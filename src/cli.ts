#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { approve, reportDir, run } from './run.js';

const HELP = `pixelgate - visual regression gate

Usage:
  pixelgate run      [--config <file>] [--only <glob>]... [--json]
  pixelgate approve  [--config <file>] [--only <glob>]... [--prune]

run      Capture every snapshot, diff against baseline, write <outDir>/report/.
         Exit 0 = pass, 1 = statuses in \`failOn\` present, 2 = usage/config error.
approve  Promote current screenshots of changed/added snapshots (from the last
         run) to baseline. --prune also deletes baselines reported as removed.

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
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd || values.help ? 0 : 2;
  }
  const cfg = await loadConfig(process.cwd(), values.config);
  const log = (msg: string) => process.stderr.write(msg + '\n');

  if (cmd === 'run') {
    const report = await run(cfg, {
      only: values.only,
      onProgress: (r) => log(`${r.error ? 'x' : '.'} ${r.target} ${r.name}${r.error ? `  ${r.error}` : ''}`),
    });
    const s = report.summary;
    log(
      `\n${report.failed ? 'FAIL' : 'PASS'}  total ${s.total}  changed ${s.changed}  added ${s.added}  removed ${s.removed}  error ${s.error}  unchanged ${s.unchanged}`,
    );
    log(`report: ${path.join(reportDir(cfg), 'index.html')}`);
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.failed ? 1 : 0;
  }
  if (cmd === 'approve') {
    const done = await approve(cfg, { only: values.only, prune: values.prune });
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
