import { test, expect, type Locator, type Page } from '@playwright/test';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page }) => {
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (/\/api\/attachments\/[^/]+\/content$/.test(url)) throw new Error('Image bytes must load through img elements');
      return original(input, init);
    };
  });
});

async function openChat(page: Page) {
  await page.goto(app.url);
  await page.locator('.feed .msg').first().waitFor({ state: 'attached' });
  await page.keyboard.press('Slash');
  await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
}

async function loaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^\/api\/attachments\/[^/]+\/content$/);
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
}

test('direct images revalidate on reload and work in the gallery and lightbox', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const contentRequests = new Set<string>();
  const validated = new Set<string>();
  cdp.on('Network.requestWillBeSent', (event) => {
    if (/\/api\/attachments\/[^/]+\/content$/.test(event.request.url)) contentRequests.add(event.requestId);
  });
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    if (event.statusCode === 304) validated.add(event.requestId);
  });
  await openChat(page);
  const tile = page.locator('.feed button.att-tile').last();
  await loaded(tile.locator('img'));
  await page.reload();
  await page.locator('.feed .msg').first().waitFor({ state: 'attached' });
  await page.keyboard.press('Slash');
  await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
  await loaded(page.locator('.feed button.att-tile').last().locator('img'));
  await expect.poll(() => [...validated].filter((id) => contentRequests.has(id)).length).toBeGreaterThan(0);
  await page.locator('.feed button.att-tile').last().click();
  await loaded(page.locator('.viewer-img'));
  await page.keyboard.press('ArrowLeft');
  await loaded(page.locator('.viewer-img'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer')).toHaveCount(0);
  const state = await (await page.request.get(`${app.url}/__mock/state`)).json();
  await page.request.post(`${app.url}/__mock/action`, { data: { type: 'expire-attachments', roomId: state.rooms[0].id } });
  await expect(page.locator('.feed .att-tile img')).toHaveCount(0);
  await expect(page.locator('.feed .att-gone').first()).toBeVisible();
  await cdp.detach();
});

test('a busy direct image retries, and metadata recovers missed expiry events', async ({ page }) => {
  let failed = false;
  await page.route('**/api/attachments/*/content', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 429, contentType: 'application/json', body: '{"code":"attachment_busy"}' });
    } else await route.continue();
  });
  await openChat(page);
  await expect.poll(() => failed).toBe(true);
  const images = page.locator('.feed .att-tile img');
  await expect.poll(() => images.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const src = await images.last().getAttribute('src');
  expect(src).toBeTruthy();
  await page.route(`**${src}`, (route) => route.fulfill({ status: 410, contentType: 'application/json', body: '{"code":"attachment_expired"}' }));
  await page.route(`**${src!.replace(/\/content$/, '')}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), availability: 'expired' } });
  });
  await page.reload();
  await page.locator('.feed .msg').first().waitFor({ state: 'attached' });
  await page.keyboard.press('Slash');
  await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.feed .att-gone').last()).toBeVisible();
});

test('upload previews use local blobs, then posted images use server URLs', async ({ page }) => {
  await openChat(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 20, 20);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('.tray-item.ready img')).toHaveAttribute('src', /^blob:/);
  await page.locator('.composer textarea').fill('Posted direct image');
  await page.locator('.composer textarea').press('Enter');
  const message = page.locator('.msg').filter({ hasText: 'Posted direct image' });
  await expect(message).toHaveCount(1);
  await loaded(message.locator('.att-tile img'));
  await expect(page.locator('.tray')).toHaveCount(0);
});
