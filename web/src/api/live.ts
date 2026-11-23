import type { LiveEvent } from './client';

/** The close code the server sends after `access.revoked`. */
export const CLOSE_REVOKED = 4001;

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RETRY_CHECK_TIMEOUT_MS = 10_000;
const STALE_BACKGROUND_MS = 30_000;

export interface LiveHandlers {
  onEvent(event: LiveEvent): void;
  /** Opened, for the first time or again: the caller catches up on what it missed. */
  onOpen(): void;
  /** The connection is down and another attempt follows unless `shouldRetry` says no. */
  onDown(): void;
  /** The server ended access; no more attempts are made. */
  onRevoked(): void;
  /**
   * A browser hides why an upgrade failed (401, or 409 for a taken name), so
   * before retrying a connection that never opened the caller checks through
   * the API and answers whether to go on. The check is aborted on timeout or stop.
   */
  shouldRetry(signal?: AbortSignal): Promise<boolean>;
}

/** The live-update WebSocket: reconnects with backoff until stopped. */
export class LiveConnection {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private run: AbortController | null = null;
  private hiddenAt: number | null = null;

  constructor(
    private readonly handlers: LiveHandlers,
    private readonly url: string = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`,
  ) {}

  start(): void {
    if (this.run) return;
    const run = new AbortController();
    this.run = run;
    this.attempts = 0;
    this.hiddenAt = document.visibilityState === 'hidden' ? Date.now() : null;
    const options = { signal: run.signal };
    document.addEventListener('visibilitychange', this.onVisibilityChange, options);
    window.addEventListener('online', this.recover, options);
    window.addEventListener('pageshow', this.onPageShow, options);
    this.open(run.signal);
  }

  stop(): void {
    const run = this.run;
    this.run = null;
    this.releaseSocket()?.close();
    run?.abort();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private releaseSocket(): WebSocket | null {
    this.clearTimer();
    const ws = this.ws;
    this.ws = null;
    return ws;
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt ??= Date.now();
      return;
    }
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_BACKGROUND_MS) this.recover();
  };

  private onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.recover();
  };

  private recover = (): void => {
    const signal = this.run?.signal;
    const ws = this.ws;
    if (!signal || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Browsers handle WebSocket pings internally. A fresh authenticated
    // upgrade checks this path even when there are no chat events to receive.
    this.releaseSocket()?.close();
    this.onDown(true, signal);
  };

  private open(signal: AbortSignal): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    this.timer = setTimeout(() => {
      if (ws !== this.ws) return;
      this.releaseSocket()?.close();
      this.onDown(false, signal);
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.clearTimer();
      opened = true;
      this.attempts = 0;
      if (this.hiddenAt !== null) this.hiddenAt = Date.now();
      this.handlers.onOpen();
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws || typeof e.data !== 'string') return;
      let event: LiveEvent;
      try {
        event = JSON.parse(e.data) as LiveEvent;
      } catch {
        return;
      }
      this.handlers.onEvent(event);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      this.releaseSocket();
      if (e.code === CLOSE_REVOKED) {
        this.stop();
        this.handlers.onRevoked();
        return;
      }
      this.onDown(opened, signal);
    };
  }

  private onDown(opened: boolean, signal: AbortSignal): void {
    this.handlers.onDown();
    if (!signal.aborted) void this.retry(opened, signal);
  }

  private async retry(opened: boolean, signal: AbortSignal): Promise<void> {
    if (!opened) {
      const allowed = await this.checkRetryAccess(signal);
      if (signal.aborted) return;
      if (!allowed) {
        this.stop();
        return;
      }
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts);
    this.attempts++;
    // Jitter, so a restarted server is not met by every client at once.
    this.timer = setTimeout(() => {
      if (!signal.aborted) this.open(signal);
    }, delay * (0.75 + Math.random() * 0.5));
  }

  private async checkRetryAccess(signal: AbortSignal): Promise<boolean> {
    const check = new AbortController();
    const abort = () => check.abort();
    const timer = setTimeout(abort, RETRY_CHECK_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    // An unavailable API leaves access unknown, so try the upgrade again.
    const retryOnAbort = new Promise<true>((resolve) => {
      check.signal.addEventListener('abort', () => resolve(true), { once: true });
    });
    try {
      return await Promise.race([retryOnAbort, this.handlers.shouldRetry(check.signal)]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
