import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { approve, readReport } from '../src/report.js';

// Runs a real Playwright Test project (test/fixtures/playwright-app) that uses
// `pixelgate/playwright` and its reporter from the built dist, as a consumer would.
const repo = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(repo, 'test', 'fixtures', 'playwright-app');
const outDir = path.join(app, '.pixelgate');
const cli = path.join(repo, 'node_modules', '@playwright', 'test', 'cli.js');
const target = `desktop-${process.platform}`;
const baseline = (file: string) => path.join(outDir, 'baseline', target, file);

function playwright(env: Record<string, string> = {}, args: string[] = []): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [cli, 'test', ...args], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', PIXELGATE_PLAYWRIGHT_REPORTER: '', ...env },
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(...(e.isDirectory() ? await files(p) : [p]));
  }
  return out;
}

const clean = async () => {
  await rm(outDir, { recursive: true, force: true });
  await rm(path.join(app, 'test-results'), { recursive: true, force: true });
};
beforeAll(clean);
// In CI the output stays for the failure artifact.
afterAll(async () => {
  if (!process.env.CI) await clean();
});

/** The report's non-unchanged rows, for assertion messages. */
const why = async () =>
  JSON.stringify(
    (await readReport({ outDir }).catch(() => undefined))?.results.filter((x) => x.status !== 'unchanged') ?? 'no report',
  );

describe('playwright test fixture', () => {
  it('first run writes the baselines (screenshot and ARIA) and passes', async () => {
    const r = playwright();
    assert.equal(r.status, 0, r.output);
    const report = await readReport({ outDir });
    assert.equal(report.summary.added, 2, r.output);
    assert.ok(existsSync(baseline('card.png')) && existsSync(baseline('card.aria.yml')), r.output);
    assert.ok(existsSync(baseline('page.png')));
    // A console error belongs to the screenshot after it, not to the next one of the test.
    assert.match(report.results.find((x) => x.name === 'card')!.consoleErrors?.[0] ?? '', /card-console/, JSON.stringify(report.results));
    assert.equal(report.results.find((x) => x.name === 'page')!.consoleErrors, undefined);
  });

  it('unchanged UI passes; the hidden timestamp changes neither pixels nor the ARIA tree', async () => {
    const r = playwright();
    assert.equal(r.status, 0, r.output + (await why()));
    assert.equal((await readReport({ outDir })).summary.unchanged, 2, r.output);
  });

  it('a visual change: the test itself passes, the reporter fails the run; images reach Playwright', async () => {
    const r = playwright({ CARD_COLOR: '#dc2626' });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /1 passed/);
    const report = await readReport({ outDir });
    const card = report.results.find((x) => x.name === 'card')!;
    assert.equal(card.status, 'changed', JSON.stringify(report.results));
    assert.ok(existsSync(path.join(outDir, card.current!)) && existsSync(path.join(outDir, card.diff!)));
    const attached = (await files(path.join(app, 'test-results'))).map((f) => path.basename(f));
    // Playwright stores attachments as `<name>-<hash>.png`.
    for (const kind of ['expected', 'actual', 'diff']) assert.ok(attached.some((f) => f.startsWith(`card-${kind}`)), attached.join(', '));
  });

  it('pixelgate approve accepts it and the run passes again', async () => {
    assert.equal((await approve({ outDir })).length, 2);
    const r = playwright({ CARD_COLOR: '#dc2626' });
    assert.equal(r.status, 0, r.output + (await why()));
  });

  it('in CI a snapshot without baseline fails the run as added, and no baseline is written', async () => {
    await unlink(baseline('page.png'));
    const r = playwright({ CI: '1', CARD_COLOR: '#dc2626' });
    assert.equal(r.status, 1, r.output);
    assert.equal(existsSync(baseline('page.png')), false);
    const report = await readReport({ outDir });
    assert.equal(report.results.find((x) => x.name === 'page')!.status, 'added');
  });

  it('without the pixelgate reporter the fixture refuses to run', () => {
    const r = playwright({}, ['--reporter=list']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /add the pixelgate reporter/);
  });
});
