import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development Vite stands where Caddy stands in production: it serves the
// client and forwards the API and LiveKit's signalling, so the page, the API
// and voice share one origin.
export default defineConfig(({ command }) => ({
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
}));
