import { describe, expect, it } from 'vitest';
import { LANGUAGE_CODES, setLanguage, systemLanguage, t } from './strings';

/** Every leaf of a strings tree, by path, so two languages can be compared shape for shape. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) for (const [p, kind] of leaves(child, path ? `${path}.${key}` : key)) out.set(p, kind);
  } else out.set(path, Array.isArray(value) ? `array:${value.length}` : typeof value);
  return out;
}

describe('languages', () => {
  it('picks the system language when the interface has it, Ukrainian otherwise', () => {
    expect(systemLanguage(['pl-PL'])).toBe('pl');
    expect(systemLanguage(['de'])).toBe('de');
    expect(systemLanguage(['es-MX', 'en'])).toBe('es');
    expect(systemLanguage(['fr-CA'])).toBe('fr');
    expect(systemLanguage(['en-US'])).toBe('en');
    expect(systemLanguage(['ru-RU'])).toBe('uk');
    expect(systemLanguage([])).toBe('uk');
  });

  it('gives every language the same strings, with no empty text', () => {
    setLanguage('uk');
    const reference = leaves(t);
    for (const code of LANGUAGE_CODES) {
      setLanguage(code);
      const here = leaves(t);
      expect([...here.entries()]).toEqual([...reference.entries()]);
      for (const [path] of here) {
        const text = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], t);
        if (typeof text === 'string') expect(text.trim(), `${code}: ${path}`).not.toBe('');
      }
    }
    setLanguage('uk');
  });

  it('names the push-to-talk key in each language', () => {
    for (const code of LANGUAGE_CODES) {
      setLanguage(code);
      expect(t.pushToTalk('KeyX'.slice(3))).toContain('X');
    }
    setLanguage('uk');
  });
});
