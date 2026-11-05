import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** Exercise the same Node-only launcher an agent runs; both ports are allocated. */
export async function launchMock(port = 0) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'mock/dev.ts', '--port', String(port)], {
    cwd: process.cwd(), env: { ...process.env, VITE_DEV_STATS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(output || 'Mock launch timed out')); }, 20_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Mock app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]!); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Mock exited ${code}: ${output}`)); });
  });
  return { url, async close() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timeout);
  } };
}
