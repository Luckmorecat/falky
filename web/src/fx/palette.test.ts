import { describe, expect, it } from 'vitest';
import { assignPalettes, PALETTE_NAMES, paletteOf, roomPalette } from './palette';

describe('assignPalettes', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}`);

  it('gives everyone in a full room a different colour', () => {
    expect(new Set(assignPalettes(ids).values()).size).toBe(8);
  });

  it('decides the same whatever order a client sees people in', () => {
    const a = assignPalettes(ids);
    const b = assignPalettes([...ids].reverse());
    for (const id of ids) expect(a.get(id)).toBe(b.get(id));
  });

  it('still answers for more people than colours', () => {
    expect(assignPalettes(Array.from({ length: 12 }, (_, i) => `id${i}`)).size).toBe(12);
  });

  it('keeps a lone visitor their own colour', () => {
    expect(assignPalettes([ids[0]!]).get(ids[0]!)).toBe(paletteOf(ids[0]!));
  });
});

describe('roomPalette', () => {
  it('never repeats among the first rooms', () => {
    expect(new Set(PALETTE_NAMES.map((_, i) => roomPalette(i))).size).toBe(PALETTE_NAMES.length);
  });
});
