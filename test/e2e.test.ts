import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
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

let server: Server;
let origin: string;
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
    const body = req.url === '/ticker' ? ticker : req.url === '/settle' ? settle : home();
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
