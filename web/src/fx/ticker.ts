/** One animation frame loop for every living block; it stops when no one listens. */
export type TickFn = (timeSec: number, dtSec: number) => void;

const listeners = new Set<TickFn>();
let raf = 0;
let last = 0;

function frame(ms: number): void {
  raf = 0;
  if (document.hidden) return;
  const t = ms / 1000;
  const dt = Math.min(0.05, last ? t - last : 0.016);
  last = t;
  for (const fn of listeners) fn(t, dt);
  schedule();
}

function schedule(): void {
  if (!raf && listeners.size && !document.hidden) raf = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  schedule();
});

export function onTick(fn: TickFn): () => void {
  listeners.add(fn);
  if (!raf) {
    last = 0;
    schedule();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }
  };
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Whether blocks stay nearly still: the person asked for it, here or in the system. */
export const effectsReduced = (): boolean => (motionQuery?.matches ?? false) || document.body.classList.contains('reduced');
