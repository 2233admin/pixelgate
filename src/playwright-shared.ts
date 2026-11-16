/** What `pixelgate-cli/playwright` and its reporter share; free of @playwright/test at runtime. */
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { isCI, resolveConfig, type Config, type FailOn, type ResolvedConfig, type UpdateMode } from './config.js';
import type { SnapshotResult } from './report.js';

/** pixelgate settings for Playwright Test: `use: { pixelgateOptions: {...} }`, per project too. */
export type PixelgateOptions = Pick<
  Config,
  | 'outDir'
  | 'update'
  | 'platformSpecific'
  | 'threshold'
  | 'maxDiffPixelRatio'
  | 'comparator'
  | 'comparators'
  | 'format'
  | 'codecs'
  | 'timeoutMs'
  | 'stabilize'
  | 'hideBehavior'
  | 'mask'
  | 'maskColor'
  | 'checks'
  | 'ariaSnapshot'
  | 'maxHeight'
  | 'maxWidth'
  | 'includeOutlinesAndShadows'
  | 'applyPseudoClasses'
  | 'failOn'
>;

/** Name of the test attachment that carries one result to the reporter. */
export const ATTACHMENT = 'pixelgate-result';

/** What a worker hands the reporter for one screenshot. */
export interface PixelgateAttachment {
  outDir: string;
  failOn: FailOn[];
  result: SnapshotResult;
}

/** Working directory: `outDir` relative to the Playwright config file's directory. */
export function outDirOf(config: { configFile?: string }, opts: PixelgateOptions): string {
  return path.resolve(config.configFile ? path.dirname(config.configFile) : process.cwd(), opts.outDir ?? '.pixelgate');
}

/**
 * Baseline mode: an explicit `update` wins; else Playwright's `updateSnapshots`
 * (`--update-snapshots`): all/changed overwrite, missing writes new ones, none writes
 * nothing, and the default follows pixelgate's rule (nothing written in CI).
 */
export function updateMode(opts: PixelgateOptions, updateSnapshots: string): UpdateMode {
  if (opts.update) return opts.update;
  switch (updateSnapshots) {
    case 'all':
    case 'changed':
      return 'all';
    case 'missing':
      return 'new';
    case 'none':
      return 'none';
    default:
      return isCI() ? 'none' : 'new';
  }
}

/** The pixelgate config for one Playwright project: its target is the project (or browser) name. */
export function configFor(opts: PixelgateOptions, info: Pick<TestInfo, 'config' | 'project'>, browserName: string): ResolvedConfig {
  const name = info.project.name || browserName;
  return resolveConfig(
    // `resolveConfig` wants pages; the snapshots come from the tests instead.
    { ...opts, outDir: outDirOf(info.config, opts), pages: [{ name: '_', url: 'about:blank' }], targets: { [name]: {} } },
    process.cwd(),
    { update: updateMode(opts, info.config.updateSnapshots) },
  );
}
