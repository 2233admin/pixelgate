import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { approve, readReport } from '../src/report.js';

// Runs a real Vitest browser-mode project (test/fixtures/vitest-app) that uses
// `pixelgate/vitest` from the built dist, as a consumer would.
const app = fileURLToPath(new URL('./fixtures/vitest-app/', import.meta.url));
const outDir = path.join(app, '.pixelgate');
const theme = path.join(app, 'theme.json');
const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const target = `chromium-${process.platform}`;
let original: string;

function vitest(): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [vitestBin, 'run', '--root', app], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '' },
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

beforeAll(async () => {
  original = await readFile(theme, 'utf8');
  await rm(outDir, { recursive: true, force: true });
});

afterAll(async () => {
  await writeFile(theme, original);
  await rm(outDir, { recursive: true, force: true });
  await rm(path.join(app, '.vitest'), { recursive: true, force: true });
});

describe('vitest adapter', () => {
  it('first run: reference lands in .pixelgate/baseline and the report says added', async () => {
    const r = vitest();
    const report = await readReport({ outDir });
    assert.equal(report.summary.total, 1, r.output);
    assert.equal(report.results[0]!.status, 'added', r.output);
    assert.equal(report.results[0]!.target, target);
    assert.equal(report.results[0]!.name, 'card.browser.ts/card');
    await approve({ outDir });
    assert.ok(existsSync(path.join(outDir, `baseline/${target}/card.browser.ts_card.png`)), r.output);
  });

  it('unchanged UI passes and reports unchanged', async () => {
    const r = vitest();
    assert.equal(r.status, 0, r.output);
    const report = await readReport({ outDir });
    assert.equal(report.summary.unchanged, 1, r.output);
  });

  it('a visual change fails Vitest; actual + diff land in .pixelgate', async () => {
    await writeFile(theme, JSON.stringify({ color: '#dc2626' }));
    const r = vitest();
    assert.equal(r.status, 1, r.output);
    const report = await readReport({ outDir });
    const res = report.results[0]!;
    assert.equal(res.status, 'changed', r.output);
    assert.equal(res.current, `current/${target}/card.browser.ts_card.png`);
    assert.equal(res.diff, `diff/${target}/card.browser.ts_card.png`);
    assert.ok(existsSync(path.join(outDir, res.current!)));
    assert.ok(existsSync(path.join(outDir, res.diff!)));
  });

  it('pixelgate approve accepts it and Vitest passes again', async () => {
    const done = await approve({ outDir });
    assert.equal(done.length, 1);
    const r = vitest();
    assert.equal(r.status, 0, r.output);
  });
});
