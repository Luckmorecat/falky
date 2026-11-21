import { beforeEach, describe, expect, it } from 'vitest';
import { isDefault, keyLabel, loadShortcuts, rebind, resetShortcut, shortcuts } from './shortcuts';

describe('movable shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    loadShortcuts();
  });

  it('moves a key, remembers it across a reload and goes back to the default', () => {
    expect(rebind('mute', { code: 'KeyK', key: 'k' })).toEqual({ ok: true });
    expect(shortcuts.mute).toEqual({ code: 'KeyK', label: 'K' });
    loadShortcuts();
    expect(shortcuts.mute.code).toBe('KeyK');
    resetShortcut('mute');
    expect(isDefault('mute')).toBe(true);
    loadShortcuts();
    expect(shortcuts.mute.code).toBe('KeyM');
  });

  it('refuses a key another movable shortcut holds, and one with a fixed meaning', () => {
    expect(rebind('mute', { code: 'KeyD', key: 'd' })).toEqual({ ok: false, reason: 'taken', by: 'deafen' });
    expect(rebind('mute', { code: 'Digit3', key: '3' })).toEqual({ ok: false, reason: 'reserved' });
    expect(rebind('mute', { code: 'Escape', key: 'Escape' })).toEqual({ ok: false, reason: 'reserved' });
    expect(shortcuts.mute.code).toBe('KeyM');
  });

  it('labels keys as their caps read', () => {
    expect(keyLabel({ code: 'KeyQ', key: 'й' })).toBe('Q');
    expect(keyLabel({ code: 'Digit9', key: '(' })).toBe('9');
    expect(keyLabel({ code: 'Space', key: ' ' })).toBe('Space');
    expect(keyLabel({ code: 'F2', key: 'F2' })).toBe('F2');
  });
});
