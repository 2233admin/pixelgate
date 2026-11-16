import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';
import { imagesMatch, type MatchOptions } from './compare.js';
import type { PageSnap, ResolvedConfig, ResolvedTarget } from './config.js';
import { safeName } from './names.js';

export { safeName };

const ENGINES: Record<ResolvedTarget['browser'], BrowserType> = { chromium, firefox, webkit };

/** Kill motion and caret blink so two renders of the same UI are byte-stable. */
export const STABILIZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

export interface StableShot {
  buffer: Buffer;
  /** Two consecutive captures (or the first capture and the reference) matched. */
  stable: boolean;
  /** The very first capture matched the reference, so no comparison is needed later. */
  matchedReference: boolean;
  /** Extra captures taken before the page settled. */
  retries: number;
}

/**
 * Capture until the page holds still, the way Vitest's `toMatchScreenshot` does:
 * the reference (when there is one) is the first image to compare against, so an
 * unchanged page costs one screenshot; otherwise keep shooting until two
 * consecutive captures match, or give up after `timeoutMs` and report unstable.
 */
export async function stableShot(
  take: () => Promise<Buffer>,
  reference: Buffer | null,
  opts: MatchOptions & { timeoutMs: number },
): Promise<StableShot> {
  const first = await take();
  if (reference && imagesMatch(reference, first, opts)) {
    return { buffer: first, stable: true, matchedReference: true, retries: 0 };
  }
  if (opts.timeoutMs <= 0) return { buffer: first, stable: true, matchedReference: false, retries: 0 };

  const deadline = Date.now() + opts.timeoutMs;
  let previous = first;
  let retries = 0;
  while (Date.now() < deadline) {
    const next = await take();
    if (imagesMatch(previous, next, opts)) return { buffer: next, stable: true, matchedReference: false, retries };
    previous = next;
    retries++;
  }
  return { buffer: previous, stable: false, matchedReference: false, retries };
}

export interface CaptureResult {
  /** Target directory name (`ResolvedTarget.dir`). */
  target: string;
  name: string;
  shot?: StableShot;
  reference: Buffer | null;
  error?: string;
  /** Uncaught page errors seen while rendering. */
  pageErrors: string[];
}

async function prepare(page: Page, snap: PageSnap, cfg: ResolvedConfig): Promise<void> {
  const { stabilize, timeoutMs } = cfg;
  if (stabilize.fixedTime) await page.clock.setFixedTime(new Date(stabilize.fixedTime));
  await page.goto(snap.url, { waitUntil: 'load', timeout: timeoutMs });
  // Best effort: apps with long-polling never go idle, so don't fail on it.
  await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) }).catch(() => {});
  await page.addStyleTag({ content: STABILIZE_CSS + (stabilize.css ?? '') });
  if (snap.waitFor) await page.locator(snap.waitFor).first().waitFor({ state: 'visible', timeout: timeoutMs });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let images already in the DOM finish decoding.
    await Promise.all(
      Array.from(document.images, (img) => (img.complete ? null : img.decode().catch(() => null))),
    );
  });
  if (stabilize.waitMs) await page.waitForTimeout(stabilize.waitMs);
}

function shooter(page: Page, snap: PageSnap, timeoutMs: number): () => Promise<Buffer> {
  const opts = { animations: 'disabled' as const, caret: 'hide' as const, timeout: timeoutMs };
  return snap.selector
    ? () => page.locator(snap.selector!).first().screenshot(opts)
    : () => page.screenshot({ ...opts, fullPage: snap.fullPage ?? true });
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export interface CaptureHooks {
  /** Current baseline image for a snapshot, or null. */
  reference(targetDir: string, name: string): Promise<Buffer | null>;
  /** Called once per snapshot as soon as it is captured (or failed). */
  onCapture(result: CaptureResult): Promise<void>;
}

export async function captureAll(cfg: ResolvedConfig, snaps: PageSnap[], hooks: CaptureHooks): Promise<void> {
  const match = { threshold: cfg.threshold, maxDiffPixelRatio: cfg.maxDiffPixelRatio };
  for (const target of cfg.targets) {
    const browser = await ENGINES[target.browser].launch();
    try {
      const context = await browser.newContext({
        viewport: { width: target.width, height: target.height },
        deviceScaleFactor: target.deviceScaleFactor,
        reducedMotion: 'reduce',
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'UTC',
      });
      await pool(snaps, cfg.concurrency, async (snap) => {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const reference = await hooks.reference(target.dir, snap.name);
        const r: CaptureResult = { target: target.dir, name: snap.name, reference, pageErrors };
        try {
          await prepare(page, snap, cfg);
          r.shot = await stableShot(shooter(page, snap, cfg.timeoutMs), reference, {
            ...match,
            timeoutMs: cfg.stabilize.stableTimeoutMs,
          });
        } catch (e) {
          r.error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
        } finally {
          await page.close();
        }
        await hooks.onCapture(r);
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
}
