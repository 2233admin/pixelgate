import assert from 'node:assert/strict';
import path from 'node:path';
import { encode as encodePng } from 'fast-png';
import { describe, it } from 'vitest';
import { allowList, isAllowed, maskSelectors, stableShot } from '../src/capture.js';
import {
  compareImages,
  createMatcher,
  jpegCodec,
  pixelmatchComparator,
  pngCodec,
  ssimComparator,
  type ComparatorResult,
  type DecodedImage,
} from '../src/compare.js';
import { devices } from 'playwright';
import { isCI, parseViewport, resolveConfig } from '../src/config.js';
import { resolveUrl, safeName } from '../src/names.js';
import { determineOutcome, type OutcomeInput } from '../src/outcome.js';
import { buildReport, summarize, type Report, type SnapshotResult } from '../src/report.js';
import { commentMarker, renderMarkdown } from '../src/markdown.js';
import { storiesFromIndex } from '../src/storybook.js';
import { esmEntry } from '../src/vite.js';
import { pixelgateScreenshots, snapshotName } from '../src/vitest.js';

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return pngCodec.encode({ width, height, data });
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
    assert.equal(r.pass, false);
  });
});

// Calibration scenes (numbers quoted in ssimComparator's doc comment):
// 64x64 grey gradient with a 20x20 box at (x0, 16).
function scene(x0: number, box: [number, number, number] = [20, 20, 20]): DecodedImage {
  const w = 64, h = 64, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = 120 + x;
      const px = x >= x0 && x < x0 + 20 && y >= 16 && y < 36 ? box : [v, v, v];
      data.set([...px, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}
const mapRgb = (img: DecodedImage, f: (v: number, px: number) => number): DecodedImage => ({
  ...img,
  data: img.data.map((v, i) => (i % 4 === 3 ? v : f(v, i >> 2))),
});
const scattered = (img: DecodedImage, d: number) => mapRgb(img, (v, px) => (px % 37 === 0 ? Math.max(0, v - d) : v));
const brighter = (img: DecodedImage, d: number) => mapRgb(img, (v) => Math.min(255, v + d));
const run = (c: typeof pixelmatchComparator | typeof ssimComparator, a: DecodedImage, b: DecodedImage, o = {}) =>
  c(a, b, { createDiff: true, ...o }) as ComparatorResult;

describe('comparators (Vitest-style { pass, diff, message })', () => {
  it('pixelmatch: maxDiffPixelRatio / maxDiffPixels allowances', () => {
    const a = pngCodec.decode(WHITE), b = pngCodec.decode(RED_CORNER);
    assert.equal(run(pixelmatchComparator, a, b).pass, false);
    assert.match(run(pixelmatchComparator, a, b).message!, /10 pixels \(ratio 0\.1000\) differ/);
    assert.equal(run(pixelmatchComparator, a, b, { maxDiffPixelRatio: 0.1 }).pass, true);
    assert.equal(run(pixelmatchComparator, a, b, { maxDiffPixels: 9 }).pass, false);
    assert.equal(run(pixelmatchComparator, a, b, { maxDiffPixels: 10, maxDiffPixelRatio: 1 }).pass, true);
  });
  it('ssim (default 0.8 per window): noise and brightness shifts pass, real changes fail', () => {
    const base = scene(10);
    assert.equal(run(ssimComparator, base, scene(10)).pass, true);
    assert.equal(run(ssimComparator, base, scattered(base, 20)).pass, true, 'scattered ±20 noise');
    assert.equal(run(ssimComparator, base, brighter(base, 16)).pass, true, '+16 brightness');
    assert.equal(run(ssimComparator, base, scattered(base, 40)).pass, false, 'scattered ±40 noise');
    const shifted = run(ssimComparator, base, scene(11));
    assert.equal(shifted.pass, false, '1px shift');
    assert.match(shifted.message!, /^SSIM below 0\.8 in \d+\.\d+% of the image \(worst window -?0\.\d+/);
    assert.ok(shifted.diffPixels > 0 && shifted.diff!.width === 64);
    assert.equal(run(ssimComparator, base, scene(10), { minSimilarity: 1.01 }).pass, false, 'knob is live');
  });
  it('ssim: a hue change of similar brightness fails (per-channel, not luma-only)', () => {
    const blue = scene(10, [37, 99, 235]);
    const green = scene(10, [22, 163, 74]);
    assert.equal(run(ssimComparator, blue, green).pass, false);
    assert.equal(run(pixelmatchComparator, blue, green).pass, false);
  });
  it('ssim: a small change in a big image does not average away', () => {
    // 1px shift confined to one corner of a 4x larger canvas: the mean stays high, windows don't.
    const big = (x0: number) => {
      const s = scene(x0), w = 256, h = 256, data = new Uint8Array(w * h * 4).fill(255);
      for (let y = 0; y < 64; y++) data.set(s.data.subarray(y * 256, (y + 1) * 256), y * w * 4);
      return { width: w, height: h, data };
    };
    const r = run(ssimComparator, big(10), big(11));
    assert.equal(r.pass, false);
    assert.match(r.message!, /mean 0\.99/);
  });
  it('ssim: size change never passes', () => {
    const big = { ...scene(10), height: 32, data: scene(10).data.slice(0, 64 * 32 * 4) };
    assert.equal(run(ssimComparator, scene(10), big).pass, false);
  });
  it('matcher: byte-identical files skip the comparator', async () => {
    let calls = 0;
    const m = createMatcher({ comparator: (a, b, o) => (calls++, pixelmatchComparator(a, b, o)) });
    assert.equal(await m.same(WHITE, Buffer.from(WHITE)), true);
    assert.equal(calls, 0);
    assert.equal(await m.same(WHITE, RED_CORNER), false);
    assert.equal(calls, 1);
    const c = await m.compare(WHITE, RED_CORNER);
    assert.ok(c.diffPng && pngCodec.decode(c.diffPng).width === 10);
  });
});

describe('codecs', () => {
  it('jpeg round-trips dimensions and roughly the pixels', () => {
    const img = scene(10);
    const back = jpegCodec.decode(jpegCodec.encode(img));
    assert.deepEqual([back.width, back.height], [64, 64]);
    assert.ok(Math.abs(back.data[(20 * 64 + 20) * 4]! - 20) < 12, 'dark box survives');
    assert.equal(jpegCodec.extension, 'jpg');
  });
  it('png decodes every colour type to 8-bit RGBA', () => {
    // 2x1: [black, white] in grey, grey+alpha, RGB, 16-bit RGB and indexed.
    const cases = [
      encodePng({ width: 2, height: 1, channels: 1, depth: 8, data: new Uint8Array([0, 255]) }),
      encodePng({ width: 2, height: 1, channels: 2, depth: 8, data: new Uint8Array([0, 255, 255, 128]) }),
      encodePng({ width: 2, height: 1, channels: 3, depth: 8, data: new Uint8Array([0, 0, 0, 255, 255, 255]) }),
      encodePng({ width: 2, height: 1, channels: 3, depth: 16, data: new Uint16Array([0, 0, 0, 65535, 65535, 65535]) }),
      encodePng({ width: 2, height: 1, channels: 1, depth: 8, data: new Uint8Array([0, 1]), palette: [[0, 0, 0], [255, 255, 255]] }),
    ];
    const expected = [[0, 0, 0, 255, 255, 255, 255, 255], [0, 0, 0, 255, 255, 255, 255, 128]];
    cases.forEach((file, i) => {
      const img = pngCodec.decode(Buffer.from(file));
      assert.deepEqual([img.width, img.height], [2, 1], `case ${i}`);
      assert.deepEqual([...img.data], i === 1 ? expected[1] : expected[0], `case ${i}`);
    });
  });
  it('png round-trips exactly', () => {
    const img = scene(10);
    assert.ok(Buffer.from(pngCodec.decode(pngCodec.encode(img)).data).equals(Buffer.from(img.data)));
  });
});

describe('stableShot (Vitest-style stability loop)', () => {
  const opts = { same: createMatcher({}).same, timeoutMs: 1_000 };
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
  it('spaces captures by intervalMs so a fast shot cannot catch the same frame twice', async () => {
    // A new, distinct frame every 30 ms; a "screenshot" takes 5 ms.
    const frames = new Map<number, Buffer>();
    const frame = (n: number) => frames.get(n) ?? frames.set(n, png(10, 10, () => [(n * 97) % 256, 0, 0])).get(n)!;
    const t0 = Date.now();
    const take = async () => {
      await new Promise((res) => setTimeout(res, 5));
      return frame(Math.floor((Date.now() - t0) / 30));
    };
    const back2back = await stableShot(take, null, { ...opts, timeoutMs: 300, intervalMs: 0 });
    assert.equal(back2back.stable, true, 'without spacing the ticker looks stable');
    const spaced = await stableShot(take, null, { ...opts, timeoutMs: 300, intervalMs: 40 });
    assert.equal(spaced.stable, false);
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
  const base: OutcomeInput = { reference: WHITE, update: 'new', compare: createMatcher({}).compare };
  const type = async (i: Partial<OutcomeInput>) => (await determineOutcome({ ...base, ...i })).type;

  it('capture error wins', async () => assert.equal(await type({ error: 'boom', shot: shot(WHITE) }), 'capture-error'));
  it('unstable before anything else', async () =>
    assert.equal(await type({ reference: null, shot: shot(WHITE, { stable: false }) }), 'unstable'));
  it('missing reference: baseline in new/all, current in none', async () => {
    for (const [update, location] of [['new', 'baseline'], ['all', 'baseline'], ['none', 'current']] as const) {
      const o = await determineOutcome({ ...base, reference: null, update, shot: shot(WHITE) });
      assert.equal(o.type, 'missing-reference');
      assert.equal(o.type === 'missing-reference' && o.location, location, update);
    }
  });
  it('matched immediately skips comparison', async () => {
    let called = false;
    const o = await determineOutcome({ ...base, shot: shot(WHITE, { matchedReference: true }), compare: async () => ((called = true), null!) });
    assert.equal(o.type, 'matched-immediately');
    assert.equal(called, false);
  });
  it("the comparator's pass decides (tolerance lives in the comparator)", async () => {
    const lenient = createMatcher({ options: { maxDiffPixelRatio: 0.1 } }).compare;
    assert.equal(await type({ shot: shot(RED_CORNER), compare: lenient }), 'matched-after-comparison');
  });
  it('mismatch, or update-reference in mode all', async () => {
    assert.equal(await type({ shot: shot(RED_CORNER) }), 'mismatch');
    assert.equal(await type({ shot: shot(RED_CORNER), update: 'none' }), 'mismatch');
    assert.equal(await type({ shot: shot(RED_CORNER), update: 'all' }), 'update-reference');
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
    assert.equal(c.stabilize.stableIntervalMs, 100);
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
  it('comparator and format resolve by name, custom ones register', () => {
    const c = resolveConfig({ ...page, threshold: 0.2 }, '/');
    assert.equal(c.comparator.name, 'pixelmatch');
    assert.deepEqual(c.comparator.options, { threshold: 0.2, maxDiffPixelRatio: 0 });
    assert.equal(c.codec.extension, 'png');
    const s = resolveConfig({ ...page, comparator: { name: 'ssim', options: { minSimilarity: 0.95 } }, format: 'jpeg' }, '/');
    assert.equal(s.comparator.fn, ssimComparator);
    assert.deepEqual(s.comparator.options, { minSimilarity: 0.95 });
    assert.equal(s.codec, jpegCodec);
    const always = () => ({ pass: true, diffPixels: 0, diffRatio: 0, sizeChanged: false, diff: null, message: null });
    assert.equal(resolveConfig({ ...page, comparators: { always }, comparator: 'always' }, '/').comparator.fn, always);
    assert.throws(() => resolveConfig({ ...page, comparator: 'nope' }, '/'), /Available: pixelmatch, ssim/);
    assert.throws(() => resolveConfig({ ...page, format: 'gif' }, '/'), /Available: png, jpeg/);
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
  it('esmEntry picks the ESM file from package exports (Vite 5 ships CJS under `require`)', () => {
    // Vite 5.4 shape: nested conditions, `require` listed first.
    const vite5 = {
      require: { types: './index.d.cts', default: './index.cjs' },
      import: { types: './dist/node/index.d.ts', default: './dist/node/index.js' },
    };
    assert.equal(esmEntry(vite5), './dist/node/index.js');
    // Vite 6+ shape: ESM only.
    assert.equal(esmEntry({ types: './dist/node/index.d.ts', default: './dist/node/index.js' }), './dist/node/index.js');
    assert.equal(esmEntry('./index.js'), './index.js');
    assert.equal(esmEntry(undefined), undefined);
    assert.equal(esmEntry({ require: './index.cjs' }), undefined);
  });
  it('summarize honours failOn', () => {
    const rs = [{ target: 't', name: 'a', status: 'added' as const }];
    assert.equal(summarize(rs, ['changed', 'error']).failed, false);
    assert.equal(summarize(rs, ['added']).failed, true);
  });
});

describe('renderMarkdown (PR comment / job summary)', () => {
  const report = (results: SnapshotResult[], failOn: Report['failOn'] = ['changed', 'error', 'added']): Report =>
    buildReport(results, failOn);
  const failing = () =>
    report([
      { target: 'desktop-linux', name: 'home', status: 'unchanged', baseline: 'baseline/desktop-linux/home.png' },
      {
        target: 'desktop-linux',
        name: 'Card | dark',
        status: 'changed',
        baseline: 'baseline/desktop-linux/Card_dark.png',
        current: 'current/desktop-linux/Card_dark.png',
        diff: 'diff/desktop-linux/Card_dark.png',
        diffRatio: 0.0123,
      },
      { target: 'desktop-linux', name: 'new page', status: 'added', current: 'current/desktop-linux/new_page.png' },
      { target: 'desktop-linux', name: 'broken', status: 'error', error: 'Timeout 30000ms exceeded.\nCall log: ...' },
    ]);

  it('starts with the marker, names the outcome and lists only what needs a look', () => {
    const md = renderMarkdown(failing(), { id: 'pixelgate-linux' });
    const lines = md.split('\n');
    assert.equal(lines[0], '<!-- pixelgate-linux -->');
    assert.equal(lines[1], '### pixelgate: failed');
    assert.match(md, /1 error, 1 changed, 1 added, 1 unchanged \(4 total\)\./);
    assert.match(md, /\| changed \| `Card \\| dark` \| `desktop-linux` \| 1\.23% of pixels \|/);
    assert.match(md, /\| error \| `broken` \| `desktop-linux` \| Timeout 30000ms exceeded\. \|/);
    assert.doesNotMatch(md, /`home`/, 'unchanged snapshots are only counted');
    assert.doesNotMatch(md, /<img/, 'no image base, no images');
  });

  it('with an image base: baseline/current/diff for changed, current for added, URL-encoded', () => {
    const md = renderMarkdown(failing(), { imageBaseUrl: 'https://raw.example/o/r/sha/run 1/' });
    assert.match(md, /<details open><summary>Screenshots<\/summary>/);
    assert.match(md, /\| Baseline \| Current \| Diff \|/);
    assert.ok(md.includes('src="https://raw.example/o/r/sha/run 1/diff/desktop-linux/Card_dark.png"'));
    assert.ok(md.includes('src="https://raw.example/o/r/sha/run 1/current/desktop-linux/new_page.png"'));
    assert.equal(md.match(/<img /g)!.length, 4);
  });

  it('accept command and links only when there is something to accept', () => {
    const cmd = 'gh run download 1 -n pixelgate -D .pixelgate-ci && npx pixelgate approve --from .pixelgate-ci';
    const md = renderMarkdown(failing(), { acceptCommand: cmd, reportUrl: 'https://r', runUrl: 'https://run' });
    assert.ok(md.includes('```sh\n' + cmd + '\n```'));
    assert.ok(md.includes('[Full report](https://r) · [CI run](https://run)'));
    const passed = renderMarkdown(report([{ target: 't', name: 'a', status: 'unchanged' }]), { acceptCommand: cmd });
    assert.match(passed, /### pixelgate: passed\n\n1 unchanged \(1 total\)\.\n$/);
  });

  it('caps long tables', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ target: 't', name: `p${i}`, status: 'added' as const }));
    const md = renderMarkdown(report(many), { maxRows: 5 });
    assert.equal(md.match(/^\| added \|/gm)!.length, 5);
    assert.match(md, /…and 2 more in the full report\./);
  });

  it('marker cannot be closed early by the id', () => {
    assert.equal(commentMarker('a-->b'), '<!-- ab -->');
  });
});

describe('targets: device, emulation, hideBehavior', () => {
  const target = (targets: Parameters<typeof resolveConfig>[0]['targets'], extra = {}) =>
    resolveConfig({ targets, pages: [{ name: 'p', url: 'http://x/' }], ...extra }, '/tmp').targets;

  it('defaults keep existing baselines stable: light, reduced motion, hide, 1280x720', () => {
    const [t] = target({ d: {} });
    assert.equal(t!.colorScheme, 'light');
    assert.equal(t!.reducedMotion, 'reduce');
    assert.equal(t!.hideBehavior, 'hide');
    assert.deepEqual([t!.width, t!.height, t!.deviceScaleFactor, t!.isMobile], [1280, 720, 1, false]);
  });

  it('a device brings its viewport, scale, UA, touch and browser; explicit values win', () => {
    const pixel = devices['Pixel 7']!;
    const [p] = target({ m: { device: 'Pixel 7' } });
    assert.equal(p!.browser, 'chromium');
    assert.deepEqual([p!.width, p!.height], [pixel.viewport.width, pixel.viewport.height]);
    assert.equal(p!.deviceScaleFactor, pixel.deviceScaleFactor);
    assert.equal(p!.userAgent, pixel.userAgent);
    assert.equal(p!.hasTouch, true);
    const [i] = target({ i: { device: 'iPhone 15', viewport: '300x500', deviceScaleFactor: 1 } });
    assert.equal(i!.browser, 'webkit', 'the device picks its own browser');
    assert.deepEqual([i!.width, i!.height, i!.deviceScaleFactor], [300, 500, 1]);
  });

  it('rejects unknown devices and mobile emulation on Firefox at config time', () => {
    assert.throws(() => target({ x: { device: 'Nokia 3310' } }), /unknown device "Nokia 3310"/);
    assert.throws(() => target({ x: { device: 'Pixel 7', browser: 'firefox' } }), /Firefox has no mobile emulation/);
    assert.throws(() => target({ x: { hideBehavior: 'blur' as 'hide' } }), /hideBehavior/);
  });

  it('hideBehavior: global default, target override', () => {
    const ts = target({ a: {}, b: { hideBehavior: 'hide' } }, { hideBehavior: 'ignore' });
    assert.deepEqual(ts.map((t) => t.hideBehavior), ['ignore', 'hide']);
  });
});

describe('mask and allowedHostnames helpers', () => {
  it('maskSelectors: global + snapshot + hidden content when ignored', () => {
    const snap = { name: 'p', url: 'http://x/', mask: ['.ad'] };
    assert.deepEqual(maskSelectors({ mask: ['.clock'] }, snap, { hideBehavior: 'hide' }), ['.clock', '.ad']);
    assert.deepEqual(maskSelectors({ mask: [] }, snap, { hideBehavior: 'ignore' }), ['.ad', '[data-pixelgate-hide]']);
  });

  it('allowList adds the hosts of the snapshot URLs', () => {
    const snaps = [
      { name: 'a', url: 'http://127.0.0.1:5173/app/' },
      { name: 'b', url: 'http://localhost:6006/iframe.html?id=x' },
      { name: 'c', url: 'file:///tmp/a.html' },
    ];
    assert.deepEqual(allowList(['*.cdn.example'], snaps), ['*.cdn.example', '127.0.0.1', 'localhost']);
  });

  it('isAllowed checks http(s)/ws(s) hostnames against globs, lets the rest through', () => {
    const allow = ['127.0.0.1', '*.cdn.example', '::1'];
    assert.equal(isAllowed('http://127.0.0.1:5173/x.js', allow), true);
    assert.equal(isAllowed('https://a.cdn.example/font.woff2', allow), true);
    assert.equal(isAllowed('https://fonts.googleapis.com/css', allow), false);
    assert.equal(isAllowed('wss://evil.example/socket', allow), false);
    assert.equal(isAllowed('http://[::1]:3000/', allow), true);
    assert.equal(isAllowed('data:image/png;base64,AAAA', []), true);
    assert.equal(isAllowed('not a url', []), true);
  });

  it('IPv6 snapshot hosts are allowed the way requests are checked (no brackets)', () => {
    const allow = allowList([], [{ name: 'a', url: 'http://[::1]:5173/' }]);
    assert.deepEqual(allow, ['::1']);
    assert.equal(isAllowed('http://[::1]:5173/assets/app.js', allow), true);
  });

  it('storybook mask reaches every story', () => {
    const [s] = storiesFromIndex({ entries: { a: { id: 'button--primary', type: 'story' } } } as never, {
      url: 'http://sb',
      mask: ['.clock'],
    });
    assert.deepEqual(s!.mask, ['.clock']);
  });
});
