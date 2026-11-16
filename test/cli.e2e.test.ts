import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

// The built CLI under plain Node, as `npx pixelgate` runs it (vitest's module runner
// would load configs through Vite instead of Node).
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const pixelgate = (args: string[], cwd?: string) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('cli', () => {
  it('--version and -v print the package version', () => {
    for (const flag of ['--version', '-v']) {
      const r = pixelgate([flag]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), pkg.version);
    }
  });
});

describe('config loading under plain Node', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(process.env.PIXELGATE_TEST_TMP ?? os.tmpdir(), 'pixelgate-cli-'));
  });
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const configModule = pathToFileURL(fileURLToPath(new URL('../dist/config.js', import.meta.url))).href;
  /** A project dir with `package.json` `type` and these files; loads its config like the CLI. */
  async function load(type: string | undefined, files: Record<string, string>) {
    const dir = await mkdtemp(path.join(tmp, 'p-'));
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(type ? { name: 'p', type } : { name: 'p' }));
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    const script = `import { loadConfig } from ${JSON.stringify(configModule)};
const c = await loadConfig(process.cwd());
console.log(c.pages.map((p) => p.name).join());`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  }
  const page = (name: string) => `{ pages: [{ name: '${name}', url: 'about:blank' }] }`;

  it('an ES module pixelgate.config.ts or .js loads in a "type": "commonjs" package', async () => {
    const ts = await load('commonjs', {
      'pixelgate.config.ts': `import type { Config } from 'pixelgate';\nconst config: Config = ${page('ts')};\nexport default config;\n`,
    });
    assert.equal(ts.status, 0, ts.stderr);
    assert.equal(ts.stdout, 'ts');
    assert.doesNotMatch(ts.stderr, /Failed to load the ES module/);

    const js = await load('commonjs', { 'pixelgate.config.js': `export default ${page('js')};\n` });
    assert.equal(js.status, 0, js.stderr);
    assert.equal(js.stdout, 'js');

    // Declaring a CommonJS wrapper name is what V8 trips on first here.
    const dirname = await load('commonjs', {
      'pixelgate.config.js': `const __dirname = import.meta.dirname;\nexport default { pages: [{ name: typeof __dirname, url: 'about:blank' }] };\n`,
    });
    assert.equal(dirname.status, 0, dirname.stderr);
    assert.equal(dirname.stdout, 'string');
  });

  it('a CommonJS config and a package without "type" load as before', async () => {
    const cjs = await load('commonjs', { 'pixelgate.config.js': `module.exports = ${page('cjs')};\n` });
    assert.equal(cjs.status, 0, cjs.stderr);
    assert.equal(cjs.stdout, 'cjs');

    const untyped = await load(undefined, { 'pixelgate.config.ts': `const n: string = 'untyped';\nexport default { pages: [{ name: n, url: 'about:blank' }] };\n` });
    assert.equal(untyped.status, 0, untyped.stderr);
    assert.equal(untyped.stdout, 'untyped');
  });

  it('CommonJS files stay CommonJS: type-only imports, module syntax in comments and strings', async () => {
    const ts = await load('commonjs', {
      'pixelgate.config.ts': `import type { Config } from 'pixelgate';\nconst config: Config = ${page('typed')};\nmodule.exports = config;\n`,
    });
    assert.equal(ts.status, 0, ts.stderr);
    assert.equal(ts.stdout, 'typed');

    const js = await load('commonjs', {
      'pixelgate.config.js': `/*\nexport default is the ES module form of module.exports\n*/\nconst note = \`\nimport x from 'y'\n\`;\nmodule.exports = ${page('commented')};\n`,
    });
    assert.equal(js.status, 0, js.stderr);
    assert.equal(js.stdout, 'commented');
    assert.doesNotMatch(ts.stderr + js.stderr, /ExperimentalWarning/);
  });

  it('project files the config imports load as ES modules too; a CommonJS one stays CommonJS', async () => {
    const r = await load('commonjs', {
      'pixelgate.config.ts': `import { pages } from './pages.ts';\nimport names from './names.js';\nexport default { pages: pages.filter((p) => names.includes(p.name)) };\n`,
      'pages.ts': `export const pages: { name: string; url: string }[] = [{ name: 'a', url: 'about:blank' }, { name: 'b', url: 'about:blank' }];\n`,
      'names.js': `// exports.names is not ES module syntax\nmodule.exports = ['b'];\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'b');
  });
});
