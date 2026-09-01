/**
 * Cover art normalisation.
 *
 * Art is the single easiest way to bloat an export. A 5 MB photograph embedded
 * in twenty tracks adds 100 MB to the archive and makes some players slow to
 * browse the library, all to display an image no larger than a few hundred
 * pixels on screen. Everything here exists to prevent that quietly happening.
 */

import type { CoverImage } from '../../types.ts';

/** A good default: sharp on a retina display, small enough to embed everywhere. */
export const DEFAULT_MAX_EDGE = 1000;
export const DEFAULT_QUALITY = 0.88;

export interface CoverProcessOptions {
  maxEdge?: number;
  quality?: number;
  /** Pad a non-square image to a square canvas instead of leaving it as is. */
  squarePad?: boolean;
}

export interface CoverAnalysis {
  width: number;
  height: number;
  isSquare: boolean;
  /** Aspect ratio distance from square, as a fraction. */
  aspectSkew: number;
  originalBytes: number;
}

async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * Resize, flatten and re-encode an image to JPEG.
 *
 * Canvas output is always sRGB, which incidentally solves the other common
 * problem: art tagged with an exotic colour profile that renders differently in
 * every player.
 */
export async function processCover(
  source: Blob | Uint8Array,
  options: CoverProcessOptions = {},
): Promise<{ cover: CoverImage; analysis: CoverAnalysis }> {
  const {
    maxEdge = DEFAULT_MAX_EDGE,
    quality = DEFAULT_QUALITY,
    squarePad = false,
  } = options;

  const blob =
    source instanceof Blob
      ? source
      : new Blob([source as BlobPart], { type: 'image/jpeg' });

  const bitmap = await loadBitmap(blob);

  const analysis: CoverAnalysis = {
    width: bitmap.width,
    height: bitmap.height,
    isSquare: bitmap.width === bitmap.height,
    aspectSkew:
      Math.abs(bitmap.width - bitmap.height) / Math.max(bitmap.width, bitmap.height),
    originalBytes: blob.size,
  };

  const longestEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;

  const scaledWidth = Math.max(1, Math.round(bitmap.width * scale));
  const scaledHeight = Math.max(1, Math.round(bitmap.height * scale));

  const canvasWidth = squarePad ? Math.max(scaledWidth, scaledHeight) : scaledWidth;
  const canvasHeight = squarePad ? Math.max(scaledWidth, scaledHeight) : scaledHeight;

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Could not create a drawing context for the cover image.');
  }

  // JPEG has no alpha, so a transparent PNG would otherwise flatten to black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap,
    Math.round((canvasWidth - scaledWidth) / 2),
    Math.round((canvasHeight - scaledHeight) / 2),
    scaledWidth,
    scaledHeight,
  );
  bitmap.close();

  const encoded = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await encoded.arrayBuffer());

  return {
    cover: {
      bytes,
      mimeType: 'image/jpeg',
      width: canvasWidth,
      height: canvasHeight,
      objectUrl: URL.createObjectURL(encoded),
    },
    analysis,
  };
}

/** Build a CoverImage from bytes already known to be correctly sized. */
export async function coverFromBytes(
  bytes: Uint8Array,
  mimeType: string,
): Promise<CoverImage | null> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    const bitmap = await loadBitmap(blob);
    const cover: CoverImage = {
      bytes,
      mimeType,
      width: bitmap.width,
      height: bitmap.height,
      objectUrl: URL.createObjectURL(blob),
    };
    bitmap.close();
    return cover;
  } catch {
    // An image the browser cannot decode is not usable as cover art anyway.
    return null;
  }
}

/** Release the object URL backing a cover, so the blob can be collected. */
export function releaseCover(cover: CoverImage | undefined): void {
  if (cover?.objectUrl) URL.revokeObjectURL(cover.objectUrl);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
