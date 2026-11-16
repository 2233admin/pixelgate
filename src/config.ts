import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { devices, type Page } from 'playwright';
import { CODECS, COMPARATORS, type Codec, type Comparator } from './compare.js';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type Status = 'unchanged' | 'changed' | 'added' | 'updated' | 'removed' | 'error';

/**
 * What to do with baselines (same three modes as Vitest's `updateSnapshot`):
 * - `new`  (local default): write missing baselines, never touch existing ones.
 * - `none` (CI default):    write nothing to baseline; a missing baseline is a failure.
 * - `all`  (`-u`):          write missing baselines and overwrite mismatching ones.
 */
export type UpdateMode = 'new' | 'none' | 'all';

/**
 * What happens to elements marked `data-pixelgate-hide` (Happo: `data-happo-hide` + `hideBehavior`):
 * - `hide`   (default): `visibility: hidden` while the screenshot is taken; the space stays.
 * - `ignore`: they stay visible in the page but are painted over with a solid box (Playwright
 *   `mask`), so their content never makes a diff.
 */
export type HideBehavior = 'hide' | 'ignore';

/** The attribute that marks content to hide or ignore. */
export const HIDE_ATTR = 'data-pixelgate-hide';

export interface Target {
  /** Browser engine. Default: the device's browser, else `chromium`. */
  browser?: BrowserName;
  /**
   * Emulate a device from Playwright's list (`'iPhone 15'`, `'Pixel 7'`, `'iPad Pro 11'`...):
   * its viewport, scale factor, user agent, touch and mobile mode. `viewport` and
   * `deviceScaleFactor` set here win over the device's.
   */
  device?: string;
  /** `WIDTHxHEIGHT`, e.g. `1280x720`. Default: the device's, else `1280x720`. */
  viewport?: string;
  deviceScaleFactor?: number;
  /** `prefers-color-scheme`. Default `light`. */
  colorScheme?: 'light' | 'dark' | 'no-preference';
  /** `prefers-reduced-motion`. Default `reduce`. */
  reducedMotion?: 'reduce' | 'no-preference';
  /** Headers sent with every request of this target. */
  extraHTTPHeaders?: Record<string, string>;
  /** Overrides the top-level `hideBehavior` for this target. */
  hideBehavior?: HideBehavior;
}

export interface PageSnap {
  /** Unique name; becomes the snapshot file name. */
  name: string;
  url: string;
  /** Capture only this element. Default: the whole page. */
  selector?: string;
  /** Wait for this selector to be visible before capturing. */
  waitFor?: string;
  /** Capture the full scrollable page (ignored when `selector` is set). Default true. */
  fullPage?: boolean;
  /**
   * Put the page into the state to capture (open a menu, select a row, fill a
   * form) with Playwright's own API. Runs after the page has loaded and
   * `waitFor` is visible, before the stability loop. TS/JS configs only.
   */
  beforeCapture?: (page: Page) => Promise<void> | void;
  /** Selectors painted over with a solid box in this snapshot, on top of the top-level `mask`. */
  mask?: string[];
}

export interface StorybookSource {
  /** Base URL of a running or static-served Storybook, e.g. `http://localhost:6006`. */
  url: string;
  /** Story id globs to include, e.g. `button--*`. Default: all. */
  include?: string[];
  exclude?: string[];
  /** Element to capture inside the story iframe. Default `#storybook-root`. */
  selector?: string;
  /** Selectors painted over in every story, on top of the top-level `mask`. */
  mask?: string[];
}

export interface ViteSource {
  /** `dev` runs the dev server; `preview` serves the production build. Default `dev`. */
  mode?: 'dev' | 'preview';
  /** Run `vite build` before `preview`. Default true. */
  build?: boolean;
  /** Vite project root, relative to the pixelgate config file. Default: the config file's directory. */
  root?: string;
  /** Vite config file, relative to `root`. Default: Vite's own lookup. */
  configFile?: string;
  /** Fixed port. Default: Vite's default, next free port if taken. */
  port?: number;
}

export interface ResolvedViteSource {
  mode: 'dev' | 'preview';
  build: boolean;
  root: string;
  configFile?: string;
  port?: number;
}

