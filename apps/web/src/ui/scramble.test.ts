import { describe, expect, it } from 'vitest';
import { applyCommand, segmentsAtNode, tryApplyCommand, type IntersectionControl } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import { controlSig, fallbackNetwork } from '../render/roadNetwork';
import { RoadLayer } from '../render/roads';
import { cycleSeconds, scrambleBlockReason, scramblePhaseSeconds } from './scramble';

function center(doc: ReturnType<typeof crossDoc>['doc']): string {
  return Object.values(doc.nodes).find((n) => segmentsAtNode(doc, n.id).length === 4)!.id;
}
const control = (nodeId: string, extra: Partial<IntersectionControl> = {}): IntersectionControl => ({ nodeId, kind: 'signal', yellow: 3, allRed: 2, offset: 0, ...extra });

describe('scrambleBlockReason mirrors shared validation', () => {
  it('allows signalized 4-leg junctions with crosswalks', () => {
    const { doc } = crossDoc();
    const c = control(center(doc));
    expect(scrambleBlockReason(doc, c)).toBeNull();
    expect(tryApplyCommand(doc, { type: 'intersection.set', control: { ...c, scramble: true } }).ok).toBe(true);
  });

  it('explains each refusal, and the shared validator refuses the same cases', () => {
    const { doc } = crossDoc();
    const id = center(doc);
    const cases: [Partial<IntersectionControl>, RegExp][] = [
      [{ kind: 'uncontrolled' }, /신호/],
      [{ crosswalkLegs: [] }, /2개 이상/],
      [{ crosswalkLegs: [segmentsAtNode(doc, id)[0]!.id] }, /2개 이상/],
    ];
    for (const [extra, why] of cases) {
      const c = control(id, extra);
      expect(scrambleBlockReason(doc, c)).toMatch(why);
      expect(tryApplyCommand(doc, { type: 'intersection.set', control: { ...c, scramble: true } }).ok).toBe(false);
    }
  });

  it('refuses a road end (1 leg)', () => {
    const { doc } = crossDoc();
    const id = Object.values(doc.nodes).find((n) => segmentsAtNode(doc, n.id).length === 1)!.id;
    expect(scrambleBlockReason(doc, control(id))).toMatch(/3~4/);
  });
});

describe('cycleSeconds', () => {
  it('adds the pedestrian phase (7 s + longest crossing) to the vehicle phases', () => {
    const { doc } = crossDoc();
    const c = control(center(doc), { scramble: true });
    const phases = [{ approaches: [], green: 20 }, { approaches: [], green: 20 }];
    const ped = scramblePhaseSeconds(doc, c);
    expect(ped).toBeGreaterThan(7);
    expect(cycleSeconds(doc, c, phases)).toBe(2 * (20 + 3 + 2) + ped);
    expect(cycleSeconds(doc, { ...c, scramble: false }, phases)).toBe(2 * (20 + 3 + 2));
  });
});

describe('road render signature', () => {
  it('controlSig changes with scramble and the junction chunk is rebuilt', () => {
    const { doc } = crossDoc();
    const id = center(doc);
    applyCommand(doc, { type: 'intersection.set', control: control(id) });
    const before = controlSig(doc, id);
    const layer = new RoadLayer();
    layer.update(fallbackNetwork(doc));
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBe(0);
    applyCommand(doc, { type: 'intersection.set', control: control(id, { scramble: true }) });
    expect(controlSig(doc, id)).not.toBe(before);
    layer.update(fallbackNetwork(doc));
    expect(layer.lastRebuilt).toBeGreaterThan(0);
  });
});
