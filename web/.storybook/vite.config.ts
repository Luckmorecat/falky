import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The workshop has no application entry or backend proxy.
// Storybook supplies the React plugin; production keeps its own Vite config.
export default defineConfig({
  resolve: { alias: {
    '@falky/browser': fileURLToPath(new URL('../src/runtime/browser.ts', import.meta.url)),
    '@falky/voice': fileURLToPath(new URL('../src/voice/session.ts', import.meta.url)),
  } },
});
