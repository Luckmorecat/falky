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
    const chunks = new Map<string, { imports: string[]; modules: string[] }>();
    let assets = '';
    await build({
      mode,
      build: { outDir: join(temporary, mode), emptyOutDir: true },
      plugins: [{
        name: 'verify-production-boundary',
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            const ids = Object.keys(output.modules).map((id) => id.replaceAll('\\', '/'));
            for (const id of ids) modules.add(id);
            chunks.set(output.fileName, { imports: output.imports, modules: ids });
            assets += output.code;
          }
        },
      }],
    });
    const initial = new Set<string>();
    function visit(name: string): void {
      if (initial.has(name)) return;
      initial.add(name);
      for (const dependency of chunks.get(name)?.imports ?? []) visit(dependency);
    }
    const render = [...chunks].find(([, chunk]) => chunk.modules.some((id) => id.endsWith('/src/app/render.tsx')));
    assert.ok(render, 'The app renderer must be emitted');
    visit(render[0]);
    const initialModules = [...initial].flatMap((name) => chunks.get(name)!.modules);
    assert.ok(initialModules.some((id) => id.endsWith('/src/ui/Chat.tsx')), 'Chat stays in the initial interface');
    assert.ok([...modules].some((id) => id.endsWith('/src/ui/Settings.tsx')), 'Settings must be emitted');
    assert.ok([...modules].some((id) => id.includes('/livekit-client/')), 'LiveKit must be emitted');
    assert.ok(!initialModules.some((id) => id.endsWith('/src/ui/Settings.tsx')), 'Settings must load on demand');
    assert.ok(!initialModules.some((id) => id.includes('/livekit-client/')), 'LiveKit must load in the background');
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
