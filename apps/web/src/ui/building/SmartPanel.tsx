// Smart-city equipment of a design. Solar, planting and the drone pad share one roof-area budget.

import type { SmartFeatures } from '@smartcity/shared';
import { clampInt } from '../RoadTypeEditor';
import { NO_SMART, roofBudget } from './designDraft';

export function SmartPanel({ smart, onChange }: { smart: SmartFeatures | undefined; onChange(s: SmartFeatures): void }) {
  const s = smart ?? NO_SMART;
  const set = (patch: Partial<SmartFeatures>) => onChange({ ...s, ...patch });
  const used = roofBudget(s);
  const over = used > 1 + 1e-9;
  const pct = (v: number) => `${Math.min(100, v * 100)}%`;
  return (
    <div className="bp-smart">
      <h3>스마트 설비</h3>
      <label className="bp-slider">
        <span>태양광 지붕</span>
        <input type="range" min={0} max={100} step={5} value={Math.round(s.solarRoof * 100)} onChange={(e) => set({ solarRoof: Number(e.target.value) / 100 })} />
        <span className="bp-num">{Math.round(s.solarRoof * 100)}%</span>
      </label>
      <label className="bp-slider">
        <span>녹색 지붕</span>
        <input type="range" min={0} max={100} step={5} value={Math.round(s.greenRoof * 100)} onChange={(e) => set({ greenRoof: Number(e.target.value) / 100 })} />
        <span className="bp-num">{Math.round(s.greenRoof * 100)}%</span>
      </label>
      <div className="row wrap">
        <label className="toggle">
          <input type="checkbox" checked={s.dronePort} onChange={(e) => set({ dronePort: e.target.checked })} />
          드론 포트(지붕 10%)
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.sensors} onChange={(e) => set({ sensors: e.target.checked })} />
          IoT 센서
        </label>
        <label className="toggle">
          EV 충전기
          <input type="number" min={0} max={500} value={s.evChargers} style={{ width: 64 }} onChange={(e) => set({ evChargers: clampInt(e.target.value, 0, 500) })} />
        </label>
      </div>
      <div className={`bp-budget${over ? ' over' : ''}`} title="지붕 면적 예산">
        <span className="solar" style={{ width: pct(s.solarRoof) }} />
        <span className="green" style={{ width: pct(s.greenRoof) }} />
        {s.dronePort && <span className="pad" style={{ width: '10%' }} />}
      </div>
      <div className={over ? 'bp-error' : 'muted'}>
        지붕 사용 {Math.round(used * 100)}% / 100%{over ? ' — 지붕 면적을 넘어 저장할 수 없습니다' : ''}
      </div>
    </div>
  );
}
