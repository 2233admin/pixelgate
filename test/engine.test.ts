import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineTarget, resolveEngine, type ResolveEngineOptions } from '../src/engine.js';

const VERSION = '9.9.9';
const TARGET = 'x86_64-unknown-linux-gnu';
const FILE = 'pixelgate-engine-x86_64-unknown-linux-gnu';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let root: string;
let cache: string;
let manifestPath: string;
let server: http.Server;
let mirror: string;
let requests: string[];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let payload: Buffer;

const ENV = ['PIXELGATE_ENGINE', 'PIXELGATE_ENGINE_MIRROR', 'PIXELGATE_ENGINE_OFFLINE', 'PIXELGATE_CACHE_DIR', 'PIXELGATE_ENGINE_TIMEOUT_MS'];
const saved: Record<string, string | undefined> = {};

const opts = (extra: ResolveEngineOptions = {}): ResolveEngineOptions => ({
  manifestPath,
  version: VERSION,
  platform: 'linux',
  arch: 'x64',
  glibc: true,
  log: () => {},
  ...extra,
});
const finalPath = () => path.join(cache, 'pixelgate', 'engine', VERSION, FILE);
const cacheDirFiles = () => {
  const dir = path.dirname(finalPath());
  return existsSync(dir) ? readdirSync(dir) : [];
};
const writeManifest = (body: Buffer, size = body.length) =>
  writeFile(manifestPath, JSON.stringify({ version: VERSION, binaries: { [TARGET]: { file: FILE, sha256: sha(body), size } } }));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mirror = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = await mkdtemp(path.join(os.tmpdir(), 'pixelgate-engine-test-'));
  cache = path.join(root, 'cache');
  manifestPath = path.join(root, 'engine-manifest.json');
  process.env.PIXELGATE_CACHE_DIR = cache;
  process.env.PIXELGATE_ENGINE_MIRROR = mirror;
  payload = randomBytes(64 * 1024);
  await writeManifest(payload);
  requests = [];
  handler = (_req, res) => res.end(payload);
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe('engineTarget', () => {
  it('maps platforms to release targets', () => {
    expect(engineTarget('win32', 'x64', true)).toBe('x86_64-pc-windows-msvc');
    expect(engineTarget('win32', 'arm64', true)).toBe('x86_64-pc-windows-msvc');
    expect(engineTarget('linux', 'x64', true)).toBe('x86_64-unknown-linux-gnu');
    expect(engineTarget('linux', 'arm64', true)).toBe('aarch64-unknown-linux-gnu');
    expect(engineTarget('darwin', 'arm64', true)).toBe('aarch64-apple-darwin');
  });
  it('refuses the rest, naming the platform and the way out', () => {
    expect(() => engineTarget('darwin', 'x64', true)).toThrow(/darwin\/x64.*engine\/README\.md.*PIXELGATE_ENGINE/);
    expect(() => engineTarget('linux', 'x64', false)).toThrow(/linux\/x64.*musl/);
    expect(() => engineTarget('freebsd', 'x64', true)).toThrow(/freebsd\/x64/);
  });
});

