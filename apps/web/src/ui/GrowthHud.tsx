// HUD: RCI demand bars and the automatic growth switch (ADR 0009 §4).

import { useMemo } from 'react';
import { growthDemand, GROWTH_DEMAND_MIN, type DemandBars } from '../app/growthDemand';
import { useDoc, useServices } from './context';

const ROWS: { key: keyof DemandBars; label: string; color: string }[] = [
  { key: 'residential', label: '주거', color: '#4ade80' },
  { key: 'commercial', label: '상업', color: '#38bdf8' },
  { key: 'office', label: '업무', color: '#fbbf24' },
];

/** Bar fill for a demand in [-1, 1]: grows right from the center when positive, left when negative. */
export function demandBarStyle(value: number): { left: string; width: string } {
  const v = Math.max(-1, Math.min(1, value));
  return v >= 0 ? { left: '50%', width: `${v * 50}%` } : { left: `${50 + v * 50}%`, width: `${-v * 50}%` };
}

export function GrowthHud() {
  const { dispatcher } = useServices();
  const { doc, version } = useDoc();
  const demand = useMemo(() => growthDemand(doc), [doc, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = doc.meta.growth !== false;

  return (
    <div className="panel growth-hud" data-growth-hud aria-label="성장 수요">
      <div className="row">
        <b style={{ flex: 1 }}>성장 수요</b>
        <label className="toggle" title="켜면 조닝된 필지에 건물이 자동으로 자랍니다 (모든 참여자에게 적용)">
          <input type="checkbox" data-growth-toggle checked={on} onChange={(e) => dispatcher.dispatch({ type: 'meta.update', growth: e.target.checked })} />
          자동 성장
        </label>
      </div>
      {ROWS.map((r) => {
        const v = demand?.[r.key];
        return (
          <div key={r.key} className="demand-row" data-demand={r.key} title={v === undefined ? '계산 준비 중' : `수요 ${Math.round(v * 100)}% (${Math.round(GROWTH_DEMAND_MIN * 100)}% 초과일 때 성장)`}>
            <span>{r.label}</span>
            <div className="demand-bar">
              <i className="mid" />
              <i className="mark" style={{ left: `${50 + GROWTH_DEMAND_MIN * 50}%` }} />
              {v !== undefined && <i className="fill" style={{ ...demandBarStyle(v), background: v > GROWTH_DEMAND_MIN ? r.color : '#64748b' }} />}
            </div>
            <b>{v === undefined ? '–' : `${Math.round(v * 100)}%`}</b>
          </div>
        );
      })}
      <div className="demand-row" data-demand="industrial">
        <span>산업</span>
        <div className="demand-bar off" />
        <b className="muted">미지원</b>
      </div>
    </div>
  );
}
