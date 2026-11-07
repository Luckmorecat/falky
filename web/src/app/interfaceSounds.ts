import { playSound } from '@falky/browser';
import type { InterfaceCue } from '../voice/sounds';
import { getState } from './store';

const PRESSABLE = 'button, a[href], select, summary, input[type=checkbox]';
const HOVERABLE = 'button, a[href], select, summary, label.toggle, label.color';

/** What pressing an element should say; read before the press changes anything on it. */
export function cueFor(target: Element | null): InterfaceCue | null {
  const el = target?.closest<HTMLElement>(PRESSABLE);
  if (!el || (el as HTMLButtonElement).disabled) return null;
  const said = el.dataset.cue;
  if (said) return said === 'none' ? null : (said as InterfaceCue);
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) return expanded === 'true' ? 'close' : 'open';
  // A checkbox has already flipped by the time its click is seen.
  if (el instanceof HTMLInputElement) return el.checked ? 'on' : 'off';
  return 'tap';
}

function hoverable(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest(HOVERABLE) : null;
  return el && !(el as HTMLButtonElement).disabled ? el : null;
}

function say(cue: InterfaceCue, { force = false, pitch = 0.5 } = {}): void {
  const { settings, voice } = getState();
  if ((settings.uiSounds || force) && !voice.deafened) playSound(cue, settings.speakerId, pitch);
}

let unlocked = false;

/** A step of a slider, higher the further along it is. */
export function sayTick(fraction: number): void {
  if (unlocked) say('tick', { pitch: fraction });
}

/** Lets the whole interface answer by itself: new controls need nothing to be heard. */
export function installInterfaceSounds(): void {
  // Browsers only let sound start after the first press, so hovers wait for it.
  const unlock = () => { unlocked = true; };
  document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  document.addEventListener('keydown', unlock, { capture: true, passive: true });

  let hovered: Element | null = null;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = hoverable(e.target);
    if (el === hovered) return;
    hovered = el;
    if (el && unlocked) say('hover');
  }, { passive: true });

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const cue = cueFor(target);
    if (cue) say(cue, { force: !!target?.closest('[data-cue-always]') });
  }, { capture: true, passive: true });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
    sayTick((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min)));
  }, { passive: true });
}
