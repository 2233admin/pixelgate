import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { approve } from '../src/report.js';
import { run } from '../src/run.js';

// The page under test; tests mutate it to simulate a code change.
let buttonColor = '#2563eb';
let showBanner = true;
const page = () => `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
  button { background: ${buttonColor}; color: #fff; border: 0; padding: 12px 20px; transition: background 2s; }
  .spin { width: 20px; height: 20px; background: red; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div id="app"><h1>Hello</h1><button>Save</button><div class="spin"></div>
  <input autofocus value="caret"></div>
  ${showBanner ? '<div id="banner">banner</div>' : ''}
</body></html>`;

let server: Server;
let tmp: string;
let cfg: ResolvedConfig;

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  tmp = await mkdtemp(path.join(process.env.PIXELGATE_TEST_TMP ?? os.tmpdir(), 'pixelgate-e2e-'));
  cfg = resolveConfig(
    {
      outDir: '.pixelgate',
      targets: { desktop: { viewport: '800x600' }, mobile: { viewport: '375x667' } },
      pages: [
        { name: 'home', url: `http://127.0.0.1:${port}/` },
        { name: 'app', url: `http://127.0.0.1:${port}/`, selector: '#app' },
      ],
    },
    tmp,
  );
});

afterAll(async () => {
  server?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('run -> approve -> run', () => {
  it('first run: everything is added, gate passes', async () => {
    const r = await run(cfg);
    assert.equal(r.summary.added, 4, JSON.stringify(r.results, null, 2));
    assert.equal(r.failed, false);
    assert.ok(existsSync(path.join(tmp, '.pixelgate/report/index.html')));
  });

  it('approve promotes to baseline', async () => {
    const done = await approve(cfg);
    assert.equal(done.length, 4);
    assert.ok(existsSync(path.join(tmp, '.pixelgate/baseline/desktop/home.png')));
  });

  it('re-render of unchanged UI is stable despite animation/caret', async () => {
    const r = await run(cfg);
    assert.equal(r.summary.unchanged, 4, JSON.stringify(r.results, null, 2));
    assert.equal(r.failed, false);
  });

  it('a style change fails the gate and writes a diff', async () => {
    buttonColor = '#dc2626';
    const r = await run(cfg);
    assert.equal(r.summary.changed, 4);
    assert.equal(r.failed, true);
    const diff = r.results.find((x) => x.name === 'app' && x.target === 'desktop')!;
    assert.ok(diff.diff && existsSync(path.join(tmp, '.pixelgate', diff.diff)));
    assert.ok(diff.diffRatio! > 0 && diff.diffRatio! < 0.2);
    const json = JSON.parse(await readFile(path.join(tmp, '.pixelgate/report/report.json'), 'utf8'));
    assert.equal(json.failed, true);
  });

  it('layout change outside the selector only affects full-page snapshots', async () => {
    await approve(cfg);
    showBanner = false;
    const r = await run(cfg);
    const changed = r.results.filter((x) => x.status === 'changed').map((x) => `${x.target}/${x.name}`).sort();
    // Full page is viewport-tall, so removing the banner changes pixels but not size.
    assert.deepEqual(changed, ['desktop/home', 'mobile/home']);
  });

  it('--only runs a subset without reporting the rest as removed', async () => {
    const r = await run(cfg, { only: ['app'] });
    assert.equal(r.summary.total, 2);
    assert.equal(r.summary.removed, 0);
  });
}, 120_000);
