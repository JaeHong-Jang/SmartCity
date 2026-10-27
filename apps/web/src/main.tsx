// Bootstrap: store → transport (server, or offline solo mode when asked for) → sim worker → renderer → tools → React HUD.

import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { buildingFootprints, ROOM_ID_RE } from '@smartcity/shared';
import { createDispatcher } from './app/dispatch';
import { resumeImport } from './app/importExport';
import { sameDisplayedStats } from './app/simStats';
import { watchProposal } from './app/proposalWatch';
import { sameTransit, summarizeTransit } from './app/transit';
import { ClientStore } from './app/store';
import { LocalTransport, offlineSeenKey, readOfflineSave } from './net/localTransport';
import type { Transport } from './net/transport';
import { WsTransport } from './net/wsTransport';
import { CityRenderer } from './render/CityRenderer';
import { WorkerSimStream } from './sim/simStream';
import { SimModeController } from './simmode/controller';
import { setSimModeController } from './simmode/instance';
import { installSimModeInput } from './simmode/input';
import { createFrozenView } from './simmode/frozenStore';
import { guardedSend } from './simmode/sendGuard';
import { simModeStore } from './simmode/store';
import { SwitchableStream } from './simmode/switchableStream';
import { ToolController } from './tools/controller';
import { App } from './ui/App';
import { ServicesContext, type AppServices } from './ui/context';
import './ui/styles.css';

const CONNECT_TIMEOUT_MS = 1500;
const WELCOME_TIMEOUT_MS = 8000;
const NAME_KEY = 'smartcity:name';
/** Invite password of a server that requires one (SC_INVITE_CODE), remembered for the next visits. */
const INVITE_KEY = 'smartcity:invite';

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = safeStorage();
const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') ?? 'main').toLowerCase();
const room = ROOM_ID_RE.test(roomParam) ? roomParam : 'main';
const name = storage?.getItem(NAME_KEY) || `시민${Math.floor(1000 + Math.random() * 9000)}`;
storage?.setItem(NAME_KEY, name);

const store = new ClientStore(room, name);
let transport: Transport | null = null;
const dispatcher = createDispatcher(store, () => transport, undefined, () => simMode.active);

// Simulation worker follows the same applied command stream as the main doc.
const sim = new WorkerSimStream();
sim.onStatus((status, error) => store.set({ simStatus: status, simError: error ?? null }));
store.onReset((doc) => {
  store.set({ simStatus: 'starting', simError: null, simStats: null });
  sim.init(doc);
});
store.onApplied((cmd) => sim.command(cmd));
// Simulator mode (ADR 0010): the renderer reads through `view`, which points at a private copy while active.
const view = new SwitchableStream(sim);
const frozen = createFrozenView(store);
let savedTool = store.getState().tool;
const simMode = new SimModeController({
  getDoc: () => store.getState().doc,
  getSeq: () => store.getState().seq,
  getDayTime: () => store.getState().simStats?.clock?.dayTime ?? null,
  getSpeed: () => store.getState().simSpeed,
  setMainSpeed: (speed) => sim.setSpeed(speed),
  setEditLock(locked) {
    if (locked) {
      savedTool = store.getState().tool;
      store.set({ tool: 'select' });
    } else {
      store.set({ tool: savedTool });
    }
  },
  setViewDoc: (doc) => (doc ? frozen.freeze(doc) : frozen.thaw()),
  createStream: () => new WorkerSimStream(),
  proxy: view,
  main: sim,
});
setSimModeController(simMode);
let lastSpeed = store.getState().simSpeed;
sim.setSpeed(lastSpeed);
store.subscribe(() => {
  const s = store.getState().simSpeed;
  if (s !== lastSpeed) {
    lastSpeed = s;
    simMode.routeSpeed(s);
  }
});
let lastStatsAt = 0;
sim.subscribe((snap) => {
  const now = performance.now();
  if (now - lastStatsAt < 250) return;
  lastStatsAt = now;
  if (!sameDisplayedStats(store.getState().simStats, snap.stats)) store.set({ simStats: { ...snap.stats } });
  const transit = summarizeTransit(snap, store.getState().doc);
  if (!sameTransit(store.getState().transit, transit)) store.set({ transit });
});

function attach(t: Transport): void {
  t.onMessage((m) => {
    const wasReady = store.getState().ready;
    store.receive(m);
    if (m.t === 'welcome' && !wasReady && storage) resumeImport(store, dispatcher, sessionStorage);
  });
  store.onResyncNeeded = () => t.reconnect();
}

