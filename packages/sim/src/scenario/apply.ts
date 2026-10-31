// Scenario input validation and the single application path (ADR 0010 §2). Inputs are validated when they
// are queued and applied at the start of the tick they name, in (tick, order, eventId) order; accidents
// whose duration ran out end first (eventId order), exactly like an explicit `accident.end`.

import type { World } from '../traffic/world.js';
import { closureLanes, compose, logOutcome, newScenarioState, type AccidentEffect, type ClosureEffect, type Effect } from './state.js';
import { endBlackout, findBlackout, startBlackout } from './blackout.js';
import { endIncident, startIncident } from './emergency.js';
import { enqueueAffected } from './reroute.js';
import { generateSurge } from './surge.js';
import { detectionMissed, trackAccident } from './detection.js';
import { buildingTarget, placeText, segmentTarget } from '../control/control.js';
import { RESERVED_FACTORS, reservedError } from '../control/policy.js';
import { observeInput, retryDeferredObservations } from './controlAdapter.js';
import { DETECTION_MODES, detectionOf, SCENARIO_INPUT_KEYS, SCENARIO_PARAM_KEYS, SCENARIO_TARGET_KEYS, type ResponsePolicy, type ScenarioInput, type ScenarioInputKind, type ScenarioResult } from './types.js';

export const ACCIDENT_TICKS = 2400;
export const ACCIDENT_LENGTH = 9;
/** Gap kept between a placed obstacle and the vehicle body it was moved past. */
const PLACE_MARGIN = 0.5;
const MAX_SURGE_TRIPS = 5000;

const KINDS = new Set<ScenarioInputKind>(['closure.start', 'closure.end', 'accident.start', 'accident.end', 'surge.start', 'fire.start', 'fire.end', 'medical.start', 'medical.end', 'blackout.start', 'blackout.end', 'policy.set']);
const END_KINDS = new Set<ScenarioInputKind>(['closure.end', 'accident.end', 'fire.end', 'medical.end', 'blackout.end']);

export function ensureScenario(w: World): NonNullable<World['sc']> {
  w.sc ??= newScenarioState(w);
  return w.sc;
}

const isTick = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Segment lane position check against the current graph (null = ok). */
function laneError(w: World, segmentId: string | undefined, lane: number | undefined, required: boolean): string | null {
  if (typeof segmentId !== 'string') return 'target.segmentId가 필요합니다';
  const seg = w.graph.segments.get(segmentId);
  if (!seg) return `없는 도로 ${segmentId}`;
  if (lane === undefined) return required ? 'target.lane이 필요합니다' : null;
  if (!Number.isInteger(lane) || lane < 0 || lane >= seg.lanes.length) return `도로 ${segmentId}에 차선 ${lane}이 없습니다`;
  return null;
}

/**
 * Enqueue-time validation is static only — shape, kind, not a past tick, unique eventId, target types and the
 * existence of the referenced segment / lane / building — so a record of accepted live inputs is accepted
 * again however it is queued (all at once on replay, any order). Whether an end finds its event (unknown,
 * not started yet, already ended, ended by an earlier input) is decided at apply time, in (tick, order,
 * eventId) order, as a logged no-op.
 */
