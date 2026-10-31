// Scenario-side adapter of the central control frame (ADR 0015 §2). Everything that touches the physical
// simulation lives here: the read-only queries agents may make (infrastructure and the city's own fleet), the
// observation reports built from the physical event records, submitting stage queues to A0, the over-budget
// rules, the decision texts of the audit log, and handing accepted decisions to the existing executors. The
// agents (control/a*.ts) see only an ObservationView (or the known event) and these queries.
//
// Past a stage's per-tick budget (control.ts `submit`, STAGE_CAP): observe → the input-time observation is
// deferred to the start of the next tick's observe stage, a report's detection candidate stays due and is
// reported again next tick; dispatch → retried next tick (no `dispatch.failed`); signal → the requests are
// made again next tick; route → the notice is dropped (those vehicles keep their routes). Each is logged.

import { resolveGoal } from '../traffic/ops.js';
import type { Access } from '../traffic/demand.js';
import type { Vehicle, World } from '../traffic/world.js';
import { planOf } from '../traffic/signalClearing.js';
import { REJECT_CAP } from '../control/arbiter.js';
import { observationDraft, type ObservationReport } from '../control/a1Detection.js';
import { proposeDispatch, proposeSignals } from '../control/a4Emergency.js';
import { proposeReroute } from '../control/a5Reroute.js';
import { buildingTarget, KIND_LABEL, nodeTarget, observe, placeText, record, recordProposal, repeated, segmentTarget, submit, type DeferredObservation } from '../control/control.js';
import { knownEvent, observationView } from '../control/observation.js';
import { policyFactors } from '../control/policy.js';
import type { DispatchQueries, MapTarget, ObservedEvent, RerouteQueries, SignalQueries } from '../control/types.js';
import { accessGoal, dispatchIncident, emergencyType, facilitiesOf, placement, SERVICE } from './emergency.js';
import { enqueueAffected } from './reroute.js';
import { closureLanes, compose, isInformed, type Incident } from './state.js';

const SENSOR_LABEL: Record<string, string> = { cctv: 'CCTV', radar: '레이더', smartpole: '스마트폴' };
const OVER_BUDGET_RETRY = '처리 상한 초과 → 다음 tick 재시도';

// ---------- queries (read-only) ----------

export function dispatchQueries(w: World): DispatchQueries {
  const sc = w.sc!;
  return {
    vehicleType: (kind) => emergencyType(w, kind),
    facilities: (kind) => facilitiesOf(w, SERVICE[kind]),
    hasAccess: (buildingId) => w.demand.access.has(buildingId),
    routeCost(facilityId, buildingId, typeId) {
      const from = w.demand.access.get(facilityId);
      const scene = w.demand.access.get(buildingId);
      const type = w.types.get(typeId);
      if (!from || !scene || !type) return null;
      const at = placement(w, from, type.length);
      if (!at || (sc.ban !== null && sc.ban[at.lane])) return null;
      const res = w.router.find(at.lane, at.s, resolveGoal(w, accessGoal(scene), false), false, sc.zero);
      return res ? res.cost : null;
    },
  };
}

function ownVehicle(w: World, id: number): Vehicle | null {
  for (const m of w.sc!.missions) if (m.v !== null && m.v.alive && m.v.id === id) return m.v;
  return null;
}

export function signalQueries(w: World): SignalQueries {
  const net = w.net;
  const nLanes = net.nLanes;
  return {
    nextSignal(vehicleId, reach) {
      const v = ownVehicle(w, vehicleId);
      if (v === null) return null;
      let e = v.edge;
      let j = v.ri;
      let d = net.len[e]! - v.s;
      while (d <= reach) {
        const nxt = v.route[j + 1];
        if (nxt === undefined) return null;
        if (e < nLanes && nxt >= nLanes) {
          const node = net.connNode[nxt - nLanes]!;
          if (net.nodeSignalized[node]) {
            // A dark (unpowered) signal cannot be pre-empted: the vehicle takes the all-way stop like everyone.
            if (w.dark !== null && w.dark.nodeDark[node]) return null;
            const nodeId = net.nodeIds[node]!;
            const p = planOf(w, nodeId);
            const seg = w.graph.lanes[e]!.segmentId;
            const phase = p ? p.phases.findIndex((ph) => ph.approaches.includes(seg)) : -1;
            return phase >= 0 ? { nodeId, phase, distance: d } : null;
          }
        }
        d += net.len[nxt]!;
        e = nxt;
        j++;
      }
      return null;
    },
    servedVehicle: (nodeId) => w.sc!.ctl.get(nodeId)?.vehicleId ?? -1,
  };
}

