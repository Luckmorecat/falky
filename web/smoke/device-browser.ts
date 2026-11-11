import { expect, type Browser, type Page } from '@playwright/test';
import type { MockState } from '../mock/protocol';

export async function devicePage(browser: Browser, state: MockState) {
  const context = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 } });
  await context.addInitScript((state) => {
    localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
    localStorage.setItem(`falky.mock.${state.instanceId}.language`, 'en');
  }, state);
  return context.newPage();
}
export async function requestQR(page: Page, url: string) {
  await page.goto(url);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/qr-signins'));
  await page.getByRole('button', { name: 'Use another device', exact: false }).click();
  await expect(page.getByRole('img', { name: 'QR code for this sign-in request', exact: true })).toBeVisible();
  return (await response).json() as Promise<{ url: string; request: { id: string; expiresAt: string } }>;
}
export async function previewQR(page: Page, url: string) {
  await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
  await page.getByRole('button', { name: 'Paste QR link', exact: true }).click();
  await page.getByRole('textbox', { name: 'Paste QR link', exact: true }).fill(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve sign-in', exact: true })).toBeVisible();
}
export async function createLink(page: Page) {
  await page.getByRole('button', { name: /^(Create sign-in link|Create a new link)$/, exact: true }).click();
  return page.getByRole('textbox', { name: 'Sign-in link', exact: true }).inputValue();
}
export async function receiveLink(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('.device-code')).toBeVisible();
  await expect(page).not.toHaveURL(/signin=/);
  return (await page.locator('.device-code').innerText()).replace(/\s/g, '');
}
export async function session(page: Page, url: string) {
  return (await page.request.get(url + '/api/accounts/session')).json();
}
