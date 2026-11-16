import { playwright } from '@vitest/browser-playwright';
import { PixelgateReporter, pixelgateScreenshots } from 'pixelgate-cli/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['card.browser.ts'],
    reporters: ['default', new PixelgateReporter()],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      expect: { toMatchScreenshot: pixelgateScreenshots() },
    },
  },
});
