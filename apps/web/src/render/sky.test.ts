import { describe, expect, it } from 'vitest';
import { fogRange } from './sky';

describe('haze follows the camera', () => {
  it('never fogs the area the camera looks at', () => {
    for (const d of [20, 80, 300, 1100, 2500]) expect(fogRange(d).near).toBeGreaterThan(d * 1.05);
  });

  it('hides the ground plane edge before the far plane at every zoom', () => {
    // Camera far plane is max(6000, 6 × distance); the ground reaches 12 km past the buildable edge.
    for (const d of [20, 300, 1100, 2500]) expect(fogRange(d).far).toBeLessThan(Math.max(6000, d * 6) * 0.9);
  });

  it('pulls the haze in when the camera comes close', () => {
    expect(fogRange(80).far).toBeLessThan(fogRange(400).far);
    expect(fogRange(400).far).toBeLessThan(5200);
  });
});
