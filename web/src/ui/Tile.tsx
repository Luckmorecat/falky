import { useEffect, useRef, useState } from 'react';
import { prefs } from '../app/prefs';
import { setParticipantVolume } from '../app/controller';
import { hashString, type PaletteName, paletteStyle } from '../fx/palette';
import { effectsReduced, onTick } from '../fx/ticker';
import { t } from '../strings';
import { Dots, monogram } from './Dots';
import { Icon } from './Icon';

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

const ARCS: [number, number, number][] = [[28, 92, 26], [52, 96, 30], [80, 90, 24]];
const NODE_ANGLES = [-122, -68, -150];

/**
 * A person's block: a coloured rim around a soft black centre. Their voice
 * pushes the centre in and sets the colours moving. Everything that moves goes
 * through `transform` and `opacity`, written directly, so it costs the page no
 * layout or repaint next to a running game.
 */
export function Tile({ id, name, palette, isSelf, level, muted, deafened, adjustable, mini }: TileProps) {
  const root = useRef<HTMLElement>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [volume, setVolume] = useState(() => prefs.volume(id));

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const q = <T extends Element>(s: string) => el.querySelector<T>(s);
    const core = q<HTMLElement>('.t-core')!;
    const lit = q<HTMLElement>('.t-lit')!;
    const a = q<HTMLElement>('.t-spin.a')!;
    const b = q<HTMLElement>('.t-spin.b')!;
    const ai = q<HTMLElement>('.t-spin.a i')!;
    const bi = q<HTMLElement>('.t-spin.b i')!;
    const mono = q<SVGElement>('.t-mono');
    const nodes = [...el.querySelectorAll<SVGGElement>('.t-arcs g')];
    const seed = hashString(id);
    const ph = ((seed % 628) / 100);
    let spinA = seed % 360;
    let spinB = (seed >> 8) % 360;
    let arc = 0;
    let lvl = 0;
    let speaking = false;

    return onTick((time, dt) => {
      const target = level ? level() : 0;
      lvl += (target - lvl) * (1 - Math.exp(-dt * (target > lvl ? 26 : 4.5)));
      lit.style.opacity = (0.03 + lvl * 0.72).toFixed(3);
      if (lvl > 0.22 !== speaking && (lvl > 0.22 || lvl < 0.12)) {
        speaking = lvl > 0.22;
        el.classList.toggle('speaking', speaking);
      }
      if (effectsReduced()) {
        core.style.transform = `scale(${(1 - lvl * 0.14).toFixed(3)})`;
        return;
      }
      const sx = 1 - lvl * 0.2 + Math.sin(time * 1.9 + ph) * 0.02 + Math.sin(time * 4.3 + ph) * 0.05 * lvl;
      const sy = 1 - lvl * 0.16 + Math.cos(time * 1.4 + ph) * 0.02 + Math.cos(time * 5.1 + ph) * 0.05 * lvl;
      const dx = Math.sin(time * 0.63 + ph) * 1.6 + Math.sin(time * 2.7 + ph) * 3.4 * lvl;
      const dy = Math.cos(time * 0.51 + ph) * 1.6 + Math.cos(time * 2.2 + ph) * 3.4 * lvl;
      core.style.transform = `translate(${dx.toFixed(2)}%,${dy.toFixed(2)}%) scale(${sx.toFixed(3)},${sy.toFixed(3)})`;
      spinA += dt * (5 + lvl * 96);
      spinB -= dt * (4 + lvl * 74);
      a.style.transform = `rotate(${spinA.toFixed(1)}deg)`;
      b.style.transform = `rotate(${spinB.toFixed(1)}deg)`;
      ai.style.opacity = (0.2 + lvl * 0.7).toFixed(3);
      bi.style.opacity = (0.3 + lvl * 0.6).toFixed(3);
      if (mono) mono.style.transform = `scale(${(1 + lvl * 0.07).toFixed(3)})`;
      arc += dt * (1.5 + lvl * 26);
      nodes.forEach((n, i) => {
        const [ox, oy] = ARCS[i]!;
        n.setAttribute('transform', `rotate(${(NODE_ANGLES[i]! + Math.sin(arc * 0.1 + i * 2) * 13).toFixed(2)} ${ox} ${oy})`);
      });
    });
  }, [id, level]);

  const status = deafened ? t.statusDeaf : muted ? t.statusMuted : '';
  const dim = muted || deafened;

  return (
    <article
      ref={root}
      data-tile={id}
      className={`tile${dim ? ' dim' : ''}${mini ? ' mini' : ''}${volumeOpen ? ' vol-open' : ''}`}
      style={paletteStyle(palette)}
      aria-label={name}
    >
      <div className="t-base" />
      <div className="t-spin a"><i /></div>
      <div className="t-spin b"><i /></div>
      <div className="t-lit" />
      <div className="t-core" />
      <div className="t-grain" />
      {!mini && (
        <svg className="t-arcs" viewBox="0 0 100 100" aria-hidden="true">
          {ARCS.map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} fill="none" stroke="#fff" strokeOpacity=".3" strokeWidth=".2" strokeDasharray=".55 1.5" />)}
          {ARCS.map(([cx, cy, r], i) => <g key={cx} transform={`rotate(${NODE_ANGLES[i]} ${cx} ${cy})`}><circle cx={cx + r} cy={cy} r=".85" fill="#fff" /></g>)}
        </svg>
      )}
      <div className="t-head">
        <span className="t-name">{name}</span>
        {isSelf && <span className="t-you">{t.you}</span>}
        <span className="t-flags">
          {deafened ? <span className="t-flag" title={t.statusDeaf}><Icon name="headOff" /></span>
            : muted ? <span className="t-flag" title={t.statusMuted}><Icon name="micOff" /></span> : null}
          {adjustable && !mini && (
            <button className="ib sm ghost" aria-label={`${t.volume}: ${name}`} aria-expanded={volumeOpen} onClick={() => setVolumeOpen(!volumeOpen)}>
              <Icon name="vol" />
            </button>
          )}
        </span>
      </div>
      {!mini && (
        <div className="t-mid">
          <Dots className="t-mono" text={monogram(name)} />
          {status ? <span className="t-status">{status}</span> : <span className="t-status t-talk">{t.statusTalking}</span>}
        </div>
      )}
      {adjustable && !mini && (
        <label className="t-vol">
          <Icon name="vol" />
          <input
            type="range" min="0" max="2" step="0.05" value={volume} aria-label={`${t.volume}: ${name}`} tabIndex={volumeOpen ? 0 : -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              setParticipantVolume(id, v);
            }}
          />
          <output>{Math.round(volume * 100)}%</output>
        </label>
      )}
    </article>
  );
}
