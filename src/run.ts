import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ARIA_EXT } from './aria.js';
import { captureAll, type CaptureResult } from './capture.js';
import { createMatcher, type Matcher } from './compare.js';
import type { PageSnap, ResolvedConfig } from './config.js';
import { resolveUrl, safeName } from './names.js';
import { recordCapture } from './record.js';
import { baselinePath, buildReport, rel, writeReport, type Report, type SnapshotResult } from './report.js';
import { fetchStorybookPages, matchesAny } from './storybook.js';
import { startVite } from './vite.js';

export interface RunOptions {
  /** Only capture snapshots whose name matches one of these globs. */
  only?: string[];
  onProgress?: (r: SnapshotResult) => void;
  /** Called once the Vite server (if any) is listening. */
  onServer?: (url: string) => void;
}

export async function collectSnaps(cfg: ResolvedConfig, only?: string[], baseUrl?: string): Promise<PageSnap[]> {
  const snaps = cfg.pages.map((p) => ({ ...p, url: resolveUrl(p.url, baseUrl) }));
  if (cfg.storybook) snaps.push(...(await fetchStorybookPages(cfg.storybook)));
  return only?.length ? snaps.filter((s) => matchesAny(s.name, only)) : snaps;
}

export async function run(cfg: ResolvedConfig, opts: RunOptions = {}): Promise<Report> {
  const server = cfg.vite ? await startVite(cfg.vite) : undefined;
  try {
    if (server) opts.onServer?.(server.url);
    return await runAgainst(cfg, opts, server?.url ?? cfg.baseUrl);
  } finally {
    await server?.close();
  }
}

const readIfExists = (file: string) => (existsSync(file) ? readFile(file) : Promise.resolve(null));

export function matcherFor(cfg: ResolvedConfig): Matcher {
  return createMatcher({ codec: cfg.codec, comparator: cfg.comparator.fn, options: cfg.comparator.options });
}

async function runAgainst(cfg: ResolvedConfig, opts: RunOptions, baseUrl: string | undefined): Promise<Report> {
  const snaps = await collectSnaps(cfg, opts.only, baseUrl);
  await rm(path.join(cfg.outDir, 'current'), { recursive: true, force: true });
  await rm(path.join(cfg.outDir, 'diff'), { recursive: true, force: true });

  const matcher = matcherFor(cfg);
  const ext = `.${cfg.codec.extension}`;
  const results: SnapshotResult[] = [];
  const seen = new Set<string>();
  /** `<targetDir>/<safeName>` of snapshots whose `.aria.yml` this run accounts for. */
  const seenAria = new Set<string>();

  await captureAll(cfg, snaps, matcher, {
    reference: (dir, name) => readIfExists(baselinePath(cfg, dir, name, ext)),
    async onCapture(c: CaptureResult) {
      seen.add(`${c.target}/${safeName(c.name)}${ext}`);
      const r = await recordCapture(cfg, c, matcher.compare);
      // A failed capture proves nothing about its ARIA baseline: neither compared nor orphaned.
      if (r.status === 'error' || c.aria !== undefined) seenAria.add(`${c.target}/${safeName(c.name)}`);
      results.push(r);
      opts.onProgress?.(r);
    },
  });

  // Baselines with no matching snapshot this run. Skipped for filtered runs: absence proves nothing.
  if (!opts.only?.length) {
    for (const t of cfg.targets) {
      const dir = path.join(cfg.outDir, 'baseline', t.dir);
      if (!existsSync(dir)) continue;
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith(ext) && !f.endsWith(ARIA_EXT) && !seen.has(`${t.dir}/${f}`)) {
          results.push({ target: t.dir, name: f.slice(0, -ext.length), status: 'removed', baseline: rel(cfg, path.join(dir, f)) });
        }
      }
      // `.aria.yml` with no ARIA snapshot this run: on its snapshot's row (removed, or live with
      // `ariaSnapshot` now off), or a row of its own when there is no screenshot either.
      for (const f of files) {
        if (!f.endsWith(ARIA_EXT)) continue;
        const stem = f.slice(0, -ARIA_EXT.length);
        if (seenAria.has(`${t.dir}/${stem}`)) continue;
        const aria = { status: 'removed' as const, baseline: rel(cfg, path.join(dir, f)) };
        const row = results.find((r) => r.target === t.dir && safeName(r.name) === stem);
        if (row) row.aria = aria;
        else results.push({ target: t.dir, name: stem, status: 'removed', aria });
      }
    }
  }

  const report = buildReport(results, cfg.failOn);
  await writeReport(cfg, report);
  return report;
}
