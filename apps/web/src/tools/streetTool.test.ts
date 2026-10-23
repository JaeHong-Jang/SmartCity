import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc, IdGen, type Command, type RoadFeature } from '@smartcity/shared';
import { ClientStore } from '../app/store';
import { crossDoc, road } from '../test/fixtures';
import { PickIndex } from './picking';
import { crossingGhost, featureError, featureNear, featureOf, featureReason, FEATURE_SNAP, projectOnSegment, segmentFeatures, StreetTool } from './streetTool';
import type { ToolContext, ToolPointer } from './types';

// crossDoc: x axis -96..96 and z axis -96..96 crossing at the origin; each arm is a 96 m segment.
const ptr = (x: number, z: number): ToolPointer => ({ pos: { x, z }, client: { x, y: z }, button: 0, shift: false, ctrl: false, alt: false });

describe('projection onto a segment', () => {
  it('snaps the arc length to 0.5 m and reports the ratio and frame', () => {
    const { doc } = crossDoc();
    const idx = new PickIndex(doc);
    const p = projectOnSegment(doc, idx, { x: 50.3, z: 2 })!;
    expect(p).not.toBeNull();
    expect(p.s % FEATURE_SNAP).toBeCloseTo(0, 9);
    expect(p.t).toBeCloseTo(p.s / p.length, 9);
    expect(p.length).toBeCloseTo(96, 6);
    expect(Math.abs(p.point.z)).toBeLessThan(1e-6);
    expect(Math.abs(p.tangent.x)).toBeCloseTo(1, 6);
    expect(Math.abs(p.normal.z)).toBeCloseTo(1, 6);
    expect(p.halfWidth).toBeGreaterThan(0);
    const ghost = crossingGhost(p);
    expect(Math.abs(ghost[1]!.z - ghost[0]!.z)).toBeCloseTo(2 * p.halfWidth, 6);
  });

  it('finds nothing away from roads', () => {
    const { doc } = crossDoc();
    expect(projectOnSegment(doc, new PickIndex(doc), { x: 60, z: 60 })).toBeNull();
  });
});

describe('facility validity (same preflight as the server)', () => {
  const { doc } = crossDoc();
  const seg = Object.keys(doc.segments).sort()[0]!;
  const feature = (t: number, kind: 'crosswalk' | 'speedBump' = 'crosswalk'): RoadFeature => ({ id: 'g', segmentId: seg, kind, t });

  it('accepts the middle of a segment and rejects ends and neighbours with Korean reasons', () => {
    expect(featureError(doc, feature(0.5))).toBeNull();
    const nearEnd = featureError(doc, feature(6 / 96))!;
    expect(nearEnd).toMatch(/at least 12m/);
    expect(featureReason(nearEnd)).toBe('구간 끝에서 12m 이상 떨어져야 합니다');
    expect(featureError(doc, feature(1 - 11 / 96))).toMatch(/at least 12m/);

    const d = crossDoc().doc;
    expect(applyCommand(d, { type: 'feature.upsert', feature: { ...feature(0.5), id: 'f1' } }).ok).toBe(true);
    const close = featureError(d, feature(0.5 + 4 / 96))!;
    expect(featureReason(close)).toBe('다른 시설과 6m 이상 떨어져야 합니다');
    expect(featureError(d, feature(0.5 + 7 / 96))).toBeNull();
  });

  it('rejects crosswalks on roads without sidewalks but allows speed bumps', () => {
    const d = createEmptyDoc();
    const ids = new IdGen('n');
    expect(applyCommand(d, { type: 'roadType.upsert', roadType: { ...d.roadTypes['road-2']!, id: 'nowalk', name: '보도 없음', sidewalk: false } }).ok).toBe(true);
    road(d, { x: 0, z: 0 }, { x: 100, z: 0 }, ids, 'nowalk');
    const s = Object.keys(d.segments)[0]!;
    expect(featureReason(featureError(d, { id: 'g', segmentId: s, kind: 'crosswalk', t: 0.5 })!)).toBe('횡단보도는 보도가 있는 도로에만 놓을 수 있습니다');
    expect(featureError(d, { id: 'g', segmentId: s, kind: 'speedBump', t: 0.5 })).toBeNull();
  });

  it('maps modes to facilities', () => {
    const p = { segmentId: seg, t: 0.4 };
    expect(featureOf('crosswalk', 'a', p)).toEqual({ id: 'a', segmentId: seg, kind: 'crosswalk', t: 0.4, signal: false });
    expect(featureOf('signalCrosswalk', 'a', p)?.signal).toBe(true);
    expect(featureOf('speedBump', 'a', p)?.kind).toBe('speedBump');
    expect(featureOf('schoolZone', 'a', p)).toBeNull();
    expect(featureOf('remove', 'a', p)).toBeNull();
  });

  it('finds existing facilities near an arc position, nearest first', () => {
    const d = crossDoc().doc;
    applyCommand(d, { type: 'feature.upsert', feature: { id: 'f1', segmentId: seg, kind: 'speedBump', t: 0.3 } });
    applyCommand(d, { type: 'feature.upsert', feature: { id: 'f2', segmentId: seg, kind: 'crosswalk', t: 0.6 } });
    expect(featureNear(d, seg, 0.3 * 96 + 1, 96)?.id).toBe('f1');
    expect(featureNear(d, seg, 0.6 * 96, 96)?.id).toBe('f2');
    expect(featureNear(d, seg, 45, 96)).toBeNull();
    expect(segmentFeatures(d, seg).map((f) => f.id)).toEqual(['f1', 'f2']);
  });
});

