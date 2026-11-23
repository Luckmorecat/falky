import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('leaves event handling intact without notifications', async () => {
  vi.stubGlobal('Notification', undefined);
  const browser = await import('./browser');
  expect(browser.notificationsAvailable).toBe(false);
  expect(browser.notificationPermission()).toBe('denied');
  await expect(browser.requestNotificationPermission()).resolves.toBe('denied');
  expect(() => browser.notify('New message', {}, vi.fn())).not.toThrow();
});

it('handles a throwing constructor and unavailable permission requests', async () => {
  class UnsupportedNotification {
    static permission = 'granted';
    static requestPermission = vi.fn().mockRejectedValueOnce(new Error()).mockImplementationOnce(() => { throw new Error(); });
    constructor() { throw new TypeError('The browser does not support this constructor'); }
  }
  vi.stubGlobal('Notification', UnsupportedNotification);
  const browser = await import('./browser');
  expect(() => browser.notify('New message', {}, vi.fn())).not.toThrow();
  await expect(browser.requestNotificationPermission()).resolves.toBe('denied');
  await expect(browser.requestNotificationPermission()).resolves.toBe('denied');
  await expect(browser.requestNotificationPermission()).resolves.toBe('denied');
});

it('keeps notification clicks and closing working where supported', async () => {
  const close = vi.fn();
  let handler: (() => void) | undefined;
  class SupportedNotification {
    static permission = 'granted';
    static requestPermission = async () => 'granted';
    set onclick(callback: () => void) { handler = callback; }
    close = close;
  }
  vi.stubGlobal('Notification', SupportedNotification);
  const browser = await import('./browser');
  const click = vi.fn();
  browser.notify('New message', {}, click);
  expect(click).not.toHaveBeenCalled();
  handler?.();
  expect(click).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
