import { preferencePrefix } from '../runtime/preferences';

/** Keys a person may move to another key; each holds the physical key and what it shows. */
export type Bindable = 'mute' | 'deafen' | 'camera' | 'pushToTalk' | 'leave';
type Binding = { code: string; label: string };

const DEFAULTS: Record<Bindable, Binding> = {
  mute: { code: 'KeyM', label: 'M' },
  deafen: { code: 'KeyD', label: 'D' },
  camera: { code: 'KeyV', label: 'V' },
  pushToTalk: { code: 'Space', label: 'Space' },
  leave: { code: 'KeyL', label: 'L' },
};

/** Current bindings and their tooltip labels, shared with the keyboard hook. */
export const shortcuts = {
  ...structuredClone(DEFAULTS),
  /** Digit1 sends the first reaction, Digit2 the second, and so on. */
  react: { codePrefix: 'Digit', label: '1–6' },
  chat: { code: 'Slash', key: '/', label: '/' },
  chatEnter: { code: 'Enter', label: 'Enter' },
  previousRoom: { key: 'ArrowLeft', label: '←' },
  nextRoom: { key: 'ArrowRight', label: '→' },
  closeRooms: { key: 'Escape', label: 'Esc' },
};

export const BINDABLE = Object.keys(DEFAULTS) as Bindable[];

/** Keys the fixed shortcuts, typing and moving focus already mean something for. */
const RESERVED = /^(Slash|Enter|NumpadEnter|Escape|Tab|Arrow\w+|Digit[1-6]|Backspace|Meta\w*|Control\w*|Alt\w*|Shift\w*|CapsLock)$/;

const storageKey = (name: Bindable) => `${preferencePrefix}key.${name}`;
const listeners = new Set<() => void>();
let revision = 0;

/** Reads moved keys; called with the other preferences, once their prefix is known. */
export function loadShortcuts(): void {
  for (const name of BINDABLE) {
    shortcuts[name] = { ...DEFAULTS[name] };
    try {
      const [code, label] = localStorage.getItem(storageKey(name))?.split('\n') ?? [];
      if (code && label && !RESERVED.test(code)) shortcuts[name] = { code, label };
    } catch { /* Private storage may be unavailable. */ }
  }
}

/** What a key reads as on its cap: letters and digits upper-cased, others by name. */
export function keyLabel(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (e.code === 'Space') return 'Space';
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export type RebindResult = { ok: true } | { ok: false; reason: 'reserved' } | { ok: false; reason: 'taken'; by: Bindable };

export function rebind(name: Bindable, e: Pick<KeyboardEvent, 'code' | 'key'>): RebindResult {
  if (RESERVED.test(e.code)) return { ok: false, reason: 'reserved' };
  const by = BINDABLE.find((other) => other !== name && shortcuts[other].code === e.code);
  if (by) return { ok: false, reason: 'taken', by };
  set(name, { code: e.code, label: keyLabel(e) });
  return { ok: true };
}

export function resetShortcut(name: Bindable): void {
  set(name, DEFAULTS[name]);
}

export const isDefault = (name: Bindable): boolean => shortcuts[name].code === DEFAULTS[name].code;

function set(name: Bindable, binding: Binding): void {
  shortcuts[name] = { ...binding };
  try {
    if (binding.code === DEFAULTS[name].code) localStorage.removeItem(storageKey(name));
    else localStorage.setItem(storageKey(name), `${binding.code}\n${binding.label}`);
  } catch { /* Forgotten on reload. */ }
  revision++;
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore: anything showing a binding re-renders when one moves. */
export function subscribeShortcuts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const shortcutsRevision = (): number => revision;
