import { useEffect, useState } from 'react';
import {
  checkFillet,
  normalize,
  planFillet,
  sampleSegmentCurve,
  segmentLength,
  segmentsAtNode,
  SENSOR_DEFAULTS,
  SENSOR_KINDS,
  sensorPose,
  sub,
  LIMITS,
  type SensorKind,
  type Building,
  type CityDoc,
  type IntersectionControl,
  type SignalPhase,
} from '@smartcity/shared';
import { bearing } from '../tools/roadTool';
import { segmentFeatures } from '../tools/streetTool';
import { SENSOR_KIND_INFO, SENSOR_MODEL_NOTE, sensorBearing, wrapPi } from '../tools/sensorTool';
import { SensorKindIcon } from './Toolbar';
import { AiBadge } from './AiBadge';
import { translateError } from '../app/store';
import { useDoc, useServices, useStore } from './context';
import { BuildingPlanning, ParcelInspector } from './PlanningInspector';
import { clampNum } from './RoadTypeEditor';
import { cycleSeconds, scrambleBlockReason } from './scramble';

const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
const CONTROL_KO: Record<IntersectionControl['kind'], string> = { signal: '사용자 신호', uncontrolled: '비신호', allStop: '모든 방향 일시정지' };
const dirName = (deg: number): string => DIRS[Math.round(deg / 45) % 8]!;

/** Bearing (deg) of the direction leaving `nodeId` along a segment. */
function leaveBearing(doc: CityDoc, segId: string, nodeId: string): number {
  const s = doc.segments[segId]!;
  const pts = sampleSegmentCurve(doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos, s.control);
  const [p, q] = s.a === nodeId ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!];
  const d = normalize(sub(q, p));
  return bearing({ x: 0, z: 0 }, d);
}

/** `d` with its crosswalk legs replaced (undefined = automatic, the key is dropped). */
function withLegs(d: IntersectionControl, legs: string[] | undefined): IntersectionControl {
  const { crosswalkLegs: _old, ...rest } = d;
  return legs ? { ...rest, crosswalkLegs: legs } : rest;
}

/** Pair the most opposite approaches into shared phases (like the automatic plan). */
export function suggestPhases(doc: CityDoc, nodeId: string): SignalPhase[] {
  const segs = segmentsAtNode(doc, nodeId).map((s) => ({ id: s.id, b: leaveBearing(doc, s.id, nodeId) }));
  const left = [...segs];
  const phases: SignalPhase[] = [];
  while (left.length >= 2) {
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < left.length; i++) {
      for (let j = i + 1; j < left.length; j++) {
        const diff = Math.abs(((left[i]!.b - left[j]!.b + 540) % 360) - 180);
        if (diff < bestScore) {
          bestScore = diff;
          best = [i, j];
        }
      }
    }
    if (!best || bestScore > 40) break;
    const [i, j] = best;
    phases.push({ approaches: [left[i]!.id, left[j]!.id], green: 20 });
    left.splice(j, 1);
    left.splice(i, 1);
  }
  for (const s of left) phases.push({ approaches: [s.id], green: 15 });
  return phases;
}

