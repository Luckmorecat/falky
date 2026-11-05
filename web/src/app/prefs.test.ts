import { afterEach, describe, expect, it } from 'vitest';
import { prefs } from './prefs';

afterEach(() => localStorage.clear());

describe('screen share codec preference', () => {
  it('defaults to VP8 for existing browsers and invalid stored values', () => {
    expect(prefs.settings().shareCodec).toBe('vp8');
    localStorage.setItem('falky.shareCodec', 'unknown');
    expect(prefs.settings().shareCodec).toBe('vp8');
  });

  it.each(['vp8', 'h264', 'h265'] as const)('remembers %s across settings reads', (shareCodec) => {
    prefs.saveSettings({ ...prefs.settings(), shareCodec });
    expect(prefs.settings().shareCodec).toBe(shareCodec);
  });
});

describe('screen share bitrate preference', () => {
  it('keeps the default for existing browsers and invalid stored values', () => {
    expect(prefs.settings().shareBitrate).toBe('1');
    localStorage.setItem('falky.shareBitrate', '4');
    expect(prefs.settings().shareBitrate).toBe('1');
  });

  it.each(['1', '2', '3'] as const)('remembers multiplier %s', (shareBitrate) => {
    prefs.saveSettings({ ...prefs.settings(), shareBitrate });
    expect(prefs.settings().shareBitrate).toBe(shareBitrate);
  });
});
