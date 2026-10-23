import { useMemo, useState } from 'react';
import { cloneJson, type VehicleKind, type VehiclePart, type VehicleType } from '@smartcity/shared';
import { DEFAULT_BUS_CAPACITY } from '../app/transit';
import { vehiclePreview } from '../render/vehicles';
import { useDoc, useServices } from './context';
import { PartPreview } from './PartPreview';
import { clampNum } from './RoadTypeEditor';

const KIND_KO: Record<VehicleKind, string> = { car: '승용', bus: '버스', truck: '화물', emergency: '긴급' };
const newPart = (): VehiclePart => ({ offset: { x: 0, y: 0.3, z: 0 }, length: 2, width: 1.6, height: 0.8, color: '#cbd5e1' });

export function VehicleEditor() {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const [selected, setSelected] = useState<string | null>(Object.keys(doc.vehicleTypes)[0] ?? null);
  const [draft, setDraft] = useState<VehicleType | null>(null);
  const vt = draft ?? (selected ? doc.vehicleTypes[selected] : undefined);
  const inUse = vt ? Object.values(doc.busLines).some((l) => l.vehicleTypeId === vt.id) : false;
  const previewKey = useMemo(() => (vt ? JSON.stringify(vt.parts) : ''), [vt]);

  const edit = (p: Partial<VehicleType>) => setDraft({ ...cloneJson(vt as VehicleType), ...p });
  const editPart = (i: number, p: Partial<VehiclePart>) => {
    const parts = cloneJson((vt as VehicleType).parts);
    parts[i] = { ...parts[i]!, ...p };
    edit({ parts });
  };
  const num = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, unit?: string) => (
    <div className="row">
      <label>{label}</label>
      <input type="number" min={min} max={max} step={step} value={Math.round(value * 100) / 100} onChange={(e) => set(clampNum(e.target.value, min, max))} />
      {unit && <span className="muted">{unit}</span>}
    </div>
  );

  return (
    <>
      <div className="row">
        <h3 style={{ flex: 1 }}>차량 타입</h3>
        <button
          onClick={() => {
            const id = dispatcher.ids().next('vt');
            setSelected(null);
            setDraft(vt ? { ...cloneJson(vt), id, name: `${vt.name} 사본` } : null);
          }}
        >
          + 새 차량 타입
        </button>
      </div>
      <div className="list">
        {Object.values(doc.vehicleTypes).map((t) => (
          <button
            key={t.id}
            className={vt?.id === t.id ? 'active' : ''}
            onClick={() => {
              setSelected(t.id);
              setDraft(null);
            }}
          >
            <span className="swatch" style={{ background: t.color }} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span className="muted">
              {KIND_KO[t.kind]} · 비중 {t.spawnWeight}
            </span>
          </button>
        ))}
      </div>
      {vt && (
        <>
          <hr />
          <PartPreview deps={previewKey} build={() => vehiclePreview(vt.parts)} />
          <div className="row">
            <label>이름</label>
            <input type="text" value={vt.name} maxLength={80} onChange={(e) => edit({ name: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div className="row">
            <label>종류</label>
            <select value={vt.kind} onChange={(e) => edit({ kind: e.target.value as VehicleKind })}>
              {Object.entries(KIND_KO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <label style={{ minWidth: 0 }}>대표 색</label>
            <input type="color" value={vt.color} onChange={(e) => edit({ color: e.target.value })} />
          </div>
          {num('길이', vt.length, 2, 30, 0.1, (v) => edit({ length: v }), 'm')}
          {num('폭', vt.width, 1, 4, 0.05, (v) => edit({ width: v }), 'm')}
          {num('높이', vt.height, 1, 6, 0.05, (v) => edit({ height: v }), 'm')}
          {num('최고 속도', vt.maxSpeed * 3.6, 8, 216, 5, (v) => edit({ maxSpeed: v / 3.6 }), 'km/h')}
          {num('가속도', vt.maxAccel, 0.3, 6, 0.1, (v) => edit({ maxAccel: v }), 'm/s²')}
          {num('감속도', vt.comfortDecel, 0.5, 8, 0.1, (v) => edit({ comfortDecel: v }), 'm/s²')}
          {num('출현 비중', vt.spawnWeight, 0, 100, 1, (v) => edit({ spawnWeight: v }))}
          {vt.kind === 'bus' && num('정원', vt.capacity ?? DEFAULT_BUS_CAPACITY, 1, 200, 1, (v) => edit({ capacity: Math.round(v) }), '명')}
          <h3>파트 (x 전방 · y 높이 · z 우측)</h3>
          <table className="parts">
            <thead>
              <tr>
                <th>x</th>
                <th>y</th>
                <th>z</th>
                <th>길이</th>
                <th>폭</th>
                <th>높이</th>
                <th>색</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vt.parts.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input type="number" step={0.1} value={p.offset.x} onChange={(e) => editPart(i, { offset: { ...p.offset, x: clampNum(e.target.value, -20, 20) } })} />
                  </td>
                  <td>
                    <input type="number" step={0.1} value={p.offset.y} onChange={(e) => editPart(i, { offset: { ...p.offset, y: clampNum(e.target.value, 0, 6) } })} />
                  </td>
                  <td>
                    <input type="number" step={0.1} value={p.offset.z} onChange={(e) => editPart(i, { offset: { ...p.offset, z: clampNum(e.target.value, -3, 3) } })} />
                  </td>
                  <td>
                    <input type="number" step={0.1} value={p.length} onChange={(e) => editPart(i, { length: clampNum(e.target.value, 0.1, 30) })} />
                  </td>
                  <td>
                    <input type="number" step={0.1} value={p.width} onChange={(e) => editPart(i, { width: clampNum(e.target.value, 0.1, 4) })} />
                  </td>
                  <td>
                    <input type="number" step={0.05} value={p.height} onChange={(e) => editPart(i, { height: clampNum(e.target.value, 0.05, 6) })} />
                  </td>
                  <td>
                    <input type="color" value={p.color} onChange={(e) => editPart(i, { color: e.target.value })} />
                  </td>
                  <td>
                    <button className="danger" style={{ padding: '1px 5px' }} disabled={vt.parts.length <= 1} onClick={() => edit({ parts: vt.parts.filter((_, j) => j !== i) })} title="파트 삭제">
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={vt.parts.length >= 24} onClick={() => edit({ parts: [...vt.parts, newPart()] })}>
            + 파트 추가
          </button>
          <div className="row">
            <button
              className="primary"
              disabled={!draft}
              onClick={() => {
                dispatcher.dispatch({ type: 'vehicleType.upsert', vehicleType: vt });
                setSelected(vt.id);
                setDraft(null);
              }}
            >
              저장
            </button>
            {draft && <button onClick={() => setDraft(null)}>되돌리기</button>}
            <div className="spacer" />
            <button
              className="danger"
              disabled={!doc.vehicleTypes[vt.id] || inUse}
              title={inUse ? '버스 노선이 사용 중입니다' : '차량 타입 삭제'}
              onClick={() => {
                dispatcher.dispatch({ type: 'vehicleType.remove', id: vt.id });
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
