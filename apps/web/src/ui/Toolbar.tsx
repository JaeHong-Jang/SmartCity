import type { ReactNode } from 'react';
import { DEFAULT_REGULATIONS, ZONE_LABELS } from '@smartcity/shared';
import type { StreetMode, ToolId } from '../app/store';
import { ZONE_COLORS } from '../app/zoneColors';
import { PARCEL_ZONES } from '../tools/parcelTool';
import { TOOL_META } from '../tools/toolMeta';
import { AiBadge } from './AiBadge';
import { useSimMode } from '../simmode/store';
import { useDoc, useServices, useStore } from './context';
import { IconBuilding, IconBulldoze, IconBus, IconClosure, IconParcel, IconRoad, IconSelect } from './Icons';

const IconStreet = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8h18M3 16h18" />
    <path d="M8 9.5v5M12 9.5v5M16 9.5v5" />
  </svg>
);

const IconZoning = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 17h18" />
    <rect x={4} y={6} width={6} height={8} />
    <rect x={14} y={6} width={6} height={8} />
  </svg>
);

const STREET_MODES: { id: StreetMode; label: string }[] = [
  { id: 'crosswalk', label: '횡단보도' },
  { id: 'signalCrosswalk', label: '신호 횡단보도' },
  { id: 'speedBump', label: '과속방지턱' },
  { id: 'schoolZone', label: '어린이보호구역' },
  { id: 'remove', label: '제거' },
];

const TOOL_ICONS: Record<ToolId, ReactNode> = {
  select: <IconSelect />,
  road: <IconRoad />,
  building: <IconBuilding />,
  bulldoze: <IconBulldoze />,
  busLine: <IconBus />,
  closure: <IconClosure />,
  parcel: <IconParcel />,
  street: <IconStreet />,
  zoning: <IconZoning />,
};

export const TOOLS: { id: ToolId; label: string; key: string; icon: ReactNode }[] = TOOL_META.map((t) => ({ ...t, icon: TOOL_ICONS[t.id] }));

export function Toolbar() {
  const { store } = useServices();
  const tool = useStore((s) => s.tool);
  const simActive = useSimMode((s) => s.phase !== 'off');
  return (
    <nav className="panel toolbar" aria-label="도구">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          title={`${t.label} (${t.key})`}
          data-tool={t.id}
          disabled={simActive}
          onClick={() => store.set({ tool: t.id })}
        >
          {t.icon}
          <span>{t.label}</span>
          <span className="key">{t.key}</span>
        </button>
      ))}
    </nav>
  );
}

