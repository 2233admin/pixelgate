/**
 * ARIA snapshots: Playwright's `ariaSnapshot()` (the accessibility tree as YAML: roles,
 * names, states, text) kept as a `.aria.yml` baseline next to the screenshot and compared
 * as text. Like `outcome.ts`, the branching is pure (`determineAriaOutcome`), the writes
 * are in one place (`applyAriaOutcome`), and `ariaResult` makes the report entry.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Status, UpdateMode } from './config.js';
import { rel, type AriaResult, type OutDir, type SnapshotResult } from './report.js';

export const ARIA_EXT = '.aria.yml';

/** Patch size kept in the report; the full text is in the `.aria.yml` file. */
const MAX_PATCH_LINES = 200;
const MAX_PATCH_CHARS = 20_000;

/** LF line ends, no trailing whitespace, one final newline: a CRLF checkout (git autocrlf) still matches. */
export function normalizeAria(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

/** Unified diff baseline -> current, without jsdiff's `====` banner, capped for the report. */
export function ariaPatch(file: string, baseline: string, current: string): Pick<AriaResult, 'patch' | 'truncated'> {
  const full = createTwoFilesPatch(`baseline/${file}`, `current/${file}`, normalizeAria(baseline), current, undefined, undefined, {
    context: 3,
  });
  const lines = full.slice(full.indexOf('--- ')).replace(/\n$/, '').split('\n');
  let kept = lines.slice(0, MAX_PATCH_LINES);
  while (kept.length > 1 && kept.join('\n').length > MAX_PATCH_CHARS) kept = kept.slice(0, -1);
  return kept.length < lines.length ? { patch: kept.join('\n'), truncated: true } : { patch: kept.join('\n') };
}

/** Lines added and removed by a patch (hunk bodies only, not the `---`/`+++` header). */
export function patchDelta(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) inHunk = true;
    else if (inHunk && l.startsWith('+')) added++;
    else if (inHunk && l.startsWith('-')) removed++;
  }
  return { added, removed };
}

export type AriaOutcome =
  | { type: 'matched' }
  /** No baseline yet: written to `baseline` (mode new/all) or to `current` for review (mode none). */
  | { type: 'missing-reference'; location: 'baseline' | 'current'; actual: string }
  | { type: 'update-reference'; actual: string }
  | { type: 'mismatch'; actual: string };

/** `actual` is already normalised (`captureAria`); the baseline is normalised here. */
export function determineAriaOutcome(actual: string, reference: string | null, update: UpdateMode): AriaOutcome {
  if (reference === null) return { type: 'missing-reference', location: update === 'none' ? 'current' : 'baseline', actual };
  if (normalizeAria(reference) === actual) return { type: 'matched' };
  return update === 'all' ? { type: 'update-reference', actual } : { type: 'mismatch', actual };
}

export interface AriaPaths {
  baseline: string;
  current: string;
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** The only place a run writes `.aria.yml` files. Always LF. */
export async function applyAriaOutcome(outcome: AriaOutcome, paths: AriaPaths): Promise<void> {
  switch (outcome.type) {
    case 'missing-reference':
      await put(outcome.location === 'baseline' ? paths.baseline : paths.current, outcome.actual);
      break;
    case 'update-reference':
      await put(paths.baseline, outcome.actual);
      break;
    case 'mismatch':
      await put(paths.current, outcome.actual);
      break;
  }
}

export function ariaResult(outcome: AriaOutcome, ctx: { o: OutDir; paths: AriaPaths; reference: string | null }): AriaResult {
  const { o, paths } = ctx;
  const baseline = rel(o, paths.baseline);
  const file = path.basename(paths.baseline);
  switch (outcome.type) {
    case 'matched':
      return { status: 'unchanged', baseline };
    case 'missing-reference':
      return outcome.location === 'baseline' ? { status: 'added', baseline } : { status: 'added', current: rel(o, paths.current) };
    case 'update-reference':
      return { status: 'updated', baseline, ...ariaPatch(file, ctx.reference ?? '', outcome.actual) };
    case 'mismatch':
      return { status: 'changed', baseline, current: rel(o, paths.current), ...ariaPatch(file, ctx.reference ?? '', outcome.actual) };
  }
}

/** Worst first is last: a row shows the more serious of its screenshot and ARIA outcomes. */
const RANK: Status[] = ['unchanged', 'updated', 'added', 'changed', 'error'];

/** Attaches an ARIA result to a snapshot row and folds its status into the row's. */
export function withAria(r: SnapshotResult, aria: AriaResult): SnapshotResult {
  r.aria = aria;
  if (aria.status !== 'removed' && RANK.indexOf(aria.status) > RANK.indexOf(r.status)) r.status = aria.status;
  return r;
}
