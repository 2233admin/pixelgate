import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { elementBox, forcePseudoClasses } from '../src/capture.js';
import { pngCodec } from '../src/compare.js';
import { resolveConfig, type Config, type ResolvedConfig, type UpdateMode } from '../src/config.js';
import { approve } from '../src/report.js';
import { run } from '../src/run.js';

// The page under test; tests mutate it to simulate a code change.
let buttonColor = '#2563eb';
let showBanner = true;
const home = () => `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
  button { background: ${buttonColor}; color: #fff; border: 0; padding: 12px 20px; transition: background 2s; }
  .spin { width: 20px; height: 20px; background: red; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div id="app"><h1>Hello</h1><button>Save</button><div class="spin"></div>
  <input autofocus value="caret"></div>
  ${showBanner ? '<div id="banner">banner</div>' : ''}
</body></html>`;
// JS-driven change that CSS freezing cannot stop: never settles.
const ticker = `<!doctype html><body style="margin:0;font:40px monospace"><div id="t"></div>
<script>setInterval(() => { document.getElementById('t').textContent = performance.now().toFixed(0); }, 30);</script></body>`;
// Flickers for ~1.5 s after load, then holds still.
const settle = `<!doctype html><body style="margin:0;font:40px monospace"><div id="t">start</div>
<script>let n = 0; const id = setInterval(() => { document.getElementById('t').textContent = n++ < 15 ? 'tick ' + n : 'done';
  if (n > 15) clearInterval(id); }, 100);</script></body>`;
// A panel that only appears after a click.
const menu = `<!doctype html><body style="margin:0;font:20px sans-serif">
<button id="toggle" onclick="document.getElementById('panel').hidden = false">Open</button>
<div id="panel" hidden style="width:200px;height:100px;background:#16a34a;color:#fff">Panel</div></body>`;

// Content that changes on every request, with and without the hide attribute.
let counter = 0;
const dynamic = (attr: string) => `<!doctype html><body style="margin:0;font:40px monospace">
<div style="width:120px;height:40px;background:#2563eb"></div><div id="c" ${attr}>${counter++}</div></body>`;
const dark = `<!doctype html><style>body{margin:0;background:#fff}
@media (prefers-color-scheme: dark){body{background:#000}}</style><body></body>`;
// A stylesheet from another hostname (localhost) than the page's (127.0.0.1).
const external = () => `<!doctype html><link rel="stylesheet" href="http://localhost:${port}/ext.css">
<body style="margin:0"><div class="x" style="width:100px;height:100px"></div></body>`;
let lastHeaders: Record<string, string | string[] | undefined> = {};
// ARIA page: the label only changes the accessibility tree, never the pixels; the hidden
// and masked parts change on every request.
let ariaLabel = 'Close';
let ariaTick = 0;
const ariaPage = () => `<!doctype html><html lang="en"><body style="margin:0;font:16px sans-serif">
<h1 style="font-size:20px;margin:0">Title</h1><button aria-label="${ariaLabel}">x</button>
<p>Now <span data-pixelgate-hide>tick ${ariaTick++}</span></p><div class="ad">ad ${ariaTick}</div>
<div id="card"><h2 style="font-size:16px;margin:0">Card</h2><p>body</p></div></body></html>`;

let server: Server;
let origin: string;
let port: number;
let tmp: string;
const platform = process.platform;

const cfgWith = (extra: Partial<Config> = {}, update: UpdateMode = 'new'): ResolvedConfig =>
  resolveConfig(
    {
      outDir: '.pixelgate',
      targets: { desktop: { viewport: '800x600' }, mobile: { viewport: '375x667' } },
      pages: [
        { name: 'home', url: `${origin}/` },
        { name: 'app', url: `${origin}/`, selector: '#app' },
      ],
      ...extra,
    },
    tmp,
    { update },
  );
