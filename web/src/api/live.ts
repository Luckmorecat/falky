import type { LiveEvent } from './client';

/** The close code the server sends after `access.revoked`. */
export const CLOSE_REVOKED = 4001;

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

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
   * the API and answers whether to go on.
   */
  shouldRetry(): Promise<boolean>;
}

/** The live-update WebSocket: reconnects with backoff until stopped. */
export class LiveConnection {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly handlers: LiveHandlers,
    private readonly url: string = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      opened = true;
      this.attempts = 0;
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
      this.ws = null;
      if (e.code === CLOSE_REVOKED) {
        this.stopped = true;
        this.handlers.onRevoked();
        return;
      }
      this.handlers.onDown();
      void this.retry(opened);
    };
  }

  private async retry(opened: boolean): Promise<void> {
    if (!opened && !(await this.handlers.shouldRetry())) {
      this.stopped = true;
      return;
    }
    if (this.stopped) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts);
    this.attempts++;
    // Jitter, so a restarted server is not met by every client at once.
    this.timer = setTimeout(() => this.open(), delay * (0.75 + Math.random() * 0.5));
  }
}
