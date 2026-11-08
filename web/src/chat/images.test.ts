import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type Attachment } from '../api/client';
import { onImageGone, useAttachmentImage } from './images';

vi.mock('../api/client', () => ({ api: { attachment: vi.fn() } }));

const attachment: Attachment = {
  id: 'photo', contentUrl: '/api/attachments/photo/content', availability: 'posted',
  filename: 'photo.webp', contentType: 'image/webp', size: 10, inline: true, width: 1, height: 1,
};
let root: Root;
let container: HTMLDivElement;
let image: ReturnType<typeof useAttachmentImage>;
const gone = vi.fn();

function Harness({ attachment }: { attachment: Attachment }) {
  image = useAttachmentImage(attachment);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  gone.mockClear();
  vi.mocked(api.attachment).mockReset();
  vi.mocked(api.attachment).mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve({ ...attachment, availability: 'expired' }), 700);
  }));
  onImageGone(gone);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  onImageGone(() => {});
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reports slow expired metadata after an image retry without starting another lookup', async () => {
  await act(async () => root.render(createElement(Harness, { attachment })));
  await act(async () => image.onError());
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(image.attempt).toBe(1);
  expect(gone).not.toHaveBeenCalled();
  await act(async () => image.onError());
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(gone).toHaveBeenCalledExactlyOnceWith(attachment.id);
  expect(api.attachment).toHaveBeenCalledExactlyOnceWith(attachment.id);
});

it('ignores late metadata when the attachment changes', async () => {
  await act(async () => root.render(createElement(Harness, { attachment })));
  await act(async () => image.onError());
  await act(async () => vi.advanceTimersByTimeAsync(600));
  const next = { ...attachment, id: 'next', contentUrl: '/api/attachments/next/content' };
  await act(async () => root.render(createElement(Harness, { attachment: next })));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(gone).not.toHaveBeenCalled();
  expect(image.attempt).toBe(0);
});

it('ignores late metadata after the image unmounts', async () => {
  await act(async () => root.render(createElement(Harness, { attachment })));
  await act(async () => image.onError());
  await act(async () => vi.advanceTimersByTimeAsync(600));
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(gone).not.toHaveBeenCalled();
});
