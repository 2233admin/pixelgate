import type { Report } from './report.js';

/** Self-contained review page. Images load by relative path from `<outDir>/report/`. */
export function renderHtml(report: Report): string {
  const data = JSON.stringify(report).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pixelgate report</title>
<style>
:root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e3e3e3; --card:#fafafa;
  --changed:#c2410c; --added:#15803d; --updated:#0369a1; --removed:#6d28d9; --error:#b91c1c; --unchanged:#666; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --line:#2a2a2a; --card:#181818;
  --changed:#fb923c; --added:#4ade80; --updated:#38bdf8; --removed:#a78bfa; --error:#f87171; --unchanged:#999; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px; z-index:1; }
h1 { font-size:16px; margin:0 0 8px; }
.bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }
button[aria-pressed=true] { border-color:var(--fg); }
.sep { width:1px; height:20px; background:var(--line); margin:0 4px; }
main { padding:16px; display:grid; gap:16px; }
.card { border:1px solid var(--line); border-radius:8px; background:var(--card); overflow:hidden; }
.head { display:flex; gap:8px; align-items:baseline; padding:8px 12px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.name { font-weight:600; word-break:break-all; }
.tag { font-size:12px; font-weight:600; text-transform:uppercase; }
.meta { color:var(--muted); font-size:12px; }
.imgs { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:8px; padding:8px; }
figure { margin:0; } figcaption { font-size:12px; color:var(--muted); margin-bottom:4px; }
img { max-width:100%; display:block; border:1px solid var(--line); background:repeating-conic-gradient(#8882 0 25%, transparent 0 50%) 0 0/16px 16px; }
.slider { display:grid; width:fit-content; max-width:100%; }
.slider img { grid-area:1 / 1; }
.slider .top { clip-path:inset(0 50% 0 0); }
input[type=range] { width:100%; }
.err { color:var(--error); padding:8px 12px; white-space:pre-wrap; font-family:ui-monospace, monospace; font-size:12px; }
.empty { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div class="bar" id="filters"></div>
  <div class="bar" style="margin-top:6px" id="views"></div>
</header>
<main id="list"></main>
<script id="data" type="application/json">${data}</script>
<script>
const report = JSON.parse(document.getElementById('data').textContent);
const STATUSES = ['changed', 'error', 'removed', 'added', 'updated', 'unchanged'];
const s = report.summary;
let filter = s.changed + s.error + s.removed > 0 ? 'attention' : 'all';
let view = 'side';
const src = (p) => '../' + p;
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'text' ? (n.textContent = v) : n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
};
document.getElementById('title').textContent =
  (report.failed ? 'FAILED' : 'PASSED') + ' - ' + s.total + ' snapshots - ' + new Date(report.createdAt).toLocaleString();

function buttons(id, items, get, set) {
  const box = document.getElementById(id);
  box.replaceChildren(...items.map(([key, label]) => {
    const b = el('button', { 'aria-pressed': String(get() === key), text: label });
    b.onclick = () => { set(key); render(); };
    return b;
  }));
}
function figure(label, path) {
  return el('figure', {}, [el('figcaption', { text: label }), el('img', { src: src(path), loading: 'lazy', alt: label })]);
}
function slider(r) {
  // Both images share one grid cell; the baseline on top is clipped from the right.
  const bottom = el('img', { src: src(r.current), alt: 'current' });
  const top = el('img', { src: src(r.baseline), alt: 'baseline', class: 'top' });
  const wrap = el('div', { class: 'slider' }, [bottom, top]);
  const range = el('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'baseline / current' });
  range.oninput = () => { top.style.clipPath = 'inset(0 ' + (100 - range.value) + '% 0 0)'; };
  return el('div', { style: 'padding:8px' }, [el('figcaption', { text: 'left: baseline - right: current' }), wrap, range]);
}
function card(r) {
  const meta = [r.target];
  if (r.diffRatio != null && (r.status === 'changed' || r.status === 'updated')) meta.push((r.diffRatio * 100).toFixed(3) + '% px (' + r.diffPixels + ')');
  if (r.sizeChanged) meta.push('size changed');
  if (r.message && !r.sizeChanged) meta.push(r.message);
  const head = el('div', { class: 'head' }, [
    el('span', { class: 'tag', style: 'color:var(--' + r.status + ')', text: r.status }),
    el('span', { class: 'name', text: r.name }),
    el('span', { class: 'meta', text: meta.join(' - ') }),
  ]);
  const c = el('section', { class: 'card' }, [head]);
  if (r.error) c.append(el('div', { class: 'err', text: r.error }));
  if (r.pageErrors?.length) c.append(el('div', { class: 'err', text: 'page errors:\\n' + r.pageErrors.join('\\n') }));
  if (r.status === 'changed' && view === 'slider') c.append(slider(r));
  else if (r.status === 'changed' && view === 'diff') c.append(el('div', { class: 'imgs' }, [figure('diff', r.diff)]));
  else {
    const figs = [];
    if (r.baseline) figs.push(figure('baseline', r.baseline));
    if (r.current) figs.push(figure('current', r.current));
    if (r.diff) figs.push(figure('diff', r.diff));
    if (figs.length) c.append(el('div', { class: 'imgs' }, figs));
  }
  return c;
}
function render() {
  buttons('filters', [['attention', 'Needs review (' + (s.changed + s.error + s.removed) + ')'], ['all', 'All (' + s.total + ')'],
    ...STATUSES.map((k) => [k, k + ' (' + s[k] + ')'])], () => filter, (v) => (filter = v));
  buttons('views', [['side', 'Side by side'], ['diff', 'Diff only'], ['slider', 'Slider']], () => view, (v) => (view = v));
  const rows = report.results.filter((r) =>
    filter === 'all' ? true : filter === 'attention' ? ['changed', 'error', 'removed'].includes(r.status) : r.status === filter);
  const list = document.getElementById('list');
  list.replaceChildren(...(rows.length ? rows.map(card) : [el('p', { class: 'empty', text: 'Nothing here.' })]));
}
render();
</script>
</body>
</html>
`;
}
