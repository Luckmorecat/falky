import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prefs } from '../app/prefs';
import { setParticipantVolume } from '../app/controller';
import { setLanguage } from '../strings';
import { Tile, type TileProps } from './Tile';

vi.mock('../app/prefs', () => ({ prefs: { volume: vi.fn(() => 1) } }));
vi.mock('../app/controller', () => ({ setParticipantVolume: vi.fn() }));
vi.mock('../app/store', () => ({ useApp: () => false }));
vi.mock('../app/interfaceSounds', () => ({ sayTick: vi.fn() }));
vi.mock('./Orb', () => ({ Orb: () => createElement('div', { className: 'orb' }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.mocked(prefs.volume).mockReturnValue(1);
  setLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<TileProps> = {}) {
  await act(async () => root.render(createElement(Tile, { id: 'sam', name: 'Sam', adjustable: true, ...props })));
}

it('shows a saved zero volume as muted for you without applying microphone-mute styling', async () => {
  vi.mocked(prefs.volume).mockReturnValue(0);
  await render();
  expect(container.querySelector('.locally-muted')).not.toBeNull();
  expect(container.querySelector('.dim')).toBeNull();
  expect(container.querySelector('.t-flag')?.getAttribute('title')).toBe('Muted for you · Volume 0%');
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Sam, Muted for you · Volume 0%');
});

it('shows both independent states and keeps local mute when their microphone comes back on', async () => {
  vi.mocked(prefs.volume).mockReturnValue(0);
  await render({ muted: true });
  expect(container.querySelectorAll('.t-flag')).toHaveLength(2);
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Sam, microphone off, Muted for you · Volume 0%');
  await render({ deafened: true });
  expect(container.querySelectorAll('.t-flag')).toHaveLength(2);
  expect(container.querySelector('article')?.getAttribute('aria-label')).toContain("can't hear, Muted for you");
  await render();
  expect(container.querySelectorAll('.t-flag')).toHaveLength(1);
  expect(container.querySelector('.locally-muted')).not.toBeNull();
});

it('adds the badge at zero and removes it as soon as volume rises, preserving their microphone mute', async () => {
  await render({ muted: true });
  const orb = container.querySelector('.orb')!;
  await act(async () => {
    for (let i = 0; i < 20; i++) orb.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  });
  expect(setParticipantVolume).toHaveBeenLastCalledWith('sam', 0);
  expect(container.querySelectorAll('.t-flag')).toHaveLength(2);
  await act(async () => { orb.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })); });
  expect(setParticipantVolume).toHaveBeenLastCalledWith('sam', .05);
  expect(container.querySelector('.locally-muted')).toBeNull();
  expect(container.querySelector('.dim')).not.toBeNull();
  expect(container.querySelectorAll('.t-flag')).toHaveLength(1);
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Sam, microphone off');
});

it('never applies a saved participant volume to your own mute status', async () => {
  vi.mocked(prefs.volume).mockReturnValue(0);
  await render({ isSelf: true, adjustable: false });
  expect(container.querySelector('.locally-muted')).toBeNull();
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Sam');
});