export interface Stabilize {
  /** Extra CSS injected before capture (e.g. hide clocks, ads). */
  css?: string;
  /** Extra settle time after load, ms. Default 0. */
  waitMs?: number;
  /** Freeze `Date.now()` to this ISO time. Default: off. */
  fixedTime?: string;
  /**
   * Keep capturing until two consecutive screenshots match (or one matches the
   * baseline), for at most this long. Unstable pages are reported as errors.
   * `0` = take a single screenshot. Default 5000.
   */
  stableTimeoutMs?: number;
  /**
   * Gap between captures in that loop, so two matching frames are at least
   * this far apart (a screenshot can be faster than a page's own updates).
   * Default 100.
   */
  stableIntervalMs?: number;
}

export interface Config {
  targets?: Record<string, Target>;
  /** Pages to capture. Relative URLs (`/settings`) resolve against the Vite server or `baseUrl`. */
  pages?: PageSnap[];
  storybook?: StorybookSource;
  /** Start the project's Vite server for the run and point relative page URLs at it. */
  vite?: ViteSource;
  /** Base for relative page URLs when not using `vite`, e.g. `http://localhost:3000`. */
  baseUrl?: string;
  /** Working directory for baseline/current/diff/report. Default `.pixelgate`. */
  outDir?: string;
  /** Per-pixel color distance tolerance, 0..1 (pixelmatch). Default 0.1. */
  threshold?: number;
  /** Changed-pixel ratio at or below which a snapshot still counts as unchanged (pixelmatch). Default 0. */
  maxDiffPixelRatio?: number;
  /**
   * Comparison algorithm: `pixelmatch` (default, exact pixels), `ssim`
   * (structural similarity, tolerant of anti-aliasing noise), or a name from
   * `comparators`. `options` go to the comparator.
   */
  comparator?: string | { name: string; options?: Record<string, unknown> };
  /** Register custom comparators by name (same contract as Vitest's). */
  comparators?: Record<string, Comparator<any>>;
  /** Image format for baseline/current files: `png` (default), `jpeg`, or a name from `codecs`. Diffs are always PNG. */
  format?: string;
  /** Register custom codecs by name. */
  codecs?: Record<string, Codec>;
  /** Parallel pages per browser. Default 4. */
  concurrency?: number;
  /** Navigation + readiness timeout per snapshot, ms. Default 30000. */
  timeoutMs?: number;
  stabilize?: Stabilize;
  /** What to do with `data-pixelgate-hide` elements. Default `hide`. */
  hideBehavior?: HideBehavior;
  /**
   * Selectors painted over with a solid box in every snapshot (dynamic content you
   * cannot mark with `data-pixelgate-hide`, e.g. third-party widgets).
   */
  mask?: string[];
  /** Color of masked boxes. Default `#FF00FF`. */
  maskColor?: string;
  /**
   * Block every request whose hostname matches none of these globs (`cdn.example.com`,
   * `*.example.com`), so third-party fonts, scripts and images cannot change or break a
   * snapshot. The hosts of the snapshot URLs themselves (Vite, `baseUrl`, Storybook) are
   * always allowed. `[]` = only those. Default: no blocking.
   */
  allowedHostnames?: string[];
  /** Baseline update mode. Default: `none` when `CI` is set, else `new`. */
  update?: UpdateMode;
  /**
   * Keep separate baselines per OS (`<target>-<platform>/`), since font
   * rasterisation differs between Windows, macOS and Linux. Default true.
   */
  platformSpecific?: boolean;
  /**
   * Statuses that make `run` exit non-zero.
   * Default `['changed', 'error']`, plus `'added'` when `update` is `none`.
   */
  failOn?: Status[];
}

export interface ResolvedTarget {
  name: string;
  /** Directory name under baseline/current/diff: `name`, or `name-platform`. */
  dir: string;
  browser: BrowserName;
  device?: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  screen?: { width: number; height: number };
  colorScheme: 'light' | 'dark' | 'no-preference';
  reducedMotion: 'reduce' | 'no-preference';
  extraHTTPHeaders?: Record<string, string>;
  hideBehavior: HideBehavior;
}

