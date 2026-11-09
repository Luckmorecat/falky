import { afterEach, describe, expect, it } from 'vitest';
import { prefs } from './prefs';

afterEach(() => localStorage.clear());

describe('live background preference', () => {
  it('carries over the previous preference and lets the renamed switch override it', () => {
    localStorage.setItem('falky.voiceBackground', 'on');
    expect(prefs.settings().liveBackground).toBe(true);
    prefs.saveSettings({ ...prefs.settings(), liveBackground: false });
    expect(prefs.settings().liveBackground).toBe(false);
  });

  it('requires an explicit opt-in and remembers the switch across reads', () => {
    expect(prefs.settings().liveBackground).toBe(false);
    localStorage.setItem('falky.liveBackground', 'true');
    expect(prefs.settings().liveBackground).toBe(false);
    prefs.saveSettings({ ...prefs.settings(), liveBackground: true });
    expect(localStorage.getItem('falky.liveBackground')).toBe('on');
    expect(prefs.settings().liveBackground).toBe(true);
    prefs.saveSettings({ ...prefs.settings(), liveBackground: false });
    expect(prefs.settings().liveBackground).toBe(false);
  });
});

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

it('discards obsolete favourite colours without touching other preferences', () => {
  localStorage.setItem('falky.favoriteColors', 'sky,rose,moss');
  localStorage.setItem('falky.theme', 'light');
  expect(prefs.settings()).not.toHaveProperty('favoriteColors');
  expect(localStorage.getItem('falky.favoriteColors')).toBeNull();
  expect(prefs.settings().theme).toBe('light');
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

it('keeps playback volume on the selected connection and ignores legacy person volume', () => {
  localStorage.setItem('falky.volume.sam', '0');
  expect(prefs.volume('sam.mac')).toBe(1);
  prefs.setVolume('sam.mac', 0.4);
  expect(prefs.volume('sam.mac')).toBe(0.4);
  expect(prefs.volume('sam.windows')).toBe(1);
  expect(prefs.volume('sam')).toBe(1);
});
