import { useState } from 'react';
import { cloneJson, roadHalfWidth, type RoadType } from '@smartcity/shared';
import { useDoc, useServices } from './context';

const kmh = (ms: number): number => Math.round(ms * 3.6);

export function RoadTypeEditor() {
  const { store, dispatcher } = useServices();
  const { doc } = useDoc();
  const [selected, setSelected] = useState<string | null>(Object.keys(doc.roadTypes)[0] ?? null);
  const [draft, setDraft] = useState<RoadType | null>(null);
  const base = selected ? doc.roadTypes[selected] : undefined;
  const rt = draft ?? base;

  const select = (id: string) => {
    setSelected(id);
    setDraft(null);
  };
  const patch = (p: Partial<RoadType>) => setDraft({ ...(rt as RoadType), ...p });
  const create = () => {
    const id = dispatcher.ids().next('rt');
    const src = rt ?? Object.values(doc.roadTypes)[0]!;
    setSelected(null);
    setDraft({ ...cloneJson(src), id, name: `${src.name} 사본` });
  };
  const save = () => {
    if (!rt) return;
    dispatcher.dispatch({ type: 'roadType.upsert', roadType: rt });
    setSelected(rt.id);
    setDraft(null);
    store.setToolOptions({ roadTypeId: rt.id });
  };

  return (
    <>
      <div className="row">
        <h3 style={{ flex: 1 }}>도로 타입</h3>
        <button onClick={create}>+ 새 도로 타입</button>
      </div>
      <div className="list">
        {Object.values(doc.roadTypes).map((t) => (
          <button key={t.id} className={rt?.id === t.id ? 'active' : ''} onClick={() => select(t.id)}>
            <span className="swatch" style={{ background: t.busOnlyRightLane ? '#9a3434' : '#3b3f45' }} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span className="muted">
              {t.lanesForward}+{t.lanesBackward} · {kmh(t.speedLimit)}km/h
            </span>
          </button>
        ))}
      </div>
      {rt && (
        <>
          <hr />
          <div className="row">
            <label>이름</label>
            <input type="text" value={rt.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div className="row">
            <label>정방향 차선</label>
            <input type="number" min={1} max={4} value={rt.lanesForward} onChange={(e) => patch({ lanesForward: clampInt(e.target.value, 1, 4) })} />
            <label>역방향</label>
            <input type="number" min={0} max={4} value={rt.lanesBackward} onChange={(e) => patch({ lanesBackward: clampInt(e.target.value, 0, 4) })} />
          </div>
          <div className="row">
            <label>차선 폭 (m)</label>
            <input type="number" min={2.5} max={5} step={0.1} value={rt.laneWidth} onChange={(e) => patch({ laneWidth: clampNum(e.target.value, 2.5, 5) })} />
            <label>제한속도</label>
            <input type="number" min={10} max={140} step={5} value={kmh(rt.speedLimit)} onChange={(e) => patch({ speedLimit: clampNum(e.target.value, 8, 144) / 3.6 })} />
            <span className="muted">km/h</span>
          </div>
          <div className="row wrap">
            <label className="toggle">
              <input type="checkbox" checked={rt.sidewalk} onChange={(e) => patch({ sidewalk: e.target.checked })} /> 인도
            </label>
            <label className="toggle">
              <input type="checkbox" checked={rt.busOnlyRightLane} onChange={(e) => patch({ busOnlyRightLane: e.target.checked })} /> 버스전용 (최우측 차선)
            </label>
          </div>
          <span className="muted">
            {rt.lanesBackward === 0 ? '일방통행' : '양방향'} · 전체 폭 {(roadHalfWidth(rt) * 2).toFixed(1)}m
          </span>
          <div className="row">
            <button className="primary" onClick={save} disabled={!draft}>
              저장
            </button>
            {draft && <button onClick={() => setDraft(null)}>되돌리기</button>}
          </div>
        </>
      )}
    </>
  );
}

export function clampNum(v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function clampInt(v: string, min: number, max: number): number {
  return Math.round(clampNum(v, min, max));
}