describe('StreetTool', () => {
  function setup() {
    const { doc } = crossDoc();
    const store = new ClientStore('t', 'tester');
    // Use the fixture document as the confirmed doc.
    (store.getState() as { doc: typeof doc }).doc = doc;
    const sent: Command[] = [];
    const ctx: ToolContext = {
      store,
      dispatch: (cmd) => {
        sent.push(cmd);
        return 1;
      },
      ids: () => new IdGen('t'),
      changed: () => {},
      pan: { start: () => false, move: () => {}, end: () => {} },
      focus: () => {},
    };
    const tool = new StreetTool(ctx, () => new PickIndex(store.getState().doc));
    return { doc, store, sent, tool };
  }

  it('places a crosswalk where the ghost is green and shows the reason where it is not', () => {
    const { store, sent, tool } = setup();
    tool.onPointerMove(ptr(50, 1));
    expect(tool.preview().lines[0]!.color).toBe('#4ade80');
    expect(tool.ghost()).toHaveLength(2);
    tool.onPointerDown(ptr(50, 1));
    expect(sent).toHaveLength(1);
    const cmd = sent[0]! as Extract<Command, { type: 'feature.upsert' }>;
    expect(cmd.type).toBe('feature.upsert');
    expect(cmd.feature.kind).toBe('crosswalk');
    expect(cmd.feature.signal).toBe(false);
    expect(cmd.feature.t).toBeCloseTo(50 / 96, 1);

    // 8 m from the segment end is too close: red ghost, no command.
    tool.onPointerMove(ptr(-88, 1));
    expect(tool.preview().lines[0]!.color).toBe('#ef4444');
    expect(store.getState().toolHint).toContain('12m');
    tool.onPointerDown(ptr(-88, 1));
    expect(sent).toHaveLength(1);
  });

  it('uses the signal flag for the signalized crosswalk and toggles it on an existing one', () => {
    const { doc, store, sent, tool } = setup();
    store.setToolOptions({ streetMode: 'signalCrosswalk' });
    tool.onPointerDown(ptr(50, 1));
    expect((sent[0] as Extract<Command, { type: 'feature.upsert' }>).feature.signal).toBe(true);

    const seg = Object.values(doc.segments).find((s) => doc.nodes[s.a]!.pos.x === 0 && doc.nodes[s.a]!.pos.z === 0 && doc.nodes[s.b]!.pos.x === 96)!;
    applyCommand(doc, { type: 'feature.upsert', feature: { id: 'f9', segmentId: seg.id, kind: 'crosswalk', t: 0.5, signal: true } });
    tool.onPointerDown(ptr(48, 0));
    const toggled = sent[1]! as Extract<Command, { type: 'feature.upsert' }>;
    expect(toggled.feature.id).toBe('f9');
    expect(toggled.feature.signal).toBe(false);
  });

  it('removes a hovered facility with Delete / right click, and toggles school zones', () => {
    const { doc, store, sent, tool } = setup();
    const seg = Object.values(doc.segments).find((s) => doc.nodes[s.a]!.pos.x === 0 && doc.nodes[s.b]!.pos.x === 96)!;
    applyCommand(doc, { type: 'feature.upsert', feature: { id: 'f9', segmentId: seg.id, kind: 'speedBump', t: 0.5 } });
    tool.onPointerMove(ptr(48, 0));
    expect(tool.onSecondaryClick()).toBe(true);
    expect(sent[0]).toEqual({ type: 'feature.remove', id: 'f9' });
    // Nothing hovered any more: right click falls through to cancel.
    expect(tool.onSecondaryClick()).toBe(false);

    tool.onPointerMove(ptr(48, 0));
    expect(tool.onKey({ type: 'keydown', key: 'Delete' } as KeyboardEvent)).toBe(true);
    expect(sent[1]).toEqual({ type: 'feature.remove', id: 'f9' });

    store.setToolOptions({ streetMode: 'schoolZone' });
    tool.onPointerDown(ptr(70, 0));
    expect(sent[2]).toEqual({ type: 'segment.setSchoolZone', id: seg.id, schoolZone: true });
  });

  it('selects a junction for the inspector instead of placing', () => {
    const { store, sent, tool } = setup();
    tool.onPointerDown(ptr(1, 1));
    expect(sent).toHaveLength(0);
    expect(store.getState().selection?.kind).toBe('node');
    expect(store.getState().panel).toBe('inspector');
  });
});
