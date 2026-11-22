import { afterEach, expect, it, vi } from 'vitest';
import { api } from './client';

class UploadRequest {
  static last: UploadRequest;
  constructor() { UploadRequest.last = this; }
  timeout = 0;
  open = vi.fn();
  send = vi.fn();
  upload = {};
  ontimeout?: () => void;
  onabort?: () => void;
  onloadend?: () => void;
  abort() { this.onabort?.(); this.onloadend?.(); }
}

afterEach(() => vi.unstubAllGlobals());

it('gives the server upload deadline time to respond before the XHR times out', async () => {
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  const uploading = api.upload('room', new File(['data'], 'picture.png'), vi.fn(), undefined, 60);
  const xhr = UploadRequest.last;
  expect(xhr.timeout).toBeGreaterThan(60_000);
  expect(xhr.timeout).toBeLessThanOrEqual(75_000);
  xhr.ontimeout?.();
  xhr.onloadend?.();
  await expect(uploading).rejects.toMatchObject({ code: 'upload_timeout', status: 408 });
});

it('retains caller cancellation before and during upload', async () => {
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  const file = new File(['data'], 'picture.png');
  const initial = new AbortController();
  initial.abort();
  await expect(api.upload('room', file, vi.fn(), initial.signal)).rejects.toMatchObject({ code: 'aborted' });
  const controller = new AbortController();
  const uploading = api.upload('room', file, vi.fn(), controller.signal);
  expect(UploadRequest.last.send).toHaveBeenCalledOnce();
  controller.abort();
  await expect(uploading).rejects.toMatchObject({ code: 'aborted' });
});
