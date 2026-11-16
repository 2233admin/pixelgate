/**
 * Playwright Test reporter for `pixelgate-cli/playwright`: add it next to your usual reporters,
 * `reporter: [['list'], ['pixelgate-cli/playwright-reporter']]`.
 *
 * It clears `current/` and `diff/` before the run, collects the result each
 * `pixelgate.screenshot()` attached (the last retry of a test wins), writes the review page
 * per out dir and fails the run when `failOn` says so, even if every test passed.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { FailOn } from './config.js';
import { ATTACHMENT, outDirOf, type PixelgateAttachment, type PixelgateOptions } from './playwright-shared.js';
import { safeName } from './names.js';
import { buildReport, reportDir, summarize, writeReport, type SnapshotResult } from './report.js';

interface Row {
  outDir: string;
  failOn: FailOn[];
  test: string;
  title: string;
  result: SnapshotResult;
}

/** Set in the runner when this reporter is configured; workers inherit it. */
export const REPORTER_ENV = 'PIXELGATE_PLAYWRIGHT_REPORTER';

export default class PixelgatePlaywrightReporter implements Reporter {
  constructor() {
    // Reporters are created before any worker starts, and workers copy the runner's env.
    process.env[REPORTER_ENV] = '1';
  }

  /** `outDir \0 target \0 name` -> row. */
  private rows = new Map<string, Row>();
  /** Snapshots claimed by more than one test, by key. */
  private clashes = new Map<string, Set<string>>();
  /** Keys each test produced in its latest attempt. */
  private byTest = new Map<string, string[]>();

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    const dirs = new Set(config.projects.map((p) => outDirOf(config, ((p.use as { pixelgateOptions?: PixelgateOptions }).pixelgateOptions ?? {}))));
    // Workers write into these from the first test on, so clear them here, once.
    for (const dir of dirs) {
      rmSync(path.join(dir, 'current'), { recursive: true, force: true });
      rmSync(path.join(dir, 'diff'), { recursive: true, force: true });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // A retry replaces what the earlier attempt of the same test reported.
    for (const key of this.byTest.get(test.id) ?? []) if (this.rows.get(key)?.test === test.id) this.rows.delete(key);
    const keys: string[] = [];
    for (const a of result.attachments) {
      if (a.name !== ATTACHMENT || !a.body) continue;
      const data = JSON.parse(a.body.toString('utf8')) as PixelgateAttachment;
      // Keyed by file: names that map to the same file (`a/b`, `a_b`) collide.
      const key = `${data.outDir}\0${data.result.target}\0${safeName(data.result.name)}`;
      const title = test.titlePath().filter(Boolean).join(' > ');
      const other = this.rows.get(key);
      if (other && other.test !== test.id) {
        const set = this.clashes.get(key) ?? new Set([other.title]);
        set.add(title);
        this.clashes.set(key, set);
      }
      this.rows.set(key, { ...data, test: test.id, title });
      keys.push(key);
    }
    this.byTest.set(test.id, keys);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const byDir = new Map<string, Row[]>();
    for (const [key, row] of this.rows) {
      const clash = this.clashes.get(key);
      const r: SnapshotResult = clash
        ? { ...row.result, status: 'error', error: `snapshot name used by more than one test: ${[...clash].join('; ')}` }
        : row.result;
      byDir.set(row.outDir, [...(byDir.get(row.outDir) ?? []), { ...row, result: r }]);
    }
    let failed = false;
    for (const [outDir, rows] of byDir) {
      const failOn = [...new Set(rows.flatMap((r) => r.failOn))];
      const report = buildReport(
        rows.map((r) => r.result),
        failOn,
      );
      // Projects sharing an out dir keep their own `failOn`: each row is judged by its own.
      report.failed = rows.some((r) => summarize([r.result], r.failOn).failed);
      await writeReport({ outDir }, report);
      const s = report.summary;
      process.stderr.write(
        `\npixelgate: ${report.failed ? 'FAIL' : 'PASS'}  total ${s.total}  changed ${s.changed}  added ${s.added}  updated ${s.updated}  error ${s.error}  unchanged ${s.unchanged}` +
          `\npixelgate: report ${path.join(reportDir({ outDir }), 'index.html')}\n`,
      );
      failed ||= report.failed;
    }
    return failed && result.status === 'passed' ? { status: 'failed' } : undefined;
  }
}
