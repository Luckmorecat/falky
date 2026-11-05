import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_REVOKED, LiveConnection, type LiveHandlers } from './live';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  close() {}
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
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects after a drop and reports the new opening, so the caller catches up', async () => {
    const h = handlers();
    new LiveConnection(h, 'ws://x').start();
    last().onopen!();
    last().onclose!({ code: 4000 });
    expect(h.onDown).toHaveBeenCalledOnce();
    // It had opened, so the socket is retried without asking through the API.
    expect(h.shouldRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
    last().onopen!();
    expect(h.onOpen).toHaveBeenCalledTimes(2);
  });

  it('stops for good when access is revoked', async () => {
    const h = handlers();
    new LiveConnection(h, 'ws://x').start();
    last().onopen!();
    last().onclose!({ code: CLOSE_REVOKED });
    expect(h.onRevoked).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('asks before retrying a connection that never opened, and obeys', async () => {
    const h = handlers({ shouldRetry: vi.fn(async () => false) });
    new LiveConnection(h, 'ws://x').start();
    last().onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.shouldRetry).toHaveBeenCalledOnce();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('passes events on and ignores what it cannot parse', () => {
    const h = handlers();
    new LiveConnection(h, 'ws://x').start();
    last().onmessage!({ data: 'not json' });
    last().onmessage!({ data: JSON.stringify({ type: 'room.changed', payload: { id: 'r', name: 'n' } }) });
    expect(h.onEvent).toHaveBeenCalledOnce();
  });

  it('does nothing further once stopped', async () => {
    const h = handlers();
    const live = new LiveConnection(h, 'ws://x');
    live.start();
    const ws = last();
    live.stop();
    ws.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onDown).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });
});
