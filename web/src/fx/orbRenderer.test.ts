import { describe, expect, it } from 'vitest';
import { oklchToRgb, isDue } from './orbRenderer';

describe('isDue', () => {
  it('gives a voice every frame', () => {
    expect(isDue(0.5, 0.001)).toBe(true);
  });

  it('keeps a silent orb to a few pictures a second', () => {
    expect(isDue(0, 0.016)).toBe(false);
    expect(isDue(0, 0.07)).toBe(true);
  });
});

describe('oklchToRgb', () => {
  it('reads a colour as parts of one', () => {
    const [r, g, b] = oklchToRgb('oklch(0.672 0.148 254)');
    expect([r * 255, g * 255, b * 255].map(Math.round)).toEqual([79, 152, 238]);
  });

  it('keeps colours out of gamut within one', () => {
    expect(oklchToRgb('oklch(1 0.4 150)').every((c) => c >= 0 && c <= 1)).toBe(true);
  });
});
