import { patchDelta } from './aria.js';
import type { CheckName, Status } from './config.js';
import { checkFindings, type Report, type SnapshotResult } from './report.js';

export interface MarkdownOptions {
  /**
   * Tells several pixelgate jobs on one pull request apart (an OS matrix, two apps):
   * each keeps its own comment. Default `pixelgate`.
   */
  id?: string;
  /** Link to the full HTML report, e.g. the CI artifact. */
  reportUrl?: string;
  /** Link to the CI run. */
  runUrl?: string;
  /**
   * Base URL that the report's image paths (`current/desktop-linux/home.png`) resolve
   * against. Without it the comment has no images.
   */
  imageBaseUrl?: string;
  /** Shell command that accepts the changes, shown in a code block. */
  acceptCommand?: string;
  /** Table rows before the rest is only counted. Default 50. */
  maxRows?: number;
  /** Snapshots with images before the rest is only counted. Default 10. */
  maxImages?: number;
}

/** First line of every comment; how the action finds the comment to update. */
export const commentMarker = (id = 'pixelgate') => `<!-- ${id.replace(/-->/g, '')} -->`;

const LISTED: Status[] = ['error', 'changed', 'removed', 'added', 'updated'];

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s: string) => '`' + cell(s).replace(/`/g, "'") + '`';

function percent(ratio: number): string {
  const p = ratio * 100;
  return p > 0 && p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`;
}

function detail(r: SnapshotResult): string {
  switch (r.status) {
    case 'changed': {
      const parts: string[] = [];
      // With an ARIA snapshot a row can be changed for its tree alone: then there is no `current`.
      if (r.current || !r.aria) parts.push(r.diffRatio !== undefined ? `${percent(r.diffRatio)} of pixels` : r.message ?? 'changed');
      if (r.sizeChanged) parts.push('size changed');
      if (r.aria?.status === 'changed' && r.aria.patch) {
        const d = patchDelta(r.aria.patch);
        parts.push(`ARIA tree +${d.added} -${d.removed} lines${r.aria.truncated ? ' (diff truncated)' : ''}`);
      }
      return parts.join(', ') || 'changed';
    }
    case 'added':
      return 'no baseline yet';
    case 'updated':
      return 'baseline overwritten';
    case 'removed':
      return r.baseline ? 'baseline with no snapshot in this run' : 'ARIA baseline with no snapshot in this run';
    case 'error': {
      const msg = (r.error ?? 'error').split('\n')[0]!;
      return msg.length > 200 ? msg.slice(0, 199) + '…' : msg;
    }
    default:
      return '';
  }
}

/** Which images of a result are worth showing, in display order. */
function images(r: SnapshotResult): Array<[label: string, path: string]> {
  const out: Array<[string, string | undefined]> =
    r.status === 'changed'
      ? r.current || !r.aria
        ? [['Baseline', r.baseline], ['Current', r.current], ['Diff', r.diff]]
        : [['Screenshot (pixels unchanged)', r.baseline]]
      : r.status === 'removed'
        ? [['Baseline', r.baseline]]
        : [['Current', r.current ?? r.baseline]];
  return out.filter((x): x is [string, string] => !!x[1]);
}

function imageUrl(base: string, rel: string): string {
  return base.replace(/\/+$/, '') + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

const CHECK_LABEL: Record<CheckName, string> = {
  pageErrors: 'with page errors',
  a11y: 'with accessibility violations',
  overflow: 'overflowing the viewport',
};

function headline(report: Report, id?: string): string[] {
  const s = report.summary;
  const counts = LISTED.filter((st) => s[st] > 0).map((st) => `${s[st]} ${st}`);
  if (s.unchanged > 0) counts.push(`${s.unchanged} unchanged`);
  // Reports from before the checks have no check counters.
  const checks = (Object.keys(CHECK_LABEL) as CheckName[]).filter((c) => (s[c] ?? 0) > 0).map((c) => `${s[c]} ${CHECK_LABEL[c]}`);
  return [
    commentMarker(id),
    `### pixelgate: ${report.failed ? 'failed' : 'passed'}`,
    '',
    `${counts.join(', ') || 'no snapshots'} (${s.total} total).` + (checks.length ? ` Checks: ${checks.join(', ')}.` : ''),
  ];
}

function checkDetail(r: SnapshotResult, c: CheckName): string {
  if (c === 'overflow') return `${r.overflowPx}px past the right edge`;
  if (c === 'pageErrors') {
    const first = r.pageErrors![0]!.split('\n')[0]!;
    const more = r.pageErrors!.length > 1 ? ` (+${r.pageErrors!.length - 1} more)` : '';
    return (first.length > 150 ? first.slice(0, 149) + '…' : first) + more;
  }
  const v = r.a11y!;
  const ids = v.slice(0, 4).map((x) => `${code(x.id)}${x.impact ? ` (${x.impact})` : ''}`);
  return `${v.length} rule${v.length > 1 ? 's' : ''}: ${ids.join(', ')}${v.length > 4 ? ', …' : ''}`;
}

