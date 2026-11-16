import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the explore engine comes from. Releases attach one prebuilt binary per platform to the
 * GitHub release `v<version>`; the package carries `engine-manifest.json` pinning each binary's
 * sha256 and size, so whatever serves the bytes (GitHub, a mirror, a proxy) cannot change what runs.
 */

export interface EngineManifestEntry {
  file: string;
  sha256: string;
  size: number;
}

export interface EngineManifest {
  version: string;
  binaries: Record<string, EngineManifestEntry>;
}

export interface ResolveEngineOptions {
  /** Explicit binary (`--engine`). Wins over everything. */
  engine?: string;
  /** Download when nothing is available locally. Default true; false = only explicit/env/cache. */
  download?: boolean;
  /** Progress lines (default: stderr). */
  log?: (msg: string) => void;
  // The rest exists for tests: the real values come from the install and the host.
  /** Manifest location. Default: `engine-manifest.json` at the package root. */
  manifestPath?: string;
  /** Package version the manifest must match. Default: the installed package.json. */
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Linux libc: true = glibc. Default: detected. */
  glibc?: boolean;
}

const BUILD_HINT = 'Build it per engine/README.md and set PIXELGATE_ENGINE to the binary.';
const DEFAULT_MIRROR = 'https://github.com/2233admin/pixelgate/releases/download';
const DEFAULT_TIMEOUT_MS = 120_000;
// Windows Defender may hold the fresh temp file for a moment; a few short retries ride it out.
const RENAME_TRIES = 5;

// package.json and engine-manifest.json sit one level up from both src/ and dist/.
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** Rust target triple of the prebuilt engine for a Node platform, or throws. */
export function engineTarget(platform: NodeJS.Platform, arch: string, glibc: boolean): string {
  const unsupported = (why: string): never => {
    throw new Error(`no prebuilt engine for ${why}. ${BUILD_HINT}`);
  };
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return 'x86_64-pc-windows-msvc'; // Windows on Arm runs x64
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    if (!glibc) return unsupported(`${platform}/${arch} without glibc (musl)`);
    return arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu';
  }
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return unsupported(`${platform}/${arch}`);
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return Boolean(report?.header?.glibcVersionRuntime);
}

function cacheRoot(): string {
  const dir = process.env.PIXELGATE_CACHE_DIR;
  if (dir) return path.resolve(dir);
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
}

function readManifest(manifestPath: string, version: string): EngineManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`no prebuilt engine in this install (${manifestPath} is missing; a source checkout?). ${BUILD_HINT}`);
  }
  const bad = (why: string): never => {
    throw new Error(`invalid engine manifest ${manifestPath}: ${why}`);
  };
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return bad('not JSON');
  }
  const man = m as Partial<EngineManifest> | null;
  if (!man || typeof man !== 'object' || typeof man.binaries !== 'object' || !man.binaries) return bad('no "binaries"');
  if (man.version !== version) return bad(`version ${String(man.version)} does not match pixelgate ${version}`);
  for (const [target, e] of Object.entries(man.binaries)) {
    const ok =
      e &&
      typeof e.file === 'string' &&
      e.file === path.basename(e.file) && // a file name, never a path
      typeof e.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(e.sha256) &&
      Number.isInteger(e.size) &&
      e.size > 0;
    if (!ok) return bad(`entry "${target}" needs file, a 64-hex sha256 and a positive size`);
  }
  return man as EngineManifest;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** True when `file` exists with exactly the pinned size and hash. */
