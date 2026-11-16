import { defineConfig } from '@playwright/test';
import type { PixelgateOptions } from 'pixelgate/playwright';

// Uses `pixelgate/playwright` from the built dist, as a consumer would.
export default defineConfig<{ pixelgateOptions: PixelgateOptions }>({
  testDir: '.',
  testMatch: 'card.spec.ts',
  outputDir: './test-results',
  // A consumer writes 'pixelgate/playwright-reporter'; Playwright resolves reporters from its own
  // location, where this repo's package self-reference does not apply.
  reporter: [['list'], ['../../../dist/playwright-reporter.js']],
  use: { pixelgateOptions: { ariaSnapshot: true } },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 400, height: 300 } } }],
});