const file = (...p: string[]) => path.join(tmp, '.pixelgate', ...p);

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === '/ext.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end('.x { background: #ff0000; }');
    const routes: Record<string, () => string> = {
      '/ticker': () => ticker,
      '/settle': () => settle,
      '/menu': () => menu,
      '/dynamic': () => dynamic('data-pixelgate-hide'),
      '/dynamic-plain': () => dynamic(''),
      '/dark': () => dark,
      '/aria': ariaPage,
      '/tall': () => `<!doctype html><body style="margin:0"><div style="height:1000px;background:linear-gradient(#f00,#00f)"></div></body>`,
      '/shadow': () => `<!doctype html><body style="margin:0;background:#fff">
<div id="card" style="margin:40px;width:100px;height:40px;background:#eee;box-shadow:0 4px 12px 2px rgba(0,0,0,.5)"></div></body>`,
      '/pseudo': () => `<!doctype html><html><head><link rel="stylesheet" href="http://localhost:${port}/ext.css"><style>
@media (min-width: 1px) { button:hover { background: rgb(255, 0, 0); } }
button { background: rgb(0, 0, 255); border: 0; width: 60px; height: 30px; margin: 0; display: block; }
</style></head><body style="margin:0;padding-top:50px"><button data-pixelgate-hover>a</button><button>b</button></body></html>`,
      '/a11y': () => `<!doctype html><html lang="en"><body style="margin:0">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><div id="ok"><button>Ok</button></div></body></html>`,
      '/cards': () => `<!doctype html><html lang="en"><body style="margin:0">
<div class="card"><button>Ok</button></div>
<div class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"></div></body></html>`,
      '/wide': () => `<!doctype html><body style="margin:0"><div style="width:900px;height:10px;background:#000"></div></body>`,
      '/boom': () => `<!doctype html><body style="margin:0"><script>throw new Error('boom')</script></body>`,
      '/external': external,
      '/ws': () => `<!doctype html><body style="margin:0">
<script>window.sock = new WebSocket('ws://localhost:${port}/sock');</script></body>`,
    };
    res.writeHead(200, { 'content-type': 'text/html' }).end((routes[req.url ?? ''] ?? home)());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  tmp = await mkdtemp(path.join(process.env.PIXELGATE_TEST_TMP ?? os.tmpdir(), 'pixelgate-e2e-'));
});

