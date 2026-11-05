import type { CSSProperties } from 'react';

/** An orb's body, the cloud poured over it, the darker patch beneath and the light at the cloud's heart. */
export const PALETTES = {
  sky: ['#4f98ee', '#a5d6f6', '#3a7fe6', '#f3fbf8'],
  apricot: ['#a7a0c8', '#f6983c', '#8f86b8', '#e8e0f2'],
  lagoon: ['#35d3ad', '#86ecd0', '#147a70', '#4fe36c'],
  rose: ['#f08ca8', '#ffc9c4', '#c9477e', '#fff1e6'],
  violet: ['#7b6cf0', '#b6a8ff', '#4a38c8', '#f0b8f0'],
  amber: ['#f2b441', '#ffe08a', '#e4762a', '#fff7dc'],
  moss: ['#9dc65a', '#dceca0', '#4f8a4a', '#f8ffd8'],
  coral: ['#f0684c', '#ffab7d', '#b8305a', '#ffe3c4'],
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
  const [base, bright, deep, core] = PALETTES[name];
  return { '--base': base, '--bright': bright, '--deep': deep, '--core': core } as CSSProperties;
}
