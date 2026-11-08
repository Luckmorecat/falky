import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VolumeSlider } from './VolumeSlider';

vi.mock('../app/interfaceSounds', () => ({ sayTick: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

function Preview() {
  const [value, setValue] = useState(1);
  const tile = useRef<HTMLElement>(null);
  return createElement('article', { ref: tile },
    createElement('div', { className: 'orb' }),
    createElement(VolumeSlider, { label: 'Volume', value, onChange: setValue, wheelTarget: tile }),
    createElement('span', { className: 'name' }, 'Sam'),
  );
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Preview)));
  Object.defineProperty(container.querySelector('.t-vol'), 'clientHeight', { value: 200 });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function wheel(init: WheelEventInit, target = '.orb') {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  container.querySelector(target)!.dispatchEvent(event);
  return event;
}

const value = () => Number(container.querySelector('input')!.value);

it('accepts wheel events over the orb, tile padding, name and slider', async () => {
  for (const target of ['.orb', 'article', '.name', '.t-vol-grip']) {
    await act(async () => { expect(wheel({ deltaY: -120 }, target).defaultPrevented).toBe(true); });
  }
  expect(value()).toBe(1.2);
});

it('leaves page scrolling alone while the slider is hidden', async () => {
  const grip = container.querySelector<SVGElement>('.t-vol-grip')!;
  grip.style.pointerEvents = 'none';
  await act(async () => { expect(wheel({ deltaY: -120 }).defaultPrevented).toBe(false); });
  expect(value()).toBe(1);
  grip.style.pointerEvents = 'stroke';
  await act(async () => { expect(wheel({ deltaY: -120 }).defaultPrevented).toBe(true); });
  expect(value()).toBe(1.05);
});

it('adjusts in 5% steps for pixel, line and page wheels, cancelling page scrolling', async () => {
  for (const deltaMode of [0, 1, 2]) {
    await act(async () => {
      expect(wheel({ deltaY: -120, deltaMode }).defaultPrevented).toBe(true);
    });
    expect(value()).toBe(1.05);
    await act(async () => { wheel({ deltaY: 120, deltaMode }); });
    expect(value()).toBe(1);
  }
});

it('accumulates small trackpad movements and responds to direction changes', async () => {
  await act(async () => {
    for (let i = 0; i < 3; i++) wheel({ deltaY: -10 });
  });
  expect(value()).toBe(1);
  await act(async () => { wheel({ deltaY: -10 }); });
  expect(value()).toBe(1.05);
  await act(async () => {
    wheel({ deltaY: 20 });
    for (let i = 0; i < 4; i++) wheel({ deltaY: -10 });
  });
  expect(value()).toBe(1.1);
});

it('handles rapid wheel events, clamps to 0–200%, and crosses 100% in either direction', async () => {
  await act(async () => {
    for (let i = 0; i < 25; i++) wheel({ deltaY: 120 });
  });
  expect(value()).toBe(0);
  await act(async () => {
    for (let i = 0; i < 45; i++) wheel({ deltaY: -120 });
  });
  expect(value()).toBe(2);
  await act(async () => {
    for (let i = 0; i < 21; i++) wheel({ deltaY: 120 });
  });
  expect(value()).toBe(.95);
});

it('preserves zoom gestures and horizontal scrolling', async () => {
  await act(async () => {
    for (const init of [
      { deltaY: -120, ctrlKey: true },
      { deltaY: -120, metaKey: true },
      { deltaY: -120, shiftKey: true },
      { deltaX: 120, deltaY: -10 },
      { deltaX: 120, deltaY: 0 },
    ]) expect(wheel(init).defaultPrevented).toBe(false);
  });
  expect(value()).toBe(1);
});
