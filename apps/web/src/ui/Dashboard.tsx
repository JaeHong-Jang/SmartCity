// City dashboard (도시 현황, 설계 기준): designStats(doc) recomputed only when the doc changes, plus
// live traffic from this participant's own simulation (a per-viewer preview, ADR 0006/0007).

import { useMemo } from 'react';
import { designStats } from '@smartcity/shared';
import { useDoc, useStore } from './context';

const n0 = (v: number): string => Math.round(v).toLocaleString('ko-KR');

/** Demand bar in [-1, 1]: grows right from the center when the city wants more. */
function Demand({ label, value, color }: { label: string; value: number; color: string }) {
  const w = Math.abs(value) * 50;
  return (
    <div className="demand" title={`${label} 수요 ${Math.round(value * 100)}`}>
      <span className="muted">{label}</span>
      <div className="demand-track">
        <i className="demand-mid" />
        <i className="demand-fill" style={{ left: value >= 0 ? '50%' : `${50 - w}%`, width: `${w}%`, background: value >= 0 ? color : '#64748b' }} />
      </div>
      <b>{value >= 0 ? '+' : ''}{Math.round(value * 100)}</b>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="dash-stat">
      <span className="muted">{label}</span>
      <b>
        {value}
        {unit && <small> {unit}</small>}
      </b>
    </div>
  );
}

export function Dashboard({ onClose }: { onClose(): void }) {
  const { doc, version } = useDoc();
  const sim = useStore((s) => s.simStats);
  // The doc object is updated in place; docVersion is the change counter (bumps on every applied
  // command and on welcome/resync).
  const st = useMemo(() => designStats(doc), [version]);
  const solarShare = st.energyDemand > 0 ? Math.min(1, st.solarProduction / st.energyDemand) : 0;
  return (
    <section className="panel dashboard" aria-label="도시 현황">
      <div className="row">
        <h3 style={{ flex: 1 }}>도시 현황 (설계 기준)</h3>
        <button aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dash-grid">
        <Stat label="인구" value={n0(st.population)} unit="명" />
        <Stat label="일자리" value={n0(st.jobs)} unit="개" />
        <Stat label="건물" value={n0(st.buildings)} unit="동" />
        <Stat label="연면적" value={n0(st.grossFloorArea)} unit="㎡" />
      </div>
      <h4>설계 균형 (RCI)</h4>
      <Demand label="주거" value={st.demand.residential} color="#4ade80" />
      <Demand label="상업" value={st.demand.commercial} color="#60a5fa" />
      <Demand label="일자리" value={st.demand.workplaces} color="#facc15" />
      <h4>에너지 · 환경</h4>
      <div className="row">
        <span className="muted" style={{ flex: 1 }}>
          수요 {n0(st.energyDemand)} · 태양광 {n0(st.solarProduction)} kWh/일
        </span>
        <b>{Math.round(solarShare * 100)}%</b>
      </div>
      <div className="bar solar">
        <i style={{ width: `${solarShare * 100}%` }} />
      </div>
      <div className="dash-grid">
        <Stat label="CO₂" value={n0(st.co2)} unit="kg/일" />
        <Stat label="녹색 지붕" value={n0(st.greenRoofArea)} unit="㎡" />
        <Stat label="EV 충전기" value={n0(st.evChargers)} unit="기" />
        <Stat label="센서 건물" value={n0(st.sensorBuildings)} unit="동" />
        <Stat label="드론 포트" value={n0(st.dronePorts)} unit="곳" />
        <Stat label="필지" value={n0(st.parcels)} unit="개" />
      </div>
      <div className="row">
        <span className="muted" style={{ flex: 1 }}>
          규제 위반
        </span>
        <b className={st.violations ? 'warn' : 'ok'}>{st.violations}건</b>
      </div>
      <h4>시민 (시뮬레이션)</h4>
      <div className="dash-grid">
        <Stat label="설계 인구" value={n0(st.population)} unit="명" />
        <Stat label="시뮬 시민" value={n0(sim?.citizens?.total ?? 0)} unit="명" />
        <Stat label="집" value={n0(sim?.citizens?.home ?? 0)} unit="명" />
        <Stat label="직장·상점" value={n0(sim?.citizens?.atWork ?? 0)} unit="명" />
        <Stat label="보행" value={n0(sim?.citizens?.walking ?? 0)} unit="명" />
        <Stat label="운전" value={n0(sim?.citizens?.driving ?? 0)} unit="명" />
      </div>
      <span className="muted">설계 인구는 건물 면적 기준 추정치이고, 시뮬 시민은 이 화면의 시뮬레이션이 움직이는 에이전트 수입니다 (에이전트 1명 = 주민 {n0(sim?.citizens?.scale ?? 1)}명).</span>
      <h4>교통(내 화면 미리보기)</h4>
      <div className="dash-grid">
        <Stat label="차량" value={n0(sim?.vehicles ?? 0)} unit="대" />
        <Stat label="평균 속도" value={n0((sim?.avgSpeed ?? 0) * 3.6)} unit="km/h" />
        <Stat label="정지 차량" value={n0(sim?.stopped ?? 0)} unit="대" />
        <Stat label="도착" value={n0(sim?.arrived ?? 0)} unit="대" />
      </div>
    </section>
  );
}
