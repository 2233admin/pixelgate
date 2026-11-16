import { AxeBuilder } from '@axe-core/playwright';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Locator, type Page } from 'playwright';
import { normalizeAria } from './aria.js';
import { pngCodec, type Codec, type Matcher } from './compare.js';
import { HIDE_ATTR, IMPACTS, type A11yOptions, type PageSnap, type ResolvedConfig, type ResolvedTarget } from './config.js';
import type { A11yViolation } from './report.js';
import { safeName } from './names.js';
import { matchesAny } from './storybook.js';

export { safeName };

const ENGINES: Record<ResolvedTarget['browser'], BrowserType> = { chromium, firefox, webkit };

/**
 * A snapshot as capture sees it: a `pages`/Storybook entry, or a Playwright Test
 * `pixelgate.screenshot()` call, which brings its own page, element and mask locators.
 */
export type CaptureSnap = Omit<PageSnap, 'url'> & {
  url?: string;
  /** The element to capture; wins over `selector`. */
  locator?: Locator;
  /** Painted over like `mask` selectors. */
  maskLocators?: Locator[];
};

/** The element a snapshot captures (the first match), or undefined for the page. */
export const rootOf = (page: Page, snap: CaptureSnap): Locator | undefined =>
  snap.locator ?? (snap.selector ? page.locator(snap.selector).first() : undefined);

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
  /** Normalised ARIA snapshot, when `ariaSnapshot` is on for this snapshot. */
  aria?: string;
  /** Full size of a screenshot that `maxHeight`/`maxWidth` cut off. */
  capped?: { width: number; height: number };
  /** Stylesheets `applyPseudoClasses` could not read (other origins), so their rules were not forced. */
  unreadableStylesheets?: string[];
}

/** How far the page reaches past the right edge of the viewport, in CSS pixels (0 = fits). */
export async function measureOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** Marks the element a selector snapshot captured, so axe checks exactly that one. */
const AXE_SCOPE_ATTR = 'data-pixelgate-axe-scope';

/**
 * axe-core on the page, or on the element the screenshot captured when the snapshot has
 * a `selector`. The screenshot takes the first match (`locator().first()`), so axe must
 * too: `include(selector)` would check every match, and accept no Playwright selectors.
 */
export async function runAxe(page: Page, root: Locator | undefined, opts: Required<A11yOptions>): Promise<A11yViolation[]> {
  let axe = new AxeBuilder({ page }).withTags(opts.tags);
  if (opts.disableRules.length) axe = axe.disableRules(opts.disableRules);
  const scoped = root ? await root.evaluate((el, attr) => el.setAttribute(attr, ''), AXE_SCOPE_ATTR).then(() => true) : false;
  if (scoped) axe = axe.include(`[${AXE_SCOPE_ATTR}]`);
  let violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'];
  try {
    ({ violations } = await axe.analyze());
  } finally {
    if (scoped) await page.locator(`[${AXE_SCOPE_ATTR}]`).evaluateAll((els, attr) => els.forEach((e) => e.removeAttribute(attr)), AXE_SCOPE_ATTR);
  }
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

/** The pseudo-classes `applyPseudoClasses` forces, each through a `data-pixelgate-<name>` attribute. */
export const PSEUDO_CLASSES = ['hover', 'focus', 'focus-visible', 'active'] as const;

/**
 * Runs in the page (self-contained). Rewrites every readable CSS rule whose selector uses
 * `:hover`, `:focus`, `:focus-visible` or `:active` in place: `:hover` becomes
 * `:is(:hover, [data-pixelgate-hover])`, same specificity, same position. So marked
 * elements show that state, `:not(:hover)` stops matching them, and nested rules under a
 * forced parent follow. Walks `@media`/`@supports`/`@layer`/nesting, `@import`, adopted
 * sheets and open shadow roots. Returns the stylesheets it could not read.
 */
export function forcePseudoClasses(): string[] {
  const has = /:(hover|focus-visible|focus|active)(?![\w-])/;
  const all = /:(hover|focus-visible|focus|active)(?![\w-])/g;
  const unreadable: string[] = [];
  const done = new Set<CSSStyleSheet>();
  type Parent = { cssRules: CSSRuleList; insertRule(rule: string, index?: number): number };
  const walk = (parent: Parent) => {
    const list = parent.cssRules;
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!;
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) sheet(rule.styleSheet);
        continue;
      }
      if (rule instanceof CSSStyleRule && has.test(rule.selectorText)) {
        const from = rule.selectorText;
        rule.selectorText = from.replace(all, (m, p: string) => `:is(${m}, [data-pixelgate-${p}])`);
        // A browser without `:is()` keeps the old selector: then add a copy keyed on the attribute.
        if (rule.selectorText === from) {
          try {
            parent.insertRule(`${from.replace(all, (_m, p: string) => `[data-pixelgate-${p}]`)} { ${rule.style.cssText} }`, i + 1);
            i++;
          } catch {
            // A selector this context will not take: that state stays unforced.
          }
        }
      }
      const inner = rule as unknown as Partial<Parent>;
      if (inner.cssRules && typeof inner.insertRule === 'function') walk(inner as Parent);
    }
  };
  const sheet = (s: CSSStyleSheet) => {
    if (done.has(s)) return;
    done.add(s);
    try {
      void s.cssRules;
    } catch {
      unreadable.push(s.href ?? '(inline)');
      return;
    }
    walk(s);
  };
  const root = (r: Document | ShadowRoot) => {
    for (const s of Array.from(r.styleSheets)) sheet(s);
    for (const s of r.adoptedStyleSheets ?? []) sheet(s);
    for (const el of Array.from(r.querySelectorAll('*'))) if (el.shadowRoot) root(el.shadowRoot);
  };
  root(document);
  return unreadable;
}

