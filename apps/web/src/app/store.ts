// ClientStore: small external store read by React (useSyncExternalStore), tools and renderers.
// The confirmed doc only changes through server-ordered `applied` commands (ADR 0001).

import {
  applyCommand,
  cloneJson,
  createEmptyDoc,
  normalizeDoc,
  type CityDoc,
  type Command,
  type ParcelZone,
  type Peer,
  type Presence,
  type ServerMessage,
  type Vec2,
} from '@smartcity/shared';
import type { SimStats } from '@smartcity/sim';
import { initialAi, reduceAi, type AiEvent, type AiState } from './aiChat';
import { addHighlight, highlightFromBatch, initialHighlights, type Highlight, type HighlightState } from './highlights';
import type { ProposalStatus } from './proposal';
import type { TransitSummary } from './transit';

export type ToolId = 'select' | 'road' | 'building' | 'bulldoze' | 'busLine' | 'closure' | 'parcel' | 'street' | 'zoning';
/** Traffic facility tool sub-modes (교통 시설). */
export type StreetMode = 'crosswalk' | 'signalCrosswalk' | 'speedBump' | 'schoolZone' | 'remove';
/** Snap resolution in meters; 0 = off. Personal UI state, never stored in the doc. */
export type SnapStep = 0 | 1 | 2 | 4 | 8;
export type SimSpeed = 0 | 1 | 2 | 4;
export type Connection = 'connecting' | 'online' | 'reconnecting' | 'offline';
export type PanelId = 'inspector' | 'roadTypes' | 'buildings' | 'vehicles' | 'busLines' | 'ai';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'segment'; id: string }
  | { kind: 'building'; id: string }
  | { kind: 'busStop'; id: string }
  | { kind: 'parcel'; id: string };

export interface ToolOptions {
  roadTypeId: string;
  curve: boolean;
  /** Road tool: round the corners of a newly drawn road automatically (ADR 0012 §1; remembered per browser). */
  autoFillet: boolean;
  /** Shared by every placing tool and by moves (G cycles it). */
  snapStep: SnapStep;
  buildingTypeId: string;
  /** Extra rotation for free building placement, radians. */
  buildingRotation: number;
  parcelZone: ParcelZone;
  /** Parcel tool: click a polygon instead of dragging a rectangle (P toggles). */
  parcelPolygon: boolean;
  streetMode: StreetMode;
  /** Zoning tool: the use painted along roads, lot depth in 8 m cells, and erase mode. */
  zoningZone: 'residential' | 'commercial' | 'office';
  zoningDepth: 1 | 2 | 3 | 4;
  zoningErase: boolean;
}

export interface PendingEntry {
  ref: number;
  cmd: Command;
  /** Polylines previewing what was sent; kept as a pulsing ghost until the server answers. */
  ghost: Vec2[][];
  sentAt: number;
}

export interface Flash {
  id: number;
  ghost: Vec2[][];
  until: number;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  until: number;
  key?: string;
}

export interface Overlays {
  flow: boolean;
  shadows: boolean;
  /** Regulation violation badges on buildings and parcels. */
  violations: boolean;
}

/** Waiting for the server before the first welcome (drives the full-screen connect overlay). */
export interface ConnectWait {
  /** Attempt number of the transport (1 = first). */
  attempt: number;
  /** Epoch ms of the next automatic attempt, null while one is running. */
  retryAt: number | null;
  /** Refusal the server sent for this room (e.g. its city file cannot be read). */
  error: string | null;
}

/** A city this browser saved in offline solo mode under the same room name, differing from the server's. */
export interface OfflineCityNote {
  buildings: number;
  roads: number;
  savedAt: number | null;
  /** `seq:savedAt` of that save; closing the notice remembers it for this tab. */
  seen: string;
  /** Why the save cannot be read (null = readable); it can still be exported raw. */
  unreadable: string | null;
}

