// Urban-design inspector parts: the parcel inspector (zone, regulation, compliance, violations) and
// the planning block of the building inspector (parcel, metrics, smart features).

import { useEffect, useState } from 'react';
import {
  buildingMetrics,
  DEFAULT_REGULATIONS,
  parcelCompliance,
  pointInPolygon,
  ZONE_LABELS,
  type CityDoc,
  type Parcel,
  type ParcelZone,
  type Regulation,
  type Violation,
  type Zone,
} from '@smartcity/shared';
import { closedRing } from '../app/ring';
import { ZONE_COLORS } from '../app/zoneColors';
import { PARCEL_ZONES } from '../tools/parcelTool';
import { formatArea } from '../render/parcels';
import { useDoc, useServices } from './context';
import { clampNum } from './RoadTypeEditor';
import { ZONE_KO } from './Toolbar';

const pct = (v: number): string => `${Math.round(v * 100)}%`;

function buildingName(doc: CityDoc, id: string): string {
  const b = doc.buildings[id];
  return (b && doc.buildingTypes[b.typeId]?.name) || '건물';
}

/** One violation in Korean. */
export function violationText(doc: CityDoc, parcel: Parcel, v: Violation): string {
  const who = v.buildingId ? `${buildingName(doc, v.buildingId)}: ` : '';
  switch (v.kind) {
    case 'coverage':
      return `건폐율 ${pct(v.value as number)} — 한도 ${pct(v.limit as number)} 초과`;
    case 'far':
      return `용적률 ${pct(v.value as number)} — 한도 ${pct(v.limit as number)} 초과`;
    case 'height':
      return `${who}높이 ${(v.value as number).toFixed(1)}m — 최고 ${v.limit}m 초과`;
    case 'setback':
      return `${who}경계 후퇴 ${(v.value as number).toFixed(1)}m — ${v.limit}m 이상 필요`;
    case 'outside':
      return `${who}필지 경계를 벗어남`;
    case 'use':
      return `${who}${ZONE_KO[v.value as string] ?? v.value} 용도는 ${ZONE_LABELS[parcel.zone]}에서 허용되지 않음`;
  }
}

export function parcelOf(doc: CityDoc, buildingId: string): Parcel | undefined {
  const b = doc.buildings[buildingId];
  if (!b) return undefined;
  return Object.keys(doc.parcels)
    .sort()
    .map((id) => doc.parcels[id]!)
    .find((pc) => pointInPolygon(b.pos, pc.polygon));
}

