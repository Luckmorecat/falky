import { useState } from 'react';
import { prefs } from '../app/prefs';
import { setParticipantVolume } from '../app/controller';
import { type PaletteName, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { Icon } from './Icon';
import { Orb } from './Orb';

export interface TileProps {
  id: string;
  name: string;
  palette: PaletteName;
  isSelf?: boolean;
  /** How loud they are now; absent outside the room's voice, where it is not known. */
  level?: () => number;
  muted?: boolean;
  deafened?: boolean;
  /** Whether this client hears them, so their volume can change. */
  adjustable?: boolean;
  mini?: boolean;
}

/** A person in the room: their orb, their name, and how they are heard. */
export function Tile({ id, name, palette, isSelf, level, muted, deafened, adjustable, mini }: TileProps) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [volume, setVolume] = useState(() => prefs.volume(id));

  const status = deafened ? t.statusDeaf : muted ? t.statusMuted : '';
  const dim = muted || deafened;

  return (
    <article
      data-tile={id}
      className={`tile${dim ? ' dim' : ''}${mini ? ' mini' : ''}${volumeOpen ? ' vol-open' : ''}`}
      style={paletteStyle(palette)}
      aria-label={status ? `${name}, ${status}` : name}
    >
      <div
        className="t-orb"
        // No hover on a touch screen: a tap on the orb brings its controls up instead.
        onPointerUp={adjustable && !mini ? (e) => { if (e.pointerType !== 'mouse') setVolumeOpen(!volumeOpen); } : undefined}
      >
        <Orb seed={id} palette={palette} level={level} />
        {!mini && (deafened ? <span className="t-flag" title={t.statusDeaf}><Icon name="headOff" /></span>
          : muted ? <span className="t-flag" title={t.statusMuted}><Icon name="micOff" /></span> : null)}
        {adjustable && !mini && (
          <label className="t-vol" onPointerUp={(e) => e.stopPropagation()}>
            <Icon name="vol" />
            <input
              type="range" min="0" max="2" step="0.05" value={volume} aria-label={`${t.volume}: ${name}`}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                setParticipantVolume(id, v);
              }}
            />
            <output>{Math.round(volume * 100)}%</output>
          </label>
        )}
      </div>
      <div className="t-label">
        <span className="t-name">{name}</span>
        {isSelf && <span className="t-you">{t.you}</span>}
      </div>
    </article>
  );
}
