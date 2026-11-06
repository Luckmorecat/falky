import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onTick } from './ticker';

let hidden = false;
let callbacks: Map<number, FrameRequestCallback>;
let sequence = 0;
const cleanup: (() => void)[] = [];

beforeEach(() => {
  hidden = false;
  callbacks = new Map();
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callbacks.set(++sequence, fn); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
});
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function visible(value: boolean) {
  hidden = !value;
  document.dispatchEvent(new Event('visibilitychange'));
}
function draw(ms: number) {
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach((fn) => fn(ms));
}

it('cancels frames while hidden and resumes without advancing through the gap', () => {
  const tick = vi.fn();
  cleanup.push(onTick(tick));
  draw(1000);
  expect(callbacks.size).toBe(1);
  visible(false);
  expect(callbacks.size).toBe(0);
  draw(20_000);
  expect(tick).toHaveBeenCalledTimes(1);
  visible(true);
  visible(true);
  expect(callbacks.size).toBe(1);
  draw(30_000);
  expect(tick).toHaveBeenLastCalledWith(30, .016);
});

it('does not start while hidden or resume after its last subscriber leaves', () => {
  visible(false);
  const stop = onTick(vi.fn());
  cleanup.push(stop);
  expect(callbacks.size).toBe(0);
  stop();
  visible(true);
  expect(callbacks.size).toBe(0);
});
