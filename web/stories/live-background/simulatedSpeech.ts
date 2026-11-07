/** Deterministic phrases for Storybook; no microphone or media connection. */
export function simulatedSpeech(time: number, index: number): number {
  const phrase = (time + index * 1.8) % 7.5;
  if (phrase > 4.9) return 0;
  const envelope = Math.min(1, phrase / .25, (4.9 - phrase) / .45);
  const syllables = .22 + .55 * Math.pow(.5 + .5 * Math.sin(time * 12 + index * 3), 2);
  return envelope * syllables * (.75 + .25 * Math.sin(time * 2.7 + index));
}
