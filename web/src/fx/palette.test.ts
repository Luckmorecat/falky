import { describe, expect, it } from 'vitest';
import { PALETTE_NAMES, roomPalette } from './palette';

describe('roomPalette', () => {
  it('never repeats among the first rooms', () => {
    expect(new Set(PALETTE_NAMES.map((_, i) => roomPalette(i))).size).toBe(PALETTE_NAMES.length);
  });
});
