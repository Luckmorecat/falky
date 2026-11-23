import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getToasts, subscribeToasts, type ToastContent } from '../app/toasts';
import { t } from '../strings';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import './Notices.css';

type Position = 'banner' | 'before' | 'after' | 'form';
const TopSlots = createContext<Partial<Record<Position, HTMLElement | null>>>({});
const MIN_UNPINNED_SPACE = 52; // A 44px action and both scroll margins.

export function ToastHost({ children, inert }: { children: ReactNode; inert?: boolean }) {
  const [banner, setBanner] = useState<HTMLDivElement | null>(null);
  const [before, setBefore] = useState<HTMLDivElement | null>(null);
  const [after, setAfter] = useState<HTMLDivElement | null>(null);
  const [form, setForm] = useState<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const hasPersistentToast = toasts.some(toast => toast.persistent);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const stack = stackRef.current;
    if (!viewport || !stack || typeof ResizeObserver === 'undefined') return;
    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const stackHeight = stack.offsetHeight;
      viewport.style.setProperty('--notice-height', `${stackHeight}px`);
      const knock = stack.querySelector<HTMLElement>('.knock-toast');
      const knockHeight = knock?.offsetHeight ?? 0;
      viewport.style.setProperty('--notice-knock-height', `${knockHeight}px`);
      const overflowing = stackHeight > viewport.clientHeight;
      const wasOverflowing = viewport.hasAttribute('data-overflowing');
      if (overflowing !== wasOverflowing) viewport.toggleAttribute('data-overflowing', overflowing);
      const height = viewport.clientHeight;
      const canPinKnock = overflowing && knockHeight > 0 && height >= knockHeight + MIN_UNPINNED_SPACE;
      const newlyPinned = canPinKnock && !viewport.hasAttribute('data-pin-knock');
      viewport.toggleAttribute('data-pin-knock', canPinKnock);
      const revealFocus = overflowing && (!wasOverflowing || height < previousHeight || newlyPinned);
      previousHeight = height;
      if (!revealFocus) return;
      const focused = document.activeElement;
      if (viewport.contains(focused)) focused?.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(viewport);
    observer.observe(stack);
    return () => observer.disconnect();
  }, []);

  return (
    <TopSlots value={{ banner, before, after, form }}>
      <div className="app-viewport" inert={inert}>
        {children}
        <div className={`float-top${hasPersistentToast ? ' has-persistent-toast' : ''}`} ref={viewportRef} aria-live="polite">
          <div className="top-notice-stack" ref={stackRef}>
            <div className="top-notice-slot" ref={setBanner} />
            <div className="top-notice-slot" ref={setBefore} />
            {toasts.map(({ id, dismiss, title, body }) => <ToastCard key={id} title={title} body={body} onDismiss={dismiss} />)}
            <div className="top-notice-slot" ref={setAfter} />
            <div className="top-notice-slot" ref={setForm} />
          </div>
        </div>
      </div>
    </TopSlots>
  );
}

/** Shares the top layout with room UI that keeps its own semantics. */
export function TopNoticeSlot({ position, children }: { position: Position; children: ReactNode }) {
  const target = useContext(TopSlots)[position];
  return target ? createPortal(children, target) : null;
}

interface ToastCardProps extends ToastContent {
  action?: ReactNode;
  onDismiss?: () => void;
  role?: 'status' | 'alert';
  className?: string;
}

interface ToastProps extends ToastCardProps {
  open: boolean;
  position?: 'before' | 'after';
}

export function Toast({ open, position = 'after', ...props }: ToastProps) {
  return open ? <TopNoticeSlot position={position}><ToastCard {...props} /></TopNoticeSlot> : null;
}

function revealUnpinnedKnock(knock: HTMLDivElement) {
  const viewport = knock.closest<HTMLElement>('.float-top');
  if (!viewport?.closest('[data-chat-toast-overlap]') || viewport.scrollTop <= 0 || viewport.clientHeight >= knock.offsetHeight + MIN_UNPINNED_SPACE) return;

  const pending = new AbortController();
  let idle: ReturnType<typeof setTimeout>;
  const cancel = () => { pending.abort(); clearTimeout(idle); };
  const reveal = () => {
    const focused = document.activeElement;
    if (focused !== viewport && viewport.contains(focused)) return;
    if (viewport.closest('[data-chat-toast-overlap]') && !viewport.hasAttribute('data-pin-knock')) viewport.scrollTop = 0;
  };
  const settled = () => { cancel(); reveal(); };
  const waitForPause = () => { clearTimeout(idle); idle = setTimeout(settled, 200); };
  const options = { signal: pending.signal, passive: true };
  // A fling already in progress can overtake the first reveal. A fresh gesture belongs to the user.
  viewport.addEventListener('scrollend', () => { if (viewport.scrollTop > 0) settled(); }, options);
  viewport.addEventListener('scroll', waitForPause, options);
  for (const event of ['pointerdown', 'wheel', 'keydown', 'focusin']) viewport.addEventListener(event, cancel, options);
  waitForPause();
  reveal();
  return cancel;
}

function ToastCard({ title, body, action, onDismiss, role = 'status', className }: ToastCardProps) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (className === 'knock-toast' && card.current) return revealUnpinnedKnock(card.current);
  }, [className]);

  return (
    <div ref={card} className={className ? `toast ${className}` : 'toast'} role={role}>
      <div>
        <strong>{title}</strong>
        {body && <p>{body}</p>}
      </div>
      {(action || onDismiss) && (
        <div className="toast-actions">
          {action}
          {onDismiss && <IconButton size="small" aria-label={t.close} onClick={onDismiss}><Icon name="x" /></IconButton>}
        </div>
      )}
    </div>
  );
}
