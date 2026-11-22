import { describe, expect, it } from 'vitest';
import { PALETTE_NAMES, PALETTES, roomPalette, themedPalette } from './palette';

describe('roomPalette', () => {
  it('never repeats among the first rooms', () => {
    expect(new Set(PALETTE_NAMES.map((_, i) => roomPalette(i))).size).toBe(PALETTE_NAMES.length);
  });
});

describe('light palettes', () => {
  const parts = (colour: string) => colour.slice(6, -1).split(' ').map(Number) as [number, number, number];
  it('keep every hue, never get lighter, and keep their heart off white', () => {
    for (const name of PALETTE_NAMES) {
      const dark = themedPalette(name, false);
      const light = themedPalette(name, true);
      expect(dark).toEqual(PALETTES[name]);
      light.forEach((colour, i) => {
        const [l, , h] = parts(colour);
        const [dl, , dh] = parts(dark[i]!);
        expect(h, `${name} ${i}`).toBe(dh);
        expect(l, `${name} ${i}`).toBeLessThanOrEqual(dl);
      });
      expect(parts(light[3])[0], name).toBeLessThanOrEqual(0.92);
    }
  });
});
