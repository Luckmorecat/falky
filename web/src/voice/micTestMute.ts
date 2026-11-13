export interface MicTestMute {
  ready: Promise<void>;
  release(): void;
}

/** A test owns only its temporary mute, and cannot restore an obsolete room. */
export class MicTestMuting {
  private holds = new Set<symbol>();
  private restore?: () => Promise<void>;
  private ready = Promise.resolve();
  private revision = 0;

  get active(): boolean { return this.holds.size > 0; }

  acquire(mute: () => Promise<void>, restore?: () => Promise<void>): MicTestMute {
    const token = Symbol();
    const first = !this.active;
    this.holds.add(token);
    if (first) {
      this.revision++;
      this.restore ??= restore;
      this.ready = mute();
    }
    return { ready: this.ready, release: () => {
      if (!this.holds.delete(token) || this.active) return;
      const revision = this.revision;
      const restore = this.restore;
      void this.ready.catch(() => {}).then(async () => {
        if (revision === this.revision && !this.active) {
          this.restore = undefined;
          await restore?.();
        }
      }).catch(() => {});
    } };
  }

  keepMuted(): void { this.restore = undefined; this.revision++; }

  reset(): void {
    this.keepMuted();
    this.holds.clear();
  }
}
