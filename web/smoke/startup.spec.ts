import { test, expect } from '@playwright/test';
import type { MockState } from '../mock/protocol';
import { authPreferences } from './account-browser';
import { chromiumOptions } from './browser';
import { launchMock } from './launcher';

test.use({ launchOptions: { ...chromiumOptions(), args: ['--use-angle=swiftshader'] } });
let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(0, { stats: false }); });
test.afterAll(async () => { await app?.close(); });

test('warms voice when a signed-out account flow starts', async ({ page, context }) => {
  await authPreferences(page, app.url);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true });
  const warmupCalls = async () => {
    const { result } = await cdp.send('Profiler.takePreciseCoverage');
    const voice = result.find((script) => script.url.startsWith(`${app.url}/`) && new URL(script.url).pathname === '/src/mock/voice.ts');
    return voice?.functions.find((fn) => fn.functionName === 'preloadVoice')?.ranges[0]?.count ?? 0;
  };

  try {
    await page.goto(app.url);
    await expect(page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
    await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 3; frame++) await new Promise<number>(requestAnimationFrame);
    });
    expect(await warmupCalls()).toBe(0);

    await page.getByRole('button', { name: /^Use another device/ }).click();
    await expect(page.getByRole('dialog', { name: 'Use another device', exact: true })).toBeVisible();
    await expect.poll(warmupCalls).toBeGreaterThan(0);
  } finally {
    await cdp.detach();
  }
});

test('keeps background programs through empty and same-size source updates', async ({ page }) => {
  const state: MockState = await (await page.request.post(`${app.url}/__mock/bootstrap`, { data: { scenario: 'quiet' } })).json();
  await page.addInitScript((state) => {
    localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
    localStorage.setItem(`falky.mock.${state.instanceId}.language`, 'en');
    localStorage.setItem(`falky.mock.${state.instanceId}.liveBackground`, 'on');
    const original = WebGLRenderingContext.prototype.createProgram;
    WebGLRenderingContext.prototype.createProgram = function () {
      const canvas = this.canvas;
      if (canvas instanceof HTMLCanvasElement && canvas.matches('.live-background')) {
        canvas.dataset.programBuilds = String(Number(canvas.dataset.programBuilds ?? 0) + 1);
      }
      return original.call(this);
    };
  }, state);
  await page.goto(`${app.url}/?scenario=quiet`);
  const field = page.locator('.live-background');
  await expect(field).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
  // One surface and one voice program; empty Stage sources must not rebuild either.
  await expect(field).toHaveAttribute('data-program-builds', '2');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.locator('.grid .orb')).toHaveCount(1);
  await expect(field).toHaveAttribute('data-program-builds', '2');
  const next = await page.request.post(`${app.url}/__mock/action`, { data: {
    type: 'participants', roomId: state.rooms[0]!.id,
    participants: [{ connectionId: 'sam.connection', visitorId: '01JBX6Z8Q3M5W2K7R9T4V1C0D1', name: 'Sam', muted: false, deafened: false, sharing: false }],
  } });
  expect(next.ok()).toBeTruthy();
  await expect(page.locator('.grid .orb')).toHaveCount(2);
  // Membership growth rebuilds only the voice program, retaining the theme surface.
  await expect(field).toHaveAttribute('data-program-builds', '3');
  await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.locator('.grid .orb')).toHaveCount(1);
  await expect(field).toHaveAttribute('data-program-builds', '4');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.locator('.grid .orb')).toHaveCount(2);
  await expect(field).toHaveAttribute('data-program-builds', '5');
});

test('does not measure a hidden chat and restores the latest messages on opening', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  await page.addInitScript(() => {
    const reads = () => { document.documentElement.dataset.feedReads = String(Number(document.documentElement.dataset.feedReads ?? 0) + 1); };
    const original = window.getComputedStyle;
    window.getComputedStyle = function (element, pseudo) {
      if (element.matches('.feed')) reads();
      return original.call(this, element, pseudo);
    };
    for (const key of ['clientHeight', 'clientWidth'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, key)!;
      Object.defineProperty(Element.prototype, key, { ...descriptor, get() {
        if ((this as Element).matches('.feed')) reads();
        return descriptor.get!.call(this) as number;
      } });
    }
  });
  await page.goto(app.url);
  await expect(page.locator('.feed .msg').first()).toBeAttached();
  await expect(page.locator('.chat')).toBeHidden();
  expect(await page.locator('html').getAttribute('data-feed-reads')).toBeNull();
  await page.locator('.dock-chat').click();
  await expect(page.getByText('Welcome back! Try sending a message or joining voice.', { exact: true })).toBeVisible();
  expect(Number(await page.locator('html').getAttribute('data-feed-reads'))).toBeGreaterThan(0);
  await expect(page.locator('.to-latest')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('.feed').evaluate((el) => { el.scrollTop -= 500; });
  await expect.poll(() => page.locator('.to-latest').getAttribute('aria-hidden')).toBe('false');
  await page.locator('.dock-chat').click();
  await expect(page.locator('.dock-chat')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('html').evaluate((el) => { el.removeAttribute('data-feed-reads'); });
  await page.setViewportSize({ width: 430, height: 844 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.locator('html').getAttribute('data-feed-reads')).toBeNull();
  await page.locator('.dock-chat').click();
  await expect(page.locator('.chat')).toBeVisible();
  await expect(page.locator('.to-latest')).toHaveAttribute('aria-hidden', 'false');
});
