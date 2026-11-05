import { describe, expect, it } from 'vitest';
import { hexToRgb, isDue } from './orbRenderer';

describe('isDue', () => {
  it('gives a voice every frame', () => {
    expect(isDue(0.5, 0.001)).toBe(true);
  });

  it('keeps a silent orb to a few pictures a second', () => {
    expect(isDue(0, 0.016)).toBe(false);
    expect(isDue(0, 0.07)).toBe(true);
  });
});

describe('hexToRgb', () => {
  it('reads a colour as parts of one', () => {
    expect(hexToRgb('#ff0033')).toEqual([1, 0, 0.2]);
  });
});