export interface RenderStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface ClientState {
  doc: CityDoc;
  /** Increments on every confirmed doc change (React components key off this). */
  docVersion: number;
  seq: number;
  room: string;
  name: string;
  clientId: string | null;
  tag: string;
  color: string;
  connection: Connection;
  /** True once the first welcome arrived. */
  ready: boolean;
  /** Non-null while the server has not answered in time: the connect overlay is shown (cleared by welcome). */
  connectWait: ConnectWait | null;
  /** Shown as a dismissible notice after joining a server room (null = none). */
  offlineCity: OfflineCityNote | null;
  /** Offline solo mode was asked for but the stored city cannot be read: it is not opened (reason). */
  offlineError: string | null;
  tool: ToolId;
  toolOptions: ToolOptions;
  /** Short status text from the active tool (length, angle, errors). */
  toolHint: string;
  selection: Selection | null;
  /** Approaches of the signal phase being edited, drawn as arrows. */
  phaseHighlight: { nodeId: string; approaches: string[] } | null;
  peers: Peer[];
  presence: Record<string, Presence>;
  pending: PendingEntry[];
  /** Outcome of our recent commands by ref: 'ok' or the server's error (bounded to the last 100). */
  results: Record<number, string>;
  flashes: Flash[];
  toasts: Toast[];
  simSpeed: SimSpeed;
  simStatus: 'starting' | 'ready' | 'error';
  simError: string | null;
  simStats: SimStats | null;
  /** Bus passengers and stop queues from the latest snapshot (null until the sim runs). */
  transit: TransitSummary | null;
  /** Parcel under the select tool's cursor (its label shows even for automatic lots). */
  hoverParcelId: string | null;
  /** AI building assistant: chat, running request and the proposal being reviewed (ADR 0009 §5). */
  ai: AiState;
  /** Dry-run result of the shown proposal against the current doc (null = no proposal). */
  proposalStatus: ProposalStatus | null;
  /** Things the AI recently built: pulse, beacon and the "최근 적용" list (not part of the doc). */
  highlights: HighlightState;
  /** AI batches dispatched and not answered yet, by dispatch ref (resolved here so a panel switch cannot lose them). */
  aiApplies: Record<number, { batch: Command; summary: string; reqId: number }>;
  /** reqId of the AI proposal being applied right now (null = none); survives panel switches. */
  aiApplying: number | null;
  /** Per proposal reqId: commands sent whose answer is not known yet (apply stays blocked meanwhile). */
  aiPending: Record<number, number>;
  /** Bumped when the connection is lost or the doc is replaced: waiters of the old session give up. */
  session: number;
  overlays: Overlays;
  panel: PanelId | null;
  render: RenderStats;
}

type Listener = () => void;
export type AppliedListener = (cmd: Command, seq: number) => void;
export type ResetListener = (doc: CityDoc) => void;

const FLASH_MS = 900;
const TOAST_MS = 4000;

