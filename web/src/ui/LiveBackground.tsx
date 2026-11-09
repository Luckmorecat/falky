import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef } from 'react';
import { useApp } from '../app/store';
import { createBackground } from '../fx/backgroundRenderer';
import { createThemeWave } from '../fx/themeWave';
import { createUnreadBeacon } from '../fx/unreadBeacon';
import { effectsReduced, onTick } from '../fx/ticker';
import type { VoiceSource } from '../fx/voiceField';

// Match CSS/FLIP time even when GPU work delays animation frames.
const layoutTime = () => Number(document.timeline.currentTime ?? performance.now());

export interface LiveBackgroundHandle {
  setSources(sources: VoiceSource[]): void;
  invalidateLayout(): void;
}

/** Screen-owned canvas; participant membership never resets the theme wave. */
export function LiveBackground({ ref, unreadTarget }: { ref: Ref<LiveBackgroundHandle>; unreadTarget: RefObject<HTMLElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sources = useRef<VoiceSource[]>([]);
  const renderer = useRef<ReturnType<typeof createBackground>>(null);
  const enabled = useApp((s) => s.settings.liveBackground && !s.settings.fewerEffects);
  const message = useApp((s) => {
    const chat = s.viewedRoomId ? s.chats[s.viewedRoomId] : undefined;
    if (s.chatOpen || !chat?.unread) return null;
    const newest = chat.messages.findLast((m) => m.authorId !== s.visitor?.id);
    return newest ? `${s.viewedRoomId}/${newest.id}` : null;
  });
  const unread = useRef({ message, target: unreadTarget });
  unread.current = { message, target: unreadTarget };
  const wave = useRef<ReturnType<typeof createThemeWave> | null>(null);
  const layoutUntil = useRef(0);

  useImperativeHandle(ref, () => ({
    setSources: (next) => {
      sources.current = next;
      renderer.current?.setSources(next);
    },
    invalidateLayout: () => { layoutUntil.current = layoutTime() + 500; },
  }), []);

  useEffect(() => {
    if (!enabled) { wave.current = null; return; }
    const painter = createBackground(canvas.current!, sources.current);
    if (!painter) return;
    renderer.current = painter;
    wave.current ??= createThemeWave(document.documentElement.dataset.theme === 'light');
    layoutUntil.current = layoutTime() + 500;
    const beacon = createUnreadBeacon();
    let time = 0;
    const stop = onTick((_now, dt) => {
      time += dt;
      if (layoutUntil.current) {
        painter.invalidateLayout();
        // Measure once after settling too, even if a slow frame skipped the deadline.
        if (layoutTime() >= layoutUntil.current) layoutUntil.current = 0;
      }
      const reduced = effectsReduced();
      const theme = wave.current!.frame(document.documentElement.dataset.theme === 'light', dt, reduced);
      const { message, target } = unread.current;
      const frame = beacon.frame(message, dt, reduced);
      painter.draw(time, 1.5, 480, reduced, theme, message && target.current ? { element: target.current, frame } : undefined);
    });
    return () => { stop(); painter.dispose(); renderer.current = null; };
  }, [enabled]);

  return <canvas ref={canvas} className="live-background" data-beacon={enabled && message ? '' : undefined} aria-hidden="true" />;
}
