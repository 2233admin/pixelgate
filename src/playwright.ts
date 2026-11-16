/**
 * Playwright Test integration (Happo: `happoScreenshot`).
 *
 * `pixelgate.screenshot()` runs pixelgate's own capture on the test's page: the stability
 * loop, hide/mask, the configured comparator and format, checks and ARIA snapshots. The
 * files go into the usual `.pixelgate/` layout; each result travels to the pixelgate
 * reporter (`pixelgate/playwright-reporter`) as a test attachment, and the reporter writes
 * the review page and fails the run per `failOn`, so `pixelgate approve` works unchanged.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base, type Locator, type TestInfo } from '@playwright/test';
import { settle, shoot, watchPage, type CaptureResult, type CaptureSnap } from './capture.js';
import { createMatcher } from './compare.js';
import type { ResolvedConfig } from './config.js';
import { ATTACHMENT, configFor, type PixelgateAttachment, type PixelgateOptions } from './playwright-shared.js';
import { recordCapture } from './record.js';
import { safeName } from './names.js';
import { baselinePath, type SnapshotResult } from './report.js';

export { expect } from '@playwright/test';
export { ATTACHMENT, configFor, outDirOf, updateMode, type PixelgateAttachment, type PixelgateOptions } from './playwright-shared.js';

export interface ScreenshotOptions {
  /** Capture this element (its first match). Default: the page. */
  locator?: Locator;
  /** Capture the whole scrollable page rather than the viewport. Default true. */
  fullPage?: boolean;
  /** Painted over, on top of `pixelgateOptions.mask`: selectors or locators. */
  mask?: Array<string | Locator>;
  maxHeight?: number;
  maxWidth?: number;
  includeOutlinesAndShadows?: boolean;
  ariaSnapshot?: boolean;
}

export interface Pixelgate {
  /**
   * Captures the page (or `locator`), compares it with its baseline and writes the files.
   * Returns the result; a change does not fail the test, the reporter fails the run per
   * `failOn`. Throws when nothing could be captured (or not a stable screenshot).
   * `name` is unique per project; it becomes the file name.
   */
  screenshot(name: string, opts?: ScreenshotOptions): Promise<SnapshotResult>;
}

/** The reporter sets this env var in the runner (workers inherit it); its name is the fallback check. */
const usesReporter = (info: TestInfo) =>
  process.env.PIXELGATE_PLAYWRIGHT_REPORTER === '1' || info.config.reporter.some(([name]) => /pixelgate/.test(String(name)));

const firstLine = (e: unknown) => (e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e));

/** Images of a changed screenshot under the names Playwright's HTML report shows as a diff. */
async function attachImages(info: TestInfo, cfg: ResolvedConfig, name: string, r: SnapshotResult): Promise<void> {
  const files: Array<[string, string | undefined]> = [
    ['expected', r.baseline],
    ['actual', r.current],
    ['diff', r.diff],
  ];
  for (const [kind, rel] of files) {
    const file = rel && path.join(cfg.outDir, rel);
    if (file && existsSync(file)) await info.attach(`${name}-${kind}${path.extname(file)}`, { path: file });
  }
}

export const test = base.extend<{ pixelgateOptions: PixelgateOptions; pixelgate: Pixelgate }>({
  pixelgateOptions: [{}, { option: true }],
  pixelgate: async ({ page, browserName, pixelgateOptions }, use, info) => {
    if (!usesReporter(info)) {
      throw new Error(
        "pixelgate: add the pixelgate reporter to playwright.config, e.g. reporter: [['list'], ['pixelgate/playwright-reporter']]; " +
          'without it no report is written and nothing fails the run.',
      );
    }
    const cfg = configFor(pixelgateOptions, info, browserName);
    const target = cfg.targets[0]!;
    const matcher = createMatcher({ codec: cfg.codec, comparator: cfg.comparator.fn, options: cfg.comparator.options });
    const ext = `.${cfg.codec.extension}`;
    const log = watchPage(page, target.checks);
    // What each list held at the previous screenshot of this test.
    const reported = { pageErrors: 0, consoleErrors: 0, httpErrors: 0 };
    const names = new Set<string>();

    await use({
      async screenshot(name, opts = {}) {
        // Names that map to the same file (`a/b`, `a_b`) are the same snapshot.
        if (names.has(safeName(name))) throw new Error(`pixelgate.screenshot("${name}"): a snapshot with this file name was already taken in this test`);
        names.add(safeName(name));
        const snap: CaptureSnap = {
          name,
          fullPage: opts.fullPage,
          locator: opts.locator,
          mask: opts.mask?.filter((m): m is string => typeof m === 'string'),
          maskLocators: opts.mask?.filter((m): m is Locator => typeof m !== 'string'),
          maxHeight: opts.maxHeight,
          maxWidth: opts.maxWidth,
          includeOutlinesAndShadows: opts.includeOutlinesAndShadows,
          ariaSnapshot: opts.ariaSnapshot,
        };
        const baseline = baselinePath(cfg, target.dir, name, ext);
        const c: CaptureResult = { target: target.dir, name, reference: existsSync(baseline) ? await readFile(baseline) : null, pageErrors: [] };
        try {
          const { unreadableStylesheets } = await settle(page, snap, cfg);
          if (unreadableStylesheets.length) c.unreadableStylesheets = [...new Set(unreadableStylesheets)];
          await shoot(page, snap, cfg, target, matcher, c);
        } catch (e) {
          c.error = firstLine(e);
        }
        // What the page reported since the previous screenshot of this test.
        c.pageErrors = log.pageErrors.slice(reported.pageErrors);
        c.consoleErrors = log.consoleErrors.slice(reported.consoleErrors);
        c.httpErrors = log.httpErrors.slice(reported.httpErrors);
        reported.pageErrors = log.pageErrors.length;
        reported.consoleErrors = log.consoleErrors.length;
        reported.httpErrors = log.httpErrors.length;
        const r = await recordCapture(cfg, c, matcher.compare);
        const data: PixelgateAttachment = { outDir: cfg.outDir, failOn: cfg.failOn, result: r };
        await info.attach(ATTACHMENT, { body: JSON.stringify(data), contentType: 'application/json' });
        if (r.status !== 'unchanged') info.annotations.push({ type: 'pixelgate', description: `${name}: ${r.status}` });
        if (r.status === 'changed') await attachImages(info, cfg, name, r);
        if (r.status === 'error') throw new Error(`pixelgate.screenshot("${name}"): ${r.error}`);
        return r;
      },
    });
  },
});
