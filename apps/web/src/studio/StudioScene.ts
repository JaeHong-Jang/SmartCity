// 3D view of the building studio: its own WebGLRenderer and orbit camera (camera-controls), the
// draft baked with the city's building geometry (props included), ghosts, selection handle and
// pointer input. Picking walks the cell grid (picking.ts); ghosts are never picked.
// Left click/drag = tool, right drag (or Alt+left drag) = rotate, Shift+right / middle drag = pan,
// short right click = erase, Shift+click = erase. Keys: see viewNav.ts.

import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { parseVoxel, voxelKey, voxelsToParts, VOXEL_LIMITS, type BuildingProp, type VoxelModel, type Zone } from '@smartcity/shared';
import { bakeBuildingGeometry, createBuildingMaterial } from '../render/buildingGeometry';
import { configureRenderer, createSun } from '../render/sceneKit';
import { studioBakeInput } from './design';
import { pickVoxel, planeCell, rayBox, type V3, type VoxelHit } from './picking';
import { propBox } from './props';
import { StudioEditor, TOOL_INFO, type RectMode } from './StudioEditor';
import { isCameraOnlyPress, navAction, nextView, toolDigit, viewAngles, type ViewName } from './viewNav';
import type { Cell } from './voxelEdit';

CameraControls.install({ THREE });

const DRAG_PX = 5;
const GHOST_MAX = 4096;
const SLOW_BAKE_MS = 16;
const BAKE_DELAY_MS = 150;
const EXTENT = VOXEL_LIMITS.halfExtent * 2;

interface Pick {
  voxel: VoxelHit | null;
  /** Nearest prop under the cursor (closer than the voxel hit). */
  prop: number | null;
}

