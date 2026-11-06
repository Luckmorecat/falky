import { useEffect, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { viewRoom, voice } from '../app/controller';
import { useApp } from '../app/store';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import { canShareScreen } from '../voice/share';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { Settings } from './Settings';

/** The control center: voice for this visitor, wherever they are looking. */
export function Dock({ room }: { room: Room | null }) {
  const v = useApp((s) => s.voice);
  const rooms = useApp((s) => s.rooms);
  const selfId = useApp((s) => s.visitor?.id);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  useEffect(() => {
    if (!sheetOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.sheet, [data-settings]')) setSheetOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [sheetOpen]);

  const elsewhere = inVoice && room && v.roomId !== room.id;
  const voiceRoom = rooms.find((r) => r.id === v.roomId);

  if (!inVoice) {
    return (
      <div className="dock">
        <div className="dock-bg" />
        {room && (
          <Button variant="join" disabled={joining} onClick={() => void voice.join(room.id)}>
            <Icon name="mic" />
            {joining ? t.joining : t.join}
          </Button>
        )}
        <SettingsButton open={sheetOpen} onToggle={() => setSheetOpen(!sheetOpen)} />
      </div>
    );
  }

  const muteLabel = v.muted ? t.muteOff : t.muteOn;
  const deafLabel = v.deafened ? t.deafOff : t.deafOn;
  const shareLabel = v.sharing ? t.shareOff : t.shareOn;

  return (
    <div className="dock" role="toolbar" aria-label={voiceRoom?.name}>
      <div className="dock-bg" />
      {elsewhere && room && voiceRoom && (
        <>
          <button className="dock-room" onClick={() => viewRoom(voiceRoom.id)} title={t.back(voiceRoom.name)}>{voiceRoom.name}</button>
          <button className="dock-move" disabled={joining} onClick={() => void voice.join(room.id)}>{joining ? t.joining : t.moveHere}</button>
          <span className="dock-sep" />
        </>
      )}
      <IconButton className={v.deafened ? 'off' : ''} aria-pressed={v.deafened} aria-label={deafLabel} data-tip={deafLabel} onClick={() => void voice.toggleDeafen()}>
        <Icon name={v.deafened ? 'headOff' : 'head'} />
      </IconButton>
      <div className="mic-wrap">
        <span ref={ring} className="mic-ring" />
        <IconButton className={v.muted ? 'off' : ''} aria-pressed={v.muted} aria-label={muteLabel} data-tip={muteLabel} onClick={() => void voice.toggleMute()}>
          <Icon name={v.muted ? 'micOff' : 'mic'} />
        </IconButton>
      </div>
      {canShareScreen && (
        <IconButton className={`hide-phone${v.sharing ? ' sharing' : ''}`} aria-pressed={v.sharing} aria-label={shareLabel} data-tip={shareLabel} onClick={() => void voice.toggleShare()}>
          <Icon name="screen" />
        </IconButton>
      )}
      <span className="dock-sep" />
      <SettingsButton open={sheetOpen} onToggle={() => setSheetOpen(!sheetOpen)} />
      <button className="leave" aria-label={t.leaveVoice} onClick={() => void voice.leave()}>
        <span>{t.leave}</span>
        <i><Icon name="x" /></i>
      </button>
    </div>
  );
}

function SettingsButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return (
    <div className="sheet-anchor">
      <IconButton data-settings aria-label={t.settings} aria-expanded={open} data-tip={open ? undefined : t.settings} onClick={onToggle}>
        <Icon name="sliders" />
      </IconButton>
      <Settings open={open} />
    </div>
  );
}