function NodeInspector({ id }: { id: string }) {
  const { store, dispatcher } = useServices();
  const { doc } = useDoc();
  const node = doc.nodes[id]!;
  const segs = segmentsAtNode(doc, id);
  const custom = doc.intersections[id];
  const auto: IntersectionControl = { nodeId: id, kind: segs.length >= 3 ? 'signal' : 'uncontrolled', yellow: 3, allRed: 2, offset: 0 };
  const [draft, setDraft] = useState<IntersectionControl>(custom ?? auto);
  const [editing, setEditing] = useState(0);
  // Reset the form when the confirmed control changes (local apply or a collaborator's edit).
  useEffect(() => {
    setDraft(custom ?? { nodeId: id, kind: segmentsAtNode(doc, id).length >= 3 ? 'signal' : 'uncontrolled', yellow: 3, allRed: 2, offset: 0 });
    setEditing(0);
  }, [id, custom, doc]);
  useEffect(() => {
    const ph = draft.phases?.[editing];
    store.set({ phaseHighlight: draft.kind === 'signal' && ph ? { nodeId: id, approaches: ph.approaches } : null });
  }, [draft, editing, id, store]);
  useEffect(() => () => store.set({ phaseHighlight: null }), [store]);

  const label = (segId: string) => {
    const s = doc.segments[segId];
    const rt = s ? doc.roadTypes[s.roadTypeId] : undefined;
    return `${dirName(leaveBearing(doc, segId, id))}쪽 · ${rt?.name ?? ''}`;
  };
  const setPhase = (i: number, p: Partial<SignalPhase>) => {
    const phases = (draft.phases ?? []).map((ph, j) => (j === i ? { ...ph, ...p } : ph));
    setDraft({ ...draft, phases });
  };
  const scrambleBlock = scrambleBlockReason(doc, draft);
  const valid = (draft.kind !== 'signal' || !draft.phases || draft.phases.every((p) => p.approaches.length > 0)) && !(draft.scramble && scrambleBlock);

  return (
    <>
      <h3>교차점</h3>
      <dl className="kv">
        <dt>위치</dt>
        <dd>
          {node.pos.x.toFixed(1)}, {node.pos.z.toFixed(1)}
        </dd>
        <dt>연결 도로</dt>
        <dd>{segs.length}개</dd>
        <dt>제어 방식</dt>
        <dd>{custom ? CONTROL_KO[custom.kind] : segs.length >= 3 ? '자동 신호' : '없음'}</dd>
      </dl>
      {segs.length === 2 && <FilletSection id={id} />}
      {segs.length >= 2 && (
        <>
          <hr />
          <h3>신호 위상 편집</h3>
          <div className="row">
            <label>종류</label>
            <select
              value={draft.kind}
              onChange={(e) => {
                const { scramble: _s, ...rest } = draft;
                const kind = e.target.value as IntersectionControl['kind'];
                setDraft(kind === 'signal' ? { ...draft, kind } : { ...rest, kind });
              }}
            >
              <option value="signal">신호</option>
              <option value="uncontrolled">비신호 (선착순)</option>
              <option value="allStop">모든 방향 일시정지</option>
            </select>
          </div>
          {segs.length >= 3 && (
            <>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!draft.crosswalkLegs}
                  onChange={(e) => setDraft(withLegs(draft, e.target.checked ? undefined : segs.filter((s) => doc.roadTypes[s.roadTypeId]?.sidewalk).map((s) => s.id)))}
                />
                횡단보도 자동 (보도 있는 모든 방향)
              </label>
              {draft.crosswalkLegs &&
                segs.map((s) => {
                  const walk = !!doc.roadTypes[s.roadTypeId]?.sidewalk;
                  const legs = draft.crosswalkLegs!;
                  return (
                    <label key={s.id} className="toggle" title={walk ? undefined : '보도가 없는 도로입니다'}>
                      <input
                        type="checkbox"
                        disabled={!walk}
                        checked={legs.includes(s.id)}
                        onChange={(e) => setDraft(withLegs(draft, e.target.checked ? [...legs, s.id] : legs.filter((l) => l !== s.id)))}
                      />
                      {label(s.id)} 횡단보도
                    </label>
                  );
                })}
            </>
          )}
          {draft.kind === 'signal' && (
            <>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!draft.phases}
                  onChange={(e) => setDraft({ ...draft, phases: e.target.checked ? undefined : suggestPhases(doc, id) })}
                />
                위상 자동 계산
              </label>
              {draft.phases?.map((ph, i) => (
                <div key={i} className={`phase ${editing === i ? 'editing' : ''}`} onMouseEnter={() => setEditing(i)} onFocus={() => setEditing(i)}>
                  <div className="row">
                    <b style={{ flex: 1 }}>위상 {i + 1}</b>
                    <label style={{ minWidth: 0 }}>녹색</label>
                    <input type="number" min={3} max={180} value={ph.green} onChange={(e) => setPhase(i, { green: clampNum(e.target.value, 3, 180) })} />
                    <span className="muted">초</span>
                    <button className="danger" disabled={(draft.phases?.length ?? 0) <= 1} onClick={() => setDraft({ ...draft, phases: draft.phases!.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </div>
                  {segs.map((s) => (
                    <label key={s.id} className="toggle">
                      <input
                        type="checkbox"
                        checked={ph.approaches.includes(s.id)}
                        onChange={(e) => setPhase(i, { approaches: e.target.checked ? [...ph.approaches, s.id] : ph.approaches.filter((a) => a !== s.id) })}
                      />
                      {label(s.id)}
                    </label>
                  ))}
                </div>
              ))}
              {draft.phases && (
                <button disabled={draft.phases.length >= 8} onClick={() => setDraft({ ...draft, phases: [...draft.phases!, { approaches: [], green: 15 }] })}>
                  + 위상 추가
                </button>
              )}
              <div className="row">
                <label>황색</label>
                <input type="number" min={0} max={10} step={0.5} value={draft.yellow} onChange={(e) => setDraft({ ...draft, yellow: clampNum(e.target.value, 0, 10) })} />
                <label style={{ minWidth: 0 }}>전적색</label>
                <input type="number" min={0} max={10} step={0.5} value={draft.allRed} onChange={(e) => setDraft({ ...draft, allRed: clampNum(e.target.value, 0, 10) })} />
              </div>
              <label className="toggle" title={scrambleBlock ?? undefined}>
                <input
                  type="checkbox"
                  data-scramble
                  checked={!!draft.scramble}
                  disabled={!draft.scramble && scrambleBlock !== null}
                  onChange={(e) => {
                    const { scramble: _s, ...rest } = draft;
                    setDraft(e.target.checked ? { ...rest, scramble: true } : rest);
                  }}
                />
                보행 전용 신호(모든 방향 동시 보행)
              </label>
              {scrambleBlock && <span className="muted" data-scramble-reason>{draft.scramble ? '적용할 수 없음: ' : '사용 불가: '}{scrambleBlock}</span>}
              <span className="muted" data-cycle>
                총 주기 {draft.phases ? '' : '약 '}
                {cycleSeconds(doc, draft, draft.phases ?? suggestPhases(doc, id))}초{draft.scramble ? ' (보행 전용 위상 포함)' : ''}
              </span>
              <div className="row">
                <label>오프셋</label>
                <input type="number" min={0} max={600} step={1} value={draft.offset} onChange={(e) => setDraft({ ...draft, offset: clampNum(e.target.value, 0, 600) })} />
                <span className="muted">초 (연동 신호용)</span>
              </div>
            </>
          )}
          <div className="row">
            <button className="primary" disabled={!valid} onClick={() => dispatcher.dispatch({ type: 'intersection.set', control: draft })}>
              적용
            </button>
            <button disabled={!custom} onClick={() => dispatcher.dispatch({ type: 'intersection.reset', nodeId: id })}>
              자동 복원
            </button>
          </div>
          {!valid && <span className="muted">모든 위상에 접근로를 하나 이상 선택하세요</span>}
        </>
      )}
    </>
  );
}

/** "모서리 둥글게" on a two-road corner (ADR 0012 §1): one road.fillet, or the reason it is not possible. */
function FilletSection({ id }: { id: string }) {
  const { store, dispatcher } = useServices();
  const { doc } = useDoc();
  const check = checkFillet(doc, id);
  const round = () => {
    const plan = planFillet(store.getState().doc, id, dispatcher.ids());
    if (!plan.command) {
      store.toast(translateError(plan.error ?? ''), 'error');
      return;
    }
    dispatcher.dispatch(plan.command, plan.curve ? [plan.curve] : []);
  };
  return (
    <div className="row wrap" data-fillet-section>
      <button data-fillet disabled={!check.ok} onClick={round}>
        모서리 둥글게
      </button>
      {check.ok ? (
        <span className="muted">반경 {check.geometry.radius.toFixed(1)} m · 양쪽 {check.geometry.t.toFixed(1)} m</span>
      ) : (
        <span className="muted" data-fillet-reason>
          {translateError(check.error)}
        </span>
      )}
    </div>
  );
}

function SegmentInspector({ id }: { id: string }) {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const seg = doc.segments[id]!;
  const closure = doc.closures[id];
  const [reason, setReason] = useState('공사');
  const features = segmentFeatures(doc, id);
  const len = segmentLength(doc, seg);
  return (
    <>
      <h3>도로</h3>
      <dl className="kv">
        <dt>길이</dt>
        <dd>{segmentLength(doc, seg).toFixed(1)} m</dd>
        <dt>형태</dt>
        <dd>{seg.control ? '곡선' : '직선'}</dd>
        <dt>상태</dt>
        <dd style={{ color: closure ? '#fca5a5' : undefined }}>{closure ? `폐쇄됨 (${closure.reason})` : '통행 가능'}</dd>
        <dt>구역</dt>
        <dd>{seg.schoolZone ? '어린이보호구역 (30km/h)' : '일반'}</dd>
      </dl>
      <label className="toggle">
        <input type="checkbox" checked={!!seg.schoolZone} onChange={(e) => dispatcher.dispatch({ type: 'segment.setSchoolZone', id, schoolZone: e.target.checked })} />
        어린이보호구역
      </label>
      <h3>교통 시설</h3>
      {features.length === 0 ? (
        <span className="muted">없음 — 교통 시설 도구(8)로 횡단보도·과속방지턱을 놓을 수 있습니다</span>
      ) : (
        features.map((f) => (
          <div className="row" key={f.id} data-feature={f.id}>
            <b style={{ flex: 1 }}>
              {f.kind === 'crosswalk' ? '횡단보도' : '과속방지턱'} · {Math.round(f.t * len)}m
            </b>
            {f.kind === 'crosswalk' && (
              <label className="toggle">
                <input type="checkbox" checked={!!f.signal} onChange={(e) => dispatcher.dispatch({ type: 'feature.upsert', feature: { ...f, signal: e.target.checked } })} />
                신호
              </label>
            )}
            <button className="danger" aria-label="시설 삭제" onClick={() => dispatcher.dispatch({ type: 'feature.remove', id: f.id })}>
              ×
            </button>
          </div>
        ))
      )}
      <div className="row">
        <label>도로 타입</label>
        <select value={seg.roadTypeId} onChange={(e) => dispatcher.dispatch({ type: 'segment.setType', id, roadTypeId: e.target.value })} style={{ flex: 1 }}>
          {Object.values(doc.roadTypes).map((rt) => (
            <option key={rt.id} value={rt.id}>
              {rt.name}
            </option>
          ))}
        </select>
      </div>
      {closure ? (
        <button onClick={() => dispatcher.dispatch({ type: 'closure.remove', segmentId: id })}>폐쇄 해제</button>
      ) : (
        <div className="row">
          <input type="text" value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} aria-label="폐쇄 사유" style={{ flex: 1 }} />
          <button onClick={() => dispatcher.dispatch({ type: 'closure.set', closure: { segmentId: id, reason: reason || '도로 폐쇄' } })}>도로 폐쇄</button>
        </div>
      )}
      <button className="danger" onClick={() => dispatcher.dispatch({ type: 'segment.remove', id })}>
        도로 철거
      </button>
    </>
  );
}