type Drag =
  | { kind: 'press'; x: number; y: number; pick: Pick; erase: boolean }
  | { kind: 'rect'; mode: RectMode; start: Cell; planeY: number; cells: Cell[] }
  | { kind: 'raise'; y0: number; plane: THREE.Plane; delta: number };

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export class StudioScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
  readonly controls: CameraControls;
  /** Set by the overlay: Tab hides/shows the side panels. */
  onTogglePanels: (() => void) | null = null;

  private readonly material = createBuildingMaterial();
  private readonly building = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
  private readonly cellBox = new THREE.BoxGeometry(1, 1, 1);
  /** Instant cell view while a slow bake is pending. */
  private readonly cells = new THREE.InstancedMesh(this.cellBox, new THREE.MeshStandardMaterial({ roughness: 0.8 }), VOXEL_LIMITS.cells);
  private readonly upper = new THREE.InstancedMesh(this.cellBox, new THREE.MeshBasicMaterial({ color: '#cbd5e1', transparent: true, opacity: 0.16, depthWrite: false }), VOXEL_LIMITS.cells);
  private readonly ghostMat = new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.45, depthWrite: false });
  private readonly ghost = new THREE.InstancedMesh(this.cellBox, this.ghostMat, GHOST_MAX);
  private readonly problems = new THREE.InstancedMesh(this.cellBox, new THREE.MeshBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0.5, depthWrite: false }), VOXEL_LIMITS.cells);
  private readonly propGhostMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
  private readonly propGhost = new THREE.Mesh(new THREE.BufferGeometry(), this.propGhostMat);
  private readonly propMarks = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#facc15'));
  private readonly handle = new THREE.Group();
  private readonly sun = createSun(2.1, 2048, 0.3);

  private raf = 0;
  private last = performance.now();
  private dirty = true;
  private bakeKey = '';
  private lastBakeMs = 0;
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private drag: Drag | null = null;
  private pointer: { x: number; y: number } | null = null;
  private problemProps: number[] = [];
  private lastView: ViewName | null = null;
  private readonly unsub: () => void;
  /** Serialized prop the hover ghost geometry was baked from. */
  private propGhostKey = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: StudioEditor,
    /** The design's zone (용도): part of the facade look (ADR 0014 §5); change it with setZone. */
    private zone: Zone,
  ) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true });
    configureRenderer(r);
    this.renderer = r;

    const s = this.scene;
    s.background = new THREE.Color('#bcd3e6');
    s.add(new THREE.HemisphereLight('#e8f1fb', '#56603f', 1.3));
    this.sun.position.set(-40, 70, 45);
    const sc = this.sun.shadow.camera;
    sc.left = -60;
    sc.right = 60;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 1;
    sc.far = 260;
    s.add(this.sun, this.sun.target);

    // Plot: lawn, 2 m grid, plot edge, and the road in front (+z) with an arrow.
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#7c9a6a', roughness: 1 }));
    lawn.position.y = -0.02;
    lawn.receiveShadow = true;
    s.add(lawn);
    const plot = new THREE.Mesh(new THREE.PlaneGeometry(EXTENT, EXTENT).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#c9c3b4', roughness: 1 }));
    plot.position.y = -0.01;
    plot.receiveShadow = true;
    s.add(plot);
    this.grid = new THREE.GridHelper(EXTENT, EXTENT / 2, '#6b7280', '#9ca3af');
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.position.y = 0.01;
    s.add(this.grid);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(140, 10).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3b4048', roughness: 0.95 }));
    road.position.set(0, 0, EXTENT / 2 + 9);
    road.receiveShadow = true;
    s.add(road);
    const sidewalk = new THREE.Mesh(new THREE.PlaneGeometry(140, 3).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#a8a29e', roughness: 1 }));
    sidewalk.position.set(0, 0.005, EXTENT / 2 + 2.5);
    s.add(sidewalk);
    for (let x = -66; x < 70; x += 8) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.25).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#f8fafc' }));
      dash.position.set(x, 0.01, EXTENT / 2 + 9);
      s.add(dash);
    }
    const arrow = new THREE.Shape([new THREE.Vector2(-2.2, 0), new THREE.Vector2(2.2, 0), new THREE.Vector2(0, 3.2)]);
    const front = new THREE.Mesh(new THREE.ShapeGeometry(arrow).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#f59e0b', side: THREE.DoubleSide }));
    front.position.set(0, 0.03, EXTENT / 2 + 0.6);
    front.name = 'front-arrow';
    s.add(front);

    this.building.castShadow = true;
    this.building.receiveShadow = true;
    this.cells.castShadow = true;
    this.cells.receiveShadow = true;
    for (const m of [this.cells, this.upper, this.ghost, this.problems]) {
      m.count = 0;
      m.frustumCulled = false;
    }
    this.cells.visible = false;
    this.ghost.renderOrder = 2;
    this.problems.renderOrder = 3;
    this.propGhost.visible = false;
    this.selBox.visible = false;
    s.add(this.building, this.cells, this.upper, this.ghost, this.problems, this.propGhost, this.propMarks, this.selBox, this.handle);

    // Floor handle: a yellow arrow (shaft + cone) above the selection.
    const hm = new THREE.MeshBasicMaterial({ color: '#facc15', depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.4, 10), hm);
    shaft.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.4, 14), hm);
    head.position.y = 3;
    const grab = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    grab.position.y = 1.8;
    grab.name = 'handle-grab';
    this.handle.add(shaft, head, grab);
    this.handle.renderOrder = 5;
    this.handle.visible = false;

    // Camera: right drag (or Alt+left drag) orbits, Shift+right / middle drag pans, wheel zooms; left is
    // the tool button. Touch: one finger = tool, two = rotate + zoom, three = pan.
    const c = new CameraControls(this.camera, canvas);
    c.mouseButtons.left = CameraControls.ACTION.NONE;
    c.mouseButtons.right = CameraControls.ACTION.ROTATE;
    c.mouseButtons.middle = CameraControls.ACTION.TRUCK;
    c.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
    c.touches.one = CameraControls.ACTION.NONE;
    c.touches.two = CameraControls.ACTION.TOUCH_DOLLY_ROTATE;
    c.touches.three = CameraControls.ACTION.TOUCH_TRUCK;
    c.minDistance = 6;
    c.maxDistance = 320;
    c.maxPolarAngle = Math.PI / 2 - 0.04;
    c.smoothTime = 0.1;
    c.draggingSmoothTime = 0.04;
    this.controls = c;
    c.addEventListener('controlstart', () => (this.lastView = null));
    this.frame(false);

    // Registered after the controls' own listener but as capture, which runs first on the target.
    canvas.addEventListener('pointerdown', this.setModifierButtons, true);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('contextmenu', this.noMenu);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    this.unsub = editor.subscribe(this.sync);
    this.sync();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.bakeTimer) clearTimeout(this.bakeTimer);
    this.unsub();
    const cv = this.canvas;
    cv.removeEventListener('pointerdown', this.setModifierButtons, true);
    cv.removeEventListener('pointerdown', this.onDown);
    cv.removeEventListener('pointermove', this.onMove);
    cv.removeEventListener('pointerup', this.onUp);
    cv.removeEventListener('pointercancel', this.onCancel);
    cv.removeEventListener('pointerleave', this.onLeave);
    cv.removeEventListener('contextmenu', this.noMenu);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Bounding box centre and size of the draft (the empty plot when there is none). */
  private bounds(): { cx: number; cz: number; r: number; h: number } {
    const m = this.editor.doc.model;
    let i0 = Infinity;
    let i1 = -Infinity;
    let j0 = Infinity;
    let j1 = -Infinity;
    let h = 4;
    for (const key of m.cells.keys()) {
      const [i, j, k] = parseVoxel(key);
      i0 = Math.min(i0, i);
      i1 = Math.max(i1, i);
      j0 = Math.min(j0, j);
      j1 = Math.max(j1, j);
      h = Math.max(h, (k + 1) * m.floorHeight);
    }
    if (i0 === Infinity) return { cx: 0, cz: 0, r: 14, h };
    const cx = ((i0 + i1 + 1) / 2) * m.cell;
    const cz = ((j0 + j1 + 1) / 2) * m.cell;
    return { cx, cz, r: Math.max(14, ((i1 - i0 + 1) * m.cell) / 2 + m.cell, ((j1 - j0 + 1) * m.cell) / 2 + m.cell), h };
  }

  /** Point the camera at the draft (or the empty plot); the orbit centre is the draft's bounding box centre. */
  frame(smooth = true): void {
    const { cx, cz, r, h } = this.bounds();
    const d = Math.max(r * 2.4, h * 2);
    this.lastView = 'home';
    void this.controls.setLookAt(cx + d * 0.55, h * 0.45 + d * 0.4, cz + d * 0.85, cx, h * 0.42, cz, smooth);
    this.dirty = true;
  }

  /** Smoothly turn to a named view around the draft's centre (keeps the zoom distance). */
  setView(view: ViewName): void {
    if (view === 'home') {
      this.frame();
      return;
    }
    const { cx, cz, h } = this.bounds();
    const a = viewAngles(view);
    this.lastView = view;
    void this.controls.setTarget(cx, h * 0.42, cz, true);
    void this.controls.rotateTo(a.azimuth, a.polar, true);
    this.dirty = true;
  }

  /** Cells and props to show in red (save check failures). */
  setProblems(cells: readonly string[], props: readonly number[]): void {
    const m = this.editor.doc.model;
    let n = 0;
    for (const key of cells) {
      if (n >= VOXEL_LIMITS.cells) break;
      const [i, j, k] = parseVoxel(key);
      this.cellMatrix(m, i, j, k, 1.04);
      this.problems.setMatrixAt(n++, _m);
    }
    this.problems.count = n;
    this.problems.instanceMatrix.needsUpdate = true;
    this.problemProps = [...props];
    this.drawPropMarks();
    this.dirty = true;
  }

  /** Client pixel of a point in the building frame (test hook). */
  toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    _v.set(x, y, z).project(this.camera);
    return { x: rect.left + ((_v.x + 1) / 2) * rect.width, y: rect.top + ((1 - _v.y) / 2) * rect.height };
  }

  /** The design's zone changed (용도): rebake, since the residential high-rise look depends on it. */
  setZone(zone: Zone): void {
    if (zone === this.zone) return;
    this.zone = zone;
    this.sync();
  }

  // ── Sync with the editor ──

  private sync = (): void => {
    const ed = this.editor;
    const key = `${ed.draftVersion}|${ed.floor}|${ed.upperHidden}|${this.zone}`;
    if (key !== this.bakeKey) {
      this.bakeKey = key;
      if (this.lastBakeMs < SLOW_BAKE_MS) this.bake();
      else {
        // Large drafts: show plain cells now, the finished look after a short pause.
        this.showCells();
        if (this.bakeTimer) clearTimeout(this.bakeTimer);
        this.bakeTimer = setTimeout(() => {
          this.bakeTimer = null;
          this.bake();
        }, BAKE_DELAY_MS);
      }
      this.drawUpper();
      this.grid.position.y = (ed.floor ?? 0) * ed.doc.model.floorHeight + 0.01;
    }
    this.drawSelection();
    this.drawPropMarks();
    this.refreshHover();
    this.dirty = true;
  };

  private cellMatrix(m: VoxelModel, i: number, j: number, k: number, scale = 1): void {
    const fh = m.floorHeight;
    _m.makeScale(m.cell * scale, fh * scale, m.cell * scale).setPosition((i + 0.5) * m.cell, (k + 0.5) * fh, (j + 0.5) * m.cell);
  }

  private visibleModel(): VoxelModel {
    const ed = this.editor;
    const m = ed.doc.model;
    if (ed.floor === null) return m;
    const cells = new Map<string, number>();
    for (const [key, s] of m.cells) if (parseVoxel(key)[2] <= ed.floor) cells.set(key, s);
    return { ...m, cells };
  }

  private bake(): void {
    const t0 = performance.now();
    const ed = this.editor;
    const m = this.visibleModel();
    const parts = m === ed.doc.model ? ed.parts().parts : voxelsToParts(m).parts;
    const top = ed.floor === null ? Infinity : (ed.floor + 1) * m.floorHeight + 0.01;
    const props = ed.doc.props.filter((p) => p.pos.y <= top);
    const old = this.building.geometry;
    this.building.geometry = bakeBuildingGeometry(studioBakeInput(parts, props, ed.doc, this.zone));
    old.dispose();
    this.building.visible = true;
    this.cells.visible = false;
    this.lastBakeMs = performance.now() - t0;
    this.dirty = true;
  }

  private showCells(): void {
    const m = this.visibleModel();
    const styles = m.styles;
    let n = 0;
    for (const [key, s] of m.cells) {
      const [i, j, k] = parseVoxel(key);
      this.cellMatrix(m, i, j, k);
      this.cells.setMatrixAt(n, _m);
      this.cells.setColorAt(n, _c.set(styles[s]?.color ?? '#cccccc'));
      n++;
    }
    this.cells.count = n;
    this.cells.instanceMatrix.needsUpdate = true;
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
    this.cells.visible = true;
    this.building.visible = false;
  }

  private drawUpper(): void {
    const ed = this.editor;
    const m = ed.doc.model;
    let n = 0;
    if (ed.floor !== null && !ed.upperHidden) {
      for (const key of m.cells.keys()) {
        const [i, j, k] = parseVoxel(key);
        if (k <= ed.floor) continue;
        this.cellMatrix(m, i, j, k);
        this.upper.setMatrixAt(n++, _m);
      }
    }
    this.upper.count = n;
    this.upper.instanceMatrix.needsUpdate = true;
  }

  private drawSelection(): void {
    const sel = this.editor.tool === 'select' ? this.editor.selection() : null;
    this.selBox.visible = !!sel;
    this.handle.visible = !!sel;
    if (!sel) return;
    const m = this.editor.doc.model;
    let i0 = Infinity;
    let i1 = -Infinity;
    let j0 = Infinity;
    let j1 = -Infinity;
    for (const [i, j] of sel.columns) {
      i0 = Math.min(i0, i);
      i1 = Math.max(i1, i);
      j0 = Math.min(j0, j);
      j1 = Math.max(j1, j);
    }
    const box = this.selBox.box;
    box.min.set(i0 * m.cell - 0.05, sel.bottom * m.floorHeight - 0.05, j0 * m.cell - 0.05);
    box.max.set((i1 + 1) * m.cell + 0.05, (sel.top + 1) * m.floorHeight + 0.05, (j1 + 1) * m.cell + 0.05);
    this.handle.position.set(((i0 + i1 + 1) / 2) * m.cell, (sel.top + 1) * m.floorHeight + 0.6, ((j0 + j1 + 1) / 2) * m.cell);
  }

  private drawPropMarks(): void {
    for (const c of [...this.propMarks.children]) {
      this.propMarks.remove(c);
      (c as THREE.Box3Helper).geometry.dispose();
      ((c as THREE.Box3Helper).material as THREE.Material).dispose();
    }
    const props = this.editor.doc.props;
    for (const i of this.problemProps) {
      const p = props[i];
      if (!p) continue;
      const b = propBox(p);
      this.propMarks.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)), new THREE.Color('#ef4444')));
    }
  }

  // ── Picking ──

  private setRay(x: number, y: number): void {
    const rect = this.canvas.getBoundingClientRect();
    _ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  private rayArrays(): [V3, V3] {
    const o = _ray.ray.origin;
    const d = _ray.ray.direction;
    return [
      [o.x, o.y, o.z],
      [d.x, d.y, d.z],
    ];
  }

  private pick(x: number, y: number): Pick {
    this.setRay(x, y);
    const [o, d] = this.rayArrays();
    const ed = this.editor;
    const m = ed.doc.model;
    const voxel = pickVoxel(o, d, { cell: m.cell, floorHeight: m.floorHeight, has: ed.pickable, level: ed.floor ?? 0 });
    let prop: number | null = null;
    let best = voxel ? voxel.t + 0.05 : Infinity;
    const top = ed.floor === null ? Infinity : (ed.floor + 1) * m.floorHeight + 0.01;
    ed.doc.props.forEach((p, i) => {
      if (p.pos.y > top) return;
      const b = propBox(p);
      const t = rayBox(o, d, b.min, b.max);
      if (t !== null && t < best) {
        best = t;
        prop = i;
      }
    });
    return { voxel, prop };
  }

  // ── Ghosts ──

  private showGhost(cells: readonly Cell[], color: string, opacity = 0.45): void {
    const m = this.editor.doc.model;
    const n = Math.min(cells.length, GHOST_MAX);
    for (let a = 0; a < n; a++) {
      const [i, j, k] = cells[a]!;
      this.cellMatrix(m, i, j, k, 1.02);
      this.ghost.setMatrixAt(a, _m);
    }
    this.ghost.count = n;
    this.ghost.instanceMatrix.needsUpdate = true;
    this.ghostMat.color.set(color);
    this.ghostMat.opacity = opacity;
    this.dirty = true;
  }

  private clearGhost(): void {
    if (this.ghost.count === 0 && !this.propGhost.visible) return;
    this.ghost.count = 0;
    this.propGhost.visible = false;
    this.dirty = true;
  }

  private modeColor(mode: RectMode): string {
    return mode === 'add' ? '#4ade80' : mode === 'erase' ? '#f87171' : this.editor.channel === 'roofColor' ? this.editor.style.roofColor : this.editor.style.color;
  }

  private refreshHover(): void {
    if (this.drag && this.drag.kind !== 'press') return;
    if (!this.pointer) {
      this.clearGhost();
      return;
    }
    this.hover(this.pointer.x, this.pointer.y, false);
  }

  private hover(x: number, y: number, shift: boolean): void {
    const ed = this.editor;
    const p = this.pick(x, y);
    this.propGhost.visible = false;
    this.ghost.count = 0;
    this.canvas.style.cursor = 'crosshair';
    if (ed.tool === 'select') {
      this.setRay(x, y);
      if (this.handle.visible && _ray.intersectObject(this.handle, true).length) this.canvas.style.cursor = 'ns-resize';
      if (p.voxel?.kind === 'cell') {
        const sel = ed.parts().sources.find((src) => src.includes(voxelKey(p.voxel!.i, p.voxel!.j, p.voxel!.k)));
        if (sel) this.showGhost(sel.map(parseVoxel), '#facc15', 0.18);
      }
      this.dirty = true;
      return;
    }
    if (ed.tool === 'prop' && !shift) {
      if (p.prop !== null) {
        this.ghostProp(ed.doc.props[p.prop]!, false);
        return;
      }
      if (!p.voxel) return;
      const snap = ed.propSnap(p.voxel);
      if (snap.prop) this.ghostProp(snap.prop, snap.ok);
      ed.setHint(snap.ok ? '' : snap.reason);
      return;
    }
    if ((ed.tool === 'erase' || shift) && p.prop !== null) {
      this.ghostProp(ed.doc.props[p.prop]!, false);
      return;
    }
    if (!p.voxel) {
      this.dirty = true;
      return;
    }
    if (ed.tool === 'eyedropper') {
      if (p.voxel.kind === 'cell') this.showGhost([[p.voxel.i, p.voxel.j, p.voxel.k]], '#ffffff', 0.35);
      return;
    }
    const t = ed.clickTargets(p.voxel, shift);
    if (t) this.showGhost(t.cells, this.modeColor(t.mode), t.mode === 'paint' ? 0.6 : 0.45);
  }

  private ghostProp(prop: BuildingProp, ok: boolean): void {
    const key = JSON.stringify(prop);
    if (key !== this.propGhostKey) {
      this.propGhostKey = key;
      const old = this.propGhost.geometry;
      this.propGhost.geometry = bakeBuildingGeometry({ parts: [], props: [prop] });
      old.dispose();
    }
    this.propGhostMat.color.set(ok ? '#ffffff' : '#ff6b6b');
    this.propGhostMat.opacity = ok ? 0.75 : 0.6;
    this.propGhost.visible = true;
    this.dirty = true;
  }

  // ── Input ──

  private noMenu = (e: Event): void => e.preventDefault();

  /** Alt+left drag rotates, Shift+right drag pans (read by the controls on this same pointerdown). */
  private setModifierButtons = (e: PointerEvent): void => {
    const b = this.controls.mouseButtons;
    b.left = e.altKey ? CameraControls.ACTION.ROTATE : CameraControls.ACTION.NONE;
    b.right = e.shiftKey ? CameraControls.ACTION.TRUCK : CameraControls.ACTION.ROTATE;
  };

  private onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) {
      // A second finger turns the gesture into camera work: drop the tool press.
      this.cancelDrag();
      return;
    }
    if (isCameraOnlyPress(e.button, e.shiftKey, e.altKey) && e.button === 0) {
      this.drag = null;
      this.clearGhost();
      return;
    }
    if (e.button === 2) {
      this.drag = null;
      this.rightDown = { x: e.clientX, y: e.clientY, cameraOnly: isCameraOnlyPress(2, e.shiftKey, e.altKey) };
      return;
    }
    if (e.button !== 0) return;
    const ed = this.editor;
    this.canvas.setPointerCapture(e.pointerId);
    if (ed.tool === 'select' && this.handle.visible) {
      this.setRay(e.clientX, e.clientY);
      if (_ray.intersectObject(this.handle, true).length) {
        // Drag on a vertical plane through the handle that faces the camera.
        const n = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize().negate();
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.handle.position);
        const hit = _ray.ray.intersectPlane(plane, new THREE.Vector3());
        if (hit && ed.beginRaise()) {
          this.drag = { kind: 'raise', y0: hit.y, plane, delta: 0 };
          this.clearGhost();
          return;
        }
      }
    }
    this.drag = { kind: 'press', x: e.clientX, y: e.clientY, pick: this.pick(e.clientX, e.clientY), erase: e.shiftKey };
  };

  private rightDown: { x: number; y: number; cameraOnly: boolean } | null = null;

  private onMove = (e: PointerEvent): void => {
    this.pointer = { x: e.clientX, y: e.clientY };
    const ed = this.editor;
    const d = this.drag;
    if (d?.kind === 'raise') {
      this.setRay(e.clientX, e.clientY);
      const hit = _ray.ray.intersectPlane(d.plane, _v);
      if (!hit) return;
      const delta = Math.round((hit.y - d.y0) / ed.doc.model.floorHeight);
      if (delta !== d.delta) {
        d.delta = delta;
        ed.previewRaise(delta);
      }
      return;
    }
    if (d?.kind === 'press' && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) {
      const tool = d.erase ? 'erase' : ed.tool;
      const v = d.pick.voxel;
      const mode: RectMode | null = tool === 'stack' ? 'add' : tool === 'erase' ? 'erase' : tool === 'paint' ? 'paint' : null;
      if (mode && v && (mode === 'add' || v.kind === 'cell')) {
        const start: Cell = mode === 'add' ? StudioEditor.stackCell(v) : [v.i, v.j, v.k];
        const fh = ed.doc.model.floorHeight;
        this.drag = { kind: 'rect', mode, start, planeY: mode === 'add' ? start[2] * fh : (start[2] + 0.5) * fh, cells: [] };
      } else {
        this.drag = null;
      }
    }
    const r = this.drag;
    if (r?.kind === 'rect') {
      this.setRay(e.clientX, e.clientY);
      const [o, dir] = this.rayArrays();
      const end = planeCell(o, dir, r.planeY, ed.doc.model.cell);
      if (!end) return;
      r.cells = ed.rectTargets(r.mode, r.start, end);
      this.showGhost(r.cells, this.modeColor(r.mode), r.mode === 'paint' ? 0.6 : 0.45);
      ed.setHint(`${r.cells.length}블록 · Esc 취소`);
      return;
    }
    if (!d) this.hover(e.clientX, e.clientY, e.shiftKey);
  };

  private onUp = (e: PointerEvent): void => {
    const ed = this.editor;
    if (e.button === 2) {
      const r = this.rightDown;
      this.rightDown = null;
      if (r && !r.cameraOnly && Math.hypot(e.clientX - r.x, e.clientY - r.y) <= DRAG_PX) this.erase(this.pick(e.clientX, e.clientY));
      return;
    }
    if (e.button !== 0) return;
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'raise') {
      ed.endRaise();
    } else if (d.kind === 'rect') {
      ed.setHint('');
      ed.apply(d.mode, d.cells);
    } else {
      this.act(d.pick, d.erase);
    }
    this.hover(e.clientX, e.clientY, e.shiftKey);
  };

  private act(p: Pick, erase: boolean): void {
    const ed = this.editor;
    if (erase || ed.tool === 'erase') {
      this.erase(p);
      return;
    }
    switch (ed.tool) {
      case 'stack':
      case 'paint':
        if (p.voxel) ed.click(p.voxel);
        break;
      case 'eyedropper':
        if (p.voxel) ed.eyedrop(p.voxel);
        break;
      case 'select':
        ed.select(p.voxel);
        break;
      case 'prop':
        if (p.voxel) ed.placeProp(p.voxel);
        break;
    }
  }

  /** Erase whatever is nearest under the cursor: a prop (and its mirror images) or cells. */
  private erase(p: Pick): void {
    const ed = this.editor;
    if (p.prop !== null) ed.removeProps(ed.propGroup(p.prop));
    else if (p.voxel) ed.click(p.voxel, true);
  }

  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'raise') this.editor.endRaise(true);
    if (d?.kind === 'rect') this.editor.setHint('');
    this.clearGhost();
  }

  private onCancel = (): void => this.cancelDrag();

  private onLeave = (): void => {
    this.pointer = null;
    if (!this.drag) this.clearGhost();
  };

  private onBlur = (): void => this.cancelDrag();

  /** Studio shortcuts; every key is kept from the city behind the overlay. */
  private onKey = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    e.stopPropagation();
    const ed = this.editor;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Camera keys go by e.code (works with a Korean IME); numpad digits must not pick tools.
    const nav = navAction(e.code, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    if (nav) {
      e.preventDefault();
      this.runNav(nav);
      return;
    }
    if (e.code === 'KeyF' && !mod && !e.altKey) {
      this.frame();
      return;
    }
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) ed.redo();
      else ed.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      ed.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === 'Escape') {
      if (this.drag && this.drag.kind !== 'press') this.cancelDrag();
      else if (ed.selected) ed.select(null);
      return;
    }
    const tool = TOOL_INFO.find((t) => t.key === toolDigit(e.code));
    if (tool) {
      ed.set('tool', tool.id);
      return;
    }
    if (ed.tool === 'prop' && key === 'r') {
      ed.set('propRot', (ed.propRot + 1) % 4);
      if (this.pointer) this.hover(this.pointer.x, this.pointer.y, false);
      return;
    }
    if (ed.tool === 'prop' && (e.key === '[' || e.key === ']')) {
      const sizes = [0.5, 0.75, 1, 1.5, 2, 3, 4];
      const i = sizes.indexOf(ed.propSize);
      ed.set('propSize', sizes[Math.max(0, Math.min(sizes.length - 1, (i < 0 ? 2 : i) + (e.key === ']' ? 1 : -1)))]!);
      return;
    }
  };

  private runNav(a: NonNullable<ReturnType<typeof navAction>>): void {
    const rad = Math.PI / 180;
    switch (a.type) {
      case 'rotate':
        this.lastView = null;
        void this.controls.rotate(a.azimuthDeg * rad, a.polarDeg * rad, true);
        break;
      case 'view':
        this.setView(a.view);
        break;
      case 'cycle':
        this.setView(nextView(this.lastView));
        break;
      case 'panels':
        this.onTogglePanels?.();
        break;
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!isTyping(e.target)) e.stopPropagation();
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const cv = this.canvas;
    const pr = this.renderer.getPixelRatio();
    if (cv.width !== Math.floor(cv.clientWidth * pr) || cv.height !== Math.floor(cv.clientHeight * pr)) {
      this.renderer.setSize(cv.clientWidth, cv.clientHeight, false);
      this.camera.aspect = cv.clientWidth / Math.max(1, cv.clientHeight);
      this.camera.updateProjectionMatrix();
      this.dirty = true;
    }
    const moved = this.controls.update(dt);
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };
}
