// Building designs (건물 설계): list, smart-city presets, volumes painted on a grid, facade, smart
// equipment and live metrics. Saving sends `buildingType.upsert` with the revision the draft started
// from, so a concurrent edit is rejected instead of silently overwritten (ADR 0007 §5).

import { useEffect, useMemo, useRef, useState } from 'react';
import { cloneJson, partOutline, SMART_CITY_PRESETS, type BuildingPart, type BuildingType, type CellKey, type Command, type Zone } from '@smartcity/shared';
import { buildingPreview } from '../render/buildings';
import { FootprintPainter } from './building/FootprintPainter';
import { MetricsPanel } from './building/MetricsPanel';
import { SmartPanel } from './building/SmartPanel';
import { VolumeFields } from './building/VolumeFields';
import { applyPaint, besideParts, CONFLICT_KO, newPart, partTop, preflight, stackOn, type PaintResult } from './building/designDraft';
import './building/building.css';
import { translateError } from '../app/store';
import { useServices, useStore } from './context';
import { PartPreview } from './PartPreview';
import { ZONE_KO } from './Toolbar';

const PLOTS = [40, 60, 80, 120, 160];

/** Smallest plot that holds every volume with a 4 m margin. */
function autoPlot(parts: readonly BuildingPart[]): number {
  let r = 0;
  for (const p of parts) for (const v of partOutline(p)) r = Math.max(r, Math.abs(v.x), Math.abs(v.z));
  return PLOTS.find((s) => s / 2 >= r + 4) ?? PLOTS[PLOTS.length - 1]!;
}

type Upsert = Extract<Command, { type: 'buildingType.upsert' }>;

