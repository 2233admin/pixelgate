/**
 * Image comparison, pluggable the way Vitest's `toMatchScreenshot` is:
 * a comparator works on decoded RGBA images and returns `{ pass, diff, message }`;
 * a codec turns files into RGBA and back. Both are looked up by name, built-ins
 * first, then whatever the config registers.
 */
import jpeg from 'jpeg-js';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ssim } from 'ssim.js';

/** Decoded image, RGBA, 4 bytes per pixel. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ComparatorResult {
  pass: boolean;
  /** Pixels counted as different (comparator-defined). */
  diffPixels: number;
  diffRatio: number;
  sizeChanged: boolean;
  /** Visualisation of the difference, when `createDiff` was requested. */
  diff: DecodedImage | null;
  /** Human-readable reason when `pass` is false. */
  message: string | null;
}

export type Comparator<O extends object = Record<string, unknown>> = (
  reference: DecodedImage,
  actual: DecodedImage,
  options: Partial<O> & { createDiff: boolean },
) => ComparatorResult | Promise<ComparatorResult>;

export interface Codec {
  /** File extension without the dot. */
  extension: string;
  decode(file: Buffer): DecodedImage;
  encode(image: DecodedImage): Buffer;
  /** Let Playwright produce this format directly. Otherwise PNG is captured and re-encoded. */
  screenshot?: { type: 'png' | 'jpeg'; quality?: number };
}

// ---------------------------------------------------------------- codecs

export const pngCodec: Codec = {
  extension: 'png',
  decode(file) {
    const img = PNG.sync.read(file);
    return { width: img.width, height: img.height, data: img.data };
  },
  encode({ width, height, data }) {
    const img = new PNG({ width, height });
    img.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return PNG.sync.write(img);
  },
  screenshot: { type: 'png' },
};

const JPEG_QUALITY = 90;
export const jpegCodec: Codec = {
  extension: 'jpg',
  decode(file) {
    const img = jpeg.decode(file, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  },
  encode(image) {
    return jpeg.encode(image, JPEG_QUALITY).data;
  },
  screenshot: { type: 'jpeg', quality: JPEG_QUALITY },
};

export const CODECS: Record<string, Codec> = { png: pngCodec, jpeg: jpegCodec };

// ----------------------------------------------------------- comparators

/** Copy `img` onto a transparent canvas of `width`x`height` (top-left aligned). */
function pad(img: DecodedImage, width: number, height: number): DecodedImage {
  if (img.width === width && img.height === height) return img;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * width * 4);
  }
  return { width, height, data };
}

function sameCanvas(a: DecodedImage, b: DecodedImage) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  return { width, height, a: pad(a, width, height), b: pad(b, width, height), sizeChanged: a.width !== b.width || a.height !== b.height };
}

export interface PixelmatchOptions {
  /** Per-pixel colour tolerance, 0..1. Default 0.1. */
  threshold: number;
  /** Count anti-aliased pixels as different. Default false. */
  includeAA: boolean;
  /** Changed pixels allowed (absolute). */
  maxDiffPixels: number;
  /** Changed pixels allowed (share of the image). Default 0. */
  maxDiffPixelRatio: number;
}

/** Exact per-pixel comparison (mapbox/pixelmatch). A size change never passes. */
export const pixelmatchComparator: Comparator<PixelmatchOptions> = (reference, actual, options) => {
  const { width, height, a, b, sizeChanged } = sameCanvas(reference, actual);
  const diff = options.createDiff ? new Uint8Array(width * height * 4) : undefined;
  const count = pixelmatch(a.data, b.data, diff, width, height, {
    threshold: options.threshold ?? 0.1,
    includeAA: options.includeAA ?? false,
    alpha: 0.2,
  });
  const area = width * height;
  // A size change is a visual change even if the padded area happens to match.
  const diffPixels = sizeChanged && count === 0 ? 1 : count;
  const allowed = Math.min(options.maxDiffPixels ?? Infinity, (options.maxDiffPixelRatio ?? 0) * area);
  const pass = !sizeChanged && diffPixels <= allowed;
  const diffRatio = area === 0 ? 0 : diffPixels / area;
  return {
    pass,
    diffPixels,
    diffRatio,
    sizeChanged,
    diff: diff ? { width, height, data: diff } : null,
    message: pass
      ? null
      : sizeChanged
        ? `Size changed: ${reference.width}x${reference.height} -> ${actual.width}x${actual.height}`
        : `${diffPixels} pixels (ratio ${diffRatio.toFixed(4)}) differ`,
  };
};

export interface SsimOptions {
  /** A window (local neighbourhood) counts as changed below this similarity, -1..1. Default 0.8. */
  minSimilarity: number;
  /** Share of the image allowed in changed windows. Default 0. */
  maxDiffPixelRatio: number;
  /** ssim.js algorithm. Default `weber` (fastest). */
  variant: 'fast' | 'original' | 'bezkrovny' | 'weber';
  /** ssim.js window size. Default 11. */
  windowSize: number;
}

