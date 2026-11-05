import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShareStats, ShareStatsOverlay } from './ShareStatsOverlay';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function source() {
  let timestamp = 0;
  const getStats = vi.fn(async () => new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: (timestamp += 1000), bytesSent: timestamp * 125 }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP8' }],
  ]) as unknown as RTCStatsReport);
  return { sender: { getStats } };
}

it('resets visible rates and history on track replacement, and stops polling on unmount', async () => {
  const first = source();
  const second = source();
  await act(async () => { root.render(createElement(ShareStats, { track: first, direction: 'send' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelector('strong')?.textContent).toContain('1.00');
  expect(container.querySelectorAll('circle')).toHaveLength(2);
  await act(async () => { root.render(createElement(ShareStats, { track: second, direction: 'send' })); });
  expect(container.querySelector('strong')?.textContent).toContain('—');
  expect(container.querySelectorAll('circle')).toHaveLength(0);
  const firstCalls = first.sender.getStats.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(first.sender.getStats).toHaveBeenCalledTimes(firstCalls);
  expect(container.querySelector('strong')?.textContent).toContain('1.00');
  await act(async () => { root.render(null); });
  const secondCalls = second.sender.getStats.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(second.sender.getStats).toHaveBeenCalledTimes(secondCalls);
});

it('draws gaps for unavailable periods while retaining a real zero sample', async () => {
  await act(async () => { root.render(createElement(ShareStatsOverlay, {
    direction: 'receive',
    sample: { at: 5000, bitrate: 0, codecs: [], history: [
      { at: 1000, bitrate: 1_000_000 }, { at: 2000, bitrate: 2_000_000 },
      { at: 3000, bitrate: null }, { at: 4000, bitrate: 500_000 }, { at: 5000, bitrate: 0 },
    ] },
  })); });
  expect(container.querySelectorAll('.share-stats-line')).toHaveLength(2);
  expect(container.querySelectorAll('circle')).toHaveLength(4);
  expect(container.querySelector('circle:last-child')?.getAttribute('cy')).toBe('48');
  expect(container.querySelector('strong')?.textContent).toContain('0.00');
  expect(container.querySelector('svg')?.getAttribute('aria-label')).toBeTruthy();
});
