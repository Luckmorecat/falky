import { type RefObject, useEffect, useRef, useState } from 'react';
import { sayTick } from '../app/interfaceSounds';
import { pointsPath, sideFraction, sideUpTo, squircleSide } from '../fx/squircle';
import './Range.css';
import './VolumeSlider.css';

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
export function VolumeSlider({ label, value, onChange, wheelTarget }: { label: string; value: number; onChange(v: number): void; wheelTarget?: RefObject<HTMLElement | null> }) {
  const control = useRef<HTMLDivElement>(null);
  const box = useRef<SVGSVGElement>(null);
  const current = useRef({ value, onChange });
  current.current = { value, onChange };
  const [held, setHeld] = useState(false);
  const fill = sideUpTo(SIDE, value / MAX);
  const handle = fill.at(-1)!;

  useEffect(() => {
    const el = control.current!;
    const target = wheelTarget?.current ?? el;
    const grip = el.querySelector('.t-vol-grip')!;
    let pending = 0;
    let lastWheel = 0;
    const wheel = (e: WheelEvent) => {
      if (getComputedStyle(grip).pointerEvents === 'none' && !el.matches(':focus-within')) {
        pending = 0;
        return;
      }
      if (e.ctrlKey || e.metaKey || e.shiftKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const delta = Math.max(-40, Math.min(40, e.deltaY * unit));
      if (e.timeStamp - lastWheel > 250 || Math.sign(delta) !== Math.sign(pending)) pending = 0;
      lastWheel = e.timeStamp;
      pending += delta;
      if (Math.abs(pending) < 40) return;
      const direction = Math.sign(pending);
      pending -= direction * 40;
      const next = Math.max(0, Math.min(MAX * 20, Math.round(current.current.value * 20) - direction)) / 20;
      if (next === current.current.value) return;
      current.current.value = next;
      current.current.onChange(next);
      sayTick(next / MAX);
    };
    // React's passive wheel listener cannot stop the page scrolling with the slider.
    target.addEventListener('wheel', wheel, { passive: false });
    return () => target.removeEventListener('wheel', wheel);
  }, [wheelTarget]);

  const follow = (clientY: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect?.height) return;
    const v = settle(sideFraction(SIDE, ((clientY - rect.top) / rect.height) * 100) * MAX);
    if (v === value) return;
    onChange(v);
    sayTick(v / MAX);
  };

  return (
    <div ref={control} className={`t-vol${held ? ' held' : ''}`} onPointerUp={(e) => e.stopPropagation()}>
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