/** Korean wording for the most common applyCommand errors; anything else is shown verbatim. */
const ERROR_KO: [RegExp, string][] = [
  [/segment shorter than/, '도로가 너무 짧습니다'],
  [/nodes already connected/, '이미 연결된 지점입니다'],
  [/unknown segment/, '도로가 이미 바뀌었습니다. 다시 시도하세요'],
  [/unknown node/, '교차점이 이미 바뀌었습니다. 다시 시도하세요'],
  [/building type in use/, '이 타입의 건물이 남아 있습니다'],
  [/vehicle type in use/, '버스 노선이 이 차량 타입을 사용 중입니다'],
  [/rate limited/, '요청이 너무 많습니다. 잠시 후 다시 시도하세요'],
  [/out of range/, '허용 범위를 벗어난 값입니다'],
  [/no lanes in that direction/, '그 방향에는 차선이 없습니다'],
  [/a line needs/, '노선에는 정류장이 2개 이상 필요합니다'],
  [/building overlaps a road/, '건물이 도로와 겹칩니다'],
  [/building extends beyond the map/, '건물이 지도 경계를 벗어납니다'],
  [/the moved road would cross another road/, '옮긴 도로가 다른 도로와 교차합니다'],
  [/parcels overlap/, '다른 필지와 겹칩니다'],
  [/parcel smaller than/, '필지가 너무 작습니다 (16㎡ 미만)'],
  [/parcel\.polygon must be a simple polygon/, '필지 경계가 스스로 교차합니다'],
  [/unknown building/, '건물이 이미 바뀌었습니다. 다시 시도하세요'],
  [/unknown parcel/, '필지가 이미 바뀌었습니다. 다시 시도하세요'],
  [/road features must be at least/, '구간 끝에서 12m 이상 떨어져야 합니다'],
  [/too close to another road feature/, '다른 시설과 6m 이상 떨어져야 합니다'],
  [/crosswalks need a road with sidewalks/, '횡단보도는 보도가 있는 도로에만 놓을 수 있습니다'],
  [/too many road features/, '시설이 너무 많습니다'],
  [/unknown road feature/, '시설이 이미 바뀌었습니다. 다시 시도하세요'],
  [/crosswalk leg is not connected/, '이 교차로에 연결되지 않은 도로입니다'],
  [/conflict: the design was changed/, '다른 사용자가 이 설계를 먼저 바꿨습니다'],
  [/overlaps another building/, '다른 건물과 겹칩니다'],
  [/parcel exists/, '같은 이름의 필지가 이미 있습니다'],
  [/building exists/, '같은 이름의 건물이 이미 있습니다'],
  [/a pedestrian-only phase needs/, '보행 전용 신호 조건(신호 교차로, 3~4갈래, 횡단보도 2곳 이상)을 만족하지 않습니다'],
  [/unknown frontage segment/, '필지가 접한 도로가 없습니다'],
  [/cannot round the corner: the corner must join exactly two roads/, '도로 두 개가 만나는 꺾임만 둥글게 할 수 있습니다'],
  [/cannot round the corner: only straight roads/, '직선 도로끼리의 꺾임만 둥글게 할 수 있습니다'],
  [/cannot round the corner: the two roads differ in type/, '두 도로의 종류가 다릅니다'],
  [/cannot round the corner: the two roads differ in school zone/, '한쪽만 어린이보호구역입니다'],
  [/cannot round the corner: the roads run in opposite directions/, '두 도로의 진행 방향이 맞지 않습니다'],
  [/cannot round the corner: the junction has its own control settings/, '교차점에 신호 설정이 있습니다'],
  [/cannot round the corner: the corner is almost straight/, '거의 직선이라 둥글게 할 꺾임이 없습니다'],
  [/cannot round the corner: the turn is too sharp/, '꺾임이 너무 급합니다 (150° 초과)'],
  [/cannot round the corner: not enough room/, '도로가 짧아 최소 반경의 곡선이 들어가지 않습니다'],
  [/cannot round the corner: degenerate corner/, '꺾임 형상이 올바르지 않습니다'],
  [/cannot round the corner: a road is closed/, '폐쇄된 도로가 있습니다'],
  [/cannot round the corner: a bus stop is in the corner/, '모서리 구간에 버스 정류장이 있습니다'],
  [/cannot round the corner: a bus line serves the roads/, '버스 노선이 이 도로를 지납니다'],
  [/cannot round the corner: a crosswalk is in the corner/, '모서리 구간에 횡단보도가 있습니다'],
  [/cannot round the corner: a speed bump is in the corner/, '모서리 구간에 과속방지턱이 있습니다'],
  [/cannot round the corner: a lot faces the corner/, '모서리에 접한 필지가 있습니다'],
  [/cannot round the corner: the curve would cross a building/, '곡선이 건물과 겹칩니다'],
  [/cannot round the corner: the curve would cross a zoned lot/, '곡선이 자동 필지와 겹칩니다'],
  [/cannot round the corner: the curve would cross another road/, '곡선이 다른 도로와 교차합니다'],
  [/cannot round the corner: the corner changed since it was planned/, '다른 사용자가 이 모서리를 먼저 바꿨습니다. 다시 시도하세요'],
  [/fillet radius out of range/, '반경이 허용 범위를 벗어났습니다'],
];

