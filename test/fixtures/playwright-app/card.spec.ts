import { expect, test } from 'pixelgate/playwright';

// The e2e test changes the card's colour (CARD_COLOR) and label (CARD_LABEL) between runs.
const color = process.env.CARD_COLOR ?? '#2563eb';
const label = process.env.CARD_LABEL ?? 'Save';

test('card', async ({ page, pixelgate }) => {
  await page.setContent(`<!doctype html><html lang="en"><body style="margin:0">
<div id="card" style="margin:20px;width:160px;height:60px;background:${color}">
  <button style="margin:12px">${label}</button><span data-pixelgate-hide>${Date.now()}</span>
</div></body></html>`);
  const r = await pixelgate.screenshot('card', { locator: page.locator('#card') });
  expect(['unchanged', 'added', 'changed', 'updated']).toContain(r.status);
  await pixelgate.screenshot('page');
});
