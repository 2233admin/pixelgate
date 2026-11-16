import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../src/config.js';
import { approve } from '../src/report.js';
import { run } from '../src/run.js';

const app = fileURLToPath(new URL('./fixtures/vite-app/', import.meta.url));
const css = path.join(app, 'style.css');
let original: string;
let tmp: string;
const cfgFor = (mode: 'dev' | 'preview'): ResolvedConfig =>
  resolveConfig(
    {
      outDir: tmp,
      vite: { root: '.', mode },
      targets: { desktop: { viewport: '640x400' } },
      pages: [{ name: 'plans', url: '/', selector: '.card' }],
    },
    app,
  );

beforeAll(async () => {
  original = await readFile(css, 'utf8');
  tmp = await mkdtemp(path.join(process.env.PIXELGATE_TEST_TMP ?? os.tmpdir(), 'pixelgate-vite-'));
});

afterAll(async () => {
  await writeFile(css, original);
  await rm(path.join(app, 'dist'), { recursive: true, force: true });
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('vite adapter', () => {
  it('dev server: relative URL keeps Vite base, first run adds', async () => {
    let server = '';
    const r = await run(cfgFor('dev'), { onServer: (u) => (server = u) });
    assert.match(server, /^http:\/\/127\.0\.0\.1:\d+\/app\/$/);
    assert.equal(r.summary.added, 1, JSON.stringify(r.results));
    await approve({ outDir: tmp });
  });

  it('preview build renders the same pixels as dev', async () => {
    const r = await run(cfgFor('preview'));
    assert.equal(r.summary.unchanged, 1, JSON.stringify(r.results));
  });

  it('a CSS edit is caught through the dev server', async () => {
    await writeFile(css, original.replace('#2563eb', '#16a34a'));
    const r = await run(cfgFor('dev'));
    assert.equal(r.summary.changed, 1);
    assert.equal(r.failed, true);
  });

  it('server is closed after the run (port free for the next one)', async () => {
    const a = await run(cfgFor('dev'));
    const b = await run(cfgFor('dev'));
    assert.equal(a.summary.changed + b.summary.changed, 2);
  });
});
