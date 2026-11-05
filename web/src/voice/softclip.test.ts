import { describe, expect, it } from 'vitest';
import { softClipCurve } from './softclip';

describe('softClipCurve', () => {
  const curve = softClipCurve();
  const at = (x: number) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))]!;

  it('leaves normal levels exactly as they are', () => {
    for (const x of [0, 0.1, 0.5, 0.8, -0.4]) expect(at(x)).toBeCloseTo(x, 3);
  });
  it('keeps peaks below full scale, on both sides', () => {
    expect(at(1)).toBeLessThan(1);
    expect(at(1)).toBeGreaterThan(0.9);
    expect(at(-1)).toBeCloseTo(-at(1), 5);
  });
  it('never reverses: more in is never less out', () => {
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
  });
});
