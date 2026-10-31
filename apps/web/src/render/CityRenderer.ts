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
import { cityFrame, cityViewPose, districtFrame, EMPTY_START, eyeLevelPose, type CameraPose } from './cityView';
import { commandDomains, D_BUILDINGS, D_BUS_STOPS, D_PARCELS, D_ROADS, D_SENSORS, D_VEHICLE_TYPES } from './dirty';
import { computeDayNight, createDayNightState, NOON } from './dayNight';
import { createGround, type Ground } from './ground';
import { HighlightLayer, type HighlightStats } from './highlight';
import { createMountains, type Mountains } from './mountains';
import { OverlayLayer } from './overlays';
import { PavingLayer } from './paving';
import { PedestrianLayer } from './pedestrians';
import { FrameTimes, type FramePercentiles } from './perfStats';
import { buildRoadNetwork, type RoadNetworkGeom } from './roadNetwork';
import { RoadLayer, Y_WALK } from './roads';
import { BlackoutLayer } from './blackout';
import { DetectionLayer } from './detection';
import { ControlMarkLayer } from './controlMark';
import { EmergencyLayer } from './emergency';
import { ScenarioLayer } from './scenario';
import { configureRenderer, createSun } from './sceneKit';
import { PedSignalLayer, SignalLayer } from './signals';
import { SensorLayer, type SensorStats } from './sensors';
import { createSky, fogRange, type Sky } from './sky';
import { StreetscapeLayer, type StreetscapeStats } from './streetscape';
import { VehicleLayer } from './vehicles';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const SUN_DISTANCE = 520;
const _sunOffset = new THREE.Vector3();
const _target = new THREE.Vector3();
const _panHit = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _fwd = new THREE.Vector3();
/** Grid contrast while only looking around (select tool, simulator); editing tools get 1. */
const GRID_VIEWING = 0.35;

