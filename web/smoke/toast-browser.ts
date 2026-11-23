import type { Page } from '@playwright/test';

export async function showBrowserToast(page: Page, title: string, durationMs?: number | null, dismissalEvent?: string): Promise<void> {
  await page.evaluate(async ({ title, durationMs, dismissalEvent }) => {
    const path = '/src/app/toasts.ts';
    const { showToast } = await import(path) as typeof import('../src/app/toasts');
    const handle = showToast({ title, durationMs });
    if (dismissalEvent) window.addEventListener(dismissalEvent, handle.dismiss, { once: true });
  }, { title, durationMs, dismissalEvent });
}
