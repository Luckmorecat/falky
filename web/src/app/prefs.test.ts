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

describe('favourite colours preference', () => {
  it('starts empty and ignores colours that do not exist', () => {
    expect(prefs.settings().favoriteColors).toEqual([]);
    localStorage.setItem('falky.favoriteColors', 'plaid,moss');
    expect(prefs.settings().favoriteColors).toEqual(['moss']);
  });

  it('remembers the choice, and never more than three', () => {
    prefs.saveSettings({ ...prefs.settings(), favoriteColors: ['sky', 'moss', 'coral'] });
    expect(prefs.settings().favoriteColors).toEqual(['sky', 'moss', 'coral']);
    localStorage.setItem('falky.favoriteColors', 'sky,rose,violet,amber,moss');
    expect(prefs.settings().favoriteColors).toHaveLength(3);
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
