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
pnpm add -D pixelgate
pnpm exec playwright install chromium   # plus firefox / webkit if you target them
```

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