afterAll(async () => {
  server?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('run (mode new) -> change -> approve', () => {
  it('first run writes missing baselines per platform and passes', async () => {
    const r = await run(cfgWith());
    assert.equal(r.summary.added, 4, JSON.stringify(r.results, null, 2));
    assert.equal(r.failed, false);
    assert.equal(r.results[0]!.target.endsWith(`-${platform}`), true);
    assert.ok(existsSync(file('baseline', `desktop-${platform}`, 'home.png')));
    assert.ok(!existsSync(file('current')), 'mode new writes straight to baseline');
    assert.ok(existsSync(file('report', 'index.html')));
  });

  it('re-render of unchanged UI is stable despite animation/caret', async () => {
    const r = await run(cfgWith());
    assert.equal(r.summary.unchanged, 4, JSON.stringify(r.results, null, 2));
    assert.equal(r.failed, false);
  });

  it('a style change fails the gate and writes current + diff', async () => {
    buttonColor = '#dc2626';
    const r = await run(cfgWith());
    assert.equal(r.summary.changed, 4);
    assert.equal(r.failed, true);
    const app = r.results.find((x) => x.name === 'app' && x.target === `desktop-${platform}`)!;
    assert.ok(app.diff && existsSync(path.join(tmp, '.pixelgate', app.diff)));
    assert.ok(app.current && existsSync(path.join(tmp, '.pixelgate', app.current)));
    assert.ok(app.diffRatio! > 0 && app.diffRatio! < 0.2);
    const json = JSON.parse(await readFile(file('report', 'report.json'), 'utf8'));
    assert.equal(json.failed, true);
  });

  it('approve promotes, then the gate passes', async () => {
    assert.equal((await approve(cfgWith())).length, 4);
    assert.equal((await run(cfgWith())).summary.unchanged, 4);
  });

  it('layout change outside the selector only affects full-page snapshots', async () => {
    showBanner = false;
    const r = await run(cfgWith());
    const changed = r.results.filter((x) => x.status === 'changed').map((x) => x.target.split('-')[0] + '/' + x.name).sort();
    assert.deepEqual(changed, ['desktop/home', 'mobile/home']);
  });

  it('--only runs a subset without reporting the rest as removed', async () => {
    const r = await run(cfgWith(), { only: ['app'] });
    assert.equal(r.summary.total, 2);
    assert.equal(r.summary.removed, 0);
  });
});

describe('update modes', () => {
  it('mode all (-u) overwrites mismatching baselines and passes', async () => {
    const r = await run(cfgWith({}, 'all'));
    assert.equal(r.summary.updated, 2, JSON.stringify(r.results, null, 2));
    assert.equal(r.failed, false);
    assert.equal((await run(cfgWith())).summary.unchanged, 4);
  });

  it('mode none (CI): a snapshot without baseline fails and is not written to baseline', async () => {
    const cfg = cfgWith({ pages: [{ name: 'fresh', url: `${origin}/` }], targets: { desktop: { viewport: '800x600' } } }, 'none');
    assert.deepEqual(cfg.failOn, ['changed', 'error', 'added']);
    const r = await run(cfg);
    assert.equal(r.summary.added, 1);
    assert.equal(r.failed, true);
    assert.ok(existsSync(file('current', `desktop-${platform}`, 'fresh.png')));
    assert.ok(!existsSync(file('baseline', `desktop-${platform}`, 'fresh.png')));
  });
});

describe('approve --from (accept CI screenshots on another machine)', () => {
  const ci = (dir: string) =>
    cfgWith({ outDir: dir, targets: { desktop: { viewport: '800x600' } }, pages: [{ name: 'card', url: `${origin}/`, selector: '#app' }] }, 'none');

  it('copies new screenshots of a CI run into the local baseline, then that baseline passes', async () => {
    const first = await run(ci('.pixelgate-ci'));
    assert.equal(first.summary.added, 1, JSON.stringify(first.results));
    assert.equal(first.failed, true, 'mode none: a missing baseline fails');

    const local = path.join(tmp, '.pixelgate-local');
    const done = await approve({ outDir: local }, { from: path.join(tmp, '.pixelgate-ci') });
    assert.deepEqual(done.map((r) => r.status), ['added']);
    assert.ok(existsSync(path.join(local, 'baseline', `desktop-${platform}`, 'card.png')));
    const ciReport = JSON.parse(await readFile(path.join(tmp, '.pixelgate-ci', 'report', 'report.json'), 'utf8'));
    assert.equal(ciReport.summary.added, 1, 'the downloaded report is left as it was');

    assert.equal((await run(ci('.pixelgate-local'))).summary.unchanged, 1);
  });

  it('refuses report paths that point outside the out dirs', async () => {
    const evil = path.join(tmp, '.pixelgate-evil');
    await mkdir(path.join(evil, 'report'), { recursive: true });
    const result = { target: 'desktop', name: 'x', status: 'added', current: '../../outside.png' };
    await writeFile(path.join(evil, 'report', 'report.json'), JSON.stringify({ results: [result], failOn: [] }));
    await assert.rejects(approve({ outDir: path.join(tmp, '.pixelgate-x') }, { from: evil }), /escapes/);
    const target = { ...result, current: 'current/x.png', target: '../../up' };
    await writeFile(path.join(evil, 'report', 'report.json'), JSON.stringify({ results: [target], failOn: [] }));
    await mkdir(path.join(evil, 'current'), { recursive: true });
    await writeFile(path.join(evil, 'current', 'x.png'), 'png');
    await assert.rejects(approve({ outDir: path.join(tmp, '.pixelgate-x') }, { from: evil }), /escapes/);
  });
});

describe('pluggable comparator + codec', () => {
  const cfg = () =>
    cfgWith({
      outDir: '.pixelgate-jpeg',
      format: 'jpeg',
      comparator: 'ssim',
      targets: { desktop: { viewport: '800x600' } },
      pages: [{ name: 'app', url: `${origin}/`, selector: '#app' }],
    });
  const jfile = (...p: string[]) => path.join(tmp, '.pixelgate-jpeg', ...p);

  it('jpeg baselines, ssim comparison, approve keeps the format', async () => {
    buttonColor = '#2563eb';
    const first = await run(cfg());
    assert.equal(first.summary.added, 1, JSON.stringify(first.results));
    assert.ok(existsSync(jfile('baseline', `desktop-${platform}`, 'app.jpg')));

    assert.equal((await run(cfg())).summary.unchanged, 1, 'jpeg re-capture is stable');

    buttonColor = '#16a34a';
    const changed = await run(cfg());
    const r = changed.results[0]!;
    assert.equal(r.status, 'changed', JSON.stringify(r));
    assert.match(r.message!, /^SSIM below 0\.8 in/);
    assert.equal(r.current, `current/desktop-${platform}/app.jpg`);
    assert.equal(r.diff, `diff/desktop-${platform}/app.png`);

    await approve(cfg());
    assert.equal((await run(cfg())).summary.unchanged, 1);
  });
});

describe('beforeCapture', () => {
  it('drives the page into the state to capture', async () => {
    const cfg = cfgWith({
      outDir: '.pixelgate-menu',
      targets: { desktop: { viewport: '400x200' } },
      pages: [
        { name: 'closed', url: `${origin}/menu` },
        { name: 'open', url: `${origin}/menu`, beforeCapture: (page) => page.click('#toggle') },
      ],
    });
    const r = await run(cfg);
    assert.equal(r.summary.added, 2, JSON.stringify(r.results));
    const dir = path.join(tmp, '.pixelgate-menu', 'baseline', `desktop-${platform}`);
    const [closed, open] = await Promise.all([readFile(path.join(dir, 'closed.png')), readFile(path.join(dir, 'open.png'))]);
    assert.ok(!closed.equals(open), 'the click changed what was captured');
    assert.equal((await run(cfg)).summary.unchanged, 2, 'and does so reproducibly');
  });

  it('a failing beforeCapture is a capture error, not a crash', async () => {
    const r = await run(
      cfgWith({
        outDir: '.pixelgate-menu-err',
        targets: { desktop: { viewport: '400x200' } },
        timeoutMs: 2_000,
        pages: [{ name: 'missing', url: `${origin}/menu`, beforeCapture: (page) => page.click('#nope', { timeout: 500 }) }],
      }),
    );
    assert.equal(r.results[0]!.status, 'error');
    assert.match(r.results[0]!.error!, /#nope|Timeout/);
  });
});

describe('determinism: hide, ignore, mask, allowedHostnames', () => {
  const one = (outDir: string, pages: Config['pages'], extra: Partial<Config> = {}) =>
    cfgWith({ outDir, targets: { desktop: { viewport: '400x200' } }, pages, ...extra });
  const twice = async (cfg: () => ResolvedConfig) => {
    const first = await run(cfg());
    assert.equal(first.summary.added, 1, JSON.stringify(first.results));
    return run(cfg());
  };
  const pixels = async (outDir: string, name: string) =>
    pngCodec.decode(await readFile(path.join(tmp, outDir, 'baseline', `desktop-${platform}`, `${name}.png`)));
  const rgbAt = (img: { data: Uint8Array; width: number }, x: number, y: number) =>
    Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

  it('control: content that changes per request makes a diff', async () => {
    const r = await twice(() => one('.pg-plain', [{ name: 'p', url: `${origin}/dynamic-plain` }]));
    assert.equal(r.summary.changed, 1, JSON.stringify(r.results));
  });

  it('data-pixelgate-hide (default `hide`): the changing content makes no diff', async () => {
    const r = await twice(() => one('.pg-hide', [{ name: 'p', url: `${origin}/dynamic` }]));
    assert.equal(r.summary.unchanged, 1, JSON.stringify(r.results));
  });

  it('hideBehavior `ignore`: painted over with maskColor, no diff', async () => {
    const cfg = () => one('.pg-ignore', [{ name: 'p', url: `${origin}/dynamic` }], { hideBehavior: 'ignore', maskColor: '#00ff00' });
    assert.equal((await twice(cfg)).summary.unchanged, 1);
    const img = await pixels('.pg-ignore', 'p');
    let green = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0 && img.data[i + 1] === 255 && img.data[i + 2] === 0) green++;
    assert.ok(green > 100, `masked box drawn (${green} green pixels)`);
  });

  it('page-level `mask` covers content without the attribute', async () => {
    const r = await twice(() => one('.pg-mask', [{ name: 'p', url: `${origin}/dynamic-plain`, mask: ['#c'] }]));
    assert.equal(r.summary.unchanged, 1, JSON.stringify(r.results));
  });

  it('allowedHostnames blocks other hosts and reports them; the snapshot host stays allowed', async () => {
    await run(one('.pg-open', [{ name: 'p', url: `${origin}/external` }]));
    assert.deepEqual(rgbAt(await pixels('.pg-open', 'p'), 50, 50), [255, 0, 0], 'control: the localhost stylesheet loads');

    const r = await run(one('.pg-blocked', [{ name: 'p', url: `${origin}/external` }], { allowedHostnames: [] }));
    assert.deepEqual(r.results[0]!.blocked, ['localhost']);
    assert.notDeepEqual(rgbAt(await pixels('.pg-blocked', 'p'), 50, 50), [255, 0, 0], 'stylesheet blocked');
  });

  it('allowedHostnames also blocks WebSockets (they bypass request routing)', async () => {
    const r = await run(one('.pg-ws', [{ name: 'p', url: `${origin}/ws` }], { allowedHostnames: [] }));
    assert.deepEqual(r.results[0]!.blocked, ['localhost'], JSON.stringify(r.results));
  });
});

describe('checks without a baseline: a11y, overflow, page errors', () => {
  const at = (outDir: string, url: string, extra: Partial<Config> = {}, page: Partial<NonNullable<Config['pages']>[number]> = {}) =>
    cfgWith({ outDir, targets: { desktop: { viewport: '400x200' } }, pages: [{ name: 'p', url: `${origin}${url}`, ...page }], ...extra });

  it('a11y: axe-core finds the image without alt; scoped to a clean selector it finds nothing', async () => {
    const page = await run(at('.pg-a11y', '/a11y', { checks: { a11y: true } }));
    const ids = page.results[0]!.a11y?.map((v) => v.id) ?? [];
    assert.ok(ids.includes('image-alt'), JSON.stringify(page.results[0]));
    assert.equal(page.summary.a11y, 1);
    assert.equal(page.failed, false, 'default failOn: reported only');

    const scoped = await run(at('.pg-a11y-ok', '/a11y', { checks: { a11y: true } }, { selector: '#ok' }));
    assert.equal(scoped.results[0]!.a11y, undefined, JSON.stringify(scoped.results[0]));
  });

  it('a11y checks the element the screenshot captured: the first match, Playwright selectors too', async () => {
    // Second `.card` has an image without alt, but the screenshot is of the first one.
    const first = await run(at('.pg-a11y-first', '/cards', { checks: { a11y: true } }, { selector: '.card' }));
    assert.equal(first.results[0]!.a11y, undefined, JSON.stringify(first.results[0]));
    const nth = await run(at('.pg-a11y-nth', '/cards', { checks: { a11y: true } }, { selector: '.card >> nth=1' }));
    assert.deepEqual(nth.results[0]!.a11y?.map((v) => v.id), ['image-alt'], JSON.stringify(nth.results[0]));
  });

  it('overflow: measured on the target that enables it, absent on a page that fits', async () => {
    const wide = await run(at('.pg-wide', '/wide', { targets: { desktop: { viewport: '400x200', checks: { overflow: true } } } }));
    assert.equal(wide.results[0]!.overflowPx, 500);
    assert.equal(wide.summary.overflow, 1);
    const fits = await run(at('.pg-fits', '/dark', { checks: { overflow: true } }));
    assert.equal(fits.results[0]!.overflowPx, undefined);
  });

  it('page errors: counted always, failing only when failOn lists them', async () => {
    const reportOnly = await run(at('.pg-boom', '/boom'));
    assert.match(reportOnly.results[0]!.pageErrors?.[0] ?? '', /boom/);
    assert.equal(reportOnly.summary.pageErrors, 1);
    assert.equal(reportOnly.failed, false);
    const gated = await run(at('.pg-boom-gate', '/boom', { failOn: ['changed', 'error', 'pageErrors'] }));
    assert.equal(gated.failed, true);
  });

  it('approve accepts the pixels but not the findings: a gating check still fails', async () => {
    const cfg = () => at('.pg-a11y-approve', '/a11y', { checks: { a11y: true }, failOn: ['changed', 'error', 'a11y'] });
    assert.equal((await run(cfg())).failed, true);
    await approve(cfg());
    const after = JSON.parse(await readFile(path.join(tmp, '.pg-a11y-approve', 'report', 'report.json'), 'utf8'));
    assert.equal(after.summary.a11y, 1);
    assert.equal(after.failed, true);
  });
});

describe('ARIA snapshots', () => {
  const at = (outDir: string, update: UpdateMode, extra: Partial<Config> = {}, page: Partial<NonNullable<Config['pages']>[number]> = {}) =>
    cfgWith(
      {
        outDir,
        targets: { desktop: { viewport: '400x200' } },
        pages: [{ name: 'a', url: `${origin}/aria`, mask: ['.ad'], ...page }],
        ariaSnapshot: true,
        ...extra,
      },
      update,
    );
  const ariaFile = (outDir: string) => path.join(tmp, outDir, 'baseline', `desktop-${platform}`, 'a.aria.yml');

  it('records the tree as a .aria.yml baseline, without hidden or masked content; a re-run matches', async () => {
    const first = await run(at('.pg-aria', 'new'));
    assert.deepEqual([first.results[0]!.status, first.results[0]!.aria?.status], ['added', 'added'], JSON.stringify(first.results));
    const yml = await readFile(ariaFile('.pg-aria'), 'utf8');
    assert.match(yml, /- heading "Title" \[level=1\]/);
    assert.match(yml, /- button "Close"/);
    assert.doesNotMatch(yml, /tick|ad \d/, yml);
    const again = await run(at('.pg-aria', 'none'));
    assert.equal(again.failed, false, JSON.stringify(again.results));
    assert.deepEqual([again.results[0]!.status, again.results[0]!.aria?.status], ['unchanged', 'unchanged']);
  });

  it('a CRLF baseline (git autocrlf checkout) still matches', async () => {
    const file = ariaFile('.pg-aria');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/\n/g, '\r\n'));
    const report = await run(at('.pg-aria', 'none'));
    assert.equal(report.results[0]!.aria?.status, 'unchanged', JSON.stringify(report.results));
  });

  it('a label change with identical pixels fails as changed with a text diff; approve accepts it', async () => {
    ariaLabel = 'Dismiss';
    try {
      const report = await run(at('.pg-aria', 'none'));
      const r = report.results[0]!;
      assert.equal(r.status, 'changed', JSON.stringify(r));
      assert.equal(r.current, undefined, 'the pixels did not change');
      assert.equal(r.aria?.status, 'changed');
      assert.match(r.aria?.patch ?? '', /^-- button "Close": x$/m);
      assert.match(r.aria?.patch ?? '', /^\+- button "Dismiss": x$/m);
      assert.equal(report.failed, true);

      await approve(at('.pg-aria', 'none'));
      assert.match(await readFile(ariaFile('.pg-aria'), 'utf8'), /button "Dismiss"/);
      const reviewed = JSON.parse(await readFile(path.join(tmp, '.pg-aria', 'report', 'report.json'), 'utf8'));
      assert.deepEqual([reviewed.results[0].status, reviewed.results[0].aria.status], ['unchanged', 'unchanged']);
      const after = await run(at('.pg-aria', 'none'));
      assert.equal(after.failed, false, JSON.stringify(after.results));
    } finally {
      ariaLabel = 'Close';
    }
  });

  it('turned off: the stray .aria.yml is reported on its row, approve --prune deletes it', async () => {
    const off = await run(at('.pg-aria', 'none', { ariaSnapshot: false }));
    const r = off.results[0]!;
    assert.deepEqual([r.status, r.aria?.status], ['unchanged', 'removed'], JSON.stringify(r));
    assert.equal(off.failed, false);
    await approve(at('.pg-aria', 'none', { ariaSnapshot: false }), { prune: true });
    assert.equal(existsSync(ariaFile('.pg-aria')), false);
    assert.equal(existsSync(ariaFile('.pg-aria').replace('a.aria.yml', 'a.png')), true, 'the screenshot baseline stays');
  });

  it('a selector snapshot records the tree of the element it captured', async () => {
    await run(at('.pg-aria-card', 'new', {}, { selector: '#card' }));
    const yml = await readFile(ariaFile('.pg-aria-card'), 'utf8');
    assert.match(yml, /heading "Card"/);
    assert.doesNotMatch(yml, /Title/);
  });

  it('turned on for an existing suite in CI mode: rows are added until approved', async () => {
    await run(at('.pg-aria-late', 'new', { ariaSnapshot: false }));
    const ci = await run(at('.pg-aria-late', 'none'));
    const r = ci.results[0]!;
    assert.deepEqual([r.status, r.aria?.status, r.current], ['added', 'added', undefined], JSON.stringify(r));
    assert.equal(ci.failed, true);
    assert.equal(existsSync(ariaFile('.pg-aria-late')), false, 'CI mode writes no baseline');
    await approve(at('.pg-aria-late', 'none'));
    assert.equal((await run(at('.pg-aria-late', 'none'))).failed, false);
  });
});

