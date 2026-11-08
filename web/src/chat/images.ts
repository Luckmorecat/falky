import { useEffect, useState } from 'react';
import { api, type Attachment } from '../api/client';

export type ImageState = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'gone' } | { status: 'failed' };

let onGone: (id: string) => void = () => {};

export function onImageGone(fn: (id: string) => void): void {
  onGone = fn;
}

export const isImage = (a: Pick<Attachment, 'contentType'>): boolean => a.contentType.startsWith('image/');
export const isAvailable = (a: Pick<Attachment, 'availability'>): boolean => a.availability === 'posted' || a.availability === 'ready';

export function useAttachmentImage(a: Pick<Attachment, 'id' | 'contentUrl' | 'availability'> | null): {
  state: ImageState;
  attempt: number;
  onError(): void;
} {
  const src = a?.contentUrl ?? '';
  const available = !!a && isAvailable(a);
  const [failure, setFailure] = useState({ src: '', attempt: 0, retrying: false });
  const attempt = failure.src === src ? failure.attempt : 0;
  const retrying = failure.src === src && failure.retrying;

  useEffect(() => {
    if (!available || !retrying || attempt >= 4) return;
    const timer = setTimeout(() => setFailure({ src, attempt: attempt + 1, retrying: false }), 600 * 2 ** attempt);
    return () => clearTimeout(timer);
  }, [src, available, retrying, attempt]);

  // Image error events have no HTTP status; metadata distinguishes expiry from a failed read.
  useEffect(() => {
    if (!a || !available || !retrying || attempt !== 0 || src.startsWith('blob:')) return;
    let cancelled = false;
    void api.attachment(a.id).then((fresh) => {
      if (!cancelled && !isAvailable(fresh)) onGone(fresh.id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [a?.id, src, available, retrying, attempt]);

  const state: ImageState = !a ? { status: 'loading' }
    : !available ? { status: 'gone' }
    : retrying && attempt >= 4 ? { status: 'failed' }
    : { status: 'ready', src };
  return { state, attempt, onError: () => setFailure({ src, attempt, retrying: true }) };
}
