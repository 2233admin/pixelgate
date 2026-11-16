#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CHECKS, findConfigFile, loadConfig } from './config.js';
import { explore } from './explore.js';
import { renderMarkdown } from './markdown.js';
import { approve, readReport, reportDir, type OutDir } from './report.js';
import { run } from './run.js';

const HELP = `pixelgate - visual regression gate

Usage:
  pixelgate --version
  pixelgate run      [--config <file>] [--only <glob>]... [--json] [-u | --ci]
  pixelgate approve  [--config <file> | --out-dir <dir>] [--from <dir>] [--only <glob>]... [--prune]
  pixelgate summary  [--config <file> | --out-dir <dir>] [--id <id>] [--report-url <url>]
                     [--run-url <url>] [--image-base <url>] [--accept-command <cmd>]
  pixelgate explore  <url> [spec] [--engine <path>] [--time-limit <dur>] [--keep-going] [--headed]
                     [--width <px>] [--height <px>] [--device-scale-factor <n>] [--allow-url <pattern>]...
                     [--config <file>] [--out-dir <dir>]

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

explore  Property-based exploration of <url> with the vendored Bombadil engine (--engine or
         PIXELGATE_ENGINE): random clicks and typing, checked against LTL properties. Writes
         <outDir>/explore/. Exit 0 = no violations, 1 = violations, 2 = engine/usage error.
         Chromium only; it clicks everything, so point it at local or throwaway environments.

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
      engine: { type: 'string' },
      'time-limit': { type: 'string' },
      'keep-going': { type: 'boolean' },
      headed: { type: 'boolean' },
      width: { type: 'string' },
      height: { type: 'string' },
      'device-scale-factor': { type: 'string' },
      'allow-url': { type: 'string', multiple: true },
      // Declared only to refuse it with a reason (mobile emulation is not offered for explore).
      device: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    // package.json sits one level up from both src/ and dist/.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(pkg.version);
    return 0;
  }
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
          r.consoleErrors?.length && `console errors ${r.consoleErrors.length + (r.consoleErrorsDropped ?? 0)}`,
          r.httpErrors?.length && `failed requests ${r.httpErrors.length + (r.httpErrorsDropped ?? 0)}`,
          r.aria && r.aria.status !== 'unchanged' && `aria ${r.aria.status}`,
          r.capped && `capped from ${r.capped.width}x${r.capped.height}`,
        ].filter(Boolean);
        log(`${mark[r.status] ?? '?'} ${r.target} ${r.name}${r.error ? `  ${r.error}` : ''}${checks.length ? `  [${checks.join('; ')}]` : ''}`);
      },
    });
    const s = report.summary;
    log(
      `\n${report.failed ? 'FAIL' : 'PASS'}  total ${s.total}  changed ${s.changed}  added ${s.added}  updated ${s.updated}  removed ${s.removed}  error ${s.error}  unchanged ${s.unchanged}` +
        (CHECKS.some((c) => s[c] > 0)
          ? `\nchecks  ${CHECKS.map((c) => `${c} ${s[c]}`).join('  ')}  (failOn: ${report.failOn.join(', ')})`
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
  if (cmd === 'explore') {
    if (values.device) throw new Error('explore: --device (mobile emulation) is not supported; use --width/--height/--device-scale-factor');
    const [, url, spec, ...extra] = positionals;
    if (!url || extra.length) throw new Error('usage: pixelgate explore <url> [spec] [options]');
    const num = (name: string, v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
      return n;
    };
    const r = await explore({
      url,
      spec,
      engine: values.engine,
      timeLimit: values['time-limit'],
      keepGoing: values['keep-going'],
      headed: values.headed,
      width: num('width', values.width),
      height: num('height', values.height),
      deviceScaleFactor: num('device-scale-factor', values['device-scale-factor']),
      allowUrl: values['allow-url'],
      config: values.config,
      outDir: values['out-dir'],
      cwd,
    });
    const rep = r.report;
    log(
      `
${['PASS', 'FAIL', 'ERROR'][r.exitCode]}  states ${rep.states.length}  violations ${rep.violations.length}` +
        (rep.violations.length ? `  (${[...new Set(rep.violations.map((v) => v.name))].join(', ')})` : '') +
        `
report: ${path.join(r.dir, 'explore.html')}`,
    );
    return r.exitCode;
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
