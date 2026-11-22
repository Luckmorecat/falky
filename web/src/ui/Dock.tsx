import { type Ref, useEffect, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { setChatOpen, showNotice, viewRoom, voice } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { useApp } from '../app/store';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import { canUseCamera } from '../voice/camera';
import { EMOJI_REACTIONS, SOUND_REACTIONS } from '../voice/reactions';
import { canShareScreen } from '../voice/share';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import type { Settings as SettingsDialog } from './Settings';
import './Dock.css';

/** The control center and the settings it opens, which outlast any change between its states. */
export function Dock({ room, unreadRef }: { room: Room | null; unreadRef?: Ref<HTMLSpanElement> }) {
  const [Settings, setSettings] = useState<typeof SettingsDialog | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function openSettings() {
    if (!Settings) {
      try {
        const module = await import('./Settings');
        setSettings(() => module.Settings);
      } catch {
        showNotice(t.settings, t.errors.network);
        return;
      }
    }
    setSettingsOpen(true);
  }

  return (
    <>
      <Controls room={room} unreadRef={unreadRef} onSettings={() => void openSettings()} />
      {Settings && <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

/** Voice for this visitor, wherever they are looking. */
function Controls({ room, unreadRef, onSettings }: { room: Room | null; unreadRef?: Ref<HTMLSpanElement>; onSettings(): void }) {
  const v = useApp((s) => s.voice);
  const rooms = useApp((s) => s.rooms);
  const pushToTalk = useApp((s) => s.settings.pushToTalk);
  const selfId = useApp((s) => s.voice.people.find((p) => p.local)?.id);
  const ring = useRef<HTMLSpanElement>(null);
  const inVoice = v.status === 'connected' || v.status === 'reconnecting' || (v.status === 'joining' && v.roomId !== null);
  const joining = v.status === 'joining';

  useEffect(() => {
    if (!inVoice || !selfId) return;
    return onTick(() => {
      const el = ring.current;
      if (!el) return;
      const l = voice.level(selfId);
      el.style.opacity = (l > 0.03 ? 0.3 + l * 0.7 : 0).toFixed(3);
      el.style.transform = `scale(${(0.94 + l * 0.24).toFixed(3)})`;
    });
  }, [inVoice, selfId]);

  const elsewhere = inVoice && room && v.roomId !== room.id;
  const voiceRoom = rooms.find((r) => r.id === v.roomId);

  if (!inVoice) {
    return (
      <div className="dock">
        <div className="dock-bg" />
        {room && (
          <Button variant="join" data-cue="none" disabled={joining} onClick={() => void voice.join(room.id)}>
            <Icon name="mic" />
            {joining ? t.joining : t.join}
          </Button>
        )}
        <SettingsButton onOpen={onSettings} />
        {room && <ChatButton unreadRef={unreadRef} />}
      </div>
    );
  }

  const muteLabel = v.muted ? t.muteOff : t.muteOn;
  const deafLabel = v.deafened ? t.deafOff : t.deafOn;
  const shareLabel = v.sharing ? t.shareOff : t.shareOn;
  const cameraLabel = v.camera ? t.cameraOff : t.cameraOn;

  return (
    <div className="dock" role="toolbar" aria-label={voiceRoom?.name}>
      <div className="dock-bg" />
      {elsewhere && room && voiceRoom && (
        <>
          <button className="dock-room" onClick={() => viewRoom(voiceRoom.id)} title={t.back(voiceRoom.name)}>{voiceRoom.name}</button>
          <button className="dock-move" data-cue="none" disabled={joining} onClick={() => void voice.join(room.id)}>{joining ? t.joining : t.moveHere}</button>
          <span className="dock-sep" />
        </>
      )}
      <IconButton className={v.deafened ? 'off' : ''} aria-pressed={v.deafened} data-cue={v.deafened ? 'on' : 'off'} aria-label={deafLabel} data-tip={`${deafLabel} (${shortcuts.deafen.label})`} onClick={() => void voice.toggleDeafen()}>
        <Icon name={v.deafened ? 'headOff' : 'head'} />
      </IconButton>
      <div className="mic-wrap">
        <span ref={ring} className="mic-ring" />
        <IconButton className={v.muted ? 'off' : ''} aria-pressed={v.muted} data-cue={v.muted ? 'on' : 'off'} aria-label={muteLabel} data-tip={pushToTalk && v.muted ? t.holdToTalk(shortcuts.pushToTalk.label) : `${muteLabel} (${shortcuts.mute.label})`} onClick={() => void voice.toggleMute()}>
          <Icon name={v.muted ? 'micOff' : 'mic'} />
        </IconButton>
      </div>
      {canUseCamera && (
        <IconButton aria-pressed={v.camera} data-cue={v.camera ? 'off' : 'on'} aria-label={cameraLabel} data-tip={`${cameraLabel} (${shortcuts.camera.label})`} onClick={() => void voice.toggleCamera()}>
          <Icon name="camera" />
        </IconButton>
      )}
      {canShareScreen && (
        <IconButton className={`hide-phone${v.sharing ? ' sharing' : ''}`} aria-pressed={v.sharing} aria-label={shareLabel} data-tip={shareLabel} onClick={() => void voice.toggleShare()}>
          <Icon name="screen" />
        </IconButton>
      )}
      <ReactButton />
      <span className="dock-sep" />
      <SettingsButton onOpen={onSettings} />
      <ChatButton unreadRef={unreadRef} />
      <LeaveButton />
    </div>
  );
}

/** A tray of reactions above the dock, open until the pointer goes elsewhere. */
function ReactButton() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', away);
    addEventListener('keydown', escape);
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={wrap} className={`react-wrap${open ? ' open' : ''}`}>
      <IconButton
        aria-expanded={open}
        aria-controls="react-tray"
        aria-label={t.reactions}
        data-cue={open ? 'off' : 'open'}
        data-tip={open ? undefined : `${t.reactions} (${shortcuts.react.label})`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="smile" />
      </IconButton>
      <div id="react-tray" className="react-tray" role="group" aria-label={t.reactions} inert={!open}>
        <div className="react-row">
          {EMOJI_REACTIONS.map((r, i) => (
            <button key={r.id} type="button" className="react-pick" aria-label={t.reactionNames[r.id]} data-tip={`${t.reactionNames[r.id]} (${i + 1})`} onClick={() => voice.react(r.id)}>
              {r.emoji}
            </button>
          ))}
        </div>
        <div className="react-row react-sounds" role="group" aria-label={t.roomSounds}>
          {SOUND_REACTIONS.map((r) => (
            <button key={r.id} type="button" className="react-pick" aria-label={t.reactionNames[r.id]} title={t.reactionNames[r.id]} onClick={() => voice.react(r.id)}>
              {r.emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function LeaveButton() {
  const dialog = useRef<HTMLDialogElement>(null);

  function leave() {
    dialog.current?.close();
    void voice.leave();
  }

  return (
    <>
      <button className="leave" data-cue="none" aria-label={t.leaveVoice} aria-haspopup="dialog" data-tip={`${t.leaveVoice} (${shortcuts.leave.label})`} onClick={() => dialog.current?.showModal()}>
        <span>{t.leave}</span>
        <i><Icon name="x" /></i>
      </button>
      <dialog
        ref={dialog}
        className="leave-confirm"
        aria-labelledby="leave-confirm-title"
        onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}
      >
        <h2 id="leave-confirm-title">{t.leaveAsk}</h2>
        <div className="leave-confirm-actions">
          <Button autoFocus onClick={() => dialog.current?.close()}>{t.leaveCancel}</Button>
          <Button variant="danger" data-cue="none" onClick={leave}>{t.leave}</Button>
        </div>
      </dialog>
    </>
  );
}

function SettingsButton({ onOpen }: { onOpen(): void }) {
  return (
    <IconButton aria-label={t.settings} aria-haspopup="dialog" data-cue="open" data-tip={t.settings} onClick={onOpen}>
      <Icon name="sliders" />
    </IconButton>
  );
}

/** The chat opens from here like everything else in the dock, and says how much waits in it. */
function ChatButton({ unreadRef }: { unreadRef?: Ref<HTMLSpanElement> }) {
  const open = useApp((s) => s.chatOpen);
  const unread = useApp((s) => (s.viewedRoomId ? (s.chats[s.viewedRoomId]?.unread ?? 0) : 0));
  const label = open ? t.closeChat : unread ? `${t.chat}: ${unread}` : t.chat;
  return (
    <IconButton
      className="dock-chat"
      aria-expanded={open}
      aria-label={label}
      data-cue={open ? 'off' : 'open'}
      data-tip={open ? t.closeChat : `${t.chat} (${shortcuts.chat.label})`}
      onClick={() => setChatOpen(!open)}
    >
      <Icon name="chat" />
      {unread > 0 && !open && <span ref={unreadRef} className="badge">{unread > 99 ? '99+' : unread}</span>}
    </IconButton>
  );
}