function BuildingInspector({ id }: { id: string }) {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const b = doc.buildings[id]!;
  const type = doc.buildingTypes[b.typeId];
  const replace = (next: Building) => dispatcher.dispatch({ type: 'batch', commands: [{ type: 'building.remove', id }, { type: 'building.place', building: next }] });
  const deg = Math.round((b.rotation * 180) / Math.PI);
  const rotateTo = (d: number) => {
    const r = (((d % 360) + 540) % 360) - 180;
    dispatcher.dispatch({ type: 'building.move', id, pos: b.pos, rotation: (r * Math.PI) / 180 });
  };
  return (
    <>
      <h3>건물</h3>
      <dl className="kv">
        <dt>타입</dt>
        <dd>
          {type?.name ?? b.typeId} <AiBadge type={type} />
        </dd>
        <dt>위치</dt>
        <dd>
          {b.pos.x.toFixed(1)}, {b.pos.z.toFixed(1)}
        </dd>
      </dl>
      <div className="row">
        <label>타입 변경</label>
        <select value={b.typeId} onChange={(e) => replace({ ...b, typeId: e.target.value })} style={{ flex: 1 }}>
          {Object.values(doc.buildingTypes).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>회전</label>
        <button onClick={() => rotateTo(deg - 15)}>−15°</button>
        <b style={{ width: 44, textAlign: 'center' }}>{deg}°</b>
        <button onClick={() => rotateTo(deg + 15)}>+15°</button>
        <button onClick={() => rotateTo(deg + 90)}>+90°</button>
      </div>
      {b.auto && (
        <div className="row" data-auto-building>
          <b style={{ flex: 1 }}>자동 성장 건물</b>
          <button
            title="이 건물을 직접 관리합니다 (성장 시스템이 더 이상 바꾸지 않음)"
            onClick={() => dispatcher.dispatch({ type: 'building.move', id, pos: b.pos, rotation: b.rotation })}
          >
            자동 관리 해제
          </button>
        </div>
      )}
      <button className="danger" onClick={() => dispatcher.dispatch({ type: 'building.remove', id })}>
        건물 철거
      </button>
      <BuildingPlanning id={id} />
    </>
  );
}

function StopInspector({ id }: { id: string }) {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const st = doc.busStops[id]!;
  const lines = Object.values(doc.busLines).filter((l) => l.stopIds.includes(id));
  const waiting = useStore((s) => s.transit?.waiting[id] ?? 0);
  return (
    <>
      <h3>버스 정류장</h3>
      <dl className="kv">
        <dt>진행 방향</dt>
        <dd>{st.dir === 'forward' ? '정방향' : '역방향'}</dd>
        <dt>도로 위치</dt>
        <dd>{Math.round(st.t * 100)}%</dd>
        <dt>경유 노선</dt>
        <dd>{lines.length ? lines.map((l) => l.name).join(', ') : '없음'}</dd>
        <dt>대기 승객</dt>
        <dd>{waiting}명</dd>
      </dl>
      <button className="danger" onClick={() => dispatcher.dispatch({ type: 'busStop.remove', id })}>
        정류장 삭제
      </button>
      {lines.some((l) => l.stopIds.length <= 2) && <span className="muted">정류장이 2개 미만이 되는 노선은 함께 삭제됩니다</span>}
    </>
  );
}

const DEG = Math.PI / 180;

/** Number field that commits on Enter / blur (one `sensor.update` per edit, not per keystroke). */
function CommitNumber({ value, min, max, onCommit, field }: { value: number; min: number; max: number; onCommit: (v: number) => void; field: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const v = clampNum(draft, min, max);
    setDraft(null);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      data-sensor-field={field}
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function SensorInspector({ id }: { id: string }) {
  const { dispatcher } = useServices();
  const { doc } = useDoc();
  const s = doc.sensors[id]!;
  const pose = sensorPose(doc, s);
  const update = (patch: { kind?: SensorKind; heading?: number; fov?: number; range?: number }) => dispatcher.dispatch({ type: 'sensor.update', id, ...patch });
  const turn = (by: number) => update({ heading: wrapPi(s.heading + by) });
  const fov = Math.round(s.fov / DEG);
  return (
    <>
      <h3>센서 · {SENSOR_KIND_INFO[s.kind].label}</h3>
      <div className="row wrap" role="group" aria-label="센서 종류">
        {SENSOR_KINDS.map((k) => (
          <button
            key={k}
            data-sensor-set-kind={k}
            className={s.kind === k ? 'active' : ''}
            title={`${SENSOR_KIND_INFO[k].desc} (시야각·범위는 그 종류의 기본값으로)`}
            onClick={() => k !== s.kind && update({ kind: k, fov: SENSOR_DEFAULTS[k].fov, range: SENSOR_DEFAULTS[k].range })}
          >
            <SensorKindIcon kind={k} /> {SENSOR_KIND_INFO[k].short}
          </button>
        ))}
      </div>
      <span className="muted">{SENSOR_KIND_INFO[s.kind].desc}</span>
      <div className="row">
        <label>방향</label>
        <button data-sensor-turn="-15" onClick={() => turn(-15 * DEG)}>−15°</button>
        <b data-sensor-bearing style={{ width: 64, textAlign: 'center' }}>
          {pose ? `방위 ${sensorBearing(pose.pos, pose.yaw)}°` : '—'}
        </b>
        <button data-sensor-turn="15" onClick={() => turn(15 * DEG)}>+15°</button>
        <button data-sensor-turn="180" onClick={() => turn(Math.PI)} title="반대쪽을 봅니다">
          반대
        </button>
      </div>
      <div className="row">
        <label>시야각</label>
        <CommitNumber field="fov" value={fov} min={1} max={360} onCommit={(v) => update({ fov: Math.min(2 * Math.PI, v * DEG) })} />
        <span className="muted">°</span>
        <label>범위</label>
        <CommitNumber field="range" value={s.range} min={LIMITS.sensorRangeMin} max={LIMITS.sensorRangeMax} onCommit={(v) => update({ range: v })} />
        <span className="muted">m</span>
      </div>
      <dl className="kv">
        <dt>도로 위치</dt>
        <dd>
          {Math.round(s.t * 100)}% · {s.side === 'right' ? '오른쪽' : '왼쪽'} 보도
        </dd>
      </dl>
      <span className="muted" data-sensor-note>
        {SENSOR_MODEL_NOTE} · 지도의 노란 띠 = 실제로 감시하는 차선 구간 · 도로를 지우면 함께 삭제
      </span>
      <button className="danger" data-sensor-remove onClick={() => dispatcher.dispatch({ type: 'sensor.remove', id })}>
        센서 삭제
      </button>
    </>
  );
}

export function Inspector() {
  const sel = useStore((s) => s.selection);
  const { doc } = useDoc();
  if (!sel) {
    return (
      <>
        <h3>속성</h3>
        <span className="muted">선택 도구(1)로 도로·교차점·건물·정류장·필지·센서를 클릭하면 여기에서 편집할 수 있습니다.</span>
        <dl className="kv">
          <dt>교차점</dt>
          <dd>{Object.keys(doc.nodes).length}</dd>
          <dt>도로</dt>
          <dd>{Object.keys(doc.segments).length}</dd>
          <dt>건물</dt>
          <dd>{Object.keys(doc.buildings).length}</dd>
          <dt>버스 노선</dt>
          <dd>{Object.keys(doc.busLines).length}</dd>
          <dt>폐쇄 도로</dt>
          <dd>{Object.keys(doc.closures).length}</dd>
          <dt>필지</dt>
          <dd>{Object.keys(doc.parcels).length}</dd>
        </dl>
      </>
    );
  }
  switch (sel.kind) {
    case 'node':
      return doc.nodes[sel.id] ? <NodeInspector key={sel.id} id={sel.id} /> : null;
    case 'segment':
      return doc.segments[sel.id] ? <SegmentInspector key={sel.id} id={sel.id} /> : null;
    case 'building':
      return doc.buildings[sel.id] ? <BuildingInspector key={sel.id} id={sel.id} /> : null;
    case 'busStop':
      return doc.busStops[sel.id] ? <StopInspector key={sel.id} id={sel.id} /> : null;
    case 'parcel':
      return doc.parcels[sel.id] ? <ParcelInspector key={sel.id} id={sel.id} /> : null;
    case 'sensor':
      return doc.sensors[sel.id] ? <SensorInspector key={sel.id} id={sel.id} /> : null;
  }
}
