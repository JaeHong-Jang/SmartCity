import { describe, expect, it } from 'vitest';
import { createEmptyDoc, FACILITY_PRESETS } from '@smartcity/shared';
import type { ScenarioOutcome } from '@smartcity/sim';
import { dispatchText, incidentText } from './emergencyText';
import { applyOutcomes, reconcileEvents, type PendingEnd } from './eventState';
import { countFacilities, facilityHint, FACILITY_SUMMARY } from './facilities';
import type { EventRow } from './store';

const row = (over: Partial<EventRow> = {}): EventRow => ({ eventId: 'f1', kind: 'fire', label: '건물 화재', pos: { x: 0, z: 0 }, startTick: 100, endTick: null, status: 'ok', active: false, ended: false, buildingId: 'b1', ...over });
const out = (kind: string, over: Partial<ScenarioOutcome> = {}): ScenarioOutcome => ({ eventId: 'f1', tick: 120, kind, applied: true, ...over });
const none = new Map<string, PendingEnd>();

describe('fire and medical rows', () => {
  it('follow the snapshot: incident state and progress, the dispatch stage', () => {
    const view = {
      activeEvents: [{ eventId: 'f1', kind: 'fire' as const, startTick: 100, endTick: null }],
      incidents: [{ eventId: 'f1', kind: 'fire' as const, buildingId: 'b1', state: 'burning' as const, progress: 37.4 }],
      dispatches: [{ eventId: 'f1', kind: 'fire' as const, vehicleId: 9, stage: 'enroute' as const, facilityId: 'fs', buildingId: 'b1' }],
    };
    const [r] = reconcileEvents([row({ status: 'pending' })], view, 130, new Map());
    expect(r!.status).toBe('ok');
    expect(r!.active).toBe(true);
    expect(r!.incident).toEqual({ state: 'burning', progress: 37.4 });
    expect(r!.dispatch).toEqual({ stage: 'enroute', vehicleId: 9 });
    expect(incidentText(r!)).toBe('불타는 중 37%');
    expect(dispatchText(r!)).toBe('출동 중');
  });

  it('outcomes: dispatch status, response time and result', () => {
    let rows = [row()];
    rows = applyOutcomes(rows, [out('dispatch.start', { reason: 'vehicle 9 from fs' })], none);
    expect(dispatchText(rows[0]!)).toBe('출동 중');
    rows = applyOutcomes(rows, [out('dispatch.arrive', { reason: '12.0분' })], none);
    expect(rows[0]!.response).toBe('12.0분');
    expect(dispatchText(rows[0]!)).toBe('현장 도착 · 대응 12.0분');
    rows = applyOutcomes(rows, [out('fire.extinguished')], none);
    expect(incidentText(rows[0]!)).toBe('진화됨');
    rows = applyOutcomes([row()], [out('fire.damaged')], none);
    expect(incidentText(rows[0]!)).toBe('피해');
    rows = applyOutcomes([row({ kind: 'medical' })], [out('medical.complete')], none);
    expect(incidentText(rows[0]!)).toBe('완료');
  });

  it('a call no vehicle could be sent to says why, and the incident keeps running', () => {
    const rows = applyOutcomes([row()], [out('dispatch.failed', { reason: '출동 불가: 시설 없음' })], none);
    expect(dispatchText(rows[0]!)).toBe('출동 불가: 시설 없음');
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.ended).toBe(false);
  });

  it('medical states read as waiting, treating, transport', () => {
    const m = (state: 'waiting' | 'treating' | 'transport') => incidentText({ kind: 'medical', incident: { state, progress: 0 }, ended: false });
    expect([m('waiting'), m('treating'), m('transport')]).toEqual(['대기 중', '처치 중', '이송 중']);
  });
});

