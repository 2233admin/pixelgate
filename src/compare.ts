import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface CompareOptions {
  /** Per-pixel tolerance 0..1. */
  threshold: number;
}

export interface CompareResult {
  width: number;
  height: number;
  diffPixels: number;
  diffRatio: number;
  sizeChanged: boolean;
  /** PNG highlighting changed pixels in red. */
  diffPng: Buffer;
}

/** Copy `img` onto a transparent canvas of `width`x`height` (top-left aligned). */
function pad(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

export function compareImages(baseline: Buffer, current: Buffer, opts: CompareOptions): CompareResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = pad(a, width, height);
  const pb = pad(b, width, height);
  const diff = new PNG({ width, height });
  let diffPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, {
    threshold: opts.threshold,
    alpha: 0.2,
  });
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  // A size change is always a visual change, even if the padded area happens to match.
  if (sizeChanged && diffPixels === 0) diffPixels = 1;
  return {
    width,
    height,
    diffPixels,
    diffRatio: width * height === 0 ? 0 : diffPixels / (width * height),
    sizeChanged,
    diffPng: PNG.sync.write(diff),
  };
}
