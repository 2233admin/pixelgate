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

/** Load the project's own Vite, not one bundled with pixelgate. */
async function importVite(root: string): Promise<ViteApi> {
  let entry: string;
  try {
    entry = createRequire(path.join(root, 'package.json')).resolve('vite');
  } catch {
    throw new Error(`The \`vite\` option needs the \`vite\` package installed for ${root}`);
  }
  return (await import(pathToFileURL(entry).href)) as ViteApi;
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
