// Scene assembly and render loop: lights, fog, optional shadows, ground, roads, buildings,
// vehicles, signals and overlays. Reads the store and sim stream; never mutates city state.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';
import { fitDistance, type Box } from '../app/highlights';
import type { ClientStore } from '../app/store';
import type { SimulationStream } from '../sim/simStream';
import type { GroundPan, ToolPreview } from '../tools/types';
import { BuildingLayer } from './buildings';
import { createCityCamera, type CityCamera } from './camera';
import { commandDomains, D_BUILDINGS, D_ROADS, D_VEHICLE_TYPES } from './dirty';
import { computeDayNight, createDayNightState, NOON } from './dayNight';
import { createGround, type Ground } from './ground';
import { HighlightLayer, type HighlightStats } from './highlight';
import { OverlayLayer } from './overlays';
import { PedestrianLayer } from './pedestrians';
import { buildRoadNetwork, type RoadNetworkGeom } from './roadNetwork';
import { RoadLayer, Y_WALK } from './roads';
import { ScenarioLayer } from './scenario';
import { configureRenderer, createSun } from './sceneKit';
import { PedSignalLayer, SignalLayer } from './signals';
import { VehicleLayer } from './vehicles';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const SUN_DISTANCE = 520;
const _sunOffset = new THREE.Vector3();
const _target = new THREE.Vector3();
const _panHit = new THREE.Vector3();

