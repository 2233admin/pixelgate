import assert from 'node:assert/strict';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, it } from 'vitest';
import { stableShot } from '../src/capture.js';
import { compareImages, passes } from '../src/compare.js';
import { isCI, parseViewport, resolveConfig } from '../src/config.js';
import { resolveUrl, safeName } from '../src/names.js';
import { determineOutcome, type OutcomeInput } from '../src/outcome.js';
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
const WHITE = png(10, 10, white);
const RED_CORNER = png(10, 10, (x, y) => (x < 2 && y < 5 ? [255, 0, 0] : [255, 255, 255]));
const BLUE_CORNER = png(10, 10, (x, y) => (x < 2 && y < 5 ? [0, 0, 255] : [255, 255, 255]));

describe('compareImages', () => {
  it('identical images have zero diff', () => {
    const r = compareImages(WHITE, png(10, 10, white), { threshold: 0.1 });
    assert.equal(r.diffPixels, 0);
    assert.equal(r.sizeChanged, false);
  });
  it('counts changed pixels', () => {
    const r = compareImages(WHITE, RED_CORNER, { threshold: 0.1 });
    assert.equal(r.diffPixels, 10);
    assert.equal(r.diffRatio, 0.1);
  });
  it('size change is always a diff and never passes', () => {
    const r = compareImages(WHITE, png(10, 12, white), { threshold: 0.1 });
    assert.equal(r.sizeChanged, true);
    assert.ok(r.diffPixels > 0);
    assert.equal(r.height, 12);
    assert.equal(passes(r, 1), false);
  });
  it('passes honours maxDiffPixelRatio', () => {
    const r = compareImages(WHITE, RED_CORNER, { threshold: 0.1 });
    assert.equal(passes(r, 0), false);
    assert.equal(passes(r, 0.1), true);
  });
});

describe('stableShot (Vitest-style stability loop)', () => {
  const opts = { threshold: 0.1, maxDiffPixelRatio: 0, timeoutMs: 1_000 };
  const seq = (...frames: Buffer[]) => {
    let i = 0;
    const take = async () => frames[Math.min(i++, frames.length - 1)]!;
    return { take, calls: () => i };
  };

  it('first capture matching the reference costs one screenshot', async () => {
    const s = seq(WHITE);
    const r = await stableShot(s.take, png(10, 10, white), opts);
    assert.deepEqual([r.stable, r.matchedReference, r.retries, s.calls()], [true, true, 0, 1]);
  });
  it('without a reference, two consecutive equal captures are stable', async () => {
    const s = seq(WHITE, WHITE);
    const r = await stableShot(s.take, null, opts);
    assert.deepEqual([r.stable, r.matchedReference, r.retries, s.calls()], [true, false, 0, 2]);
  });
  it('waits out flicker, returns the settled frame', async () => {
    const s = seq(RED_CORNER, BLUE_CORNER, WHITE, WHITE);
    const r = await stableShot(s.take, null, opts);
    assert.equal(r.stable, true);
    assert.equal(r.retries, 2);
    assert.ok(r.buffer.equals(WHITE));
  });
  it('a page that never settles is unstable after the timeout', async () => {
    let i = 0;
    const take = async () => {
      await new Promise((res) => setTimeout(res, 5));
      return i++ % 2 ? RED_CORNER : BLUE_CORNER;
    };
    const r = await stableShot(take, null, { ...opts, timeoutMs: 100 });
    assert.equal(r.stable, false);
    assert.ok(r.retries > 3);
  });
  it('timeoutMs 0 takes a single screenshot', async () => {
    const s = seq(RED_CORNER, WHITE);
    const r = await stableShot(s.take, WHITE, { ...opts, timeoutMs: 0 });
    assert.deepEqual([r.stable, r.matchedReference, s.calls()], [true, false, 1]);
  });
});

