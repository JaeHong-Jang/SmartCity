import { describe, expect, it } from 'vitest';
import { createEmptyDoc, FACILITY_PRESETS } from '@smartcity/shared';
import { blackoutState, powerSummaryText } from './emergencyText';
import { coverageRings } from './coverage';
import { facilityHint, SUPPLY_MODEL_NOTE } from './facilities';
import { blackoutAreaPlace, blackoutSubstationPlace } from './label';
import { reconcileEvents } from './eventState';
import { ticksToGameMin } from './time';
import type { EventRow } from './store';

const row = (over: Partial<EventRow> = {}): EventRow => ({ eventId: 'b1', kind: 'blackout', label: '정전', pos: { x: 0, z: 0 }, startTick: 100, endTick: 3700, status: 'ok', active: false, ended: false, ...over });

describe('blackout rows', () => {
  it('reads 정전 중 with the minutes left, then 복구됨 once the sim stops listing it', () => {
    const listed = { activeEvents: [{ eventId: 'b1', kind: 'blackout' as const, startTick: 100, endTick: 3700 }] };
    let rows = reconcileEvents([row({ status: 'pending' })], listed, 200, new Map());
    expect(rows[0]!.active).toBe(true);
    expect(blackoutState(rows[0]!, 200, ticksToGameMin)).toBe('정전 중 · 남은 30분'); // 3500 ticks ≈ 29.2 game min
    rows = reconcileEvents(rows, { activeEvents: [] }, 3800, new Map());
    expect(rows[0]!.ended).toBe(true);
    expect(blackoutState(rows[0]!, 3800, ticksToGameMin)).toBe('복구됨');
  });

  it('is undecided (generic text) while unconfirmed, and for other kinds', () => {
    expect(blackoutState(row({ status: 'pending' }), 0, ticksToGameMin)).toBeNull();
    expect(blackoutState(row({ kind: 'fire', active: true }), 0, ticksToGameMin)).toBeNull();
    expect(blackoutState(row({ active: true, endTick: null }), 0, ticksToGameMin)).toBe('정전 중');
  });

  it('labels: a substation area, or a disc with its radius', () => {
    const doc = createEmptyDoc('t', 1);
    for (const t of FACILITY_PRESETS) doc.buildingTypes[t.id] = t;
    doc.buildings['s1'] = { id: 's1', typeId: 'svc-substation', pos: { x: 5, z: 6 }, rotation: 0 };
    const sub = blackoutSubstationPlace(doc, 's1');
    expect(sub.label).toMatch(/담당 구역 정전$/);
    expect(sub.pos).toEqual({ x: 5, z: 6 });
    expect(blackoutAreaPlace(10.4, -20.6, 150).label).toBe('구역 정전 (10, -21) 반경 150 m');
  });
});

describe('blackout numbers are city-wide, not per event', () => {
  it('two blackouts: each row shows only its own state; the city-wide counts are one separate line', () => {
    const a = row({ eventId: 'A', active: true, endTick: 3700 });
    const b = row({ eventId: 'B', active: true, endTick: 5000 });
    const ta = blackoutState(a, 200, ticksToGameMin)!;
    const tb = blackoutState(b, 200, ticksToGameMin)!;
    expect(ta).toMatch(/^정전 중 · 남은 \d+분$/);
    expect(tb).toMatch(/^정전 중 · 남은 \d+분$/);
    expect(ta).not.toContain('신호');
    expect(tb).not.toContain('신호');
    expect(powerSummaryText({ dark: 3, battery: 0, buildings: 12, queue: 1.5 })).toBe('전체 도시 정전 현황: 정전 신호 3 · 배터리 유지 0 · 전기 끊긴 건물 12 · 대기 1.5차량·분');
  });
});

describe('substation tool', () => {
  it('hints when the copy has no substation (an area blackout always works); notes the supply model', () => {
    const c = { fireStation: 1, hospital: 1, substation: 0, powerPlant: 0 };
    expect(facilityHint('blackout', c)).toContain('변전소가 없어');
    expect(facilityHint('blackout', { ...c, substation: 1 })).toBeNull();
    expect(SUPPLY_MODEL_NOTE).toBe('커버리지 기반 공급 모델');
  });

  it('coverage circles reach the farthest supplied junction or building (at least 30 m)', () => {
    const doc = createEmptyDoc('t', 1);
    doc.buildings['s1'] = { id: 's1', typeId: 'x', pos: { x: 0, z: 0 }, rotation: 0 };
    doc.buildings['h1'] = { id: 'h1', typeId: 'x', pos: { x: 30, z: 40 }, rotation: 0 };
    doc.nodes['n1'] = { id: 'n1', pos: { x: 0, z: 100 } } as never;
    const rings = coverageRings(doc, { substations: ['s1', 'missing'], junctions: { n1: 's1' }, buildings: { h1: 's1' } });
    expect(rings).toEqual([{ substationId: 's1', x: 0, z: 0, radius: 100 }]);
    expect(coverageRings(doc, { substations: ['s1'], junctions: {}, buildings: {} })[0]!.radius).toBe(30);
  });
});
