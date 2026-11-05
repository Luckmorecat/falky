import { describe, expect, it } from 'vitest';
import { shareOptions, type ShareSettings } from './share';

const base: ShareSettings = { shareResolution: '1080', shareFps: '30', shareBitrate: '1', shareFocus: 'motion', shareAudio: true };

describe('shareOptions', () => {
  it('asks for what was chosen', () => {
    const { capture, publish } = shareOptions({ ...base, shareResolution: '1440', shareFps: '60' }, false);
    expect(capture.resolution).toEqual({ width: 2560, height: 1440, frameRate: 60 });
    expect(publish.screenShareEncoding?.maxFramerate).toBe(60);
  });

  it('spends more bits on more pixels and frames', () => {
    const rate = (s: Partial<ShareSettings>) => shareOptions({ ...base, ...s }, false).publish.screenShareEncoding!.maxBitrate;
    expect(rate({ shareResolution: '1440' })).toBeGreaterThan(rate({}));
    expect(rate({ shareFps: '60' })).toBeGreaterThan(rate({}));
    expect(rate({ shareFps: '15' })).toBeLessThan(rate({}));
  });

  it.each([
    ['1', 3_000_000, 7_500_000],
    ['2', 6_000_000, 15_000_000],
    ['3', 9_000_000, 22_500_000],
  ] as const)('applies bitrate multiplier %s at different resolutions and frame rates', (shareBitrate, normal, high) => {
    for (const safari of [false, true]) {
      const options = shareOptions({ ...base, shareBitrate }, safari);
      expect(options.publish.screenShareEncoding?.maxBitrate).toBe(normal);
      expect(options.publish.screenShareEncoding?.maxFramerate).toBe(30);
      expect(options.capture).toEqual(shareOptions(base, safari).capture);
      expect(shareOptions({ ...base, shareBitrate, shareResolution: '1440', shareFps: '60' }, safari).publish.screenShareEncoding?.maxBitrate).toBe(high);
    }
  });

  it('leaves system sound out when sound is off', () => {
    const { capture } = shareOptions({ ...base, shareAudio: false }, false);
    expect(capture.audio).toBe(false);
    expect(capture.systemAudio).toBe('exclude');
  });

  it('names no resolution on Safari', () => {
    expect(shareOptions(base, true).capture.resolution).toBeUndefined();
  });
});