function validate(w: World, input: ScenarioInput): string | null {
  const sc = w.sc!;
  if (!input || typeof input !== 'object') return '입력 형식 오류';
  if (typeof input.eventId !== 'string' || input.eventId.length === 0) return 'eventId가 필요합니다';
  if (sc.seen.has(input.eventId)) return `중복 eventId ${input.eventId}`;
  if (!isTick(input.tick)) return 'tick은 0 이상의 정수여야 합니다';
  if (input.tick < w.tick) return `지난 tick ${input.tick} (현재 ${w.tick})`;
  // Every number must survive a JSON round trip (NaN / ±Infinity become null): records accepted live replay.
  if (typeof input.order !== 'number' || !Number.isSafeInteger(input.order)) return 'order는 정수여야 합니다';
  if (!KINDS.has(input.kind)) return `알 수 없는 kind ${String(input.kind)}`;
  if (typeof input.target !== 'object' || input.target === null || Array.isArray(input.target)) return 'target은 객체여야 합니다';
  if (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params)) return 'params는 객체여야 합니다';
  const t = input.target;
  const p = input.params;
  // Whitelisted keys only: an accepted input is plain JSON (no BigInt, functions or nested objects ride along).
  for (const k of Object.keys(input)) if (!(SCENARIO_INPUT_KEYS as readonly string[]).includes(k)) return `알 수 없는 입력 필드 ${k}`;
  for (const k of Object.keys(t)) if (!(SCENARIO_TARGET_KEYS as readonly string[]).includes(k)) return `알 수 없는 target 필드 ${k}`;
  for (const k of Object.keys(p)) if (!SCENARIO_PARAM_KEYS[input.kind].includes(k)) return `${input.kind}에 없는 params 필드 ${k}`;
  for (const k of ['segmentId', 'buildingId', 'eventId'] as const) if (t[k] !== undefined && typeof t[k] !== 'string') return `target.${k}는 문자열이어야 합니다`;
  if (t.lane !== undefined && !(typeof t.lane === 'number' && Number.isInteger(t.lane) && t.lane >= 0)) return 'target.lane은 0 이상의 정수여야 합니다';
  if (t.s !== undefined && !(typeof t.s === 'number' && Number.isFinite(t.s) && t.s >= 0)) return 'target.s는 0 이상의 유한한 수여야 합니다';
  for (const k of Object.keys(p)) if (typeof p[k] !== 'number' || !Number.isFinite(p[k]!)) return `params.${k}는 유한한 수여야 합니다`;
  if (p.durationTicks !== undefined && (!isTick(p.durationTicks) || p.durationTicks < 1)) return 'durationTicks는 1 이상의 정수여야 합니다';
  if (t.eventId !== undefined && !END_KINDS.has(input.kind)) return 'target.eventId는 *.end 입력에만 씁니다';
  for (const k of ['burnTicks', 'suppressTicks', 'treatTicks'] as const) if (p[k] !== undefined && (!isTick(p[k]) || p[k] < 1)) return `${k}는 1 이상의 정수여야 합니다`;
  switch (input.kind) {
    case 'closure.start':
      return laneError(w, t.segmentId, t.lane, false);
    case 'closure.end':
    case 'accident.end':
      if (t.eventId !== undefined) return typeof t.eventId === 'string' && t.eventId.length > 0 ? null : 'target.eventId는 문자열이어야 합니다';
      return laneError(w, t.segmentId, t.lane, input.kind === 'accident.end');
    case 'accident.start': {
      const e = laneError(w, t.segmentId, t.lane, true);
      if (e) return e;
      const l = w.graph.segments.get(t.segmentId!)!.lanes[t.lane!]!;
      if (t.s !== undefined && (typeof t.s !== 'number' || t.s < 0 || t.s > w.net.len[l]!)) return `target.s는 0..${w.net.len[l]!.toFixed(1)} 범위여야 합니다`;
      if (p.length !== undefined && !(p.length > 0)) return 'length는 양수여야 합니다';
      return null;
    }
    case 'surge.start': {
      if (typeof t.buildingId !== 'string' || !w.doc.buildings[t.buildingId]) return `없는 건물 ${String(t.buildingId)}`;
      if (!w.demand.access.has(t.buildingId)) return `건물 ${t.buildingId}에 접속 도로가 없습니다`;
      if (!Number.isInteger(p.extraTrips) || p.extraTrips! < 1 || p.extraTrips! > MAX_SURGE_TRIPS) return `extraTrips는 1..${MAX_SURGE_TRIPS} 정수여야 합니다`;
      for (const k of ['inflowTicks', 'stayTicks', 'outflowTicks'] as const) if (p[k] !== undefined && !isTick(p[k])) return `${k}는 0 이상의 정수여야 합니다`;
      return null;
    }
    case 'fire.start':
    case 'medical.start':
      // Facilities and routes are looked up when the call applies: none → the incident runs, `dispatch.failed`.
      return typeof t.buildingId === 'string' && w.doc.buildings[t.buildingId] ? null : `없는 건물 ${String(t.buildingId)}`;
    case 'fire.end':
    case 'medical.end':
      if (t.eventId !== undefined) return t.eventId.length > 0 ? null : 'target.eventId는 문자열이어야 합니다';
      return typeof t.buildingId === 'string' && w.doc.buildings[t.buildingId] ? null : `없는 건물 ${String(t.buildingId)}`;
    case 'blackout.start': {
      const disc = p.x !== undefined || p.z !== undefined || p.radius !== undefined;
      if (t.buildingId !== undefined) {
        if (disc) return 'blackout.start: buildingId 또는 x, z, radius 중 하나만';
        const b = w.doc.buildings[t.buildingId];
        return b && w.doc.buildingTypes[b.typeId]?.service === 'substation' ? null : `변전소가 아닌 건물 ${t.buildingId}`;
      }
      if (p.x === undefined || p.z === undefined || p.radius === undefined) return 'blackout.start: 변전소 buildingId 또는 x, z, radius가 필요합니다';
      return p.radius > 0 && p.radius <= 20000 ? null : 'radius는 0 < r ≤ 20000이어야 합니다';
    }
    case 'blackout.end':
      if (t.eventId !== undefined) return t.eventId.length > 0 ? null : 'target.eventId는 문자열이어야 합니다';
      return typeof t.buildingId === 'string' && w.doc.buildings[t.buildingId] ? null : `없는 건물 ${String(t.buildingId)}`;
    case 'policy.set':
      if (p.reroute !== 0 && p.reroute !== 1) return 'reroute는 0 또는 1이어야 합니다';
      if (!(p.informedShare! >= 0 && p.informedShare! <= 1)) return 'informedShare는 0..1이어야 합니다';
      if (p.preempt !== undefined && p.preempt !== 0 && p.preempt !== 1) return 'preempt는 0 또는 1이어야 합니다';
      if (p.battery !== undefined && p.battery !== 0 && p.battery !== 1) return 'battery는 0 또는 1이어야 합니다';
      if (p.detection !== undefined && p.detection !== 0 && p.detection !== 1 && p.detection !== 2) return 'detection은 0(legacy), 1(reports), 2(sensors)여야 합니다';
      return reservedError((k) => p[k], 0);
  }
  return null;
}

