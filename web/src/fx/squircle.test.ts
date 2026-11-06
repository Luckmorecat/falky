import { describe, expect, it } from 'vitest';
import { sideFraction, sideUpTo, squircleSide, squirclePath } from './squircle';

const points = (path: string) => path.slice(1, -1).split('L').map((p) => p.split(' ').map(Number) as [number, number]);

describe('squirclePath', () => {
  it('touches the box in the middle of each side', () => {
    const xs = points(squirclePath()).map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo(100, 1);
  });

  it('keeps its corners between a circle and a square', () => {
    const [x, y] = points(squirclePath(3.4, 8))[1]!;
    const fromCentre = Math.hypot(x - 50, y - 50);
    expect(fromCentre).toBeGreaterThan(50);
    expect(fromCentre).toBeLessThan(50 * Math.SQRT2);
  });
});

describe('squircleSide', () => {
  const side = squircleSide(6);

  it('runs up the right side, clear of the outline by the gap', () => {
    const middle = side[Math.floor(side.length / 2)]!;
    expect(middle.x).toBeCloseTo(106, 1);
    expect(middle.y).toBeCloseTo(50, 1);
    expect(side.every((p, i) => i === 0 || p.y < side[i - 1]!.y)).toBe(true);
  });

  it('ends symmetrically around the corners', () => {
    const first = side[0]!;
    const last = side[side.length - 1]!;
    expect(first.x).toBeCloseTo(last.x, 5);
    expect(first.y - 50).toBeCloseTo(50 - last.y, 5);
    expect(first.y).toBeGreaterThan(80);
  });

  it('turns a height into a fraction and back', () => {
    const at = (f: number) => sideUpTo(side, f).at(-1)!;
    expect(at(0)).toEqual(side[0]);
    expect(at(1).y).toBeCloseTo(side.at(-1)!.y, 5);
    expect(at(.5).y).toBeCloseTo(50, 5);
    expect(sideFraction(side, at(.3).y)).toBeCloseTo(.3, 5);
    expect(sideFraction(side, -500)).toBe(1);
    expect(sideFraction(side, 500)).toBe(0);
  });
});
