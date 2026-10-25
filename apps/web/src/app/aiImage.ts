// Prepares pictures for the AI assistant: shrink to a long side <= 1280 px and re-encode as JPEG so each
// stays well under the server limit. The retry policy is a pure function (`nextAttempt`); the canvas
// work is the thin browser part around it.

import { AI_IMAGE_TYPES, MAX_AI_IMAGES, MAX_AI_IMAGE_BYTES, type AiImage } from '@smartcity/shared';

export const MAX_SIDE = 1280;
export const MIN_SIDE = 320;
const FIRST_QUALITY = 0.85;
const RETRY_QUALITY = 0.75;
const MIN_QUALITY = 0.5;
/** Decoded bytes per picture the client aims for (the server accepts up to MAX_AI_IMAGE_BYTES). */
export const TARGET_BYTES = 280_000;
/** Decoded bytes for all pictures of one message: base64 grows them by 4/3 and the frame is 512 KB. */
export const TOTAL_BYTES = 360_000;
/** Longest accepted source file (before shrinking). */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_IMAGE_TEXT = '이 이미지와 비슷한 건물을 설계해줘';

export interface Attempt {
  /** Longest side in pixels. */
  maxSide: number;
  /** JPEG quality 0..1. */
  quality: number;
}

export const FIRST_ATTEMPT: Attempt = { maxSide: MAX_SIDE, quality: FIRST_QUALITY };

export type Next = { kind: 'ok' } | { kind: 'retry'; attempt: Attempt } | { kind: 'fail' };

/** Decoded size one picture may use when `count` pictures are sent together. */
export const imageBudget = (count: number): number => Math.min(TARGET_BYTES, MAX_AI_IMAGE_BYTES, Math.floor(TOTAL_BYTES / Math.max(1, count)));

/** After encoding with `prev` into `bytes`: done, try lower quality (down to 0.5), then a 20 % smaller picture. */
export function nextAttempt(prev: Attempt, bytes: number, budget: number): Next {
  if (bytes <= budget) return { kind: 'ok' };
  const q = Math.round((prev.quality - 0.1) * 100) / 100;
  if (q >= MIN_QUALITY) return { kind: 'retry', attempt: { maxSide: prev.maxSide, quality: q } };
  const side = Math.floor(prev.maxSide * 0.8);
  if (side < MIN_SIDE) return { kind: 'fail' };
  return { kind: 'retry', attempt: { maxSide: side, quality: RETRY_QUALITY } };
}

/** Pixel size that fits `maxSide` without enlarging. */
export function fitSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export class ImageError extends Error {}

/** Whether a picked/dropped/pasted file can be attached at all. */
export function checkSource(file: Blob, attached: number): string | null {
  if (attached >= MAX_AI_IMAGES) return `이미지는 최대 ${MAX_AI_IMAGES}장까지 첨부할 수 있습니다`;
  if (!file.type.startsWith('image/')) return '이미지 파일만 첨부할 수 있습니다';
  if (file.size > MAX_SOURCE_BYTES) return '이미지가 너무 큽니다 (25 MB 이하)';
  return null;
}

const toBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError('encode failed'))), 'image/jpeg', quality));

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new ImageError('read failed'));
    r.readAsDataURL(blob);
  });

/** Shrink and encode one picture so it fits `budget` decoded bytes. Throws ImageError on failure. */
export async function compressImage(file: Blob, budget: number): Promise<AiImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('decode failed');
  }
  try {
    let attempt = FIRST_ATTEMPT;
    for (;;) {
      const { w, h } = fitSize(bitmap.width, bitmap.height, attempt.maxSide);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new ImageError('no canvas');
      // JPEG has no transparency: paint white under PNG/WebP cut-outs.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await toBlob(canvas, attempt.quality);
      const next = nextAttempt(attempt, blob.size, budget);
      if (next.kind === 'ok') {
        const mediaType = AI_IMAGE_TYPES[0];
        return { mediaType, data: await toBase64(blob) };
      }
      if (next.kind === 'fail') throw new ImageError('too large');
      attempt = next.attempt;
    }
  } finally {
    bitmap.close();
  }
}