export function ToolOptions() {
  const { store } = useServices();
  const tool = useStore((s) => s.tool);
  const opts = useStore((s) => s.toolOptions);
  const { doc } = useDoc();
  if (tool === 'road') {
    return (
      <section className="panel tool-options" aria-label="도로 도구 옵션">
        <h3>도로 타입</h3>
        <div className="list">
          {Object.values(doc.roadTypes).map((rt) => (
            <button key={rt.id} data-road-type={rt.id} className={opts.roadTypeId === rt.id ? 'active' : ''} onClick={() => store.setToolOptions({ roadTypeId: rt.id })}>
              <span className="swatch" style={{ background: rt.busOnlyRightLane ? '#9a3434' : '#3b3f45' }} />
              <span style={{ flex: 1 }}>{rt.name}</span>
              <span className="muted">{rt.lanesForward + rt.lanesBackward}차선</span>
            </button>
          ))}
        </div>
        <div className="row wrap">
          <button className={opts.curve ? 'active' : ''} onClick={() => store.setToolOptions({ curve: !opts.curve })}>
            곡선 (C)
          </button>
        </div>
        <span className="muted">클릭으로 이어 그리기 · 격자 스냅은 하단 바/G · 우클릭/Esc 취소</span>
      </section>
    );
  }
  if (tool === 'building') {
    return (
      <section className="panel tool-options" aria-label="건물 도구 옵션">
        <h3>건물 타입</h3>
        <div className="list">
          {Object.values(doc.buildingTypes).map((bt) => (
            <button key={bt.id} data-building-type={bt.id} className={opts.buildingTypeId === bt.id ? 'active' : ''} onClick={() => store.setToolOptions({ buildingTypeId: bt.id })}>
              <span className="swatch" style={{ background: bt.parts[0]?.color }} />
              <span style={{ flex: 1 }}>{bt.name}</span>
              <AiBadge type={bt} />
              <span className="muted">{ZONE_KO[bt.zone]}</span>
            </button>
          ))}
        </div>
        <span className="muted">도로 40m 이내에서 자동 정렬 · Shift 자유 배치 · , . 회전</span>
      </section>
    );
  }
  if (tool === 'parcel') {
    return (
      <section className="panel tool-options" aria-label="필지 도구 옵션">
        <h3>용도지역</h3>
        <div className="list">
          {PARCEL_ZONES.map((z) => {
            const r = DEFAULT_REGULATIONS[z];
            return (
              <button key={z} data-zone={z} className={opts.parcelZone === z ? 'active' : ''} onClick={() => store.setToolOptions({ parcelZone: z })}>
                <span className="swatch" style={{ background: ZONE_COLORS[z] }} />
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{ZONE_LABELS[z]}</span>
                <span className="muted">
                  건폐 {Math.round(r.coverage * 100)}% · 용적 {Math.round(r.far * 100)}%
                </span>
              </button>
            );
          })}
        </div>
        <div className="row wrap">
          <button className={!opts.parcelPolygon ? 'active' : ''} onClick={() => store.setToolOptions({ parcelPolygon: false })}>
            사각형
          </button>
          <button className={opts.parcelPolygon ? 'active' : ''} onClick={() => store.setToolOptions({ parcelPolygon: true })}>
            다각형 (P)
          </button>
        </div>
        <span className="muted">{opts.parcelPolygon ? '꼭짓점 클릭 · Enter/첫 점 클릭으로 닫기' : '드래그로 사각형'} · 규제값은 인스펙터에서 수정</span>
      </section>
    );
  }
  if (tool === 'zoning') {
    return (
      <section className="panel tool-options" aria-label="조닝 도구 옵션">
        <h3>조닝 (도로를 따라 자동 성장 필지)</h3>
        <div className="list">
          {(['residential', 'commercial', 'office'] as const).map((z) => (
            <button key={z} data-zoning-zone={z} className={!opts.zoningErase && opts.zoningZone === z ? 'active' : ''} onClick={() => store.setToolOptions({ zoningZone: z, zoningErase: false })}>
              <span className="swatch" style={{ background: ZONE_COLORS[z] }} />
              <span style={{ flex: 1 }}>{ZONE_LABELS[z]}</span>
            </button>
          ))}
          <button data-zoning-erase className={opts.zoningErase ? 'active' : ''} onClick={() => store.setToolOptions({ zoningErase: !opts.zoningErase })}>
            <span style={{ flex: 1 }}>지우기</span>
          </button>
        </div>
        <div className="row wrap">
          <label>깊이</label>
          {([1, 2, 3, 4] as const).map((d) => (
            <button key={d} data-zoning-depth={d} className={opts.zoningDepth === d ? 'active' : ''} onClick={() => store.setToolOptions({ zoningDepth: d })} title={`${d * 8}m`}>
              {d}칸
            </button>
          ))}
        </div>
        <span className="muted">도로 옆에서 드래그 · [ ] 깊이(8m/칸) · 지우기는 건물이 없는 자동 필지만 · Esc 취소</span>
      </section>
    );
  }
  if (tool === 'street') {
    return (
      <section className="panel tool-options" aria-label="교통 시설 도구 옵션">
        <h3>교통 시설</h3>
        <div className="list">
          {STREET_MODES.map((m) => (
            <button key={m.id} data-street-mode={m.id} className={opts.streetMode === m.id ? 'active' : ''} onClick={() => store.setToolOptions({ streetMode: m.id })}>
              <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{m.label}</span>
            </button>
          ))}
        </div>
        <span className="muted">구간 끝 12m·시설 간 6m 이상 · 시설 클릭 = 신호 전환 · Delete/우클릭 제거 · 교차로 클릭 = 속성 패널</span>
      </section>
    );
  }
  return null;
}

export const ZONE_KO: Record<string, string> = { residential: '주거', commercial: '상업', office: '업무', industrial: '공업', public: '공공' };
