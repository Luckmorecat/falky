import { defineConfig } from '@playwright/test';
import { chromiumOptions } from './smoke/browser';

export default defineConfig({
  testDir: './smoke',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    launchOptions: chromiumOptions(),
    trace: 'retain-on-failure',
  },
});
