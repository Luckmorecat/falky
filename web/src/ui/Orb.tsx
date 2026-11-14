import { type ReactNode, useEffect, useRef } from 'react';
import { addOrb } from '../fx/orbRenderer';
import { hashString, PALETTES, type PaletteName, paletteStyle } from '../fx/palette';
import './Orb.css';

/**
 * A voice as a rounded square of poured colour. Talking swells it, sets the
 * colours flowing and brightens its edge. `still` draws it once, for small marks.
 * Whatever is passed inside lies on the orb and swells with it, like a camera's picture.
 */
export function Orb({ seed, palette, level, still, children }: { seed: string; palette?: PaletteName; level?: () => number; still?: boolean; children?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hash = hashString(seed);

  useEffect(
    () => palette ? addOrb({ root: root.current!, canvas: canvas.current!, seed: hash, colors: PALETTES[palette], level, still }) : undefined,
    [hash, palette, level, still],
  );

  return (
    <div ref={root} className={`orb${palette ? '' : ' colour-loading'}`} style={paletteStyle(palette)} aria-hidden="true">
      <canvas ref={canvas} />
      {children}
    </div>
  );
}
