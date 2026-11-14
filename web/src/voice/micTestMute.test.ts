import { expect, it, vi } from 'vitest';
import { MicTestMuting } from './micTestMute';

it('restores only an initially enabled microphone after the last test releases it', async () => {
  const muting = new MicTestMuting();
  const restore = vi.fn(async () => {});
  const first = muting.acquire(async () => {}, restore);
  const second = muting.acquire(async () => {});
  await first.ready;
  first.release();
  expect(muting.active).toBe(true);
  expect(restore).not.toHaveBeenCalled();
  second.release();
  await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
  first.release();
  second.release();
  expect(restore).toHaveBeenCalledOnce();
});

it('cancels pending restoration when the user deafens or the room ends', async () => {
  for (const cancel of ['keepMuted', 'reset'] as const) {
    const muting = new MicTestMuting();
    let finish!: () => void;
    const restore = vi.fn(async () => {});
    const test = muting.acquire(() => new Promise<void>((resolve) => { finish = resolve; }), restore);
    test.release();
    muting[cancel]();
    finish();
    await test.ready;
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
  }
});

it('preserves the original state when tests stop and restart before mute completes', async () => {
  const muting = new MicTestMuting();
  const restore = vi.fn(async () => {});
  const first = muting.acquire(async () => {}, restore);
  first.release();
  const second = muting.acquire(async () => {});
  await second.ready;
  expect(restore).not.toHaveBeenCalled();
  second.release();
  await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
});
