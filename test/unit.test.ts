import assert from 'node:assert/strict';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, it } from 'vitest';
import { compareImages } from '../src/compare.js';
import { parseViewport, resolveConfig } from '../src/config.js';
import { resolveUrl, safeName } from '../src/names.js';
import { summarize } from '../src/report.js';
import { storiesFromIndex } from '../src/storybook.js';
import { pixelgateScreenshots, snapshotName } from '../src/vitest.js';

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}
const white = () => [255, 255, 255] as [number, number, number];

describe('compareImages', () => {
  it('identical images have zero diff', () => {
    const r = compareImages(png(10, 10, white), png(10, 10, white), { threshold: 0.1 });
    assert.equal(r.diffPixels, 0);
    assert.equal(r.sizeChanged, false);
  });
  it('counts changed pixels', () => {
    const b = png(10, 10, (x, y) => (x < 2 && y < 5 ? [255, 0, 0] : [255, 255, 255]));
    const r = compareImages(png(10, 10, white), b, { threshold: 0.1 });
    assert.equal(r.diffPixels, 10);
    assert.equal(r.diffRatio, 0.1);
  });
  it('size change is always a diff', () => {
    const r = compareImages(png(10, 10, white), png(10, 12, white), { threshold: 0.1 });
    assert.equal(r.sizeChanged, true);
    assert.ok(r.diffPixels > 0);
    assert.equal(r.height, 12);
  });
});

describe('config', () => {
  it('parses viewport', () => {
    assert.deepEqual(parseViewport('1280x720'), { width: 1280, height: 720 });
    assert.throws(() => parseViewport('big'));
  });
  it('applies defaults', () => {
    const c = resolveConfig({ pages: [{ name: 'home', url: 'http://x/' }] }, '/repo');
    assert.equal(c.targets.length, 1);
    assert.equal(c.targets[0]!.browser, 'chromium');
    assert.deepEqual(c.failOn, ['changed', 'error']);
  });
  it('rejects duplicates and empty sources', () => {
    assert.throws(() => resolveConfig({ pages: [{ name: 'a', url: 'u' }, { name: 'a', url: 'u' }] }, '/'));
    assert.throws(() => resolveConfig({}, '/'));
    assert.throws(() => resolveConfig({ pages: [{ name: 'a', url: 'u' }], targets: { x: { browser: 'ie' as never } } }, '/'));
  });
});

describe('storybook', () => {
  const index = {
    entries: {
      'button--primary': { id: 'button--primary', type: 'story' },
      'button--docs': { id: 'button--docs', type: 'docs' },
      'card--default': { id: 'card--default', type: 'story' },
    },
  };
  it('maps stories to iframe urls, skipping docs', () => {
    const pages = storiesFromIndex(index, { url: 'http://sb:6006/' });
    assert.deepEqual(pages.map((p) => p.name), ['button--primary', 'card--default']);
    assert.equal(pages[0]!.url, 'http://sb:6006/iframe.html?id=button--primary&viewMode=story');
    assert.equal(pages[0]!.selector, '#storybook-root');
  });
  it('filters by include/exclude globs', () => {
    assert.deepEqual(storiesFromIndex(index, { url: 'u', include: ['button--*'] }).map((p) => p.name), ['button--primary']);
    assert.deepEqual(storiesFromIndex(index, { url: 'u', exclude: ['button--*'] }).map((p) => p.name), ['card--default']);
  });
});

describe('vitest path mapping', () => {
  const root = path.resolve('/proj');
  const data = { root, ext: '.png', browserName: 'chromium', testFileDirectory: 'src/ui', testFileName: 'Button.test.tsx' };
  const p = pixelgateScreenshots();
  const out = (...s: string[]) => path.join(root, '.pixelgate', ...s);
  it('names snapshots by test file + arg', () => {
    assert.equal(snapshotName(data, 'primary'), 'src/ui/Button.test.tsx/primary');
    assert.equal(snapshotName({ testFileDirectory: '.', testFileName: 'a.test.ts' }, 'x'), 'a.test.ts/x');
  });
  it('maps reference/actual/diff into the pixelgate layout', () => {
    const f = 'src_ui_Button.test.tsx_primary.png';
    assert.equal(p.resolveScreenshotPath({ ...data, arg: 'primary' }), out('baseline', 'chromium', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-actual' }), out('current', 'chromium', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-reference' }), out('current', 'chromium', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-diff' }), out('diff', 'chromium', f));
  });
});

describe('misc', () => {
  it('safeName is filesystem safe', () => {
    assert.equal(safeName('Header / dark mode?'), 'Header_dark_mode');
  });
  it('resolveUrl keeps absolute URLs and the base path', () => {
    assert.equal(resolveUrl('file:///x.html', undefined), 'file:///x.html');
    assert.equal(resolveUrl('/settings', 'http://h:5173/app/'), 'http://h:5173/app/settings');
    assert.equal(resolveUrl('/', 'http://h:5173/app'), 'http://h:5173/app/');
    assert.throws(() => resolveUrl('/x', undefined), /relative/);
  });
  it('summarize honours failOn', () => {
    const rs = [{ target: 't', name: 'a', status: 'added' as const }];
    assert.equal(summarize(rs, ['changed', 'error']).failed, false);
    assert.equal(summarize(rs, ['added']).failed, true);
  });
});