export function BuildingEditor() {
  const { store, dispatcher } = useServices();
  const doc = useStore((s) => s.doc);
  const docVersion = useStore((s) => s.docVersion);
  const pending = useStore((s) => s.pending);
  const results = useStore((s) => s.results);
  // Bumped on every draft change, so a late save response never clobbers newer work.
  const editSeq = useRef(0);
  const [selected, setSelected] = useState<string | null>(store.getState().toolOptions.buildingTypeId);
  const [draft, setDraft] = useState<BuildingType | null>(null);
  /** Revision the draft started from (0 = a new design). */
  const [baseRev, setBaseRev] = useState(0);
  const [partIdx, setPartIdx] = useState(0);
  /** Bumped whenever the painter must reload cells from the design (select, undo, volume list change). */
  const [gen, setGen] = useState(0);
  const [plotChoice, setPlotChoice] = useState<number | null>(null);
  const [paint, setPaint] = useState<PaintResult | null>(null);
  const [saving, setSaving] = useState<{ ref: number; id: string; seq: number; rev: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stored = selected ? doc.buildingTypes[selected] : undefined;
  const bt = draft ?? stored;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of Object.values(doc.buildings)) m.set(b.typeId, (m.get(b.typeId) ?? 0) + 1);
    return m;
    // The doc is mutated in place; docVersion marks its changes.
  }, [doc, docVersion]);
  const inUse = bt ? (counts.get(bt.id) ?? 0) : 0;
  const part = bt?.parts[Math.min(partIdx, (bt?.parts.length ?? 1) - 1)];
  const plot = plotChoice ?? (bt ? autoPlot(bt.parts) : 60);

  const cmd: Upsert | null = draft ? { type: 'buildingType.upsert', buildingType: draft, expectedRev: baseRev } : null;
  const check = useMemo(() => (cmd ? preflight(doc, cmd) : null), [doc, docVersion, draft, baseRev]);
  const blocked = !!paint?.empty;

  // Outcome of our save, from the server's own answer to this ref (not inferred from the doc,
  // which other users may already have changed again).
  useEffect(() => {
    if (!saving) return;
    const outcome = results[saving.ref];
    if (outcome === undefined) {
      // Dropped from pending without an answer: the connection was lost (ADR 0001).
      if (!pending.some((p) => p.ref === saving.ref)) {
        setSaveError('연결이 끊겨 저장 결과를 알 수 없습니다 — 다시 접속한 뒤 확인하세요');
        setSaving(null);
      }
      return;
    }
    if (outcome === 'ok') {
      setSaveError(null);
      if (editSeq.current === saving.seq) {
        setDraft(null);
        setSelected(saving.id);
        setPaint(null);
        setGen((g) => g + 1);
      } else if (draft?.id === saving.id) {
        // Kept editing the same design meanwhile: those edits now build on the revision we just saved.
        setBaseRev(saving.rev + 1);
      }
    } else {
      setSaveError(/^conflict/.test(outcome) ? CONFLICT_KO : `저장이 거부되었습니다 — ${translateError(outcome)}`);
    }
    setSaving(null);
  }, [saving, pending, results, draft]);

  const reset = () => {
    setPartIdx(0);
    setPaint(null);
    setSaveError(null);
    setGen((g) => g + 1);
  };
  const select = (id: string) => {
    editSeq.current++;
    setSelected(id);
    setDraft(null);
    setPlotChoice(null);
    reset();
  };
  const startNew = (t: BuildingType) => {
    editSeq.current++;
    setSelected(null);
    setDraft(t);
    setBaseRev(0);
    setPlotChoice(null);
    reset();
  };
  const edit = (fn: (t: BuildingType) => void) => {
    if (!bt) return;
    if (!draft) setBaseRev(bt.rev ?? 0);
    const next = cloneJson(bt);
    fn(next);
    editSeq.current++;
    setDraft(next);
  };
  const setPart = (i: number, p: BuildingPart) => edit((t) => void (t.parts[i] = p));
  const duplicate = () => {
    if (!bt) return;
    const copy = cloneJson(bt);
    delete copy.rev;
    startNew({ ...copy, id: dispatcher.ids().next('bt'), name: `${bt.name} 사본`.slice(0, 80) });
  };
  const addPreset = (preset: BuildingType) => {
    const ref = dispatcher.dispatch({ type: 'buildingType.upsert', buildingType: cloneJson(preset), expectedRev: 0 });
    if (ref !== null) select(preset.id);
  };
  const onPaint = (cells: Set<CellKey>, size: number) => {
    if (!bt || !part) return;
    const r = applyPaint(part, cells, size);
    setPaint(r);
    if (!r.empty) setPart(partIdx, r.part);
  };
  const save = () => {
    if (!cmd) return;
    const r = preflight(doc, cmd);
    if (!r.ok) {
      setSaveError(r.error);
      return;
    }
    setSaveError(null);
    const ref = dispatcher.dispatch(cmd);
    if (ref !== null) setSaving({ ref, id: cmd.buildingType.id, seq: editSeq.current, rev: baseRev });
  };

  const previewKey = bt ? JSON.stringify([bt.parts, bt.smart ?? null, plot]) : '';
  const conflict = (check && !check.ok && check.error === CONFLICT_KO) || saveError === CONFLICT_KO;
  const error = saveError ?? (check && !check.ok ? check.error : null);
  const painterKey = bt && part ? `${bt.id}|${partIdx}|${gen}|${part.footprint ? 'fp' : JSON.stringify([part.offset, part.width, part.depth])}` : '';

  return (
    <>
      <div className="row">
        <h3 style={{ flex: 1 }}>건물 설계</h3>
        <button onClick={() => startNew({ id: dispatcher.ids().next('bt'), name: '새 설계', zone: 'residential', parts: [newPart()] })}>+ 새 설계</button>
      </div>
      <div className="list bp-designs">
        {Object.values(doc.buildingTypes).map((t) => (
          <button key={t.id} className={bt?.id === t.id ? 'active' : ''} onClick={() => select(t.id)}>
            <span className="swatch" style={{ background: t.parts[0]?.color }} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span className="muted bp-meta">
              {ZONE_KO[t.zone]} · r{t.rev ?? 0} · {counts.get(t.id) ?? 0}동
            </span>
          </button>
        ))}
      </div>
      <div className="bp-section">
        <h3>미래형 프리셋</h3>
        <div className="chips bp-presets">
          {SMART_CITY_PRESETS.map((p) =>
            doc.buildingTypes[p.id] ? (
              <button key={p.id} className={bt?.id === p.id ? 'active' : ''} onClick={() => select(p.id)}>
                {p.name}
              </button>
            ) : (
              <button key={p.id} className="missing" title="이 도시에 없는 프리셋입니다 — 눌러서 추가" onClick={() => addPreset(p)}>
                + {p.name}
              </button>
            ),
          )}
        </div>
      </div>
      {bt && part && (
        <>
          <hr />
          <PartPreview deps={previewKey} height={200} build={() => buildingPreview(bt, plot)} />
          <div className="row">
            <label>이름</label>
            <input type="text" value={bt.name} maxLength={80} onChange={(e) => edit((t) => void (t.name = e.target.value))} style={{ flex: 1 }} />
          </div>
          <div className="row">
            <label>존</label>
            <select value={bt.zone} onChange={(e) => edit((t) => void (t.zone = e.target.value as Zone))}>
              {Object.entries(ZONE_KO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <span className="muted">{draft ? (baseRev ? `r${baseRev}에서 수정 중` : '새 설계') : `r${bt.rev ?? 0}`}</span>
          </div>

          <div className="bp-section">
            <div className="row">
              <h3 style={{ flex: 1 }}>볼륨(매스)</h3>
              <button
                disabled={bt.parts.length >= 16}
                onClick={() => {
                  edit((t) => void t.parts.push(besideParts(t.parts)));
                  setPartIdx(bt.parts.length);
                  setPaint(null);
                  setGen((g) => g + 1);
                }}
              >
                + 볼륨
              </button>
              <button
                disabled={bt.parts.length >= 16}
                title="선택한 볼륨 위에 같은 평면으로 새 볼륨을 쌓습니다"
                onClick={() => {
                  edit((t) => void t.parts.splice(partIdx + 1, 0, stackOn(part)));
                  setPartIdx(partIdx + 1);
                  setPaint(null);
                  setGen((g) => g + 1);
                }}
              >
                위에 쌓기
              </button>
            </div>
            <div className="list bp-volumes">
              {bt.parts.map((p, i) => (
                <button
                  key={i}
                  className={i === partIdx ? 'active' : ''}
                  onClick={() => {
                    setPartIdx(i);
                    setPaint(null);
                  }}
                >
                  <span className="swatch" style={{ background: p.color }} />
                  <span style={{ flex: 1 }}>
                    매스 {i + 1} · {ZONE_KO[p.use ?? bt.zone]} · {p.floors}층
                  </span>
                  <span className="muted">
                    {Math.round(p.baseHeight * 10) / 10}–{Math.round(partTop(p) * 10) / 10}m{p.footprint ? ' · 그린 평면' : ''}
                  </span>
                </button>
              ))}
            </div>
            <div className="row">
              <span className="muted" style={{ flex: 1 }}>
                매스 {partIdx + 1} 편집
              </span>
              <label className="muted">대지</label>
              <select value={plotChoice ?? ''} onChange={(e) => setPlotChoice(e.target.value ? Number(e.target.value) : null)}>
                <option value="">자동({autoPlot(bt.parts)}m)</option>
                {PLOTS.map((s) => (
                  <option key={s} value={s}>
                    {s}m
                  </option>
                ))}
              </select>
              <button
                className="danger"
                disabled={bt.parts.length <= 1}
                onClick={() => {
                  edit((t) => void t.parts.splice(partIdx, 1));
                  setPartIdx(Math.max(0, partIdx - 1));
                  setPaint(null);
                  setGen((g) => g + 1);
                }}
              >
                삭제
              </button>
            </div>
            <FootprintPainter part={part} others={bt.parts.filter((_, i) => i !== partIdx)} plot={plot} resetKey={painterKey} onPaint={onPaint} />
            {paint?.empty && <div className="bp-error">칠한 칸이 없습니다 — 칸을 칠해야 저장할 수 있습니다</div>}
            {paint && paint.excluded > 0 && <div className="bp-warn">떨어진 칸은 제외됨 ({paint.excluded}칸)</div>}
            {paint && paint.filled > 0 && <div className="muted">안쪽 빈칸 {paint.filled}칸은 채워집니다 (중정은 아직 지원하지 않음)</div>}
            {paint && paint.corners > 32 && <div className="bp-error">꼭짓점 {paint.corners}개 — 32개 이하로 단순하게 그려야 저장할 수 있습니다</div>}
            <VolumeFields part={part} zone={bt.zone} onChange={(p) => setPart(partIdx, p)} />
          </div>

          <SmartPanel smart={bt.smart} onChange={(s) => edit((t) => void (t.smart = s))} />
          <MetricsPanel type={bt} />

          {inUse > 0 && <div className="bp-warn">이 설계를 쓰는 건물 {inUse}동에 모두 적용됩니다</div>}
          {draft && error && (
            <div className="bp-notice error">
              <span className="bp-error">{error}</span>
              {conflict && (
                <div className="row wrap">
                  <button onClick={() => stored && select(stored.id)}>최신본 불러오기</button>
                  <button onClick={duplicate}>복제해서 새 설계로</button>
                </div>
              )}
            </div>
          )}
          <div className="row wrap">
            <button className="primary" disabled={!draft || !!saving || !check?.ok || blocked} onClick={save}>
              {saving ? '저장 중…' : '저장'}
            </button>
            {draft && (
              <button
                onClick={() => {
                  if (stored) select(stored.id);
                  else {
                    setDraft(null);
                    reset();
                  }
                }}
              >
                되돌리기
              </button>
            )}
            <button onClick={duplicate}>복제해서 새 설계로</button>
            <button onClick={() => store.set({ tool: 'building', toolOptions: { ...store.getState().toolOptions, buildingTypeId: bt.id } })} disabled={!doc.buildingTypes[bt.id]}>
              배치하기
            </button>
            <div className="spacer" />
            <button
              className="danger"
              disabled={!doc.buildingTypes[bt.id] || inUse > 0}
              title={inUse > 0 ? `이 설계의 건물 ${inUse}동이 있어 삭제할 수 없습니다` : '설계 삭제'}
              onClick={() => {
                dispatcher.dispatch({ type: 'buildingType.remove', id: bt.id });
                setSelected(null);
                setDraft(null);
                reset();
              }}
            >
              설계 삭제
            </button>
          </div>
        </>
      )}
    </>
  );
}
