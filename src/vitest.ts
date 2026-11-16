/**
 * Vitest browser-mode adapter.
 *
 * `toMatchScreenshot` keeps doing the capture and comparison; pixelgate only
 * decides where the files go (the same `.pixelgate/` layout as `pixelgate run`)
 * and, through the reporter, writes the review page so `pixelgate approve`
 * works on Vitest results too.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Reporter, Vitest } from 'vitest/node';
import { targetDir } from './config.js';
import { baselinePath, buildReport, currentPath, diffPath, rel, reportDir, writeReport, type SnapshotResult } from './report.js';

export interface PixelgateVitestOptions {
  /** Working directory, relative to the Vitest root. Default `.pixelgate`. */
  outDir?: string;
  /** Separate baselines per OS: `<browser>-<platform>/`. Default true (Vitest does the same in its default file names). */
  platformSpecific?: boolean;
}

/** Subset of Vitest's `PathResolveData` used here. */
export interface ScreenshotPathData {
  arg: string;
  ext: string;
  root: string;
  browserName: string;
  platform: string;
  testFileDirectory: string;
  testFileName: string;
}

interface Seen {
  outDir: string;
  target: string;
  name: string;
  baselineExisted: boolean;
}

// Vitest calls the path resolvers and the reporter in the same (main) process,
// so the reporter learns which snapshots ran from this registry.
const registry = new Map<string, Seen>();

const outDirOf = (root: string, opts: PixelgateVitestOptions) => path.resolve(root, opts.outDir ?? '.pixelgate');

/** `src/components/Button.test.tsx` + `primary` -> `src/components/Button.test.tsx/primary`. */
export function snapshotName(data: Pick<ScreenshotPathData, 'testFileDirectory' | 'testFileName'>, arg: string): string {
  return [data.testFileDirectory, data.testFileName, arg]
    .filter((p) => p && p !== '.')
    .join('/')
    .replace(/\\/g, '/');
}

/**
 * Value for `test.browser.expect.toMatchScreenshot` (spread it in if you set other options too).
 */
export function pixelgateScreenshots(opts: PixelgateVitestOptions = {}) {
  const dirOf = (data: ScreenshotPathData) => targetDir(data.browserName, opts.platformSpecific ?? true, data.platform);
  return {
    resolveScreenshotPath(data: ScreenshotPathData): string {
      const outDir = outDirOf(data.root, opts);
      const target = dirOf(data);
      const name = snapshotName(data, data.arg);
      const file = baselinePath({ outDir }, target, name);
      const key = `${outDir}\0${target}\0${name}`;
      if (!registry.has(key)) {
        registry.set(key, { outDir, target, name, baselineExisted: existsSync(file) });
      }
      return file;
    },
    resolveDiffPath(data: ScreenshotPathData): string {
      const outDir = outDirOf(data.root, opts);
      // Vitest asks for `<arg>-reference` (new screenshot, no baseline, CI), `<arg>-actual` and `<arg>-diff`.
      const m = /-(reference|actual|diff)$/.exec(data.arg);
      const name = snapshotName(data, m ? data.arg.slice(0, -m[0].length) : data.arg);
      return m?.[1] === 'diff' ? diffPath({ outDir }, dirOf(data), name) : currentPath({ outDir }, dirOf(data), name);
    },
  };
}

export function classify(seen: Seen): SnapshotResult {
  const o = { outDir: seen.outDir };
  const base = baselinePath(o, seen.target, seen.name);
  const cur = currentPath(o, seen.target, seen.name);
  const dif = diffPath(o, seen.target, seen.name);
  const r: SnapshotResult = { target: seen.target, name: seen.name, status: 'unchanged' };
  const hasBase = existsSync(base);
  if (hasBase) r.baseline = rel(o, base);
  if (existsSync(cur)) r.current = rel(o, cur);
  if (existsSync(dif)) r.diff = rel(o, dif);

  if (r.current && hasBase) r.status = 'changed';
  else if (r.current) r.status = 'added';
  // Outside CI Vitest writes a missing reference straight to the baseline path.
  else if (hasBase && !seen.baselineExisted) r.status = 'added';
  else if (!hasBase) {
    r.status = 'error';
    r.error = 'no screenshot produced (unstable screenshot or failed capture)';
  }
  return r;
}

/** Writes `<outDir>/report/` after every Vitest run. Add it next to your usual reporters. */
export class PixelgateReporter implements Reporter {
  private root = process.cwd();
  constructor(private readonly opts: PixelgateVitestOptions = {}) {}

  private get outDir() {
    return outDirOf(this.root, this.opts);
  }

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  async onTestRunStart(): Promise<void> {
    for (const [key, seen] of registry) if (seen.outDir === this.outDir) registry.delete(key);
    await rm(path.join(this.outDir, 'current'), { recursive: true, force: true });
    await rm(path.join(this.outDir, 'diff'), { recursive: true, force: true });
  }

  async onTestRunEnd(): Promise<void> {
    const results = [...registry.values()].filter((s) => s.outDir === this.outDir).map(classify);
    if (results.length === 0) return;
    const report = buildReport(results, ['changed', 'error']);
    await writeReport({ outDir: this.outDir }, report);
    const s = report.summary;
    process.stderr.write(
      `\npixelgate: ${s.total} screenshots, changed ${s.changed}, added ${s.added}, error ${s.error}` +
        `\npixelgate: report ${path.join(reportDir({ outDir: this.outDir }), 'index.html')}\n`,
    );
  }
}
