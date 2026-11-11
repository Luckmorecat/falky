import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromiumOptions } from '../smoke/browser';

const cwd = fileURLToPath(new URL('../', import.meta.url));
async function capture(args: string[], environment: NodeJS.ProcessEnv = {}, interrupt = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/screenshot-mock.ts', ...args], {
    cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (interrupt && !signalled && stderr.includes('Mock: ')) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 55_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const url = /Mock: (http:\/\/(?:127\.0\.0\.1|localhost):\d+)/.exec(stderr)?.[1];
    if (url) await assert.rejects(fetch(`${url}/__mock/state`), 'Capture must close its mock server');
    return { code, stdout, stderr, url };
  } finally { clearTimeout(timeout); }
}

test('all presets produce PNGs and terminate their isolated servers', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-screenshots-'));
  try {
    for (const preset of ['room', 'chat', 'unread', 'voice', 'screen-share', 'settings', 'profile', 'entry', 'welcome', 'invitation', 'recovery', 'recovery-kit', 'account']) {
      const output = join(directory, 'nested', `${preset}.png`);
      const result = await capture(['--preset', preset, '--output', output]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), output);
      assert.ok(result.url);
      const png = await readFile(output);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), 1440);
      assert.equal(png.readUInt32BE(20), 1000);
    }
    const output = join(directory, 'mobile.png');
    const mobile = await capture(['--scenario', 'quiet', '--preset', 'chat', '--viewport', '390x844', '--theme', 'light', '--lang', 'uk', '--full-page', '--output', output]);
    assert.equal(mobile.code, 0, mobile.stderr);
    const png = await readFile(output);
    assert.equal(png.readUInt32BE(16), 390);
    assert.equal(png.readUInt32BE(20), 844);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failure after browser launch and interruption still close the mock; invalid arguments never launch it', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-capture-errors-'));
  try {
    const output = join(directory, 'directory.png');
    await mkdir(output);
    const failedWrite = await capture(['--output', output]);
    assert.equal(failedWrite.code, 1, failedWrite.stderr);
    assert.ok(failedWrite.url);
    assert.equal(failedWrite.stdout, '');
    const failedLaunch = await capture(['--output', join(directory, 'missing.png')], { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nonexistent/falky-browser' });
    assert.equal(failedLaunch.code, 1);
    assert.ok(failedLaunch.url);
    const interrupted = await capture(['--output', join(directory, 'interrupted.png')], {}, true);
    assert.equal(interrupted.code, 143, interrupted.stderr);
    assert.ok(interrupted.url);
    const invalid = await capture(['--preset', 'voice', '--scenario', 'entry']);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.url, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GPU opt-in requests hardware-capable headless Chromium while retaining executable override', () => {
  const defaults = chromiumOptions();
  const gpu = chromiumOptions(true);
  assert.equal(gpu.executablePath, defaults.executablePath);
  assert.equal(defaults.args, undefined);
  assert.equal(gpu.channel, 'chromium');
  assert.deepEqual(gpu.args, ['--enable-gpu']);
});

test('device presets use production flows at narrow Ukrainian light and dark sizes', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'falky-device-captures-'));
  try {
    for (const [preset, width, theme] of [['device-qr', 320, 'light'], ['device-code', 390, 'dark'], ['device-issuer', 390, 'light'], ['device-scanner', 320, 'dark']] as const) {
      const output = join(directory, `${preset}.png`);
      const result = await capture(['--preset', preset, '--viewport', `${width}x844`, '--theme', theme, '--lang', 'uk', '--output', output]);
      assert.equal(result.code, 0, result.stderr);
      const png = await readFile(output);
      assert.equal(png.readUInt32BE(16), width);
      assert.equal(png.readUInt32BE(20), 844);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
