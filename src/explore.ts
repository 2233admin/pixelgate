import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { allowList, bareHost, isAllowed, watchPage, type PageLog } from './capture.js';
import { findConfigFile, loadConfig, type PageSnap, type ResolvedChecks } from './config.js';
import { MAX_LOGGED, type HttpError } from './report.js';

/**
 * `pixelgate explore`: property-based exploration. The engine (Bombadil, vendored in engine/)
 * clicks and types through the page and checks LTL properties; Playwright owns the browser,
 * so pixelgate's config (headers, host blocking) applies and the engine attaches over CDP.
 */

export interface ExploreOptions {
  /** Origin the exploration starts at. */
  url: string;
  /** Bombadil-compatible specification file (TS/JS). Default: the engine's built-in properties. */
  spec?: string;
  /** Engine binary. Default: `PIXELGATE_ENGINE`. */
  engine?: string;
  /** Engine time limit: a number with s/m/h/d suffix. Default `60s`. */
  timeLimit?: string;
  /** Keep exploring after the first violation (default: the engine stops at it). */
  keepGoing?: boolean;
  headed?: boolean;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  /** Exploration boundary as Chrome match patterns, passed through. */
  allowUrl?: string[];
  /** Pixelgate config file; else the default one in `cwd` when there is one. */
  config?: string;
  /** Output root; default the config's `outDir`, else `.pixelgate`. Output goes to `<outDir>/explore/`. */
  outDir?: string;
  cwd?: string;
  /** Do not echo the engine's output to stderr (it is still saved to `engine.log`). */
  quietEngine?: boolean;
  /** Progress lines (default: stderr). */
  log?: (msg: string) => void;
}

export interface ExploreState {
  index: number;
  /** Engine clock, microseconds since the epoch. */
  timestamp: number;
  url: string;
  /** The action that led to this state; empty for the first. */
  action: string;
  /** Relative to the explore dir, forward slashes. */
  screenshot?: string;
  violations: string[];
}

export interface ExploreViolation {
  name: string;
  stateIndex: number;
  /** Source of the failing condition, when the engine reported one. */
  condition?: string;
  /** The values the condition saw. */
  snapshots: unknown[];
}

export interface ExploreReport {
  url: string;
  spec?: string;
  timeLimit: string;
  startedAt: string;
  durationMs: number;
  engineExitCode: number | null;
  /** Why the run is not a clean 0/1 verdict: engine error, stall, unreadable trace. */
  error?: string;
  exitCode: 0 | 1 | 2;
  states: ExploreState[];
  violations: ExploreViolation[];
  pageErrors: string[];
  consoleErrors: string[];
  httpErrors: HttpError[];
  /** Distinct console errors / failed requests past `MAX_LOGGED`. */
  consoleErrorsDropped?: number;
  httpErrorsDropped?: number;
}

export interface ExploreResult {
  /** 0 = no violations, 1 = violations, 2 = engine/trace problem. */
  exitCode: 0 | 1 | 2;
  report: ExploreReport;
  /** `<outDir>/explore`. */
  dir: string;
}

// --- trace parsing ---------------------------------------------------------------------------
// The engine's trace JSON is unversioned upstream: read what we know, default the rest.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** One-line summary of an engine action such as `{"Click":{"fingerprint":{...},"point":{...}}}`. */
export function summarizeAction(action: unknown): string {
  if (action === null || action === undefined) return '';
  if (typeof action === 'string') return action;
  if (!isObj(action)) return JSON.stringify(action);
  const [kind] = Object.keys(action);
  if (!kind) return '';
  const v = action[kind];
  if (!isObj(v)) return v === null || v === undefined || v === true ? kind : `${kind} ${JSON.stringify(v)}`;
  const parts: string[] = [kind];
  const fp = isObj(v.fingerprint) ? v.fingerprint : undefined;
  if (fp) {
    const tag = str(fp.tag) ?? '';
    const id = str(fp.id);
    const text = str(fp.text_content) ?? str(fp.textContent);
    parts.push(`${tag}${id ? `#${id}` : ''}`.trim() || 'element');
    if (text) parts.push(JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text));
  }
  for (const k of ['text', 'key', 'code', 'url']) {
    const s = str(v[k]);
    if (s !== undefined) parts.push(`${k}=${JSON.stringify(s)}`);
  }
  if (isObj(v.point) && typeof v.point.x === 'number' && typeof v.point.y === 'number') {
    parts.push(`@${Math.round(v.point.x)},${Math.round(v.point.y)}`);
  }
  return parts.join(' ');
}

