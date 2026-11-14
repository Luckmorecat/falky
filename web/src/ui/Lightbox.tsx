import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment } from '../api/client';
import { formatBytes } from '../chat/gallery';
import { useAttachmentImage } from '../chat/images';
import { t } from '../strings';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import './Lightbox.css';

export interface ViewerItem {
  attachment: Attachment;
  authorName: string;
  createdAt: string;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MAX_SCALE = 4;
const STEP = 2.5;
const at1: View = { scale: 1, x: 0, y: 0 };

const timeOf = (iso: string) => new Date(iso).toLocaleString(t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function calm(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduced');
}

/** The picture's place in the chat, if it is still on screen. */
function originOf(id: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`.feed [data-attachment="${CSS.escape(id)}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const visible = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && rect.width > 0;
  return visible ? el : null;
}

/**
 * The transform and clip that make `to` look exactly like the thumbnail: scaled
 * to cover it, cropped to its box and rounded like its corners, as
 * `object-fit: cover` shows it in the chat.
 */
function flip(thumb: HTMLElement, to: DOMRect): { transform: string; clipPath: string } {
  const from = thumb.getBoundingClientRect();
  const scale = Math.max(from.width / to.width, from.height / to.height);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const insetX = Math.max(0, (to.width - from.width / scale) / 2);
  const insetY = Math.max(0, (to.height - from.height / scale) / 2);
  const radius = (parseFloat(getComputedStyle(thumb).borderTopLeftRadius) || 0) / scale;
  return {
    transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
    clipPath: `inset(${insetY}px ${insetX}px round ${radius}px)`,
  };
}

/**
 * A picture over everything: it grows out of its place in the chat and goes
 * back there. Arrows, keys or a swipe move between the room's pictures; a
 * double click, the wheel or a pinch zooms, and a zoomed picture is dragged
 * about. Escape, the close button, a click beside the picture or a swipe down
 * puts it away.
 */
export function Lightbox({ items, startId, onClose }: { items: ViewerItem[]; startId: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const bg = useRef<HTMLDivElement>(null);
  const [currentId, setCurrentId] = useState(startId);
  const [view, setView] = useState<View>(at1);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: 'none' | 'pan' | 'swipe' | 'dismiss' | 'pinch' | 'undecided'; startX: number; startY: number; view: View; dist: number; moved: number; time: number }>({ kind: 'none', startX: 0, startY: 0, view: at1, dist: 0, moved: 0, time: 0 });
  const opened = useRef(false);

  const index = Math.max(0, items.findIndex((i) => i.attachment.id === currentId));
  const item = items[index];
  const { state: image, attempt, onError } = useAttachmentImage(item?.attachment ?? null);
  const count = items.length;

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => { if (el?.open) el.close(); };
  }, []);

  // Grows out of the thumbnail once the picture has its size.
  useLayoutEffect(() => {
    if (opened.current || image.status === 'loading') return;
    const target = frame.current;
    if (!target) return;
    const run = () => {
      if (opened.current) return;
      opened.current = true;
      const from = originOf(startId);
      const to = target.getBoundingClientRect();
      bg.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calm() ? 1 : 220, easing: 'ease' });
      if (calm() || !from || !to.width) {
        target.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: calm() ? 1 : 200, easing: 'cubic-bezier(.23,1,.32,1)' });
        return;
      }
      const start = flip(from, to);
      target.animate([{ ...start, opacity: 0.6 }, { transform: 'none', clipPath: 'inset(0px 0px round 0px)', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.32,.72,0,1)' });
    };
    const el = img.current;
    if (image.status === 'ready' && el && !el.complete) {
      el.addEventListener('load', run, { once: true });
      return () => el.removeEventListener('load', run);
    }
    run();
  }, [image.status, attempt, startId]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    const target = frame.current;
    const finish = () => onClose();
    const back = item ? originOf(item.attachment.id) : null;
    const quick = calm();
    bg.current?.animate([{ opacity: Number(getComputedStyle(bg.current).opacity) }, { opacity: 0 }], { duration: quick ? 1 : 220, easing: 'ease', fill: 'forwards' });
    const pic = img.current;
    // The picture itself goes back, from wherever a drag or a zoom has left it.
    const moving = image.status === 'ready' && pic ? pic : target;
    if (!moving) return finish();
    const zoomed = viewRef.current.scale > 1.01;
    let anim: Animation;
    if (!quick && back && !zoomed && moving.offsetWidth) {
      const current = getComputedStyle(moving).transform;
      const radius = getComputedStyle(moving).borderTopLeftRadius;
      moving.getAnimations().forEach((a) => a.cancel());
      anim = moving.animate(
        [
          { transform: current === 'none' ? 'none' : current, clipPath: `inset(0px 0px round ${radius})` },
          flip(back, rectWithoutTransform(moving)),
        ],
        { duration: 280, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' },
      );
    } else {
      anim = moving.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.97)' }], { duration: quick ? 1 : 160, easing: 'ease', fill: 'forwards' });
    }
    anim.onfinish = finish;
    anim.oncancel = finish;
  };

  const go = (delta: number) => {
    if (count < 2) return;
    const next = items[index + delta];
    if (!next) return;
    setCurrentId(next.attachment.id);
    setView(at1);
    const target = frame.current;
    if (target && !calm()) {
      target.getAnimations().forEach((a) => a.cancel());
      target.animate([{ transform: `translateX(${delta * 48}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.23,1,.32,1)' });
    }
  };

