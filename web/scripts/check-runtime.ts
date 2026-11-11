import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, resolveConfig } from 'vite';

const originalMarker = process.env.FALKY_MOCK;
const originalNodeEnv = process.env.NODE_ENV;
const originalRevision = process.env.FALKY_BUILD_REVISION;
const originalRef = process.env.FALKY_BUILD_REF;
const temporary = await mkdtemp(join(tmpdir(), 'falky-runtime-'));
try {
  delete process.env.FALKY_MOCK;
  const revision = 'abcdef0123456789abcdef0123456789abcdef01';
  process.env.FALKY_BUILD_REVISION = revision;
  process.env.FALKY_BUILD_REF = 'refs/heads/master';
  const development = await resolveConfig({}, 'build');
  assert.equal(development.define?.['import.meta.env.VITE_BUILD_VERSION'], JSON.stringify('dev abcdef0'));
  process.env.FALKY_BUILD_REF = 'refs/heads/staging';
  const staging = await resolveConfig({}, 'build');
  assert.equal(staging.define?.['import.meta.env.VITE_BUILD_VERSION'], JSON.stringify('staging abcdef0'));
  process.env.FALKY_BUILD_REF = 'refs/tags/v1.2.3+build.4';
  const production = await resolveConfig({}, 'build');
  assert.equal(production.define?.['import.meta.env.VITE_BUILD_VERSION'], JSON.stringify('v1.2.3+build.4'));
  process.env.FALKY_BUILD_REVISION = '';
  await assert.rejects(resolveConfig({}, 'build'), /build metadata/i);
  process.env.FALKY_BUILD_REVISION = revision;
  process.env.FALKY_BUILD_REF = 'refs/heads/feature';
  await assert.rejects(resolveConfig({}, 'build'), /build metadata/i);
  delete process.env.FALKY_BUILD_REVISION;
  delete process.env.FALKY_BUILD_REF;
  const archive = join(temporary, 'archive');
  await mkdir(archive);
  await copyFile('vite.config.ts', join(archive, 'vite.config.ts'));
  await copyFile('package.json', join(archive, 'package.json'));
  await symlink(resolve('node_modules'), join(archive, 'node_modules'), 'dir');
  const withoutGit = await resolveConfig({ configFile: join(archive, 'vite.config.ts') }, 'serve');
  assert.equal(withoutGit.define?.['import.meta.env.VITE_BUILD_VERSION'], JSON.stringify('dev unknown'));
  const normal = await resolveConfig({}, 'serve');
  assert.match(String(normal.define?.['import.meta.env.VITE_BUILD_VERSION']), /^"dev [a-f0-9]{7}"$/);
  console.log('Build identity: development/staging SHA, exact release tag, missing/invalid metadata rejection, and local archive fallback verified.');
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
  for (const mode of ['production', 'staging', 'mock']) {
    if (mode === 'mock') process.env.FALKY_MOCK = '1';
    process.env.FALKY_BUILD_REVISION = revision;
    process.env.FALKY_BUILD_REF = mode === 'production' ? 'refs/heads/master'
      : mode === 'staging' ? 'refs/heads/staging' : 'refs/tags/v1.2.3+build.4';
    const version = mode === 'production' ? 'dev abcdef0'
      : mode === 'staging' ? 'staging abcdef0' : 'v1.2.3+build.4';
    const modules = new Set<string>();
    const chunks = new Map<string, { imports: string[]; modules: string[] }>();
    let assets = '';
    await build({
      mode: mode === 'staging' ? 'production' : mode,
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
    assert.ok(assets.includes(version), 'The main screen footer must use the source build identity');
    const html = await readFile(join(temporary, mode, 'index.html'), 'utf8');
    assert.ok(!html.includes('build-version'), 'The footer must belong to the main screen rather than the document');
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
    assert.ok(![...modules].some((id) => id.includes('/web-vitals/')), 'Profiling instrumentation must stay outside production bundles');
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
  if (originalRevision === undefined) delete process.env.FALKY_BUILD_REVISION;
  else process.env.FALKY_BUILD_REVISION = originalRevision;
  if (originalRef === undefined) delete process.env.FALKY_BUILD_REF;
  else process.env.FALKY_BUILD_REF = originalRef;
  await rm(temporary, { recursive: true, force: true });
}