export class CityRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: CityCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private readonly dayNight = createDayNightState();
  private roads = new RoadLayer();
  private paving = new PavingLayer();
  private sky: Sky = createSky();
  private mountains: Mountains = createMountains();
  private streetscape = new StreetscapeLayer();
  /** Frame the city once, on the first entry into a room that has one (never on later edits or resyncs). */
  private autoFitPending = true;
  /** Where the last district view put the camera (a second "도시 보기" there shows the whole city). */
  private districtPose: CameraPose | null = null;
  private buildings = new BuildingLayer();
  private sensors = new SensorLayer();
  private vehicles: VehicleLayer;
  private signals: SignalLayer;
  private pedestrians: PedestrianLayer;
  private pedSignals: PedSignalLayer;
  private overlays: OverlayLayer;
  private highlights = new HighlightLayer();
  readonly scenario: ScenarioLayer;
  readonly emergency: EmergencyLayer;
  readonly blackout: BlackoutLayer;
  readonly detection: DetectionLayer;
  readonly controlMark: ControlMarkLayer;
  /** Night factor 0..1 of the last frame (blackout veil strength). */
  private night = 0;
  private network: RoadNetworkGeom = { segments: new Map(), nodes: new Map(), crossings: [], graph: null };
  private dirty = { roads: true, buildings: true, vehicleTypes: true, paving: true, sensors: true, streetscape: true };
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
  /** Perf stats (ADR 0013 §7): frame times, shadow-pass share, vehicle interpolation CPU time. */
  private readonly frameTimes = new FrameTimes();
  private readonly framePct: FramePercentiles = { p50: 0, p95: 0, p99: 0 };
  private shadowCalls = 0;
  private shadowTriangles = 0;
  private interpSum = 0;
  private interpMax = 0;
  /** Dev/measurement only: render this time of day instead of the simulation clock (null = sim clock). */
  dayTimeOverride: number | null = null;

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
    // Split the shadow-map pass out of the frame's draw calls (the renderer calls shadowMap.render itself).
    const shadowMap = renderer.shadowMap;
    const renderShadows = shadowMap.render.bind(shadowMap);
    shadowMap.render = (lights, scene, camera) => {
      const calls = renderer.info.render.calls;
      const tris = renderer.info.render.triangles;
      renderShadows(lights, scene, camera);
      this.shadowCalls = renderer.info.render.calls - calls;
      this.shadowTriangles = renderer.info.render.triangles - tris;
    };

    // Background color stays as a fallback behind the sky dome; both follow the day/night horizon color.
    const sky = new THREE.Color('#bccfdb');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 1400, 5200);
    this.scene.add(this.sky.mesh, this.mountains.mesh);

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
    this.emergency = new EmergencyLayer(stream);
    this.blackout = new BlackoutLayer(stream);
    this.detection = new DetectionLayer(stream, labelRoot);
    this.controlMark = new ControlMarkLayer(labelRoot);
    this.scene.add(this.controlMark.group);
    this.scene.add(this.paving.group, this.roads.group, this.streetscape.group, this.buildings.group, this.sensors.group, this.vehicles.group, this.pedestrians.group, this.signals.group, this.pedSignals.group, this.overlays.group, this.highlights.group, this.scenario.group, this.emergency.group, this.blackout.group, this.detection.group);

    this.unsubs.push(
      store.onApplied((cmd) => {
        const d = commandDomains(cmd);
        if (d & D_ROADS) this.dirty.roads = true;
        if (d & D_BUILDINGS) this.dirty.buildings = true;
        if (d & D_VEHICLE_TYPES) this.dirty.vehicleTypes = true;
        if (d & (D_ROADS | D_BUILDINGS | D_PARCELS)) this.dirty.paving = true;
        // A sensor's pose follows its road.
        if (d & (D_SENSORS | D_ROADS)) this.dirty.sensors = true;
        // Trees and lamps keep clear of junctions, crosswalks, stops, sensors and building entrances.
        if (d & (D_ROADS | D_BUS_STOPS | D_SENSORS | D_BUILDINGS | D_PARCELS)) this.dirty.streetscape = true;
        this.overlays.invalidate(cmd);
      }),
      store.onReset(() => {
        this.dirty.roads = true;
        this.dirty.buildings = true;
        this.dirty.vehicleTypes = true;
        this.dirty.paving = true;
        this.dirty.sensors = true;
        this.dirty.streetscape = true;
        this.overlays.invalidateAll();
      }),
      // Synchronously with the welcome (before React shows the room), so nothing the user or a test
      // does after entering is overridden.
      store.subscribe(() => this.autoFit()),
    );

    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      // Test/debug hook (dev server only): what the blackout and signal layers currently draw.
      (window as unknown as { __smartcityBlackout: unknown }).__smartcityBlackout = { stats: () => this.blackout.stats(), darkHeads: () => this.signals.darkHeads };
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.autoFit();
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
    if (this.dirty.sensors) {
      // After the road network: coverage uses its compiled graph.
      this.dirty.sensors = false;
      this.sensors.update(s.doc);
    }
    // View sectors: every sensor with the sensor tool or the layer toggle, else only a selected sensor.
    const one = s.selection?.kind === 'sensor' ? s.selection.id : null;
    this.sensors.setSectors(s.doc, this.network.graph, s.tool === 'sensor' || s.overlays.sensors ? 'all' : one !== null ? 'one' : 'none', one);
    if (this.dirty.streetscape) {
      // After the road network (placements follow its geometry and crosswalks).
      this.dirty.streetscape = false;
      this.streetscape.update(s.doc, this.network);
    }
    if (this.dirty.vehicleTypes) {
      this.dirty.vehicleTypes = false;
      this.vehicles.syncTypes(s.doc);
    }
    if (this.dirty.paving) {
      this.dirty.paving = false;
      this.paving.update(s.doc);
    }
    if (s.overlays.shadows !== this.shadows) {
      this.shadows = s.overlays.shadows;
      this.sun.castShadow = this.shadows;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.overlays.refresh();
  }

  private updateSun(): void {
    // Shadow frustum covers what is on screen around the target: the view's half width at the target,
    // stretched and pushed forward for low (near-horizontal) views. Sizes come in ~10 % steps and the
    // center snaps to shadow texels, so panning and small zooms do not make shadow edges crawl.
    const c = this.cam.controls;
    c.getTarget(_target);
    const cam = this.cam.camera;
    const s = Math.sin(c.polarAngle);
    const halfW = c.distance * Math.tan((cam.fov * Math.PI) / 360) * Math.max(1, cam.aspect);
    const want = Math.min(900, Math.max(80, halfW * (1 + 1.2 * s * s)));
    const d = Math.min(900, 80 * Math.pow(1.1, Math.ceil(Math.log(want / 80) / Math.log(1.1))));
    _fwd.set(_target.x - cam.position.x, 0, _target.z - cam.position.z);
    if (_fwd.lengthSq() > 1e-6) _target.addScaledVector(_fwd.normalize(), d * 0.45 * s * s);
    const lightDir = this.dayNight.lightDir;
    _lx.crossVectors(_up, lightDir).normalize();
    _ly.crossVectors(lightDir, _lx);
    const texel = (2 * d) / this.sun.shadow.mapSize.width;
    const px = _target.dot(_lx);
    const py = _target.dot(_ly);
    _target.addScaledVector(_lx, Math.round(px / texel) * texel - px).addScaledVector(_ly, Math.round(py / texel) * texel - py);
    _sunOffset.copy(lightDir).multiplyScalar(SUN_DISTANCE);
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
    const dn = computeDayNight(this.dayTimeOverride ?? this.stream.latest()?.stats.clock?.dayTime ?? NOON, this.dayNight);
    this.sun.color.copy(dn.lightColor);
    this.sun.intensity = dn.lightIntensity;
    this.hemi.color.copy(dn.hemiSky);
    this.hemi.groundColor.copy(dn.hemiGround);
    this.hemi.intensity = dn.hemiIntensity;
    (this.scene.background as THREE.Color).copy(dn.sky);
    (this.scene.fog as THREE.Fog).color.copy(dn.sky);
    this.sky.setColors(dn.sky, dn.skyZenith);
    this.mountains.setColors(dn.sky, dn.night, dn.lightDir);
    this.streetscape.setNight(dn.night);
    this.roads.setNight(dn.night);
    this.buildings.setNight(dn.night);
    this.paving.setNight(dn.night);
    this.buildings.setSky(dn.skyZenith);
    this.night = dn.night;
  }

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    this.frameTimes.push(now - this.last);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.syncScene();
    const st = this.store.getState();
    this.ground.setStep(st.toolOptions.snapStep);
    this.ground.setGridStrength(st.tool === 'select' ? GRID_VIEWING : 1);
    this.cam.update(dt);
    fogRange(this.cam.controls.distance, this.scene.fog as THREE.Fog);
    this.sky.follow(this.cam.camera);
    this.mountains.setQuality(st.quality);
    this.streetscape.setQuality(st.quality);
    this.mountains.follow(this.cam.camera);
    this.streetscape.frame(this.cam.camera.position, this.cam.controls.distance);
    this.applyDayNight();
    this.updateSun();
    const s = this.store.getState();
    const t0 = performance.now();
    this.vehicles.update(now, s.doc, this.cam.camera.position, this.night);
    const interp = performance.now() - t0;
    this.interpSum += interp;
    if (interp > this.interpMax) this.interpMax = interp;
    this.pedestrians.update(now, this.cam.controls.distance);
    this.sensors.frame(this.cam.camera.position.x, this.cam.camera.position.z);
    this.buildings.setOccupancy(this.stream.latest());
    this.signals.update();
    this.pedSignals.update(now, Y_WALK);
    this.highlights.update(Date.now(), s.doc, s.highlights, s.docVersion);
    this.scenario.update(now);
    this.emergency.update(now);
    this.blackout.update(now, this.night, this.cam.controls.distance);
    this.detection.update(now, this.cam.camera, this.width, this.height);
    this.controlMark.update(now, this.cam.camera, this.width, this.height);
    this.overlays.update(Date.now(), this.cam.camera, this.cam.controls.distance, this.width, this.height);
    this.renderer.info.reset();
    this.shadowCalls = 0;
    this.shadowTriangles = 0;
    this.renderer.render(this.scene, this.cam.camera);
    this.frames++;
    if (now - this.statAt >= 500) {
      const fps = Math.round((this.frames * 1000) / (now - this.statAt));
      const p = this.frameTimes.summarize(this.framePct);
      const info = this.renderer.info.render;
      this.store.set({
        render: {
          fps,
          drawCalls: info.calls,
          triangles: info.triangles,
          shadowCalls: this.shadowCalls,
          shadowTriangles: this.shadowTriangles,
          frameMs: { p50: p.p50, p95: p.p95, p99: p.p99 },
          interpMs: { mean: this.interpSum / this.frames, max: this.interpMax },
        },
      });
      this.frames = 0;
      this.interpSum = 0;
      this.interpMax = 0;
      this.statAt = now;
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

  private setPose(p: CameraPose, smooth: boolean): void {
    void this.cam.controls.setLookAt(p.position.x, p.position.y, p.position.z, p.target.x, 0, p.target.z, smooth);
  }

  /**
   * First entry into a room: once the doc is in, frame the city if it has one. Skipped when the camera
   * was already moved (by the user, or a test placing it) before the city arrived.
   */
  private autoFit(): void {
    if (!this.autoFitPending) return;
    const s = this.store.getState();
    if (!s.ready) return;
    this.autoFitPending = false;
    const frame = districtFrame(s.doc);
    if (!frame) return;
    const c = this.cam.controls;
    c.getTarget(_target);
    const { position: p, target: t } = EMPTY_START;
    const dx = p.x - t.x;
    const dz = p.z - t.z;
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
    const atStart = near(_target.x, t.x) && near(_target.z, t.z) && near(c.distance, Math.hypot(dx, p.y, dz)) && near(c.azimuthAngle, Math.atan2(dx, dz)) && near(c.polarAngle, Math.atan2(Math.hypot(dx, dz), p.y));
    if (!atStart) return;
    this.districtPose = cityViewPose(frame, this.cam.camera.fov, this.cam.camera.aspect);
    this.setPose(this.districtPose, false);
  }

  /** True while the camera is (or is flying to) the last district view. */
  private atDistrictView(): boolean {
    const d = this.districtPose;
    if (!d) return false;
    const c = this.cam.controls;
    c.getTarget(_target, true);
    c.getPosition(_panHit, true);
    return Math.hypot(_target.x - d.target.x, _target.z - d.target.z) < 5 && _panHit.distanceTo(_lx.set(d.position.x, d.position.y, d.position.z)) < 5;
  }

  /**
   * "도시 보기", keeping the current compass direction: the densest district from a low angle (the
   * rest of the city runs past the screen edges into the haze); pressed again while there, the whole
   * (trimmed) city. For a small city both are the same view.
   */
  viewCity(): void {
    const doc = this.store.getState().doc;
    const cam = this.cam.camera;
    const az = this.cam.controls.azimuthAngle;
    if (this.atDistrictView()) {
      const full = cityFrame(doc);
      this.districtPose = null;
      if (full) this.setPose(cityViewPose(full, cam.fov, cam.aspect, az), true);
      return;
    }
    const frame = districtFrame(doc);
    this.districtPose = frame ? cityViewPose(frame, cam.fov, cam.aspect, az) : null;
    this.setPose(this.districtPose ?? EMPTY_START, true);
  }

  /** "눈높이 보기": street level at the junction nearest to where the camera looks, down a road. */
  viewEyeLevel(): void {
    const doc = this.store.getState().doc;
    this.cam.controls.getTarget(_target);
    const here = { x: _target.x, z: _target.z };
    const pose = eyeLevelPose(doc, here, cityFrame(doc)?.center ?? here);
    if (pose) {
      this.setPose(pose, true);
      return;
    }
    // No roads: drop to the ground where the camera looks.
    void this.cam.controls.rotatePolarTo(this.cam.controls.maxPolarAngle, true);
    void this.cam.controls.dollyTo(80, true);
  }

  /** Measurement: start a fresh frame-time window. */
  resetFrameTimes(): void {
    this.frameTimes.clear();
  }

  /**
   * Measurement: mean wall time of `frames` back-to-back renders of the current scene (shadow pass
   * included), finished with a 1-pixel read-back so the GPU work is counted. Independent of vsync and
   * of the page's frame scheduling; scene updates (traffic, overlays) are not part of it.
   */
  benchRender(frames: number): number {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    this.renderer.render(this.scene, this.cam.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) this.renderer.render(this.scene, this.cam.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / frames;
  }

  /** Test/debug: sensor instances and view sectors currently drawn. */
  sensorStats(): SensorStats {
    return this.sensors.stats();
  }

  /** Test/debug: street trees and lamps placed and drawn per LOD. */
  streetscapeStats(): StreetscapeStats & { mountainRings: number } {
    return { ...this.streetscape.stats(), mountainRings: this.mountains.rings };
  }

  /** Test/debug: placed trees and lamps within `r` m of (x, z). */
  streetscapeNear(x: number, z: number, r: number): { trees: Vec2[]; lamps: Vec2[] } {
    return this.streetscape.near(x, z, r);
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
    this.paving.dispose();
    this.sky.dispose();
    this.mountains.dispose();
    this.streetscape.dispose();
    this.buildings.dispose();
    this.sensors.dispose();
    this.vehicles.dispose();
    this.pedestrians.dispose();
    this.signals.dispose();
    this.pedSignals.dispose();
    this.overlays.dispose();
    this.highlights.dispose();
    this.scenario.dispose();
    this.emergency.dispose();
    this.blackout.dispose();
    this.detection.dispose();
    this.controlMark.dispose();
    this.ground.dispose();
    this.renderer.dispose();
  }
}
