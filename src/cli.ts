#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findConfigFile, loadConfig } from './config.js';
import { renderMarkdown } from './markdown.js';
import { approve, readReport, reportDir, type OutDir } from './report.js';
import { run } from './run.js';

const HELP = `pixelgate - visual regression gate

Usage:
  pixelgate run      [--config <file>] [--only <glob>]... [--json] [-u | --ci]
  pixelgate approve  [--config <file> | --out-dir <dir>] [--from <dir>] [--only <glob>]... [--prune]
  pixelgate summary  [--config <file> | --out-dir <dir>] [--id <id>] [--report-url <url>]
                     [--run-url <url>] [--image-base <url>] [--accept-command <cmd>]

run      Capture every snapshot, diff against baseline, write <outDir>/report/.
         Exit 0 = pass, 1 = statuses in \`failOn\` present, 2 = usage/config error.
         Baseline mode (like Vitest): local default writes missing baselines;
         with CI set (or --ci) nothing is written and a missing baseline fails;
         -u / --update also overwrites mismatching baselines.
approve  Promote current screenshots (and .aria.yml ARIA snapshots) of
         changed/added snapshots (from the last run, or the last Vitest run with
         PixelgateReporter) to baseline.
         --from <dir> takes them from another run's out dir instead, e.g. a CI
         artifact from \`gh run download\`: how a Windows/macOS machine accepts
         Linux CI baselines.
         --prune also deletes baselines reported as removed (ARIA ones too).
         Without a pixelgate config, uses --out-dir (default .pixelgate).
summary  Print the last report as Markdown for a pull-request comment or CI job
         summary. --image-base is the URL the report's image paths resolve
         against (no images without it).

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
      from: { type: 'string' },
      update: { type: 'boolean', short: 'u' },
      ci: { type: 'boolean' },
      id: { type: 'string' },
      'report-url': { type: 'string' },
      'run-url': { type: 'string' },
      'image-base': { type: 'string' },
      'accept-command': { type: 'string' },
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
  // approve/summary only need the out dir: from the config when there is one, else --out-dir.
  const outDir = async (): Promise<OutDir> =>
    values.config || (!values['out-dir'] && findConfigFile(cwd))
      ? await loadConfig(cwd, values.config)
      : { outDir: path.resolve(cwd, values['out-dir'] ?? '.pixelgate') };

  if (cmd === 'run') {
    if (values.update && values.ci) throw new Error('--update and --ci are mutually exclusive');
    const update = values.update ? 'all' : values.ci ? 'none' : undefined;
    const cfg = await loadConfig(cwd, values.config, { update });
    log(`baseline mode: ${cfg.update}`);
    const mark: Record<string, string> = { unchanged: '.', changed: 'C', added: 'A', updated: 'U', error: 'x' };
    const report = await run(cfg, {
      only: values.only,
      onServer: (url) => log(`vite: ${url}`),
      onProgress: (r) => {
        const checks = [
          r.pageErrors?.length && `page errors ${r.pageErrors.length}`,
          r.a11y?.length && `a11y ${r.a11y.map((v) => v.id).join(',')}`,
          r.overflowPx && `overflow ${r.overflowPx}px`,
          r.aria && r.aria.status !== 'unchanged' && `aria ${r.aria.status}`,
        ].filter(Boolean);
        log(`${mark[r.status] ?? '?'} ${r.target} ${r.name}${r.error ? `  ${r.error}` : ''}${checks.length ? `  [${checks.join('; ')}]` : ''}`);
      },
    });
    const s = report.summary;
    log(
      `\n${report.failed ? 'FAIL' : 'PASS'}  total ${s.total}  changed ${s.changed}  added ${s.added}  updated ${s.updated}  removed ${s.removed}  error ${s.error}  unchanged ${s.unchanged}` +
        (s.pageErrors + s.a11y + s.overflow > 0
          ? `\nchecks  pageErrors ${s.pageErrors}  a11y ${s.a11y}  overflow ${s.overflow}  (failOn: ${report.failOn.join(', ')})`
          : ''),
    );
    if (cfg.update === 'none' && s.added > 0) {
      log(
        `${s.added} snapshot(s) have no baseline for this platform (${process.platform}). ` +
          'Their screenshots are in .pixelgate/current/: review them (e.g. from the CI artifact), run `pixelgate approve` ' +
          '(`--from <downloaded artifact>` on another machine), commit .pixelgate/baseline/.',
      );
    }
    log(`report: ${path.join(reportDir(cfg), 'index.html')}`);
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.failed ? 1 : 0;
  }
  if (cmd === 'approve') {
    const done = await approve(await outDir(), { only: values.only, prune: values.prune, from: values.from });
    for (const r of done) log(`approved ${r.status} ${r.target} ${r.name}`);
    log(`${done.length} snapshot(s) approved`);
    return 0;
  }
  if (cmd === 'summary') {
    const report = await readReport(await outDir());
    process.stdout.write(
      renderMarkdown(report, {
        id: values.id,
        reportUrl: values['report-url'],
        runUrl: values['run-url'],
        imageBaseUrl: values['image-base'],
        acceptCommand: values['accept-command'],
      }),
    );
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
