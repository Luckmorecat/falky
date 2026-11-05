import type { VoiceSound } from './session';

let ctx: AudioContext | null = null;

const NOTES: Record<VoiceSound | 'test', [number, number][]> = {
  join: [[523, 0], [784, 0.09]],
  leave: [[659, 0], [440, 0.09]],
  share: [[698, 0], [698, 0.12]],
  test: [[660, 0], [880, 0.16], [660, 0.32]],
};

/** A short synthesized cue, so that nothing but the client's own code is needed. */
export function playSound(sound: VoiceSound | 'test', sinkId = ''): void {
  ctx ??= new AudioContext();
  void ctx.resume();
  const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && withSink.setSinkId) void withSink.setSinkId(sinkId).catch(() => {});
  const start = ctx.currentTime + 0.01;
  for (const [freq, at] of NOTES[sound]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.08, start + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.18);
  }
}
