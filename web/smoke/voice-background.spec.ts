import { test, expect, type Page } from '@playwright/test';
import type { MockAction, MockState } from '../mock/protocol';
import { launchMock } from './launcher';
import { chromiumOptions } from './browser';

// Keep GPU checks deterministic even on hosts without a display server.
test.use({ launchOptions: { ...chromiumOptions(), args: ['--use-angle=swiftshader'] } });
let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page }) => { await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } }); });
async function state(page: Page): Promise<MockState> { return (await page.request.get(`${app.url}/__mock/state`)).json(); }
async function english(page: Page) {
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.keyboard.press('Escape');
}
async function action(page: Page, data: MockAction) {
  const response = await page.request.post(`${app.url}/__mock/action`, { data });
  expect(response.ok()).toBeTruthy();
  const next: MockState = await response.json();
  await page.waitForResponse(async (r) => r.url().endsWith('/__mock/state') && r.ok() && (await r.json()).revision >= next.revision);
}

test.describe('reactive voice background', () => {
  test('persists the opt-in and follows every orb through room layouts', async ({ page }) => {
    await page.goto(app.url);
    await english(page);
    const field = page.locator('.voice-background');
    await expect(field).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = page.getByLabel('Reactive background', { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    const initial = await state(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), `falky.mock.${initial.instanceId}.voiceBackground`)).toBe('on');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(field).toHaveAttribute('data-ready', 'true');
    const lounge = (await state(page)).rooms[0]!.id;
    await action(page, { type: 'participants', roomId: lounge, participants: Array.from({ length: 7 }, (_, i) => ({ visitorId: `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}`, name: `Speaker ${i + 1}`, muted: false, deafened: false, sharing: false })) });
    await expect(page.locator('.grid .orb')).toHaveCount(8);

    const sourceError = () => field.evaluate((canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext('webgl')!;
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
      const bounds = canvas.getBoundingClientRect();
      const orbs = [...document.querySelectorAll<HTMLElement>('.grid .orb')];
      const count = Array.from({ length: gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number }, (_, i) => gl.getActiveUniform(program, i)).find((u) => u?.name === 'uVoices[0]')?.size;
      if (count !== orbs.length) return Infinity;
      return Math.max(...orbs.map((orb, i) => {
        const rect = orb.getBoundingClientRect();
        const location = gl.getUniformLocation(program, `uVoices[${i}]`);
        if (!location) return Infinity;
        const source = gl.getUniform(program, location) as Float32Array;
        return Math.hypot(source[0]! - (rect.left + rect.width / 2 - bounds.left), source[1]! - (rect.top + rect.height / 2 - bounds.top));
      }));
    });
    await expect.poll(sourceError).toBeLessThan(1);
    await page.getByRole('button', { name: /^Rooms:/ }).hover();
    await expect(page.locator('body')).toHaveClass(/rooms-open/);
    await page.waitForTimeout(450);
    await expect.poll(sourceError).toBeLessThan(1);
    await page.mouse.move(1400, 950);
    await expect(page.locator('body')).not.toHaveClass(/rooms-open/);
    await page.setViewportSize({ width: 390, height: 844 });
    const chatButton = page.locator('.chat-btn');
    if (await chatButton.getAttribute('aria-expanded') === 'true') await chatButton.click();
    await expect(page.locator('.chat')).toBeHidden();
    await expect.poll(sourceError).toBeLessThan(1);
    await page.screenshot({ path: 'screenshots/voice-background-production-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(sourceError).toBeLessThan(1);
    await page.screenshot({ path: 'screenshots/voice-background-production.png' });

    const shaderTime = () => field.evaluate((canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext('webgl')!;
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
      return gl.getUniform(program, gl.getUniformLocation(program, 'uTime')!) as number;
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const pausedAt = await shaderTime();
    await page.waitForTimeout(150);
    expect(await shaderTime()).toBe(pausedAt);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(shaderTime).toBeGreaterThan(pausedAt);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Fewer effects', { exact: true }).check();
    await expect(field).toBeHidden();
    await expect(toggle).toBeChecked();
    await page.getByLabel('Fewer effects', { exact: true }).uncheck();
    await expect(field).toHaveAttribute('data-ready', 'true');
    await toggle.uncheck();
    await expect(field).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), `falky.mock.${initial.instanceId}.voiceBackground`)).toBe('off');
  });

  test('retains the static dots when WebGL is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type, ...args) {
        if (type === 'webgl' || type === 'webgl2') return null;
        return original.call(this, type, ...args);
      } as typeof original;
    });
    await page.goto(app.url);
    await english(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Reactive background', { exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('toolbar')).toBeVisible();
    await expect(page.locator('.voice-background')).toBeHidden();
    expect(await page.locator('.room-screen').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
  });
});