  /** Keeps a zoomed picture from being dragged out of sight. */
  const clamp = (v: View): View => {
    const el = img.current;
    const box = stage.current;
    if (!el || !box || v.scale <= 1) return { ...v, scale: Math.max(1, v.scale), x: v.scale <= 1 ? 0 : v.x, y: v.scale <= 1 ? 0 : v.y };
    const maxX = Math.max(0, (el.offsetWidth * v.scale - box.clientWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * v.scale - box.clientHeight) / 2);
    return { scale: Math.min(MAX_SCALE, v.scale), x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  };

  /** Zooms keeping the point under the cursor where it is. */
  const zoomAt = (scale: number, clientX?: number, clientY?: number) => {
    const box = stage.current?.getBoundingClientRect();
    const v = viewRef.current;
    const next = Math.min(MAX_SCALE, Math.max(1, scale));
    if (!box || clientX === undefined || clientY === undefined) return setView(clamp({ ...v, scale: next, ...(next === 1 ? { x: 0, y: 0 } : {}) }));
    const px = clientX - (box.left + box.width / 2);
    const py = clientY - (box.top + box.height / 2);
    const k = next / v.scale;
    setView(clamp({ scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === '+' || e.key === '=') zoomAt(viewRef.current.scale * 1.5);
      else if (e.key === '-') zoomAt(viewRef.current.scale / 1.5);
      else if (e.key === '0') setView(at1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // React's wheel listener is passive; this one may stop the page from scrolling.
  useEffect(() => {
    const box = stage.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!e.ctrlKey && v.scale > 1) {
        // Scrolling moves about a zoomed picture; a pinch, or the wheel at first, zooms.
        setView(clamp({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        return;
      }
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomAt(v.scale * factor, e.clientX, e.clientY);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || closing) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.kind = 'pinch';
      g.dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      g.view = viewRef.current;
      setDragging(true);
      return;
    }
    g.kind = viewRef.current.scale > 1 ? 'pan' : 'undecided';
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.view = viewRef.current;
    g.moved = 0;
    g.time = performance.now();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      viewRef.current = g.view;
      zoomAt(g.view.scale * (dist / g.dist), mid.x, mid.y);
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    g.moved = Math.max(g.moved, Math.hypot(dx, dy));
    if (g.kind === 'undecided' && g.moved > 8) {
      g.kind = Math.abs(dx) > Math.abs(dy) ? (count > 1 ? 'swipe' : 'none') : dy > 0 ? 'dismiss' : 'none';
      if (g.kind !== 'none') setDragging(true);
    }
    if (g.kind === 'pan') {
      setView(clamp({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }));
      if (g.moved > 4) setDragging(true);
    } else if (g.kind === 'swipe') {
      // Past the first or last picture it only gives a little.
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === count - 1);
      setView({ scale: 1, x: edge ? dx / 4 : dx, y: 0 });
    } else if (g.kind === 'dismiss') {
      setView({ scale: 1 - Math.min(0.25, dy / 1600), x: dx / 2, y: dy });
      if (bg.current) bg.current.style.opacity = String(Math.max(0.15, 1 - dy / 400));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g.kind === 'pinch') {
      if (pointers.current.size === 0) {
        g.kind = 'none';
        setDragging(false);
        setView((v) => clamp(v));
      }
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const fast = Math.abs(dx) / Math.max(1, performance.now() - g.time) > 0.5;
    setDragging(false);
    if (g.kind === 'swipe') {
      setView(at1);
      if (dx < -70 || (fast && dx < -20)) go(1);
      else if (dx > 70 || (fast && dx > 20)) go(-1);
    } else if (g.kind === 'dismiss') {
      if (dy > 110 || (dy > 40 && dy / Math.max(1, performance.now() - g.time) > 0.5)) close();
      else {
        setView(at1);
        if (bg.current) bg.current.style.opacity = '';
      }
    } else if (g.kind === 'undecided' && g.moved < 6 && !(e.target as Element).closest('.viewer-img')) {
      // A press beside the picture is a press on what lies around it.
      close();
    }
    g.kind = 'none';
  };

  if (!item) return null;
  const { attachment } = item;
  const zoomed = view.scale > 1.01;
  const meta = [timeOf(item.createdAt), attachment.width ? `${attachment.width}×${attachment.height}` : '', formatBytes(attachment.size, t.locale)].filter(Boolean).join(' · ');

  return createPortal(
    <dialog
      ref={dialog}
      className={`viewer${zoomed ? ' zoomed' : ''}${dragging ? ' dragging' : ''}${closing ? ' closing' : ''}`}
      aria-label={t.viewer.label}
      onCancel={(e) => { e.preventDefault(); close(); }}
    >
      <div className="viewer-bg" ref={bg} />
      <div
        className="viewer-stage"
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if (!(e.target as Element).closest('.viewer-img')) return;
          if (zoomed) setView(at1);
          else zoomAt(STEP, e.clientX, e.clientY);
        }}
      >
        <div className="viewer-frame" ref={frame}>
          {image.status === 'ready' ? (
            <img
              ref={img}
              key={`${attachment.id}:${attempt}`}
              className="viewer-img"
              src={image.src}
              onError={onError}
              alt={attachment.filename}
              width={attachment.width || undefined}
              height={attachment.height || undefined}
              draggable={false}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
          ) : image.status === 'loading' ? (
            <div className="viewer-wait" style={attachment.width ? { aspectRatio: `${attachment.width} / ${attachment.height}` } : undefined} />
          ) : (
            <div className="viewer-gone"><Icon name="imageOff" />{image.status === 'gone' ? t.imageUnavailable : t.imageFailed}</div>
          )}
        </div>
      </div>
      <header className="viewer-top">
        <div className="viewer-who">
          <span className="viewer-author">{item.authorName}</span>
          <span className="viewer-meta">{meta}</span>
        </div>
        <div className="viewer-actions">
          {image.status === 'ready' && (
            <IconButton
              aria-label={zoomed ? t.viewer.zoomOut : t.viewer.zoomIn}
              onClick={() => (zoomed ? setView(at1) : zoomAt(STEP))}
            >
              <Icon name={zoomed ? 'zoomOut' : 'zoomIn'} />
            </IconButton>
          )}
          <IconButton aria-label={t.close} onClick={close} autoFocus><Icon name="x" /></IconButton>
        </div>
      </header>
      {count > 1 && (
        <>
          <button type="button" className="viewer-nav prev" aria-label={t.viewer.prev} disabled={index === 0} onClick={() => go(-1)}><Icon name="left" /></button>
          <button type="button" className="viewer-nav next" aria-label={t.viewer.next} disabled={index === count - 1} onClick={() => go(1)}><Icon name="right" /></button>
          <div className="viewer-count" aria-live="polite">{t.viewer.counter(index + 1, count)}</div>
        </>
      )}
    </dialog>,
    document.body,
  );
}

/** The element's box as laid out, before any transform an animation left on it. */
function rectWithoutTransform(el: HTMLElement): DOMRect {
  const rect = el.getBoundingClientRect();
  const tr = getComputedStyle(el).transform;
  if (!tr || tr === 'none') return rect;
  const m = new DOMMatrix(tr);
  const width = rect.width / m.a;
  const height = rect.height / m.d;
  const cx = rect.left + rect.width / 2 - m.e;
  const cy = rect.top + rect.height / 2 - m.f;
  return new DOMRect(cx - width / 2, cy - height / 2, width, height);
}
