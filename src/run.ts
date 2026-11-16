import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureAll, type CaptureResult } from './capture.js';
import { compareImages } from './compare.js';
import type { PageSnap, ResolvedConfig } from './config.js';
import { resolveUrl, safeName } from './names.js';
import { baselinePath, buildReport, diffPath, rel, writeReport, type Report, type SnapshotResult } from './report.js';
import { fetchStorybookPages, matchesAny } from './storybook.js';
import { startVite } from './vite.js';

export interface RunOptions {
  /** Only capture snapshots whose name matches one of these globs. */
  only?: string[];
  onProgress?: (r: CaptureResult) => void;
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

async function runAgainst(cfg: ResolvedConfig, opts: RunOptions, baseUrl: string | undefined): Promise<Report> {
  const snaps = await collectSnaps(cfg, opts.only, baseUrl);
  await rm(path.join(cfg.outDir, 'current'), { recursive: true, force: true });
  await rm(path.join(cfg.outDir, 'diff'), { recursive: true, force: true });

  const captures = await captureAll(cfg, snaps, opts.onProgress);
  const results: SnapshotResult[] = [];

  for (const c of captures) {
    const base = baselinePath(cfg, c.target, c.name);
    const r: SnapshotResult = { target: c.target, name: c.name, status: 'unchanged' };
    if (c.pageErrors.length) r.pageErrors = c.pageErrors;
    if (existsSync(base)) r.baseline = rel(cfg, base);
    if (c.error || !c.file) {
      r.status = 'error';
      r.error = c.error ?? 'no screenshot produced';
    } else {
      r.current = rel(cfg, c.file);
      if (!existsSync(base)) {
        r.status = 'added';
      } else {
        const cmp = compareImages(await readFile(base), await readFile(c.file), { threshold: cfg.threshold });
        r.diffPixels = cmp.diffPixels;
        r.diffRatio = cmp.diffRatio;
        r.sizeChanged = cmp.sizeChanged;
        if (cmp.diffPixels > 0 && (cmp.sizeChanged || cmp.diffRatio > cfg.maxDiffPixelRatio)) {
          r.status = 'changed';
          const diffFile = diffPath(cfg, c.target, c.name);
          await mkdir(path.dirname(diffFile), { recursive: true });
          await writeFile(diffFile, cmp.diffPng);
          r.diff = rel(cfg, diffFile);
        }
      }
    }
    results.push(r);
  }

  // Baselines with no matching snapshot this run. Skipped for filtered runs: absence proves nothing.
  if (!opts.only?.length) {
    const live = new Set(captures.map((c) => `${c.target}/${safeName(c.name)}.png`));
    for (const t of cfg.targets) {
      const dir = path.join(cfg.outDir, 'baseline', t.name);
      if (!existsSync(dir)) continue;
      for (const f of await readdir(dir)) {
        if (f.endsWith('.png') && !live.has(`${t.name}/${f}`)) {
          results.push({ target: t.name, name: f.slice(0, -4), status: 'removed', baseline: rel(cfg, path.join(dir, f)) });
        }
      }
    }
  }

  const report = buildReport(results, cfg.failOn);
  await writeReport(cfg, report);
  return report;
}