/**
 * The innermost `condition` (and the `snapshots` next to it) in a violation. Upstream nests
 * it under `Always`/`Eventually`/`False`/... wrappers that change between versions, so walk.
 */
export function findCondition(violation: unknown): { condition?: string; snapshots: unknown[] } {
  let best: { depth: number; condition: string; snapshots: unknown[] } | undefined;
  const walk = (v: unknown, depth: number) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    const condition = str(v.condition);
    if (condition !== undefined && (!best || depth >= best.depth)) {
      best = { depth, condition, snapshots: Array.isArray(v.snapshots) ? v.snapshots : [] };
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(violation, 0);
  if (best) return { condition: best.condition, snapshots: best.snapshots };
  // No condition anywhere: keep any snapshots so the report still shows something.
  let snapshots: unknown[] = [];
  const find = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(find);
    if (!isObj(v)) return;
    if (!snapshots.length && Array.isArray(v.snapshots)) snapshots = v.snapshots;
    Object.values(v).forEach(find);
  };
  find(violation);
  return { snapshots };
}

export interface ParsedTrace {
  states: ExploreState[];
  violations: ExploreViolation[];
  /** Lines that were not JSON objects. */
  badLines: number;
}

/** Parse `trace --json` output (one JSON object per state). Unknown fields are ignored. */
export function parseTrace(jsonl: string): ParsedTrace {
  const states: ExploreState[] = [];
  const violations: ExploreViolation[] = [];
  let badLines = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isObj(o)) {
      badLines++;
      continue;
    }
    const meta = isObj(o.metadata) ? o.metadata : {};
    const state = isObj(meta.state) ? meta.state : {};
    const index = typeof o.index === 'number' ? o.index : states.length;
    const file = str(o.screenshot_file);
    const vs = Array.isArray(meta.violations) ? meta.violations : [];
    const names: string[] = [];
    for (const v of vs) {
      if (!isObj(v)) continue;
      const name = str(v.name) ?? 'unnamed';
      names.push(name);
      violations.push({ name, stateIndex: index, ...findCondition(v.violation) });
    }
    states.push({
      index,
      timestamp: typeof meta.timestamp === 'number' ? meta.timestamp : 0,
      url: str(state.url) ?? '',
      action: summarizeAction(meta.action),
      // The engine prints an absolute, platform-specific path; the file name is `<index>.<ext>`.
      ...(file ? { screenshot: `states/${file.split(/[\\/]/).pop()}` } : {}),
      violations: names,
    });
  }
  return { states, violations, badLines };
}

/** Verdict from the trace, not from the engine's own exit code (its usage errors exit 2 too). */
export function exitCodeFor(violations: number, engineExit: number | null, traceOk: boolean): 0 | 1 | 2 {
  if (traceOk && violations > 0) return 1;
  if (traceOk && engineExit === 0) return 0;
  return 2;
}

// --- helpers ---------------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The engine's `--time-limit` syntax: a number with an s/m/h/d suffix. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text.trim());
  if (!m) throw new Error(`--time-limit "${text}": use a number with a unit suffix, e.g. 30s, 5m, 1h`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

/** Exploration clicks everything, so say so when the origin is not a local one. */
export function isLocalOrigin(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  const host = bareHost(u.hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

/** Watchdog margin on top of the engine's own time limit. */
const GRACE_MS = 60_000;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // The engine may have children; `child.kill()` would leave them running.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function readDebugPort(userDataDir: string, timeoutMs = 10_000): Promise<number> {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const port = Number((await readFile(file, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error(`Chromium did not report a debugging port (${file}) within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Run a command to completion, collecting stdout. */
function capture(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
  });
}

const distinct = <T>(items: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(key(i)) && seen.add(key(i)));
};

const CHECKS: ResolvedChecks = { overflow: false, consoleErrors: { ignore: [] }, httpErrors: { ignore: [] } };

