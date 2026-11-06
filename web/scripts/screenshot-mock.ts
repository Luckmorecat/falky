import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect, type Browser } from '@playwright/test';
import { scenarios, type MockState } from '../mock/protocol';
import { chromiumOptions } from '../smoke/browser';
import { launchMock } from '../smoke/launcher';
import { setLanguage, t } from '../src/strings';

const presets = ['room', 'chat', 'voice', 'screen-share', 'settings', 'entry'] as const;
const { values } = parseArgs({ options: {
  preset: { type: 'string' }, scenario: { type: 'string' }, output: { type: 'string' },
  viewport: { type: 'string', default: '1440x1000' }, theme: { type: 'string', default: 'dark' },
  lang: { type: 'string', default: 'en' }, 'full-page': { type: 'boolean', default: false },
  gpu: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });

async function main() {
  if (values.help) {
    console.log(`Usage: npm run screenshot:mock -- [options]
  --preset ${presets.join('|')} (default: room)
  --scenario ${scenarios.join('|')} (default: preset's fixture)
  --output PATH.png            Default: screenshots/<preset>.png
  --viewport WIDTHxHEIGHT      Default: 1440x1000
  --theme dark|light           Default: dark
  --lang en|uk                 Default: en
  --full-page                  Capture the full page
  --gpu                        Request hardware GPU with full headless Chromium

Each capture owns and closes a fresh mock server and browser. Screen-share uses
remote-share; entry uses entry; other presets use populated. --scenario alone
captures its starting screen. Real hardware rendering depends on host support.
Install once: npx playwright install chromium
Existing browser: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium`);
    return;
  }
  const preset = values.preset ?? (values.scenario === 'entry' ? 'entry' : 'room');
  const scenario = values.scenario ?? (preset === 'entry' ? 'entry' : preset === 'screen-share' ? 'remote-share' : 'populated');
  if (!presets.includes(preset as typeof presets[number])) throw new Error(`Unknown preset: ${preset}`);
  if (!scenarios.includes(scenario as typeof scenarios[number])) throw new Error(`Unknown scenario: ${scenario}`);
  if ((preset === 'entry') !== (scenario === 'entry')) throw new Error('The entry scenario requires the entry preset, and vice versa.');
  if (values.theme !== 'dark' && values.theme !== 'light') throw new Error('Theme must be dark or light.');
  if (values.lang !== 'en' && values.lang !== 'uk') throw new Error('Language must be en or uk.');
  const dimensions = /^(\d+)x(\d+)$/.exec(values.viewport);
  const width = Number(dimensions?.[1]);
  const height = Number(dimensions?.[2]);
  if (!dimensions || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Viewport must be WIDTHxHEIGHT, each between 1 and 8192.');
  const output = resolve(values.output ?? `screenshots/${preset}.png`);
  if (!output.toLowerCase().endsWith('.png')) throw new Error('Output must have a .png extension.');
  await mkdir(dirname(output), { recursive: true });
  setLanguage(values.lang);

  const cancellation = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; cancellation.abort(new Error('Screenshot interrupted')); };
  const onTerminate = () => { process.exitCode = 143; cancellation.abort(new Error('Screenshot terminated')); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const timeout = setTimeout(() => cancellation.abort(new Error('Screenshot timed out after 45 seconds')), 45_000);
  let app: Awaited<ReturnType<typeof launchMock>> | undefined;
  let browser: Browser | undefined;
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  cancellation.signal.addEventListener('abort', closeBrowser);
  try {
    app = await launchMock(0, { signal: cancellation.signal, stats: false });
    console.error(`Mock: ${app.url} | preset: ${preset} | scenario: ${scenario}${values.gpu ? ' | GPU requested' : ''}`);
    browser = await chromium.launch({ ...chromiumOptions(values.gpu), headless: true,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    cancellation.signal.throwIfAborted();
    const page = await browser.newPage({ viewport: { width, height }, locale: values.lang,
      timezoneId: 'UTC', colorScheme: values.theme, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(15_000);
    const response = await page.request.post(`${app.url}/__mock/bootstrap`, { data: { scenario } });
    if (!response.ok()) throw new Error(`Mock bootstrap failed: ${response.status()}`);
    const state: MockState = await response.json();
    await page.addInitScript(({ state, lang, theme }) => {
      localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
      const prefix = `falky.mock.${state.instanceId}.`;
      localStorage.setItem(prefix + 'lang', lang);
      localStorage.setItem(prefix + 'theme', theme);
    }, { state, lang: values.lang, theme: values.theme });
    await page.goto(`${app.url}/?scenario=${scenario}`);
    if (preset === 'entry') {
      await expect(page.getByRole('textbox', { name: t.name, exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: t.settings, exact: true })).toBeVisible();
      // Wait for initial history; ongoing mock polling means networkidle never applies.
      await page.locator('.feed .msg, .feed .empty-chat').first().waitFor({ state: 'attached' });
      if (preset === 'chat') {
        // The chat button is hidden on wide screens; the app's shortcut works in both layouts.
        await page.keyboard.press('Slash');
        await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
      }
      if (preset === 'voice' || preset === 'screen-share') {
        await page.getByRole('button', { name: t.join, exact: true }).click();
        await expect(page.getByRole('toolbar')).toBeVisible();
      }
      if (preset === 'screen-share') {
        if (scenario !== 'remote-share') await page.getByRole('button', { name: t.shareOn, exact: true }).click();
        await page.locator('.share video').waitFor({ state: 'visible' });
        await page.waitForFunction(() => [...document.querySelectorAll('video')].some((video) => video.readyState >= 2 && video.videoWidth > 0));
      }
      if (preset === 'settings') {
        await page.getByRole('button', { name: t.settings, exact: true }).click();
        await expect(page.getByRole('dialog', { name: t.settings, exact: true })).toBeVisible();
      }
    }
    await page.evaluate(() => document.fonts.ready);
    // Keep hover/focus affordances out of captures; let layout transitions finish.
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    if (values.gpu) {
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return 'WebGL unavailable';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return name;
      });
      console.error(`WebGL renderer: ${renderer}`);
    }
    await page.screenshot({ path: output, type: 'png', fullPage: values['full-page'], animations: 'disabled', caret: 'hide' });
    cancellation.signal.throwIfAborted();
  } finally {
    clearTimeout(timeout);
    try { await browser?.close(); } finally { await app?.close(); }
    cancellation.signal.removeEventListener('abort', closeBrowser);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  cancellation.signal.throwIfAborted();
  console.log(output);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ||= 1;
});
