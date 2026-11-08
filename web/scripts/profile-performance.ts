import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import type { MockState } from '../mock/protocol';
import { scenarios } from '../mock/protocol';
import { chromiumOptions } from '../smoke/browser';
import { launchMock } from '../smoke/launcher';
import { installMetrics, metricNames, summarize } from './performance-metrics';

const { values } = parseArgs({ options: {
  url: { type: 'string' },
  'storage-state': { type: 'string' },
  scenario: { type: 'string' },
  flow: { type: 'string', default: 'chat-settings' },
  runs: { type: 'string', default: '3' },
  settle: { type: 'string', default: '1' },
  viewport: { type: 'string', default: '1440x1000' },
  'cpu-rate': { type: 'string', default: '1' },
  network: { type: 'string', default: 'none' },
  gpu: { type: 'boolean', default: false },
  output: { type: 'string' },
  compare: { type: 'string' },
  help: { type: 'boolean', default: false },
} });
const networks = {
  none: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  fast4g: { latency: 40, downloadThroughput: 1_250_000, uploadThroughput: 375_000 },
} as const;

function numeric(name: 'runs' | 'settle' | 'cpu-rate', min: number, max: number, integer = false) {
  const value = Number(values[name]);
  if (!values[name].trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}
function safeURL(value: string) {
  const url = new URL(value);
  return url.origin + url.pathname;
}
async function settle(page: Page, milliseconds: number) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await page.waitForTimeout(milliseconds);
  // web-vitals processes Event Timing entries in idle callbacks (bounded at 1s).
  await page.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done(), { timeout: 1100 })));
}

