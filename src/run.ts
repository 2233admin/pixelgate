import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureAll, safeName, type CaptureResult } from './capture.js';
import { compareImages } from './compare.js';
import type { PageSnap, ResolvedConfig, Status } from './config.js';
import { renderHtml } from './html.js';
import { fetchStorybookPages, matchesAny } from './storybook.js';

export interface SnapshotResult {
  target: string;
  name: string;
  status: Status;
  /** Paths relative to `outDir`, forward slashes. */
  baseline?: string;
  current?: string;
  diff?: string;
  diffPixels?: number;
  diffRatio?: number;
  sizeChanged?: boolean;
  error?: string;
  pageErrors?: string[];
}

export interface Report {
  version: 1;
  createdAt: string;
  failed: boolean;
  failOn: Status[];
  summary: Record<Status, number> & { total: number };
  results: SnapshotResult[];
}

export interface RunOptions {
  /** Only capture snapshots whose name matches one of these globs. */
  only?: string[];
  onProgress?: (r: CaptureResult) => void;
}

const rel = (cfg: ResolvedConfig, p: string) => path.relative(cfg.outDir, p).split(path.sep).join('/');
const baselinePath = (cfg: ResolvedConfig, target: string, name: string) =>
  path.join(cfg.outDir, 'baseline', target, `${safeName(name)}.png`);
const currentPath = (cfg: ResolvedConfig, target: string, name: string) =>
  path.join(cfg.outDir, 'current', target, `${safeName(name)}.png`);

export async function collectSnaps(cfg: ResolvedConfig, only?: string[]): Promise<PageSnap[]> {
  const snaps = [...cfg.pages];
  if (cfg.storybook) snaps.push(...(await fetchStorybookPages(cfg.storybook)));
  return only?.length ? snaps.filter((s) => matchesAny(s.name, only)) : snaps;
}

export function summarize(results: SnapshotResult[], failOn: Status[]): Pick<Report, 'summary' | 'failed'> {
  const summary = { total: results.length, unchanged: 0, changed: 0, added: 0, removed: 0, error: 0 };
  for (const r of results) summary[r.status]++;
  return { summary, failed: failOn.some((s) => summary[s] > 0) };
}

export async function run(cfg: ResolvedConfig, opts: RunOptions = {}): Promise<Report> {
  const snaps = await collectSnaps(cfg, opts.only);
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
          const diffFile = path.join(cfg.outDir, 'diff', c.target, `${safeName(c.name)}.png`);
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
          results.push({
            target: t.name,
            name: f.slice(0, -4),
            status: 'removed',
            baseline: rel(cfg, path.join(dir, f)),
          });
        }
      }
    }
  }

  const order: Status[] = ['error', 'changed', 'removed', 'added', 'unchanged'];
  results.sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name) || a.target.localeCompare(b.target),
  );
  const report: Report = { version: 1, createdAt: new Date().toISOString(), failOn: cfg.failOn, ...summarize(results, cfg.failOn), results };
  await writeReport(cfg, report);
  return report;
}

export const reportDir = (cfg: ResolvedConfig) => path.join(cfg.outDir, 'report');

export async function writeReport(cfg: ResolvedConfig, report: Report): Promise<void> {
  await mkdir(reportDir(cfg), { recursive: true });
  await writeFile(path.join(reportDir(cfg), 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(reportDir(cfg), 'index.html'), renderHtml(report));
}

export async function readReport(cfg: ResolvedConfig): Promise<Report> {
  const file = path.join(reportDir(cfg), 'report.json');
  if (!existsSync(file)) throw new Error(`No report at ${file}. Run \`pixelgate run\` first.`);
  return JSON.parse(await readFile(file, 'utf8')) as Report;
}

export interface ApproveOptions {
  only?: string[];
  /** Also delete baselines reported as `removed`. */
  prune?: boolean;
}

/** Promote current screenshots to baseline for changed/added snapshots in the last report. */
export async function approve(cfg: ResolvedConfig, opts: ApproveOptions = {}): Promise<SnapshotResult[]> {
  const report = await readReport(cfg);
  const done: SnapshotResult[] = [];
  for (const r of report.results) {
    if (opts.only?.length && !matchesAny(r.name, opts.only)) continue;
    if (r.status === 'changed' || r.status === 'added') {
      const dest = baselinePath(cfg, r.target, r.name);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(currentPath(cfg, r.target, r.name), dest);
      done.push(r);
    } else if (r.status === 'removed' && opts.prune && r.baseline) {
      await unlink(path.join(cfg.outDir, r.baseline)).catch(() => {});
      done.push(r);
    }
  }
  // Reflect the approval in the report so a re-opened review page is not stale.
  const approved = new Set(done.map((r) => `${r.target}\0${r.name}`));
  const results = report.results
    .filter((r) => !(r.status === 'removed' && approved.has(`${r.target}\0${r.name}`)))
    .map((r) =>
      approved.has(`${r.target}\0${r.name}`)
        ? { ...r, status: 'unchanged' as const, baseline: rel(cfg, baselinePath(cfg, r.target, r.name)), diff: undefined }
        : r,
    );
  await writeReport(cfg, { ...report, ...summarize(results, report.failOn), results });
  return done;
}
