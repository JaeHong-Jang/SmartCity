import { useMemo, useState } from 'react';
import { cloneJson, floorArea, type BuildingPart, type BuildingType, type RoofShape, type Zone } from '@smartcity/shared';
import { buildingPreview } from '../render/buildings';
import { useServices, useStore } from './context';
import { PartPreview } from './PartPreview';
import { clampInt, clampNum } from './RoadTypeEditor';
import { ZONE_KO } from './Toolbar';

const ROOF_KO: Record<RoofShape, string> = { flat: '평지붕', gable: '박공', pyramid: '모임' };

const newPart = (): BuildingPart => ({ offset: { x: 0, z: 0 }, width: 12, depth: 10, floors: 3, floorHeight: 3.2, baseHeight: 0, roof: 'flat', color: '#d9d4c7', roofColor: '#6b6b6b' });

export function BuildingEditor() {
  const { store, dispatcher } = useServices();
  const doc = useStore((s) => s.doc);
  useStore((s) => s.docVersion);
  const [selected, setSelected] = useState<string | null>(store.getState().toolOptions.buildingTypeId);
  const [draft, setDraft] = useState<BuildingType | null>(null);
  const bt = draft ?? (selected ? doc.buildingTypes[selected] : undefined);
  const inUse = bt ? Object.values(doc.buildings).filter((b) => b.typeId === bt.id).length : 0;
  const previewKey = useMemo(() => (bt ? JSON.stringify(bt.parts) : ''), [bt]);

  const edit = (p: Partial<BuildingType>) => setDraft({ ...cloneJson(bt as BuildingType), ...p });
  const editPart = (i: number, p: Partial<BuildingPart>) => {
    const parts = cloneJson((bt as BuildingType).parts);
    parts[i] = { ...parts[i]!, ...p };
    edit({ parts });
  };
  const create = () => {
    const id = dispatcher.ids().next('bt');
    setSelected(null);
    setDraft(bt ? { ...cloneJson(bt), id, name: `${bt.name} 사본` } : { id, name: '새 건물', zone: 'residential', parts: [newPart()] });
  };

  return (
    <>
      <div className="row">
        <h3 style={{ flex: 1 }}>건물 타입</h3>
        <button onClick={create}>+ 새 건물 타입</button>
      </div>
      <div className="list">
        {Object.values(doc.buildingTypes).map((t) => (
          <button
            key={t.id}
            className={bt?.id === t.id ? 'active' : ''}
            onClick={() => {
              setSelected(t.id);
              setDraft(null);
            }}
          >
            <span className="swatch" style={{ background: t.parts[0]?.color }} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span className="muted">
              {ZONE_KO[t.zone]} · {t.parts.length}파트
            </span>
          </button>
        ))}
      </div>
      {bt && (
        <>
          <hr />
          <PartPreview deps={previewKey} build={() => buildingPreview(bt.parts)} />
          <div className="row">
            <label>이름</label>
            <input type="text" value={bt.name} maxLength={80} onChange={(e) => edit({ name: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div className="row">
            <label>용도</label>
            <select value={bt.zone} onChange={(e) => edit({ zone: e.target.value as Zone })}>
              {Object.entries(ZONE_KO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <span className="muted">연면적 {Math.round(floorArea(bt)).toLocaleString()}㎡</span>
          </div>
          {bt.parts.map((p, i) => (
            <div key={i} className="part-card">
              <div className="part-head">
                <span>파트 {i + 1}</span>
                <button className="danger" disabled={bt.parts.length <= 1} onClick={() => edit({ parts: bt.parts.filter((_, j) => j !== i) })}>
                  삭제
                </button>
              </div>
              <label>
                X 오프셋
                <input type="number" step={1} value={p.offset.x} onChange={(e) => editPart(i, { offset: { ...p.offset, x: clampNum(e.target.value, -200, 200) } })} />
              </label>
              <label>
                Z 오프셋
                <input type="number" step={1} value={p.offset.z} onChange={(e) => editPart(i, { offset: { ...p.offset, z: clampNum(e.target.value, -200, 200) } })} />
              </label>
              <label>
                폭
                <input type="number" min={1} step={1} value={p.width} onChange={(e) => editPart(i, { width: clampNum(e.target.value, 1, 300) })} />
              </label>
              <label>
                깊이
                <input type="number" min={1} step={1} value={p.depth} onChange={(e) => editPart(i, { depth: clampNum(e.target.value, 1, 300) })} />
              </label>
              <label>
                층수
                <input type="number" min={1} max={200} value={p.floors} onChange={(e) => editPart(i, { floors: clampInt(e.target.value, 1, 200) })} />
              </label>
              <label>
                층고
                <input type="number" min={2} max={12} step={0.1} value={p.floorHeight} onChange={(e) => editPart(i, { floorHeight: clampNum(e.target.value, 2, 12) })} />
              </label>
              <label>
                시작 높이
                <input type="number" min={0} step={0.5} value={p.baseHeight} onChange={(e) => editPart(i, { baseHeight: clampNum(e.target.value, 0, 1000) })} />
              </label>
              <label>
                지붕
                <select value={p.roof} onChange={(e) => editPart(i, { roof: e.target.value as RoofShape })}>
                  {Object.entries(ROOF_KO).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                벽 색
                <input type="color" value={p.color} onChange={(e) => editPart(i, { color: e.target.value })} />
              </label>
              <label>
                지붕 색
                <input type="color" value={p.roofColor} onChange={(e) => editPart(i, { roofColor: e.target.value })} />
              </label>
            </div>
          ))}
          <button disabled={bt.parts.length >= 16} onClick={() => edit({ parts: [...bt.parts, newPart()] })}>
            + 파트 추가
          </button>
          <div className="row wrap">
            <button
              className="primary"
              disabled={!draft}
              onClick={() => {
                dispatcher.dispatch({ type: 'buildingType.upsert', buildingType: bt });
                setSelected(bt.id);
                setDraft(null);
              }}
            >
              저장
            </button>
            {draft && <button onClick={() => setDraft(null)}>되돌리기</button>}
            <button onClick={() => store.set({ tool: 'building', toolOptions: { ...store.getState().toolOptions, buildingTypeId: bt.id } })} disabled={!doc.buildingTypes[bt.id]}>
              배치하기
            </button>
            <div className="spacer" />
            <button
              className="danger"
              disabled={!doc.buildingTypes[bt.id] || inUse > 0}
              title={inUse > 0 ? `이 타입의 건물 ${inUse}동이 있어 삭제할 수 없습니다` : '건물 타입 삭제'}
              onClick={() => {
                dispatcher.dispatch({ type: 'buildingType.remove', id: bt.id });
                setSelected(null);
                setDraft(null);
              }}
            >
              타입 삭제
            </button>
          </div>
        </>
      )}
    </>
  );
}