describe('capture options: maxHeight, includeOutlinesAndShadows, applyPseudoClasses', () => {
  const at = (outDir: string, page: NonNullable<Config['pages']>[number], extra: Partial<Config> = {}) =>
    cfgWith({ outDir, targets: { desktop: { viewport: '400x200' } }, pages: [page], ...extra });
  const png = async (outDir: string, name: string) =>
    pngCodec.decode(await readFile(path.join(tmp, outDir, 'baseline', `desktop-${platform}`, `${name}.png`)));
  const rgb = (img: { data: Uint8Array; width: number }, x: number, y: number) =>
    Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

  it('maxHeight cuts a tall full page and reports its full size; under the cap nothing changes', async () => {
    const cut = await run(at('.pg-cap', { name: 't', url: `${origin}/tall`, maxHeight: 300 }));
    assert.deepEqual(cut.results[0]!.capped, { width: 400, height: 1000 }, JSON.stringify(cut.results[0]));
    const img = await png('.pg-cap', 't');
    assert.deepEqual([img.width, img.height], [400, 300]);

    const whole = await run(at('.pg-cap-default', { name: 't', url: `${origin}/tall` }));
    assert.equal(whole.results[0]!.capped, undefined, 'the default 5000px cap does not touch a 1000px page');
    assert.equal((await png('.pg-cap-default', 't')).height, 1000);
  });

  it('includeOutlinesAndShadows grows a selector crop by the box-shadow', async () => {
    const page = { name: 'card', url: `${origin}/shadow`, selector: '#card' };
    await run(at('.pg-crop', page));
    const plain = await png('.pg-crop', 'card');
    assert.deepEqual([plain.width, plain.height], [100, 40]);
    await run(at('.pg-crop-grown', { ...page, includeOutlinesAndShadows: true }));
    const grown = await png('.pg-crop-grown', 'card');
    // 0 4px 12px 2px: reach 14px, shifted 4px down: 14 + 100 + 14 wide, 10 + 40 + 18 tall.
    assert.deepEqual([grown.width, grown.height], [128, 68]);
  });

  it('applyPseudoClasses forces :hover on the marked element only, and reports unreadable stylesheets', async () => {
    const page = { name: 'p', url: `${origin}/pseudo` };
    await run(at('.pg-pseudo-off', page));
    const off = await png('.pg-pseudo-off', 'p');
    assert.deepEqual(rgb(off, 5, 55), [0, 0, 255], 'control: no hover without the option');

    const report = await run(at('.pg-pseudo', page, { applyPseudoClasses: true }));
    const on = await png('.pg-pseudo', 'p');
    assert.deepEqual(rgb(on, 5, 55), [255, 0, 0], 'marked button shows its :hover style');
    assert.deepEqual(rgb(on, 5, 85), [0, 0, 255], 'unmarked button does not');
    assert.deepEqual(report.results[0]!.unreadableStylesheets, [`http://localhost:${port}/ext.css`]);
  });
});

