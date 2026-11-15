import type { VoiceSound } from './types';

/** What the interface itself says, next to what happens in a room. */
export type InterfaceCue = 'tap' | 'on' | 'off' | 'open' | 'close' | 'tick';
/** Played to the whole room from the reactions tray. */
export type BoardSound = 'rimshot' | 'horn' | 'tada' | 'crickets';
export type Sound = VoiceSound | InterfaceCue | BoardSound | 'test';

const MASTER_VOLUME = 0.3;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
const lastPlayed = new Map<Sound, number>();

/** Milliseconds a sound stays quiet after playing, so a sweep over buttons does not rattle. */
const MIN_GAP: Partial<Record<Sound, number>> = { tap: 30, tick: 35 };

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

/** A pitched tone with its own envelope, for the board's sounds. */
function tone(start: number, type: OscillatorType, from: number, to: number, attack: number, decay: number, peak: number, lowpass = 0): void {
  const { audio, out } = output();
  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + attack + decay);
  const env = envelope(audio, out, start, attack, decay, peak);
  if (lowpass) {
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    osc.connect(filter).connect(env);
  } else osc.connect(env);
  osc.start(start);
  osc.stop(start + attack + decay + 0.05);
}

const SOUNDS: Record<Sound, (t: number, vary: number, pitch: number) => void> = {
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
  rimshot(t, v) {
    tone(t, 'sine', 200 * v, 90, 0.004, 0.16, 0.7);
    tone(t + 0.17, 'sine', 150 * v, 70, 0.004, 0.2, 0.7);
    wash(t + 0.42, 7000, 9000, 0.45, 0.35);
    tone(t + 0.42, 'triangle', 330 * v, 300, 0.002, 0.08, 0.25);
  },
  horn(t, v) {
    for (const [at, length] of [[0, 0.16], [0.22, 0.16], [0.44, 0.55]] as const) {
      tone(t + at, 'sawtooth', 415 * v, 415 * v, 0.02, length, 0.22, 2200);
      tone(t + at, 'sawtooth', 523 * v, 523 * v, 0.02, length, 0.16, 2200);
    }
  },
  tada(t, v) {
    [523, 659, 784].forEach((f, i) => tone(t + i * 0.07, 'triangle', f * v, f * v, 0.01, 0.16, 0.3));
    for (const f of [523, 659, 784, 1047]) tone(t + 0.24, 'triangle', f * v, f * v, 0.02, 0.9, 0.18);
  },
  crickets(t, v) {
    for (let chirp = 0; chirp < 3; chirp++) {
      for (let pulse = 0; pulse < 4; pulse++) tone(t + chirp * 0.42 + pulse * 0.045, 'sine', 4300 * v, 4300 * v, 0.006, 0.03, 0.12);
    }
  },
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
