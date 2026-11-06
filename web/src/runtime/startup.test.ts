import { afterEach, expect, it } from 'vitest';
import { prefs } from '../app/prefs';
import { preparePreferences } from '../mock/preferences';
import { setPreferencePrefix } from './preferences';
import { showStartupFailure } from './startup';

afterEach(() => { localStorage.clear(); setPreferencePrefix('falky.'); });

it('shows deployment-neutral startup recovery in the language selected when startup fails', () => {
  const root = document.createElement('div');
  prefs.saveSettings({ ...prefs.settings(), language: 'uk' });
  showStartupFailure(root);
  expect(root.textContent).toBe('Не вдалося відкрити Falky. Перезавантаж сторінку, щоб спробувати ще раз.');
  expect(document.documentElement.lang).toBe('uk');
  prefs.saveSettings({ ...prefs.settings(), language: 'en' });
  showStartupFailure(root);
  expect(root.textContent).toBe("Couldn't open Falky. Reload the page to try again.");
  expect(document.documentElement.lang).toBe('en');
});

it('uses bootstrapped instance preferences instead of real-mode language after mock startup fails', () => {
  // The test browser's system language is English, so a fresh instance shows that.
  localStorage.setItem('falky.language', 'uk');
  preparePreferences('failed-startup', 1);
  const root = document.createElement('div');
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('en');
  prefs.saveSettings({ ...prefs.settings(), language: 'uk' });
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('uk');
  preparePreferences('failed-startup', 2);
  showStartupFailure(root);
  expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem('falky.language')).toBe('uk');
});
