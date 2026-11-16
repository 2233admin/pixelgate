/**
 * One capture to one report row: decide the outcome, write the files, add the check
 * findings and the ARIA snapshot. Shared by `pixelgate run` and the Playwright Test fixture.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { applyAriaOutcome, ARIA_EXT, ariaResult, determineAriaOutcome, withAria } from './aria.js';
import type { CaptureResult } from './capture.js';
import type { Matcher } from './compare.js';
import type { ResolvedConfig } from './config.js';
import { applyOutcome, determineOutcome, toResult } from './outcome.js';
import { baselinePath, currentPath, diffPath, type SnapshotResult } from './report.js';

export async function recordCapture(cfg: ResolvedConfig, c: CaptureResult, compare: Matcher['compare']): Promise<SnapshotResult> {
  const ext = `.${cfg.codec.extension}`;
  const paths = {
    baseline: baselinePath(cfg, c.target, c.name, ext),
    current: currentPath(cfg, c.target, c.name, ext),
    diff: diffPath(cfg, c.target, c.name),
  };
  const outcome = await determineOutcome({ shot: c.shot, error: c.error, reference: c.reference, update: cfg.update, compare });
  await applyOutcome(outcome, paths);
  const r = toResult(outcome, {
    o: cfg,
    target: c.target,
    name: c.name,
    paths,
    hadReference: c.reference !== null,
    stableTimeoutMs: cfg.stabilize.stableTimeoutMs,
  });
  if (c.pageErrors.length) r.pageErrors = c.pageErrors;
  if (c.blocked?.length) r.blocked = c.blocked;
  if (c.capped) r.capped = c.capped;
  if (c.unreadableStylesheets?.length) r.unreadableStylesheets = c.unreadableStylesheets;
  if (c.a11y?.length) r.a11y = c.a11y;
  if (c.overflowPx) r.overflowPx = c.overflowPx;
  // A failed capture compares no ARIA snapshot.
  if (r.status !== 'error' && c.aria !== undefined) {
    const ariaPaths = { baseline: baselinePath(cfg, c.target, c.name, ARIA_EXT), current: currentPath(cfg, c.target, c.name, ARIA_EXT) };
    const reference = existsSync(ariaPaths.baseline) ? await readFile(ariaPaths.baseline, 'utf8') : null;
    const ariaOutcome = determineAriaOutcome(c.aria, reference, cfg.update);
    await applyAriaOutcome(ariaOutcome, ariaPaths);
    withAria(r, ariaResult(ariaOutcome, { o: cfg, paths: ariaPaths, reference }));
  }
  return r;
}
