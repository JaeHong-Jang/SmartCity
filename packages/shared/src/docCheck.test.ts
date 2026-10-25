import { describe, expect, it } from 'vitest';
import { createEmptyDoc, docProblem } from './index.js';

describe('docProblem', () => {
  const doc = () => {
    const d = createEmptyDoc() as unknown as Record<string, Record<string, unknown>>;
    d.nodes!.a = { id: 'a', pos: { x: 0, z: 0 } };
    d.nodes!.b = { id: 'b', pos: { x: 40, z: 0 } };
    d.segments!.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'road-2' };
    return d;
  };

  it('accepts a fresh and a small valid city', () => {
    expect(docProblem(createEmptyDoc())).toBeNull();
    expect(docProblem(doc())).toBeNull();
  });

  it('names the first broken collection or entity', () => {
    const cases: [string, (d: Record<string, Record<string, unknown>>) => void, RegExp][] = [
      ['array collection', (d) => ((d as Record<string, unknown>).nodes = []), /doc\.nodes is not a keyed/],
      ['missing collection', (d) => delete (d as Record<string, unknown>).features, /doc\.features/],
      ['intersection under another key', (d) => (d.intersections!.a = { nodeId: 'b', kind: 'signal' }), /intersections\["a"\]/],
      ['intersection of a missing node', (d) => (d.intersections!.z = { nodeId: 'z', kind: 'signal' }), /intersections\["z"\]/],
      ['feature on a missing segment', (d) => (d.features!.f = { id: 'f', segmentId: 'gone', t: 0.5 }), /features\["f"\]/],
      ['closure on a missing segment', (d) => (d.closures!.gone = { segmentId: 'gone', reason: '' }), /closures\["gone"\]/],
      ['segment with a missing road type', (d) => (d.segments!.s = { id: 's', a: 'a', b: 'b', roadTypeId: 'nope' }), /segments\["s"\]/],
      ['non-numeric position', (d) => (d.nodes!.a = { id: 'a', pos: { x: '0', z: 0 } }), /nodes\["a"\]/],
      ['meta without a name', (d) => (d.meta = { seed: 1 }), /meta/],
    ];
    for (const [what, mutate, re] of cases) {
      const d = doc();
      mutate(d);
      expect(docProblem(d), what).toMatch(re);
    }
  });
});