async function verified(file: string, entry: EngineManifestEntry): Promise<boolean> {
  try {
    return (await stat(file)).size === entry.size && (await sha256File(file)) === entry.sha256;
  } catch {
    return false;
  }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

function downloadFailure(url: string, cause: unknown): Error {
  const detail =
    cause instanceof Error ? `${cause.message}${cause.cause instanceof Error ? ` (${cause.cause.message})` : ''}` : String(cause);
  return new Error(
    `could not download the engine from ${url}: ${detail}. ` +
      'Set PIXELGATE_ENGINE_MIRROR to a reachable mirror (behind a proxy: NODE_USE_ENV_PROXY=1, Node 22.21+ or 24+), or set PIXELGATE_ENGINE to a local build (engine/README.md).',
    { cause },
  );
}

/** Raised for a bad body, so it is not mistaken for a network error. */
class BodyError extends Error {}

/** Stream `url` into a fresh temp file next to `final`, checking size and hash on the way. */
async function download(url: string, entry: EngineManifestEntry, final: string, version: string, timeoutMs: number): Promise<string> {
  const tmp = `${final}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw downloadFailure(url, e);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new Error(
        `engine ${entry.file} for v${version} is not available yet (HTTP 404, ${url}). ` +
          'The GitHub release may still be a draft. Retry later, or set PIXELGATE_ENGINE to a local build (engine/README.md).',
      );
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw downloadFailure(url, new Error(`HTTP ${res.status} ${res.statusText}`.trim()));
    }
    handle = await open(tmp, 'wx', 0o755);
    const hash = createHash('sha256');
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        // Stop at the pinned size: a wrong or hostile server must not fill the disk.
        if (received > entry.size) throw new BodyError(`engine download from ${url} is larger than the pinned ${entry.size} bytes; aborted`);
        hash.update(chunk);
        // write() may write less than asked (disk full, file-size limit): loop until all of it is on disk.
        for (let off = 0; off < chunk.byteLength; ) {
          const { bytesWritten } = await handle.write(chunk, off);
          if (bytesWritten <= 0) throw new Error(`could not write ${tmp}`);
          off += bytesWritten;
        }
      }
    } catch (e) {
      throw e instanceof BodyError ? e : downloadFailure(url, e);
    }
    await handle.close();
    handle = undefined;
    const digest = hash.digest('hex');
    if (received !== entry.size) throw new Error(`engine download from ${url} is ${received} bytes, expected ${entry.size}; discarded`);
    if (digest !== entry.sha256) throw new Error(`engine download from ${url} has sha256 ${digest}, expected ${entry.sha256}; discarded`);
    // What runs is what reached the disk, not what came over the wire.
    if (!(await verified(tmp, entry))) throw new Error(`engine written to ${tmp} does not match the pinned size and sha256; discarded`);
    return tmp;
  } catch (e) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Move the verified temp file into place; tolerate a parallel process that got there first. */
async function install(tmp: string, final: string, entry: EngineManifestEntry): Promise<void> {
  try {
    for (let i = 1; ; i++) {
      try {
        await rename(tmp, final);
        return;
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'EEXIST'].includes(errCode(e) ?? '')) throw e;
        if (await verified(final, entry)) return; // a parallel resolve won
        if (i >= RENAME_TRIES) throw e;
        await new Promise((r) => setTimeout(r, 100 * i));
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Absolute path of the engine binary: explicit path, then `PIXELGATE_ENGINE`, then the cache,
 * then a verified download into the cache.
 */
export async function resolveEngine(opts: ResolveEngineOptions = {}): Promise<string> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const given = opts.engine || process.env.PIXELGATE_ENGINE;
  if (given) {
    const abs = path.resolve(given);
    if (!existsSync(abs)) throw new Error(`engine binary not found: ${abs}`);
    return abs;
  }

  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const target = engineTarget(platform, arch, opts.glibc ?? (platform === 'linux' ? hasGlibc() : true));
  const version = opts.version ?? packageVersion();
  const manifest = readManifest(opts.manifestPath ?? path.join(packageRoot, 'engine-manifest.json'), version);
  const entry = manifest.binaries[target];
  if (!entry) throw new Error(`engine manifest has no binary for ${target}. ${BUILD_HINT}`);

  const dir = path.join(cacheRoot(), 'pixelgate', 'engine', version);
  const final = path.join(dir, entry.file);
  // The file is ~16 MB: re-hashing it on every resolve is cheap, trusting a cached file is not.
  // A bad cached file is left in place: the verified download replaces it with one rename, so a
  // parallel resolve that already repaired it never loses its file.
  let state = 'is not cached';
  if (existsSync(final)) {
    if (await verified(final, entry)) return final;
    state = 'in the cache does not match the pinned hash';
    log(`cached engine ${final} does not match the pinned hash; fetching it again`);
  }

  if (process.env.PIXELGATE_ENGINE_OFFLINE === '1') {
    throw new Error(
      `engine ${entry.file} ${state} (${final}) and PIXELGATE_ENGINE_OFFLINE=1 forbids downloading. ` +
        'Run `pixelgate engine install` online first, or set PIXELGATE_ENGINE.',
    );
  }
  if (opts.download === false) {
    throw new Error(`engine ${entry.file} ${state} (${final}). Run \`pixelgate engine install\` to download it, or set PIXELGATE_ENGINE.`);
  }

  const base = (process.env.PIXELGATE_ENGINE_MIRROR || DEFAULT_MIRROR).replace(/\/+$/, '');
  const url = `${base}/v${version}/${entry.file}`;
  const envTimeout = Number(process.env.PIXELGATE_ENGINE_TIMEOUT_MS);
  const timeoutMs = envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS;
  log(`downloading engine ${url} (sha256 ${entry.sha256})`);
  await mkdir(dir, { recursive: true });
  const tmp = await download(url, entry, final, version, timeoutMs);
  await install(tmp, final, entry);
  if (platform !== 'win32') await chmod(final, 0o755);
  log(`engine cached at ${final}`);
  return final;
}
