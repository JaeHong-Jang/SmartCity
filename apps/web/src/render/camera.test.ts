import { describe, expect, it } from 'vitest';
import CameraControls from 'camera-controls';
import { mouseButtonsFor } from './camera';

const A = CameraControls.ACTION;

describe('city camera mouse mapping (P6a)', () => {
  it('right drag rotates, middle drag pans, left stays with the tools, wheel zooms', () => {
    expect(mouseButtonsFor(false)).toEqual({ left: A.NONE, middle: A.SCREEN_PAN, right: A.ROTATE, wheel: A.DOLLY });
  });

  it('Shift+right drag pans (mice without a middle button, trackpads)', () => {
    expect(mouseButtonsFor(true).right).toBe(A.SCREEN_PAN);
    expect(mouseButtonsFor(true).middle).toBe(A.SCREEN_PAN);
    expect(mouseButtonsFor(true).left).toBe(A.NONE);
  });
});
