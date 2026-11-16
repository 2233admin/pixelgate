import { AxeBuilder } from '@axe-core/playwright';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { pngCodec, type Codec, type Matcher } from './compare.js';
import { HIDE_ATTR, IMPACTS, type A11yOptions, type PageSnap, type ResolvedConfig, type ResolvedTarget } from './config.js';
import type { A11yViolation } from './report.js';
import { safeName } from './names.js';
import { matchesAny } from './storybook.js';

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
  opts: { same: Matcher['same']; timeoutMs: number; intervalMs?: number },
): Promise<StableShot> {
  const first = await take();
  if (reference && (await opts.same(reference, first))) {
    return { buffer: first, stable: true, matchedReference: true, retries: 0 };
  }
  if (opts.timeoutMs <= 0) return { buffer: first, stable: true, matchedReference: false, retries: 0 };

  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 0;
  let previous = first;
  let retries = 0;
  while (Date.now() < deadline) {
    // A screenshot can take ~15 ms, faster than a 30 ms JS ticker: back-to-back
    // shots may catch the same frame and look "stable". Space them out.
    if (interval > 0) await new Promise((r) => setTimeout(r, interval));
    const next = await take();
    if (await opts.same(previous, next)) return { buffer: next, stable: true, matchedReference: false, retries };
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
  /** Hostnames whose requests `allowedHostnames` blocked while rendering. */
  blocked?: string[];
  a11y?: A11yViolation[];
  overflowPx?: number;
}

/** How far the page reaches past the right edge of the viewport, in CSS pixels (0 = fits). */
export async function measureOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** axe-core on the page, scoped to `selector` when it is plain CSS (axe cannot read Playwright selectors). */
export async function runAxe(page: Page, selector: string | undefined, opts: Required<A11yOptions>): Promise<A11yViolation[]> {
  let axe = new AxeBuilder({ page }).withTags(opts.tags);
  if (opts.disableRules.length) axe = axe.disableRules(opts.disableRules);
  if (selector) {
    const css = await page.evaluate((s) => {
      try {
        document.querySelector(s);
        return true;
      } catch {
        return false;
      }
    }, selector);
    if (css) axe = axe.include(selector);
  }
  const { violations } = await axe.analyze();
  const min = IMPACTS.indexOf(opts.minImpact);
  return violations
    .filter((v) => IMPACTS.indexOf(v.impact ?? 'minor') >= min)
    .map((v) => ({
      id: v.id,
      ...(v.impact ? { impact: v.impact } : {}),
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.map(String).join(' ')),
    }));
}

/** `URL.hostname` keeps IPv6 brackets (`[::1]`); globs and reports use the bare address. */
export const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/**
 * Hostname globs a run may load from: the configured ones plus the hosts of the snapshot
 * URLs themselves (the Vite server, `baseUrl`, Storybook), which only exist at run time.
 */
export function allowList(allowedHostnames: string[], snaps: PageSnap[]): string[] {
  const own = new Set<string>();
  for (const s of snaps) {
    try {
      const host = bareHost(new URL(s.url).hostname);
      if (host) own.add(host);
    } catch {
      // Not a URL; navigation reports it.
    }
  }
  return [...allowedHostnames, ...own];
}

/** Whether a request may leave the browser. Only http(s)/ws(s) URLs are checked. */
export function isAllowed(url: string, allow: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Throwing in a route handler would leave the request hanging; let the browser deal with it.
    return true;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return true;
  return matchesAny(bareHost(u.hostname), allow);
}

async function prepare(page: Page, snap: PageSnap, cfg: ResolvedConfig): Promise<void> {
  const { stabilize, timeoutMs } = cfg;
  if (stabilize.fixedTime) await page.clock.setFixedTime(new Date(stabilize.fixedTime));
  await page.goto(snap.url, { waitUntil: 'load', timeout: timeoutMs });
  // Best effort: apps with long-polling never go idle, so don't fail on it.
  await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) }).catch(() => {});
  await page.addStyleTag({ content: STABILIZE_CSS + (stabilize.css ?? '') });
  if (snap.waitFor) await page.locator(snap.waitFor).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (snap.beforeCapture) await snap.beforeCapture(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let images already in the DOM finish decoding.
    await Promise.all(
      Array.from(document.images, (img) => (img.complete ? null : img.decode().catch(() => null))),
    );
  });
  if (stabilize.waitMs) await page.waitForTimeout(stabilize.waitMs);
}

/** CSS applied only while a screenshot is taken; pierces shadow DOM and frames. */
export const HIDE_CSS = `[${HIDE_ATTR}] { visibility: hidden !important; }`;

/** Masked selectors for a snapshot: global, the snapshot's own, and hidden-but-ignored content. */
export function maskSelectors(cfg: Pick<ResolvedConfig, 'mask'>, snap: PageSnap, target: Pick<ResolvedTarget, 'hideBehavior'>): string[] {
  return [...cfg.mask, ...(snap.mask ?? []), ...(target.hideBehavior === 'ignore' ? [`[${HIDE_ATTR}]`] : [])];
}

