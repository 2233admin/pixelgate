import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Status } from './config.js';
import { renderHtml } from './html.js';
import { safeName } from './names.js';
import { matchesAny } from './storybook.js';

/** Everything report/approve need: just the working directory. */
export interface OutDir {
  outDir: string;
}

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

export const rel = (o: OutDir, p: string) => path.relative(o.outDir, p).split(path.sep).join('/');
export const baselinePath = (o: OutDir, target: string, name: string) =>
  path.join(o.outDir, 'baseline', target, `${safeName(name)}.png`);
export const currentPath = (o: OutDir, target: string, name: string) =>
  path.join(o.outDir, 'current', target, `${safeName(name)}.png`);
export const diffPath = (o: OutDir, target: string, name: string) =>
  path.join(o.outDir, 'diff', target, `${safeName(name)}.png`);
export const reportDir = (o: OutDir) => path.join(o.outDir, 'report');

const ORDER: Status[] = ['error', 'changed', 'removed', 'added', 'unchanged'];

export function sortResults(results: SnapshotResult[]): SnapshotResult[] {
  return results.sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name) ||
      a.target.localeCompare(b.target),
  );
}

export function summarize(results: SnapshotResult[], failOn: Status[]): Pick<Report, 'summary' | 'failed'> {
  const summary = { total: results.length, unchanged: 0, changed: 0, added: 0, removed: 0, error: 0 };
  for (const r of results) summary[r.status]++;
  return { summary, failed: failOn.some((s) => summary[s] > 0) };
}

export function buildReport(results: SnapshotResult[], failOn: Status[]): Report {
  return { version: 1, createdAt: new Date().toISOString(), failOn, ...summarize(results, failOn), results: sortResults(results) };
}

export async function writeReport(o: OutDir, report: Report): Promise<void> {
  await mkdir(reportDir(o), { recursive: true });
  await writeFile(path.join(reportDir(o), 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(reportDir(o), 'index.html'), renderHtml(report));
}

export async function readReport(o: OutDir): Promise<Report> {
  const file = path.join(reportDir(o), 'report.json');
  if (!existsSync(file)) throw new Error(`No report at ${file}. Run \`pixelgate run\` (or Vitest with the pixelgate reporter) first.`);
  return JSON.parse(await readFile(file, 'utf8')) as Report;
}

export interface ApproveOptions {
  only?: string[];
  /** Also delete baselines reported as `removed`. */
  prune?: boolean;
}

/** Promote current screenshots to baseline for changed/added snapshots in the last report. */
export async function approve(o: OutDir, opts: ApproveOptions = {}): Promise<SnapshotResult[]> {
  const report = await readReport(o);
  const done: SnapshotResult[] = [];
  for (const r of report.results) {
    if (opts.only?.length && !matchesAny(r.name, opts.only)) continue;
    if (r.status === 'changed' || r.status === 'added') {
      const src = currentPath(o, r.target, r.name);
      // Vitest writes a brand-new reference straight to baseline; nothing to copy then.
      if (existsSync(src)) {
        const dest = baselinePath(o, r.target, r.name);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
      }
      done.push(r);
    } else if (r.status === 'removed' && opts.prune && r.baseline) {
      await unlink(path.join(o.outDir, r.baseline)).catch(() => {});
      done.push(r);
    }
  }
  // Reflect the approval in the report so a re-opened review page is not stale.
  const key = (r: SnapshotResult) => `${r.target}\0${r.name}`;
  const approved = new Set(done.map(key));
  const results = report.results
    .filter((r) => !(r.status === 'removed' && approved.has(key(r))))
    .map((r) =>
      approved.has(key(r))
        ? { ...r, status: 'unchanged' as const, baseline: rel(o, baselinePath(o, r.target, r.name)), diff: undefined }
        : r,
    );
  await writeReport(o, { ...report, ...summarize(results, report.failOn), results });
  return done;
}
