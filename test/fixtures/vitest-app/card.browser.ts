import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import theme from './theme.json';

test('card', async () => {
  document.body.innerHTML = `
    <div data-testid="card" style="width:200px;padding:16px;background:${theme.color};color:#fff;font:16px sans-serif">
      Hello
    </div>`;
  await expect(page.getByTestId('card')).toMatchScreenshot('card');
});
