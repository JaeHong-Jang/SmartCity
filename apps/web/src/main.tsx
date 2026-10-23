// Bootstrap: store → transport (server, or offline solo fallback) → sim worker → renderer → tools → React HUD.

import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { ROOM_ID_RE } from '@smartcity/shared';
import { createDispatcher } from './app/dispatch';
import { resumeImport } from './app/importExport';
import { ClientStore } from './app/store';
import { LocalTransport } from './net/localTransport';
import type { Transport } from './net/transport';
import { WsTransport } from './net/wsTransport';
import { CityRenderer } from './render/CityRenderer';
import { WorkerSimStream } from './sim/simStream';
import { ToolController } from './tools/controller';
import { App } from './ui/App';
import { ServicesContext, type AppServices } from './ui/context';
import './ui/styles.css';

const CONNECT_TIMEOUT_MS = 1500;
const WELCOME_TIMEOUT_MS = 8000;
const NAME_KEY = 'smartcity:name';

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
const dispatcher = createDispatcher(store, () => transport);

// Simulation worker follows the same applied command stream as the main doc.
const sim = new WorkerSimStream();
sim.onStatus((status, error) => store.set({ simStatus: status, simError: error ?? null }));
store.onReset((doc) => {
  store.set({ simStatus: 'starting', simError: null, simStats: null });
  sim.init(doc);
});
store.onApplied((cmd) => sim.command(cmd));
let lastSpeed = store.getState().simSpeed;
sim.setSpeed(lastSpeed);
store.subscribe(() => {
  const s = store.getState().simSpeed;
  if (s !== lastSpeed) {
    lastSpeed = s;
    sim.setSpeed(s);
  }
});
let lastStatsAt = 0;
sim.subscribe((snap) => {
  const now = performance.now();
  if (now - lastStatsAt < 250) return;
  lastStatsAt = now;
  store.set({ simStats: { ...snap.stats } });
});

function attach(t: Transport): void {
  t.onMessage((m) => {
    const wasReady = store.getState().ready;
    store.receive(m);
    if (m.t === 'welcome' && !wasReady && storage) resumeImport(store, dispatcher, sessionStorage);
  });
  store.onResyncNeeded = () => t.reconnect();
}

function goOffline(): void {
  transport?.close();
  const local = new LocalTransport(room, storage, () => store.getState().name);
  transport = local;
  store.set({ connection: 'offline' });
  attach(local);
  local.connect();
  store.toast('서버에 연결할 수 없어 오프라인(단독 모드)으로 시작합니다', 'info');
  window.addEventListener('beforeunload', () => local.close());
}

const ws = new WsTransport(WsTransport.defaultUrl(), room, () => store.getState().name);
if (params.get('offline') === '1') {
  goOffline();
} else {
  transport = ws;
  attach(ws);
  let opened = false;
  ws.onStatus((st) => {
    const s = store.getState();
    if (transport !== ws) return;
    if (st === 'open') opened = true;
    // Never reached the server: solo mode right away. A socket that did open proves the server
    // is up (e.g. it closed us for a late hello while the page was busy), so let the transport retry.
    if (st === 'closed' && !s.ready && !opened) goOffline();
    else if (st === 'closed' && s.ready) store.connectionLost('reconnecting');
    else if (st === 'connecting' && s.ready) store.set({ connection: 'reconnecting' });
  });
  ws.connect();
  // No socket within the window (or an open socket that never sends welcome): go solo.
  // A timer that fires late means the page was busy (first shader compile), not that the
  // server is unreachable, so the window is re-armed instead.
  const armTimer = (ms: number, waiting: () => boolean): void => {
    const due = performance.now() + ms;
    setTimeout(() => {
      if (transport !== ws || store.getState().ready || !waiting()) return;
      if (performance.now() - due > 250) armTimer(ms, waiting);
      else goOffline();
    }, ms);
  };
  armTimer(CONNECT_TIMEOUT_MS, () => !opened);
  armTimer(WELCOME_TIMEOUT_MS, () => true);
}

// Renderer + tools.
const viewport = document.getElementById('viewport')!;
const labels = document.getElementById('labels')!;
const renderer = new CityRenderer(viewport, labels, store, sim);
new ToolController(
  store,
  dispatcher,
  renderer.renderer.domElement,
  renderer.pickGround,
  (p) => renderer.setPreview(p),
  (presence) => transport?.send({ t: 'presence', presence }),
  { pan: renderer.groundPan, focus: (p) => renderer.focus(p), cursor: (p) => renderer.setCursor(p) },
);

const services: AppServices = {
  store,
  dispatcher,
  focus: (p) => renderer.focus(p),
  setName(n: string) {
    const v = n.trim().slice(0, 32);
    if (!v) return;
    storage?.setItem(NAME_KEY, v);
    store.set({ name: v });
    // The server learns names from `hello`: rejoin so collaborators see the new one.
    if (transport === ws && store.getState().connection === 'online') transport.reconnect();
    store.toast(`이름을 '${v}'(으)로 바꿨습니다`, 'success');
  },
};

if (import.meta.env.DEV) {
  // Test/debug hook (dev server only): state access and world → client pixel projection.
  const v = new THREE.Vector3();
  (window as unknown as { __smartcity: unknown }).__smartcity = {
    store,
    renderer,
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
