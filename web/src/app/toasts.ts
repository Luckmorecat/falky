export interface ToastContent {
  title: string;
  body?: string;
}

interface ToastOptions extends ToastContent {
  /** Defaults to seven seconds. Use null to keep the toast until it is dismissed. */
  durationMs?: number | null;
}

interface ToastHandle {
  dismiss(): void;
}

interface ToastEntry extends ToastContent, ToastHandle {
  id: number;
  persistent: boolean;
}

let nextId = 0;
let toasts: readonly ToastEntry[] = [];
let timed: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;
const listeners = new Set<() => void>();

export const getToasts = () => toasts;

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(next: readonly ToastEntry[]): void {
  toasts = next;
  listeners.forEach(listener => listener());
}

function stopTimer(): void {
  if (timed) clearTimeout(timed.timer);
  timed = null;
}

export function showToast({ title, body, durationMs = 7_000 }: ToastOptions): ToastHandle {
  const id = ++nextId;
  const dismiss = () => {
    if (timed?.id === id) stopTimer();
    if (toasts.some(toast => toast.id === id)) update(toasts.filter(toast => toast.id !== id));
  };
  let previous = toasts;
  if (durationMs !== null) {
    const replacedId = timed?.id;
    stopTimer();
    timed = { id, timer: setTimeout(dismiss, durationMs) };
    if (replacedId !== undefined) previous = previous.filter(toast => toast.id !== replacedId);
  }
  update([...previous, { id, title, body, dismiss, persistent: durationMs === null }]);
  return { dismiss };
}

export function clearToasts(): void {
  stopTimer();
  if (toasts.length) update([]);
}
