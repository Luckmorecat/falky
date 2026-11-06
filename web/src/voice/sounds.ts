import type { VoiceSound } from './types';

/** What the interface itself says, next to what happens in a room. */
export type InterfaceCue = 'hover' | 'tap' | 'on' | 'off' | 'open' | 'close' | 'tick';
export type Sound = VoiceSound | InterfaceCue | 'test';

const MASTER_VOLUME = 0.3;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
const lastPlayed = new Map<Sound, number>();

/** Milliseconds a sound stays quiet after playing, so a sweep over buttons does not rattle. */
const MIN_GAP: Partial<Record<Sound, number>> = { hover: 45, tap: 30, tick: 35 };

function output(): { audio: AudioContext; out: GainNode } {
  if (!ctx || !master) {
    ctx = new AudioContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(compressor).connect(ctx.destination);
  }
  return { audio: ctx, out: master };
}

function envelope(audio: AudioContext, out: GainNode, start: number, attack: number, decay: number, peak: number): GainNode {
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  gain.connect(out);
  return gain;
}

/** A sine whose pitch climbs as it dies away: what the ear takes for a bubble. */
function bubble(start: number, from: number, to: number, decay: number, peak: number): void {
  const { audio, out } = output();
  const osc = audio.createOscillator();
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, start + decay);
  osc.connect(envelope(audio, out, start, 0.003, decay, peak));
  osc.start(start);
  osc.stop(start + decay + 0.05);
}

/** The water around a stream of bubbles, moving with it. */
function wash(start: number, from: number, to: number, decay: number, peak: number): void {
  const { audio, out } = output();
  if (!noise) {
    noise = audio.createBuffer(1, Math.round(audio.sampleRate * 0.5), audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const source = audio.createBufferSource();
  source.buffer = noise;
  const filter = audio.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.8;
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + decay);
  source.connect(filter).connect(envelope(audio, out, start, 0.04, decay, peak));
  source.start(start);
  source.stop(start + decay + 0.1);
}

/** Bubbles one after another between two pitches, unevenly, as water does it. */
function stream(start: number, count: number, low: number, high: number, gap: number, decay: number, peak: number, vary: number): void {
  let at = start;
  for (let i = 0; i < count; i++) {
    const pitch = low * (high / low) ** (count > 1 ? i / (count - 1) : 0) * vary;
    bubble(at, pitch, pitch * 1.55, decay * (0.85 + Math.random() * 0.3), peak * (0.8 + Math.random() * 0.2));
    at += gap * (0.7 + Math.random() * 0.6);
  }
}

const SOUNDS: Record<Sound, (t: number, vary: number, pitch: number) => void> = {
  hover: (t, v) => bubble(t, 880 * v, 1420 * v, 0.04, 0.1),
  tap(t, v) {
    bubble(t, 340 * v, 720 * v, 0.085, 0.5);
    bubble(t + 0.045, 760 * v, 1280 * v, 0.055, 0.18);
  },
  on: (t, v) => stream(t, 3, 480, 1020, 0.06, 0.075, 0.34, v),
  off: (t, v) => stream(t, 3, 1020, 460, 0.06, 0.075, 0.3, v),
  open(t, v) {
    stream(t, 5, 420, 1250, 0.038, 0.06, 0.2, v);
    wash(t, 600, 2200, 0.2, 0.05);
  },
  close(t, v) {
    stream(t, 4, 1100, 400, 0.04, 0.06, 0.18, v);
    wash(t, 2000, 600, 0.18, 0.04);
  },
  tick(t, v, pitch) {
    const base = 380 * 2 ** (pitch * 1.6) * v;
    bubble(t, base, base * 1.45, 0.05, 0.16);
  },
  join: (t, v) => stream(t, 6, 380, 1250, 0.055, 0.09, 0.55, v),
  leave: (t, v) => stream(t, 5, 1050, 340, 0.06, 0.09, 0.5, v),
  share: (t, v) => stream(t, 4, 640, 820, 0.08, 0.09, 0.5, v),
  test: (t, v) => stream(t, 7, 420, 1100, 0.07, 0.1, 0.55, v),
};

/**
 * A short synthesized sound, so that nothing but the client's own code is needed.
 * `pitch`, from 0 to 1, says how high a `tick` goes.
 */
export function playSound(sound: Sound, sinkId = '', pitch = 0.5): void {
  const now = performance.now();
  if (now - (lastPlayed.get(sound) ?? -Infinity) < (MIN_GAP[sound] ?? 60)) return;
  lastPlayed.set(sound, now);
  const { audio } = output();
  void audio.resume();
  const withSink = audio as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && withSink.setSinkId) void withSink.setSinkId(sinkId).catch(() => {});
  // A hair of difference each time, so that repeats do not sound mechanical.
  SOUNDS[sound](audio.currentTime + 0.005, 0.97 + Math.random() * 0.06, pitch);
}
