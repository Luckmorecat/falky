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
  await page.getByRole('tab', { name: 'Система', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.keyboard.press('Escape');
}
async function systemSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'System', exact: true }).click();
}
async function action(page: Page, data: MockAction) {
  const response = await page.request.post(`${app.url}/__mock/action`, { data });
  expect(response.ok()).toBeTruthy();
  const next: MockState = await response.json();
  await page.waitForResponse(async (r) => r.url().endsWith('/__mock/state') && r.ok() && (await r.json()).revision >= next.revision);
}

test.describe('live background', () => {
  test('spreads the background in silence, reverses, and keeps speech independent', async ({ page }) => {
    await page.addInitScript(() => {
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (mode, first, count) {
        draw.call(this, mode, first, count);
        const canvas = this.canvas;
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.matches('.live-background') || mode !== this.POINTS) return;
        const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
        const theme = this.getUniform(program, this.getUniformLocation(program, 'uTheme')!) as number;
        const direction = this.getUniform(program, this.getUniformLocation(program, 'uThemeDirection')!) as number;
        const top = new Uint8Array(4), bottom = new Uint8Array(4);
        this.readPixels(20, canvas.height - 20, 1, 1, this.RGBA, this.UNSIGNED_BYTE, top);
        this.readPixels(canvas.width - 20, 20, 1, 1, this.RGBA, this.UNSIGNED_BYTE, bottom);
        const level = this.getUniform(program, this.getUniformLocation(program, 'uVoices[0]')!) as Float32Array;
        const row = new Uint8Array(canvas.width * 4);
        this.readPixels(0, Math.floor(canvas.height / 2), canvas.width, 1, this.RGBA, this.UNSIGNED_BYTE, row);
        let blendedPixels = 0;
        for (let x = 0; x < canvas.width; x++) if (row[x * 4]! > 30 && row[x * 4]! < 240) blendedPixels++;
        const centre = new Uint8Array(200 * 200 * 4);
        this.readPixels(Math.floor(canvas.width / 2) - 100, Math.floor(canvas.height / 2) - 100, 200, 200, this.RGBA, this.UNSIGNED_BYTE, centre);
        let collisionPixels = 0;
        for (let i = 0; i < centre.length; i += 4) {
          if (Math.max(centre[i]!, centre[i + 1]!, centre[i + 2]!) - Math.min(centre[i]!, centre[i + 1]!, centre[i + 2]!) > 20) collisionPixels++;
        }
        canvas.dataset.frame = JSON.stringify({ theme, direction, blendedPixels, collisionPixels, top: [...top], bottom: [...bottom], level: level[2] });
      };
    });
    await page.clock.install();
    await page.goto(app.url);
    await english(page);
    await systemSettings(page);
    await page.getByLabel('Live background', { exact: true }).check();
    const field = page.locator('.live-background');
    await expect(field).toHaveAttribute('data-ready', 'true');
    const frame = () => field.evaluate((canvas) => JSON.parse((canvas as HTMLElement).dataset.frame!) as { theme: number; direction: number; blendedPixels: number; collisionPixels: number; top: number[]; bottom: number[]; level: number });
    await expect.poll(async () => (await frame()).theme).toBe(0);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));
    const selectTheme = (name: string) => page.getByRole('button', { name, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await selectTheme('Light');
    await page.clock.runFor(300);
    const middle = await frame();
    expect(middle.theme).toBeGreaterThan(.2);
    expect(middle.theme).toBeLessThan(.8);
    expect(middle.top).toEqual([255, 255, 255, 255]);
    expect(middle.bottom).toEqual([255, 255, 255, 255]);
    expect(middle.direction).toBe(1);
    expect(middle.blendedPixels).toBeGreaterThan(100);
    expect(middle.collisionPixels).toBeGreaterThan(20);
    await page.screenshot({ path: 'screenshots/live-background-theme-wave.png' });

    await selectTheme('Dark');
    await page.clock.runFor(150);
    expect((await frame()).theme).toBeLessThan(middle.theme);
    expect((await frame()).direction).toBe(-1);
    await page.clock.runFor(600);
    await expect.poll(async () => (await frame()).theme).toBe(0);
    expect((await frame()).top).toEqual([22, 22, 21, 255]);

    // The screen still owns the wave when an empty room has no voice sources.
    await page.clock.resume();
    const lounge = (await state(page)).rooms[0]!.id;
    await action(page, { type: 'participants', roomId: lounge, participants: [] });
    await selectTheme('Light');
    await expect.poll(async () => (await frame()).theme).toBe(1);
    expect((await frame()).bottom).toEqual([255, 255, 255, 255]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect.poll(async () => (await frame()).level).toBeGreaterThan(.15);
    await systemSettings(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));
    await selectTheme('Dark');
    await page.clock.runFor(300);
    expect((await frame()).theme).toBeGreaterThan(0);
    expect((await frame()).theme).toBeLessThan(1);
    expect((await frame()).level).toBeGreaterThan(0);
    await page.clock.resume();
    await expect.poll(async () => (await frame()).theme).toBe(0);
    await expect.poll(async () => (await frame()).level).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await selectTheme('Light');
    await expect.poll(async () => (await frame()).theme).toBe(1);
    expect((await frame()).top).toEqual([255, 255, 255, 255]);
    expect((await frame()).bottom).toEqual([255, 255, 255, 255]);
  });

  test('persists the opt-in and follows every orb through room layouts', async ({ page }) => {
    await page.goto(app.url);
    await english(page);
    const field = page.locator('.live-background');
    await expect(field).toBeHidden();
    await systemSettings(page);
    const toggle = page.getByLabel('Live background', { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    const initial = await state(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), `falky.mock.${initial.instanceId}.liveBackground`)).toBe('on');
    await page.keyboard.press('Escape');
    await page.reload();
    await systemSettings(page);
    await expect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(field).toHaveAttribute('data-ready', 'true');
    const lounge = (await state(page)).rooms[0]!.id;
    await action(page, { type: 'participants', roomId: lounge, participants: Array.from({ length: 7 }, (_, i) => ({ connectionId: `speaker.${i}`, visitorId: `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}`, name: `Speaker ${i + 1}`, muted: false, deafened: false, sharing: false })) });
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

    await systemSettings(page);
    await page.getByLabel('Fewer effects', { exact: true }).check();
    await expect(field).toBeHidden();
    await expect(toggle).toBeChecked();
    await page.getByLabel('Fewer effects', { exact: true }).uncheck();
    await expect(field).toHaveAttribute('data-ready', 'true');
    await toggle.uncheck();
    await expect(field).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), `falky.mock.${initial.instanceId}.liveBackground`)).toBe('off');
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
    await systemSettings(page);
    await page.getByLabel('Live background', { exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('toolbar')).toBeVisible();
    await expect(page.locator('.live-background')).toBeHidden();
    expect(await page.locator('.room-screen').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
  });
});
