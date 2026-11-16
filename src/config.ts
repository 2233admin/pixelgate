import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type Status = 'unchanged' | 'changed' | 'added' | 'removed' | 'error';

export interface Target {
  /** Browser engine. Default `chromium`. */
  browser?: BrowserName;
  /** `WIDTHxHEIGHT`, e.g. `1280x720`. Default `1280x720`. */
  viewport?: string;
  deviceScaleFactor?: number;
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
}

export interface StorybookSource {
  /** Base URL of a running or static-served Storybook, e.g. `http://localhost:6006`. */
  url: string;
  /** Story id globs to include, e.g. `button--*`. Default: all. */
  include?: string[];
  exclude?: string[];
  /** Element to capture inside the story iframe. Default `#storybook-root`. */
  selector?: string;
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
  /** Changed-pixel ratio at or below which a snapshot still counts as unchanged. Default 0. */
  maxDiffPixelRatio?: number;
  /** Parallel pages per browser. Default 4. */
  concurrency?: number;
  /** Navigation + readiness timeout per snapshot, ms. Default 30000. */
  timeoutMs?: number;
  stabilize?: Stabilize;
  /** Statuses that make `run` exit non-zero. Default `['changed', 'error']`. */
  failOn?: Status[];
}

export interface ResolvedTarget {
  name: string;
  browser: BrowserName;
  width: number;
  height: number;
  deviceScaleFactor: number;
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
  concurrency: number;
  timeoutMs: number;
  stabilize: Stabilize;
  failOn: Status[];
}

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

export function resolveConfig(config: Config, rootDir: string): ResolvedConfig {
  const targetEntries = Object.entries(config.targets ?? { chromium: {} });
  if (targetEntries.length === 0) throw new Error('Config must define at least one target');
  const targets = targetEntries.map(([name, t]) => {
    const browser = t.browser ?? 'chromium';
    if (!BROWSERS.includes(browser)) throw new Error(`Target "${name}": unknown browser "${browser}"`);
    return {
      name,
      browser,
      ...parseViewport(t.viewport ?? '1280x720'),
      deviceScaleFactor: t.deviceScaleFactor ?? 1,
    };
  });

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
    maxDiffPixelRatio: config.maxDiffPixelRatio ?? 0,
    concurrency: Math.max(1, config.concurrency ?? 4),
    timeoutMs: config.timeoutMs ?? 30_000,
    stabilize: config.stabilize ?? {},
    failOn: config.failOn ?? ['changed', 'error'],
  };
}

/** Find and load a config file. Node >=22.18 imports `.ts` configs natively (type stripping). */
export function findConfigFile(cwd: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(cwd, f)).find((f) => existsSync(f));
}

export async function loadConfig(cwd: string, explicit?: string): Promise<ResolvedConfig> {
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
  return resolveConfig(raw, path.dirname(file));
}
