import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearToasts, getToasts, showToast } from './toasts';

const titles = () => getToasts().map(({ title }) => title);

beforeEach(() => vi.useFakeTimers());
afterEach(() => { clearToasts(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('replaces the timed slot and gives the replacement a full default duration', () => {
  const callbacks = vi.spyOn(globalThis, 'setTimeout');
  const first = showToast({ title: 'First' });
  const firstTimeout = callbacks.mock.calls[0]![0];
  vi.advanceTimersByTime(6_000);
  showToast({ title: 'Second' });
  first.dismiss();
  if (typeof firstTimeout === 'function') firstTimeout();
  vi.advanceTimersByTime(6_999);
  expect(titles()).toEqual(['Second']);
  vi.advanceTimersByTime(1);
  expect(titles()).toEqual([]);
});

it('supports custom timing and independent persistent handles', () => {
  const persistent = showToast({ title: 'Working', durationMs: null });
  const other = showToast({ title: 'Waiting', durationMs: null });
  const timed = showToast({ title: 'Saved', durationMs: 250 });
  expect(titles()).toEqual(['Working', 'Waiting', 'Saved']);
  vi.advanceTimersByTime(249);
  expect(titles()).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(titles()).toEqual(['Working', 'Waiting']);
  vi.advanceTimersByTime(60_000);
  persistent.dismiss();
  persistent.dismiss();
  timed.dismiss();
  expect(titles()).toEqual(['Waiting']);
  other.dismiss();
  expect(titles()).toEqual([]);
});

it('clears both modes at an owner boundary without invalidating new feedback', () => {
  const oldPersistent = showToast({ title: 'Working', durationMs: null });
  const oldTimed = showToast({ title: 'Saved' });
  clearToasts();
  expect(titles()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  showToast({ title: 'New owner', durationMs: null });
  oldPersistent.dismiss();
  oldTimed.dismiss();
  expect(titles()).toEqual(['New owner']);
});
