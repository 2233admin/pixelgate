import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckName, FailOn, Impact, Status } from './config.js';
import { renderHtml } from './html.js';
import { safeName } from './names.js';
import { matchesAny } from './storybook.js';

/** Everything report/approve need: just the working directory. */
export interface OutDir {
  outDir: string;
}

/** One axe-core rule a snapshot violates. */
export interface A11yViolation {
  /** axe rule id, e.g. `image-alt`. */
  id: string;
  impact?: Impact;
  help: string;
  helpUrl: string;
  /** Elements that violate it. */
  nodes: number;
  /** Selectors of the first few of them. */
  targets: string[];
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
  /** Comparator's explanation, e.g. `SSIM 0.9731 < 0.99`. */
  message?: string;
  error?: string;
  pageErrors?: string[];
  /** Hostnames `allowedHostnames` blocked while rendering (why an asset may be missing). */
  blocked?: string[];
  /** axe-core violations (`checks.a11y`). */
  a11y?: A11yViolation[];
  /** CSS pixels the page reaches past the right edge of the viewport (`checks.overflow`). */
  overflowPx?: number;
}

export interface Report {
  version: 1;
  createdAt: string;
  failed: boolean;
  failOn: FailOn[];
  /** Per status, and per check: how many snapshots have that finding. */
  summary: Record<Status | CheckName, number> & { total: number };
  results: SnapshotResult[];
}

export const rel = (o: OutDir, p: string) => path.relative(o.outDir, p).split(path.sep).join('/');
/** `ext` includes the dot. Diffs are always `.png`. */
export const baselinePath = (o: OutDir, target: string, name: string, ext = '.png') =>
  path.join(o.outDir, 'baseline', target, `${safeName(name)}${ext}`);
export const currentPath = (o: OutDir, target: string, name: string, ext = '.png') =>
  path.join(o.outDir, 'current', target, `${safeName(name)}${ext}`);
export const diffPath = (o: OutDir, target: string, name: string) =>
  path.join(o.outDir, 'diff', target, `${safeName(name)}.png`);
export const reportDir = (o: OutDir) => path.join(o.outDir, 'report');

const ORDER: Status[] = ['error', 'changed', 'removed', 'added', 'updated', 'unchanged'];

export function sortResults(results: SnapshotResult[]): SnapshotResult[] {
  return results.sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name) ||
      a.target.localeCompare(b.target),
  );
}

/** Check findings of a result. They come from the result's fields, never its status, so `approve` cannot clear them. */
export function checkFindings(r: SnapshotResult): CheckName[] {
  const found: CheckName[] = [];
  if (r.pageErrors?.length) found.push('pageErrors');
  if (r.a11y?.length) found.push('a11y');
  if (r.overflowPx) found.push('overflow');
  return found;
}

export function summarize(results: SnapshotResult[], failOn: FailOn[]): Pick<Report, 'summary' | 'failed'> {
  const summary = {
    total: results.length,
    unchanged: 0,
    changed: 0,
    added: 0,
    updated: 0,
    removed: 0,
    error: 0,
    pageErrors: 0,
    a11y: 0,
    overflow: 0,
  };
  for (const r of results) {
    summary[r.status]++;
    for (const c of checkFindings(r)) summary[c]++;
  }
  return { summary, failed: failOn.some((s) => summary[s] > 0) };
}

export function buildReport(results: SnapshotResult[], failOn: FailOn[]): Report {
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
  /**
   * Out dir of another run to approve from, e.g. a CI artifact downloaded with
   * `gh run download`: its report and screenshots are read, baselines are written
   * to `o`. This is how a Windows/macOS machine accepts Linux CI baselines.
   */
  from?: string;
}

/** `rel` resolved under `dir`; throws if it points outside (the report may come from a download). */
function inside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  const back = path.relative(dir, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`Report path escapes ${dir}: ${rel}`);
  return abs;
}

/** Promote current screenshots to baseline for changed/added snapshots in the last report. */
export async function approve(o: OutDir, opts: ApproveOptions = {}): Promise<SnapshotResult[]> {
  const source: OutDir = opts.from ? { outDir: path.resolve(opts.from) } : o;
  const report = await readReport(source);
  const done: SnapshotResult[] = [];
  for (const r of report.results) {
    if (opts.only?.length && !matchesAny(r.name, opts.only)) continue;
    const take = r.status === 'changed' || r.status === 'added' || (opts.from !== undefined && r.status === 'updated');
    if (take) {
      // Paths come from the report, so the file format (png/jpg/...) is whatever the run wrote.
      // Mode `new` and Vitest write a brand-new reference straight to baseline; in place there is
      // nothing to copy then, but from another run that baseline is the screenshot to take.
      const srcRel = r.current ?? (opts.from ? r.baseline : undefined);
      const src = srcRel && inside(source.outDir, srcRel);
      if (src && existsSync(src)) {
        const dest = inside(o.outDir, path.join('baseline', r.target, path.basename(src)));
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
        r.baseline = rel(o, dest);
      }
      done.push(r);
    } else if (r.status === 'removed' && opts.prune && r.baseline) {
      await unlink(inside(o.outDir, r.baseline)).catch(() => {});
      done.push(r);
    }
  }
  // The source report belongs to the other run; leave it as downloaded.
  if (opts.from) return done;
  // Reflect the approval in the report so a re-opened review page is not stale.
  const key = (r: SnapshotResult) => `${r.target}\0${r.name}`;
  const approved = new Set(done.map(key));
  const results = report.results
    .filter((r) => !(r.status === 'removed' && approved.has(key(r))))
    .map((r) => (approved.has(key(r)) ? { ...r, status: 'unchanged' as const, diff: undefined } : r));
  await writeReport(o, { ...report, ...summarize(results, report.failOn), results });
  return done;
}