/** Validate and queue an input. Nothing changes in the running simulation until its tick. */
export function queueScenarioInput(w: World, input: ScenarioInput): ScenarioResult {
  const sc = ensureScenario(w);
  const error = validate(w, input);
  if (error) return { ok: false, error };
  sc.seen.add(input.eventId);
  // Own copy: callers cannot change a queued input afterwards.
  const target: ScenarioInput['target'] = {};
  for (const k of SCENARIO_TARGET_KEYS) if (input.target[k] !== undefined) (target as Record<string, unknown>)[k] = input.target[k];
  const params: Record<string, number> = {};
  // Reserved factors (always 0 here) are accepted and dropped: never recorded, never applied (ADR 0015 §3).
  for (const k of SCENARIO_PARAM_KEYS[input.kind]) if (input.params[k] !== undefined && !(input.kind === 'policy.set' && (RESERVED_FACTORS as readonly string[]).includes(k))) params[k] = input.params[k]!;
  const copy: ScenarioInput = { eventId: input.eventId, tick: input.tick, order: input.order, kind: input.kind, target, params };
  sc.pending.push(copy);
  sc.accepted.push(copy);
  sc.pendingSorted = false;
  return { ok: true };
}

/**
 * Runtime policy change as a recorded input: applied first at the start of the next step (the same effect as
 * an immediate change, since nothing runs between steps), and kept in `accepted` for the ScenarioRecord.
 */
export function queuePolicy(w: World, policy: ResponsePolicy): ScenarioInput {
  const sc = ensureScenario(w);
  const k = sc.policyInputs++;
  const input: ScenarioInput = {
    eventId: `policy@${w.tick}#${k}`,
    tick: w.tick,
    order: Number.MIN_SAFE_INTEGER + k,
    kind: 'policy.set',
    target: {},
    params: {
      reroute: policy.reroute ? 1 : 0,
      informedShare: policy.informedShare,
      ...(policy.preempt !== undefined ? { preempt: policy.preempt ? 1 : 0 } : {}),
      ...(policy.battery !== undefined ? { battery: policy.battery ? 1 : 0 } : {}),
      ...(policy.detection !== undefined ? { detection: DETECTION_MODES.indexOf(policy.detection) } : {}),
    },
  };
  const r = queueScenarioInput(w, input);
  if (!r.ok) throw new RangeError(r.error);
  return { ...input, target: {}, params: { ...input.params } };
}