export function rerouteQueries(w: World): RerouteQueries {
  return {
    informedUsing(lanes, share) {
      const nLanes = w.net.nLanes;
      const mark = new Uint8Array(nLanes);
      for (const l of lanes) mark[l] = 1;
      const ids: number[] = [];
      for (const v of w.vehicles) {
        if (!v.alive || v.scQueued || !isInformed(w, v, share)) continue;
        for (let j = v.ri + 1; j < v.route.length; j++) {
          const e = v.route[j]!;
          if (e < nLanes && mark[e]) {
            ids.push(v.id);
            break;
          }
        }
      }
      return ids.sort((a, b) => a - b);
    },
  };
}

// ---------- observe stage ----------

/** An event known when its input applied (closure, medical, blackout, surge; legacy accident and fire): A0 accepts it into the view, or defers it (budget). */
export function observeInput(w: World, ev: DeferredObservation['ev'], target: MapTarget | null, text: string, reason: string): boolean {
  const r = submit(w, 'observe', [observationDraft({ ...ev, source: 'input', sensorId: null }, w.tick, reason)]);
  if (r.accepted.length > 0) {
    observe(w, ev, 'input', target, 'A0', text, reason);
    return true;
  }
  w.sc!.control.deferred.push({ ev, target, text, reason });
  record(w, { agent: 'A0', verdict: 'rejected', action: 'observe', text, reason: `${r.rejected[0]!.reason} → 다음 tick 인지`, eventId: ev.eventId, target });
  return false;
}

function reportTarget(w: World, r: ObservationReport): MapTarget | null {
  return r.buildingId !== null ? buildingTarget(w, r.buildingId) : r.segmentId !== null ? segmentTarget(w, r.segmentId) : null;
}

const sensorName = (w: World, sensorId: string): string => {
  const kind = w.doc.sensors?.[sensorId]?.kind;
  return (kind && SENSOR_LABEL[kind]) || '센서';
};

/** A due, valid report (citizen report or sensor): accepted → the event is known; false = over budget (report again next tick). */
export function observeReport(w: World, r: ObservationReport, delayText: string): boolean {
  const where = reportTarget(w, r);
  const what = `${KIND_LABEL[r.kind]} · ${placeText(where, r.eventId)}`;
  const text = r.sensorId !== null ? `${sensorName(w, r.sensorId)} 감지: ${what}` : `시민 신고 접수: ${what}`;
  const reason = `${r.eventId}${r.sensorId !== null ? ` · 센서 ${r.sensorId}` : ''} · 발생 후 ${delayText}`;
  const res = submit(w, 'observe', [observationDraft(r, w.tick, delayText)]);
  if (res.accepted.length > 0) {
    observe(w, { eventId: r.eventId, kind: r.kind, segmentId: r.segmentId, lane: r.lane, buildingId: r.buildingId }, r.source, where, r.sensorId !== null ? 'A1' : 'A0', text, reason);
    return true;
  }
  record(w, { agent: r.sensorId !== null ? 'A1' : 'A0', verdict: 'rejected', action: 'observe', text, reason: `${res.rejected[0]!.reason} → 다음 tick 다시 보고`, eventId: r.eventId, target: where });
  return false;
}

/** A sensor candidate voided by a blackout at its tick (`detection.unpowered`): A1's report is rejected. */
export function reportVoid(w: World, r: ObservationReport): void {
  const where = reportTarget(w, r);
  record(w, { agent: 'A1', verdict: 'rejected', action: 'observe', text: `${sensorName(w, r.sensorId!)} 감지 무효: ${KIND_LABEL[r.kind]} · ${placeText(where, r.eventId)}`, reason: `${r.eventId} · 센서 ${r.sensorId} 정전`, eventId: r.eventId, target: where });
}

/** Whether the physical event of a deferred observation is still in effect. */
function stillActive(w: World, ev: DeferredObservation['ev']): boolean {
  const sc = w.sc!;
  switch (ev.kind) {
    case 'closure':
    case 'accident':
      return sc.effects.some((e) => e.eventId === ev.eventId);
    case 'fire':
    case 'medical':
      return sc.incidents.some((i) => i.eventId === ev.eventId);
    case 'blackout':
      return sc.blackouts.some((b) => b.eventId === ev.eventId);
    case 'surge':
      return sc.surgeQueue.some((t) => t.eventId === ev.eventId);
  }
}