/** Snapshots with check findings; says which checks gate (in `failOn`) and which only report. */
function checksTable(report: Report, maxRows: number): string[] {
  const rows: string[] = [];
  for (const r of report.results) {
    for (const c of checkFindings(r)) rows.push(`| ${c} | ${code(r.name)} | ${code(r.target)} | ${cell(checkDetail(r, c))} |`);
  }
  if (!rows.length) return [];
  const present = new Set(report.results.flatMap(checkFindings));
  const gating = [...present].filter((c) => report.failOn.includes(c));
  const reportOnly = [...present].filter((c) => !report.failOn.includes(c));
  const note = [
    gating.length ? `Failing the gate: ${gating.map(code).join(', ')}.` : '',
    reportOnly.length ? `Reported only (not in \`failOn\`): ${reportOnly.map(code).join(', ')}.` : '',
  ].filter(Boolean);
  const more = rows.length > maxRows ? ['', `…and ${rows.length - maxRows} more in the full report.`] : [];
  return ['', '#### Checks', '', note.join(' '), '', '| Check | Snapshot | Target | Detail |', '| --- | --- | --- | --- |', ...rows.slice(0, maxRows), ...more];
}

/** ARIA snapshot diffs as fenced `diff` blocks; the fence is longer than any backtick run inside. */
function ariaDiffs(listed: SnapshotResult[], open: boolean, maxImages: number): string[] {
  const withPatch = listed.filter((r) => r.aria?.patch);
  if (!withPatch.length) return [];
  const lines = ['', `<details${open ? ' open' : ''}><summary>ARIA snapshot changes</summary>`, ''];
  for (const r of withPatch.slice(0, maxImages)) {
    const patch = r.aria!.patch!;
    const fence = '`'.repeat(Math.max(3, ...(patch.match(/`+/g) ?? []).map((m) => m.length + 1)));
    lines.push(
      `**${code(r.name)}** ${code(r.target)}: ${r.aria!.status}${r.aria!.truncated ? ' (diff truncated, full tree in the report)' : ''}`,
      '',
      fence + 'diff',
      patch,
      fence,
      '',
    );
  }
  if (withPatch.length > maxImages) lines.push(`…and ${withPatch.length - maxImages} more in the full report.`, '');
  lines.push('</details>');
  return lines;
}

function table(listed: SnapshotResult[], maxRows: number): string[] {
  if (!listed.length) return [];
  const rows = listed
    .slice(0, maxRows)
    .map((r) => `| ${r.status} | ${code(r.name)} | ${code(r.target)} | ${cell(detail(r))} |`);
  const more = listed.length > maxRows ? ['', `…and ${listed.length - maxRows} more in the full report.`] : [];
  return ['', '| Status | Snapshot | Target | Detail |', '| --- | --- | --- | --- |', ...rows, ...more];
}

function screenshots(listed: SnapshotResult[], base: string | undefined, open: boolean, maxImages: number): string[] {
  const withImages = base ? listed.filter((r) => images(r).length) : [];
  if (!withImages.length) return [];
  const lines = ['', `<details${open ? ' open' : ''}><summary>Screenshots</summary>`, ''];
  for (const r of withImages.slice(0, maxImages)) {
    const imgs = images(r);
    const tags = imgs.map(([label, rel]) => {
      const url = imageUrl(base!, rel);
      return `<a href="${url}"><img src="${url}" alt="${label}" width="260"></a>`;
    });
    lines.push(
      `**${code(r.name)}** ${code(r.target)}: ${r.status}`,
      '',
      `| ${imgs.map(([label]) => label).join(' | ')} |`,
      `| ${imgs.map(() => '---').join(' | ')} |`,
      `| ${tags.join(' | ')} |`,
      '',
    );
  }
  if (withImages.length > maxImages) lines.push(`…and ${withImages.length - maxImages} more in the full report.`, '');
  lines.push('</details>');
  return lines;
}

function footer(report: Report, opts: MarkdownOptions): string[] {
  const lines: string[] = [];
  const links = [opts.reportUrl && `[Full report](${opts.reportUrl})`, opts.runUrl && `[CI run](${opts.runUrl})`].filter(Boolean);
  if (links.length) lines.push('', links.join(' · '));
  const accept = report.results.some((r) => r.status === 'changed' || r.status === 'added');
  if (accept && opts.acceptCommand) {
    lines.push(
      '',
      'Intended? Review the report, then accept these snapshots as the new baselines and commit them:',
      '',
      '```sh',
      opts.acceptCommand,
      '```',
    );
  }
  return lines;
}

/** The pull-request comment / job summary for a report, as GitHub-flavoured Markdown. */
export function renderMarkdown(report: Report, opts: MarkdownOptions = {}): string {
  const { maxRows = 50, maxImages = 10 } = opts;
  const listed = report.results.filter((r) => LISTED.includes(r.status));
  return (
    [
      ...headline(report, opts.id),
      ...table(listed, maxRows),
      ...checksTable(report, maxRows),
      ...ariaDiffs(listed, report.failed, maxImages),
      ...screenshots(listed, opts.imageBaseUrl, report.failed, maxImages),
      ...footer(report, opts),
    ].join('\n') + '\n'
  );
}