const byKey = (a: ScenarioInput, b: ScenarioInput): number => a.tick - b.tick || a.order - b.order || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

/** Start of a tick: expired accidents end, then due inputs apply in (tick, order, eventId) order. */
export function applyDueInputs(w: World): void {
  const sc = w.sc!;
  const expired = sc.effects.filter((e) => e.endTick <= w.tick).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  for (const e of expired) endEffect(w, e, null);
  if (sc.blackouts.length > 0) for (const b of sc.blackouts.filter((x) => x.endTick <= w.tick).sort((a, c) => (a.eventId < c.eventId ? -1 : 1))) endBlackout(w, b, null);
  // Observations deferred by last tick's observe budget come first (ADR 0015 §2; empty below the cap).
  if (sc.control.deferred.length > 0) retryDeferredObservations(w);
  if (sc.pending.length === 0) return;
  if (!sc.pendingSorted) {
    sc.pending.sort(byKey);
    sc.pendingSorted = true;
  }
  let n = 0;
  while (n < sc.pending.length && sc.pending[n]!.tick <= w.tick) n++;
  if (n === 0) return;
  const due = sc.pending.splice(0, n);
  for (const input of due) applyScenarioInput(w, input);
}

function log(w: World, input: ScenarioInput, applied: boolean, note?: string): void {
  const e = { eventId: input.eventId, tick: w.tick, kind: input.kind, applied, ...(note ? { note } : {}) };
  logOutcome(w.sc!, e);
}

/**
 * End an effect: by duration (`by` null) or by the end input `by`. An accident the city never knew of (ADR
 * 0013) sends no re-route notice (only the no-route retry, which is on-site recovery) and is logged missed.
 */
function endEffect(w: World, e: Effect, by: string | null): void {
  const sc = w.sc!;
  sc.effects.splice(sc.effects.indexOf(e), 1);
  const unknown = e.kind === 'accident' && !e.known;
  const lanes = unknown ? [] : effectLanes(w, e);
  compose(w);
  logOutcome(sc, { eventId: e.eventId, tick: w.tick, kind: `${e.kind}.end`, applied: true, note: by === null ? 'duration' : `by ${by}` });
  if (unknown) detectionMissed(w, e.eventId, 'ended before detection');
  enqueueAffected(w, lanes, true, e.eventId);
}

function effectLanes(w: World, e: Effect): number[] {
  if (e.kind === 'closure') return closureLanes(w, e);
  const l = w.graph.laneById.get(e.laneId);
  return l === undefined ? [] : [l];
}

/**
 * Obstacle rear on `lane`: the requested position, or — when a vehicle body (or the exit space promised to
 * a granted vehicle at the lane start) is in the way — the nearest free position ahead of it, else behind.
 * Null when the lane has no room at all.
 */
function placeObstacle(w: World, lane: number, want: number, len: number, others: readonly { rear: number; len: number }[], keep = false): number | null {
  const net = w.net;
  const L = net.len[lane]!;
  if (len > L) return null;
  const busy: [number, number][] = [];
  for (const u of w.onEdge[lane]!) busy.push([u.s - u.len, u.s]);
  // Tails of vehicles that have left the lane but still overhang its end.
  for (const n of net.next[lane]!) {
    for (const u of w.onEdge[n]!) if (u.s < u.len) busy.push([L - (u.len - u.s), L]);
  }
  if (w.reserved[lane]! > 0) busy.push([0, w.reserved[lane]!]);
  // Obstacles of other events on this lane.
  for (const o of others) busy.push([o.rear, o.rear + o.len]);
  busy.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const free = (r: number, m = PLACE_MARGIN): boolean => r >= 0 && r + len <= L + 1e-9 && busy.every(([a, b]) => r + len <= a - m || r >= b + m);
  // An obstacle that already sits there (re-check after an edit) stays unless something actually overlaps it.
  if (keep && free(want, 0)) return want;
  let r = Math.max(0, Math.min(want, L - len));
  if (free(r)) return r;
  // Ahead: just past each body that ends after the wanted rear.
  for (const [, b] of busy) {
    const c = b + PLACE_MARGIN;
    if (c >= r && free(c)) return c;
  }
  // Behind: just before each body that starts before it.
  for (let k = busy.length - 1; k >= 0; k--) {
    const c = busy[k]![0] - PLACE_MARGIN - len;
    if (c <= r && free(c)) return c;
  }
  return null;
}