async function navigate(page: Page, snap: PageSnap, cfg: ResolvedConfig): Promise<void> {
  const { stabilize, timeoutMs } = cfg;
  if (stabilize.fixedTime) await page.clock.setFixedTime(new Date(stabilize.fixedTime));
  await page.goto(snap.url, { waitUntil: 'load', timeout: timeoutMs });
  // Best effort: apps with long-polling never go idle, so don't fail on it.
  await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) }).catch(() => {});
}

/**
 * Brings a loaded page into a capturable state: motion frozen, `waitFor`/`beforeCapture`,
 * forced pseudo-classes, fonts and images ready. Returns the stylesheets
 * `applyPseudoClasses` could not read.
 */
export async function settle(page: Page, snap: CaptureSnap, cfg: ResolvedConfig): Promise<{ unreadableStylesheets: string[] }> {
  const { stabilize, timeoutMs } = cfg;
  await page.addStyleTag({ content: STABILIZE_CSS + (stabilize.css ?? '') });
  if (snap.waitFor) await page.locator(snap.waitFor).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (snap.beforeCapture) await snap.beforeCapture(page);
  // Before fonts and images settle: the forced rules may load some.
  const unreadableStylesheets: string[] = [];
  if (cfg.applyPseudoClasses) {
    for (const frame of page.frames()) {
      // A frame that navigates or detaches meanwhile has nothing to force.
      unreadableStylesheets.push(...(await frame.evaluate(forcePseudoClasses).catch(() => [])));
    }
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let images already in the DOM finish decoding.
    await Promise.all(
      Array.from(document.images, (img) => (img.complete ? null : img.decode().catch(() => null))),
    );
  });
  if (stabilize.waitMs) await page.waitForTimeout(stabilize.waitMs);
  return { unreadableStylesheets };
}

/** CSS applied only while a screenshot is taken; pierces shadow DOM and frames. */
export const HIDE_CSS = `[${HIDE_ATTR}] { visibility: hidden !important; }`;

/** Masked selectors for a snapshot: global, the snapshot's own, and hidden-but-ignored content. */
export function maskSelectors(cfg: Pick<ResolvedConfig, 'mask'>, snap: Pick<PageSnap, 'mask'>, target: Pick<ResolvedTarget, 'hideBehavior'>): string[] {
  return [...cfg.mask, ...(snap.mask ?? []), ...(target.hideBehavior === 'ignore' ? [`[${HIDE_ATTR}]`] : [])];
}

