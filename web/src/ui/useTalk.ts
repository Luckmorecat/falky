import { useCallback, useEffect, useRef } from 'react';
import { t } from '../strings';
import { showNotice, voice } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { getState, subscribe } from '../app/store';

type HoldSource = 'shortcut' | 'pointer' | 'button-key';

function canTalk(): boolean {
  const { voice: v, settings, sessionPaused } = getState();
  return settings.pushToTalk && !sessionPaused && !document.hidden && v.status === 'connected' && !v.deafened && !v.listenOnly;
}

/** Returns the same hold interaction for hardware keys and the dock button. */
export function useTalk(): (source: HoldSource, held: boolean) => void {
  const heldSources = useRef(new Set<HoldSource>());
  const hold = useCallback((source: HoldSource, held: boolean) => {
    const sources = heldSources.current;
    if (held) {
      if (!canTalk() || sources.has(source)) return;
      sources.add(source);
      if (sources.size === 1) void voice.setMuted(false);
    } else if (sources.delete(source) && sources.size === 0) {
      void voice.setMuted(true);
    }
  }, []);

  useEffect(() => {
    let heldKey: string | null = null;
    const typing = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable]');
    const down = (e: KeyboardEvent) => {
      if (!getState().settings.pushToTalk || e.code !== shortcuts.pushToTalk.code || typing(e)) return;
      // Holding the key must not also press whatever button has focus.
      e.preventDefault();
      if (!e.repeat) { heldKey = e.code; hold('shortcut', true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== heldKey) return;
      heldKey = null;
      if (heldSources.current.has('shortcut')) e.preventDefault();
      hold('shortcut', false);
    };
    const release = () => {
      heldKey = null;
      if (!heldSources.current.size) return;
      heldSources.current.clear();
      void voice.setMuted(true);
    };
    const releaseWhenUnavailable = () => { if (!canTalk()) release(); };
    const unsubscribe = subscribe(releaseWhenUnavailable);
    document.addEventListener('visibilitychange', releaseWhenUnavailable);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', release);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', releaseWhenUnavailable);
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', release);
      release();
    };
  }, [hold]);

  useEffect(trackSilence, []);
  return hold;
}

const SILENCE_POLL_MS = 2000;

function trackSilence(): () => void {
  let self: string | undefined;
  let silentFor = 0;
  let lastPoll = Date.now();

  const observe = () => {
    const { voice: v, settings, sessionPaused } = getState();
    const local = v.people.find((p) => p.local)?.id;
    const active = v.status === 'connected' && !document.hidden && !sessionPaused && !v.muted
      && !v.deafened && !v.listenOnly && settings.awayMute && !settings.pushToTalk;
    const silent = active && local && !v.speakers.includes(local) ? local : undefined;
    if (silent === self) return;
    self = silent;
    silentFor = 0;
    lastPoll = Date.now();
  };

  observe();
  const unsubscribe = subscribe(observe);
  document.addEventListener('visibilitychange', observe);
  const interval = setInterval(() => {
    observe();
    const now = Date.now();
    const gap = now - lastPoll;
    lastPoll = now;
    // A suspended or throttled browser did not observe silence during the gap.
    if (!self || gap < 0 || gap > 2 * SILENCE_POLL_MS) { silentFor = 0; return; }
    silentFor += gap;
    const { voice: v, settings } = getState();
    const minutes = Number(settings.awayMinutes);
    if (silentFor < minutes * 60_000) return;
    silentFor = 0;
    void voice.setMuted(true).then(() => {
      const current = getState().voice;
      if (current.joinedAt === v.joinedAt && current.roomId === v.roomId && current.muted && !current.deafened) {
        showNotice(t.awayMutedTitle, t.awayMutedBody(minutes));
      }
    });
  }, SILENCE_POLL_MS);

  return () => {
    clearInterval(interval);
    unsubscribe();
    document.removeEventListener('visibilitychange', observe);
  };
}
