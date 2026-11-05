import { setLanguage } from '../strings';
import { getState } from './store';

const systemDark = matchMedia('(prefers-color-scheme: dark)');

/** Puts the chosen language and theme on the page. */
export function applyAppearance(): void {
  const { lang, theme } = getState().settings;
  setLanguage(lang);
  const root = document.documentElement;
  root.lang = lang;
  const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
  root.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#000000' : '#fffbf2');
}

systemDark.addEventListener('change', applyAppearance);
