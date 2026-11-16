# pixelgate

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

## Use

```bash
pixelgate run          # capture + diff + report; exit 1 if the gate fails
pixelgate approve      # accept changed/added snapshots from the last run as the new baseline
pixelgate approve --only 'button--*'
pixelgate approve --prune   # also delete baselines whose page/story is gone
pixelgate run --json   # report JSON on stdout, for scripts and agents
```

Exit codes: `0` pass, `1` a status listed in `failOn` is present, `2` usage or config error.

Snapshot statuses:

| status | meaning |
| --- | --- |
| `unchanged` | matches baseline |
| `changed` | pixels differ beyond tolerance, or size changed |
| `added` | no baseline yet (passes by default; approve to record it) |
| `removed` | baseline exists but the page/story is gone |
| `error` | page failed to load or screenshot timed out |

### Files

```
.pixelgate/
  baseline/<target>/<name>.png   # commit this
  current/<target>/<name>.png    # last run, git-ignored
  diff/<target>/<name>.png       # red = changed pixels, git-ignored
  report/index.html              # open in a browser: side by side, diff, slider
  report/report.json             # machine-readable result
```

Add to `.gitignore`:

```
.pixelgate/current/
.pixelgate/diff/
.pixelgate/report/
```

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

pixelgate loads the project's own `vite` package, starts the server on
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

- Reference: `.pixelgate/baseline/<browser>/<test-file>_<name>.png`
- On a mismatch Vitest fails the test; the new screenshot goes to
  `.pixelgate/current/`, the diff to `.pixelgate/diff/`.
- After each run the reporter writes `.pixelgate/report/`. Review it, then
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
- optionally freezes `Date.now()` (`stabilize.fixedTime`).

Render on the same OS and browser build as your baselines were made on. Font
rasterisation differs between Windows, macOS and Linux; pin CI to one image.

## CI

```yaml
# .github/workflows/visual.yml
- run: pnpm exec playwright install --with-deps chromium
- run: pnpm build && (pnpm preview --port 5173 &) && npx wait-on http://localhost:5173
- run: pnpm exec pixelgate run
- if: failure()
  uses: actions/upload-artifact@v4
  with: { name: pixelgate-report, path: .pixelgate }
```

To accept a change: run `pixelgate approve` locally (or download the artifact),
commit the updated `.pixelgate/baseline/`, push.

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
- GitHub status check and PR comment with the changed snapshots
- DOM-snapshot capture inside Playwright/Cypress tests, rendered in several browsers
- remote render workers for a browser x viewport matrix
- MCP server so agents can run, read and approve without parsing files

## Prior art

[Happo](https://happo.io) (its MIT client inspired the config model and
DOM-snapshot approach), Playwright `toHaveScreenshot`, Lost Pixel, Argos,
reg-suit, BackstopJS. Diffing uses [pixelmatch](https://github.com/mapbox/pixelmatch).

## License

MIT