function withResult(results: Record<number, string>, ref: number, outcome: string): Record<number, string> {
  const next: Record<number, string> = { ...results, [ref]: outcome };
  const refs = Object.keys(next).map(Number);
  if (refs.length > 100) for (const r of refs.sort((a, b) => a - b).slice(0, refs.length - 100)) delete next[r];
  return next;
}

export function translateError(error: string): string {
  for (const [re, ko] of ERROR_KO) if (re.test(error)) return ko;
  return error;
}

export function initialState(room: string, name: string): ClientState {
  const doc = createEmptyDoc();
  return {
    doc,
    docVersion: 0,
    seq: 0,
    room,
    name,
    clientId: null,
    tag: '',
    color: '#38bdf8',
    connection: 'connecting',
    ready: false,
    connectWait: null,
    offlineCity: null,
    offlineError: null,
    tool: 'select',
    toolOptions: { roadTypeId: 'road-2', curve: false, autoFillet: true, snapStep: 8, buildingTypeId: 'house', buildingRotation: 0, parcelZone: 'residential', parcelPolygon: false, streetMode: 'crosswalk', zoningZone: 'residential', zoningDepth: 2, zoningErase: false },
    toolHint: '',
    selection: null,
    phaseHighlight: null,
    peers: [],
    presence: {},
    pending: [],
    results: {},
    flashes: [],
    toasts: [],
    simSpeed: 1,
    simStatus: 'starting',
    simError: null,
    simStats: null,
    transit: null,
    hoverParcelId: null,
    ai: initialAi(),
    proposalStatus: null,
    highlights: initialHighlights(),
    aiApplies: {},
    aiApplying: null,
    aiPending: {},
    session: 0,
    overlays: { flow: false, shadows: true, violations: true },
    panel: 'inspector',
    render: { fps: 0, drawCalls: 0, triangles: 0 },
  };
}

export class ClientStore {
  private state: ClientState;
  private listeners = new Set<Listener>();
  private appliedListeners = new Set<AppliedListener>();
  private resetListeners = new Set<ResetListener>();
  private nextId = 1;
  /** Called when a seq gap is detected; the transport reconnects to get a fresh snapshot. */
  onResyncNeeded: (() => void) | null = null;
  /** Called with the highlight of an AI batch that was just applied (the app flies the camera there). */
  onAiHighlight: ((h: Highlight) => void) | null = null;
  /** In-flight proposal applies by reqId: a second apply of the same proposal joins the first (see proposalApply). */
  readonly aiApplyJobs = new Map<number, Promise<unknown>>();
  private readonly aiPendingRefs = new Map<number, { cmd: Command; summary: string; reqId: number; late: boolean }>();

  constructor(room: string, name: string, private readonly now: () => number = () => Date.now()) {
    this.state = initialState(room, name);
  }

  getState = (): ClientState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onApplied(l: AppliedListener): () => void {
    this.appliedListeners.add(l);
    return () => this.appliedListeners.delete(l);
  }

  onReset(l: ResetListener): () => void {
    this.resetListeners.add(l);
    return () => this.resetListeners.delete(l);
  }

  set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setToolOptions(patch: Partial<ToolOptions>): void {
    this.set({ toolOptions: { ...this.state.toolOptions, ...patch } });
  }

  /** `key`: a later toast with the same key replaces the earlier one instead of stacking. */
  toast(text: string, kind: Toast['kind'] = 'info', key?: string): void {
    const t: Toast = { id: this.nextId++, kind, text, until: this.now() + TOAST_MS, key };
    const rest = key ? this.state.toasts.filter((x) => x.key !== key) : this.state.toasts;
    this.set({ toasts: [...rest.slice(-4), t] });
  }

  addPending(entry: PendingEntry): void {
    this.set({ pending: [...this.state.pending, entry] });
  }

  /** Drop expired toasts and flashes. Cheap no-op when nothing expired. */
  expire(): void {
    const t = this.now();
    const s = this.state;
    if (s.toasts.some((x) => x.until <= t) || s.flashes.some((x) => x.until <= t)) {
      this.set({ toasts: s.toasts.filter((x) => x.until > t), flashes: s.flashes.filter((x) => x.until > t) });
    }
  }

