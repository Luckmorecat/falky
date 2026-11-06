import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { startMockServer } from './server.ts';
import { scenarios } from './protocol.ts';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '0' },
  'api-port': { type: 'string', default: '0' },
  scenario: { type: 'string', default: 'populated' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log(`Usage: pnpm run dev:mock [--port 0] [--api-port 0] [--scenario ${scenarios.join('|')}]\nPorts default to allocated loopback ports. Select a scenario in the URL with ?scenario=entry.`);
  process.exit(0);
}
function port(value: string) {
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Port must be 0–65535');
  return Number(value);
}
// Read only by dev-time adapter selection; production must ignore this marker.
process.env.FALKY_MOCK = '1';
const mock = await startMockServer({ port: port(values['api-port']), scenario: values.scenario });
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let closing: Promise<void> | undefined;
function close() {
  return closing ??= (async () => { await vite?.close(); await mock.close(); })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void close().then(() => process.exit(0)); });
}
try {
  vite = await createServer({
    mode: 'mock',
    server: {
      host: '127.0.0.1', port: port(values.port), strictPort: true,
      proxy: {
        '/api': { target: mock.url, ws: true },
        '/__mock': { target: mock.url },
        // A mis-selected real media adapter must fail locally, never reach LiveKit.
        '/rtc': { target: mock.url, ws: true },
      },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  mock.setPublicOrigin(origin);
  console.log(`\nMock app: ${origin}/?scenario=${values.scenario}#k=mock-access-link`);
  console.log(`Mock controls: ${origin}/__mock\nScenario: ${values.scenario} | memory only | no Go or LiveKit\n`);
} catch (error) {
  await close();
  throw error;
}