/** One colour channel as a grey RGBA image, so ssim.js's grey conversion keeps it as-is. */
function channel(img: DecodedImage, c: 0 | 1 | 2) {
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = img.data[i + c]!;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/**
 * Structural similarity (ssim.js) per local window: each neighbourhood is
 * judged on luminance, contrast and structure instead of a per-pixel colour
 * threshold. `minSimilarity` is the tolerance knob. With the default 0.8, on
 * the calibration scenes in test/unit.test.ts, scattered ±20 pixel noise
 * (worst window 0.82) and a +16 global brightness shift (0.85) pass, while a
 * 1px element shift (-0.02), a hue change (-0.91) or a moved box (-0.98) fail.
 *
 * Two deliberate departures from textbook SSIM:
 * - pass/fail is decided per window, not by the mean score, so a small
 *   change in a large page can't average away;
 * - it runs per R/G/B channel and keeps the worst, because luma-only SSIM
 *   scores a blue -> green button of similar brightness as identical.
 */
export const ssimComparator: Comparator<SsimOptions> = (reference, actual, options) => {
  const { width, height, a, b, sizeChanged } = sameCanvas(reference, actual);
  const minSimilarity = options.minSimilarity ?? 0.8;
  const ssimOptions = { ssim: options.variant ?? 'weber', windowSize: options.windowSize ?? 11, downsample: false } as const;
  let mssim = Infinity;
  let map: { width: number; height: number; data: number[] } | undefined;
  for (const c of [0, 1, 2] as const) {
    const r = ssim(channel(a, c), channel(b, c), ssimOptions);
    mssim = Math.min(mssim, r.mssim);
    if (!map) map = { ...r.ssim_map, data: [...r.ssim_map.data] };
    else for (let i = 0; i < map.data.length; i++) map.data[i] = Math.min(map.data[i]!, r.ssim_map.data[i]!);
  }
  map = map!;

  // Project the (smaller) SSIM map back onto the image.
  const diff = options.createDiff ? new Uint8Array(width * height * 4) : undefined;
  let diffPixels = 0;
  for (let y = 0; y < height; y++) {
    const my = Math.min(map.height - 1, Math.floor((y * map.height) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(map.width - 1, Math.floor((x * map.width) / width));
      const bad = map.data[my * map.width + mx]! < minSimilarity;
      if (bad) diffPixels++;
      if (diff) {
        const i = (y * width + x) * 4;
        if (bad) diff.set([255, 0, 0, 255], i);
        else {
          // Faded greyscale of the reference, like pixelmatch's output.
          const g = 255 - (255 - (0.299 * a.data[i]! + 0.587 * a.data[i + 1]! + 0.114 * a.data[i + 2]!)) * 0.2;
          diff.set([g, g, g, 255], i);
        }
      }
    }
  }
  if (sizeChanged && diffPixels === 0) diffPixels = 1;
  const diffRatio = width * height === 0 ? 0 : diffPixels / (width * height);
  const pass = !sizeChanged && diffRatio <= (options.maxDiffPixelRatio ?? 0);
  let worst = Infinity;
  for (const v of map.data) worst = Math.min(worst, v);
  return {
    pass,
    diffPixels,
    diffRatio,
    sizeChanged,
    diff: diff ? { width, height, data: diff } : null,
    message: pass
      ? null
      : `SSIM below ${minSimilarity} in ${(diffRatio * 100).toFixed(2)}% of the image (worst window ${worst.toFixed(4)}, mean ${mssim.toFixed(4)})` +
        (sizeChanged ? ', size changed' : ''),
  };
};

export const COMPARATORS: Record<string, Comparator<any>> = { pixelmatch: pixelmatchComparator, ssim: ssimComparator };

// ---------------------------------------------------------------- matcher

export interface CompareResult extends Omit<ComparatorResult, 'diff'> {
  width: number;
  height: number;
  /** PNG of the diff (diffs are always PNG), or null if the comparator made none. */
  diffPng: Buffer | null;
}

/** Comparator + codec + options bound together; what a run actually uses. */
export interface Matcher {
  codec: Codec;
  /** Equal enough to count as the same frame. Byte-identical files skip decoding. */
  same(a: Buffer, b: Buffer): Promise<boolean>;
  compare(reference: Buffer, actual: Buffer): Promise<CompareResult>;
}

export function createMatcher(opts: { codec?: Codec; comparator?: Comparator<any>; options?: Record<string, unknown> }): Matcher {
  const codec = opts.codec ?? pngCodec;
  const comparator = opts.comparator ?? pixelmatchComparator;
  const options = opts.options ?? {};
  return {
    codec,
    async same(a, b) {
      if (a.equals(b)) return true;
      return (await comparator(codec.decode(a), codec.decode(b), { ...options, createDiff: false })).pass;
    },
    async compare(reference, actual) {
      const r = await comparator(codec.decode(reference), codec.decode(actual), { ...options, createDiff: true });
      const { diff, ...rest } = r;
      return {
        ...rest,
        width: diff?.width ?? 0,
        height: diff?.height ?? 0,
        diffPng: diff ? pngCodec.encode(diff) : null,
      };
    },
  };
}

/** Synchronous PNG + pixelmatch shortcut (kept for scripts and tests). */
export function compareImages(baseline: Buffer, current: Buffer, opts: { threshold: number }): CompareResult {
  const r = pixelmatchComparator(pngCodec.decode(baseline), pngCodec.decode(current), {
    threshold: opts.threshold,
    createDiff: true,
  }) as ComparatorResult;
  const { diff, ...rest } = r;
  return { ...rest, width: diff!.width, height: diff!.height, diffPng: pngCodec.encode(diff!) };
}