  /** Connection lost: pending commands have unknown outcome (ADR 0001). */
  connectionLost(next: Connection): void {
    const n = this.state.pending.length;
    const released = this.releaseAiPending();
    this.set({ connection: next, pending: [], peers: [], presence: {}, session: this.state.session + 1 });
    if (released > 0) this.toast(AI_UNKNOWN, 'error');
    if (n > 0) this.toast(`연결이 끊겨 전송 중이던 편집 ${n}건의 결과를 알 수 없습니다`, 'error');
  }

  receive(msg: ServerMessage): void {
    const s = this.state;
    switch (msg.t) {
      case 'welcome': {
        const doc = normalizeDoc(cloneJson(msg.doc));
        const resync = s.ready;
        this.set({
          doc,
          seq: msg.seq,
          docVersion: s.docVersion + 1,
          clientId: msg.clientId,
          tag: msg.tag,
          color: msg.color,
          room: msg.room,
          peers: msg.peers,
          presence: {},
          pending: [],
          selection: null,
          connection: s.connection === 'offline' ? 'offline' : 'online',
          ready: true,
          connectWait: null,
          session: s.session + 1,
        });
        for (const l of this.resetListeners) l(doc);
        if (this.releaseAiPending() > 0) this.toast(AI_UNKNOWN, 'error');
        if (resync) this.toast('서버와 다시 동기화했습니다', 'info');
        return;
      }
      case 'applied': {
        if (msg.seq <= s.seq) return;
        if (msg.seq > s.seq + 1) {
          this.onResyncNeeded?.();
          return;
        }
        // Already accepted by the sequencer: skip policy checks that may have changed since (ADR 0007).
        const res = applyCommand(s.doc, msg.cmd, { trusted: true });
        if (!res.ok) {
          // The server applied it, so our doc diverged: resync.
          this.onResyncNeeded?.();
          return;
        }
        const mine = msg.ref !== undefined && msg.by === s.clientId;
        const pending = mine ? s.pending.filter((p) => p.ref !== msg.ref) : s.pending;
        const results = mine ? withResult(s.results, msg.ref!, 'ok') : s.results;
        const selection = s.selection && !selectionExists(s.doc, s.selection) ? null : s.selection;
        this.set({ seq: msg.seq, docVersion: s.docVersion + 1, pending, results, selection });
        for (const l of this.appliedListeners) l(msg.cmd, msg.seq);
        if (mine) {
          this.settleAiPending(msg.ref!, 'ok');
          this.resolveAiApply(msg.ref!, 'ok');
        }
        return;
      }
      case 'rejected': {
        const p = s.pending.find((x) => x.ref === msg.ref);
        const flashes = p && p.ghost.length ? [...s.flashes, { id: this.nextId++, ghost: p.ghost, until: this.now() + FLASH_MS }] : s.flashes;
        this.set({ pending: s.pending.filter((x) => x.ref !== msg.ref), results: withResult(s.results, msg.ref, msg.error), flashes });
        this.toast(`거부됨: ${translateError(msg.error)}`, 'error');
        this.settleAiPending(msg.ref, msg.error);
        this.resolveAiApply(msg.ref, msg.error);
        return;
      }
      case 'peers': {
        const ids = new Set(msg.peers.map((p) => p.clientId));
        const presence: Record<string, Presence> = {};
        for (const [k, v] of Object.entries(s.presence)) if (ids.has(k)) presence[k] = v;
        this.set({ peers: msg.peers, presence });
        return;
      }
      case 'presence':
        if (msg.clientId === s.clientId) return;
        this.set({ presence: { ...s.presence, [msg.clientId]: msg.presence } });
        return;
      case 'error':
        this.toast(`서버 오류: ${msg.error}`, 'error');
        return;
      case 'ai.status':
      case 'ai.progress':
      case 'ai.proposal':
      case 'ai.error':
        this.aiEvent({ kind: 'server', msg });
        return;
      case 'pong':
        return;
    }
  }

