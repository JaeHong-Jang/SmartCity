import type { ReactNode } from 'react';
import { DEFAULT_REGULATIONS, ZONE_LABELS } from '@smartcity/shared';
import type { ToolId } from '../app/store';
import { PARCEL_ZONES, ZONE_COLORS } from '../tools/parcelTool';
import { useServices, useStore } from './context';
import { IconBuilding, IconBulldoze, IconBus, IconClosure, IconParcel, IconRoad, IconSelect } from './Icons';

export const TOOLS: { id: ToolId; label: string; key: string; icon: ReactNode }[] = [
  { id: 'select', label: '선택', key: '1', icon: <IconSelect /> },
  { id: 'road', label: '도로', key: '2', icon: <IconRoad /> },
  { id: 'building', label: '건물', key: '3', icon: <IconBuilding /> },
  { id: 'bulldoze', label: '철거', key: '4', icon: <IconBulldoze /> },
  { id: 'busLine', label: '버스', key: '5', icon: <IconBus /> },
  { id: 'closure', label: '폐쇄', key: '6', icon: <IconClosure /> },
  { id: 'parcel', label: '필지', key: '7', icon: <IconParcel /> },
];

export function Toolbar() {
  const { store } = useServices();
  const tool = useStore((s) => s.tool);
  return (
    <nav className="panel toolbar" aria-label="도구">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          title={`${t.label} (${t.key})`}
          data-tool={t.id}
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
  const doc = useStore((s) => s.doc);
  useStore((s) => s.docVersion);
  if (tool === 'road') {
    return (
      <section className="panel tool-options" aria-label="도로 도구 옵션">
        <h3>도로 타입</h3>
        <div className="list">
          {Object.values(doc.roadTypes).map((rt) => (
            <button key={rt.id} className={opts.roadTypeId === rt.id ? 'active' : ''} onClick={() => store.setToolOptions({ roadTypeId: rt.id })}>
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
            <button key={bt.id} className={opts.buildingTypeId === bt.id ? 'active' : ''} onClick={() => store.setToolOptions({ buildingTypeId: bt.id })}>
              <span className="swatch" style={{ background: bt.parts[0]?.color }} />
              <span style={{ flex: 1 }}>{bt.name}</span>
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
  return null;
}

export const ZONE_KO: Record<string, string> = { residential: '주거', commercial: '상업', office: '업무', industrial: '공업', public: '공공' };
