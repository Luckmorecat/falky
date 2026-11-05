import type { CSSProperties } from 'react';

/** Base (rim in silence), bright (rim in speech) and deep (the second glow). */
export const PALETTES = {
  magenta: ['#6c2e6c', '#e063b8', '#4d2085'],
  ember: ['#6e3120', '#f2602f', '#8f1f18'],
  indigo: ['#2c2f80', '#9286e6', '#1c2fa8'],
  sand: ['#6a4a58', '#edc690', '#6b2fa3'],
  navy: ['#14266e', '#3e6bee', '#0d1c70'],
  rose: ['#6e2b40', '#f2728c', '#6b1f5c'],
  lagoon: ['#12505b', '#42cbc3', '#0e4a7d'],
  moss: ['#475720', '#c7da5c', '#2b5a31'],
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

/** A visitor's colour wherever nothing else competes for it, such as in chat. */
export const paletteOf = (visitorId: string): PaletteName => at(hashString(visitorId));

/** Rooms take colours in their stable list order, so the first rooms never repeat. */
export const roomPalette = (index: number): PaletteName => at(index);

/**
 * Colours for the people in one room: each keeps their own colour when it is
 * free, otherwise takes the next free one. Every client decides in the same
 * order, so everyone sees the same colours.
 */
export function assignPalettes(visitorIds: string[]): Map<string, PaletteName> {
  const taken = new Set<PaletteName>();
  const out = new Map<string, PaletteName>();
  for (const id of [...visitorIds].sort()) {
    let i = hashString(id);
    let name = at(i);
    for (let tries = 0; taken.has(name) && tries < PALETTE_NAMES.length; tries++) name = at(++i);
    taken.add(name);
    out.set(id, name);
  }
  return out;
}

export function paletteStyle(name: PaletteName): CSSProperties {
  const [base, bright, deep] = PALETTES[name];
  return { '--base': base, '--bright': bright, '--deep': deep } as CSSProperties;
}