/**
 * After a recompile (lane lengths may change by < 0.5 m and kept vehicles are clamped to the new lengths):
 * every accident obstacle is checked against vehicle bodies, exit reservations and the obstacles already
 * re-placed (effect order), and moved with the placement rule (nearest free spot ahead, else behind) when it
 * no longer fits. An obstacle whose lane vanished or that finds no room ends, logged. Then recompose.
 */
export function relocateObstacles(w: World): void {
  const sc = w.sc!;
  const placed = new Map<number, { rear: number; len: number }[]>();
  for (const e of [...sc.effects]) {
    if (e.kind !== 'accident') continue;
    const lane = w.graph.laneById.get(e.laneId);
    const len = lane === undefined ? 0 : Math.min(e.len, w.net.len[lane]!);
    const others = lane === undefined ? [] : (placed.get(lane) ?? []);
    const rear = lane === undefined ? null : placeObstacle(w, lane, e.rear, len, others, true);
    if (lane === undefined || rear === null) {
      sc.effects.splice(sc.effects.indexOf(e), 1);
      logOutcome(sc, { eventId: e.eventId, tick: w.tick, kind: 'accident.end', applied: true, note: lane === undefined ? 'lane gone' : 'no room after edit' });
      detectionMissed(w, e.eventId, 'target gone');
      continue;
    }
    if (rear !== e.rear) logOutcome(sc, { eventId: e.eventId, tick: w.tick, kind: 'accident.move', applied: true, note: `moved to s=${rear.toFixed(2)} after edit` });
    e.rear = rear;
    e.len = len;
    others.push({ rear, len });
    placed.set(lane, others);
  }
  compose(w);
}

