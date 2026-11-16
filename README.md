# pixelgate

[![CI](https://github.com/2233admin/pixelgate/actions/workflows/ci.yml/badge.svg)](https://github.com/2233admin/pixelgate/actions/workflows/ci.yml)

Self-hosted visual regression testing. MIT licensed, no SaaS, no account.

pixelgate renders your pages or Storybook stories in real browsers (Playwright),
diffs them pixel by pixel against a committed baseline, writes a static review
page, and exits non-zero when something changed. That exit code is the gate:
for CI, for a pre-push hook, or for a coding agent checking its own UI work.

## Why

Frontend review is slow because a human has to look at every screen after
every change. pixelgate does the looking. People (or agents) only review the
snapshots that actually changed, side by side, with the changed pixels marked.

Hosted services such as Happo do this well, but the rendering farm, the diff
engine and the review UI are closed. pixelgate keeps all of it local:
baselines live in your repo, the report is a folder of PNGs plus one HTML file.

## Install

```bash
pnpm add -D pixelgate playwright
pnpm exec playwright install chromium   # plus firefox / webkit if you target them
```

`playwright` is a peer dependency: pixelgate drives your project's Playwright,
so `playwright install` always fetches the browser build that version expects.
`vite` and `vitest` are optional peers, used only by the adapters below.

Node 22.18 or newer (so `pixelgate.config.ts` loads without a build step).

## Configure

`pixelgate.config.ts` in the project root:

```ts
import { defineConfig } from 'pixelgate';

export default defineConfig({
  targets: {
    desktop: { browser: 'chromium', viewport: '1280x720' },
    mobile: { browser: 'chromium', viewport: '375x667', deviceScaleFactor: 2 },
    // firefox: { browser: 'firefox', viewport: '1280x720' },
  },
  // Plain URLs from a running dev server or preview build...
  pages: [
    { name: 'home', url: 'http://localhost:5173/' },
    { name: 'settings-form', url: 'http://localhost:5173/settings', selector: 'form' },
  ],
  // ...and/or every story of a running Storybook (7+ index.json, 6.x stories.json).
  storybook: { url: 'http://localhost:6006', exclude: ['*--playground'] },

  threshold: 0.1,          // per-pixel colour tolerance (0..1)
  maxDiffPixelRatio: 0,    // share of changed pixels still counted as unchanged
  failOn: ['changed', 'error'],
  stabilize: {
    css: '.clock, .ad { visibility: hidden }',
    fixedTime: '2026-01-01T00:00:00Z',
  },
});
```

`.js`, `.mjs` and `.json` configs work too.

### Interactions

A page entry captures the page as loaded. To capture a state the user reaches
by interacting (an open menu, a selected row, a filled form), give it a
`beforeCapture` hook. It gets the Playwright `Page` after load and `waitFor`,
before the stability loop:

```ts
pages: [
  { name: 'graph', url: '/', waitFor: '.node >> nth=2' },
  {
    name: 'graph-selected',
    url: '/',
    waitFor: '.node >> nth=2',
    beforeCapture: (page) => page.locator('.node').nth(1).click(),
  },
],
```

A hook that throws (say, a selector that no longer exists) makes that snapshot
an `error`, not a crashed run. Hooks are functions, so they need a `.ts`,
`.js` or `.mjs` config.

## Use

```bash
pixelgate run          # capture + diff + report; exit 1 if the gate fails
pixelgate run -u       # also overwrite baselines that changed (accept everything)
pixelgate run --ci     # CI mode: write no baselines, fail on missing ones (automatic when CI is set)
pixelgate approve      # accept changed/added snapshots from the last run as the new baseline
pixelgate approve --only 'button--*'
pixelgate approve --prune   # also delete baselines whose page/story is gone
pixelgate approve --from <dir>  # accept from another run's out dir, e.g. a downloaded CI artifact
pixelgate summary      # the last report as Markdown (PR comment, CI job summary)
pixelgate run --json   # report JSON on stdout, for scripts and agents
```

Exit codes: `0` pass, `1` a status listed in `failOn` is present, `2` usage or config error.

Snapshot statuses:

| status | meaning |
| --- | --- |
| `unchanged` | matches baseline |
| `changed` | pixels differ beyond tolerance, or size changed |
| `added` | no baseline yet (see baseline modes) |
| `updated` | baseline overwritten by `-u` |
| `removed` | baseline exists but the page/story is gone |
| `error` | page failed to load, timed out, or never held still |

### Baseline modes

Same three modes as Vitest's `updateSnapshot` (`update` in the config, or the flags):

| mode | when | missing baseline | mismatch |
| --- | --- | --- | --- |
| `new` | local default | written to `baseline/`, status `added`, passes | `changed`, fails |
| `none` | `CI` set, or `--ci` | screenshot to `current/`, status `added`, **fails** | `changed`, fails |
| `all` | `-u` | written to `baseline/` | baseline overwritten, `updated`, passes |

So a new page or story can't slip through CI without a reviewed baseline.

### Per-platform baselines

Font rasterisation differs between Windows, macOS and Linux, so baselines live
in `<target>-<platform>/` (e.g. `desktop-linux/`), as Vitest does in its file
names. A Linux CI run never compares against baselines made on Windows: it
reports them as missing instead of failing with noise. Create the CI
platform's baselines from a CI run (`--ci` leaves them in `current/`, then
`pixelgate approve`). Set `platformSpecific: false` to share one set.

### Files

```
.pixelgate/
  baseline/<target>-<platform>/<name>.png   # commit this
  current/<target>-<platform>/<name>.png    # last run, git-ignored
  diff/<target>-<platform>/<name>.png       # red = changed pixels, git-ignored
  report/index.html              # open in a browser: side by side, diff, slider
  report/report.json             # machine-readable result
```

Add to `.gitignore`:

```
.pixelgate/current/
.pixelgate/diff/
.pixelgate/report/
```

## Comparators and formats

Comparison is pluggable the way Vitest's `toMatchScreenshot` is: a comparator
gets two decoded RGBA images and returns `{ pass, diffPixels, diffRatio, sizeChanged, diff, message }`.

| `comparator` | judges | tolerance |
| --- | --- | --- |
| `pixelmatch` (default) | each pixel's colour; ignores detected anti-aliasing | `threshold`, `maxDiffPixelRatio`, `maxDiffPixels` |
| `ssim` | each local window's luminance/contrast/structure, per R/G/B channel | `minSimilarity` (per window, default 0.8), `maxDiffPixelRatio` |

`ssim` fails on any window below `minSimilarity`, not on the mean score, so a
small change in a large page can't average away. It also runs per colour
channel, because luma-only SSIM can't see a blue to green change of similar
brightness. Measured on the calibration scenes in `test/unit.test.ts`:
scattered ±20 noise and a +16 brightness shift pass, a 1px element shift, a
hue change or a moved box fail. The failure message names the share of the
image, the worst window and the mean.

```ts
export default defineConfig({
  comparator: { name: 'ssim', options: { minSimilarity: 0.7 } },
  // or your own, same contract:
  comparators: { myDiff: (reference, actual, { createDiff }) => ({ pass, diffPixels, diffRatio, sizeChanged, diff, message }) },
  format: 'jpeg',          // baseline/current files: 'png' (default) | 'jpeg' | a key of `codecs`
  codecs: { /* name: { extension, decode, encode, screenshot? } */ },
});
```

JPEG (quality 90) makes baselines several times smaller; Playwright captures
it natively. Custom codecs (e.g. WebP via `sharp`) get a PNG capture
re-encoded. Diff images are always PNG.

## Vite

Let pixelgate start your Vite app for the run; page URLs become relative:

```ts
export default defineConfig({
  vite: { mode: 'dev' },          // or 'preview' (runs `vite build` first unless build: false)
  pages: [
    { name: 'home', url: '/' },
    { name: 'settings', url: '/settings', selector: 'main' },
  ],
});
```

pixelgate loads the project's own `vite` (5 or later), starts the server on
`127.0.0.1` (HMR off), resolves relative URLs against it (your `base`, e.g.
`/app/`, is kept), and closes it when the run ends. Options: `root`,
`configFile`, `port`, `build`. Not on Vite? Run your server yourself and set
`baseUrl: 'http://localhost:3000'`.

## Vitest browser mode

Already writing component tests with Vitest browser mode and
`toMatchScreenshot`? Keep them. pixelgate only routes the files into its
layout and writes the review page, so `pixelgate approve` and the HTML report
work the same for both:

```ts
// vitest.config.ts
import { playwright } from '@vitest/browser-playwright';
import { PixelgateReporter, pixelgateScreenshots } from 'pixelgate/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', new PixelgateReporter()],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      expect: { toMatchScreenshot: pixelgateScreenshots() },
    },
  },
});
```

```ts
// Button.browser.test.ts
import { expect, test } from 'vitest';
import { page } from 'vitest/browser';

test('primary button', async () => {
  render(<Button variant="primary">Save</Button>);
  await expect(page.getByRole('button')).toMatchScreenshot('primary');
});
```

- Reference: `.pixelgate/baseline/<browser>-<platform>/<test-file>_<name>.png`
  (`pixelgateScreenshots({ platformSpecific: false })` drops the platform)
- On a mismatch Vitest fails the test; the new screenshot goes to
  `.pixelgate/current/`, the diff to `.pixelgate/diff/`.
- After each run the reporter writes `.pixelgate/report/`, with the changed
  share and pixel count of each mismatch (measured by pixelgate with
  pixelmatch at threshold 0.1; Vitest's own comparator still decides
  pass/fail). Review it, then
  `pixelgate approve` (no pixelgate config needed; `--out-dir` if you moved it),
  or `vitest -u` to accept everything.

Vitest also copies failure images into its own attachments directory
(`.vitest/` by default); git-ignore it next to the `.pixelgate/` entries.

Comparison, retries and thresholds stay Vitest's (`comparatorName`,
`comparatorOptions` in the same `toMatchScreenshot` block).

