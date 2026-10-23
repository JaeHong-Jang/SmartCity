import type { BusLine } from '@smartcity/shared';
import { stopPosition } from '../render/busRoute';
import { lineLoad, lineWaiting } from '../app/transit';
import { useDoc, useServices, useStore } from './context';
import { clampInt } from './RoadTypeEditor';

export function BusLinePanel() {
  const { store, dispatcher, focus } = useServices();
  const { doc } = useDoc();
  const transit = useStore((s) => s.transit);
  const lines = Object.values(doc.busLines);
  const busTypes = Object.values(doc.vehicleTypes);
  const upsert = (l: BusLine, p: Partial<BusLine>) => dispatcher.dispatch({ type: 'busLine.upsert', line: { ...l, ...p } });

  return (
    <>
      <div className="row">
        <h3 style={{ flex: 1 }}>버스 노선</h3>
        <button onClick={() => store.set({ tool: 'busLine' })}>+ 새 노선 (5)</button>
      </div>
      {transit && lines.length > 0 && (
        <div className="row" data-transit-total>
          <span className="muted">운행 중 버스 {transit.buses}대</span>
          <b>
            탑승 {transit.aboard} / {transit.capacity}명
          </b>
        </div>
      )}
      {lines.length === 0 && <span className="muted">버스 도구(5)로 도로 위 정류장을 차례로 클릭해 노선을 만드세요.</span>}
      {lines.map((l) => (
        <div key={l.id} className="phase">
          <div className="row">
            <input type="color" value={l.color} onChange={(e) => upsert(l, { color: e.target.value })} title="노선 색" />
            <input
              type="text"
              key={`${l.id}-${l.name}`}
              defaultValue={l.name}
              maxLength={80}
              style={{ flex: 1 }}
              aria-label="노선 이름"
              onBlur={(e) => {
                if (e.target.value && e.target.value !== l.name) upsert(l, { name: e.target.value });
              }}
            />
            <button
              title="첫 정류장으로 이동"
              onClick={() => {
                const st = doc.busStops[l.stopIds[0]!];
                const p = st ? stopPosition(doc, st) : null;
                if (p) focus(p);
              }}
            >
              보기
            </button>
          </div>
          <div className="row">
            <label>정류장</label>
            <span>{l.stopIds.length}개</span>
            <label style={{ minWidth: 0 }}>버스 대수</label>
            <input type="number" min={0} max={50} value={l.buses} onChange={(e) => upsert(l, { buses: clampInt(e.target.value, 0, 50) })} />
          </div>
          {transit && (
            <div className="row" data-line-load={l.id}>
              <label>승객</label>
              <b>대기 {lineWaiting(transit, l)}명</b>
              {(() => {
                const load = lineLoad(transit, doc, l);
                return load ? (
                  <span>
                    탑승 {load.aboard} / {load.capacity}명
                  </span>
                ) : (
                  <span className="muted" title="같은 차량 타입을 쓰는 노선이 여러 개라 노선별 탑승 인원을 구분할 수 없습니다">
                    탑승 합계는 위 참조
                  </span>
                );
              })()}
            </div>
          )}
          <div className="row">
            <label>차량 타입</label>
            <select value={l.vehicleTypeId} onChange={(e) => upsert(l, { vehicleTypeId: e.target.value })} style={{ flex: 1 }}>
              {busTypes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button className="danger" onClick={() => dispatcher.dispatch({ type: 'busLine.remove', id: l.id })}>
              삭제
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
