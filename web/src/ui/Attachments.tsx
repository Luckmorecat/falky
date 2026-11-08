import { memo, useState } from 'react';
import type { Attachment } from '../api/client';
import { removeUpload, retryUpload } from '../app/controller';
import { useApp } from '../app/store';
import { formatBytes, galleryRatio, SINGLE_MAX_HEIGHT } from '../chat/gallery';
import { isAvailable, isImage, useAttachmentImage, type ImageState } from '../chat/images';
import type { ComposerUpload } from '../chat/timeline';
import { t } from '../strings';
import { Icon } from './Icon';

/** Opens the viewer at a picture; the element is where it grows from and goes back to. */
export type OpenImage = (id: string, from: HTMLElement) => void;

function Picture({ state, alt, onLoad }: { state: ImageState; alt: string; onLoad?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  if (state.status === 'gone' || state.status === 'failed') {
    return (
      <span className="att-gone">
        <Icon name="imageOff" />
        <span>{state.status === 'gone' ? t.imageUnavailable : t.imageFailed}</span>
      </span>
    );
  }
  if (state.status === 'loading') return null;
  return (
    <img
      src={state.src}
      alt={alt}
      draggable={false}
      decoding="async"
      className={loaded ? 'loaded' : ''}
      onLoad={() => { setLoaded(true); onLoad?.(); }}
    />
  );
}

function Tile({ attachment, local, onOpen }: { attachment: Attachment; local: boolean; onOpen?: OpenImage }) {
  const fetched = useAttachmentImage(local ? null : attachment);
  const state: ImageState = local ? { status: 'ready', src: attachment.contentUrl } : fetched;
  const open = !local && onOpen && isAvailable(attachment) && state.status !== 'failed';
  const content = <Picture state={state} alt={attachment.filename} />;
  return open ? (
    <button
      type="button"
      className="att-tile"
      data-attachment={attachment.id}
      aria-label={`${t.openImage}: ${attachment.filename}`}
      onClick={(e) => onOpen(attachment.id, e.currentTarget)}
    >
      {content}
    </button>
  ) : (
    <span className="att-tile" data-attachment={attachment.id}>{content}</span>
  );
}

/** A file the chat cannot show. Nothing to press yet: downloads come later. */
function FileChip({ attachment }: { attachment: Attachment }) {
  return (
    <div className={`att-file${isAvailable(attachment) ? '' : ' gone'}`}>
      <span className="att-file-name">{attachment.filename}</span>
      <span className="att-file-size">{isAvailable(attachment) ? formatBytes(attachment.size, t.locale) : t.imageUnavailable}</span>
    </div>
  );
}

/**
 * A message's pictures. Their sizes come with the message, so the gallery has
 * its final shape before a single byte of them arrives and the feed never jumps.
 */
export const Gallery = memo(function Gallery({ attachments, local = false, onOpen }: { attachments: Attachment[]; local?: boolean; onOpen?: OpenImage }) {
  const images = attachments.filter(isImage).slice(0, 4);
  const files = attachments.filter((a) => !isImage(a));
  const ratio = galleryRatio(images);
  return (
    <>
      {images.length > 0 && (
        <div
          className={`msg-gallery g${images.length}`}
          style={{ aspectRatio: String(ratio), width: images.length === 1 ? `min(100%, ${Math.round(SINGLE_MAX_HEIGHT * ratio)}px)` : undefined }}
        >
          {images.map((a) => <Tile key={a.id} attachment={a} local={local} onOpen={onOpen} />)}
        </div>
      )}
      {files.map((a) => <FileChip key={a.id} attachment={a} />)}
    </>
  );
});

function Ring({ progress }: { progress: number }) {
  const r = 11;
  const length = 2 * Math.PI * r;
  return (
    <svg className="att-ring" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r={r} className="track" />
      <circle cx="14" cy="14" r={r} className="fill" strokeDasharray={length} strokeDashoffset={length * (1 - Math.max(0.04, progress))} />
    </svg>
  );
}

function TrayItem({ upload }: { upload: ComposerUpload }) {
  return (
    <li className={`tray-item ${upload.status}`} title={upload.status === 'failed' ? upload.reason : upload.name}>
      <img src={upload.previewUrl} alt="" draggable={false} />
      {upload.status === 'uploading' && (
        <span className="tray-veil" role="progressbar" aria-label={`${t.uploadingImage}: ${upload.name}`} aria-valuenow={Math.round(upload.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <Ring progress={upload.progress} />
        </span>
      )}
      {upload.status === 'failed' && (
        <button type="button" className="tray-veil" aria-label={`${t.retry}: ${upload.name}`} onClick={() => retryUpload(upload.roomId, upload.localId)}>
          <Icon name="retry" />
        </button>
      )}
      <button type="button" className="tray-remove" aria-label={`${t.removeImage}: ${upload.name}`} onClick={() => removeUpload(upload.roomId, upload.localId)}>
        <Icon name="x" />
      </button>
    </li>
  );
}

/** The pictures going with the next message, above the field. */
export function ComposerTray({ roomId }: { roomId: string }) {
  const uploads = useApp((s) => s.uploads[roomId]);
  if (!uploads?.length) return null;
  const failed = uploads.find((u) => u.status === 'failed');
  return (
    <div className="tray">
      <ul className="tray-list">
        {uploads.map((u) => <TrayItem key={u.localId} upload={u} />)}
      </ul>
      {failed && <p className="tray-error" role="alert">{failed.reason}</p>}
    </div>
  );
}
