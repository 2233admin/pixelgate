import { expect, test } from 'pixelgate/playwright';

// The e2e test changes the card's colour (CARD_COLOR) and label (CARD_LABEL) between runs.
const color = process.env.CARD_COLOR ?? '#2563eb';
const label = process.env.CARD_LABEL ?? 'Save';

test('card', async ({ page, pixelgate }) => {
  // The hidden timestamp sits in a block of its own: hidden text that overflows a fixed-height
  // box (as it once did inside the card) left a 1px glyph remnant on Linux Chromium.
  await page.setContent(`<!doctype html><html lang="en"><body style="margin:0">
<div id="card" style="margin:20px;width:160px;padding:12px;background:${color}"><button>${label}</button></div>
<div data-pixelgate-hide style="margin:20px;font:16px monospace">${Date.now()}</div>
<script>console.error('card-console')</script></body></html>`);
  const r = await pixelgate.screenshot('card', { locator: page.locator('#card') });
  expect(['unchanged', 'added', 'changed', 'updated']).toContain(r.status);
  await pixelgate.screenshot('page');
});
