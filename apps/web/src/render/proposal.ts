// ProposalLayer (ADR 0009 §5, Argon B2): previews an AI proposal. Designs the proposal introduces are
// baked into a temporary catalog (never added to the doc); buildings are drawn as translucent
// instances grouped per design (one draw call per design), parcels as zone-colored fills and outlines.
// Items that no longer work against the live doc are tinted orange.

import * as THREE from 'three';
import { roadHalfWidth, type BuildingType, type CityDoc } from '@smartcity/shared';
import { closedRing } from '../app/ring';
import { ZONE_COLORS } from '../app/zoneColors';
import { proposalCatalog, proposalItems, proposalParcels, proposalRoads, type ProposalItem } from '../app/proposal';
import type { AiProposal } from '../app/aiChat';
import { bakeBuildingGeometry } from './buildingGeometry';
import { MeshBuilder } from './meshBuilder';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const ORANGE = '#fb923c';
const ROAD_COLOR = '#60a5fa';
const Y_ROAD = 0.3;
const Y_FILL = 0.25;

export class ProposalLayer {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.9 });
  private meshes: THREE.InstancedMesh[] = [];
  private fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false }));
  private lines = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  private proposal: AiProposal | null = null;
  private invalidKey = '';
  private version = 0;
  private items: ProposalItem[] = [];

  constructor() {
    this.group.name = 'proposal';
    for (const m of [this.fill, this.lines]) {
      m.frustumCulled = false;
      m.renderOrder = 15;
      this.group.add(m);
    }
  }

  /** Draw `proposal` (null = hide) with the given failing item indices. Rebuilds only on change. */
  set(doc: CityDoc, proposal: AiProposal | null, invalid: Record<number, string>, version = 0): void {
    const key = Object.keys(invalid).sort().join(',');
    if (proposal === this.proposal && key === this.invalidKey && version === this.version) return;
    this.version = version;
    if (proposal !== this.proposal) this.items = proposal ? proposalItems(proposal.commands) : [];
    this.proposal = proposal;
    this.invalidKey = key;
    this.clear();
    if (!proposal) return;
    this.build(doc, invalid);
  }

  private build(doc: CityDoc, invalid: Record<number, string>): void {
    const catalog = proposalCatalog(this.items);
    const byType = new Map<string, { index: number; x: number; z: number; r: number }[]>();
    for (const it of this.items) {
      if (it.cmd.type !== 'building.place') continue;
      const b = it.cmd.building;
      let list = byType.get(b.typeId);
      if (!list) byType.set(b.typeId, (list = []));
      list.push({ index: it.index, x: b.pos.x, z: b.pos.z, r: b.rotation });
    }
    for (const [typeId, list] of byType) {
      const type: BuildingType | undefined = catalog[typeId] ?? doc.buildingTypes[typeId];
      if (!type) continue;
      const mesh = new THREE.InstancedMesh(bakeBuildingGeometry(type), this.mat, list.length);
      mesh.name = `proposal-${typeId}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 14;
      list.forEach((p, i) => {
        _m.makeRotationY(p.r).setPosition(p.x, 0, p.z);
        mesh.setMatrixAt(i, _m);
        mesh.setColorAt(i, _c.set(p.index in invalid ? ORANGE : '#ffffff'));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    const fill = new MeshBuilder();
    const lines = new MeshBuilder();
    for (const { index, parcel } of proposalParcels(this.items)) {
      _c.set(index in invalid ? ORANGE : ZONE_COLORS[parcel.zone]);
      fill.polygon(parcel.polygon, Y_FILL, _c);
      lines.band(closedRing(parcel.polygon), -0.35, 0.35, Y_FILL + 0.02, _c);
    }
    // New roads: a translucent band as wide as the road (all pieces of one road share the item's color).
    for (const { index, pieces } of proposalRoads(doc, this.items, this.version)) {
      _c.set(index in invalid ? ORANGE : ROAD_COLOR);
      for (const piece of pieces) {
        const rt = doc.roadTypes[piece.roadTypeId];
        if (rt) fill.band(piece.points, -roadHalfWidth(rt), roadHalfWidth(rt), Y_ROAD, _c);
      }
    }
    this.setGeometry(this.fill, fill);
    this.setGeometry(this.lines, lines);
  }

  private setGeometry(mesh: THREE.Mesh, b: MeshBuilder): void {
    mesh.geometry.dispose();
    mesh.geometry = b.empty ? new THREE.BufferGeometry() : b.build();
    mesh.visible = !b.empty;
  }

  private clear(): void {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes = [];
    this.setGeometry(this.fill, new MeshBuilder());
    this.setGeometry(this.lines, new MeshBuilder());
  }

  dispose(): void {
    this.clear();
    this.mat.dispose();
    for (const m of [this.fill, this.lines]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