describe('in-page helpers (chromium)', () => {
  it('elementBox: outlines, several and inset shadows, descendants, clamped to the document', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
      await page.setContent(`<body style="margin:0">
<div id="a" style="position:absolute;left:50px;top:50px;width:100px;height:50px;
  box-shadow: inset 0 0 40px red, 2px 0 0 1px rgb(0, 0, 0), -3px 0 5px rgba(0, 0, 0, 0.5)">
  <span style="position:absolute;left:0;top:0;width:10px;height:10px;outline:4px solid lime;outline-offset:3px"></span>
</div>
<div id="edge" style="position:absolute;left:2px;top:2px;width:20px;height:20px;box-shadow:0 0 0 10px #000"></div></body>`);
      const grown = await page.locator('#a').evaluate(elementBox, true);
      // Outline of the child reaches 7px above and left of the card; the shadows reach 8px left, 3px right, 5px down.
      assert.deepEqual(grown, { x: 42, y: 43, width: 111, height: 62 });
      assert.deepEqual(await page.locator('#a').evaluate(elementBox, false), { x: 50, y: 50, width: 100, height: 50 });
      assert.deepEqual(await page.locator('#edge').evaluate(elementBox, true), { x: 0, y: 0, width: 32, height: 32 });
    } finally {
      await browser.close();
    }
  });

  it('forcePseudoClasses: copies right after the original, in groups and nesting; leaves :focus-within alone', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>
a:hover, b:focus { color: red; }
@supports (display: grid) { @media (min-width: 1px) { c:focus-visible { color: red; } } }
d:focus-within { color: red; }
e { &:active { color: red; } }
</style>`);
      assert.deepEqual(await page.evaluate(forcePseudoClasses), []);
      const selectors = await page.evaluate(() => {
        const out: string[] = [];
        const walk = (list: CSSRuleList) => {
          for (const r of Array.from(list)) {
            if (r instanceof CSSStyleRule) out.push(r.selectorText);
            const inner = (r as { cssRules?: CSSRuleList }).cssRules;
            if (inner) walk(inner);
          }
        };
        walk(document.styleSheets[0]!.cssRules);
        return out;
      });
      assert.deepEqual(selectors, [
        'a:hover, b:focus',
        'a[data-pixelgate-hover], b[data-pixelgate-focus]',
        'c:focus-visible',
        'c[data-pixelgate-focus-visible]',
        'd:focus-within',
        'e',
        '&:active',
        '&[data-pixelgate-active]',
      ]);
    } finally {
      await browser.close();
    }
  });
});

describe('target emulation', () => {
  const at = (outDir: string, target: NonNullable<Config['targets']>[string], url = `${origin}/dark`) =>
    cfgWith({ outDir, targets: { t: target }, pages: [{ name: 'p', url, fullPage: false }] });
  const shot = async (outDir: string) =>
    pngCodec.decode(await readFile(path.join(tmp, outDir, 'baseline', `t-${platform}`, 'p.png')));

  it('colorScheme: dark renders the dark media query, default stays light', async () => {
    await run(at('.pg-light', { viewport: '200x100' }));
    await run(at('.pg-dark', { viewport: '200x100', colorScheme: 'dark' }));
    assert.deepEqual(Array.from((await shot('.pg-light')).data.subarray(0, 3)), [255, 255, 255]);
    assert.deepEqual(Array.from((await shot('.pg-dark')).data.subarray(0, 3)), [0, 0, 0]);
  });

  it('extraHTTPHeaders are sent with the page request', async () => {
    await run(at('.pg-headers', { viewport: '200x100', extraHTTPHeaders: { 'x-pixelgate-test': 'hello' } }));
    assert.equal(lastHeaders['x-pixelgate-test'], 'hello');
  });

  it('device: Playwright descriptor sets viewport, scale factor and user agent', async () => {
    const cfg = at('.pg-device', { device: 'Pixel 7' });
    const t = cfg.targets[0]!;
    assert.equal(t.browser, 'chromium');
    assert.equal(t.isMobile, true);
    await run(cfg);
    assert.match(String(lastHeaders['user-agent']), /Pixel 7/);
    const img = await shot('.pg-device');
    assert.ok(Math.abs(img.width - t.width * t.deviceScaleFactor) <= 1, `${img.width} vs ${t.width}x${t.deviceScaleFactor}`);
  });
});

describe('stability loop', () => {
  const single = (name: string, url: string, stableTimeoutMs?: number) =>
    cfgWith({ pages: [{ name, url }], targets: { desktop: { viewport: '400x200' } }, stabilize: { stableTimeoutMs } });

  it('a page that keeps changing is reported unstable, last frame kept for review', async () => {
    const r = await run(single('ticker', `${origin}/ticker`, 1_000));
    const t = r.results.find((x) => x.name === 'ticker')!;
    assert.equal(t.status, 'error', JSON.stringify(t));
    assert.match(t.error!, /stable screenshot within 1000ms/);
    assert.ok(t.current && existsSync(path.join(tmp, '.pixelgate', t.current)));
    assert.equal(r.failed, true);
  });

  it('a page that flickers then settles is captured settled, and reproducibly', async () => {
    const first = await run(single('settle', `${origin}/settle`));
    assert.equal(first.results.find((x) => x.name === 'settle')!.status, 'added', JSON.stringify(first.results));
    const second = await run(single('settle', `${origin}/settle`));
    assert.equal(second.results.find((x) => x.name === 'settle')!.status, 'unchanged', JSON.stringify(second.results));
  });
});