function Violations({ doc, parcel, violations }: { doc: CityDoc; parcel: Parcel; violations: Violation[] }) {
  const { store, focus } = useServices();
  if (!violations.length) return <span className="ok-note">규제 위반 없음</span>;
  return (
    <ul className="violations" aria-label="규제 위반">
      {violations.map((v, i) => {
        const b = v.buildingId ? doc.buildings[v.buildingId] : undefined;
        return (
          <li key={i}>
            {b ? (
              <button
                title="이 건물로 이동"
                onClick={() => {
                  focus(b.pos);
                  store.set({ selection: { kind: 'building', id: b.id } });
                }}
              >
                {violationText(doc, parcel, v)}
              </button>
            ) : (
              <span>{violationText(doc, parcel, v)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Gauge({ label, value, limit, unit }: { label: string; value: number; limit: number; unit: 'pct' | 'm' }) {
  const over = value > limit + 1e-9;
  const fmt = (x: number) => (unit === 'pct' ? pct(x) : `${x.toFixed(1)}m`);
  const ratio = limit > 0 ? Math.min(1, value / limit) : value > 0 ? 1 : 0;
  return (
    <div className="gauge" data-over={over}>
      <div className="row">
        <span className="muted" style={{ flex: 1 }}>
          {label}
        </span>
        <b>{fmt(value)}</b>
        <span className="muted">/ {fmt(limit)}</span>
      </div>
      <div className="bar">
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function ParcelInspector({ id }: { id: string }) {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const pc = doc.parcels[id]!;
  const [zone, setZone] = useState<ParcelZone>(pc.zone);
  const [reg, setReg] = useState<Regulation>(pc.regulation);
  // Reset the form when the stored parcel changes (local apply or a collaborator's edit).
  useEffect(() => {
    setZone(pc.zone);
    setReg(pc.regulation);
  }, [pc]);
  const c = parcelCompliance(doc, pc);
  const dirty = zone !== pc.zone || JSON.stringify(reg) !== JSON.stringify(pc.regulation);
  const setNum = (k: keyof Regulation, v: number) => setReg({ ...reg, [k]: v });

  return (
    <>
      <h3>필지</h3>
      <dl className="kv">
        <dt>용도지역</dt>
        <dd>
          <span className="swatch inline" style={{ background: ZONE_COLORS[pc.zone] }} /> {ZONE_LABELS[pc.zone]}
        </dd>
        <dt>면적</dt>
        <dd>{formatArea(c.area)}</dd>
        <dt>건물</dt>
        <dd>{c.buildingIds.length}동</dd>
        <dt>최고 높이</dt>
        <dd>
          {c.maxHeight.toFixed(1)}m / 한도 {pc.regulation.maxHeight}m
        </dd>
        <dt>후퇴 거리</dt>
        <dd>{pc.regulation.setback}m</dd>
      </dl>
      <Gauge label="건폐율" value={c.coverage} limit={pc.regulation.coverage} unit="pct" />
      <Gauge label="용적률" value={c.far} limit={pc.regulation.far} unit="pct" />
      <h3>규제 위반 {c.violations.length > 0 && `(${c.violations.length})`}</h3>
      <Violations doc={doc} parcel={pc} violations={c.violations} />
      <hr />
      <h3>규제 편집</h3>
      <div className="row">
        <label>용도지역</label>
        <select
          value={zone}
          style={{ flex: 1 }}
          onChange={(e) => {
            const z = e.target.value as ParcelZone;
            setZone(z);
            setReg({ ...DEFAULT_REGULATIONS[z] });
          }}
        >
          {PARCEL_ZONES.map((z) => (
            <option key={z} value={z}>
              {ZONE_LABELS[z]}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>건폐율</label>
        <input type="number" aria-label="건폐율 %" min={0} max={100} step={5} value={Math.round(reg.coverage * 100)} onChange={(e) => setNum('coverage', clampNum(e.target.value, 0, 100) / 100)} />
        <span className="muted">%</span>
        <label style={{ minWidth: 0 }}>용적률</label>
        <input type="number" aria-label="용적률 %" min={0} max={2000} step={10} value={Math.round(reg.far * 100)} onChange={(e) => setNum('far', clampNum(e.target.value, 0, 2000) / 100)} />
        <span className="muted">%</span>
      </div>
      <div className="row">
        <label>최고 높이</label>
        <input type="number" aria-label="최고 높이" min={0} max={1000} value={reg.maxHeight} onChange={(e) => setNum('maxHeight', clampNum(e.target.value, 0, 1000))} />
        <span className="muted">m</span>
        <label style={{ minWidth: 0 }}>후퇴</label>
        <input type="number" aria-label="후퇴 거리" min={0} max={50} step={0.5} value={reg.setback} onChange={(e) => setNum('setback', clampNum(e.target.value, 0, 50))} />
        <span className="muted">m</span>
      </div>
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => dispatcher.dispatch({ type: 'parcel.upsert', parcel: { ...pc, zone, regulation: reg } })}>
          적용
        </button>
        <button onClick={() => setReg({ ...DEFAULT_REGULATIONS[zone] })}>기본값</button>
      </div>
      <span className="muted">꼭짓점을 드래그해 경계를 바꿀 수 있습니다 · Delete 철거</span>
      <button className="danger" onClick={() => dispatcher.dispatch({ type: 'parcel.remove', id }, [closedRing(pc.polygon)])}>
        필지 철거
      </button>
    </>
  );
}

const USE_ORDER: Zone[] = ['residential', 'commercial', 'office', 'industrial', 'public'];

/** Parcel, metrics and smart features of a building (part of the building inspector). */
export function BuildingPlanning({ id }: { id: string }) {
  const { store } = useServices();
  const { doc } = useDoc();
  const b = doc.buildings[id]!;
  const type = doc.buildingTypes[b.typeId];
  if (!type) return null;
  const m = buildingMetrics(type);
  const parcel = parcelOf(doc, id);
  const mine = parcel ? parcelCompliance(doc, parcel).violations.filter((v) => v.buildingId === id || !v.buildingId) : [];
  const smart = type.smart;
  return (
    <>
      <hr />
      <h3>필지</h3>
      {parcel ? (
        <>
          <button className="link" onClick={() => store.set({ selection: { kind: 'parcel', id: parcel.id } })}>
            <span className="swatch inline" style={{ background: ZONE_COLORS[parcel.zone] }} /> {ZONE_LABELS[parcel.zone]} · {formatArea(parcelCompliance(doc, parcel).area)} 보기
          </button>
          {mine.length > 0 ? <Violations doc={doc} parcel={parcel} violations={mine} /> : <span className="ok-note">규제 위반 없음</span>}
        </>
      ) : (
        <span className="muted">필지 밖 (규제 검사 없음)</span>
      )}
      <h3>건축 지표</h3>
      <dl className="kv">
        <dt>연면적</dt>
        <dd>{formatArea(m.grossFloorArea)}</dd>
        <dt>건축면적</dt>
        <dd>{formatArea(m.footprintArea)}</dd>
        <dt>높이</dt>
        <dd>{m.height.toFixed(1)}m</dd>
        {USE_ORDER.filter((u) => m.areaByUse[u] > 0).map((u) => (
          <div key={u} style={{ display: 'contents' }}>
            <dt>{ZONE_KO[u]} 면적</dt>
            <dd>{formatArea(m.areaByUse[u])}</dd>
          </div>
        ))}
      </dl>
      <h3>스마트 설비</h3>
      {smart ? (
        <dl className="kv">
          <dt>태양광 지붕</dt>
          <dd>{pct(smart.solarRoof)}</dd>
          <dt>녹색 지붕</dt>
          <dd>{pct(smart.greenRoof)}</dd>
          <dt>EV 충전기</dt>
          <dd>{smart.evChargers}기</dd>
          <dt>IoT 센서</dt>
          <dd>{smart.sensors ? '있음' : '없음'}</dd>
          <dt>드론 포트</dt>
          <dd>{smart.dronePort ? '있음' : '없음'}</dd>
        </dl>
      ) : (
        <span className="muted">스마트 설비 없음 (건물 탭에서 설계 편집)</span>
      )}
    </>
  );
}