describe('a call that ended without a result never shows its last progress state', () => {
  const burning = {
    activeEvents: [{ eventId: 'f1', kind: 'fire' as const, startTick: 100, endTick: null }],
    incidents: [{ eventId: 'f1', kind: 'fire' as const, buildingId: 'b1', state: 'burning' as const, progress: 0 }],
    dispatches: [],
  };
  const gone = { activeEvents: [], incidents: [], dispatches: [] };

  it('manual end: 수동 종료, not "불타는 중 0%"', () => {
    const pending = new Map<string, PendingEnd>([['end1', { rowId: 'f1', tick: 150 }]]);
    let rows = reconcileEvents([row({ status: 'ok' })], burning, 120, pending);
    expect(incidentText(rows[0]!)).toBe('불타는 중 0%');
    rows = applyOutcomes(rows, [out('fire.end', { eventId: 'end1', applied: true })], pending);
    rows = reconcileEvents(rows, gone, 160, pending);
    expect(rows[0]!.ended).toBe(true);
    expect(rows[0]!.incident).toBeUndefined();
    expect(incidentText(rows[0]!)).toBe('수동 종료');
  });

  it('target building deleted: 대상 건물 삭제됨', () => {
    let rows = reconcileEvents([row({ status: 'ok' })], burning, 120, new Map());
    rows = applyOutcomes(rows, [out('fire.end', { reason: 'target gone' })], new Map());
    expect(incidentText(rows[0]!)).toBe('대상 건물 삭제됨'); // already, before the next snapshot
    rows = reconcileEvents(rows, gone, 160, new Map());
    expect(incidentText(rows[0]!)).toBe('대상 건물 삭제됨');
  });

  it('transport failed: 이송 실패, the cause (vehicle gone or no hospital) is the dispatch note, not "이송 중"', () => {
    const transporting = {
      activeEvents: [{ eventId: 'f1', kind: 'medical' as const, startTick: 100, endTick: null }],
      incidents: [{ eventId: 'f1', kind: 'medical' as const, buildingId: 'b1', state: 'transport' as const, progress: 0 }],
      dispatches: [{ eventId: 'f1', kind: 'medical' as const, vehicleId: 4, stage: 'transport' as const, facilityId: 'h', buildingId: 'b1' }],
    };
    let rows = reconcileEvents([row({ kind: 'medical', status: 'ok' })], transporting, 120, new Map());
    expect(dispatchText(rows[0]!)).toBe('이송 중');
    rows = applyOutcomes(rows, [out('dispatch.lost', { reason: '이송할 병원 없음' }), out('medical.end', { reason: 'patient transport lost' })], new Map());
    rows = reconcileEvents(rows, gone, 160, new Map());
    expect(incidentText(rows[0]!)).toBe('이송 실패');
    expect(dispatchText(rows[0]!)).toBe('출동 차량 상실: 이송할 병원 없음');
    expect(`${incidentText(rows[0]!)} ${dispatchText(rows[0]!)}`).not.toContain('이송 중');

    // Hospital still there but the ambulance was removed by a road edit (Sol 4c2 UI recheck #1): no "병원 없음".
    let other = reconcileEvents([row({ kind: 'medical', status: 'ok' })], transporting, 120, new Map());
    other = applyOutcomes(other, [out('dispatch.lost', { reason: '차량 소멸' }), out('medical.end', { reason: 'patient transport lost' })], new Map());
    other = reconcileEvents(other, gone, 160, new Map());
    expect(incidentText(other[0]!)).toBe('이송 실패');
    expect(dispatchText(other[0]!)).toBe('출동 차량 상실: 차량 소멸');
    expect(`${incidentText(other[0]!)} ${dispatchText(other[0]!)}`).not.toContain('병원 없음');
  });

  it('explicit terminal results win: 진화됨, 피해, 완료 stay', () => {
    const base = reconcileEvents([row({ status: 'ok' })], burning, 120, new Map());
    const ext = applyOutcomes(base, [out('fire.extinguished'), out('fire.end', { reason: 'target gone' })], new Map());
    expect(incidentText(ext[0]!)).toBe('진화됨');
    const dmg = applyOutcomes(base, [out('fire.damaged')], new Map());
    expect(incidentText(reconcileEvents(dmg, gone, 200, new Map())[0]!)).toBe('피해');
  });
});

