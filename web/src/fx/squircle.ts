/**
 * The shape of a voice: a square with continuous corners, as Figma draws a 32%
 * radius at 100% corner smoothing. A superellipse |x|^n + |y|^n = 1 follows that
 * outline to within half a percent, and a shader can compute it per pixel.
 */
export const SQUIRCLE_N = 3.4;

/** The outline as an SVG path in a 100 by 100 box. */
export function squirclePath(n = SQUIRCLE_N, steps = 180): string {
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const r = (Math.abs(c) ** n + Math.abs(s) ** n) ** (-1 / n);
    points.push(`${(50 + 50 * r * c).toFixed(2)} ${(50 + 50 * r * s).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

/** The same outline for CSS, so that whatever is not drawn by the shader matches it. */
export function squircleMask(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${squirclePath()}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The outline's right side from the lower corner to the upper one, `gap` outside
 * it, in the same 100 by 100 box. Going up it, y only ever falls.
 */
export function squircleSide(gap: number, n = SQUIRCLE_N, steps = 64): Point[] {
  const spread = (52 * Math.PI) / 180;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = spread - (2 * spread * i) / steps;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const r = (Math.abs(c) ** n + Math.abs(s) ** n) ** (-1 / n);
    const nx = (r * Math.abs(c)) ** (n - 1);
    const ny = Math.sign(s) * (r * Math.abs(s)) ** (n - 1);
    const out = gap / Math.hypot(nx, ny);
    points.push({ x: 50 + 50 * r * c + nx * out, y: 50 + 50 * r * s + ny * out });
  }
  return points;
}

/** How far up the side a height in the box lies: 0 at the lower end, 1 at the upper. */
export function sideFraction(side: readonly Point[], y: number): number {
  const low = side[0]!.y;
  const high = side[side.length - 1]!.y;
  return Math.max(0, Math.min(1, (low - y) / (low - high)));
}

/** The side from its lower end up to a fraction of its height, the last point exactly there. */
export function sideUpTo(side: readonly Point[], fraction: number): Point[] {
  const low = side[0]!.y;
  const y = low + (side[side.length - 1]!.y - low) * fraction;
  const next = side.findIndex((p) => p.y <= y);
  if (next <= 0) return next === 0 ? [side[0]!] : [...side];
  const a = side[next - 1]!;
  const b = side[next]!;
  const along = a.y === b.y ? 0 : (a.y - y) / (a.y - b.y);
  return [...side.slice(0, next), { x: a.x + (b.x - a.x) * along, y }];
}

export function pointsPath(points: readonly Point[]): string {
  return `M${points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L')}`;
}
