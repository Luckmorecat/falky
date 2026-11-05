import { describe, expect, it } from 'vitest';
import { loudness } from './meter';

describe('loudness', () => {
  it('reads silence as nothing', () => {
    expect(loudness(new Float32Array(64))).toBe(0);
  });

  it('never goes past full', () => {
    expect(loudness(new Float32Array(64).fill(1))).toBe(1);
  });

  it('rises with the signal', () => {
    expect(loudness(new Float32Array(64).fill(0.2))).toBeGreaterThan(loudness(new Float32Array(64).fill(0.05)));
  });
});
