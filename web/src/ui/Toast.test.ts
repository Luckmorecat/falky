import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearToasts, showToast } from '../app/toasts';
import { setLanguage } from '../strings';
import { Toast, ToastHost } from './Toast';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  setLanguage('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearToasts();
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps the host across screen switches and gives timed and persistent toasts separate close controls', async () => {
  await act(async () => { showToast({ title: 'Working', durationMs: null }); });
  const render = async (screen: string) => await act(async () => root.render(createElement(ToastHost, null, createElement('main', { key: screen }, screen))));
  await render('Sign in');
  const host = container.querySelector('.float-top');
  expect(host?.getAttribute('aria-live')).toBe('polite');
  expect(host?.textContent).toBe('Working');
  await render('Room');
  expect(container.querySelector('.float-top')).toBe(host);
  expect(host?.textContent).toBe('Working');
  await act(async () => { showToast({ title: 'Saved' }); });
  const timed = [...host!.querySelectorAll('[role="status"]')].find((item) => item.textContent === 'Saved')!;
  await act(async () => timed.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(host?.textContent).toBe('Working');
});

it('updates a declarative toast in place and removes it when closed or unmounted', async () => {
  const previousAction = vi.fn();
  const currentAction = vi.fn();
  const close = vi.fn();
  const render = async (props?: Parameters<typeof Toast>[0]) => await act(async () => {
    root.render(createElement(ToastHost, null, createElement('main', null, props && createElement(Toast, props))));
  });
  await render({ open: false, title: 'Previous' });
  expect(container.querySelector('.toast')).toBeNull();
  await render({ open: true, title: 'Previous', role: 'alert', action: createElement('button', { onClick: previousAction }, 'Previous action') });
  const toast = container.querySelector('[role="alert"]');
  expect(toast?.parentElement?.closest('.float-top')).not.toBeNull();
  expect(container.querySelector('main')?.textContent).toBe('');

  await render({ open: true, title: 'Updated', body: 'Details', role: 'alert', action: createElement('button', { onClick: currentAction }, 'New action'), onDismiss: close });
  expect(container.querySelector('[role="alert"]')).toBe(toast);
  expect(toast?.querySelector('strong')?.textContent).toBe('Updated');
  expect(toast?.querySelector('p')?.textContent).toBe('Details');
  const [action, dismiss] = toast!.querySelectorAll<HTMLButtonElement>('button');
  expect(action?.textContent).toBe('New action');
  await act(async () => { action!.click(); dismiss!.click(); });
  expect(previousAction).not.toHaveBeenCalled();
  expect(currentAction).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();

  await render({ open: false, title: 'Updated' });
  expect(container.querySelector('.toast')).toBeNull();
  await render({ open: true, title: 'Reopened' });
  expect(container.querySelector('.toast')?.textContent).toBe('Reopened');
  await render();
  expect(container.querySelector('.toast')).toBeNull();
});
