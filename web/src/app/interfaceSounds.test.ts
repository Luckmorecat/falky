import { describe, expect, it } from 'vitest';
import { cueFor } from './interfaceSounds';

function el(html: string): Element {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.firstElementChild!;
}

describe('cueFor', () => {
  it('taps on a plain button, also from an icon inside it', () => {
    expect(cueFor(el('<button></button>'))).toBe('tap');
    expect(cueFor(el('<button><svg></svg></button>').firstElementChild)).toBe('tap');
  });

  it('says nothing for what cannot be pressed', () => {
    expect(cueFor(el('<div></div>'))).toBeNull();
    expect(cueFor(el('<button disabled></button>'))).toBeNull();
    expect(cueFor(el('<input type="text">'))).toBeNull();
    expect(cueFor(null)).toBeNull();
  });

  it('opens what is closed and closes what is open', () => {
    expect(cueFor(el('<button aria-expanded="false"></button>'))).toBe('open');
    expect(cueFor(el('<button aria-expanded="true"></button>'))).toBe('close');
  });

  it('follows a checkbox', () => {
    expect(cueFor(el('<input type="checkbox" checked>'))).toBe('on');
    expect(cueFor(el('<input type="checkbox">'))).toBe('off');
  });

  it('lets a control say for itself, or stay silent for a sound of its own', () => {
    expect(cueFor(el('<button data-cue="off"></button>'))).toBe('off');
    expect(cueFor(el('<button data-cue="none"></button>'))).toBeNull();
  });
});