export interface ResolvedConfig {
  rootDir: string;
  outDir: string;
  targets: ResolvedTarget[];
  pages: PageSnap[];
  storybook?: StorybookSource;
  vite?: ResolvedViteSource;
  baseUrl?: string;
  threshold: number;
  maxDiffPixelRatio: number;
  comparator: { name: string; fn: Comparator<any>; options: Record<string, unknown> };
  codec: Codec;
  concurrency: number;
  timeoutMs: number;
  stabilize: Stabilize & { stableTimeoutMs: number; stableIntervalMs: number };
  mask: string[];
  maskColor?: string;
  allowedHostnames?: string[];
  update: UpdateMode;
  platformSpecific: boolean;
  failOn: Status[];
}

export interface ConfigOverrides {
  update?: UpdateMode;
}

/** Same rule of thumb as Vitest/std-env: `CI` set to anything but `false`/`0`. */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CI;
  return (v !== undefined && v !== '' && v !== 'false' && v !== '0') || !!env.GITHUB_ACTIONS || !!env.GITLAB_CI;
}

export function targetDir(name: string, platformSpecific: boolean, platform: string = process.platform): string {
  return platformSpecific ? `${name}-${platform}` : name;
}

const UPDATE_MODES: UpdateMode[] = ['new', 'none', 'all'];

export function defineConfig(config: Config): Config {
  return config;
}

export const CONFIG_FILES = [
  'pixelgate.config.ts',
  'pixelgate.config.mts',
  'pixelgate.config.js',
  'pixelgate.config.mjs',
  'pixelgate.config.json',
];

