import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

function buildVersion(): string {
  const revision = process.env.FALKY_BUILD_REVISION;
  const ref = process.env.FALKY_BUILD_REF;
  // CI supplies the actual source, since the Docker context has no Git metadata.
  // Never replace a malformed deployment identity with a plausible local label.
  if (revision !== undefined || ref !== undefined) {
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)
      || !ref || !/^(refs\/heads\/master|refs\/tags\/v[0-9][A-Za-z0-9.+-]*)$/.test(ref)) {
      throw new Error('Invalid Falky build metadata: provide a full revision and master or a v* tag ref.');
    }
    return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : `dev ${revision.slice(0, 7)}`;
  }
  // Snapshot local HEAD at server start/build time; source archives can lack Git.
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return `dev ${head.slice(0, 7)}`;
  } catch {
    return 'dev unknown';
  }
}

// In development Vite stands where Caddy stands in production: it serves the
// client and forwards the API and LiveKit's signalling, so the page, the API
// and voice share one origin.
export default defineConfig(({ command }) => {
  const version = buildVersion();
  return {
    define: { 'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(version) },
    // Mode names and build-time env never opt a production bundle into mocks.
    resolve: { alias: Object.fromEntries(Object.entries({
      browser: command === 'serve' && process.env.FALKY_MOCK === '1' ? 'mock/browser.ts' : 'runtime/browser.ts',
      voice: command === 'serve' && process.env.FALKY_MOCK === '1' ? 'mock/voice.ts' : 'voice/session.ts',
      bootstrap: command === 'serve' && process.env.FALKY_MOCK === '1' ? 'mock/bootstrap.ts' : 'runtime/bootstrap.ts',
    }).map(([name, path]) => [`@falky/${name}`, fileURLToPath(new URL(`./src/${path}`, import.meta.url))])) },
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:8080', ws: true },
        '/rtc': { target: 'http://127.0.0.1:7880', ws: true },
      },
    },
    // The deferred LiveKit SDK remains a single large chunk.
    build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
    test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
  };
});
