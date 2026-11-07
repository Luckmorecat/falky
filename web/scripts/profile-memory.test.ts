import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cwd = fileURLToPath(new URL('../', import.meta.url));
async function profile(args: string[], environment: NodeJS.ProcessEnv = {}, interrupt?: 'blank' | 'app') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/profile-memory.ts', ...args], {
    cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    // Interrupt during active collection, after both browser and server exist.
    if (interrupt && !signalled && stderr.includes(`${interrupt === 'blank' ? 'Blank tab' : 'App'} ready; sampling`)) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const url = /Mock: (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)?.[1];
    if (url) await assert.rejects(fetch(`${url}/__mock/state`), 'Profiler must close its mock server');
    return { code, stdout, stderr, url };
  } finally { clearTimeout(timeout); }
}

test('selected scenarios produce consistent reports, including entry and synthetic remote video', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-memory-'));
  try {
    for (const scenario of ['populated', 'entry', 'quiet', 'remote-share']) {
      const output = join(directory, 'nested', `${scenario}.json`);
      const result = await profile(['--scenario', scenario, '--duration', '0.15', '--interval', '1', '--warmup', '0',
        '--output', output, ...(scenario === 'populated' ? ['--cycles', '2'] : []),
        ...(scenario === 'remote-share' ? ['--join-voice'] : [])]);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.url);
      assert.ok(result.stdout.includes(output));
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.schemaVersion, 2);
      assert.equal(report.workload.scenario, scenario);
      assert.equal(report.workload.joinVoice, scenario === 'remote-share');
      assert.equal(report.environment.appMode, 'mock-development');
      assert.equal(report.environment.stats, false);
      assert.ok(report.environment.chromium);
      assert.equal(report.blankBaseline.url, 'about:blank');
      assert.equal(report.blankBaseline.chromium, report.environment.chromium);
      assert.ok(report.appUrl.startsWith(result.url));
      assert.ok(report.blankBaseline.finishedAt <= report.appStartedAt);
      const blankBrowser = report.blankBaseline.browserBeforePage.processes.find((entry: { type: string }) => entry.type === 'browser');
      const appBrowser = report.browserBeforePage.processes.find((entry: { type: string }) => entry.type === 'browser');
      assert.ok(blankBrowser && appBrowser);
      assert.notEqual(blankBrowser.pid, appBrowser.pid, 'Control and app must use fresh browsers');
      type Sample = {
        phase: string; cycle: number | null; elapsedMs: number; jsHeapUsedBytes: number;
        jsHeapTotalBytes: number; nodes: number; eventListeners: number;
        browser: { pssBytes: number | null; processes: { pssBytes: number | null }[] };
      };
      const samples: Sample[] = report.samples;
      assert.equal(samples[0]!.phase, 'ready');
      assert.equal(samples.at(-1)!.phase, 'final-after-gc');
      assert.equal(report.summary.sampleCount, samples.length);
      assert.ok(samples.some((sample) => sample.phase === 'idle'), 'Duration shorter than interval still gets an idle sample');
      for (const run of [report, report.blankBaseline]) {
        const idle: Sample[] = run.samples.filter((sample: Sample) => sample.phase === 'idle');
        assert.ok(idle.length >= 1);
        if (idle.length === 1) {
          assert.equal(run.summary.idleMedianHeapBytes, idle[0]!.jsHeapUsedBytes);
          assert.equal(run.summary.idleMedianBrowserPssBytes, idle[0]!.browser.pssBytes);
        }
        assert.equal(run.summary.sampleCount, run.samples.length);
      }
      assert.ok(report.blankBaseline.samples.every((sample: Sample) => !sample.phase.startsWith('settings-')));
      const blankPss = report.blankBaseline.summary.idleMedianBrowserPssBytes;
      const appPss = report.summary.idleMedianBrowserPssBytes;
      assert.equal(report.summary.chromiumOverheadPssBytes, blankPss);
      assert.equal(report.summary.appIncrementalPssBytes,
        blankPss === null || appPss === null ? null : appPss - blankPss);
      assert.ok(result.stdout.includes('App incremental PSS (idle medians):'));
      assert.ok(result.stdout.includes('Chromium overhead (blank-tab median PSS):'));
      assert.equal(samples.filter((sample) => sample.phase === 'settings-open').length, scenario === 'populated' ? 2 : 0);
      const baseline = samples.find((sample) => sample.phase === 'baseline-after-gc')!;
      const final = samples.at(-1)!;
      assert.equal(report.summary.retainedHeapDeltaBytes, final.jsHeapUsedBytes - baseline.jsHeapUsedBytes);
      assert.equal(report.summary.retainedNodesDelta, final.nodes - baseline.nodes);
      assert.equal(report.summary.retainedEventListenersDelta, final.eventListeners - baseline.eventListeners);
      assert.equal(report.summary.sampledPeakHeapBytes, Math.max(...samples.map((sample) => sample.jsHeapUsedBytes)));
      const blankSamples: Sample[] = report.blankBaseline.samples;
      const allSamples = [...blankSamples, ...samples];
      for (const [index, sample] of allSamples.entries()) {
        assert.ok(sample.jsHeapUsedBytes > 0 && sample.jsHeapUsedBytes <= sample.jsHeapTotalBytes);
        if (index && index !== blankSamples.length) {
          assert.ok(sample.elapsedMs >= allSamples[index - 1]!.elapsedMs);
        }
        const available = sample.browser.processes.every((entry) => entry.pssBytes !== null);
        assert.equal(sample.browser.pssBytes !== null, available);
        if (available) assert.equal(sample.browser.pssBytes,
          sample.browser.processes.reduce((sum, entry) => sum + entry.pssBytes!, 0));
      }
      const csv = (await readFile(output.replace(/\.json$/, '.csv'), 'utf8')).trim().split('\n');
      assert.equal(csv.length, blankSamples.length + samples.length + 1);
      assert.ok(csv[0]!.includes('browserPssBytes'));
      assert.ok(csv[0]!.includes('browserPssAboveBlankMedianBytes'));
      for (const [index, sample] of allSamples.entries()) {
        const fields = csv[index + 1]!.split(',');
        const isApp = index >= blankSamples.length;
        assert.equal(fields.length, 14);
        assert.equal(fields[0], isApp ? 'app' : 'blank');
        assert.equal(fields[1], sample.phase);
        assert.equal(Number(fields[4]), sample.jsHeapUsedBytes);
        assert.equal(fields[9], sample.browser.pssBytes === null ? '' : String(sample.browser.pssBytes));
        assert.equal(fields[13], isApp && blankPss !== null && sample.browser.pssBytes !== null
          ? String(sample.browser.pssBytes - blankPss) : '');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid arguments fail before launch; launch failure and interruption clean up', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-memory-errors-'));
  try {
    for (const args of [
      ['--scenario', 'unknown'], ['--duration', 'NaN'], ['--duration', '0'], ['--interval', '0'],
      ['--cycles', '1.5'], ['--warmup', '-1'], ['--output', 'wrong.csv'],
      ['--scenario', 'entry', '--cycles', '1'], ['--scenario', 'entry', '--join-voice'],
    ]) {
      const result = await profile(args);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.url, undefined);
    }
    const output = join(directory, 'missing.json');
    const failed = await profile(['--output', output], { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nonexistent/falky-browser' });
    assert.equal(failed.code, 1);
    assert.ok(failed.url);
    const directoryOutput = join(directory, 'directory.json');
    await mkdir(directoryOutput);
    const failedWrite = await profile(['--duration', '0.1', '--warmup', '0', '--output', directoryOutput]);
    assert.equal(failedWrite.code, 1, failedWrite.stderr);
    assert.ok(failedWrite.url);
    for (const stage of ['blank', 'app'] as const) {
      const interrupted = await profile(['--duration', '2', '--warmup', '0', '--output', output], {}, stage);
      assert.equal(interrupted.code, 143, interrupted.stderr);
      assert.ok(interrupted.url);
      await assert.rejects(readFile(output), 'An interrupted profile must not write a successful report');
    }
    const help = await profile(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.url, undefined);
    assert.ok(help.stdout.includes('--scenario'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