/** What follows an input-time observation accepted late (the same reactions its input would have had). */
function afterLateObserve(w: World, ev: DeferredObservation['ev']): void {
  const sc = w.sc!;
  if (ev.kind === 'closure' || ev.kind === 'accident') {
    const e = sc.effects.find((x) => x.eventId === ev.eventId)!;
    if (e.kind === 'closure') return enqueueAffected(w, closureLanes(w, e), false, e.eventId);
    e.known = true;
    compose(w);
    const lane = w.graph.laneById.get(e.laneId);
    if (lane !== undefined) enqueueAffected(w, [lane], false, e.eventId);
    return;
  }
  if (ev.kind === 'fire' || ev.kind === 'medical') {
    const inc = sc.incidents.find((i) => i.eventId === ev.eventId)!;
    inc.knownTick = w.tick;
    dispatchIncident(w, inc);
  }
}

/** Start of the observe stage (after expiries, before the tick's inputs): deferred observations first, in order. */
export function retryDeferredObservations(w: World): void {
  const c = w.sc!.control;
  const list = c.deferred;
  c.deferred = [];
  for (const d of list) {
    if (!stillActive(w, d.ev)) {
      record(w, { agent: 'A0', verdict: 'cancelled', action: 'observe', text: d.text, reason: '인지 전에 종료', eventId: d.ev.eventId, target: d.target });
      continue;
    }
    if (observeInput(w, d.ev, d.target, d.text, d.reason)) afterLateObserve(w, d.ev);
  }
}

// ---------- dispatch stage ----------

export type DispatchPlan = { ok: true; facilityId: string; from: Access; scene: Access; typeId: string } | { ok: false; reason: string; boundary?: true; retry?: true };

/**
 * A4 proposes from the known event and the dispatch queries, A0 arbitrates, the caller executes an accepted
 * plan. An incident the city does not know of: nothing happens. Over budget: retried next tick.
 */
export function dispatchDecision(w: World, inc: Incident): DispatchPlan {
  const ev = knownEvent(w, inc.eventId);
  if (ev === null) return { ok: false, reason: '관측되지 않은 사건', boundary: true };
  const choice = proposeDispatch(ev, dispatchQueries(w), w.tick);
  if (!choice.ok) return choice;
  const r = submit(w, 'dispatch', [choice.draft]);
  const scene = buildingTarget(w, ev.buildingId!);
  const text = `${inc.kind === 'fire' ? '소방차' : '구급차'} 출동: ${placeText(buildingTarget(w, choice.facilityId), choice.facilityId)} → ${placeText(scene, ev.buildingId!)}`;
  if (r.accepted.length === 0) {
    const why = r.rejected[0]!.reason;
    if (why !== REJECT_CAP) return { ok: false, reason: why, boundary: true };
    record(w, { agent: 'A4', verdict: 'rejected', action: 'dispatch', text, reason: `${KIND_LABEL[inc.kind]} ${inc.eventId} · ${OVER_BUDGET_RETRY}`, eventId: inc.eventId, target: scene });
    return { ok: false, reason: why, retry: true };
  }
  recordProposal(w, r.accepted[0]!, 'accepted', text, `${KIND_LABEL[inc.kind]} ${inc.eventId} · 자유류 경로가 가장 짧은 시설`, scene);
  return { ok: true, facilityId: choice.facilityId, typeId: choice.typeId, from: w.demand.access.get(choice.facilityId)!, scene: w.demand.access.get(ev.buildingId!)! };
}

/** The first failed dispatch of an incident (the one `dispatch.failed` logs): a rejection in the audit. */
export function dispatchFailedDecision(w: World, inc: Incident, reason: string): void {
  const scene = buildingTarget(w, inc.buildingId);
  record(w, { agent: 'A4', verdict: 'rejected', action: 'dispatch', text: `출동 불가: ${placeText(scene, inc.buildingId)}`, reason: `${KIND_LABEL[inc.kind]} ${inc.eventId} · ${reason}`, eventId: inc.eventId, target: scene });
}

/** A dispatch cancelled before it reached the scene (`dispatch.cancel`). */
export function dispatchCancelledDecision(w: World, inc: Incident, reason: string): void {
  const scene = buildingTarget(w, inc.buildingId);
  record(w, { agent: 'A4', verdict: 'cancelled', action: 'dispatch', text: `출동 취소: ${placeText(scene, inc.buildingId)}`, reason: `${KIND_LABEL[inc.kind]} ${inc.eventId} · ${reason}`, eventId: inc.eventId, target: scene });
}

