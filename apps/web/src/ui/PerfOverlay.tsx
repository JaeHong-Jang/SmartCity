// Development performance overlay (ADR 0013 §7): frame time percentiles, main vs shadow-pass draw
// calls, triangles and vehicle interpolation CPU time. Dev server only; toggled with the ` key
// (or opened with ?perf=1).

import { useEffect, useState } from 'react';
import { useStore } from './context';

const fmt = (v: number | undefined, d = 1): string => (v === undefined ? '–' : v.toFixed(d));

export function PerfOverlay() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('perf') === '1');
  const r = useStore((s) => s.render);
  const vehicles = useStore((s) => s.simStats?.vehicles ?? 0);
  const shadows = useStore((s) => s.overlays.shadows);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.code === 'Backquote' && !e.ctrlKey && !e.metaKey && !e.altKey) setOpen((o) => !o);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!open) return null;
  const shadow = r.shadowCalls ?? 0;
  return (
    <div
      className="perf-overlay"
      data-perf-overlay
      style={{ position: 'fixed', left: 84, bottom: 60, zIndex: 40, padding: '6px 10px', font: '11px/1.45 ui-monospace, monospace', color: '#e2e8f0', background: 'rgba(15,23,42,0.82)', borderRadius: 6, pointerEvents: 'none', whiteSpace: 'pre' }}
    >
      {`프레임 ms  p50 ${fmt(r.frameMs?.p50)}  p95 ${fmt(r.frameMs?.p95)}  p99 ${fmt(r.frameMs?.p99)}  (${r.fps} fps)
드로우콜  메인 ${r.drawCalls - shadow}  그림자 ${shadow}${shadows ? '' : ' (꺼짐)'}
삼각형    ${(r.triangles / 1000).toFixed(0)}k  (그림자 ${((r.shadowTriangles ?? 0) / 1000).toFixed(0)}k)
보간 CPU  평균 ${fmt(r.interpMs?.mean, 2)} ms  최대 ${fmt(r.interpMs?.max, 2)} ms  · 차량 ${vehicles}`}
    </div>
  );
}
