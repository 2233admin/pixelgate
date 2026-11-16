import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { explore, type ExploreReport } from '../src/explore.js';

// Needs the engine binary (engine/README.md). Without it: skip loudly, or fail when CI says it must run.
const engine = process.env.PIXELGATE_ENGINE;
if (!engine && process.env.PIXELGATE_REQUIRE_ENGINE === '1') {
  throw new Error('PIXELGATE_REQUIRE_ENGINE=1 but PIXELGATE_ENGINE is not set');
}
if (!engine) console.warn('SKIPPED explore e2e: set PIXELGATE_ENGINE to the engine binary to run it');
const maybe = engine ? describe : describe.skip;

const fixture = (name: string) => pathToFileURL(fileURLToPath(new URL(`./fixtures/explore/${name}`, import.meta.url))).href;

maybe('explore e2e', () => {
  let tmp: string;
  const servers: Server[] = [];
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(process.env.PIXELGATE_TEST_TMP ?? os.tmpdir(), 'pixelgate-explore-e2e-'));
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const readReport = async (dir: string) => JSON.parse(await readFile(path.join(dir, 'explore.json'), 'utf8')) as ExploreReport;
  const quiet = () => undefined;

  it('a page that throws: exit 1 with a noUncaughtExceptions violation', async () => {
    const outDir = path.join(tmp, 'throws');
    const r = await explore({ url: fixture('throws.html'), engine, timeLimit: '30s', outDir, cwd: tmp, quietEngine: true, log: quiet });
    assert.equal(r.exitCode, 1, JSON.stringify(r.report.error));
    const rep = await readReport(r.dir);
    assert.ok(rep.violations.some((v) => v.name === 'noUncaughtExceptions'), JSON.stringify(rep.violations));
    assert.match(JSON.stringify(rep.violations), /boom from bad button/);
    const shot = rep.states.find((s) => s.violations.includes('noUncaughtExceptions'))?.screenshot;
    assert.ok(shot && existsSync(path.join(r.dir, shot)), 'violation state has a screenshot');
    assert.match(await readFile(path.join(r.dir, 'explore.html'), 'utf8'), /noUncaughtExceptions/);
    assert.ok(existsSync(path.join(r.dir, 'trace.bin')) && existsSync(path.join(r.dir, 'engine.log')));
    // The page's own error reached the passive Playwright listener too.
    assert.ok(rep.pageErrors.some((e) => e.includes('boom from bad button')), JSON.stringify(rep.pageErrors));
  });

  it('a clean page with an alert() button: exit 0, several states, no hang', async () => {
    const outDir = path.join(tmp, 'clean');
    const t0 = Date.now();
    const r = await explore({ url: fixture('clean.html'), engine, timeLimit: '10s', outDir, cwd: tmp, quietEngine: true, log: quiet });
    assert.equal(r.exitCode, 0, JSON.stringify(r.report.error));
    assert.ok(r.report.states.length > 2, `states: ${r.report.states.length}`);
    assert.equal(r.report.violations.length, 0, JSON.stringify(r.report.violations));
    assert.ok(Date.now() - t0 < 60_000, 'finished near the time limit');
  });

  it('allowedHostnames blocking and the engine coexist: blocked host never loaded, run finishes', async () => {
    const hits: Record<string, number> = {};
    const server = createServer((req, res) => {
      const u = req.url ?? '/';
      hits[u] = (hits[u] ?? 0) + 1;
      if (u === '/' || u.startsWith('/?')) {
        const { port } = server.address() as AddressInfo;
        res.setHeader('content-type', 'text/html');
        // `localhost` is the same server under another hostname: only allowedHostnames keeps it out.
        res.end(`<!doctype html><title>blocked</title><button onclick="document.title='x'+Date.now()">Go</button>
<script src="/allowed.js"></script><script src="http://localhost:${port}/blocked.js"></script>`);
      } else {
        res.setHeader('content-type', 'text/javascript');
        res.end('window.loaded = (window.loaded || 0) + 1;');
      }
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const outDir = path.join(tmp, 'blocked');
    await writeFile(
      path.join(tmp, 'pixelgate.config.json'),
      JSON.stringify({ outDir, pages: [{ name: 'home', url: `http://127.0.0.1:${port}/` }], allowedHostnames: ['127.0.0.1'] }),
    );
    const r = await explore({ url: `http://127.0.0.1:${port}/`, engine, timeLimit: '10s', cwd: tmp, quietEngine: true, log: quiet });
    assert.equal(r.exitCode, 0, JSON.stringify(r.report.error));
    assert.ok(r.report.states.length >= 1);
    assert.ok((hits['/allowed.js'] ?? 0) >= 1, `allowed script requested: ${JSON.stringify(hits)}`);
    assert.equal(hits['/blocked.js'] ?? 0, 0, `blocked script was requested: ${JSON.stringify(hits)}`);
    assert.equal(r.dir, path.join(outDir, 'explore'));
  });
});
