import { test, expect } from '@playwright/test';
import type { MockState } from '../mock/protocol';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
let fixture: MockState;
test.beforeAll(async () => { app = await launchMock(0, { stats: false }); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page }) => {
  fixture = await (await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } })).json();
  await page.addInitScript(({ instanceId, generation }) => {
    localStorage.setItem(`falky.mock-generation.${instanceId}`, String(generation));
    const prefix = `falky.mock.${instanceId}.`;
    localStorage.setItem(prefix + 'language', 'en');
    localStorage.setItem(prefix + 'theme', 'dark');
    localStorage.setItem(prefix + 'liveBackground', 'on');
  }, fixture);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`unread Beacon reaches the chat target and stops on read at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(app.url);
    await page.locator('.feed .msg').first().waitFor({ state: 'attached' });
    const background = page.locator('.live-background');
    await expect(background).toHaveAttribute('data-ready', 'true');
    await expect(background).not.toHaveAttribute('data-beacon');
    await page.request.post(`${app.url}/__mock/action`, { data: { type: 'message', roomId: fixture.rooms[0]!.id, authorName: 'Sam', body: 'Ready when you are 👋' } });
    await expect(background).toHaveAttribute('data-beacon', '');
    await expect(page.locator(viewport.width < 1180 ? '.chat-btn .badge' : '.chat-hint .badge')).toHaveText('1');
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath('beacon.png') });
    const clip = viewport.width < 1180
      ? { x: 210, y: 0, width: 180, height: 90 }
      : { x: 1110, y: 790, width: 300, height: 190 };
    const first = await page.screenshot({ clip });
    await page.waitForTimeout(350);
    expect((await page.screenshot({ clip })).equals(first)).toBe(false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    const still = await page.screenshot({ clip });
    await page.waitForTimeout(350);
    expect((await page.screenshot({ clip })).equals(still)).toBe(true);
    await page.keyboard.press('Slash');
    await expect(background).not.toHaveAttribute('data-beacon');
    await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
    if (viewport.width < 1180) await page.getByRole('button', { name: 'Close chat', exact: true }).click();
    else {
      await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'false');
    await page.request.post(`${app.url}/__mock/action`, { data: { type: 'message', roomId: fixture.rooms[1]!.id, authorName: 'Sam', body: 'Unread in Games' } });
    await expect(page.getByRole('button', { name: 'Rooms: Lounge', exact: true }).getByTitle('New messages')).toBeAttached();
    await expect(background).not.toHaveAttribute('data-beacon');
    await page.keyboard.press('ArrowRight');
    await expect(background).toHaveAttribute('data-beacon', '');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'System', exact: true }).click();
    await page.getByRole('switch', { name: 'Fewer effects', exact: true }).click();
    await expect(background).not.toHaveAttribute('data-ready');
    await page.getByRole('switch', { name: 'Fewer effects', exact: true }).click();
    await expect(background).toHaveAttribute('data-ready', 'true');
    await page.getByRole('switch', { name: 'Live background', exact: true }).click();
    await expect(background).not.toHaveAttribute('data-ready');
  });
}
