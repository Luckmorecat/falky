import { afterEach, expect, it } from 'vitest';
import { prefs } from '../app/prefs';
import { preparePreferences } from './preferences';

afterEach(() => localStorage.clear());

it('preserves reload preferences but resets only the selected instance on a new generation', () => {
  localStorage.setItem('falky.theme', 'light');
  preparePreferences('one', 1);
  prefs.saveSettings({ ...prefs.settings(), lang: 'en', micId: 'mock-mic', theme: 'light' });
  prefs.setLastRead('room', 'message');
  prefs.setVolume('peer', 1.7);
  preparePreferences('two', 1);
  expect(prefs.settings().lang).toBe('uk');
  prefs.saveSettings({ ...prefs.settings(), theme: 'system' });
  preparePreferences('one', 1);
  expect(prefs.settings()).toMatchObject({ lang: 'en', micId: 'mock-mic', theme: 'light' });
  expect(prefs.lastRead('room')).toBe('message');
  preparePreferences('one', 2);
  expect(prefs.settings()).toMatchObject({ lang: 'uk', micId: '', theme: 'dark' });
  expect(prefs.lastRead('room')).toBeNull();
  expect(prefs.volume('peer')).toBe(1);
  preparePreferences('two', 1);
  expect(prefs.settings().theme).toBe('system');
  expect(localStorage.getItem('falky.theme')).toBe('light');
});
