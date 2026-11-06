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
  it('starts automatic and ignores the multiplier older clients saved', () => {
    localStorage.setItem('falky.shareBitrate', '3');
    expect(prefs.settings().shareMbps).toBe('0');
  });

  it('keeps a ceiling within what is on offer', () => {
    prefs.saveSettings({ ...prefs.settings(), shareMbps: '12' });
    expect(prefs.settings().shareMbps).toBe('12');
    localStorage.setItem('falky.shareMbps', '500');
    expect(prefs.settings().shareMbps).toBe('20');
    localStorage.setItem('falky.shareMbps', 'many');
    expect(prefs.settings().shareMbps).toBe('0');
  });
});
