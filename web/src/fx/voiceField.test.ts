import { expect, it } from 'vitest';
import { createVoiceField, HISTORY, type VoiceSource } from './voiceField';

it('keeps the history active after a voice quiets and ages out an absent source', () => {
  let level = 1;
  const source: VoiceSource = { element: document.createElement('div'), palette: 'sky', level: () => level };
  const field = createVoiceField(1);
  expect(field.update(1, [source]).moving).toBe(true);

  level = 0;
  for (let frame = 1; frame <= 50; frame++) field.update(1 + frame / 20, [source]);
  expect(field.voices[2]).toBeLessThan(.001);
  expect(field.active[0]).toBe(1);
  expect(field.history.some((value) => value > .001)).toBe(true);

  for (let sample = 1; sample <= HISTORY + 2; sample++) field.update(3.5 + sample / 10, []);
  expect(field.history.some((value) => value > .001)).toBe(false);
  const next = field.update(3.5 + (HISTORY + 2) / 10 + .001, [source]);
  expect(next.phase).toBeCloseTo(.001);
  expect(next.moving).toBe(false);
  expect(field.active[0]).toBe(0);
});

it('clears a cached peak before the next sample', () => {
  let level = 1;
  const source: VoiceSource = { element: document.createElement('div'), palette: 'sky', level: () => level };
  const field = createVoiceField(1);
  expect(field.update(1, [source]).moving).toBe(true);
  level = 0;
  field.clear();
  expect(field.update(1.01, [source]).moving).toBe(false);
  expect(field.history).toEqual(new Float32Array(HISTORY));
  expect(field.update(1.2, [source]).moving).toBe(false);
});
