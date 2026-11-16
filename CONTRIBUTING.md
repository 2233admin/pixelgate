# Contributing

Read the [Generative AI policy](docs/gen-ai-policy.md) first: AI-written changes are welcome,
with a label and evidence.

## Setup and checks

Setup and the test commands are in [Development](README.md#development). Before you open a
pull request:

```bash
pnpm typecheck
pnpm test
```

`pnpm test` builds `dist/` and runs real Chromium, so install the browser once
(`pnpm exec playwright install chromium-headless-shell`).

## Pull requests

- One change per pull request. They are squash-merged, so the title becomes the commit
  subject: use the `type: summary` form of the history (`feat:`, `fix:`, `docs:`, `ci:`,
  `chore:`).
- Fill in the template: what and why, how you verified it, and what AI you used.
- A behavior change comes with a test. If a change alters what the demo app gated by
  [`visual.yml`](.github/workflows/visual.yml) renders, update its Linux baselines from the
  CI run: download the artifact and `pixelgate approve --from <dir>` (see
  [Per-platform baselines](README.md#per-platform-baselines)).
- New options and behavior go in the README; Happo parity changes also update
  [docs/happo-parity.md](docs/happo-parity.md).
- Dependencies stay on their latest release; CI checks it.

Releases are cut by the maintainer: see [Releasing](README.md#releasing).
