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

export type ToolId = 'select' | 'road' | 'building' | 'bulldoze' | 'busLine' | 'closure' | 'parcel';
/** Snap resolution in meters; 0 = off. Personal UI state, never stored in the doc. */
export type SnapStep = 0 | 1 | 2 | 4 | 8;
export type SimSpeed = 0 | 1 | 2 | 4;
export type Connection = 'connecting' | 'online' | 'reconnecting' | 'offline';
export type PanelId = 'inspector' | 'roadTypes' | 'buildings' | 'vehicles' | 'busLines';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'segment'; id: string }
  | { kind: 'building'; id: string }
  | { kind: 'busStop'; id: string }
  | { kind: 'parcel'; id: string };

export interface ToolOptions {
  roadTypeId: string;
  curve: boolean;
  /** Shared by every placing tool and by moves (G cycles it). */
  snapStep: SnapStep;
  buildingTypeId: string;
  /** Extra rotation for free building placement, radians. */
  buildingRotation: number;
  parcelZone: ParcelZone;
  /** Parcel tool: click a polygon instead of dragging a rectangle (P toggles). */
  parcelPolygon: boolean;
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
  [/conflict: the design was changed/, '다른 사용자가 이 설계를 먼저 바꿨습니다'],
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
    tool: 'select',
    toolOptions: { roadTypeId: 'road-2', curve: false, snapStep: 8, buildingTypeId: 'house', buildingRotation: 0, parcelZone: 'residential', parcelPolygon: false },
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
    this.set({ connection: next, pending: [], peers: [], presence: {} });
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
        });
        for (const l of this.resetListeners) l(doc);
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
        return;
      }
      case 'rejected': {
        const p = s.pending.find((x) => x.ref === msg.ref);
        const flashes = p && p.ghost.length ? [...s.flashes, { id: this.nextId++, ghost: p.ghost, until: this.now() + FLASH_MS }] : s.flashes;
        this.set({ pending: s.pending.filter((x) => x.ref !== msg.ref), results: withResult(s.results, msg.ref, msg.error), flashes });
        this.toast(`거부됨: ${translateError(msg.error)}`, 'error');
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
      case 'pong':
        return;
    }
  }
}

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
