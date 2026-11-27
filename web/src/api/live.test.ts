import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_REVOKED, LiveConnection, type LiveHandlers } from './live';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  close = vi.fn(() => { this.readyState = FakeSocket.CLOSED; });
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function handlers(over: Partial<LiveHandlers> = {}): LiveHandlers {
  return {
    onEvent: vi.fn(),
    onOpen: vi.fn(),
    onDown: vi.fn(),
    onRevoked: vi.fn(),
    shouldRetry: vi.fn(async () => true),
    ...over,
  };
}

describe('LiveConnection', () => {
  let live: LiveConnection;

  function start(h: LiveHandlers): void {
    live = new LiveConnection(h, 'ws://x');
    live.start();
  }

  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    live.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects after a drop and reports the new opening, so the caller catches up', async () => {
    const h = handlers();
    start(h);
    last().open();
    last().onclose!({ code: 4000 });
    expect(h.onDown).toHaveBeenCalledOnce();
    // It had opened, so the socket is retried without asking through the API.
    expect(h.shouldRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    expect(h.onOpen).toHaveBeenCalledTimes(2);
  });

  it('stops for good when access is revoked', async () => {
    const h = handlers();
    start(h);
    last().open();
    last().onclose!({ code: CLOSE_REVOKED });
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(h.onRevoked).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('asks before retrying a connection that never opened, and obeys', async () => {
    const h = handlers({ shouldRetry: vi.fn(async () => false) });
    start(h);
    last().onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.shouldRetry).toHaveBeenCalledOnce();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('backs off across failed upgrades and resets after opening', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = handlers();
    start(h);
    last().onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.all).toHaveLength(2);

    last().onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);

    last().open();
    last().onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('passes events on and ignores what it cannot parse', () => {
    const h = handlers();
    start(h);
    last().onmessage!({ data: 'not json' });
    last().onmessage!({ data: JSON.stringify({ type: 'room.changed', payload: { id: 'r', name: 'n' } }) });
    expect(h.onEvent).toHaveBeenCalledOnce();
  });

  it('does nothing further once stopped', async () => {
    const h = handlers();
    start(h);
    const ws = last();
    live.stop();
    ws.onclose!({ code: 1006 });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onDown).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('abandons a stalled upgrade and only accepts callbacks from its replacement', async () => {
    const h = handlers();
    start(h);
    const ws = last();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.close).toHaveBeenCalledOnce();
    expect(h.onDown).toHaveBeenCalledOnce();
    expect(h.shouldRetry).toHaveBeenCalledOnce();

    ws.onopen!();
    ws.onmessage!({ data: JSON.stringify({ type: 'room.changed' }) });
    ws.onclose!({ code: CLOSE_REVOKED });
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onEvent).not.toHaveBeenCalled();
    expect(h.onRevoked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    expect(h.onOpen).toHaveBeenCalledOnce();
  });

  it('continues recovery when retry authorization stalls after a failed replacement', async () => {
    const shouldRetry = vi.fn((_signal?: AbortSignal) => new Promise<boolean>(() => {}));
    const h = handlers({ shouldRetry });
    start(h);
    last().open();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10_000);
    const signal = shouldRetry.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    expect(h.onOpen).toHaveBeenCalledTimes(2);
  });

  it('keeps an idle connection through a short time in the background', async () => {
    const h = handlers();
    start(h);
    const ws = last();
    ws.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(h.onDown).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it.each(['foreground', 'online', 'page restore'] as const)('rechecks the live path on %s', async (reason) => {
    const h = handlers();
    start(h);
    const ws = last();
    ws.open();
    if (reason === 'foreground') {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(30_000);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    } else if (reason === 'online') {
      window.dispatchEvent(new Event('offline'));
      expect(ws.close).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('online'));
    } else {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }
    expect(ws.close).toHaveBeenCalledOnce();
    expect(h.onDown).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    ws.onclose!({ code: 1006 });
    last().open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.onOpen).toHaveBeenCalledTimes(2);
    expect(h.onDown).toHaveBeenCalledOnce();
    expect(h.shouldRetry).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it.each([true, false])('ignores a retry decision of %s from before a stop and restart', async (retry) => {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((finish) => { resolve = finish; });
    const shouldRetry = vi.fn((_signal?: AbortSignal) => promise);
    const h = handlers({ shouldRetry });
    start(h);
    last().onclose!({ code: 1006 });
    expect(h.shouldRetry).toHaveBeenCalledOnce();

    live.stop();
    expect(shouldRetry.mock.calls[0]?.[0]?.aborted).toBe(true);
    live.start();
    const ws = last();
    ws.open();
    resolve(retry);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(ws.close).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(3);
  });
});
