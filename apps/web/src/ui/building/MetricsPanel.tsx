// Live indicators of the design being edited (per building).

import { Fragment } from 'react';
import type { BuildingType, Zone } from '@smartcity/shared';
import { ZONE_KO } from '../Toolbar';
import { designEstimates } from './designDraft';

const n0 = (v: number): string => Math.round(v).toLocaleString();

export function MetricsPanel({ type }: { type: BuildingType }) {
  const m = designEstimates(type);
  const uses = (Object.keys(m.areaByUse) as Zone[]).filter((u) => m.areaByUse[u] > 0);
  const selfShare = m.energy > 0 ? Math.round((m.solar / m.energy) * 100) : 0;
  const rows: [string, string][] = [
    ['연면적', `${n0(m.grossFloorArea)}㎡`],
    ['건축면적', `${n0(m.footprintArea)}㎡`],
    ['높이', `${Math.round(m.height * 10) / 10}m`],
    ['용도별 면적', uses.map((u) => `${ZONE_KO[u]} ${n0(m.areaByUse[u])}㎡`).join(' · ') || '—'],
    ['예상 거주 인구', `${n0(m.residents)}명`],
    ['예상 일자리', `${n0(m.jobs)}개`],
    ['에너지 수요', `${n0(m.energy)} kWh/일`],
    ['태양광 발전', `${n0(m.solar)} kWh/일 (자립 ${selfShare}%)`],
  ];
  return (
    <div className="bp-metrics">
      <h3>설계 지표 (1동 기준)</h3>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
