export * from './config.js';
export {
  compareImages,
  createMatcher,
  pixelmatchComparator,
  ssimComparator,
  pngCodec,
  jpegCodec,
  COMPARATORS,
  CODECS,
  type Codec,
  type Comparator,
  type ComparatorResult,
  type CompareResult,
  type DecodedImage,
  type Matcher,
  type PixelmatchOptions,
  type SsimOptions,
} from './compare.js';
export {
  captureAll,
  captureAria,
  stableShot,
  capBox,
  elementBox,
  forcePseudoClasses,
  PSEUDO_CLASSES,
  STABILIZE_CSS,
  watchPage,
  type Box,
  type CaptureResult,
  type PageLog,
  type Shooter,
  type StableShot,
} from './capture.js';
export { determineOutcome, applyOutcome, toResult, type Outcome } from './outcome.js';
export {
  normalizeAria,
  determineAriaOutcome,
  applyAriaOutcome,
  ariaResult,
  withAria,
  ARIA_EXT,
  type AriaOutcome,
} from './aria.js';
export { safeName, resolveUrl } from './names.js';
export { storiesFromIndex, fetchStorybookPages } from './storybook.js';
export { startVite, type RunningServer } from './vite.js';
export { renderMarkdown, commentMarker, type MarkdownOptions } from './markdown.js';
export { run, collectSnaps, matcherFor, type RunOptions } from './run.js';
export {
  approve,
  readReport,
  writeReport,
  buildReport,
  summarize,
  checkFindings,
  type Report,
  type SnapshotResult,
  type A11yViolation,
  type HttpError,
  MAX_LOGGED,
  type AriaResult,
  type ApproveOptions,
  type OutDir,
} from './report.js';
