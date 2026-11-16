#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findConfigFile, loadConfig } from './config.js';
import { approve, reportDir, type OutDir } from './report.js';
import { run } from './run.js';

const HELP = `pixelgate - visual regression gate

Usage:
  pixelgate run      [--config <file>] [--only <glob>]... [--json] [-u | --ci]
  pixelgate approve  [--config <file> | --out-dir <dir>] [--only <glob>]... [--prune]

run      Capture every snapshot, diff against baseline, write <outDir>/report/.
         Exit 0 = pass, 1 = statuses in \`failOn\` present, 2 = usage/config error.
         Baseline mode (like Vitest): local default writes missing baselines;
         with CI set (or --ci) nothing is written and a missing baseline fails;
         -u / --update also overwrites mismatching baselines.
approve  Promote current screenshots of changed/added snapshots (from the last
         run, or the last Vitest run with PixelgateReporter) to baseline.
         --prune also deletes baselines reported as removed.
         Without a pixelgate config, uses --out-dir (default .pixelgate).

--json   Print the report JSON to stdout (progress goes to stderr).`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      only: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      prune: { type: 'boolean' },
      'out-dir': { type: 'string' },
      update: { type: 'boolean', short: 'u' },
      ci: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd || values.help ? 0 : 2;
  }
  const cwd = process.cwd();
  const log = (msg: string) => process.stderr.write(msg + '\n');

  if (cmd === 'run') {
    if (values.update && values.ci) throw new Error('--update and --ci are mutually exclusive');
    const update = values.update ? 'all' : values.ci ? 'none' : undefined;
    const cfg = await loadConfig(cwd, values.config, { update });
    log(`baseline mode: ${cfg.update}`);
    const mark: Record<string, string> = { unchanged: '.', changed: 'C', added: 'A', updated: 'U', error: 'x' };
    const report = await run(cfg, {
      only: values.only,
      onServer: (url) => log(`vite: ${url}`),
      onProgress: (r) => log(`${mark[r.status] ?? '?'} ${r.target} ${r.name}${r.error ? `  ${r.error}` : ''}`),
    });
    const s = report.summary;
    log(
      `\n${report.failed ? 'FAIL' : 'PASS'}  total ${s.total}  changed ${s.changed}  added ${s.added}  updated ${s.updated}  removed ${s.removed}  error ${s.error}  unchanged ${s.unchanged}`,
    );
    if (cfg.update === 'none' && s.added > 0) {
      log(
        `${s.added} snapshot(s) have no baseline for this platform (${process.platform}). ` +
          'Their screenshots are in .pixelgate/current/: review them (e.g. from the CI artifact), run `pixelgate approve`, commit .pixelgate/baseline/.',
      );
    }
    log(`report: ${path.join(reportDir(cfg), 'index.html')}`);
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.failed ? 1 : 0;
  }
  if (cmd === 'approve') {
    const target: OutDir =
      values.config || (!values['out-dir'] && findConfigFile(cwd))
        ? await loadConfig(cwd, values.config)
        : { outDir: path.resolve(cwd, values['out-dir'] ?? '.pixelgate') };
    const done = await approve(target, { only: values.only, prune: values.prune });
    for (const r of done) log(`approved ${r.status} ${r.target} ${r.name}`);
    log(`${done.length} snapshot(s) approved`);
    return 0;
  }
  log(`Unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`pixelgate: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
