import { api } from '../api/client';
import { preferencePrefix } from '../runtime/preferences';

/** Exact grant targets outlive media, browser sessions, and replacement joins. */
export class PendingLeaves {
  private readonly prefix = preferencePrefix + 'pendingLeave.';
  private readonly entries = new Set<string>();
  private readonly sending = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private suspended = false;
  private readonly pagehide = () => {
    this.suspended = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  };
  private readonly pageshow = () => { this.suspended = false; void this.retry(); };
  private readonly reachable = () => { void this.retry(); };

  constructor(private readonly changed: () => void) {
    this.read();
    window.addEventListener('pageshow', this.pageshow);
    window.addEventListener('pagehide', this.pagehide);
    window.addEventListener('online', this.reachable);
    window.addEventListener('focus', this.reachable);
    window.addEventListener('storage', this.reachable);
    // Defer notification until the containing voice client has been constructed.
    queueMicrotask(() => { if (!this.disposed) { this.changed(); void this.retry(); } });
  }

  get count(): number { return this.entries.size; }

  add(grantId: string): Promise<void> {
    if (!grantId) return Promise.resolve();
    this.entries.add(grantId);
    try { localStorage.setItem(this.prefix + grantId, 'pending'); } catch { /* Keep visible in memory if browser storage is unavailable. */ }
    this.changed();
    return this.send(grantId);
  }

  async retry(): Promise<void> {
    if (this.disposed || this.suspended) return;
    this.read();
    this.changed();
    await Promise.all([...this.entries].map((grantId) => this.send(grantId)));
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    window.removeEventListener('pageshow', this.pageshow);
    window.removeEventListener('pagehide', this.pagehide);
    window.removeEventListener('online', this.reachable);
    window.removeEventListener('focus', this.reachable);
    window.removeEventListener('storage', this.reachable);
  }

  private read(): void {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(this.prefix)) this.entries.add(key.slice(this.prefix.length));
      }
    } catch { /* Storage can be disabled independently of media access. */ }
  }

  private send(grantId: string): Promise<void> {
    const existing = this.sending.get(grantId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const result = await api.leaveVoice(grantId);
        if (result.revoked === true) {
          try { localStorage.removeItem(this.prefix + grantId); } catch { /* A later retry is idempotent. */ }
          this.entries.delete(grantId);
        }
      } catch {
        // Neither a lost response nor 401 proves that this grant was revoked.
      } finally {
        this.sending.delete(grantId);
        this.changed();
        if (!this.disposed && !this.suspended && this.entries.size && !this.timer) {
          this.timer = setTimeout(() => { this.timer = undefined; void this.retry(); }, 10_000);
        }
      }
    })();
    this.sending.set(grantId, request);
    return request;
  }
}
