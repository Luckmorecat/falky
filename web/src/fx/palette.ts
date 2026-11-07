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
  indigo: ['#4a5ee0', '#8fa4ff', '#26308f', '#d4dcff'],
  plum: ['#a84aa6', '#e08ad8', '#5e2268', '#ffd0f2'],
  sunset: ['#f25f8b', '#ffb35c', '#b62d78', '#ffe9a8'],
  aurora: ['#2fb7c9', '#b58cff', '#1a6f9c', '#d8fff0'],
  lime: ['#c5e334', '#f2ff8a', '#7aa61e', '#fdffd6'],
  clay: ['#b9785a', '#e8b795', '#7d4630', '#f7e3d0'],
  ocean: ['#1f8fa8', '#6fd3dc', '#0f5a78', '#d8fbff'],
  ruby: ['#d42a55', '#ff7a86', '#7f1238', '#ffccc2'],
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

/** How many colours a person can call their favourites. */
export const MAX_FAVORITES = 3;

/** One of the favourites, by chance; nothing when there are none. */
export const pickFavorite = (favorites: readonly PaletteName[], random: () => number = Math.random): PaletteName | null =>
  favorites[Math.floor(random() * favorites.length)] ?? null;

/** The colour worn right now, for its owner alone; anyone else keeps their usual colour. */
export const ownPalette = (visitorId: string, selfId: string | undefined, own: PaletteName | null): PaletteName =>
  (visitorId === selfId && own) || paletteOf(visitorId);

/** Rooms take colours in their stable list order, so the first rooms never repeat. */
export const roomPalette = (index: number): PaletteName => at(index);

/**
 * Colours for the people in one room: each keeps their own colour when it is
 * free, otherwise takes the next free one. Those in voice go first, in an order
 * every client shares, so everyone sees the same colours on them. A colour
 * someone chose for themself is theirs on this screen, whether or not they are
 * in voice yet, so nobody's changes when they come in. Those who only write
 * follow in the order given: oldest first means a newcomer disturbs nobody.
 */
export function assignPalettes(voiceIds: readonly string[], chosen?: { id: string; palette: PaletteName }, writerIds: readonly string[] = []): Map<string, PaletteName> {
  const taken = new Set<PaletteName>();
  const out = new Map<string, PaletteName>();
  if (chosen) {
    taken.add(chosen.palette);
    out.set(chosen.id, chosen.palette);
  }
  for (const id of [...[...voiceIds].sort(), ...writerIds]) {
    if (out.has(id)) continue;
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
