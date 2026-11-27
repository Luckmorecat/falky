import type { Room } from 'livekit-client';

/** Safari also identifies some iPads as desktop Macs. */
export function usesNativeAudio(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

interface Sink {
  interruption?: 'waiting' | 'paused';
  blocked?: boolean;
  attempt: number;
  unwatch?: () => void;
}

const playbackEvents = ['playing', 'pause', 'waiting', 'stalled'];
const blockedPlayback = (error: unknown) => (error as Error | undefined)?.name === 'NotAllowedError';

/** Keeps playback failures tied to the room and the attachment that produced them. */
export class NativeAudio {
  private readonly sinks = new Map<HTMLMediaElement, Sink>();
  private roomBlocked = false;
  private roomAttempt = 0;
  private closed = false;

  constructor(
    private readonly room: Room,
    private readonly host: HTMLElement,
    private readonly canRecover: () => boolean,
    private readonly onBlocked: (blocked: boolean) => void,
  ) {
    for (const type of playbackEvents) this.host.addEventListener(type, this.trackPlayback, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private refresh(): void {
    this.onBlocked(this.roomBlocked || [...this.sinks.values()].some((sink) => sink.blocked));
  }

  watch(element: HTMLMediaElement, watchFailure: (retry: () => void) => () => void): void {
    this.roomAttempt++;
    const sink: Sink = { attempt: 0 };
    this.sinks.set(element, sink);
    // A track can recycle the same element. Check the current attachment's own result
    // before reporting a block from an SDK track event.
    sink.unwatch = watchFailure(() => {
      if (this.sinks.get(element) === sink && this.canRecover()) this.play(element, sink);
    });
  }

  unwatch(element: HTMLMediaElement): void {
    const sink = this.sinks.get(element);
    if (!sink) return;
    sink.unwatch?.();
    this.sinks.delete(element);
    this.roomAttempt++;
    this.roomBlocked = false;
    this.refresh();
  }

  private play(element: HTMLMediaElement, sink: Sink): void {
    const attempt = ++sink.attempt;
    const update = (blocked: boolean) => {
      if (this.sinks.get(element) !== sink || sink.attempt !== attempt) return;
      sink.blocked = blocked;
      this.refresh();
    };
    void element.play().then(() => update(false), (error: unknown) => {
      if (blockedPlayback(error)) update(true);
    });
  }

  start(): void {
    if (this.closed) return;
    const attempt = ++this.roomAttempt;
    const update = (blocked: boolean) => {
      if (this.roomAttempt !== attempt) return;
      this.roomBlocked = blocked;
      this.refresh();
    };
    void this.room.startAudio().then(() => update(false), (error: unknown) => {
      if (blockedPlayback(error)) update(true);
    });
  }

  sdkStatus(playing: boolean): void {
    if (playing) {
      this.roomBlocked = false;
      this.refresh();
    } else if (this.canRecover()) {
      // The SDK status covers the whole room and can be emitted after a track
      // was detached. Only retry sinks that still need playback.
      this.replaySinks();
    }
  }

  retry(foreground = false, force = false): void {
    if (!this.canRecover()) return;
    const startRoom = foreground || !this.room.canPlaybackAudio || this.roomBlocked;
    if (startRoom) this.start();
    if (!startRoom || force) this.replaySinks();
  }

  private replaySinks(): void {
    for (const [element, sink] of this.sinks) {
      if (element.paused || sink.interruption || sink.blocked) this.play(element, sink);
    }
  }

  private readonly trackPlayback = (event: Event) => {
    const element = event.target;
    if (!(element instanceof HTMLAudioElement)) return;
    const sink = this.sinks.get(element);
    if (!sink) return;
    if (event.type === 'playing') {
      sink.interruption = undefined;
      sink.blocked = false;
      sink.attempt++;
      this.refresh();
    } else if (event.type === 'pause') {
      if (!element.paused || sink.interruption === 'paused') return;
      sink.interruption = 'paused';
      if (this.canRecover()) this.play(element, sink);
    } else {
      sink.interruption ??= 'waiting';
    }
  };

  private readonly onClick = (event: MouseEvent) => {
    if (event.isTrusted && !(event.target instanceof Element && event.target.closest('[data-enable-voice-audio]'))) this.retry();
  };

  // LiveKit's own visibility hook does not cover desktop-mode iPads.
  private readonly onVisibility = () => this.retry(!/mobile\//i.test(navigator.userAgent));

  resetRoomBlock(): void {
    this.roomBlocked = false;
    this.roomAttempt++;
    this.refresh();
  }

  close(): void {
    this.closed = true;
    this.roomAttempt++;
    for (const sink of this.sinks.values()) sink.unwatch?.();
    this.sinks.clear();
    for (const type of playbackEvents) this.host.removeEventListener(type, this.trackPlayback, true);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