describe('after an end the vehicle is driving back, not dispatching', () => {
  const live = {
    activeEvents: [{ eventId: 'f1', kind: 'fire' as const, startTick: 100, endTick: null }],
    incidents: [{ eventId: 'f1', kind: 'fire' as const, buildingId: 'b1', state: 'burning' as const, progress: 20 }],
    dispatches: [{ eventId: 'f1', kind: 'fire' as const, vehicleId: 4, stage: 'enroute' as const, facilityId: 'fs', buildingId: 'b1' }],
  };
  const returning = { activeEvents: [], incidents: [], dispatches: [{ eventId: 'f1', kind: 'fire' as const, vehicleId: 4, stage: 'returning' as const, facilityId: 'fs', buildingId: 'b1' }] };
  const home = { activeEvents: [], incidents: [], dispatches: [] };

  it('manual end → 복귀 중 → 복귀 완료, never 출동 중 on the ended row', () => {
    const pending = new Map<string, PendingEnd>([['end1', { rowId: 'f1', tick: 150 }]]);
    let rows = reconcileEvents([row({ status: 'ok' })], live, 120, pending);
    rows = applyOutcomes(rows, [out('dispatch.start')], pending);
    expect(dispatchText(rows[0]!)).toBe('출동 중');
    // the end applies: the sim recalls the truck (outcomes first, then the snapshot)
    rows = applyOutcomes(rows, [out('fire.end', { eventId: 'end1' }), out('dispatch.cancel', { reason: 'recalled' })], pending);
    expect(rows[0]!.endReason).toBe('수동 종료');
    expect(dispatchText(rows[0]!)).not.toContain('출동 중'); // even before the next snapshot
    rows = reconcileEvents(rows, returning, 160, pending);
    expect(dispatchText(rows[0]!)).toBe('복귀 중');
    expect(incidentText(rows[0]!)).toBe('수동 종료');
    rows = applyOutcomes(rows, [out('dispatch.return', { tick: 300 })], pending);
    rows = reconcileEvents(rows, home, 310, pending);
    expect(dispatchText(rows[0]!)).toBe('복귀 완료');
  });

  it('a cancelled or lost vehicle shows that reason after the end', () => {
    let rows = reconcileEvents([row({ status: 'ok' })], live, 120, new Map());
    rows = applyOutcomes(rows, [out('dispatch.start'), out('fire.end', { reason: 'target gone' }), out('dispatch.lost', { reason: '편집으로 사라짐' })], new Map());
    rows = reconcileEvents(rows, home, 160, new Map());
    expect(dispatchText(rows[0]!)).toBe('출동 차량 상실: 편집으로 사라짐');
  });
});

describe('facilities', () => {
  it('counts the buildings of each service design in the copy', () => {
    const doc = createEmptyDoc('t', 1);
    for (const t of FACILITY_PRESETS) doc.buildingTypes[t.id] = t;
    const place = (id: string, typeId: string) => (doc.buildings[id] = { id, typeId, pos: { x: 0, z: 0 }, rotation: 0 });
    place('a', 'svc-fire-station');
    place('b', 'svc-fire-station');
    place('c', 'svc-hospital');
    const c = countFacilities(doc);
    expect(c).toEqual({ fireStation: 2, hospital: 1, substation: 0, powerPlant: 0 });
    expect(FACILITY_SUMMARY(c)).toBe('소방서 2 · 병원 1 · 변전소 0 · 발전소 0');
  });

  it('hints before creating a call nobody can answer', () => {
    const none = { fireStation: 0, hospital: 0, substation: 0, powerPlant: 0 };
    expect(facilityHint('fire', none)).toBe('소방서가 없어 출동할 수 없습니다 — 도시에 소방서를 지어 두세요');
    expect(facilityHint('medical', none)).toContain('병원이 없어');
    expect(facilityHint('fire', { ...none, fireStation: 1 })).toBeNull();
    expect(facilityHint('medical', { ...none, hospital: 1 })).toBeNull();
    expect(facilityHint('medical', { ...none, fireStation: 1 })).not.toBeNull(); // a fire station does not answer medical calls
  });
});
