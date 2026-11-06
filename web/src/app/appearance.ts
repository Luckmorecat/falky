import { setOrbLook } from '../fx/orbRenderer';
import { squircleMask } from '../fx/squircle';
import { resolveLanguage, setLanguage } from '../strings';
import { getState } from './store';

const systemDark = matchMedia('(prefers-color-scheme: dark)');

/** Puts the chosen language, theme and effects on the page. */
export function applyAppearance(): void {
  const { language, theme, fewerEffects, orbLight } = getState().settings;
  const lang = resolveLanguage(language);
  setLanguage(lang);
  const root = document.documentElement;
  root.lang = lang;
  const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
  root.dataset.theme = resolved;
  root.style.setProperty('--squircle', squircleMask());
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#000000' : '#ffffff');
  document.body.classList.toggle('reduced', fewerEffects);
  setOrbLook(orbLight);
}

systemDark.addEventListener('change', applyAppearance);
