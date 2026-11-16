# Happo capability parity

Where pixelgate stands against [Happo](https://docs.happo.io)'s documented capabilities
(34 current doc pages, read 2026-11-16). Status: HAVE / PARTIAL / GAP / N/A (SaaS-only,
out of scope for a self-hosted tool). Updated with each parity slice.

## Slices

1. **Deterministic capture and target emulation** (done): `data-pixelgate-hide` +
   `hideBehavior`, `mask`, `allowedHostnames`, per-target `device`, `colorScheme`,
   `reducedMotion`, `extraHTTPHeaders`.
2. **Checks without a baseline** (done): `checks.a11y` (axe-core), `checks.overflow`,
   page errors; result fields plus opt-in `failOn` conditions, which `approve` does not clear.
3. **ARIA snapshots**: `<name>.aria.yml` baselines, text diff, approved with the screenshot.
4. Playwright Test fixture, `maxHeight`, outline/shadow-aware element crops, pseudo-class forcing.
Status: HAVE / PARTIAL / GAP / N/A (SaaS-only, out of scope for a self-hosted tool).

## Rendering determinism

| Happo | What it does | pixelgate today | Status |
| --- | --- | --- | --- |
| `data-happo-hide` | `visibility:hidden` on marked elements | `data-pixelgate-hide`, via the screenshot `style` (pierces shadow DOM and frames) | HAVE |
| `hideBehavior: 'ignore'` | render marked elements but exclude them from comparison | `hideBehavior: 'ignore'` paints them over (Playwright `mask`); plus `mask` selectors globally, per page, per Storybook source | HAVE |
| `allowedHostnames` | block every request to hosts not listed, before it leaves the browser | `allowedHostnames` globs (`context.route`), snapshot hosts always allowed, blocked hosts reported per snapshot | HAVE |
| `prefersColorScheme` per target | light/dark | target `colorScheme` | HAVE |
| `prefersReducedMotion` per target | | target `reducedMotion` | HAVE |
| `freezeAnimations` first/last frame | | CSS kills animation durations + Playwright `animations: 'disabled'` | PARTIAL |
| `outgoingRequestHeaders` | extra request headers | target `extraHTTPHeaders` | HAVE |
| `allowPointerEvents` | | not touched (pointer events allowed) | HAVE |
| dates/timestamps advice | mockdate etc. | `stabilize.fixedTime` (Playwright clock) | HAVE |
| stability | Happo waits for content | Vitest-style stable-screenshot loop | HAVE (stronger) |

## What a snapshot can show

| Happo | | pixelgate | Status |
| --- | --- | --- | --- |
| `applyPseudoClasses` | `data-happo-hover/focus/focus-visible/active` attributes force `:hover` etc. | only one element at a time via `beforeCapture` (`locator.hover()`) | GAP (CDP `CSS.forcePseudoState`, chromium only) |
| `includeOutlinesAndShadows` | grow element crops to include focus rings / box-shadows | `locator.screenshot()` crops to the border box | GAP |
| `maxHeight` / `maxWidth` | cap tall full-page shots (default 5000px) | uncapped | GAP |
| animated snapshots | capture animations as frame sequences (CSS, WAAPI, SMIL, rAF, video) | none | GAP (large) |
| browsers chrome/firefox/edge/safari/ios-safari/ipad-safari | | chromium/firefox/webkit + `deviceScaleFactor` | HAVE (target `device`: Playwright's device list) |
| `screenshotScale` | 1x/2x for iOS targets | `deviceScaleFactor` | HAVE |

## Checks beyond pixels

| Happo | | pixelgate | Status |
| --- | --- | --- | --- |
| accessibility target | axe-core per snapshot, WCAG 2.0/2.1 A/AA, `window.happoAxeOptions` | `checks.a11y` (`@axe-core/playwright`): tags, `disableRules`, `minImpact`, scoped to the snapshot's selector | HAVE |
| ARIA snapshots | text tree of what a screen reader gets, diffed | none | GAP (Playwright `locator.ariaSnapshot()` built in) |
| `detectHorizontalOverflow` | measure how far a page reaches past the viewport's right edge | `checks.overflow` (global or per target) → `overflowPx` | HAVE |
| `blockApproval.renderErrors` | page errors block approval | `failOn: ['pageErrors']` | HAVE |
| `blockApproval.accessibilityViolations` / `horizontalOverflow` | | `failOn: ['a11y', 'overflow']`; `approve` does not clear findings | HAVE |
| `failOnWaitForTimeout` | | `waitFor` timeout is an `error` | HAVE |

## Comparison

| Happo | | pixelgate | Status |
| --- | --- | --- | --- |
| color-delta threshold (`compareThreshold`) | | pixelmatch `threshold` | HAVE |
| anti-aliasing excluded | | pixelmatch AA detection | HAVE |
| pixel threshold (`ignoreThreshold`) | | `maxDiffPixelRatio` | HAVE |
| ssim | | `comparator: 'ssim'` (per window, per channel) | HAVE |
| apply blur | blur before deep compare | none | GAP (small) |
| ignore whitespace | ignore whitespace-only shifts | none | GAP (small) |

## Integrations

| Happo | | pixelgate | Status |
| --- | --- | --- | --- |
| Storybook | + per-story `beforeScreenshot`, `delay`, `waitForContent`, targets | stories from index.json, include/exclude globs | PARTIAL (no per-story params) |
| Pages (full-page URLs) | `waitForContent`, `waitForSelector` | `pages` + `waitFor` (+ `text=` selectors) | HAVE |
| Vitest browser mode | | `pixelgate/vitest` | HAVE |
| Playwright Test | `happoScreenshot(page, locator, {component, variant})` fixture, `mergeTests` | none | GAP |
| Cypress | `cy.happoScreenshot()` | none | GAP |
| Custom (register examples in a JS bundle) | | none (Storybook covers most) | GAP (low) |
| Native apps (upload images) | | none | N/A for now |

## Workflow / CI

| Happo | | pixelgate | Status |
| --- | --- | --- | --- |
| PR status + comment | | GitHub Action, sticky comment, job summary | HAVE |
| accept/reject in UI | | static report + `approve` / `approve --from` | HAVE (no web accept button) |
| partial runs `--only` / `--skip` | + borrow excluded from base report | `--only` globs, no "removed" for partial runs | PARTIAL (no `--skip`, no changed-files detection) |
| local dev job URL | | report path printed | HAVE |
| flake reporting / `happo flake` | | none | GAP (needs a store; could be a committed list) |
| multi-project / groups | | `artifact-name` per job | PARTIAL |
| MCP server | comparisons for a SHA, details, paged | `--json`, `summary` | GAP |
| baseline command | SHA to borrow from | baselines are committed, n/a | N/A |
| webhooks, SSO, roles, image API, GHE app | | | N/A (SaaS) |
