---
name: pixelgate
description: Use when a project gates UI changes with pixelgate (pixelgate-cli, a pixelgate.config.* file or a .pixelgate/ folder): how to check only what changed, read the report, and approve baselines quickly and cheaply.
---

# pixelgate for agents

pixelgate screenshots pages or stories, diffs them against baselines, runs a few checks (accessibility, overflow, errors), and exits non-zero when something fails. The exit code is the gate. A full run captures every snapshot and can take minutes, so check only what your change can affect, and leave the full run for before merge.

This file is what `pixelgate skill` prints. `pixelgate skill install` writes it to `.claude/skills/pixelgate/SKILL.md` (`--dir <dir>` for another skills folder); re-run that after upgrading pixelgate so the copy matches the CLI.

## Find the setup first

- Config: `pixelgate.config.*` for `pixelgate run`. Projects can also run pixelgate inside Vitest browser mode (`PixelgateReporter` from `pixelgate-cli/vitest`) or Playwright Test (`pixelgate-cli/playwright-reporter`); then the gate is that test command, and `pixelgate approve` / `summary` still read its out dir.
- Out dir (default `.pixelgate/`): `baseline/<target>-<platform>/` holds the committed baselines, `current/` the last screenshots, `report/index.html` the review page.
- Read the project's own scripts first (`package.json`, AGENTS.md, CLAUDE.md). If it has a fast wrapper, for example one that maps changed files to pages, use that rather than a raw full run.

## Check only what changed

- `pixelgate run --only '<glob>'` captures just the matching snapshots; repeat `--only` for several globs. Map your changed files to page or story names and pass those.
- A change to a shared layer (theme, tokens, layout shell) can affect everything: pick a handful of representative pages, and let the full run before merge catch the rest.
- `pixelgate run --json` prints the report JSON on stdout (progress goes to stderr). Read `summary` and each result's `status` and findings from it rather than scraping logs.
- Exit codes: `0` pass; `1` a status or check finding listed in `failOn` is present; `2` usage or config error. On `2`, fix the command or the config instead of re-running it.
- Baseline modes: locally a missing baseline is written (`added`); in CI (`CI` set, or `--ci`) nothing is written and a missing baseline fails. `-u` overwrites every changed baseline: never use it to make a gate pass.

## Read every result before approving

| status | what to do |
| --- | --- |
| `unchanged` | nothing |
| `changed` | open the diff on the review page and say why it changed. An intended colour, copy or layout change is fine. A refactor that should be pixel-identical (tokens renamed to ones with the same value, files moved, CSS split) must show no change: a diff means the refactor is wrong, so fix the code. |
| `added` | look at the new screenshot before approving it |
| `removed` | the page or story is gone; if that was intended, `approve --prune` deletes its baseline |
| `error` | the page failed to load, timed out or never held still (animations, clocks, live data). Re-run just that snapshot with `--only`. Never approve it; if it keeps failing, fix the page or the `stabilize` settings. |

- Approve only what you looked at: `pixelgate approve --only '<glob>'`. Plain `pixelgate approve` accepts every changed and added snapshot from the last run.
- Checks (`a11y`, `overflow`, `pageErrors`, `consoleErrors`, `httpErrors`) are findings, not pixels: they gate only when listed in `failOn`, and `approve` does not clear them. Fix the page.
- ARIA snapshots (`.aria.yml` next to the PNG) are approved together with the screenshot.
- Write in the commit message which snapshots changed and why.

## CI and pull requests

- To take baselines from a CI platform: download the run's out-dir artifact (`gh run download`) and `pixelgate approve --from <dir>`.
- `pixelgate summary` prints the last report as Markdown for a PR comment or job summary; `--image-base <url>` makes its images resolve, `--accept-command <cmd>` tells reviewers how to accept.

## Exploring (optional)

`pixelgate explore <url> [spec]` clicks and types at random and checks properties after every step (by default no uncaught exceptions and the like; your own LTL properties in `spec`). It writes `<outDir>/explore/` and exits `1` on violations. Point it only at local or throwaway environments, give it a `--time-limit`, and in CI fetch the engine first with `pixelgate engine install`.

## Keep it cheap

- One capture run at a time per machine: pixelgate drives real Chromium, and parallel runs on a small machine slow each other down until snapshots time out and turn into `error`.
- Don't run the full gate after every edit. Run it once, before merge.
