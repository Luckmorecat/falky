const JOIN_TIMEOUT_MS = 20_000;

/** The deadline covers SDK loading, HTTP admission and connection setup. */
export class JoinAttempt {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer = setTimeout(() => this.cancel(), JOIN_TIMEOUT_MS);
  private readonly interrupted = new Promise<never>((_, reject) => {
    this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true });
  });

  cancel(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }

  async waitFor<T>(work: Promise<T>): Promise<T> {
    try {
      return await Promise.race([work, this.interrupted]);
    } finally {
      clearTimeout(this.timer);
    }
  }
}