/** The single path that changes running sim state for an experiment input (ADR 0010 §2). */
export function applyScenarioInput(w: World, input: ScenarioInput): void {
  const sc = w.sc!;
  const t = input.target;
  const p = input.params;
  const seg = t.segmentId !== undefined ? w.graph.segments.get(t.segmentId) : undefined;
  switch (input.kind) {
    case 'closure.start': {
      if (!seg || (t.lane !== undefined && seg.lanes[t.lane] === undefined)) return log(w, input, false, 'target gone');
      const e: ClosureEffect = {
        kind: 'closure',
        eventId: input.eventId,
        segmentId: seg.id,
        lane: t.lane ?? -1,
        startTick: w.tick,
        endTick: p.durationTicks !== undefined ? w.tick + p.durationTicks : Infinity,
      };
      sc.effects.push(e);
      compose(w);
      log(w, input, true);
      const where = segmentTarget(w, e.segmentId);
      if (observeInput(w, { eventId: e.eventId, kind: 'closure', segmentId: e.segmentId, lane: e.lane, buildingId: null }, where, `도로 통제 인지: ${placeText(where, e.segmentId)}`, `${e.eventId} · 통제는 즉시 인지`)) enqueueAffected(w, effectLanes(w, e), false, e.eventId);
      return;
    }
    case 'accident.start': {
      const lane = seg ? seg.lanes[t.lane!] : undefined;
      if (!seg || lane === undefined) return log(w, input, false, 'target gone');
      const len = p.length ?? ACCIDENT_LENGTH;
      const L = w.net.len[lane]!;
      const rear = placeObstacle(w, lane, t.s ?? (L - len) / 2, len, sc.obs?.[lane] ?? []);
      if (rear === null) return log(w, input, false, 'no room on lane');
      const e: AccidentEffect = {
        kind: 'accident',
        eventId: input.eventId,
        segmentId: seg.id,
        lane: t.lane!,
        laneId: w.graph.lanes[lane]!.id,
        rear,
        len,
        startTick: w.tick,
        endTick: w.tick + (p.durationTicks ?? ACCIDENT_TICKS),
        known: detectionOf(sc.policy) === 'legacy',
        onSite: detectionOf(sc.policy) !== 'legacy',
        seen: new Set(),
        stuck: new Set(),
      };
      sc.effects.push(e);
      compose(w);
      log(w, input, true, rear !== t.s && t.s !== undefined ? `moved to s=${rear.toFixed(2)}` : undefined);
      // ADR 0013 §2: the obstacle is physical from now; costs and re-route notices wait for detection.
      if (!e.known) trackAccident(w, e.eventId, e.laneId, rear + len / 2);
      else {
        const where = segmentTarget(w, e.segmentId);
        if (observeInput(w, { eventId: e.eventId, kind: 'accident', segmentId: e.segmentId, lane: e.lane, buildingId: null }, where, `사고 인지: ${placeText(where, e.segmentId)} ${e.lane + 1}차선`, `${e.eventId} · 즉시 인지 (감지 모드 legacy)`)) enqueueAffected(w, [lane], false, e.eventId);
        else {
          // Over the observe budget: physical at once, known (router cost, notices) next tick.
          e.known = false;
          compose(w);
        }
      }
      return;
    }
    case 'closure.end':
    case 'accident.end': {
      const kind = input.kind === 'closure.end' ? 'closure' : 'accident';
      const lane = t.lane ?? -1;
      const e =
        t.eventId !== undefined
          ? sc.effects.find((x) => x.kind === kind && x.eventId === t.eventId)
          : sc.effects.find((x) => x.kind === kind && x.segmentId === t.segmentId && x.lane === lane);
      if (!e) return log(w, input, false, t.eventId !== undefined ? `event ${t.eventId} not active (unknown, not started yet or already ended)` : 'no active event on target');
      endEffect(w, e, input.eventId);
      log(w, input, true);
      return;
    }
    case 'surge.start': {
      const n = generateSurge(w, input);
      log(w, input, n > 0, n > 0 ? `${n} trips` : 'no origin');
      const where = buildingTarget(w, t.buildingId!);
      if (n > 0) observeInput(w, { eventId: input.eventId, kind: 'surge', segmentId: null, lane: -1, buildingId: t.buildingId! }, where, `수요 급증 인지: ${placeText(where, t.buildingId!)}`, `${input.eventId} · 행사 ${n}통행 (사전 공지된 계획)`);
      return;
    }
    case 'fire.start':
    case 'medical.start': {
      const id = t.buildingId!;
      if (!w.doc.buildings[id]) return log(w, input, false, 'target gone');
      if (input.kind === 'fire.start') {
        if (sc.damaged.includes(id)) return log(w, input, false, 'building damaged');
        if (sc.incidents.some((x) => x.kind === 'fire' && x.buildingId === id)) return log(w, input, false, 'fire already active');
      }
      log(w, input, true);
      startIncident(w, input);
      return;
    }
    case 'fire.end':
    case 'medical.end': {
      const why = endIncident(w, input);
      if (why !== null) return log(w, input, false, why);
      log(w, input, true);
      return;
    }
    case 'blackout.start': {
      const why = startBlackout(w, input);
      log(w, input, why === null, why ?? undefined);
      const where = t.buildingId !== undefined ? buildingTarget(w, t.buildingId) : { kind: 'point' as const, id: input.eventId, name: '구역', x: p.x!, z: p.z! };
      if (why === null) observeInput(w, { eventId: input.eventId, kind: 'blackout', segmentId: null, lane: -1, buildingId: t.buildingId ?? null }, where, `정전 인지: ${placeText(where, input.eventId)}`, `${input.eventId} · 정전은 즉시 인지`);
      return;
    }
    case 'blackout.end': {
      const b = findBlackout(w, input);
      if (!b) return log(w, input, false, t.eventId !== undefined ? `event ${t.eventId} not active (unknown, not started yet or already ended)` : 'no active event on target');
      endBlackout(w, b, input.eventId);
      log(w, input, true);
      return;
    }
    case 'policy.set':
      // Applies to events from now on (no retroactive re-route); pre-emption and batteries follow at once (per tick).
      sc.policy = {
        reroute: p.reroute === 1,
        informedShare: p.informedShare!,
        ...(p.preempt !== undefined ? { preempt: p.preempt === 1 } : {}),
        ...(p.battery !== undefined ? { battery: p.battery === 1 } : {}),
        ...(p.detection !== undefined ? { detection: DETECTION_MODES[p.detection]! } : {}),
      };
      log(w, input, true);
      return;
  }
}
