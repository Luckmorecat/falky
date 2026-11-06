import { useRef, useState } from 'react';
import { sayTick } from '../app/interfaceSounds';
import { pointsPath, sideFraction, sideUpTo, squircleSide } from '../fx/squircle';

/** Far enough off the outline to clear an orb swollen by a loud voice. */
const SIDE = squircleSide(6.5);
const RAIL = pointsPath(SIDE);
const MAX = 2;
const MIDDLE = sideUpTo(SIDE, 0.5).at(-1)!;

/** Volumes run in twentieths, and 100% holds the handle a little: it is where everyone starts. */
function settle(v: number): number {
  return Math.abs(v - 1) < 0.06 ? 1 : Math.round(v * 20) / 20;
}

const at = (p: { x: number; y: number }) => ({ left: `${p.x}%`, top: `${p.y}%` });

/** A participant's volume, dragged up and down the right side of their orb. */
export function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  const box = useRef<SVGSVGElement>(null);
  const [held, setHeld] = useState(false);
  const fill = sideUpTo(SIDE, value / MAX);
  const handle = fill.at(-1)!;

  const follow = (clientY: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect?.height) return;
    const v = settle(sideFraction(SIDE, ((clientY - rect.top) / rect.height) * 100) * MAX);
    if (v === value) return;
    onChange(v);
    sayTick(v / MAX);
  };

  return (
    <div className={`t-vol${held ? ' held' : ''}`} onPointerUp={(e) => e.stopPropagation()}>
      <svg ref={box} viewBox="0 0 100 100" aria-hidden="true">
        <path className="t-vol-rail" d={RAIL} />
        <path className="t-vol-fill" d={pointsPath(fill)} />
        <path
          className="t-vol-grip"
          d={RAIL}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setHeld(true);
            follow(e.clientY);
          }}
          onPointerMove={(e) => { if (held) follow(e.clientY); }}
          onPointerUp={() => setHeld(false)}
          onPointerCancel={() => setHeld(false)}
        />
      </svg>
      <input type="range" min="0" max={MAX} step="0.05" value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <i className="t-vol-at t-vol-mark" style={at(MIDDLE)} />
      <i className="t-vol-at t-vol-thumb" style={at(handle)} />
      <span className="t-vol-at t-vol-value" style={at(handle)}>{Math.round(value * 100)}%</span>
    </div>
  );
}
