import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, expect, type Browser, type CDPSession } from '@playwright/test';
import { scenarios, type MockState } from '../mock/protocol';
import { chromiumOptions } from '../smoke/browser';
import { launchMock } from '../smoke/launcher';
import { setLanguage, t } from '../src/strings';

const { values } = parseArgs({ options: {
  scenario: { type: 'string', default: 'populated' },
  duration: { type: 'string', default: '15' },
  interval: { type: 'string', default: '1' },
  warmup: { type: 'string', default: '3' },
  cycles: { type: 'string', default: '0' },
  output: { type: 'string' },
  'join-voice': { type: 'boolean', default: false },
  gpu: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });

// SystemInfo is queried on the browser session, so unrelated Chromium instances,
// Playwright's driver and the Vite/mock server are outside this process set.
async function processMemory(session: CDPSession) {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const processes = await Promise.all(processInfo.map(async ({ id, type }: { id: number; type: string }) => {
    let rssBytes: number | null = null;
    let pssBytes: number | null = null;
    let unavailable: string | null = null;
    try {
      if (process.platform !== 'linux') throw new Error('Linux /proc is required');
      const rollup = await readFile(`/proc/${id}/smaps_rollup`, 'utf8');
      const rss = /^Rss:\s+(\d+) kB$/m.exec(rollup);
      const pss = /^Pss:\s+(\d+) kB$/m.exec(rollup);
      if (!rss || !pss) throw new Error('Missing Rss/Pss in smaps_rollup');
      rssBytes = Number(rss[1]) * 1024;
      pssBytes = Number(pss[1]) * 1024;
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
    return { pid: id, type, rssBytes, pssBytes, unavailable };
  }));
  const complete = processes.length > 0 && processes.every((entry) => entry.pssBytes !== null);
  return {
    // Never present a partial process sum as the browser's total memory.
    pssBytes: complete ? processes.reduce((sum, entry) => sum + entry.pssBytes!, 0) : null,
    rssBytes: complete ? processes.reduce((sum, entry) => sum + entry.rssBytes!, 0) : null,
    measuredProcesses: processes.filter((entry) => entry.pssBytes !== null).length,
    processes,
  };
}

function numberOption(name: 'duration' | 'interval' | 'warmup' | 'cycles', minimum: number, maximum: number) {
  const value = Number(values[name]);
  if (!values[name].trim() || !Number.isFinite(value) || value < minimum || value > maximum ||
    (name === 'cycles' && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${name === 'cycles' ? 'an integer' : 'a number'} between ${minimum} and ${maximum}`);
  }
  return value;
}

async function main() {
  if (values.help) {
    console.log(`Usage: pnpm run profile:memory [options]
  --scenario ${scenarios.join('|')} (default: populated)
  --duration SECONDS     Idle sampling duration, 0.1–3600 (default: 15)
  --interval SECONDS     Sampling interval, 0.05–60 (default: 1)
  --warmup SECONDS       Settle after UI readiness, 0–300 (default: 3)
  --cycles COUNT         Settings open/close cycles after idle, 0–1000 (default: 0)
  --join-voice           Join simulated voice; remote-share waits for video
  --gpu                  Request hardware-capable headless Chromium
  --output PATH.json     JSON and sibling CSV (default: profiles/memory-<timestamp>.json)

Each run measures a blank tab, closes Chromium, then measures the mock app in
a second fresh browser. --warmup and --duration apply to each browser. The
headline app footprint is app idle median PSS minus blank idle median PSS.
English, dark theme, 1440x1000 viewport, UTC, reduced motion, stats disabled.
Entry cannot use --cycles or --join-voice. Other scenarios start outside voice
unless --join-voice is specified. Measurements cover the mock development app,
not production or real media transport. PSS/RSS require readable Linux /proc;
unavailable process totals are null. RSS sums double-count shared pages.
JS heap/DOM cover the main page target, not separate workers/frames. Browser
process totals include browser overhead; GPU device memory is not measured.
Incremental PSS estimates added RAM, including browser work caused by the app;
shared pages and run variance prevent exact ownership. Negative deltas are kept.
Post-GC deltas are diagnostic, not a leak verdict or pass/fail memory budget.
Install once if missing: pnpm exec playwright install chromium
Existing browser: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium`);
    return;
  }
  if (!scenarios.includes(values.scenario as typeof scenarios[number])) throw new Error(`Unknown scenario: ${values.scenario}`);
  const duration = numberOption('duration', 0.1, 3600);
  const interval = numberOption('interval', 0.05, 60);
  const warmup = numberOption('warmup', 0, 300);
  const cycles = numberOption('cycles', 0, 1000);
  if (values.scenario === 'entry' && (cycles || values['join-voice'])) throw new Error('Entry cannot use --cycles or --join-voice');
  const startedAt = new Date().toISOString();
  const output = resolve(values.output ?? `profiles/memory-${startedAt.replace(/[:.]/g, '-')}.json`);
  if (!output.endsWith('.json')) throw new Error('Output must have a .json extension');
  const csvOutput = output.slice(0, -5) + '.csv';
  await mkdir(dirname(output), { recursive: true });
  setLanguage('en');

  const cancellation = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; cancellation.abort(new Error('Memory profile interrupted')); };
  const onTerminate = () => { process.exitCode = 143; cancellation.abort(new Error('Memory profile terminated')); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const timeout = setTimeout(() => cancellation.abort(new Error('Memory profile timed out')),
    (2 * (warmup + duration) + cycles * 35 + 120) * 1000);
  let app: Awaited<ReturnType<typeof launchMock>> | undefined;
  let browser: Browser | undefined;
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  cancellation.signal.addEventListener('abort', closeBrowser);
  const pause = (ms: number) => delay(ms, undefined, { signal: cancellation.signal });
  try {
    app = await launchMock(0, { signal: cancellation.signal, stats: false });
    const mockUrl = app.url;
    console.error(`Mock: ${app.url} | scenario: ${values.scenario} | voice: ${values['join-voice']} | cycles: ${cycles}`);
    async function measureBrowser(kind: 'blank' | 'app') {
      cancellation.signal.throwIfAborted();
      const runStartedAt = new Date().toISOString();
      try {
        browser = await chromium.launch({ ...chromiumOptions(values.gpu), headless: true,
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
        cancellation.signal.throwIfAborted();
        const browserSession = await browser.newBrowserCDPSession();
        const browserBeforePage = await processMemory(browserSession);
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
          locale: 'en', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(15_000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        if (kind === 'app') {
          const response = await page.request.post(`${mockUrl}/__mock/bootstrap`, { data: { scenario: values.scenario } });
          if (!response.ok()) throw new Error(`Mock bootstrap failed: ${response.status()}`);
          const state: MockState = await response.json();
          await page.addInitScript((state) => {
            localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
            const prefix = `falky.mock.${state.instanceId}.`;
            localStorage.setItem(prefix + 'lang', 'en');
            localStorage.setItem(prefix + 'theme', 'dark');
          }, state);
          await page.goto(`${mockUrl}/?scenario=${values.scenario}`);
          if (values.scenario === 'entry') {
            await expect(page.getByRole('textbox', { name: t.name, exact: true })).toBeVisible();
          } else {
            await expect(page.getByRole('button', { name: t.settings, exact: true })).toBeVisible();
            await page.locator('.feed .msg, .feed .empty-chat').first().waitFor({ state: 'attached' });
            if (values['join-voice']) {
              await page.getByRole('button', { name: t.join, exact: true }).click();
              await expect(page.getByRole('toolbar')).toBeVisible();
              if (values.scenario === 'remote-share') {
                await page.locator('.share video').waitFor({ state: 'visible' });
                await page.waitForFunction(() => [...document.querySelectorAll('video')]
                  .some((video) => video.readyState >= 2 && video.videoWidth > 0));
              }
            }
          }
        } else {
          // Exercise Playwright's locator world in both runs, including the blank control.
          await page.goto('about:blank');
          await page.locator('html').waitFor({ state: 'attached' });
        }
        await page.evaluate(() => document.fonts.ready);
        const session = await context.newCDPSession(page);
        const sampleOrigin = performance.now();
        async function sample(phase: string, cycle: number | null = null) {
          cancellation.signal.throwIfAborted();
          const elapsedMs = performance.now() - sampleOrigin;
          const heap = await session.send('Runtime.getHeapUsage');
          const dom = await session.send('Memory.getDOMCounters');
          return { phase, cycle, elapsedMs, jsHeapUsedBytes: heap.usedSize, jsHeapTotalBytes: heap.totalSize,
            documents: dom.documents, nodes: dom.nodes, eventListeners: dom.jsEventListeners,
            browser: await processMemory(browserSession) };
        }
        const samples = [await sample('ready')];
        await pause(warmup * 1000);
        await session.send('HeapProfiler.collectGarbage');
        const baseline = await sample('baseline-after-gc');
        samples.push(baseline);
        console.error(`${kind === 'blank' ? 'Blank tab' : 'App'} ready; sampling idle for ${duration}s every ${interval}s, after ${warmup}s warmup`);
        const idleStart = performance.now();
        // Use actual elapsed time, including collection overhead. Always sample the
        // end, including when duration is shorter than the requested interval.
        while (performance.now() - idleStart < duration * 1000) {
          await pause(Math.min(interval * 1000, Math.max(0, duration * 1000 - (performance.now() - idleStart))));
          samples.push(await sample('idle'));
        }
        for (let cycle = 1; cycle <= (kind === 'app' ? cycles : 0); cycle++) {
          await page.getByRole('button', { name: t.settings, exact: true }).click();
          await expect(page.getByRole('dialog', { name: t.settings, exact: true })).toBeVisible();
          samples.push(await sample('settings-open', cycle));
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog', { name: t.settings, exact: true })).toBeHidden();
          samples.push(await sample('settings-closed', cycle));
        }
        // Let deferred cleanup and transitions finish before the retained comparison.
        await pause(500);
        samples.push(await sample('final-before-gc'));
        await session.send('HeapProfiler.collectGarbage');
        const retained = await sample('final-after-gc');
        samples.push(retained);
        const url = page.url();
        await context.close();
        const browserAfterPage = await processMemory(browserSession);
        if (pageErrors.length) throw new Error(`Page errors during profile: ${pageErrors.join('; ')}`);
        const idle = samples.filter((entry) => entry.phase === 'idle');
        function median(numbers: number[]) {
          const sorted = numbers.toSorted((a, b) => a - b);
          const middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
        }
        const completePss = samples.flatMap((entry) => entry.browser.pssBytes === null ? [] : [entry.browser.pssBytes]);
        const summary = {
          sampleCount: samples.length,
          idleMedianHeapBytes: median(idle.map((entry) => entry.jsHeapUsedBytes)),
          idleMedianBrowserPssBytes: idle.every((entry) => entry.browser.pssBytes !== null)
            ? median(idle.map((entry) => entry.browser.pssBytes!)) : null,
          sampledPeakHeapBytes: Math.max(...samples.map((entry) => entry.jsHeapUsedBytes)),
          sampledPeakBrowserPssBytes: completePss.length ? Math.max(...completePss) : null,
          processMemoryComplete: samples.every((entry) => entry.browser.pssBytes !== null),
          retainedHeapDeltaBytes: retained.jsHeapUsedBytes - baseline.jsHeapUsedBytes,
          retainedNodesDelta: retained.nodes - baseline.nodes,
          retainedEventListenersDelta: retained.eventListeners - baseline.eventListeners,
        };
        return { startedAt: runStartedAt, finishedAt: new Date().toISOString(), chromium: browser.version(), url,
          browserBeforePage, browserAfterPage, summary, samples };
      } finally {
        await browser?.close();
        browser = undefined;
      }
    }
    // Sequential fresh browsers keep app allocations and caches out of the blank
    // control, and avoid changing PSS shares by keeping two browsers alive.
    const blankBaseline = await measureBrowser('blank');
    const appRun = await measureBrowser('app');
    if (blankBaseline.chromium !== appRun.chromium) throw new Error('Chromium version changed between baseline and app');
    const { browserBeforePage, browserAfterPage, samples } = appRun;
    const baseline = samples.find((entry) => entry.phase === 'baseline-after-gc')!;
    const retained = samples.at(-1)!;
    const chromiumOverheadPssBytes = blankBaseline.summary.idleMedianBrowserPssBytes;
    const appSessionPssBytes = appRun.summary.idleMedianBrowserPssBytes;
    const summary = {
      ...appRun.summary,
      chromiumOverheadPssBytes,
      appIncrementalPssBytes: appSessionPssBytes === null || chromiumOverheadPssBytes === null
        ? null : appSessionPssBytes - chromiumOverheadPssBytes,
    };
    const report = {
      schemaVersion: 2, startedAt, finishedAt: new Date().toISOString(),
      appStartedAt: appRun.startedAt,
      environment: { platform: process.platform, architecture: process.arch, node: process.version,
        chromium: appRun.chromium, executable: chromiumOptions(values.gpu).executablePath ?? chromium.executablePath(),
        appMode: 'mock-development', viewport: { width: 1440, height: 1000 },
        language: 'en', theme: 'dark', timezone: 'UTC', reducedMotion: true, stats: false, gpuRequested: values.gpu },
      workload: { scenario: values.scenario, joinVoice: values['join-voice'], durationSeconds: duration,
        intervalSeconds: interval, warmupSeconds: warmup, settingsCycles: cycles },
      appUrl: appRun.url,
      notes: [
        'Mock development app; synthetic media is not evidence of production or real call memory usage.',
        'Heap and DOM counters cover the main page target; separate workers/frames are not aggregated.',
        'Process metrics cover Chromium processes reported by CDP, including browser overhead; exclude Node/Vite/mock.',
        'PSS apportions shared RAM. Summed RSS double-counts shared pages. Neither measures GPU device memory.',
        'Missing/exited/unreadable processes make that sample total null; per-process errors are preserved.',
        'Blank baseline and app use separate sequential fresh browsers with matching warmup and idle duration.',
        'Incremental PSS is app idle median minus blank idle median; it estimates added RAM, not exact ownership.',
        'Shared-page accounting and run variance can produce negative deltas; these are preserved.',
        'Settings cycles run only in the app, after the matched idle comparison.',
        'Peak values are sampled, not guaranteed maxima. GC is forced only at two labeled checkpoints per browser.',
        'Retained deltas include lazy initialization and caches; a positive delta alone does not prove a leak.',
      ],
      blankBaseline, browserBeforePage, browserAfterPage, summary, samples,
    };
    const csv = [
      'workload,phase,cycle,elapsedMs,jsHeapUsedBytes,jsHeapTotalBytes,documents,nodes,eventListeners,browserPssBytes,browserRssBytes,measuredProcesses,reportedProcesses,browserPssAboveBlankMedianBytes',
      ...([{ workload: 'blank', samples: blankBaseline.samples }, { workload: 'app', samples }] as const)
        .flatMap(({ workload, samples }) => samples.map((entry) => [workload, entry.phase, entry.cycle, entry.elapsedMs,
          entry.jsHeapUsedBytes, entry.jsHeapTotalBytes, entry.documents, entry.nodes, entry.eventListeners,
          entry.browser.pssBytes, entry.browser.rssBytes, entry.browser.measuredProcesses, entry.browser.processes.length,
          workload === 'app' && entry.browser.pssBytes !== null && chromiumOverheadPssBytes !== null
            ? entry.browser.pssBytes - chromiumOverheadPssBytes : null].join(','))),
    ].join('\n') + '\n';
    await writeFile(csvOutput, csv);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    const mib = (bytes: number | null) => bytes === null ? 'unavailable' : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
    console.log(`Scenario: ${values.scenario}${values['join-voice'] ? ' (simulated voice)' : ''}`);
    console.log(`App incremental PSS (idle medians): ${mib(summary.appIncrementalPssBytes)}`);
    console.log(`Chromium overhead (blank-tab median PSS): ${mib(summary.chromiumOverheadPssBytes)}`);
    console.log(`App session total (idle median PSS): ${mib(summary.idleMedianBrowserPssBytes)}`);
    console.log(`Idle median JS heap: ${mib(summary.idleMedianHeapBytes)} | sampled peak: ${mib(summary.sampledPeakHeapBytes)}`);
    console.log(`Post-GC JS heap: ${mib(baseline.jsHeapUsedBytes)} → ${mib(retained.jsHeapUsedBytes)} | delta: ${mib(summary.retainedHeapDeltaBytes)}`);
    console.log(`Post-GC DOM delta: ${summary.retainedNodesDelta} nodes, ${summary.retainedEventListenersDelta} listeners`);
    console.log(`Sampled peak browser PSS: ${mib(summary.sampledPeakBrowserPssBytes)} | complete coverage: ${summary.processMemoryComplete}`);
    console.log(`JSON: ${output}\nCSV: ${csvOutput}`);
  } finally {
    clearTimeout(timeout);
    try { await browser?.close(); } finally { await app?.close(); }
    cancellation.signal.removeEventListener('abort', closeBrowser);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  cancellation.signal.throwIfAborted();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ||= 1;
});