## Stable screenshots

Before every capture pixelgate:

- waits for `load`, then up to 5 s for network idle, then `document.fonts.ready` and pending image decodes;
- injects CSS that zeroes animations and transitions and hides the caret, and uses Playwright's `animations: 'disabled'`;
- runs with `reducedMotion: 'reduce'`, `locale: en-US`, `timezoneId: UTC`, light colour scheme;
- optionally freezes `Date.now()` (`stabilize.fixedTime`);
- then captures until the page holds still, like Vitest's `toMatchScreenshot`:
  if the first screenshot matches the baseline it's done (one capture, no
  decode when the bytes are identical); otherwise it keeps capturing until two
  consecutive screenshots match. Captures are spaced
  `stabilize.stableIntervalMs` apart (default 100): a screenshot can take
  ~15 ms, faster than a 30 ms JS ticker, and back-to-back shots would catch
  the same frame. A page still moving after `stabilize.stableTimeoutMs`
  (default 5000, `0` = single shot) is reported as an `error` with its last
  frame in `current/`, instead of a flaky `changed`.

CSS can stop animations but not JavaScript timers (tickers, carousels, data
arriving late); the stability loop is what covers those.

## CI and pull requests

This repository is also a GitHub Action. On a pull request it runs the gate,
uploads the review report as an artifact, writes a job summary and keeps one
comment on the pull request up to date:

