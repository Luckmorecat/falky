import type { CSSProperties } from 'react';

/** An orb's body, the cloud poured over it, the darker patch beneath and the light at the cloud's heart. */
export const PALETTES = {
  sky: ['oklch(0.672 0.148 254)', 'oklch(0.853 0.068 237.2)', 'oklch(0.606 0.171 258.5)', 'oklch(0.981 0.009 171.8)'],
  apricot: ['oklch(0.725 0.058 292.9)', 'oklch(0.762 0.152 60.9)', 'oklch(0.646 0.074 292.4)', 'oklch(0.918 0.026 305.8)'],
  lagoon: ['oklch(0.778 0.139 172.2)', 'oklch(0.873 0.104 174)', 'oklch(0.523 0.088 184.6)', 'oklch(0.811 0.204 146.9)'],
  rose: ['oklch(0.754 0.125 2.5)', 'oklch(0.882 0.062 24.5)', 'oklch(0.592 0.172 357.6)', 'oklch(0.966 0.021 60.8)'],
  violet: ['oklch(0.613 0.191 284.4)', 'oklch(0.776 0.123 290.6)', 'oklch(0.46 0.211 279.8)', 'oklch(0.851 0.097 326.4)'],
  amber: ['oklch(0.808 0.145 79.1)', 'oklch(0.914 0.111 90.3)', 'oklch(0.681 0.16 50.5)', 'oklch(0.975 0.036 93.3)'],
  moss: ['oklch(0.774 0.144 126.8)', 'oklch(0.913 0.099 118.1)', 'oklch(0.577 0.113 142.3)', 'oklch(0.985 0.051 115.6)'],
  coral: ['oklch(0.681 0.174 33.3)', 'oklch(0.813 0.116 49.2)', 'oklch(0.53 0.174 7.1)', 'oklch(0.931 0.051 70)'],
  indigo: ['oklch(0.543 0.198 271.5)', 'oklch(0.74 0.134 272.9)', 'oklch(0.368 0.155 271.6)', 'oklch(0.899 0.049 275.2)'],
  plum: ['oklch(0.564 0.168 328.3)', 'oklch(0.748 0.144 330.3)', 'oklch(0.373 0.129 321.7)', 'oklch(0.908 0.068 336.2)'],
  sunset: ['oklch(0.685 0.184 4.8)', 'oklch(0.823 0.136 67.6)', 'oklch(0.533 0.185 351.9)', 'oklch(0.937 0.086 91.6)'],
  aurora: ['oklch(0.717 0.113 208.4)', 'oklch(0.726 0.166 298.7)', 'oklch(0.515 0.104 237.9)', 'oklch(0.968 0.045 170.1)'],
  lime: ['oklch(0.865 0.189 119.4)', 'oklch(0.966 0.142 114.3)', 'oklch(0.669 0.162 126.9)', 'oklch(0.988 0.053 109.6)'],
  clay: ['oklch(0.634 0.092 45.4)', 'oklch(0.815 0.073 56.2)', 'oklch(0.455 0.083 42.2)', 'oklch(0.927 0.034 65.9)'],
  ocean: ['oklch(0.602 0.1 217.3)', 'oklch(0.81 0.094 203.2)', 'oklch(0.44 0.083 231.3)', 'oklch(0.964 0.037 205)'],
  ruby: ['oklch(0.572 0.203 12.9)', 'oklch(0.737 0.162 16.3)', 'oklch(0.393 0.143 7.2)', 'oklch(0.887 0.06 31.1)'],
} as const;

export type PaletteName = keyof typeof PALETTES;
export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

const at = (i: number): PaletteName => PALETTE_NAMES[((i % PALETTE_NAMES.length) + PALETTE_NAMES.length) % PALETTE_NAMES.length]!;

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Rooms take colours in their stable list order, so the first rooms never repeat. */
export const roomPalette = (index: number): PaletteName => at(index);

type Colours = readonly [string, string, string, string];

/**
 * The same palette for a white page: every stop a little darker and richer, so pale
 * colours keep their shape against white and no highlight dissolves into it. The hue
 * and the order of the stops stay, so a person is the same colour in either theme.
 */
function forLight([base, bright, deep, core]: Colours): Colours {
  const shift = (colour: string, lightness: (l: number) => number, chroma: (c: number) => number) => {
    const [l, c, h] = colour.slice(6, -1).split(' ').map(Number) as [number, number, number];
    return `oklch(${lightness(l).toFixed(3)} ${Math.min(0.26, chroma(c)).toFixed(3)} ${h})`;
  };
  return [
    shift(base, (l) => l * 0.9 + 0.02, (c) => c * 1.15),
    shift(bright, (l) => Math.min(l * 0.9 + 0.02, 0.86), (c) => c * 1.2),
    shift(deep, (l) => l * 0.9, (c) => c * 1.1),
    // Only a near-white heart needs colour added; a vivid one is already enough.
    shift(core, (l) => Math.min(l, 0.92), (c) => (c < 0.08 ? Math.max(0.045, c * 1.6) : c)),
  ];
}

const LIGHT = Object.fromEntries(PALETTE_NAMES.map((name) => [name, forLight(PALETTES[name])])) as Record<PaletteName, Colours>;

/** A palette's four stops as they should look in the given theme. */
export const themedPalette = (name: PaletteName, light: boolean): Colours => (light ? LIGHT[name] : PALETTES[name]);

/**
 * `--base` and the others name the palette itself; styles draw with `--pal-*`,
 * which styles.css points at the light stops (`--*-l`) on a light page.
 */
export function paletteStyle(name: PaletteName | undefined): CSSProperties {
  if (!name) return { '--base': 'var(--text-3)', '--deep': 'var(--fill)' } as CSSProperties;
  const [base, bright, deep, core] = PALETTES[name];
  const [baseL, brightL, deepL, coreL] = LIGHT[name];
  return { '--base': base, '--bright': bright, '--deep': deep, '--core': core, '--base-l': baseL, '--bright-l': brightL, '--deep-l': deepL, '--core-l': coreL } as CSSProperties;
}
