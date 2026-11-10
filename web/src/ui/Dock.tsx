import { useEffect, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { showNotice, viewRoom, voice } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { useApp } from '../app/store';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import { canUseCamera } from '../voice/camera';
import { canShareScreen } from '../voice/share';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import type { Settings as SettingsDialog } from './Settings';

/** The control center and the settings it opens, which outlast any change between its states. */
export function Dock({ room }: { room: Room | null }) {
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
      <Controls room={room} onSettings={() => void openSettings()} />
      {Settings && <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

/** Voice for this visitor, wherever they are looking. */
function Controls({ room, onSettings }: { room: Room | null; onSettings(): void }) {
  const v = useApp((s) => s.voice);
  const rooms = useApp((s) => s.rooms);
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
        <IconButton className={v.muted ? 'off' : ''} aria-pressed={v.muted} data-cue={v.muted ? 'on' : 'off'} aria-label={muteLabel} data-tip={`${muteLabel} (${shortcuts.mute.label})`} onClick={() => void voice.toggleMute()}>
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
      <span className="dock-sep" />
      <SettingsButton onOpen={onSettings} />
      <button className="leave" data-cue="none" aria-label={t.leaveVoice} onClick={() => void voice.leave()}>
        <span>{t.leave}</span>
        <i><Icon name="x" /></i>
      </button>
    </div>
  );
}

function SettingsButton({ onOpen }: { onOpen(): void }) {
  return (
    <IconButton aria-label={t.settings} aria-haspopup="dialog" data-cue="open" data-tip={t.settings} onClick={onOpen}>
      <Icon name="sliders" />
    </IconButton>
  );
}
