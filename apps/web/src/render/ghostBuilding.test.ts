import { describe, expect, it } from 'vitest';
import type { BuildingType } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { GhostBuilding } from './ghostBuilding';

const pb = { typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0, color: '#4ade80' };

describe('GhostBuilding', () => {
  it('rebuilds when the design changes even if id, rev and serialized length are unchanged', () => {
    const house = crossDoc().doc.buildingTypes['house']!;
    const a: BuildingType = { ...house, rev: 1 };
    const part = a.parts[0]!;
    // Same JSON length, different geometry: floors 2 -> 3.
    const b: BuildingType = { ...a, parts: [{ ...part, floors: part.floors === 3 ? 2 : 3 }, ...a.parts.slice(1)] };
    expect(JSON.stringify(b.parts).length).toBe(JSON.stringify(a.parts).length);
    const ghost = new GhostBuilding();
    ghost.set(a, pb);
    const first = ghost.group.children[0] as import('three').Mesh;
    ghost.set(b, pb);
    expect(ghost.group.children[0]).not.toBe(first);
  });

  it('keeps the geometry while the same design is only repositioned', () => {
    const type = crossDoc().doc.buildingTypes['house']!;
    const ghost = new GhostBuilding();
    ghost.set(type, pb);
    const first = ghost.group.children[0];
    ghost.set(type, { ...pb, pos: { x: 5, z: 7 }, rotation: 1, settle: 1 });
    expect(ghost.group.children[0]).toBe(first);
    expect(ghost.group.position.x).toBe(5);
    ghost.set(undefined, undefined);
    expect(ghost.group.visible).toBe(false);
  });

  it('eases toward the target, jumps on settle, and restarts after being hidden', () => {
    const type = crossDoc().doc.buildingTypes['house']!;
    const ghost = new GhostBuilding();
    ghost.set(type, pb);
    ghost.set(type, { ...pb, pos: { x: 10, z: 0 } });
    expect(ghost.group.position.x).toBe(0); // target moved, shown pose has not yet
    expect(ghost.advance(1000)).toBe(true);
    expect(ghost.group.position.x).toBeGreaterThan(0);
    expect(ghost.group.position.x).toBeLessThan(10);
    for (let t = 1016; t < 3000; t += 16) ghost.advance(t);
    expect(ghost.group.position.x).toBe(10);
    expect(ghost.advance(4000)).toBe(false);
    ghost.set(type, { ...pb, pos: { x: 30, z: 0 } });
    ghost.set(type, { ...pb, pos: { x: 30, z: 0 }, settle: 1 });
    expect(ghost.group.position.x).toBe(30);
    ghost.set(undefined, undefined);
    ghost.set(type, { ...pb, pos: { x: 50, z: 0 } });
    expect(ghost.group.position.x).toBe(50);
  });

  it('a pending frame callback cannot revive the spring after hide', () => {
    const type = crossDoc().doc.buildingTypes['house']!;
    const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    const saved = [g.requestAnimationFrame, g.cancelAnimationFrame];
    const pending = new Map<number, (t: number) => void>();
    let n = 0;
    g.requestAnimationFrame = (f: (t: number) => void) => (pending.set(++n, f), n);
    g.cancelAnimationFrame = (id: number) => void pending.delete(id);
    try {
      const ghost = new GhostBuilding();
      ghost.set(type, pb);
      ghost.set(type, { ...pb, pos: { x: 5, z: 0 } }); // moving: a frame is pending
      const leftover = [...pending.values()];
      ghost.set(undefined, undefined);
      expect(pending.size).toBe(0);
      for (const f of leftover) f(1000); // even a callback that already fired must do nothing
      ghost.set(type, { ...pb, pos: { x: 90, z: 0 } });
      expect(ghost.group.position.x).toBe(90);
    } finally {
      [g.requestAnimationFrame, g.cancelAnimationFrame] = saved;
    }
  });
});
