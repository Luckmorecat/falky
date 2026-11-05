import { afterEach, expect, it } from 'vitest';
import { prefs } from '../app/prefs';
import { preparePreferences } from '../mock/preferences';
import { setPreferencePrefix } from './preferences';
import { showStartupFailure } from './startup';

afterEach(() => { localStorage.clear(); setPreferencePrefix('falky.'); });

it('shows deployment-neutral startup recovery in the language selected when startup fails', () => {
  const root = document.createElement('div');
  showStartupFailure(root);
  expect(root.textContent).toBe('Не вдалося відкрити Falky. Перезавантаж сторінку, щоб спробувати ще раз.');
  expect(document.documentElement.lang).toBe('uk');
  prefs.saveSettings({ ...prefs.settings(), lang: 'en' });
  showStartupFailure(root);
  expect(root.textContent).toBe("Couldn't open Falky. Reload the page to try again.");
  expect(document.documentElement.lang).toBe('en');
});

it('uses bootstrapped instance preferences instead of real-mode language after mock startup fails', () => {
  localStorage.setItem('falky.lang', 'en');
  preparePreferences('failed-startup', 1);
  const root = document.createElement('div');
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('uk');
  prefs.saveSettings({ ...prefs.settings(), lang: 'en' });
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('en');
  preparePreferences('failed-startup', 2);
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('uk');
  expect(localStorage.getItem('falky.lang')).toBe('en');
});