// Offline solo mode only when asked for (?offline=1, or the overlay's button). A server room that
// cannot be reached waits behind the connect overlay instead: opening the browser's own city under
// the same room name looked like the server city had vanished (ADR 0011).
function goOffline(): void {
  const local = new LocalTransport(room, storage, () => store.getState().name);
  if (local.unreadable) {
    // Never open an empty city over a save we could not read: the first edit would replace it.
    store.set({ connection: 'offline', offlineError: local.unreadable.reason });
    return;
  }
  transport = local;
  store.set({ connection: 'offline' });
  attach(local);
  local.connect();
  window.addEventListener('beforeunload', () => local.close());
}

/** After joining the server room: point out a different offline city saved here under the same name. */
function noticeOfflineCity(): void {
  const local = readOfflineSave(storage, room);
  if (local.status === 'none') return;
  if (local.status === 'unreadable') {
    store.set({ offlineCity: { buildings: 0, roads: 0, savedAt: null, seen: '', unreadable: local.reason } });
    return;
  }
  const d = local.doc;
  const roads = Object.keys(d.segments).length;
  const buildings = Object.keys(d.buildings).length;
  if (!roads && !buildings && !Object.keys(d.nodes).length && !Object.keys(d.parcels).length) return;
  if (JSON.stringify(d) === JSON.stringify(store.getState().doc)) return;
  const seen = `${local.seq}:${local.savedAt ?? ''}`;
  try {
    if (sessionStorage.getItem(offlineSeenKey(room)) === seen) return;
  } catch {
    // No session storage: show it.
  }
  store.set({ offlineCity: { buildings, roads, savedAt: local.savedAt, seen, unreadable: null } });
}

let invite = storage?.getItem(INVITE_KEY) ?? null;
const ws = new WsTransport(WsTransport.defaultUrl(), room, () => store.getState().name, () => invite);
if (params.get('offline') === '1') {
  goOffline();
} else {
  transport = ws;
  attach(ws);
  let opened = false;
  const showWait = (): void => {
    const s = store.getState();
    if (s.ready) return;
    store.set({ connectWait: { attempt: Math.max(1, ws.attempts), retryAt: ws.retryAt, error: s.connectWait?.error ?? null, refresh: ws.outdated, auth: ws.authRefused } });
  };
  let noticed = false;
  ws.onMessage((m) => {
    if (m.t === 'welcome' && !noticed) {
      noticed = true;
      noticeOfflineCity();
    }
    // A refusal before welcome (e.g. unreadable city file) is shown on the overlay; the transport keeps
    // retrying. A protocol refusal (another app version) stops the transport and asks for a reload, also
    // in a tab that was already in the city (a reconnect to an upgraded server): the city stays shown,
    // editing stays blocked (connection 'reconnecting'). An invite refusal likewise waits for the password.
    if (m.t === 'error' && (!store.getState().ready || ws.outdated || ws.authRefused)) {
      store.set({ connectWait: { attempt: Math.max(1, ws.attempts), retryAt: ws.retryAt, error: m.error, refresh: ws.outdated, auth: ws.authRefused } });
    }
  });
  ws.onStatus((st) => {
    const s = store.getState();
    if (st === 'open') opened = true;
    // Before the first welcome: keep retrying behind the overlay. After it: reconnect, never go offline.
    if (!s.ready) {
      if (st === 'closed' || s.connectWait) showWait();
    } else if (st === 'closed') store.connectionLost('reconnecting');
    else if (st === 'connecting') store.set({ connection: 'reconnecting' });
  });
  ws.connect();
  // No socket within the window (or an open socket that never sends welcome): show the overlay.
  // (Retrying a hung attempt is the transport's own welcome deadline.) A timer that fires late
  // means the page was busy (first shader compile), not that the server is unreachable, so the
  // window is re-armed instead.
  const armTimer = (ms: number, waiting: () => boolean): void => {
    const due = performance.now() + ms;
    setTimeout(() => {
      if (store.getState().ready || !waiting()) return;
      if (performance.now() - due > 250) armTimer(ms, waiting);
      else showWait();
    }, ms);
  };
  armTimer(CONNECT_TIMEOUT_MS, () => !opened);
  armTimer(WELCOME_TIMEOUT_MS, () => true);
}

