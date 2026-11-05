import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development Vite stands where Caddy stands in production: it serves the
// client and forwards the API and LiveKit's signalling, so the page, the API
// and voice share one origin. See docs/web-client.md.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', ws: true },
      '/rtc': { target: 'http://127.0.0.1:7880', ws: true },
    },
  },
  // LiveKit's SDK is most of the bundle, and the first screen needs it soon anyway.
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'] },
});
