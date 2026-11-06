import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, resolveConfig } from 'vite';

const originalMarker = process.env.FALKY_MOCK;
const originalNodeEnv = process.env.NODE_ENV;
const temporary = await mkdtemp(join(tmpdir(), 'falky-runtime-'));
try {
  delete process.env.FALKY_MOCK;
  const normal = await resolveConfig({}, 'serve');
  assert.deepEqual(normal.server.proxy, {
    '/api': { target: 'http://127.0.0.1:8080', ws: true },
    '/rtc': { target: 'http://127.0.0.1:7880', ws: true },
  });
  for (const [name, suffix] of [['browser', '/src/runtime/browser.ts'], ['voice', '/src/voice/session.ts'], ['bootstrap', '/src/runtime/bootstrap.ts']] as const) {
    assert.ok(normal.resolve.alias.some((alias) => alias.find === `@falky/${name}` && alias.replacement.endsWith(suffix)));
  }
  console.log('Ordinary dev uses real adapters and unchanged Go/LiveKit proxies.');
  // Resolving serve mode sets NODE_ENV; mirror a fresh production build process.
  process.env.NODE_ENV = 'production';
  for (const mode of ['production', 'mock']) {
    if (mode === 'mock') process.env.FALKY_MOCK = '1';
    const modules = new Set<string>();
    let assets = '';
    await build({
      mode,
      build: { outDir: join(temporary, mode), emptyOutDir: true },
      plugins: [{
        name: 'verify-production-boundary',
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            for (const id of Object.keys(output.modules)) modules.add(id.replaceAll('\\', '/'));
            assets += output.code;
          }
        },
      }],
    });
    assert.ok([...modules].some((id) => id.endsWith('/src/voice/session.ts')), 'Real voice must be emitted');
    assert.ok([...modules].some((id) => id.endsWith('/src/runtime/browser.ts')), 'Real browser adapter must be emitted');
    assert.deepEqual([...modules].filter((id) => /\/(?:src\/)?mock\//.test(id)), []);
    assert.doesNotMatch(assets, /__mock|mock-access-link|Simulated microphone|falky\.mock\./);
    console.log(`${mode} build: inspected ${modules.size} emitted modules and JS assets; real adapters present, mock/control code absent.`);
  }
} finally {
  if (originalMarker === undefined) delete process.env.FALKY_MOCK;
  else process.env.FALKY_MOCK = originalMarker;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await rm(temporary, { recursive: true, force: true });
}