/** Screenshots in the codec's format: natively when Playwright supports it, else PNG re-encoded. */
function shooter(page: Page, snap: PageSnap, cfg: ResolvedConfig, target: ResolvedTarget, codec: Codec): () => Promise<Buffer> {
  const native = codec.screenshot;
  const masks = maskSelectors(cfg, snap, target);
  const opts = {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    timeout: cfg.timeoutMs,
    type: native?.type ?? 'png',
    ...(native?.type === 'jpeg' && native.quality !== undefined ? { quality: native.quality } : {}),
    ...(target.hideBehavior === 'hide' ? { style: HIDE_CSS } : {}),
    ...(masks.length ? { mask: masks.map((s) => page.locator(s)) } : {}),
    ...(cfg.maskColor ? { maskColor: cfg.maskColor } : {}),
  };
  const raw = snap.selector
    ? () => page.locator(snap.selector!).first().screenshot(opts)
    : () => page.screenshot({ ...opts, fullPage: snap.fullPage ?? true });
  return native ? raw : async () => codec.encode(pngCodec.decode(await raw()));
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

async function newContext(browser: Browser, target: ResolvedTarget, allow: string[] | undefined): Promise<{
  context: BrowserContext;
  blocked: Map<Page, Set<string>>;
}> {
  const context = await browser.newContext({
    viewport: { width: target.width, height: target.height },
    deviceScaleFactor: target.deviceScaleFactor,
    isMobile: target.isMobile,
    hasTouch: target.hasTouch,
    ...(target.userAgent ? { userAgent: target.userAgent } : {}),
    ...(target.screen ? { screen: target.screen } : {}),
    reducedMotion: target.reducedMotion,
    colorScheme: target.colorScheme,
    locale: 'en-US',
    timezoneId: 'UTC',
    ...(target.extraHTTPHeaders ? { extraHTTPHeaders: target.extraHTTPHeaders } : {}),
    // Requests made by a service worker bypass routing; with an allowlist, have none.
    ...(allow ? { serviceWorkers: 'block' as const } : {}),
  });
  const blocked = new Map<Page, Set<string>>();
  // Only route when asked: a routed context gets no HTTP cache.
  if (allow) {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (isAllowed(req.url(), allow)) return route.continue();
      try {
        blocked.get(req.frame().page())?.add(bareHost(new URL(req.url()).hostname));
      } catch {
        // No frame (e.g. a worker): still blocked, just not attributed.
      }
      return route.abort('blockedbyclient');
    });
  }
  return { context, blocked };
}

export async function captureAll(cfg: ResolvedConfig, snaps: PageSnap[], matcher: Matcher, hooks: CaptureHooks): Promise<void> {
  const allow = cfg.allowedHostnames && allowList(cfg.allowedHostnames, snaps);
  for (const target of cfg.targets) {
    const browser = await ENGINES[target.browser].launch();
    try {
      let ctx: Awaited<ReturnType<typeof newContext>>;
      try {
        ctx = await newContext(browser, target, allow);
      } catch (e) {
        // One bad target (e.g. an emulation the engine rejects) fails its snapshots, not the run.
        const error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
        for (const snap of snaps) {
          await hooks.onCapture({ target: target.dir, name: snap.name, reference: null, error, pageErrors: [] });
        }
        continue;
      }
      const { context, blocked } = ctx;
      await pool(snaps, cfg.concurrency, async (snap) => {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const hosts = new Set<string>();
        blocked.set(page, hosts);
        // WebSockets bypass `context.route`; give them the same allowlist.
        if (allow) {
          await page.routeWebSocket(
            () => true,
            (ws) => {
              if (isAllowed(ws.url(), allow)) return void ws.connectToServer();
              try {
                hosts.add(bareHost(new URL(ws.url()).hostname));
              } catch {
                // Unparseable URL: still closed.
              }
              return ws.close({ code: 1008, reason: 'blocked by pixelgate allowedHostnames' });
            },
          );
        }
        const reference = await hooks.reference(target.dir, snap.name);
        const r: CaptureResult = { target: target.dir, name: snap.name, reference, pageErrors };
        try {
          await prepare(page, snap, cfg);
          r.shot = await stableShot(shooter(page, snap, cfg, target, matcher.codec), reference, {
            same: matcher.same,
            timeoutMs: cfg.stabilize.stableTimeoutMs,
            intervalMs: cfg.stabilize.stableIntervalMs,
          });
          // Checks run on the state that was captured, after the screenshot so they cannot change it.
          if (target.checks.overflow) {
            const px = await measureOverflow(page);
            if (px > 0) r.overflowPx = px;
          }
          if (target.checks.a11y) {
            const v = await runAxe(page, snap.selector, target.checks.a11y);
            if (v.length) r.a11y = v;
          }
        } catch (e) {
          r.error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
        } finally {
          if (hosts.size) r.blocked = [...hosts].sort();
          blocked.delete(page);
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