/**
 * The accessibility tree of what the screenshot captured: the selector's first match, or
 * the body. Hidden (`data-pixelgate-hide`) and masked elements are left out (`aria-hidden`),
 * since their content is what changes between runs. Runs last: it leaves those attributes.
 */
export async function captureAria(page: Page, snap: CaptureSnap, cfg: ResolvedConfig, target: ResolvedTarget): Promise<string> {
  const hidden = [...new Set([`[${HIDE_ATTR}]`, ...maskSelectors(cfg, snap, target)])].map((s) => page.locator(s));
  for (const l of [...hidden, ...(snap.maskLocators ?? [])]) {
    await l.evaluateAll((els) => els.forEach((e) => e.setAttribute('aria-hidden', 'true')));
  }
  const root = rootOf(page, snap) ?? page.locator('body');
  // `ariaSnapshot` has no timeout by default.
  return normalizeAria(await root.ariaSnapshot({ timeout: cfg.timeoutMs }));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Runs in the page (self-contained). The element's box in page coordinates, grown (when
 * `grow`) by the outlines and box-shadows of the element and its descendants, rounded
 * outward and kept inside the document.
 */
export function elementBox(el: Element, grow: boolean): Box {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  if (grow) {
    const px = (s: string) => (s.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    const add = (e: Element) => {
      const cs = getComputedStyle(e);
      let l = 0;
      let t = 0;
      let r = 0;
      let b = 0;
      if (cs.outlineStyle !== 'none') {
        const w = parseFloat(cs.outlineWidth) || 0;
        l = t = r = b = (cs.outlineStyle === 'auto' ? Math.max(3, w) : w) + Math.max(0, parseFloat(cs.outlineOffset) || 0);
      }
      if (cs.boxShadow && cs.boxShadow !== 'none') {
        // Commas inside rgb()/rgba() do not separate shadows.
        for (const shadow of cs.boxShadow.split(/,(?![^(]*\))/)) {
          if (/\binset\b/.test(shadow)) continue;
          const [x = 0, y = 0, blur = 0, spread = 0] = px(shadow);
          const reach = spread + blur;
          l = Math.max(l, reach - x);
          r = Math.max(r, reach + x);
          t = Math.max(t, reach - y);
          b = Math.max(b, reach + y);
        }
      }
      if (!(l || t || r || b)) return;
      const box = e.getBoundingClientRect();
      if (!box.width && !box.height) return;
      // Outlines and shadows are in the element's own (untransformed) pixels; the box includes
      // transforms of the element and its ancestors. Scale the extents the same way (a rotation
      // overestimates them, which keeps the decoration in the crop).
      const own = e as HTMLElement;
      const sx = own.offsetWidth ? box.width / own.offsetWidth : 1;
      const sy = own.offsetHeight ? box.height / own.offsetHeight : 1;
      left = Math.min(left, box.left - l * sx);
      top = Math.min(top, box.top - t * sy);
      right = Math.max(right, box.right + r * sx);
      bottom = Math.max(bottom, box.bottom + b * sy);
    };
    add(el);
    for (const d of Array.from(el.querySelectorAll('*'))) add(d);
  }
  const doc = document.documentElement;
  const width = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const height = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const x0 = Math.max(0, Math.floor(left + scrollX));
  const y0 = Math.max(0, Math.floor(top + scrollY));
  const x1 = Math.min(width, Math.ceil(right + scrollX));
  const y1 = Math.min(height, Math.ceil(bottom + scrollY));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Runs in the page. Size of the whole scrollable page. */
function pageSize(): { width: number; height: number } {
  const doc = document.documentElement;
  return {
    width: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0),
    height: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
}

/** `box` cut to the caps (0 = none); `capped` is the full size when it was cut. */
export function capBox(box: Box, maxWidth: number, maxHeight: number): { clip: Box; capped?: { width: number; height: number } } {
  const width = maxWidth > 0 ? Math.min(box.width, maxWidth) : box.width;
  const height = maxHeight > 0 ? Math.min(box.height, maxHeight) : box.height;
  const clip = { ...box, width, height };
  return width < box.width || height < box.height ? { clip, capped: { width: box.width, height: box.height } } : { clip };
}

export interface Shooter {
  take(): Promise<Buffer>;
  /** Set by the last `take()` when the caps cut the screenshot. */
  capped?: { width: number; height: number };
}

/**
 * Screenshots in the codec's format: natively when Playwright supports it, else PNG re-encoded.
 * Within the caps and without grown crops this is the plain page/locator screenshot; otherwise
 * a clip of the full page, so crops can reach outside the element and pages stop at the cap.
 */
function shooter(page: Page, snap: CaptureSnap, cfg: ResolvedConfig, target: ResolvedTarget, codec: Codec): Shooter {
  const native = codec.screenshot;
  const masks = maskSelectors(cfg, snap, target);
  const opts = {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    timeout: cfg.timeoutMs,
    type: native?.type ?? 'png',
    ...(native?.type === 'jpeg' && native.quality !== undefined ? { quality: native.quality } : {}),
    ...(target.hideBehavior === 'hide' ? { style: HIDE_CSS } : {}),
    ...(masks.length || snap.maskLocators?.length ? { mask: [...masks.map((s) => page.locator(s)), ...(snap.maskLocators ?? [])] } : {}),
    ...(cfg.maskColor ? { maskColor: cfg.maskColor } : {}),
  };
  const maxWidth = snap.maxWidth ?? target.maxWidth;
  const maxHeight = snap.maxHeight ?? target.maxHeight;
  const capping = maxWidth > 0 || maxHeight > 0;
  const grow = snap.includeOutlinesAndShadows ?? cfg.includeOutlinesAndShadows;
  const s: Shooter = { take: async () => Buffer.alloc(0) };
  const clipped = (clip: Box) => page.screenshot({ ...opts, fullPage: true, clip });
  const raw = async (): Promise<Buffer> => {
    s.capped = undefined;
    const el = rootOf(page, snap);
    if (el) {
      if (!grow && !capping) return el.screenshot(opts);
      // Waits for the element like the screenshot call does, within the snapshot timeout.
      const { clip, capped } = capBox(await el.evaluate(elementBox, grow, { timeout: cfg.timeoutMs }), maxWidth, maxHeight);
      s.capped = capped;
      return grow || capped ? clipped(clip) : el.screenshot(opts);
    }
    const fullPage = snap.fullPage ?? true;
    if (!fullPage || !capping) return page.screenshot({ ...opts, fullPage });
    const { clip, capped } = capBox({ x: 0, y: 0, ...(await page.evaluate(pageSize)) }, maxWidth, maxHeight);
    s.capped = capped;
    return capped ? clipped(clip) : page.screenshot({ ...opts, fullPage: true });
  };
  s.take = native ? raw : async () => codec.encode(pngCodec.decode(await raw()));
  return s;
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

/**
 * The capture itself, on a page already in the state to capture: a stable screenshot
 * (compared against `r.reference` first), then the checks and the ARIA snapshot of what
 * was captured. Fills in `r`; throws on a capture error.
 */
export async function shoot(
  page: Page,
  snap: CaptureSnap,
  cfg: ResolvedConfig,
  target: ResolvedTarget,
  matcher: Matcher,
  r: CaptureResult,
): Promise<void> {
  const shooting = shooter(page, snap, cfg, target, matcher.codec);
  r.shot = await stableShot(() => shooting.take(), r.reference, {
    same: matcher.same,
    timeoutMs: cfg.stabilize.stableTimeoutMs,
    intervalMs: cfg.stabilize.stableIntervalMs,
  });
  if (shooting.capped) r.capped = shooting.capped;
  // Checks run on the state that was captured, after the screenshot so they cannot change it.
  if (target.checks.overflow) {
    const px = await measureOverflow(page);
    if (px > 0) r.overflowPx = px;
  }
  if (target.checks.a11y) {
    const v = await runAxe(page, rootOf(page, snap), target.checks.a11y);
    if (v.length) r.a11y = v;
  }
  if (snap.ariaSnapshot ?? target.ariaSnapshot) r.aria = await captureAria(page, snap, cfg, target);
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
          await navigate(page, snap, cfg);
          const { unreadableStylesheets } = await settle(page, snap, cfg);
          if (unreadableStylesheets.length) r.unreadableStylesheets = [...new Set(unreadableStylesheets)];
          await shoot(page, snap, cfg, target, matcher, r);
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
