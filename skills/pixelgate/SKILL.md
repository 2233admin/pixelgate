---
name: pixelgate
description: Use when a project gates UI changes with pixelgate (pixelgate-cli, a pixelgate.config.* file or a .pixelgate/ folder): how to check only what changed, read the report, and approve baselines quickly and cheaply.
---

# pixelgate for agents

pixelgate screenshots pages or stories, diffs them against baselines, and exits non-zero when something changed. The exit code is the gate. A full run captures every snapshot and can take minutes, so check only what your change can affect, and leave the full run for before merge.

## Find the setup first

- Config: `pixelgate.config.*` (or the Vite/Vitest/Playwright integration the README describes). Baselines live in `.pixelgate/baseline/<platform>/`, the last run's report in `.pixelgate/report/index.html` and its JSON.
- Read the project's own scripts (`package.json`, AGENTS.md, CLAUDE.md). If the project has a fast wrapper (for example a script that maps changed files to pages), use it instead of a raw full run.

## Check only what changed

- `pixelgate run --only '<glob>'` captures just the matching snapshots. Repeat `--only` for several globs. Map your changed files to page or story names and pass those.
- If the change touches a shared layer (theme, tokens, layout shell), pick a handful of representative pages rather than everything; the full run before merge catches the rest.
- `pixelgate run --json` prints the report as JSON on stdout. Read that rather than scraping logs.
- Exit codes: `0` pass, `1` a status or check finding listed in `failOn`, `2` usage or config error. On `2`, fix the command or config; don't re-run it.

## Read every diff before approving

- Statuses: `unchanged`, `changed`, `added`, `updated`, `removed`, `error`.
- For each `changed` or `added` snapshot, open the diff in the report and say why it changed: an intended colour, copy or layout change is fine; a refactor that should be pixel-identical (renaming tokens to ones with the same value, moving files, splitting CSS) must show zero changes, and any diff means the refactor is wrong.
- `error` is usually a page that timed out or never held still (animations, clocks, data that keeps changing). Re-run just that snapshot with `--only`. Do not approve it. If it keeps failing, fix the page or the stabilize settings.
- Approve only what you checked: `pixelgate approve --only '<glob>'`. `pixelgate approve` with no `--only` accepts every changed and added snapshot from the last run. Don't use `run -u` to make a gate pass.
- Write in the commit message which snapshots changed and why.

## CI

- In CI (`CI` set, or `--ci`) no baselines are written and missing ones fail. To take baselines from a CI platform, download its out-dir artifact and `pixelgate approve --from <dir>`.
- `pixelgate summary` prints the last report as Markdown for a PR comment.

## Keep it cheap

- One capture run at a time per machine: pixelgate drives real Chromium, and parallel runs on a small machine slow each other down until they time out.
- Don't run the full gate after every edit. Run it once, before merge.
