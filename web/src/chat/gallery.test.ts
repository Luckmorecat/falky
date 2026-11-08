import { describe, expect, it } from 'vitest';
import { formatBytes, galleryRatio, gallerySize, MAX_RATIO, MIN_RATIO, ratioOf, SINGLE_MAX_HEIGHT } from './gallery';

describe('gallery', () => {
  it('keeps a single picture in its shape, within bounds', () => {
    expect(ratioOf({ width: 800, height: 600 })).toBeCloseTo(4 / 3);
    expect(ratioOf({ width: 4000, height: 500 })).toBe(MAX_RATIO);
    expect(ratioOf({ width: 300, height: 3000 })).toBe(MIN_RATIO);
    expect(ratioOf({ width: 0, height: 0 })).toBeCloseTo(4 / 3);
  });

  it('caps a tall single picture by height, not by the column', () => {
    const size = gallerySize([{ width: 600, height: 1000 }], 300);
    expect(size.height).toBeCloseTo(SINGLE_MAX_HEIGHT);
    expect(size.width).toBeCloseTo(SINGLE_MAX_HEIGHT * 0.6);
  });

  it('fills the column for several pictures', () => {
    const four = Array.from({ length: 4 }, () => ({ width: 10, height: 10 }));
    expect(gallerySize(four, 300)).toEqual({ width: 300, height: 300 });
    expect(galleryRatio(four.slice(0, 3))).toBe(1.5);
  });

  it('says sizes as people read them', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024, 'en')).toBe('25 MB');
  });
});
