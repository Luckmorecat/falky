import { prefs } from '../app/prefs';
import { setLanguage, t } from '../strings';

/** Read at failure time, after bootstrap has selected any instance-owned prefs. */
export function showStartupFailure(root: HTMLElement): void {
  const language = prefs.settings().lang;
  setLanguage(language);
  root.ownerDocument.documentElement.lang = language;
  root.textContent = t.startupFailure;
}
