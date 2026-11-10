import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

// One process owns both listeners; the ordinary Vite config remains the real backend path.
test('Node launcher prints a loopback URL, proxies fixture API, serves design and closes both listeners', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'mock/dev.ts', '--port', '0', '--scenario', 'entry'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  let origin = '';
  try {
    origin = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Mock app: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]!);
      });
      child.once('exit', (code) => reject(new Error(`Launcher exited ${code}: ${output}`)));
      child.once('error', reject);
    });
    const bootstrap = await fetch(origin + '/__mock/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const state = await bootstrap.json();
    assert.equal(state.scenario, 'entry');
    assert.equal(state.visitor, null);
    assert.deepEqual(state.credentials, { accessPassword: 'falky-mock', login: 'alex', password: 'mock-password', recoveryCode: 'mock-recovery-code' });
    assert.equal((await fetch(origin + '/design.html')).status, 200);
    assert.equal((await fetch(origin + '/rtc')).status, 404);
    assert.equal((await fetch(origin + '/api/me')).status, 401);
    const passed = await fetch(origin + '/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'falky-mock' }) });
    assert.equal(passed.status, 200);
    const access = passed.headers.get('set-cookie')!.split(';')[0]!;
    const entered = await fetch(origin + '/api/accounts/register', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: access }, body: JSON.stringify({ login: 'node', password: 'password1', name: 'Node Only' }) });
    assert.equal(entered.status, 200);
    const cookie = entered.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(origin + '/api/rooms', { headers: { cookie } })).status, 200);
  } finally {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    if (child.exitCode === null) await exit;
  }
  await assert.rejects(fetch(origin + '/__mock/state'));
});