describe('resolveEngine', () => {
  it('downloads once, then serves the cache without a request', async () => {
    const first = await resolveEngine(opts());
    expect(first).toBe(finalPath());
    expect(await readFile(first)).toEqual(payload);
    expect(requests).toEqual([`/v${VERSION}/${FILE}`]);
    expect(await resolveEngine(opts())).toBe(first);
    expect(requests).toHaveLength(1);
    expect(cacheDirFiles()).toEqual([FILE]);
  });

  it('strips a trailing slash from the mirror', async () => {
    process.env.PIXELGATE_ENGINE_MIRROR = `${mirror}/`;
    await resolveEngine(opts());
    expect(requests).toEqual([`/v${VERSION}/${FILE}`]);
  });

  it('rejects a wrong sha256 and leaves nothing behind', async () => {
    handler = (_req, res) => res.end(randomBytes(payload.length));
    await expect(resolveEngine(opts())).rejects.toThrow(/sha256/);
    expect(cacheDirFiles()).toEqual([]);
  });

  it('aborts a body larger than the pinned size and leaves nothing behind', async () => {
    handler = (_req, res) => res.end(Buffer.concat([payload, randomBytes(4096)]));
    await expect(resolveEngine(opts())).rejects.toThrow(/larger than the pinned/);
    expect(cacheDirFiles()).toEqual([]);
  });

  it('rejects a short body', async () => {
    handler = (_req, res) => res.end(payload.subarray(0, 100));
    await expect(resolveEngine(opts())).rejects.toThrow(/expected/);
    expect(cacheDirFiles()).toEqual([]);
  });

  it('explains a 404 as a release that may still be a draft', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end('nope');
    };
    await expect(resolveEngine(opts())).rejects.toThrow(
      new RegExp(`engine ${FILE} for v${VERSION} is not available yet \\(HTTP 404, .*draft.*PIXELGATE_ENGINE.*engine/README\\.md`),
    );
    expect(cacheDirFiles()).toEqual([]);
  });

  it('names the mirror and proxy variables on other HTTP errors', async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };
    await expect(resolveEngine(opts())).rejects.toThrow(/503.*PIXELGATE_ENGINE_MIRROR.*NODE_USE_ENV_PROXY=1/);
  });

  it('follows a redirect', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/v')) {
        res.statusCode = 302;
        res.setHeader('location', '/elsewhere/blob');
        res.end();
      } else res.end(payload);
    };
    expect(await readFile(await resolveEngine(opts()))).toEqual(payload);
    expect(requests).toEqual([`/v${VERSION}/${FILE}`, '/elsewhere/blob']);
  });

  it('replaces a corrupt cached file', async () => {
    await resolveEngine(opts());
    await writeFile(finalPath(), randomBytes(payload.length));
    requests = [];
    expect(await readFile(await resolveEngine(opts()))).toEqual(payload);
    expect(requests).toHaveLength(1);
  });

  it('replaces a truncated cached file', async () => {
    await resolveEngine(opts());
    await writeFile(finalPath(), payload.subarray(0, 10));
    requests = [];
    expect(await readFile(await resolveEngine(opts()))).toEqual(payload);
    expect(requests).toHaveLength(1);
  });

  it('survives two parallel resolves with one valid file', async () => {
    const [a, b] = await Promise.all([resolveEngine(opts()), resolveEngine(opts())]);
    expect(a).toBe(b);
    expect(await readFile(a)).toEqual(payload);
    expect(cacheDirFiles()).toEqual([FILE]);
  });

  it('with PIXELGATE_ENGINE_OFFLINE=1 and no cache fails without a request', async () => {
    process.env.PIXELGATE_ENGINE_OFFLINE = '1';
    await expect(resolveEngine(opts())).rejects.toThrow(/PIXELGATE_ENGINE_OFFLINE=1/);
    expect(requests).toEqual([]);
  });

  it('with download:false and no cache fails without a request, but serves a cached file', async () => {
    await expect(resolveEngine(opts({ download: false }))).rejects.toThrow(/engine install/);
    expect(requests).toEqual([]);
    await resolveEngine(opts());
    requests = [];
    expect(await resolveEngine(opts({ download: false }))).toBe(finalPath());
    expect(requests).toEqual([]);
  });

  it('prefers an explicit path, then PIXELGATE_ENGINE, over everything', async () => {
    const fake = path.join(root, 'fake-engine');
    const other = path.join(root, 'other-engine');
    await writeFile(fake, 'x');
    await writeFile(other, 'y');
    expect(await resolveEngine(opts({ engine: fake }))).toBe(fake);
    process.env.PIXELGATE_ENGINE = other;
    expect(await resolveEngine(opts())).toBe(other);
    expect(await resolveEngine(opts({ engine: fake }))).toBe(fake);
    expect(requests).toEqual([]);
    await expect(resolveEngine(opts({ engine: path.join(root, 'missing') }))).rejects.toThrow(/not found/);
  });

  it('says so when the install has no manifest', async () => {
    await rm(manifestPath);
    await expect(resolveEngine(opts())).rejects.toThrow(/no prebuilt engine in this install.*engine\/README\.md.*PIXELGATE_ENGINE/);
  });

  it('rejects a manifest with a bad hash, a wrong version or a path as file name', async () => {
    const entry = { file: FILE, sha256: sha(payload), size: payload.length };
    const write = (m: unknown) => writeFile(manifestPath, JSON.stringify(m));
    await write({ version: VERSION, binaries: { [TARGET]: { ...entry, sha256: 'abc' } } });
    await expect(resolveEngine(opts())).rejects.toThrow(/sha256/);
    await write({ version: '0.0.1', binaries: { [TARGET]: entry } });
    await expect(resolveEngine(opts())).rejects.toThrow(/version/);
    await write({ version: VERSION, binaries: { [TARGET]: { ...entry, file: '../evil' } } });
    await expect(resolveEngine(opts())).rejects.toThrow(/file/);
    await write({ version: VERSION, binaries: { [TARGET]: { ...entry, size: 0 } } });
    await expect(resolveEngine(opts())).rejects.toThrow(/positive size/);
  });

  it('reports an unsupported platform before touching the manifest', async () => {
    await expect(resolveEngine(opts({ platform: 'darwin', arch: 'x64' }))).rejects.toThrow(/darwin\/x64/);
  });
});
