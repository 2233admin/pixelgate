/**
 * What happened to one snapshot, decided in one place.
 *
 * Mirrors Vitest's `toMatchScreenshot` split: `determineOutcome` is pure (all
 * branching, no I/O), `applyOutcome` performs the file writes the outcome
 * calls for, and `toResult` turns it into a report row.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StableShot } from './capture.js';
import type { CompareResult } from './compare.js';
import type { UpdateMode } from './config.js';
import { rel, type OutDir, type SnapshotResult } from './report.js';

export type Outcome =
  | { type: 'capture-error'; error: string }
  | { type: 'unstable'; actual: Buffer; retries: number }
  /** First capture matched the reference: no comparison needed. */
  | { type: 'matched-immediately' }
  | { type: 'matched-after-comparison'; compare: CompareResult }
  /** No baseline yet: written to `baseline` (mode new/all) or to `current` for review (mode none). */
  | { type: 'missing-reference'; location: 'baseline' | 'current'; actual: Buffer }
  | { type: 'update-reference'; actual: Buffer; compare: CompareResult }
  | { type: 'mismatch'; actual: Buffer; compare: CompareResult };

export interface OutcomeInput {
  shot?: StableShot;
  error?: string;
  reference: Buffer | null;
  update: UpdateMode;
  /** The configured comparator (via `Matcher.compare`); its `pass` decides. */
  compare: (reference: Buffer, actual: Buffer) => Promise<CompareResult>;
}

/** All branching lives here; the only async work is the comparison itself. */
export async function determineOutcome(input: OutcomeInput): Promise<Outcome> {
  const { shot, reference, update } = input;
  if (input.error || !shot) return { type: 'capture-error', error: input.error ?? 'no screenshot produced' };
  if (!shot.stable) return { type: 'unstable', actual: shot.buffer, retries: shot.retries };
  if (reference === null) {
    return { type: 'missing-reference', location: update === 'none' ? 'current' : 'baseline', actual: shot.buffer };
  }
  if (shot.matchedReference) return { type: 'matched-immediately' };
  const compare = await input.compare(reference, shot.buffer);
  if (compare.pass) return { type: 'matched-after-comparison', compare };
  if (update === 'all') return { type: 'update-reference', actual: shot.buffer, compare };
  return { type: 'mismatch', actual: shot.buffer, compare };
}

export interface SnapshotPaths {
  baseline: string;
  current: string;
  diff: string;
}

async function put(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** The only place a run writes snapshot files. */
export async function applyOutcome(outcome: Outcome, paths: SnapshotPaths): Promise<void> {
  switch (outcome.type) {
    case 'missing-reference':
      await put(outcome.location === 'baseline' ? paths.baseline : paths.current, outcome.actual);
      break;
    case 'update-reference':
      await put(paths.baseline, outcome.actual);
      break;
    case 'mismatch':
      await put(paths.current, outcome.actual);
      if (outcome.compare.diffPng) await put(paths.diff, outcome.compare.diffPng);
      break;
    case 'unstable':
      // Keep the last frame so the reviewer can see what kept moving.
      await put(paths.current, outcome.actual);
      break;
  }
}

export function toResult(
  outcome: Outcome,
  ctx: { o: OutDir; target: string; name: string; paths: SnapshotPaths; hadReference: boolean; stableTimeoutMs: number },
): SnapshotResult {
  const { o, paths } = ctx;
  const r: SnapshotResult = { target: ctx.target, name: ctx.name, status: 'unchanged' };
  if (ctx.hadReference) r.baseline = rel(o, paths.baseline);
  const metrics = (c: CompareResult) => {
    r.diffPixels = c.diffPixels;
    r.diffRatio = c.diffRatio;
    r.sizeChanged = c.sizeChanged;
    if (c.message) r.message = c.message;
  };
  switch (outcome.type) {
    case 'capture-error':
      r.status = 'error';
      r.error = outcome.error;
      break;
    case 'unstable':
      r.status = 'error';
      r.error = `Could not capture a stable screenshot within ${ctx.stableTimeoutMs}ms (${outcome.retries} retries)`;
      r.current = rel(o, paths.current);
      break;
    case 'matched-immediately':
      break;
    case 'matched-after-comparison':
      metrics(outcome.compare);
      break;
    case 'missing-reference':
      r.status = 'added';
      if (outcome.location === 'baseline') r.baseline = rel(o, paths.baseline);
      else r.current = rel(o, paths.current);
      break;
    case 'update-reference':
      r.status = 'updated';
      r.baseline = rel(o, paths.baseline);
      metrics(outcome.compare);
      break;
    case 'mismatch':
      r.status = 'changed';
      r.current = rel(o, paths.current);
      if (outcome.compare.diffPng) r.diff = rel(o, paths.diff);
      metrics(outcome.compare);
      break;
  }
  return r;
}