// Renderer + tools.
const viewport = document.getElementById('viewport')!;
const labels = document.getElementById('labels')!;
const renderer = new CityRenderer(viewport, labels, frozen.view, view);
renderer.scenario.setSource({
  graph: () => simMode.roadGraph(),
  surges(tick) {
    const doc = simMode.copyCityDoc();
    if (!doc) return [];
    return simModeStore
      .getState()
      .events.filter((e) => e.kind === 'surge' && e.status === 'ok' && tick >= e.startTick && (e.endTick === null || tick < e.endTick))
      .flatMap((e) => (e.buildingId && doc.buildings[e.buildingId] ? [doc.buildings[e.buildingId]!.pos] : []));
  },
});
renderer.emergency.setSource({
  building(id) {
    const doc = simMode.copyCityDoc();
    const b = doc?.buildings[id];
    const t = b && doc?.buildingTypes[b.typeId];
    if (!b || !t) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const poly of buildingFootprints(b, t)) {
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const h = Math.max(6, ...t.parts.map((p) => p.baseHeight + p.floors * p.floorHeight));
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ, h };
  },
  node: (id) => simMode.copyCityDoc()?.nodes[id]?.pos ?? null,
});
// Before the ToolController: while simulator mode is active the shared editing tools never see the left button.
installSimModeInput(renderer.renderer.domElement, simMode, renderer.pickGround, renderer.groundPan);
new ToolController(
  store,
  dispatcher,
  renderer.renderer.domElement,
  renderer.pickGround,
  (p) => renderer.setPreview(p),
  (presence) => transport?.send({ t: 'presence', presence }),
  { pan: renderer.groundPan, focus: (p) => renderer.focus(p), cursor: (p) => renderer.setCursor(p) },
);

watchProposal(store);
store.onAiHighlight = (h) => {
  if (h.bbox) renderer.fitBox(h.bbox);
};

const services: AppServices = {
  store,
  dispatcher,
  focus: (p) => renderer.focus(p),
  fit: (box) => renderer.fitBox(box),
  send: (msg) => guardedSend(msg, () => simMode.active, (m) => transport?.send(m), (text) => store.toast(text, 'error', 'simlock')),
  cameraTarget() {
    const t = renderer.cam.controls.getTarget(new THREE.Vector3());
    return { x: t.x, z: t.z };
  },
  setName(n: string) {
    const v = n.trim().slice(0, 32);
    if (!v) return;
    storage?.setItem(NAME_KEY, v);
    store.set({ name: v });
    // The server learns names from `hello`: rejoin so collaborators see the new one.
    if (transport === ws && store.getState().connection === 'online') transport.reconnect();
    store.toast(`이름을 '${v}'(으)로 바꿨습니다`, 'success');
  },
  retryConnect: () => ws.retryNow(),
  submitInvite(code: string) {
    const v = code.trim();
    if (!v || !ws.authRefused) return;
    invite = v;
    try {
      storage?.setItem(INVITE_KEY, v);
    } catch {
      // Not remembered: asked again on the next visit.
    }
    const cw = store.getState().connectWait;
    if (cw) store.set({ connectWait: { ...cw, error: null, auth: false } });
    ws.connect();
  },
};

if (import.meta.env.DEV) {
  // Test/debug hook (dev server only): state access and world → client pixel projection.
  const v = new THREE.Vector3();
  (window as unknown as { __smartcity: unknown }).__smartcity = {
    store,
    renderer,
    simmode: {
      controller: simMode,
      store: simModeStore,
      workers: () => simMode.liveWorkers(),
      /** Building count of the doc the renderer draws (frozen copy in simulator mode) and of the live doc. */
      drawnBuildings: () => Object.keys(frozen.view.getState().doc.buildings).length,
      liveBuildings: () => Object.keys(store.getState().doc.buildings).length,
      scene: () => renderer.scenario.stats(),
      emergency: () => renderer.emergency.stats(),
    },
    worldToScreen(x: number, z: number) {
      const rect = renderer.renderer.domElement.getBoundingClientRect();
      v.set(x, 0, z).project(renderer.cam.camera);
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    },
    lookAt(px: number, py: number, pz: number, tx: number, tz: number) {
      void renderer.cam.controls.setLookAt(px, py, pz, tx, 0, tz, false);
    },
    cameraTarget() {
      const t = renderer.cam.controls.getTarget(new THREE.Vector3());
      return { x: t.x, z: t.z };
    },
  };
}

createRoot(document.getElementById('root')!).render(
  <ServicesContext.Provider value={services}>
    <App />
  </ServicesContext.Provider>,
);