/** A mission lost for good (`dispatch.lost`), once: what it was doing and what follows. */
export function dispatchLostDecision(w: World, inc: Incident, stage: 'enroute' | 'working' | 'transport' | 'returning', reason: string, follow: string): void {
  const scene = buildingTarget(w, inc.buildingId);
  const what = stage === 'enroute' ? '출동' : stage === 'transport' ? '이송' : stage === 'returning' ? '귀소' : '현장';
  record(w, { agent: 'A4', verdict: 'cancelled', action: 'dispatch', text: `${what} 차량 소멸: ${placeText(scene, inc.buildingId)}`, reason: `${KIND_LABEL[inc.kind]} ${inc.eventId} · ${reason}${follow ? ` · ${follow}` : ''}`, eventId: inc.eventId, target: scene });
}

// ---------- signal stage ----------

export interface SignalRequest {
  vehicleId: number;
  eta: number;
  phase: number;
}

/**
 * Signal stage of a tick: A4's requests (from the ObservationView and the signal queries) → A0 (one per
 * junction) → the target phases the safety executor serves. Logged when a junction's accepted request changes;
 * requests waiting behind it, and requests over the budget (made again next tick), are counted.
 */
export function signalTargets(w: World): Map<string, SignalRequest> {
  const out = new Map<string, SignalRequest>();
  const sc = w.sc!;
  const served = sc.control.served;
  const drafts = proposeSignals(observationView(w), signalQueries(w));
  if (drafts.length === 0) {
    served.clear();
    return out;
  }
  const r = submit(w, 'signal', drafts);
  for (const p of r.accepted) {
    const a = p.action;
    if (a.type !== 'signal') continue;
    out.set(a.nodeId, { vehicleId: a.vehicleId, eta: a.eta, phase: a.phase });
    if (served.get(a.nodeId) !== a.vehicleId) {
      served.set(a.nodeId, a.vehicleId);
      const node = nodeTarget(w, a.nodeId);
      recordProposal(w, p, 'accepted', `우선신호: ${placeText(node, a.nodeId)} 위상 ${a.phase + 1} ← 차량 ${a.vehicleId}`, `${p.reason} · 도착 ${(a.eta / w.tickRate).toFixed(0)}초 전 · 전환은 안전 실행기(황색·전적색·보행 정리)`, node);
    }
  }
  for (const nodeId of [...served.keys()]) if (!out.has(nodeId)) served.delete(nodeId);
  const over = r.rejected.filter((x) => x.reason === REJECT_CAP).length;
  if (over > 0) record(w, { agent: 'A0', verdict: 'rejected', action: 'signal', text: `우선신호 요청 ${over}건 처리 상한 초과`, reason: '다음 tick에 다시 요청', eventId: null, target: null });
  for (let k = 0; k < r.rejected.length - over; k++) repeated(w);
  return out;
}

// ---------- route stage ----------

/** A5's re-route notice for a known event's affected lanes: the accepted informed vehicles (vehicle order), else []. */
export function rerouteNotice(w: World, lanes: readonly number[], eventId: string, ended: boolean): Vehicle[] {
  const sc = w.sc!;
  const ev = knownEvent(w, eventId);
  if (ev === null) return [];
  const draft = proposeReroute(ev, lanes, ended, { tick: w.tick, factors: policyFactors(sc.policy) }, rerouteQueries(w));
  if (draft === null || draft.action.type !== 'reroute') return [];
  const ids = new Set(draft.action.vehicleIds);
  const segmentId = w.graph.lanes[lanes[0]!]?.segmentId;
  const target = segmentId !== undefined ? segmentTarget(w, segmentId) : null;
  const text = `우회 안내: 정보 차량 ${ids.size}대 재탐색`;
  const r = submit(w, 'route', [draft]);
  if (r.accepted.length === 0) {
    record(w, { agent: 'A5', verdict: 'rejected', action: 'reroute', text, reason: `${r.rejected[0]!.reason} → 안내 취소 (차량은 기존 경로 유지)`, eventId, target });
    return [];
  }
  recordProposal(w, r.accepted[0]!, 'accepted', text, `${KIND_LABEL[ev.kind]} ${eventId} ${ended ? '종료' : '발생'} · 영향 차선 ${lanes.length}개 · 정보 차량 비율 ${Math.round(sc.policy.informedShare * 100)}%`, target);
  return w.vehicles.filter((v) => ids.has(v.id));
}
