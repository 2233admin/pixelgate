import type { Status } from './config.js';
import type { Report, SnapshotResult } from './report.js';

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
      const parts = [r.diffRatio !== undefined ? `${percent(r.diffRatio)} of pixels` : r.message ?? 'changed'];
      if (r.sizeChanged) parts.push('size changed');
      return parts.join(', ');
    }
    case 'added':
      return 'no baseline yet';
    case 'updated':
      return 'baseline overwritten';
    case 'removed':
      return 'baseline with no snapshot in this run';
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
      ? [['Baseline', r.baseline], ['Current', r.current], ['Diff', r.diff]]
      : r.status === 'removed'
        ? [['Baseline', r.baseline]]
        : [['Current', r.current ?? r.baseline]];
  return out.filter((x): x is [string, string] => !!x[1]);
}

function imageUrl(base: string, rel: string): string {
  return base.replace(/\/+$/, '') + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

function headline(report: Report, id?: string): string[] {
  const s = report.summary;
  const counts = LISTED.filter((st) => s[st] > 0).map((st) => `${s[st]} ${st}`);
  if (s.unchanged > 0) counts.push(`${s.unchanged} unchanged`);
  return [
    commentMarker(id),
    `### pixelgate: ${report.failed ? 'failed' : 'passed'}`,
    '',
    `${counts.join(', ') || 'no snapshots'} (${s.total} total).`,
  ];
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
      'Intended? Review the report, then accept these screenshots as the new baselines and commit them:',
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
      ...screenshots(listed, opts.imageBaseUrl, report.failed, maxImages),
      ...footer(report, opts),
    ].join('\n') + '\n'
  );
}
