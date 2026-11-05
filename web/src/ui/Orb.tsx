import { useEffect, useRef } from 'react';
import { addOrb } from '../fx/orbRenderer';
import { hashString, PALETTES, type PaletteName, paletteStyle } from '../fx/palette';

/**
 * A voice as a sphere of poured colour. Talking swells it, sets the colours
 * flowing and brightens its edge. `still` draws it once, for small marks.
 */
export function Orb({ seed, palette, level, still }: { seed: string; palette: PaletteName; level?: () => number; still?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hash = hashString(seed);

  useEffect(
    () => addOrb({ root: root.current!, canvas: canvas.current!, seed: hash, colors: PALETTES[palette], level, still }),
    [hash, palette, level, still],
  );

  return (
    <div ref={root} className="orb" style={paletteStyle(palette)} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