export function parseViewport(viewport: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(viewport.trim());
  if (!m) throw new Error(`Invalid viewport "${viewport}", expected WIDTHxHEIGHT like 1280x720`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const BROWSERS: BrowserName[] = ['chromium', 'firefox', 'webkit'];
const HIDE_BEHAVIORS: HideBehavior[] = ['hide', 'ignore'];

function resolveTarget(name: string, t: Target, platformSpecific: boolean, defaultHide: HideBehavior): ResolvedTarget {
  const dev = t.device === undefined ? undefined : devices[t.device];
  if (t.device !== undefined && !dev) {
    throw new Error(`Target "${name}": unknown device "${t.device}". Use a name from Playwright's device list, e.g. "iPhone 15" or "Pixel 7".`);
  }
  const browser = t.browser ?? (dev?.defaultBrowserType as BrowserName | undefined) ?? 'chromium';
  if (!BROWSERS.includes(browser)) throw new Error(`Target "${name}": unknown browser "${browser}"`);
  const isMobile = dev?.isMobile ?? false;
  // Fail at config time: inside the run this would be one crash for the whole target.
  if (isMobile && browser === 'firefox') {
    throw new Error(`Target "${name}": Firefox has no mobile emulation, so device "${t.device}" needs chromium or webkit`);
  }
  const hideBehavior = t.hideBehavior ?? defaultHide;
  if (!HIDE_BEHAVIORS.includes(hideBehavior)) throw new Error(`Target "${name}": \`hideBehavior\` must be "hide" or "ignore"`);
  return {
    name,
    dir: targetDir(name, platformSpecific),
    browser,
    device: t.device,
    // An explicit viewport wins; else the device's; the 1280x720 default only without either.
    ...(t.viewport ? parseViewport(t.viewport) : (dev?.viewport ?? parseViewport('1280x720'))),
    deviceScaleFactor: t.deviceScaleFactor ?? dev?.deviceScaleFactor ?? 1,
    isMobile,
    hasTouch: dev?.hasTouch ?? false,
    userAgent: dev?.userAgent,
    // At runtime descriptors carry `screen`, but `DeviceDescriptor` does not type it.
    screen: (dev as { screen?: { width: number; height: number } } | undefined)?.screen,
    colorScheme: t.colorScheme ?? 'light',
    reducedMotion: t.reducedMotion ?? 'reduce',
    extraHTTPHeaders: t.extraHTTPHeaders,
    hideBehavior,
  };
}

export function resolveConfig(config: Config, rootDir: string, overrides: ConfigOverrides = {}): ResolvedConfig {
  const update = overrides.update ?? config.update ?? (isCI() ? 'none' : 'new');
  if (!UPDATE_MODES.includes(update)) throw new Error(`\`update\` must be one of ${UPDATE_MODES.join(', ')}`);
  const platformSpecific = config.platformSpecific ?? true;

  const targetEntries = Object.entries(config.targets ?? { chromium: {} });
  if (targetEntries.length === 0) throw new Error('Config must define at least one target');
  const hideBehavior = config.hideBehavior ?? 'hide';
  const targets = targetEntries.map(([name, t]) => resolveTarget(name, t, platformSpecific, hideBehavior));
  const pages = config.pages ?? [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (!p.name || !p.url) throw new Error('Every page needs `name` and `url`');
    if (seen.has(p.name)) throw new Error(`Duplicate page name "${p.name}"`);
    seen.add(p.name);
  }
  if (pages.length === 0 && !config.storybook) {
    throw new Error('Config must define `pages` or `storybook`');
  }
  if (config.vite?.mode && !['dev', 'preview'].includes(config.vite.mode)) {
    throw new Error('`vite.mode` must be "dev" or "preview"');
  }

  const threshold = config.threshold ?? 0.1;
  if (threshold < 0 || threshold > 1) throw new Error('`threshold` must be within 0..1');
  const maxDiffPixelRatio = config.maxDiffPixelRatio ?? 0;

  const comparators = { ...COMPARATORS, ...config.comparators };
  const cmp = typeof config.comparator === 'string' ? { name: config.comparator } : (config.comparator ?? { name: 'pixelmatch' });
  const fn = comparators[cmp.name];
  if (!fn) throw new Error(`Unknown comparator "${cmp.name}". Available: ${Object.keys(comparators).join(', ')}`);
  // The top-level shortcuts are pixelmatch options; explicit options win.
  const cmpOptions = cmp.name === 'pixelmatch' ? { threshold, maxDiffPixelRatio, ...cmp.options } : { ...cmp.options };

  const codecs = { ...CODECS, ...config.codecs };
  const format = config.format ?? 'png';
  const codec = codecs[format];
  if (!codec) throw new Error(`Unknown format "${format}". Available: ${Object.keys(codecs).join(', ')}`);

  return {
    rootDir,
    outDir: path.resolve(rootDir, config.outDir ?? '.pixelgate'),
    targets,
    pages,
    storybook: config.storybook,
    vite: config.vite && {
      mode: config.vite.mode ?? 'dev',
      build: config.vite.build ?? true,
      root: path.resolve(rootDir, config.vite.root ?? '.'),
      configFile: config.vite.configFile,
      port: config.vite.port,
    },
    baseUrl: config.baseUrl,
    threshold,
    maxDiffPixelRatio,
    comparator: { name: cmp.name, fn, options: cmpOptions },
    codec,
    concurrency: Math.max(1, config.concurrency ?? 4),
    timeoutMs: config.timeoutMs ?? 30_000,
    stabilize: {
      ...config.stabilize,
      stableTimeoutMs: config.stabilize?.stableTimeoutMs ?? 5_000,
      stableIntervalMs: config.stabilize?.stableIntervalMs ?? 100,
    },
    mask: config.mask ?? [],
    maskColor: config.maskColor,
    allowedHostnames: config.allowedHostnames,
    update,
    platformSpecific,
    failOn: config.failOn ?? (update === 'none' ? ['changed', 'error', 'added'] : ['changed', 'error']),
  };
}

/** Find and load a config file. Node >=22.18 imports `.ts` configs natively (type stripping). */
export function findConfigFile(cwd: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(cwd, f)).find((f) => existsSync(f));
}

export async function loadConfig(cwd: string, explicit?: string, overrides: ConfigOverrides = {}): Promise<ResolvedConfig> {
  const file = explicit ? path.resolve(cwd, explicit) : findConfigFile(cwd);
  if (!file || !existsSync(file)) {
    throw new Error(`No config found. Create one of: ${CONFIG_FILES.join(', ')}`);
  }
  let raw: Config;
  if (file.endsWith('.json')) {
    raw = JSON.parse(await readFile(file, 'utf8')) as Config;
  } else {
    const mod = (await import(pathToFileURL(file).href)) as { default?: Config };
    if (!mod.default) throw new Error(`${file} must have a default export`);
    raw = mod.default;
  }
  return resolveConfig(raw, path.dirname(file), overrides);
}