// --- the run ---------------------------------------------------------------------------------

export async function explore(opts: ExploreOptions): Promise<ExploreResult> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const cwd = opts.cwd ?? process.cwd();

  let origin: URL;
  try {
    origin = new URL(opts.url);
  } catch {
    throw new Error(`explore: "${opts.url}" is not a URL (use e.g. http://localhost:3000 or file:///path/page.html)`);
  }
  if (!['http:', 'https:', 'file:'].includes(origin.protocol)) throw new Error(`explore: unsupported URL scheme "${origin.protocol}"`);

  const engine = opts.engine ?? process.env.PIXELGATE_ENGINE;
  if (!engine) throw new Error('explore: no engine binary. Pass --engine <path> or set PIXELGATE_ENGINE (build it per engine/README.md)');
  if (!existsSync(engine)) throw new Error(`explore: engine binary not found: ${engine}`);
  const spec = opts.spec ? path.resolve(cwd, opts.spec) : undefined;
  if (spec && !existsSync(spec)) throw new Error(`explore: specification file not found: ${spec}`);
  const timeLimit = opts.timeLimit ?? '60s';
  const limitMs = parseDuration(timeLimit);
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const scale = opts.deviceScaleFactor ?? 1;

  // The config is optional here: explore needs no pages, only its output dir and network settings.
  const cfgFile = opts.config ?? findConfigFile(cwd);
  const cfg = cfgFile ? await loadConfig(cwd, cfgFile) : undefined;
  const outRoot = opts.outDir ? path.resolve(cwd, opts.outDir) : (cfg?.outDir ?? path.resolve(cwd, '.pixelgate'));
  const dir = path.join(outRoot, 'explore');
  const statesDir = path.join(dir, 'states');
  const tracePath = path.join(dir, 'trace.bin');
  // Headers come from the first Chromium target: this is a Chromium-only command.
  const headers = cfg?.targets.find((t) => t.browser === 'chromium')?.extraHTTPHeaders;
  const allow = cfg?.allowedHostnames && allowList(cfg.allowedHostnames, [{ name: 'explore', url: opts.url } satisfies PageSnap]);

  await rm(dir, { recursive: true, force: true });
  await mkdir(statesDir, { recursive: true });

  if (!isLocalOrigin(opts.url)) {
    log(`warning: ${origin.origin} is not a local origin. Exploration clicks every button and submits every form it finds, including destructive ones.`);
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'pixelgate-explore-'));
  let context: BrowserContext | undefined;
  let child: ChildProcess | undefined;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    if (child) killTree(child);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const logs: PageLog[] = [];
  const blockedHosts = new Set<string>();
  let engineExit: number | null = null;
  let error: string | undefined;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: !opts.headed,
      viewport: { width, height },
      deviceScaleFactor: scale,
      args: ['--remote-debugging-port=0'],
      ...(headers ? { extraHTTPHeaders: headers } : {}),
      // Requests made by a service worker bypass routing; with an allowlist, have none.
      ...(allow ? { serviceWorkers: 'block' as const } : {}),
    });
    if (allow) {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (isAllowed(url, allow)) return route.continue();
        try {
          blockedHosts.add(bareHost(new URL(url).hostname));
        } catch {
          // Not a URL with a host: still blocked.
        }
        return route.abort('blockedbyclient');
      });
    }
    // Passive listeners only: a page.evaluate while the engine runs would pause the page via CDP.
    const watch = (p: Page) => logs.push(watchPage(p, CHECKS, blockedHosts));
    const page = context.pages()[0] ?? (await context.newPage());
    watch(page);
    context.on('page', watch);
    // Without a navigated page the engine either finds no target or sits on about:blank.
    await page.goto(opts.url);

    const port = await readDebugPort(userDataDir);
    const args = [
      'browser',
      'test-external',
      '--remote-debugger',
      `http://127.0.0.1:${port}`,
      '--width',
      String(width),
      '--height',
      String(height),
      '--device-scale-factor',
      String(scale),
      '--output-path',
      tracePath,
      '--output-path-overwrite',
      '--time-limit',
      timeLimit,
      ...(opts.keepGoing ? [] : ['--exit-on-violation']),
      ...(opts.allowUrl ?? []).flatMap((p) => ['--allow-url', p]),
      opts.url,
      ...(spec ? [spec] : []),
    ];
    log(`engine: ${engine}\nexploring ${opts.url} for up to ${timeLimit}${opts.keepGoing ? '' : ' (stops at the first violation)'}`);

    const engineLog = createWriteStream(path.join(dir, 'engine.log'));
    let stalled = false;
    engineExit = await new Promise<number | null>((resolve, reject) => {
      const c = spawn(engine, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child = c;
      const watchdog = setTimeout(() => {
        stalled = true;
        killTree(c);
      }, limitMs + GRACE_MS);
      for (const s of [c.stdout, c.stderr]) {
        s.on('data', (b: Buffer) => {
          if (!opts.quietEngine) process.stderr.write(b);
          engineLog.write(b);
        });
      }
      c.on('error', (e) => {
        clearTimeout(watchdog);
        reject(e);
      });
      c.on('close', (code) => {
        clearTimeout(watchdog);
        resolve(code);
      });
    });
    await new Promise<void>((r) => engineLog.end(r));
    if (interrupted) throw new Error('interrupted');
    if (stalled) error = `engine did not exit within ${timeLimit} + ${GRACE_MS / 1000}s and was killed`;
    // 2 is also how the engine reports a violation; whether it was one is read from the trace below.
    else if (engineExit !== 0 && engineExit !== 2) error = `engine exited with code ${engineExit} (see ${path.join(dir, 'engine.log')})`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (child) killTree(child);
    await context?.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }

  // The trace is the verdict, whatever the engine's exit code says.
  let parsed: ParsedTrace = { states: [], violations: [], badLines: 0 };
  let traceOk = false;
  if (!interrupted && existsSync(tracePath)) {
    try {
      const r = await capture(engine, ['trace', '--json', '--screenshots', statesDir, tracePath]);
      parsed = parseTrace(r.stdout);
      if (r.code !== 0) error ??= `trace exited with code ${r.code}: ${r.stderr.trim().split('\n').pop() ?? ''}`;
      else if (parsed.states.length === 0) error ??= 'trace has no states';
      else if (parsed.badLines > 0 && parsed.badLines >= parsed.states.length) error ??= 'trace output is not JSON states';
      else traceOk = true;
    } catch (e) {
      error ??= `could not read the trace: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (!error) {
    error = 'engine wrote no trace';
  }

  const flat = <T>(f: (l: PageLog) => T[]) => logs.flatMap(f);
  const consoleErrors = distinct(flat((l) => l.consoleErrors), (s) => s);
  const httpErrors = distinct(flat((l) => l.httpErrors), (h) => `${h.method} ${h.url} ${h.status ?? h.failure}`);
  const exitCode = exitCodeFor(parsed.violations.length, engineExit, traceOk);
  if (exitCode === 2) error ??= `engine exited with code ${engineExit} without a violation in the trace (see ${path.join(dir, 'engine.log')})`;
  const report: ExploreReport = {
    url: opts.url,
    ...(spec ? { spec } : {}),
    timeLimit,
    startedAt,
    durationMs: Date.now() - started,
    engineExitCode: engineExit,
    ...(error && exitCode === 2 ? { error } : {}),
    exitCode,
    states: parsed.states,
    violations: parsed.violations,
    pageErrors: distinct(flat((l) => l.pageErrors), (s) => s).slice(0, MAX_LOGGED),
    consoleErrors: consoleErrors.slice(0, MAX_LOGGED),
    httpErrors: httpErrors.slice(0, MAX_LOGGED),
    ...(consoleErrors.length > MAX_LOGGED ? { consoleErrorsDropped: consoleErrors.length - MAX_LOGGED } : {}),
    ...(httpErrors.length > MAX_LOGGED ? { httpErrorsDropped: httpErrors.length - MAX_LOGGED } : {}),
  };
  await writeFile(path.join(dir, 'explore.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dir, 'explore.html'), renderExploreHtml(report));
  if (report.error) log(`explore: ${report.error}`);
  return { exitCode, report, dir };
}

// --- report ----------------------------------------------------------------------------------

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Static page, no scripts: violations first (with their state's screenshot), then every state. */
export function renderExploreHtml(report: ExploreReport): string {
  const shot = (i: number) => report.states.find((s) => s.index === i)?.screenshot;
  const img = (src: string | undefined, alt: string) => (src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">` : '<div class="none">no screenshot</div>');
  const json = (v: unknown) => esc(JSON.stringify(v, null, 2));
  const violations = report.violations
    .map((v) => {
      const state = report.states.find((s) => s.index === v.stateIndex);
      return `<section class="card bad">
  <h3>${esc(v.name)} <span class="meta">state ${v.stateIndex}${state?.action ? ` after ${esc(state.action)}` : ''}</span></h3>
  ${img(shot(v.stateIndex), `state ${v.stateIndex}`)}
  ${v.condition ? `<pre class="code">${esc(v.condition)}</pre>` : ''}
  ${v.snapshots.length ? `<details open><summary>snapshots (${v.snapshots.length})</summary><pre>${json(v.snapshots)}</pre></details>` : ''}
</section>`;
    })
    .join('\n');
  const list = (title: string, items: string[], dropped?: number) =>
    items.length ? `<h2>${esc(title)} (${items.length}${dropped ? ` + ${dropped} more` : ''})</h2><ul>${items.map((i) => `<li><code>${esc(i)}</code></li>`).join('')}</ul>` : '';
  const strip = report.states
    .map(
      (s) => `<figure class="${s.violations.length ? 'bad' : ''}">
  ${img(s.screenshot, `state ${s.index}`)}
  <figcaption><b>${s.index}</b> ${esc(s.action || 'start')}<br><span class="meta">${esc(s.url)}</span>${s.violations.length ? `<br><b class="fail">${esc(s.violations.join(', '))}</b>` : ''}</figcaption>
</figure>`,
    )
    .join('\n');
  const verdict = report.exitCode === 0 ? 'PASS' : report.exitCode === 1 ? 'FAIL' : 'ERROR';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pixelgate explore</title>
<style>
:root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e3e3e3; --card:#fafafa; --bad:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --line:#2a2a2a; --card:#181818; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; padding:16px; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
h1 { font-size:16px; margin:0 0 4px; } h2 { font-size:14px; margin:24px 0 8px; } h3 { font-size:14px; margin:0 0 8px; }
.meta { color:var(--muted); font-size:12px; font-weight:400; word-break:break-all; }
.fail, .bad h3 { color:var(--bad); }
.card { border:1px solid var(--line); border-radius:8px; background:var(--card); padding:12px; margin:8px 0; }
.card.bad { border-color:var(--bad); }
pre { margin:8px 0 0; padding:8px; overflow:auto; font:12px/1.4 ui-monospace, monospace; border:1px solid var(--line); border-radius:6px; }
.card img { max-width:min(100%, 640px); }
img { display:block; max-width:100%; border:1px solid var(--line); }
.none { color:var(--muted); font-size:12px; }
.strip { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:8px; }
figure { margin:0; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--card); font-size:12px; }
figure.bad { border-color:var(--bad); }
figcaption { margin-top:4px; word-break:break-word; }
</style>
</head>
<body>
<h1>pixelgate explore: ${verdict}</h1>
<div class="meta">${esc(report.url)}${report.spec ? ` &middot; spec ${esc(report.spec)}` : ''} &middot; ${report.states.length} states &middot; ${report.violations.length} violations &middot; ${(report.durationMs / 1000).toFixed(1)}s &middot; engine exit ${esc(report.engineExitCode)}</div>
${report.error ? `<p class="fail">${esc(report.error)}</p>` : ''}
<h2>Violations (${report.violations.length})</h2>
${violations || '<p class="meta">None.</p>'}
${list('Page errors', report.pageErrors)}${list('Console errors', report.consoleErrors, report.consoleErrorsDropped)}${list('Failed requests', report.httpErrors.map((h) => `${h.method} ${h.url} ${h.status ?? h.failure ?? ''}`), report.httpErrorsDropped)}
<h2>States (${report.states.length})</h2>
<div class="strip">
${strip}
</div>
</body>
</html>
`;
}
