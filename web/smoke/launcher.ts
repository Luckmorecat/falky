import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Exercise the same Node-only launcher an agent runs; both ports are allocated. */
export async function launchMock(port = 0, options: { signal?: AbortSignal; stats?: boolean } = {}) {
  options.signal?.throwIfAborted();
  const child = spawn(process.execPath, ['--import', 'tsx', 'mock/dev.ts', '--port', String(port)], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, VITE_DEV_STATS: String(options.stats ?? true) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => {
      options.signal?.removeEventListener('abort', abort);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timeout); }
    })();
  }
  function abort() { void close(); }
  options.signal?.addEventListener('abort', abort, { once: true });
  let output = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(output || 'Mock launch timed out')), 20_000);
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
    options.signal?.throwIfAborted();
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
