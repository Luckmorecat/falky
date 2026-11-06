import type { LaunchOptions } from '@playwright/test';

/** Share browser installation/overrides with both local browser tools. */
export function chromiumOptions(gpu = false): LaunchOptions {
  return {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    // Full Chromium's new headless mode supports the normal hardware GPU path.
    ...(gpu ? { channel: 'chromium', args: ['--enable-gpu'] } : {}),
  };
}
