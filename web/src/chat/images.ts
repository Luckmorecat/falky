import { useEffect, useState } from 'react';
import type { Attachment } from '../api/client';

/**
 * Attachment content is private and served with `no-store`, so an `<img>`
 * pointing at it would download again every time the virtual feed remounts a
 * row. Each image is read once instead, kept as an object URL, and the
 * oldest are let go when there are many. The server allows only a few content
 * streams at once, so reads queue and back off when it is busy.
 */

export type ImageState = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'gone' } | { status: 'failed' };

interface Entry {
  state: ImageState;
  listeners: Set<() => void>;
  used: number;
}

const KEEP = 80;
const PARALLEL = 3;
const entries = new Map<string, Entry>();
const queue: Array<() => Promise<void>> = [];
let running = 0;
let clock = 0;
let onGone: (id: string) => void = () => {};

/** Told when the server says an image is no longer there, so the message can say so too. */
export function onImageGone(fn: (id: string) => void): void {
  onGone = fn;
}

export const isImage = (a: Pick<Attachment, 'contentType'>): boolean => a.contentType.startsWith('image/');
export const isAvailable = (a: Pick<Attachment, 'availability'>): boolean => a.availability === 'posted' || a.availability === 'ready';

function set(id: string, state: ImageState): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.state = state;
  entry.listeners.forEach((l) => l());
}

function pump(): void {
  while (running < PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

async function read(id: string, url: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!entries.has(id)) return;
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'same-origin' });
    } catch {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      const blob = await res.blob();
      if (!entries.has(id)) return;
      set(id, { status: 'ready', src: URL.createObjectURL(blob) });
      return;
    }
    if (res.status === 410) {
      set(id, { status: 'gone' });
      onGone(id);
      return;
    }
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
  }
  set(id, { status: 'failed' });
}

function trim(): void {
  if (entries.size <= KEEP) return;
  const idle = [...entries].filter(([, e]) => !e.listeners.size).sort((a, b) => a[1].used - b[1].used);
  for (const [id, entry] of idle.slice(0, entries.size - KEEP)) {
    if (entry.state.status === 'ready') URL.revokeObjectURL(entry.state.src);
    entries.delete(id);
  }
}

function entryFor(a: Pick<Attachment, 'id' | 'contentUrl'>): Entry {
  let entry = entries.get(a.id);
  if (!entry) {
    entry = { state: { status: 'loading' }, listeners: new Set(), used: ++clock };
    entries.set(a.id, entry);
    queue.push(() => read(a.id, a.contentUrl));
    pump();
    trim();
  }
  entry.used = ++clock;
  return entry;
}

/** Starts reading an image ahead of being shown, as the lightbox does for its neighbours. */
export function preloadImage(a: Pick<Attachment, 'id' | 'contentUrl'>): void {
  entryFor(a);
}

/** The person's own upload is already in memory: no need to read it back from the server. */
export function seedImage(id: string, src: string): void {
  const old = entries.get(id);
  if (old?.state.status === 'ready') URL.revokeObjectURL(old.state.src);
  entries.set(id, { state: { status: 'ready', src }, listeners: old?.listeners ?? new Set(), used: ++clock });
  old?.listeners.forEach((l) => l());
  trim();
}

/** Lets an image be read again, as after the network came back. */
export function forgetFailed(): void {
  for (const [id, entry] of entries) if (entry.state.status === 'failed' && !entry.listeners.size) entries.delete(id);
}

export function useAttachmentImage(a: Pick<Attachment, 'id' | 'contentUrl' | 'availability'> | null): ImageState {
  const available = !!a && isAvailable(a);
  const [, render] = useState(0);
  useEffect(() => {
    if (!a || !available) return;
    const entry = entryFor(a);
    const listener = () => render((n) => n + 1);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [a?.id, available]);
  if (!a) return { status: 'loading' };
  if (!available) return { status: 'gone' };
  return entries.get(a.id)?.state ?? { status: 'loading' };
}