async function main() {
  if (values.help) {
    console.log(`Usage: pnpm run profile:performance [options]
  --url URL                Existing site; otherwise starts an isolated mock dev app
  --storage-state FILE     Playwright auth state for --url (never saved in report)
  --scenario NAME          Mock fixture: ${scenarios.join('|')} (default: populated)
  --flow chat-settings|none Default: chat-settings; entry requires none
  --runs COUNT             Fresh Chromium launches, 1–20 (default: 3)
  --settle SECONDS         Settle before/after the flow, 0.1–10 (default: 1)
  --viewport WIDTHxHEIGHT  Default: 1440x1000
  --cpu-rate RATE          CDP CPU slowdown, 1–20 (default: 1)
  --network none|fast4g    Default: none; fast4g = 40ms, 10Mbps down, 3Mbps up
  --gpu                    Request hardware-capable Chromium
  --output PATH.json       Default: profiles/performance-<timestamp>.json
  --compare BASELINE.json  Compare medians only if workload/environment match

JSON is written to stdout and the output file; progress goes to stderr.
Each run disables browser HTTP cache and uses a fresh, extension-free browser.
The flow opens chat, types and clears an unsent draft, closes chat, and opens/
closes settings. It never sends messages or joins voice. --flow none performs
no inputs and reports INP as null. Metrics are web-vitals live updates sampled
at the end of the stated observation window, not whole-visit field metrics.
English locale, UTC, dark OS theme, normal motion, device scale 1. Existing-site
preferences are preserved. The mock uses fixed English/dark preferences.
Mock development timings include Vite and simulated services; they do not
measure the production bundle, compression, real media or real-user INP.
Use --url for a deployed/locally served production build. Authentication must
already exist in --storage-state; no login or access-link entry is automated.
Install Chromium once: pnpm exec playwright install chromium
Or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium.`);
    return;
  }
  const runs = numeric('runs', 1, 20, true);
  const settleSeconds = numeric('settle', .1, 10);
  const cpuRate = numeric('cpu-rate', 1, 20);
  const viewportMatch = /^(\d+)x(\d+)$/.exec(values.viewport);
  const width = Number(viewportMatch?.[1]), height = Number(viewportMatch?.[2]);
  if (!viewportMatch || width < 320 || width > 3840 || height < 320 || height > 3840) throw new Error('--viewport must be WIDTHxHEIGHT, each 320–3840');
  if (values.flow !== 'chat-settings' && values.flow !== 'none') throw new Error('Unknown --flow');
  if (!Object.hasOwn(networks, values.network)) throw new Error('Unknown --network');
  const network = networks[values.network as keyof typeof networks];
  const scenario = values.scenario ?? 'populated';
  if (!scenarios.includes(scenario as typeof scenarios[number])) throw new Error('Unknown --scenario');
  if (values.url && values.scenario) throw new Error('--scenario applies only to mock runs');
  if (!values.url && values['storage-state']) throw new Error('--storage-state requires --url');
  if (!values.url && scenario === 'entry' && values.flow !== 'none') throw new Error('Entry requires --flow none');
  if (values.url) {
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('--url must be HTTP(S) without credentials or fragments; use --storage-state for auth');
  }
  const startedAt = new Date().toISOString();
  const output = resolve(values.output ?? `profiles/performance-${startedAt.replace(/[:.]/g, '-')}.json`);
  if (!output.endsWith('.json')) throw new Error('--output must have a .json extension');
  if (values.compare && output === resolve(values.compare)) throw new Error('--output must not overwrite --compare');
  const baseline = values.compare ? JSON.parse(await readFile(values.compare, 'utf8')) as Report : null;
  if (baseline && (baseline.schemaVersion !== 1 || !baseline.environment || !baseline.workload || !baseline.summary || baseline.status !== 'complete')) {
    throw new Error('Baseline must be a complete performance report with schemaVersion 1');
  }
  const libraryURL = new URL('web-vitals.iife.js', import.meta.resolve('web-vitals'));
  const library = await readFile(libraryURL, 'utf8');
  const libraryVersion = (JSON.parse(await readFile(new URL('../package.json', libraryURL), 'utf8')) as { version: string }).version;
  const initScript = `{ const __name = (fn) => fn; ${library}\n(${installMetrics.toString()})(webVitals); }`;
  let revision: string | null = null;
  let sourceDirty: boolean | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source may be an unpacked archive. */ }
  try { sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* Source may be an unpacked archive. */ }
  const cancellation = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; cancellation.abort(new Error('Performance profile interrupted')); };
  const onTerminate = () => { process.exitCode = 143; cancellation.abort(new Error('Performance profile terminated')); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const timeout = setTimeout(() => cancellation.abort(new Error('Performance profile timed out')), (runs * (90 + 2 * settleSeconds) + 30) * 1000);
  let app: Awaited<ReturnType<typeof launchMock>> | undefined;
  let browser: Browser | undefined;
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  cancellation.signal.addEventListener('abort', closeBrowser);
  const results = [];
  const environment = {
    chromium: '', webVitals: libraryVersion, node: process.version,
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null,
    viewport: { width, height }, locale: 'en', timezone: 'UTC', colorScheme: 'dark', reducedMotion: 'no-preference',
    deviceScaleFactor: 1, cpuRate, network: { name: values.network, ...network }, gpuRequested: values.gpu,
    cache: 'disabled; fresh browser per run',
  };
  const workload = { target: values.url ? 'existing-url' : 'mock-development', url: values.url ? safeURL(values.url) : null,
    targetFingerprint: values.url ? createHash('sha256').update(values.url).digest('hex') : null,
    scenario: values.url ? null : scenario, flow: values.flow, settleSeconds, authenticated: Boolean(values['storage-state']) };
  try {
    if (!values.url) {
      app = await launchMock(0, { signal: cancellation.signal, stats: false });
      console.error(`Mock: ${app.url}`);
    }
    for (let index = 1; index <= runs; index++) {
      cancellation.signal.throwIfAborted();
      console.error(`Run ${index}/${runs}: ${workload.target}, ${values.flow}`);
      const options = chromiumOptions(values.gpu);
      browser = await chromium.launch({ ...options, args: [...options.args ?? [], '--disable-extensions'], headless: true,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      cancellation.signal.throwIfAborted();
      environment.chromium = browser.version();
      try {
        const context = await browser.newContext({ viewport: { width, height }, locale: 'en', timezoneId: 'UTC',
          colorScheme: 'dark', reducedMotion: 'no-preference', deviceScaleFactor: 1, storageState: values['storage-state'] });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(30_000);
        let pageErrors = 0;
        page.on('pageerror', () => pageErrors++);
        await context.addInitScript({ content: initScript });
        if (app) {
          const response = await page.request.post(`${app.url}/__mock/reset`, { data: { scenario } });
          if (!response.ok()) throw new Error(`Mock reset failed: ${response.status()}`);
          const state: MockState = await response.json();
          await context.addInitScript((state) => {
            localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
            const prefix = `falky.mock.${state.instanceId}.`;
            localStorage.setItem(prefix + 'language', 'en');
            localStorage.setItem(prefix + 'theme', 'dark');
            localStorage.setItem(prefix + 'uiSounds', 'off');
          }, state);
        }
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        await session.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        await session.send('Network.emulateNetworkConditions', { offline: false, ...network });
        const target = values.url ?? `${app!.url}/?scenario=${scenario}`;
        const response = await page.goto(target, { waitUntil: 'load' });
        if (!response?.ok()) throw new Error(`Navigation failed: HTTP ${response?.status() ?? 'unknown'}`);
        if (app || values.flow === 'chat-settings') {
          await page.locator(app && scenario === 'entry' ? '.screen.center' : '.room-screen').waitFor({ state: 'visible' });
          if (scenario !== 'entry' || !app) await page.locator('.feed .msg, .feed .empty-chat').first().waitFor({ state: 'attached' });
        }
        const readyMs = await page.evaluate(() => performance.now());
        console.error(`Run ${index} ready; collecting loading metrics`);
        await settle(page, settleSeconds * 1000);
        const loading = await page.evaluate(() => ({
          ...window.__falkyPerformance.snapshot(),
          navigation: (() => {
            const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
            return { responseStart: n.responseStart, responseEnd: n.responseEnd,
              domContentLoadedMs: n.domContentLoadedEventEnd, loadEventMs: n.loadEventEnd,
              transferBytes: n.transferSize, encodedBodyBytes: n.encodedBodySize, decodedBodyBytes: n.decodedBodySize };
          })(),
          resources: performance.getEntriesByType('resource').map((entry) => {
            const r = entry as PerformanceResourceTiming;
            return { type: r.initiatorType, startTime: r.startTime, duration: r.duration,
              transferBytes: r.transferSize, encodedBodyBytes: r.encodedBodySize, decodedBodyBytes: r.decodedBodySize };
          }),
        }));
        const actions: { name: string; startTime: number; endTime: number }[] = [];
        const action = async (name: string, perform: () => Promise<unknown>) => {
          const startTime = await page.evaluate(() => performance.now());
          await perform();
          actions.push({ name, startTime, endTime: await page.evaluate(() => performance.now()) });
        };
        if (values.flow === 'chat-settings') {
          await page.mouse.move(0, 0);
          await page.locator('.chat-btn[aria-expanded="false"]').waitFor({ state: 'attached' });
          await action('open-chat', () => page.keyboard.press('Slash'));
          await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'true');
          await action('type-draft', () => page.locator('.composer textarea').pressSequentially('Performance check', { delay: 30 }));
          await action('clear-draft', async () => {
            await page.locator('.composer textarea').press('ControlOrMeta+A');
            await page.locator('.composer textarea').press('Backspace');
          });
          await action('close-chat', async () => {
            if (await page.locator('.chat-btn').isVisible()) await page.locator('.chat-btn').click();
            else await page.locator('.topbar .mark').click();
          });
          await expect(page.locator('.chat-btn')).toHaveAttribute('aria-expanded', 'false');
          await action('open-settings', () => page.locator('.dock button[aria-haspopup="dialog"]').click());
          await expect(page.locator('dialog.settings')).toBeVisible();
          await action('close-settings', () => page.keyboard.press('Escape'));
          await expect(page.locator('dialog.settings')).not.toBeVisible();
        }
        await settle(page, settleSeconds * 1000);
        if (values.flow !== 'none') await page.waitForFunction(() => window.__falkyPerformance.snapshot().vitals.INP !== null);
        const final = await page.evaluate(() => window.__falkyPerformance.snapshot());
        if (pageErrors) throw new Error(`Page raised ${pageErrors} uncaught errors`);
        if (values.flow !== 'none' && final.vitals.INP === null) throw new Error('Interaction flow completed but INP was not reported');
        results.push({ index, readyMs, loading, actions, ...final,
          unavailable: metricNames.filter((name) => final.vitals[name] === null) });
      } finally {
        await browser.close();
        browser = undefined;
      }
    }
  } finally {
    clearTimeout(timeout);
    try { await browser?.close(); } finally { await app?.close(); }
    cancellation.signal.removeEventListener('abort', closeBrowser);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  cancellation.signal.throwIfAborted();
  const report = { schemaVersion: 1, status: 'complete', startedAt, finishedAt: new Date().toISOString(), revision, sourceDirty,
    environment, workload, measurement: 'web-vitals live updates over a finite lab observation window',
    summary: summarize(results), runs: results, comparison: null as Comparison | null };
  if (baseline) {
    const differences = ['environment', 'workload'].filter((key) => !isDeepStrictEqual(baseline[key as 'environment' | 'workload'], report[key as 'environment' | 'workload']));
    report.comparison = { compatible: !differences.length, differences, baselineRevision: baseline.revision,
      metrics: differences.length ? null : Object.fromEntries(metricNames.map((name) => {
        const before = baseline.summary[name]?.median ?? null, after = report.summary[name].median;
        return [name, { baseline: before, current: after, delta: before === null || after === null ? null : after - before,
          percent: before === null || before === 0 || after === null ? null : (after - before) / before * 100 }];
      })) };
  }
  await mkdir(dirname(output), { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  await writeFile(output, json);
  console.error(`Saved ${output}`);
  console.log(json.trimEnd());
}

type Comparison = { compatible: boolean; differences: string[]; baselineRevision: string | null; metrics: Record<string, unknown> | null };
type Report = { schemaVersion: number; status: string; revision: string | null; environment: unknown; workload: unknown; summary: ReturnType<typeof summarize> };
void main().catch((error: unknown) => {
  // Do not echo a URL's query string, auth state or access link in diagnostics.
  let message = error instanceof Error ? error.message : String(error);
  if (values.url) {
    let label = '[invalid URL]';
    try { label = safeURL(values.url); } catch { /* Retain the original validation error. */ }
    message = message.replaceAll(values.url, label);
  }
  console.error(message);
  process.exitCode ||= 1;
});
