// View controls at the foot of the toolbar (ADR 0013 §6): camera presets (the whole city from a low
// angle, and street level) and the zone-color overlay. Only these buttons and the first entry into a
// room move the camera on their own; collaborators' edits never do. View only, so they stay enabled
// in simulator mode.

import { useServices, useStore } from './context';

const IconCityView = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 20h18" />
    <path d="M5 20V11l4-2v11" />
    <path d="M9 20V5l6 3v12" />
    <path d="M15 20v-8l4 2v6" />
  </svg>
);

const IconEyeLevel = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

const IconZones = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4h8v7H3zM13 4h8v4h-8zM13 10h8v10h-8zM3 13h8v7H3z" />
  </svg>
);

export function ViewButtons() {
  const { store, viewCity, viewEyeLevel } = useServices();
  const overlays = useStore((s) => s.overlays);
  return (
    <>
      <div aria-hidden="true" style={{ flex: 'none', height: 1, margin: '2px 6px', background: 'var(--panel-border)' }} />
      <button className="tool-btn" data-view="city" title="도시 보기: 가장 밀집한 지역을 낮은 각도에서 · 한 번 더 누르면 도시 전체" onClick={viewCity}>
        <IconCityView />
        <span>도시 보기</span>
      </button>
      <button className="tool-btn" data-view="eye" title="눈높이 보기: 가까운 교차로에서 길을 따라" onClick={viewEyeLevel}>
        <IconEyeLevel />
        <span>눈높이</span>
      </button>
      <button
        className={`tool-btn ${overlays.zones ? 'active' : ''}`}
        data-overlay="zones"
        aria-pressed={overlays.zones}
        title="용도지역 색: 필지를 용도지역 색으로 칠하기 (필지·조닝 도구에서는 항상 표시)"
        onClick={() => store.set({ overlays: { ...overlays, zones: !overlays.zones } })}
      >
        <IconZones />
        <span>용도지역</span>
      </button>
    </>
  );
}
