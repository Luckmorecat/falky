import { useEffect } from 'react';
import { t } from '../strings';
import { showNotice, voice } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { getState } from '../app/store';

let wantLive = false;
let settling = false;

/**
 * Brings the microphone to what the key says. A press and release can both
 * land while one toggle is still under way, so it settles until they agree.
 */
async function settle(): Promise<void> {
  if (settling) return;
  settling = true;
  try {
    for (let tries = 0; tries < 3; tries++) {
      const v = getState().voice;
      if (v.status !== 'connected' || v.deafened || v.listenOnly || wantLive === !v.muted) break;
      await voice.toggleMute();
    }
  } finally {
    settling = false;
  }
}

export function holdToTalk(live: boolean): void {
  wantLive = live;
  void settle();
}

/** How long a live microphone may stay silent before it is turned off. */
export const AWAY_AFTER = 10 * 60_000;

/** Push to talk while a setting asks for it, and the microphone off for anyone long silent. */
export function useTalk(): void {
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable]');
    const down = (e: KeyboardEvent) => {
      if (!getState().settings.pushToTalk || e.code !== shortcuts.pushToTalk.code || typing(e)) return;
      // Holding the key must not also press whatever button has focus.
      e.preventDefault();
      if (!e.repeat) holdToTalk(true);
    };
    const up = (e: KeyboardEvent) => {
      if (!getState().settings.pushToTalk || e.code !== shortcuts.pushToTalk.code) return;
      e.preventDefault();
      holdToTalk(false);
    };
    const release = () => { if (getState().settings.pushToTalk) holdToTalk(false); };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', release);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', release);
    };
  }, []);

  useEffect(() => {
    let lastHeard = performance.now();
    let wasLive = false;
    const check = setInterval(() => {
      const s = getState();
      const v = s.voice;
      const self = v.people.find((p) => p.local)?.id;
      const live = v.status === 'connected' && !v.muted && !s.settings.pushToTalk;
      if (!live || !self || !wasLive || v.speakers.includes(self)) lastHeard = performance.now();
      wasLive = live;
      if (live && s.settings.awayMute && performance.now() - lastHeard > AWAY_AFTER) {
        void voice.toggleMute();
        showNotice(t.awayMutedTitle, t.awayMutedBody);
      }
    }, 2000);
    return () => clearInterval(check);
  }, []);
}
