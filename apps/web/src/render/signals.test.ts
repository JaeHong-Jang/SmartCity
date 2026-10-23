import { describe, expect, it } from 'vitest';
import { CROSSING_STRIDE, crossingSignature, PedSignal, type Crossing, type SimSnapshot } from '@smartcity/sim';
import type { SimulationStream } from '../sim/simStream';
import { pedLampState, PedSignalLayer, pedSignalHeads } from './signals';

function crossing(index: number, signal: boolean): Crossing {
  return {
    index,
    id: `c${index}`,
    kind: 'midblock',
    segmentId: 's',
    s: 30,
    a: { x: 30, z: -5 },
    b: { x: 30, z: 5 },
    width: 4,
    polygon: [],
    signal,
    schoolZone: false,
  };
}

describe('pedestrian signal heads', () => {
  it('puts two heads on each signalized crossing, facing across the road, and skips unsignalized ones', () => {
    const heads = pedSignalHeads([crossing(0, false), crossing(1, true)]);
    expect(heads).toHaveLength(2);
    expect(heads.every((h) => h.crossing === 1)).toBe(true);
    const [h0, h1] = heads;
    // Opposite curbs, facing each other, outside the zebra's 4 m width.
    expect(h0!.dz).toBeCloseTo(1, 6);
    expect(h1!.dz).toBeCloseTo(-1, 6);
    expect(h0!.z).toBeLessThan(-5);
    expect(h1!.z).toBeGreaterThan(5);
    expect(Math.abs(h0!.x - 30)).toBeGreaterThan(2);
    expect(h0!.x).toBeCloseTo(h1!.x, 6);
  });

  it('shows red / walk / blinking green, and hides unsignalized crossings', () => {
    expect(pedLampState(PedSignal.red, 0)).toEqual({ red: true, green: false });
    expect(pedLampState(PedSignal.walk, 0)).toEqual({ red: false, green: true });
    const a = pedLampState(PedSignal.clearance, 0)!;
    const b = pedLampState(PedSignal.clearance, 300)!;
    expect(a.red).toBe(false);
    expect(a.green).not.toBe(b.green);
    expect(pedLampState(PedSignal.none, 0)).toBeNull();
  });
});

describe('pedestrian signal layer', () => {
  it('ignores crossing states from a snapshot of a different crossing list (Sol 2b-sim #4)', () => {
    const old = [crossing(0, true), crossing(1, true)];
    const states = new Float32Array(2 * CROSSING_STRIDE);
    states[0] = PedSignal.walk;
    states[CROSSING_STRIDE] = PedSignal.red;
    const snap = { crossings: states, crossingCount: 2, crossingSig: crossingSignature(old.map((c) => c.id)) } as unknown as SimSnapshot;
    const stream = { latest: () => snap } as unknown as SimulationStream;
    const layer = new PedSignalLayer(stream);
    const greens = (): number => {
      const g = (layer as unknown as { green: { count: number; instanceColor: { getX(i: number): number; getY(i: number): number } } }).green;
      let n = 0;
      for (let i = 0; i < g.count; i++) if (g.instanceColor.getY(i) > 0.5 && g.instanceColor.getX(i) < 0.5) n++;
      return n;
    };
    layer.setCrossings(old);
    layer.update(0, 0.2);
    expect(greens()).toBe(2);
    // The first crossing was removed: the remaining one must not inherit its WALK.
    layer.setCrossings([{ ...old[1]!, index: 0 }]);
    layer.update(0, 0.2);
    expect(greens()).toBe(0);
  });
});
