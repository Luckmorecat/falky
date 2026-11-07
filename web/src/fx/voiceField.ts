/** Voice sampling and propagation, independent of theme transition timing. */
import type { PaletteName } from './palette';

export const HISTORY = 32;
export const SAMPLE_INTERVAL = .1;

export interface VoiceSource {
  element: HTMLElement;
  palette: PaletteName;
  level: () => number;
}

export function createVoiceField(count: number) {
  const voices = new Float32Array(count * 4);
  const history = new Float32Array(count * HISTORY);
  const active = new Float32Array(count);
  let lastSample = 0;
  let lastTime = 0;
  return {
    voices, history, active,
    update(time: number, sources: VoiceSource[]) {
      const previousTime = lastTime;
      const dt = Math.min(.05, Math.max(0, time - previousTime));
      lastTime = time;
      const sampleTime = Math.floor((time + 1e-7) / SAMPLE_INTERVAL) * SAMPLE_INTERVAL;
      const sampleDue = sampleTime > lastSample;
      if (sampleDue) {
        for (let i = 0; i < count; i++) history.copyWithin(i * HISTORY + 1, i * HISTORY, (i + 1) * HISTORY - 1);
        lastSample = sampleTime;
      }
      for (let i = 0; i < Math.min(sources.length, count); i++) {
        const target = sources[i]!.level();
        const previous = voices[i * 4 + 2]!;
        const level = previous + (target - previous) * (1 - Math.exp(-dt * (target > previous ? 12 : 2.8)));
        voices[i * 4 + 2] = level;
        if (sampleDue) {
          const fraction = Math.max(0, Math.min(1, (sampleTime - previousTime) / Math.max(time - previousTime, .0001)));
          history[i * HISTORY] = previous + (level - previous) * fraction;
        }
        let peak = level;
        for (let j = 0; j < HISTORY; j++) peak = Math.max(peak, history[i * HISTORY + j]!);
        active[i] = peak > .001 ? 1 : 0;
      }
      return { phase: Math.max(0, time - lastSample), moving: active.some((value) => value > 0) };
    },
    clear() {
      for (let i = 0; i < count; i++) voices[i * 4 + 2] = 0;
      history.fill(0);
      active.fill(0);
      lastSample = lastTime;
    },
  };
}
