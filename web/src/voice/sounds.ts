import type { VoiceSound } from './types';

/** What the interface itself says, next to what happens in a room. */
export type InterfaceCue = 'tap' | 'on' | 'off' | 'open' | 'close' | 'tick';
/** Played to the whole room from the reactions tray. */
export type BoardSound = 'boom' | 'airhorn' | 'sad' | 'pipe' | 'dun' | 'bonk';
export type Sound = VoiceSound | InterfaceCue | BoardSound | 'pop' | 'knock' | 'test';

const MASTER_VOLUME = 0.3;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
const lastPlayed = new Map<Sound, number>();

/** Milliseconds a sound stays quiet after playing, so a sweep over buttons does not rattle. */
const MIN_GAP: Partial<Record<Sound, number>> = { tap: 30, tick: 35, pop: 20, boom: 30, airhorn: 30, sad: 30, pipe: 30, dun: 30, bonk: 30 };

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

interface NoteShape {
  lowpass?: number;
  /** How far the pitch wobbles, as a fraction of it, growing as the note is held. */
  vibrato?: number;
  /** Seconds for the filter to open from muffled, as a mute pulled away from a bell. */
  wah?: number;
  /** Where the pitch ends, as a fraction of where it began. */
  bend?: number;
}

/** A held note that sustains before it lets go, for horns and brass. */
function note(start: number, type: OscillatorType, freq: number, length: number, peak: number, { lowpass = 0, vibrato = 0, wah = 0, bend = 1 }: NoteShape = {}): void {
  const { audio, out } = output();
  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (bend !== 1) osc.frequency.exponentialRampToValueAtTime(freq * bend, start + length);
  if (vibrato) {
    const lfo = audio.createOscillator();
    lfo.frequency.value = 5.5;
    const depth = audio.createGain();
    depth.gain.setValueAtTime(0, start);
    depth.gain.linearRampToValueAtTime(freq * vibrato, start + length * 0.6);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(start + length + 0.05);
  }
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  gain.gain.setValueAtTime(peak, start + length * 0.75);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  gain.connect(out);
  let tail: AudioNode = osc;
  if (lowpass) {
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = wah ? 6 : 0.7;
    filter.frequency.setValueAtTime(wah ? lowpass * 0.3 : lowpass, start);
    if (wah) filter.frequency.exponentialRampToValueAtTime(lowpass, start + Math.min(wah, length));
    tail = osc.connect(filter);
  }
  tail.connect(gain);
  osc.start(start);
  osc.stop(start + length + 0.05);
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
  pop(t, v, pitch) {
    const base = 480 * 2 ** (pitch * 1.3) * v;
    bubble(t, base, base * 1.9, 0.07, 0.55);
    bubble(t + 0.03, base * 1.5, base * 2.4, 0.05, 0.2);
  },
  // A deep hit falling away, and its echo.
  boom(t, v) {
    for (const [at, level] of [[0, 1], [0.34, 0.3]] as const) {
      tone(t + at, 'sine', 150 * v, 36, 0.004, 0.95, 0.95 * level);
      tone(t + at, 'triangle', 310 * v, 55, 0.003, 0.4, 0.4 * level, 900);
      wash(t + at, 1600, 180, 0.28, 0.35 * level);
    }
  },
  // Three blasts and a long one, each sagging a little as the can runs out.
  airhorn(t, v) {
    for (const [at, length] of [[0, 0.2], [0.25, 0.11], [0.4, 0.11], [0.55, 0.75]] as const) {
      for (const [f, peak] of [[392, 0.15], [397, 0.15], [589, 0.09], [786, 0.06]] as const) note(t + at, 'sawtooth', f * v, length, peak, { lowpass: 3400, bend: 0.97 });
    }
  },
  // Wah, wah, wah, waaah: each note opening like a plunger mute, the last one wobbling.
  sad(t, v) {
    [294, 277, 262].forEach((f, i) => note(t + i * 0.38, 'sawtooth', f * v, 0.34, 0.22, { lowpass: 1500, wah: 0.14 }));
    note(t + 1.14, 'sawtooth', 247 * v, 1.3, 0.22, { lowpass: 1500, wah: 0.18, vibrato: 0.035 });
  },
  // A struck tube rings at partials no string has; then it bounces twice on the floor.
  pipe(t, v) {
    for (const [at, level] of [[0, 1], [0.36, 0.45], [0.58, 0.22]] as const) {
      for (const [ratio, decay] of [[1, 1.5], [2.76, 1], [5.4, 0.65], [8.93, 0.4], [13.3, 0.22]] as const) {
        tone(t + at, 'sine', 520 * ratio * v, 520 * ratio * v, 0.002, decay * level + 0.08, 0.18 * level);
      }
      wash(t + at, 7000, 3000, 0.1, 0.35 * level);
    }
  },
  // Two stabs of a low minor chord over a timpani, then the long one, a step down.
  dun(t, v) {
    for (const [at, length, shift] of [[0, 0.2, 1], [0.28, 0.2, 1], [0.6, 1.5, 0.94]] as const) {
      for (const f of [98, 147, 196, 233]) note(t + at, 'sawtooth', f * shift * v, length, 0.11, { lowpass: 1300, vibrato: length > 1 ? 0.02 : 0 });
      tone(t + at, 'sine', 110 * shift * v, 60, 0.004, length > 1 ? 0.9 : 0.3, 0.7);
    }
  },
  // A hollow head under a mallet: a pitch dropping fast over a woody knock.
  bonk(t, v) {
    tone(t, 'sine', 820 * v, 230 * v, 0.002, 0.15, 0.85);
    tone(t, 'square', 410 * v, 120 * v, 0.002, 0.06, 0.14, 1800);
    wash(t, 2600, 1200, 0.05, 0.45);
    tone(t + 0.05, 'triangle', 300 * v, 290 * v, 0.003, 0.28, 0.22);
  },
  // Two raps on a door, then two more.
  knock(t, v) {
    for (const at of [0, 0.14, 0.5, 0.64]) {
      bubble(t + at, 190 * v, 150 * v, 0.07, 0.75);
      wash(t + at, 900, 500, 0.05, 0.12);
    }
  },
};

/**
 * A short synthesized sound, so that nothing but the client's own code is needed.
 * `pitch`, from 0 to 1, says how high a `tick` or a `pop` goes.
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
