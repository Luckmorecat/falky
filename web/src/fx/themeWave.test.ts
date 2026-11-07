import { describe, expect, it } from 'vitest';
import { createThemeWave } from './themeWave';

describe('theme wave', () => {
  it('starts in the current theme without an entrance transition', () => {
    expect(createThemeWave(false).frame(false, 0, false)).toMatchObject({ progress: 0, direction: 0 });
    expect(createThemeWave(true).frame(true, 0, false)).toMatchObject({ progress: 1, direction: 0 });
  });

  it('reverses from the visible position when the target changes mid-wave', () => {
    const wave = createThemeWave(false);
    expect(wave.frame(true, .3, false)).toMatchObject({ progress: .5, direction: 1 });
    expect(wave.frame(false, 0, false)).toMatchObject({ progress: .5, direction: 1 });
    expect(wave.frame(false, .15, false).progress).toBeCloseTo(.25);
    expect(wave.frame(false, .6, false)).toMatchObject({ progress: 0, direction: 0 });
    expect(wave.frame(true, 1, false)).toMatchObject({ progress: 1, direction: 0 });
  });

  it('snaps to the selected theme when reduced motion is requested mid-transition', () => {
    const wave = createThemeWave(false);
    wave.frame(true, .2, false);
    expect(wave.frame(true, 0, true)).toMatchObject({ progress: 1, direction: 0 });
    expect(wave.frame(false, 0, true)).toMatchObject({ progress: 0, direction: 0 });
  });

  it('turns the dot currents smoothly instead of snapping their displacement on reversal', () => {
    const wave = createThemeWave(false);
    wave.frame(true, .3, false);
    const reversed = wave.frame(false, .02, false);
    expect(reversed.progress).toBeLessThan(.5);
    expect(reversed.direction).toBeGreaterThan(-1);
    expect(reversed.direction).toBeLessThan(1);
  });

  it('starts either new theme at the corners and preserves its field when reversing', () => {
    const wave = createThemeWave(true);
    expect(wave.frame(false, .3, false)).toEqual({ progress: .5, direction: -1, fromLight: true });
    expect(wave.frame(true, 0, false)).toEqual({ progress: .5, direction: -1, fromLight: true });
    wave.frame(false, 1, false);
    expect(wave.frame(true, .3, false)).toEqual({ progress: .5, direction: 1, fromLight: false });
  });
});
