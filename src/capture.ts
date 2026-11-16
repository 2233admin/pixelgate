import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';
import type { PageSnap, ResolvedConfig, ResolvedTarget } from './config.js';
import { safeName } from './names.js';

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

export interface CaptureResult {
  target: string;
  name: string;
  file?: string;
  error?: string;
  /** Uncaught page errors seen while rendering. */
  pageErrors: string[];
}

export { safeName };

async function captureOne(page: Page, snap: PageSnap, cfg: ResolvedConfig, file: string): Promise<void> {
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

  const shotOpts = { path: file, animations: 'disabled' as const, caret: 'hide' as const, timeout: timeoutMs };
  if (snap.selector) {
    await page.locator(snap.selector).first().screenshot(shotOpts);
  } else {
    await page.screenshot({ ...shotOpts, fullPage: snap.fullPage ?? true });
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export async function captureAll(
  cfg: ResolvedConfig,
  snaps: PageSnap[],
  onProgress?: (r: CaptureResult) => void,
): Promise<CaptureResult[]> {
  const results: CaptureResult[] = [];
  for (const target of cfg.targets) {
    const dir = path.join(cfg.outDir, 'current', target.name);
    await mkdir(dir, { recursive: true });
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
        const file = path.join(dir, `${safeName(snap.name)}.png`);
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const r: CaptureResult = { target: target.name, name: snap.name, pageErrors };
        try {
          await captureOne(page, snap, cfg, file);
          r.file = file;
        } catch (e) {
          r.error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
        } finally {
          await page.close();
        }
        results.push(r);
        onProgress?.(r);
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  return results;
}