```yaml
# .github/workflows/visual.yml
name: visual
on: pull_request
permissions:
  contents: write # only for images-branch
  pull-requests: write # the comment
jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
      - run: npm ci
      - run: npx playwright install --with-deps chromium-headless-shell
      # Pin the same commit as the pixelgate you installed.
      - uses: 2233admin/pixelgate@<sha>
        with:
          images-branch: pixelgate-images # optional: screenshots in the comment
```

The comment lists every changed, added, removed and failed snapshot, links the
report artifact and the run, and prints the command that accepts the change.
With `images-branch` it also shows baseline, current and diff images.

| input | default | |
| --- | --- | --- |
| `working-directory` | `.` | where the pixelgate config is |
| `command` | `npx --no pixelgate` | how to call the CLI there |
| `args` | | extra `pixelgate run` arguments, e.g. `--only 'button--*'` |
| `out-dir` | `.pixelgate` | the config's `outDir` |
| `artifact-name` | `pixelgate` | one per job; also keeps the jobs' comments apart |
| `comment` | `true` | a passing run with no earlier comment posts nothing |
| `images-branch` | | branch for the comment's screenshots; empty = no images |
| `fail` | `true` | fail the step when the gate fails |
| `github-token` | `github.token` | |

Outputs: `result` (`pass`, `fail`, `error`) and `artifact-url`.

**Accepting a change.** CI renders on Linux; your machine may not. The comment
prints a command like this one, to run in the project:

```sh
d=$(mktemp -d) && gh run download <run-id> -R <owner>/<repo> -n pixelgate -D "$d" \
  && npx --no pixelgate approve --from "$d"
```

It downloads the artifact and copies its screenshots into
`.pixelgate/baseline/<target>-linux/`. Commit and push; the next run passes.
The first run on a platform works the same way: every snapshot is `added`, the
gate fails, and you accept from the comment.

- Images in the comment come from `raw.githubusercontent.com`, so they render
  for public repositories only. Private repositories still get the table and
  the report artifact. The images branch only grows; delete it any time.
- Pull requests from forks get a read-only token: no comment and no images
  (both are warnings), the gate itself still runs.
- Other CI: `pixelgate run --ci`, keep `.pixelgate` as an artifact, and
  `pixelgate summary` prints the same Markdown for any comment API.

This repository gates `test/fixtures/vite-app` with its own action:
[`.github/workflows/visual.yml`](.github/workflows/visual.yml).

## Programmatic API

```ts
import { loadConfig, run, approve } from 'pixelgate';

const cfg = await loadConfig(process.cwd());
const report = await run(cfg, { only: ['home'] });
if (report.failed) console.log(report.results.filter((r) => r.status === 'changed'));
```

## Development

```bash
pnpm install
pnpm exec playwright install chromium-headless-shell
pnpm test            # builds dist first; e2e runs real Chromium, a Vite app and a Vitest browser project
pnpm deps:check      # exits non-zero if any dependency is behind latest
pnpm deps:latest     # move everything to latest
```

Dependency policy: always on the latest release of every dependency. Dependabot
opens the bumps weekly; `deps:check` must be clean before a release.

## Roadmap

- accessibility checks (axe-core) in the same render pass
- DOM-snapshot capture inside Playwright/Cypress tests, rendered in several browsers
- remote render workers for a browser x viewport matrix
- MCP server so agents can run, read and approve without parsing files

## Prior art

[Happo](https://happo.io) (its MIT client inspired the config model and
DOM-snapshot approach), Playwright `toHaveScreenshot`, Lost Pixel, Argos,
reg-suit, BackstopJS. Diffing uses [pixelmatch](https://github.com/mapbox/pixelmatch).

## License

MIT
