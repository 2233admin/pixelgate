// Create or update this job's pixelgate comment on the pull request. The comment is found by
// its first line, the marker `pixelgate summary --id <artifact-name>` writes. Failures are
// warnings: a fork pull request's token cannot comment, and the gate result stands anyway.
import { readFileSync } from 'node:fs';

const env = process.env;
const api = env.GITHUB_API_URL ?? 'https://api.github.com';
const repo = env.GITHUB_REPOSITORY;
const pr = env.PG_PR;
// Same rule as commentMarker() in src/markdown.ts.
const marker = `<!-- ${(env.PG_ID ?? 'pixelgate').replace(/-->/g, '')} -->`;
const body = readFileSync(env.PG_BODY_FILE, 'utf8');
const headers = {
  authorization: `Bearer ${env.PG_TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
};

async function gh(method, url, data) {
  const res = await fetch(url, { method, headers, body: data && JSON.stringify(data) });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

try {
  let existing;
  for (let page = 1; ; page++) {
    const list = await gh('GET', `${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    for (const c of list) if (c.body?.startsWith(marker)) existing = c;
    if (list.length < 100) break;
  }
  if (existing) {
    const c = await gh('PATCH', `${api}/repos/${repo}/issues/comments/${existing.id}`, { body });
    console.log(`Updated ${c.html_url}`);
  } else if (env.PG_RESULT !== 'pass' || body.includes('\n| Status |')) {
    const c = await gh('POST', `${api}/repos/${repo}/issues/${pr}/comments`, { body });
    console.log(`Commented ${c.html_url}`);
  } else {
    console.log('Gate passed and there is no earlier comment: nothing to post.');
  }
} catch (e) {
  console.log(`::warning title=pixelgate::Could not comment on the pull request: ${e instanceof Error ? e.message : e}`);
}
