import { afterEach, expect, it, vi } from 'vitest';
import { observeShareStats, type ShareStatsSample } from './shareStats';

const report = (bytes: number, timestamp: number, direction = 'outbound-rtp', mimeType = 'video/H264') => new Map([
  ['video', { id: 'video', type: direction, kind: 'video', ssrc: 1, codecId: 'codec', bytesSent: bytes, bytesReceived: bytes, timestamp }],
  ['codec', { id: 'codec', type: 'codec', mimeType }],
]) as unknown as RTCStatsReport;

afterEach(() => { vi.useRealTimers(); });

it('measures outgoing video using elapsed report time, including valid zero traffic', async () => {
  vi.useFakeTimers();
  let current = report(1000, 100);
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats({ sender: { getStats: async () => current } }, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  expect(samples.at(-1)?.bitrate).toBeNull();
  current = report(251000, 2100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_000_000);
  expect(samples.at(-1)?.codecs).toEqual(['H264']);
  current = report(251000, 3100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(0);
  stop();
});

it('totals primary and fallback video senders once, excluding audio and repair codecs', async () => {
  vi.useFakeTimers();
  let primary = report(0, 100);
  let fallback = new Map(report(0, 100, 'outbound-rtp', 'video/VP8'));
  const sender = { getStats: async () => primary };
  const backup = { getStats: async () => fallback as RTCStatsReport };
  const track = { sender, simulcastCodecs: new Map([['h264', { sender }], ['vp8', { sender: backup }]]) };
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats(track, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  // Distinct senders can use the same report IDs; the endpoint scopes the identity.
  primary = report(125000, 1100);
  fallback = new Map(report(62500, 1100, 'outbound-rtp', 'video/VP8'));
  fallback.set('audio', { id: 'audio', type: 'outbound-rtp', kind: 'audio', bytesSent: 900000, timestamp: 1100 });
  fallback.set('repair', { id: 'repair', type: 'outbound-rtp', kind: 'video', codecId: 'rtx', bytesSent: 900000, timestamp: 1100 });
  fallback.set('rtx', { id: 'rtx', type: 'codec', mimeType: 'video/rtx' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_500_000);
  expect(samples.at(-1)?.codecs).toEqual(['H264', 'VP8']);
  stop();
});

it('measures incoming video and leaves gaps for missing, reset, stale, and failed reports', async () => {
  vi.useFakeTimers();
  let current = report(0, 100, 'inbound-rtp', 'video/VP9');
  let failure = false;
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats({ receiver: { getStats: async () => {
    if (failure) throw new Error('stats unavailable');
    return current;
  } } }, 'receive', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  current = report(125000, 1100, 'inbound-rtp', 'video/VP9');
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_000_000);
  expect(samples.at(-1)?.codecs).toEqual(['VP9']);
  for (const next of [current, new Map() as RTCStatsReport, report(500, 3100, 'inbound-rtp'), report(1, 4100, 'inbound-rtp')]) {
    current = next;
    await vi.advanceTimersByTimeAsync(1000);
    expect(samples.at(-1)?.bitrate).toBeNull();
  }
  failure = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBeNull();
  failure = false;
  current = report(1000, 6100, 'inbound-rtp');
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBeNull();
  current = report(126000, 7100, 'inbound-rtp');
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_000_000);
  expect(samples.at(-1)?.history.map((point) => point.bitrate)).toEqual([null, 1_000_000, null, null, null, null, null, null, 1_000_000]);
  stop();
});

it('keeps at most one minute in memory and discards pending results after stop', async () => {
  vi.useFakeTimers();
  let timestamp = 0;
  let finish: ((report: RTCStatsReport) => void) | undefined;
  let pending = false;
  const getStats = vi.fn(() => pending ? new Promise<RTCStatsReport>((resolve) => { finish = resolve; }) : Promise.resolve(report(timestamp++ * 125000, timestamp * 1000)));
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats({ sender: { getStats } }, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(samples.at(-1)?.history).toHaveLength(61);
  expect(samples.at(-1)?.history[0]?.at).toBe(60_000);
  pending = true;
  await vi.advanceTimersByTimeAsync(5000);
  const calls = getStats.mock.calls.length;
  const count = samples.length;
  stop();
  finish?.(report(9999999, 999999));
  await vi.advanceTimersByTimeAsync(5000);
  expect(getStats).toHaveBeenCalledTimes(calls);
  expect(samples).toHaveLength(count);
});

it('stops and clears diagnostics when the captured media track ends', async () => {
  vi.useFakeTimers();
  const mediaStreamTrack = new EventTarget() as MediaStreamTrack;
  const getStats = vi.fn(async () => report(0, 100));
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats({ sender: { getStats }, mediaStreamTrack }, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  mediaStreamTrack.dispatchEvent(new Event('ended'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(getStats).toHaveBeenCalledTimes(1);
  expect(samples.at(-1)?.history).toEqual([]);
  expect(samples.at(-1)?.bitrate).toBeNull();
  stop();
});

it('continues measuring the fallback when dynacast marks the primary inactive', async () => {
  vi.useFakeTimers();
  let bytes = 0;
  let timestamp = 100;
  const primary = new Map(report(0, 100));
  primary.get('video').active = false;
  const track = {
    sender: { getStats: async () => primary as RTCStatsReport },
    simulcastCodecs: new Map([['vp8', { sender: { getStats: async () => report(bytes, timestamp, 'outbound-rtp', 'video/VP8') } }]]),
  };
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats(track, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  bytes = 125000;
  timestamp = 1100;
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_000_000);
  expect(samples.at(-1)?.codecs).toEqual(['VP8']);
  stop();
});

it.each([
  ['true', true],
  [undefined, false],
  ['', false],
  ['false', false],
  ['TRUE', false],
  ['True', false],
  ['1', false],
  [' true', false],
  ['true ', false],
])('enables diagnostics only for the literal true flag (%s)', async (flag, enabled) => {
  const { shareStatsEnabled } = await import('./shareStats');
  expect(shareStatsEnabled(flag)).toBe(enabled);
});

it('uses active encoding state when browsers omit active from a paused sender report', async () => {
  vi.useFakeTimers();
  let bytes = 0;
  let timestamp = 100;
  const track = {
    sender: { getStats: async () => report(0, 100), getParameters: () => ({ encodings: [{ active: false }] }) },
    simulcastCodecs: new Map([['vp8', { sender: { getStats: async () => report(bytes, timestamp, 'outbound-rtp', 'video/VP8') } }]]),
  };
  const samples: ShareStatsSample[] = [];
  const stop = observeShareStats(track, 'send', (sample) => samples.push(sample));
  await vi.advanceTimersByTimeAsync(0);
  bytes = 125000;
  timestamp = 1100;
  await vi.advanceTimersByTimeAsync(1000);
  expect(samples.at(-1)?.bitrate).toBe(1_000_000);
  expect(samples.at(-1)?.codecs).toEqual(['VP8']);
  stop();
});
