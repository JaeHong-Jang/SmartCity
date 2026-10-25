import { describe, expect, it } from 'vitest';
import { MAX_AI_IMAGE_BYTES } from '@smartcity/shared';
import { checkSource, FIRST_ATTEMPT, fitSize, imageBudget, MIN_SIDE, nextAttempt, TARGET_BYTES, type Attempt } from './aiImage';

describe('nextAttempt', () => {
  it('stops when the picture fits', () => {
    expect(nextAttempt(FIRST_ATTEMPT, 280_000, 280_000)).toEqual({ kind: 'ok' });
    expect(nextAttempt(FIRST_ATTEMPT, 10, 280_000)).toEqual({ kind: 'ok' });
  });

  it('lowers the quality first, in 0.1 steps down to 0.5', () => {
    const q: number[] = [];
    let a: Attempt = FIRST_ATTEMPT;
    for (;;) {
      const n = nextAttempt(a, 999_999, 280_000);
      if (n.kind !== 'retry' || n.attempt.maxSide !== a.maxSide) break;
      a = n.attempt;
      q.push(a.quality);
    }
    expect(q).toEqual([0.75, 0.65, 0.55]);
  });

  it('then shrinks the size by 20 % and restarts at a lower quality', () => {
    expect(nextAttempt({ maxSide: 1280, quality: 0.55 }, 999_999, 280_000)).toEqual({ kind: 'retry', attempt: { maxSide: 1024, quality: 0.75 } });
  });

  it('always terminates: gives up below the minimum side', () => {
    let a: Attempt = FIRST_ATTEMPT;
    let steps = 0;
    for (;;) {
      const n = nextAttempt(a, 999_999, 280_000);
      steps++;
      if (n.kind === 'fail') break;
      if (n.kind !== 'retry') throw new Error('unexpected');
      a = n.attempt;
      expect(steps).toBeLessThan(100);
    }
    expect(a.maxSide * 0.8).toBeLessThan(MIN_SIDE);
  });
});

describe('sizes and sources', () => {
  it('keeps the long side within the limit and never enlarges', () => {
    expect(fitSize(4000, 2000, 1280)).toEqual({ w: 1280, h: 640 });
    expect(fitSize(600, 800, 1280)).toEqual({ w: 600, h: 800 });
    expect(fitSize(1, 5000, 1280).w).toBe(1);
  });

  it('shares the message size between two pictures and stays under the server limit', () => {
    expect(imageBudget(1)).toBe(TARGET_BYTES);
    expect(imageBudget(2)).toBe(180_000);
    expect(imageBudget(1)).toBeLessThanOrEqual(MAX_AI_IMAGE_BYTES);
    // Two pictures at their budget, base64-encoded, fit the 512 KB frame with room for the rest.
    expect(Math.ceil((imageBudget(2) * 2 * 4) / 3)).toBeLessThan(512 * 1024 - 2000);
  });

  it('rejects non-images, a third picture and huge files', () => {
    const img = new Blob(['x'], { type: 'image/png' });
    expect(checkSource(img, 0)).toBeNull();
    expect(checkSource(img, 1)).toBeNull();
    expect(checkSource(img, 2)).toMatch(/최대 2장/);
    expect(checkSource(new Blob(['x'], { type: 'text/plain' }), 0)).toMatch(/이미지 파일/);
    expect(checkSource(new Blob([new Uint8Array(26 * 1024 * 1024)], { type: 'image/jpeg' }), 0)).toMatch(/너무 큽니다/);
  });
});