export class CityRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: CityCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private readonly dayNight = createDayNightState();
  private roads = new RoadLayer();
  private buildings = new BuildingLayer();
  private vehicles: VehicleLayer;
  private signals: SignalLayer;
  private pedestrians: PedestrianLayer;
  private pedSignals: PedSignalLayer;
  private overlays: OverlayLayer;
  private highlights = new HighlightLayer();
  readonly scenario: ScenarioLayer;
  private network: RoadNetworkGeom = { segments: new Map(), nodes: new Map(), crossings: [], graph: null };
  private dirty = { roads: true, buildings: true, vehicleTypes: true };
  private raf = 0;
  private last = performance.now();
  private frames = 0;
  private statAt = performance.now();
  private unsubs: (() => void)[] = [];
  private shadows = true;
  private width = 1;
  private height = 1;
  private resizeObserver: ResizeObserver;
  private ground: Ground;
  /** World point grabbed by a left-drag pan. */
  private panAnchor: THREE.Vector3 | null = null;

  constructor(
    private readonly container: HTMLElement,
    labelRoot: HTMLElement,
    private readonly store: ClientStore,
    private readonly stream: SimulationStream,
  ) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    configureRenderer(renderer);
    renderer.info.autoReset = false;
    renderer.domElement.className = 'city-canvas';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const sky = new THREE.Color('#aecbe0');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 1400, 5200);

    this.hemi = new THREE.HemisphereLight('#dbeafe', '#56603f', 1.25);
    this.scene.add(this.hemi);
    this.sun = createSun(2.2, 2048, 0.6);
    this.scene.add(this.sun, this.sun.target);

    const halfSize = store.getState().doc.meta.halfSize;
    this.ground = createGround(halfSize);
    this.scene.add(this.ground.group);
    this.cam = createCityCamera(renderer.domElement, halfSize);

    this.vehicles = new VehicleLayer(stream);
    this.signals = new SignalLayer(stream);
    this.pedestrians = new PedestrianLayer(stream);
    this.pedSignals = new PedSignalLayer(stream);
    this.overlays = new OverlayLayer(store, stream, labelRoot, () => this.network);
    this.scenario = new ScenarioLayer(stream);
    this.scene.add(this.roads.group, this.buildings.group, this.vehicles.group, this.pedestrians.group, this.signals.group, this.pedSignals.group, this.overlays.group, this.highlights.group, this.scenario.group);

    this.unsubs.push(
      store.onApplied((cmd) => {
        const d = commandDomains(cmd);
        if (d & D_ROADS) this.dirty.roads = true;
        if (d & D_BUILDINGS) this.dirty.buildings = true;
        if (d & D_VEHICLE_TYPES) this.dirty.vehicleTypes = true;
        this.overlays.invalidate(cmd);
      }),
      store.onReset(() => {
        this.dirty.roads = true;
        this.dirty.buildings = true;
        this.dirty.vehicleTypes = true;
        this.overlays.invalidateAll();
      }),
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
  }

  /** Unclamped ground-plane hit under a client-space pixel (null = above the horizon). */
  private rayGround(clientX: number, clientY: number, out: THREE.Vector3): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.cam.camera);
    return _ray.ray.intersectPlane(_plane, out);
  }

  /** Ground point (y = 0) under a client-space pixel. */
  pickGround = (clientX: number, clientY: number): Vec2 | null => {
    const p = this.rayGround(clientX, clientY, _hit);
    if (!p) return null;
    const h = this.store.getState().doc.meta.halfSize;
    return { x: Math.max(-h, Math.min(h, p.x)), z: Math.max(-h, Math.min(h, p.z)) };
  };

  /**
   * Left-drag pan: the grabbed ground point stays under the cursor. Each move shifts the target by
   * the anchor's offset and syncs the camera immediately, so several pointer events per frame never
   * overshoot.
   */
  readonly groundPan: GroundPan = {
    start: (x, y) => {
      const p = this.rayGround(x, y, _panHit);
      if (!p) return false;
      this.panAnchor = p.clone();
      return true;
    },
    move: (x, y) => {
      const a = this.panAnchor;
      const p = a && this.rayGround(x, y, _panHit);
      if (!a || !p) return;
      this.cam.controls.getTarget(_target);
      void this.cam.controls.moveTo(_target.x + a.x - p.x, 0, _target.z + a.z - p.z, false);
      this.cam.controls.update(0);
      this.cam.camera.updateMatrixWorld();
    },
    end: () => {
      this.panAnchor = null;
    },
  };

  /** Cursor for the fine snap grid around the pointer. */
  setCursor(p: Vec2 | null): void {
    this.ground.setCursor(p);
  }

  setPreview(p: ToolPreview): void {
    this.overlays.setPreview(p);
  }

  get roadNetwork(): RoadNetworkGeom {
    return this.network;
  }

  private syncScene(): void {
    const s = this.store.getState();
    if (this.dirty.roads) {
      this.dirty.roads = false;
      this.network = buildRoadNetwork(s.doc);
      this.roads.update(this.network);
      this.pedSignals.setCrossings(this.network.crossings);
    }
    if (this.dirty.buildings) {
      this.dirty.buildings = false;
      this.buildings.update(s.doc);
    }
    if (this.dirty.vehicleTypes) {
      this.dirty.vehicleTypes = false;
      this.vehicles.syncTypes(s.doc);
    }
    if (s.overlays.shadows !== this.shadows) {
      this.shadows = s.overlays.shadows;
      this.sun.castShadow = this.shadows;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.overlays.refresh();
  }

  private updateSun(): void {
    // Shadow frustum follows the camera target and scales with zoom.
    this.cam.controls.getTarget(_target);
    const d = Math.min(900, Math.max(120, this.cam.controls.distance * 0.9));
    _sunOffset.copy(this.dayNight.lightDir).multiplyScalar(SUN_DISTANCE);
    this.sun.position.copy(_target).add(_sunOffset);
    this.sun.target.position.copy(_target);
    const sc = this.sun.shadow.camera;
    if (sc.right !== d) {
      sc.left = -d;
      sc.right = d;
      sc.top = d;
      sc.bottom = -d;
      sc.near = 10;
      sc.far = 1600;
      sc.updateProjectionMatrix();
    }
  }

  /** Sun, sky, fog and window lights from the simulation's game clock (noon when it reports none). */
  private applyDayNight(): void {
    const dn = computeDayNight(this.stream.latest()?.stats.clock?.dayTime ?? NOON, this.dayNight);
    this.sun.color.copy(dn.lightColor);
    this.sun.intensity = dn.lightIntensity;
    this.hemi.color.copy(dn.hemiSky);
    this.hemi.groundColor.copy(dn.hemiGround);
    this.hemi.intensity = dn.hemiIntensity;
    (this.scene.background as THREE.Color).copy(dn.sky);
    (this.scene.fog as THREE.Fog).color.copy(dn.sky);
    this.buildings.setNight(dn.night);
  }

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.syncScene();
    this.ground.setStep(this.store.getState().toolOptions.snapStep);
    this.cam.update(dt);
    this.applyDayNight();
    this.updateSun();
    const s = this.store.getState();
    this.vehicles.update(now, s.doc);
    this.pedestrians.update(now, this.cam.controls.distance);
    this.buildings.setOccupancy(this.stream.latest());
    this.signals.update();
    this.pedSignals.update(now, Y_WALK);
    this.highlights.update(Date.now(), s.doc, s.highlights, s.docVersion);
    this.scenario.update(now);
    this.overlays.update(Date.now(), this.cam.camera, this.cam.controls.distance, this.width, this.height);
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.cam.camera);
    this.frames++;
    if (now - this.statAt >= 500) {
      const fps = Math.round((this.frames * 1000) / (now - this.statAt));
      this.frames = 0;
      this.statAt = now;
      this.store.set({ render: { fps, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles } });
      this.store.expire();
    }
  };

  /** Fly the camera to look at a point. */
  focus(p: Vec2): void {
    void this.cam.controls.moveTo(p.x, 0, p.z, true);
  }

  /** Fly the camera to frame a box (what the AI just built), keeping the viewing angle. */
  fitBox(box: Box): void {
    void this.cam.controls.moveTo((box.minX + box.maxX) / 2, 0, (box.minZ + box.maxZ) / 2, true);
    void this.cam.controls.dollyTo(fitDistance(box), true);
  }

  /** Test/debug: highlight things currently drawn. */
  highlightStats(): HighlightStats {
    return this.highlights.stats();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs) u();
    this.resizeObserver.disconnect();
    this.cam.dispose();
    this.roads.dispose();
    this.buildings.dispose();
    this.vehicles.dispose();
    this.pedestrians.dispose();
    this.signals.dispose();
    this.pedSignals.dispose();
    this.overlays.dispose();
    this.highlights.dispose();
    this.scenario.dispose();
    this.ground.dispose();
    this.renderer.dispose();
  }
}
