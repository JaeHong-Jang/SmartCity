// Dependency-free SVG line chart: smart response ON vs OFF over the same sim-tick axis.

import { ticksToGameMin } from '../../simmode/time';
import type { AlignedRow, KpiMetric } from '../../simmode/kpiSeries';

const W = 250;
const H = 120;
const PAD = { l: 38, r: 8, t: 8, b: 20 };

function path(rows: AlignedRow[], side: 'on' | 'off', metric: KpiMetric, x: (t: number) => number, y: (v: number) => number): string {
  const pts: string[] = [];
  for (const r of rows) {
    const k = r[side];
    if (k) pts.push(`${x(r.tick).toFixed(1)},${y(metric.get(k)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function fmt(v: number): string {
  return Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}

export function KpiChart({ rows, metric }: { rows: AlignedRow[]; metric: KpiMetric }) {
  const first = rows[0]?.tick ?? 0;
  const last = rows[rows.length - 1]?.tick ?? first + 1;
  let max = 0;
  for (const r of rows) for (const k of [r.on, r.off]) if (k) max = Math.max(max, metric.get(k));
  if (max <= 0) max = 1;
  const x = (t: number) => PAD.l + ((t - first) / Math.max(1, last - first)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  return (
    <figure className="sim-chart" data-metric={metric.id}>
      <figcaption>
        {metric.label} <span className="muted">({metric.unit})</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric.label}: 스마트 대응 ON/OFF 비교`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} />
            <text className="axis" x={PAD.l - 4} y={y(max * f) + 3} textAnchor="end">
              {fmt(max * f)}
            </text>
          </g>
        ))}
        <text className="axis" x={PAD.l} y={H - 6}>
          {Math.round(ticksToGameMin(first))}분
        </text>
        <text className="axis" x={W - PAD.r} y={H - 6} textAnchor="end">
          {Math.round(ticksToGameMin(last))}분
        </text>
        <polyline className="line off" data-simmode-line="off" points={path(rows, 'off', metric, x, y)} />
        <polyline className="line on" data-simmode-line="on" points={path(rows, 'on', metric, x, y)} />
      </svg>
    </figure>
  );
}
