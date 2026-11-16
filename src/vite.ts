import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedViteSource } from './config.js';

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

// Just the slice of Vite's API pixelgate touches, so `vite` stays an optional peer dependency.
interface ViteServerLike {
  resolvedUrls: { local: string[]; network: string[] } | null;
  close(): Promise<void>;
}
interface ViteApi {
  createServer(config: object): Promise<ViteServerLike & { listen(): Promise<unknown> }>;
  preview(config: object): Promise<ViteServerLike>;
  build(config: object): Promise<unknown>;
}

type ExportTarget = string | { [condition: string]: ExportTarget } | null | undefined;

/** Pick the ESM file from an `exports["."]` entry: `import` before `default`/`node`, nested conditions allowed. */
export function esmEntry(target: ExportTarget): string | undefined {
  if (!target || typeof target === 'string') return target ?? undefined;
  for (const key of ['import', 'module', 'node', 'default']) {
    const hit = esmEntry(target[key]);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Load the project's own Vite, not one bundled with pixelgate.
 *
 * `require.resolve('vite')` would pick the `require` condition: Vite 5's CJS
 * build, which (deprecated, and) exposes no named exports through `import()`.
 * So read the package's `exports` and import its ESM entry.
 */
async function importVite(root: string): Promise<ViteApi> {
  let pkgFile: string;
  try {
    pkgFile = createRequire(path.join(root, 'package.json')).resolve('vite/package.json');
  } catch {
    throw new Error(`The \`vite\` option needs the \`vite\` package installed for ${root}`);
  }
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as { exports?: Record<string, ExportTarget>; module?: string; main?: string };
  const rel = esmEntry(pkg.exports?.['.']) ?? pkg.module ?? pkg.main ?? 'index.js';
  const mod = (await import(pathToFileURL(path.join(path.dirname(pkgFile), rel)).href)) as ViteApi & { default?: ViteApi };
  // Fall back to a CJS default export if some version only ships that.
  return typeof mod.build === 'function' ? mod : (mod.default ?? mod);
}

/** Start the project's Vite dev server, or build + preview it, on a loopback port. */
export async function startVite(opts: ResolvedViteSource): Promise<RunningServer> {
  const vite = await importVite(opts.root);
  const common = { root: opts.root, configFile: opts.configFile, logLevel: 'warn', clearScreen: false };
  const listen = { host: '127.0.0.1', port: opts.port, strictPort: opts.port !== undefined };

  let server: ViteServerLike;
  if (opts.mode === 'preview') {
    if (opts.build) await vite.build(common);
    server = await vite.preview({ ...common, preview: listen });
  } else {
    const dev = await vite.createServer({ ...common, server: { ...listen, hmr: false } });
    await dev.listen();
    server = dev;
  }
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('Vite server started but reported no local URL');
  }
  return { url, close: () => server.close() };
}