  /** Remember an AI batch sent as `ref`; when it is applied the highlight is created even if no panel is open. */
  trackAiApply(ref: number, batch: Command, summary: string, reqId: number): void {
    this.set({ aiApplies: { ...this.state.aiApplies, [ref]: { batch, summary, reqId } } });
    const done = this.state.results[ref];
    if (done !== undefined) this.resolveAiApply(ref, done);
  }

  private resolveAiApply(ref: number, outcome: string): void {
    const rec = this.state.aiApplies[ref];
    if (!rec) return;
    const { [ref]: _done, ...rest } = this.state.aiApplies;
    this.set({ aiApplies: rest });
    if (outcome !== 'ok') return;
    this.recordAiApplied(rec.batch, rec.summary, rec.reqId);
  }

  /** A command of proposal `reqId` was sent as `ref`: until it is answered the proposal cannot be applied again. */
  trackAiPending(ref: number, cmd: Command, reqId: number, summary: string): void {
    // A synchronous transport may have answered before the ref was registered: nothing is pending then.
    if (this.state.results[ref] !== undefined) return;
    this.aiPendingRefs.set(ref, { cmd, summary, reqId, late: false });
    this.set({ aiPending: { ...this.state.aiPending, [reqId]: (this.state.aiPending[reqId] ?? 0) + 1 } });
  }

  /** The apply stopped waiting for `ref`: if its answer is `ok` later, that answer records the highlight. */
  markAiLate(ref: number): void {
    const rec = this.aiPendingRefs.get(ref);
    if (rec) rec.late = true;
  }

  /** Called in the same synchronous step that processes the answer, so a later session change cannot lose it. */
  private settleAiPending(ref: number, outcome: string): void {
    const rec = this.aiPendingRefs.get(ref);
    if (!rec) return;
    this.aiPendingRefs.delete(ref);
    const { [rec.reqId]: n = 1, ...rest } = this.state.aiPending;
    this.set({ aiPending: n > 1 ? { ...rest, [rec.reqId]: n - 1 } : rest });
    if (rec.late && outcome === 'ok') this.recordAiApplied(rec.cmd, rec.summary, rec.reqId, 'AI 제안의 늦게 도착한 항목이 적용되었습니다 (되돌리려면 철거 도구로 지우세요)');
  }

  /** The session ended: unanswered refs are "unknown" (never inferred from the doc) and their guard is released. */
  private releaseAiPending(): number {
    const n = this.aiPendingRefs.size;
    this.aiPendingRefs.clear();
    if (Object.keys(this.state.aiPending).length) this.set({ aiPending: {} });
    return n;
  }

  /** An AI proposal (one batch, or several commands collected into one) was applied: highlight, camera, toast. */
  recordAiApplied(batch: Command, summary: string, reqId: number, toast = 'AI 제안을 적용했습니다 (되돌리려면 철거 도구로 지우세요)'): void {
    const s = this.state;
    const h = highlightFromBatch(batch, s.doc.buildingTypes, this.now(), 0, summary, s.doc);
    if (h) {
      const next = addHighlight(s.highlights, h);
      this.set({ highlights: next });
      this.onAiHighlight?.(next.items[next.items.length - 1]!);
    }
    // Only the proposal this batch came from: a newer one the user asked for meanwhile stays.
    if (this.state.ai.proposal?.reqId === reqId) this.aiEvent({ kind: 'discard' });
    this.toast(toast, 'success');
  }

  aiEvent(ev: AiEvent): void {
    this.set({ ai: reduceAi(this.state.ai, ev) });
  }
}

export const AI_UNKNOWN = '연결이 바뀌어 결과를 확인할 수 없습니다 — 도시를 확인하세요';

export function selectionExists(doc: CityDoc, sel: Selection): boolean {
  switch (sel.kind) {
    case 'node':
      return sel.id in doc.nodes;
    case 'segment':
      return sel.id in doc.segments;
    case 'building':
      return sel.id in doc.buildings;
    case 'busStop':
      return sel.id in doc.busStops;
    case 'parcel':
      return sel.id in doc.parcels;
  }
}