describe('determineOutcome', () => {
  const shot = (buffer: Buffer, extra: Partial<{ stable: boolean; matchedReference: boolean }> = {}) => ({
    buffer, stable: true, matchedReference: false, retries: 0, ...extra,
  });
  const base: OutcomeInput = {
    reference: WHITE,
    update: 'new',
    maxDiffPixelRatio: 0,
    compare: (a, b) => compareImages(a, b, { threshold: 0.1 }),
  };
  const type = (i: Partial<OutcomeInput>) => determineOutcome({ ...base, ...i }).type;

  it('capture error wins', () => assert.equal(type({ error: 'boom', shot: shot(WHITE) }), 'capture-error'));
  it('unstable before anything else', () =>
    assert.equal(type({ reference: null, shot: shot(WHITE, { stable: false }) }), 'unstable'));
  it('missing reference: baseline in new/all, current in none', () => {
    for (const [update, location] of [['new', 'baseline'], ['all', 'baseline'], ['none', 'current']] as const) {
      const o = determineOutcome({ ...base, reference: null, update, shot: shot(WHITE) });
      assert.equal(o.type, 'missing-reference');
      assert.equal(o.type === 'missing-reference' && o.location, location, update);
    }
  });
  it('matched immediately skips comparison', () => {
    let called = false;
    const o = determineOutcome({ ...base, shot: shot(WHITE, { matchedReference: true }), compare: () => ((called = true), null!) });
    assert.equal(o.type, 'matched-immediately');
    assert.equal(called, false);
  });
  it('within tolerance passes after comparison', () =>
    assert.equal(type({ shot: shot(RED_CORNER), maxDiffPixelRatio: 0.1 }), 'matched-after-comparison'));
  it('mismatch, or update-reference in mode all', () => {
    assert.equal(type({ shot: shot(RED_CORNER) }), 'mismatch');
    assert.equal(type({ shot: shot(RED_CORNER), update: 'none' }), 'mismatch');
    assert.equal(type({ shot: shot(RED_CORNER), update: 'all' }), 'update-reference');
  });
});

describe('config', () => {
  const page = { pages: [{ name: 'home', url: 'http://x/' }] };
  it('parses viewport', () => {
    assert.deepEqual(parseViewport('1280x720'), { width: 1280, height: 720 });
    assert.throws(() => parseViewport('big'));
  });
  it('applies defaults', () => {
    const c = resolveConfig(page, '/repo', { update: 'new' });
    assert.equal(c.targets.length, 1);
    assert.equal(c.targets[0]!.browser, 'chromium');
    assert.deepEqual(c.failOn, ['changed', 'error']);
    assert.equal(c.stabilize.stableTimeoutMs, 5_000);
  });
  it('CI mode fails on added by default', () => {
    assert.deepEqual(resolveConfig(page, '/', { update: 'none' }).failOn, ['changed', 'error', 'added']);
    assert.deepEqual(resolveConfig({ ...page, failOn: ['error'] }, '/', { update: 'none' }).failOn, ['error']);
  });
  it('detects CI like std-env', () => {
    assert.equal(isCI({ CI: 'true' }), true);
    assert.equal(isCI({ CI: '1' }), true);
    assert.equal(isCI({ CI: 'false' }), false);
    assert.equal(isCI({ CI: '' }), false);
    assert.equal(isCI({ GITHUB_ACTIONS: 'true' }), true);
    assert.equal(isCI({}), false);
  });
  it('baselines are per platform unless disabled', () => {
    assert.equal(resolveConfig(page, '/').targets[0]!.dir, `chromium-${process.platform}`);
    assert.equal(resolveConfig({ ...page, platformSpecific: false }, '/').targets[0]!.dir, 'chromium');
  });
  it('rejects bad input', () => {
    assert.throws(() => resolveConfig({ pages: [{ name: 'a', url: 'u' }, { name: 'a', url: 'u' }] }, '/'));
    assert.throws(() => resolveConfig({}, '/'));
    assert.throws(() => resolveConfig({ ...page, targets: { x: { browser: 'ie' as never } } }, '/'));
    assert.throws(() => resolveConfig({ ...page, update: 'sometimes' as never }, '/'));
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
  const data = {
    root, ext: '.png', browserName: 'chromium', platform: 'linux',
    testFileDirectory: 'src/ui', testFileName: 'Button.test.tsx',
  };
  const out = (...s: string[]) => path.join(root, '.pixelgate', ...s);
  const f = 'src_ui_Button.test.tsx_primary.png';
  it('names snapshots by test file + arg', () => {
    assert.equal(snapshotName(data, 'primary'), 'src/ui/Button.test.tsx/primary');
    assert.equal(snapshotName({ testFileDirectory: '.', testFileName: 'a.test.ts' }, 'x'), 'a.test.ts/x');
  });
  it('maps reference/actual/diff into per-platform pixelgate dirs', () => {
    const p = pixelgateScreenshots();
    assert.equal(p.resolveScreenshotPath({ ...data, arg: 'primary' }), out('baseline', 'chromium-linux', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-actual' }), out('current', 'chromium-linux', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-reference' }), out('current', 'chromium-linux', f));
    assert.equal(p.resolveDiffPath({ ...data, arg: 'primary-diff' }), out('diff', 'chromium-linux', f));
  });
  it('platformSpecific: false drops the platform segment', () => {
    const p = pixelgateScreenshots({ platformSpecific: false });
    assert.equal(p.resolveScreenshotPath({ ...data, arg: 'primary' }), out('baseline', 'chromium', f));
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
