import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { metricNames } from './performance-metrics';

const cwd = fileURLToPath(new URL('../', import.meta.url));
async function profile(args: string[], env: NodeJS.ProcessEnv = {}, interrupt = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/profile-performance.ts', ...args], {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', signalled = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (interrupt && !signalled && stderr.includes('ready; collecting loading metrics')) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const url = /Mock: (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)?.[1];
    if (url) await assert.rejects(fetch(`${url}/__mock/state`, { signal: AbortSignal.timeout(2000) }), 'Owned mock must stop');
    return { code, stdout, stderr, url };
  } finally { clearTimeout(timeout); }
}

test('measures actual mobile interactions, aggregates fresh runs and compares compatible reports', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-performance-'));
  const options = ['--scenario', 'quiet', '--viewport', '390x844', '--cpu-rate', '2', '--network', 'fast4g', '--settle', '.1'];
  try {
    const output = join(directory, 'nested', 'baseline.json');
    const result = await profile([...options, '--runs', '2', '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.url);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(JSON.parse(result.stdout), report, 'stdout is the same machine-readable report');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, 'complete');
    assert.equal(report.workload.target, 'mock-development');
    assert.equal(report.workload.scenario, 'quiet');
    assert.equal(report.environment.cpuRate, 2);
    assert.equal(report.environment.network.name, 'fast4g');
    assert.ok(report.environment.chromium);
    assert.ok(report.environment.webVitals);
    assert.equal(report.runs.length, 2);
    for (const run of report.runs) {
      assert.deepEqual(run.actions.map((a: { name: string }) => a.name), ['open-chat', 'type-draft', 'clear-draft', 'close-chat', 'open-settings', 'close-settings']);
      assert.ok(run.readyMs > 0);
      assert.ok(run.loading.navigation.loadEventMs > 0);
      assert.ok(run.loading.resources.length > 0);
      assert.ok(run.vitals.INP.entries.some((e: { interactionId: number }) => e.interactionId > 0), 'INP must come from browser interaction entries');
      for (const name of metricNames) {
        assert.ok(Number.isFinite(run.vitals[name].value), `${name} must be measured`);
        assert.ok(run.vitals[name].value >= 0);
      }
    }
    for (const name of metricNames) {
      assert.equal(report.summary[name].measuredRuns, 2);
      assert.equal(report.summary[name].median, (report.runs[0].vitals[name].value + report.runs[1].vitals[name].value) / 2);
      assert.equal(report.summary[name].unit, name === 'CLS' ? 'score' : 'ms');
    }
    const nextPath = join(directory, 'next.json');
    const next = await profile([...options, '--runs', '1', '--compare', output, '--output', nextPath]);
    assert.equal(next.code, 0, next.stderr);
    const compared = JSON.parse(next.stdout);
    assert.equal(compared.comparison.compatible, true);
    for (const name of metricNames) assert.equal(compared.comparison.metrics[name].delta,
      compared.summary[name].median - report.summary[name].median);
    report.environment.cpuRate = 4;
    await writeFile(output, JSON.stringify(report));
    const mismatch = await profile([...options, '--runs', '1', '--compare', output, '--output', nextPath]);
    assert.equal(mismatch.code, 0, mismatch.stderr);
    assert.equal(JSON.parse(mismatch.stdout).comparison.compatible, false);
    assert.deepEqual(JSON.parse(mismatch.stdout).comparison.differences, ['environment']);
    assert.equal(JSON.parse(mismatch.stdout).comparison.metrics, null, 'Do not compare incompatible measurements');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('entry load without inputs keeps INP unavailable and supports JSON stdout', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-performance-entry-'));
  try {
    const result = await profile(['--scenario', 'entry', '--flow', 'none', '--runs', '1', '--settle', '.1', '--output', join(directory, 'entry.json')]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runs[0].vitals.INP, null);
    assert.deepEqual(report.runs[0].actions, []);
    assert.ok(report.runs[0].unavailable.includes('INP'));
    assert.equal(report.summary.INP.median, null);
    assert.equal(report.summary.INP.measuredRuns, 0);
    assert.equal(report.summary.INP.unavailableRuns, 1);
    assert.ok(report.summary.FCP.median > 0);
    assert.ok(report.summary.LCP.median > 0);
    assert.ok(report.summary.CLS.median >= 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profiles an existing URL without starting a mock or saving query secrets', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-performance-url-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Profile target</title><h1>Loading measurement</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await profile(['--url', `${origin}/?example=do-not-save-this`, '--flow', 'none', '--runs', '1', '--settle', '.1', '--output', join(directory, 'url.json')]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.url, undefined);
    const report = JSON.parse(result.stdout);
    assert.equal(report.workload.url, origin + '/');
    assert.equal(report.workload.scenario, null);
    assert.equal(report.workload.target, 'existing-url');
    assert.ok(report.workload.targetFingerprint);
    assert.ok(!result.stdout.includes('do-not-save-this'));
    assert.ok(report.summary.TTFB.median >= 0);
    assert.ok(report.summary.FCP.median > 0);
    assert.equal(report.summary.CLS.median, 0, 'No shifts must be reported as zero, not missing');
    assert.equal(report.summary.INP.median, null);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('validates options and cleans up after launch failure and interruption', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-performance-errors-'));
  const output = join(directory, 'must-not-exist.json');
  try {
    for (const args of [['--runs', '0'], ['--runs', '1.5'], ['--viewport', '0x844'], ['--cpu-rate', 'NaN'],
      ['--network', 'constructor'], ['--url', 'invalid'], ['--scenario', 'entry'], ['--storage-state', 'unused.json']]) {
      const result = await profile([...args, '--output', output]);
      assert.notEqual(result.code, 0);
      assert.equal(result.url, undefined, 'Invalid options must fail before launching resources');
      assert.equal(result.stdout, '');
    }
    const missing = await profile(['--runs', '1', '--output', output], { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: join(directory, 'missing-browser') });
    assert.notEqual(missing.code, 0);
    assert.ok(missing.url, 'Failure must happen after mock startup to exercise cleanup');
    const interrupted = await profile(['--runs', '1', '--settle', '10', '--output', output], {}, true);
    assert.equal(interrupted.code, 143, interrupted.stderr);
    assert.ok(interrupted.url);
    assert.equal(interrupted.stdout, '');
    await assert.rejects(readFile(output), 'Failed/incomplete profiles must not publish a complete report');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
