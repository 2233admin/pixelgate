// Push the screenshots worth a look (every snapshot that is not unchanged) to a branch, so
// the pull-request comment can show them. Images are a nice-to-have: any failure here is a
// warning, never a failed gate (fork pull requests, for one, get no `contents: write`).
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const out = env.PG_OUT_ABS;
const branch = env.PG_BRANCH;
const prefix = env.PG_PREFIX;
const token = env.PG_TOKEN ?? '';
const repo = env.GITHUB_REPOSITORY;
const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
const redact = (s) => String(s).split(token).join('***').split(auth).join('***');

try {
  const report = JSON.parse(readFileSync(path.join(out, 'report', 'report.json'), 'utf8'));
  const files = new Set();
  for (const r of report.results) {
    if (r.status === 'unchanged') continue;
    for (const p of [r.baseline, r.current, r.diff]) if (p && existsSync(path.join(out, p))) files.add(p);
  }
  if (!files.size) {
    console.log('No screenshots to push.');
    process.exit(0);
  }

  const dir = mkdtempSync(path.join(env.RUNNER_TEMP ?? os.tmpdir(), 'pixelgate-images-'));
  const git = (...args) =>
    execFileSync('git', ['-c', `http.extraheader=${auth}`, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  const remote = `${server}/${repo}.git`;
  const fetchBranch = () => {
    try {
      git('fetch', '-q', '--depth=1', remote, branch);
      return true;
    } catch {
      return false;
    }
  };

  git('init', '-q');
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  if (fetchBranch()) git('checkout', '-q', '-B', branch, 'FETCH_HEAD');
  else git('checkout', '-q', '--orphan', branch);
  for (const f of files) {
    const dest = path.join(dir, prefix, f);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(out, f), dest);
  }
  git('add', '-A');
  git('commit', '-q', '-m', `pixelgate screenshots: ${prefix}`);
  // Parallel jobs push to the same branch: on a race, replay this commit on top and retry.
  for (let attempt = 1; ; attempt++) {
    try {
      git('push', '-q', remote, `HEAD:${branch}`);
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      if (fetchBranch()) git('rebase', '-q', 'FETCH_HEAD');
    }
  }

  const sha = git('rev-parse', 'HEAD');
  const where = prefix.split('/').map(encodeURIComponent).join('/');
  const host = new URL(server).host;
  const base =
    host === 'github.com'
      ? `https://raw.githubusercontent.com/${repo}/${sha}/${where}`
      : `${server}/${repo}/raw/${sha}/${where}`;
  appendFileSync(env.GITHUB_OUTPUT, `base=${base}\n`);
  console.log(`Pushed ${files.size} screenshot(s) to ${branch} at ${sha.slice(0, 7)}.`);
} catch (e) {
  const msg = redact(e instanceof Error ? e.message : e).split('\n')[0];
  console.log(`::warning title=pixelgate::Could not push screenshots to "${branch}" (${msg}). The comment will have no images.`);
}
