// Full-screen 3D building studio over the city: its own WebGL canvas (disposed on close), tool bar,
// palette panel, floor slider, budget gauges, live metrics and saving with `buildingType.upsert`
// against the revision the edit started from (same outcome handling as BuildingEditor).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type Zone } from '@smartcity/shared';
import { useDoc, useServices, useStore } from '../context';
import { MetricsPanel } from '../building/MetricsPanel';
import { CONFLICT_KO } from '../building/designDraft';
import '../building/building.css';
import { ZONE_KO } from '../Toolbar';
import { budget, BUDGET_MAX, checkDesign, fromBuildingType, toBuildingType, translateStudioError, type StudioCheck } from '../../studio/design';
import { StudioEditor, TOOL_INFO } from '../../studio/StudioEditor';
import { StudioScene } from '../../studio/StudioScene';
import { VIEW_LABEL, type ViewName } from '../../studio/viewNav';
import { newStudioDoc, type StudioDoc } from '../../studio/voxelEdit';
import { StudioPanel, type LoadInfo } from './StudioPanel';
import { closeStudio, type StudioRequest } from './studioHost';
import './studio.css';

interface Meta {
  id: string;
  name: string;
  zone: Zone;
  origin?: 'ai';
}

const GUIDE_KEY = 'smartcity.studio.guideDismissed';
const VIEW_BUTTONS: ViewName[] = ['front', 'right', 'back', 'left', 'top', 'home'];

/** localStorage can throw or be missing (private mode, blocked data): the guide then just shows each time. */
function guideDismissed(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberGuideDismissed(): void {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    // Not persisted; the guide shows again next time.
  }
}

function Gauge({ label, n, max }: { label: string; n: number; max: number }) {
  const share = n / max;
  return (
    <div className={`st-gauge${share > 1 ? ' over' : share > 0.8 ? ' warn' : ''}`} title={`${label} ${n} / ${max}`}>
      <span>{label}</span>
      <div className="st-gauge-track">
        <div className="st-gauge-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <b>
        {n.toLocaleString()}/{max.toLocaleString()}
      </b>
    </div>
  );
}

export function StudioOverlay({ req }: { req: StudioRequest }) {
  const { store, dispatcher } = useServices();
  const { doc, version } = useDoc();
  const pending = useStore((s) => s.pending);
  const results = useStore((s) => s.results);

  // Opening: a lossy conversion is edited as a copy so the original stays intact (ADR 0008 §1).
  const init = useMemo(() => {
    if (!req.type) return { doc: newStudioDoc(), lossy: false, meta: { id: dispatcher.ids().next('bt'), name: '새 스튜디오 설계', zone: 'residential' as Zone }, baseRev: 0 };
    const o = fromBuildingType(req.type);
    if (o.lossy) return { doc: o.doc, lossy: true, meta: { id: dispatcher.ids().next('bt'), name: `${req.type.name} 사본`.slice(0, 80), zone: req.type.zone, ...(req.type.origin ? { origin: req.type.origin } : {}) }, baseRev: 0 };
    return { doc: o.doc, lossy: false, meta: { id: req.type.id, name: req.type.name, zone: req.type.zone, ...(req.type.origin ? { origin: req.type.origin } : {}) }, baseRev: req.baseRev };
    // Only on open.
  }, []);
  const editor = useMemo(() => new StudioEditor(init.doc), [init]);
  useSyncExternalStore(editor.subscribe, editor.getVersion);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<StudioScene | null>(null);
  const [meta, setMeta] = useState<Meta>(init.meta);
  const [baseRev, setBaseRev] = useState(init.baseRev);
  const [metaSeq, setMetaSeq] = useState(0);
  const seq = `${editor.draftVersion}:${metaSeq}`;
  const [savedSeq, setSavedSeq] = useState('0:0');
  const [saving, setSaving] = useState<{ ref: number; id: string; seq: string; rev: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lossyNote, setLossyNote] = useState<'open' | 'template' | null>(init.lossy ? 'open' : null);
  /** Leaving with unsaved changes waits for confirmation; holds what to do once confirmed. */
  const [confirmLeave, setConfirmLeave] = useState<(() => void) | null>(null);
  const [check, setCheck] = useState<StudioCheck | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [guide, setGuide] = useState(() => !guideDismissed());
  const [guideSkip, setGuideSkip] = useState(false);
  const dirty = seq !== savedSeq;

  useEffect(() => {
    const sc = new StudioScene(canvasRef.current!, editor, meta.zone);
    sceneRef.current = sc;
    sc.onTogglePanels = () => setCollapsed((c) => !c);
    if (import.meta.env.DEV) (window as unknown as { __studio?: unknown }).__studio = { editor, scene: sc };
    return () => {
      sc.dispose();
      sceneRef.current = null;
      if (import.meta.env.DEV) delete (window as unknown as { __studio?: unknown }).__studio;
    };
    // The scene is made once per editor; zone changes reach it through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  useEffect(() => {
    sceneRef.current?.setZone(meta.zone);
  }, [meta.zone]);

  // Volumes for gauges, metrics and the save check: converted after a short pause, so stacking on a
  // large draft never waits for voxelsToParts (saving converts the current draft itself).
  const [conv, setConv] = useState(() => editor.parts());
  const bt = toBuildingType(editor.doc, meta, conv);
  const b = budget(editor.doc, conv);

  // Save check (same applyCommand as the server), debounced; culprits are drawn in red.
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = editor.parts();
      setConv(cur);
      const c = checkDesign(doc, toBuildingType(editor.doc, meta, cur), baseRev, cur.sources);
      setCheck(c);
      sceneRef.current?.setProblems(c.ok ? [] : c.cells, c.ok ? [] : c.props);
    }, 150);
    return () => clearTimeout(t);
  }, [editor, editor.draftVersion, meta, baseRev, version]);

  // Outcome of our save from the server's answer to this ref (BuildingEditor pattern).
  useEffect(() => {
    if (!saving) return;
    const outcome = results[saving.ref];
    if (outcome === undefined) {
      if (!pending.some((p) => p.ref === saving.ref)) {
        setSaveError('연결이 끊겨 저장 결과를 알 수 없습니다 — 다시 접속한 뒤 확인하세요');
        setSaving(null);
      }
      return;
    }
    if (outcome === 'ok') {
      setSaveError(null);
      setBaseRev(saving.rev + 1);
      setSavedSeq(saving.seq);
      setLossyNote(null);
      // Ready to place: the building tool now uses this design.
      store.set({ tool: 'building', panel: 'buildings', toolOptions: { ...store.getState().toolOptions, buildingTypeId: saving.id } });
      setNotice('저장했습니다 — 닫으면 건물 도구로 바로 배치할 수 있습니다');
    } else {
      setSaveError(/^conflict/.test(outcome) ? CONFLICT_KO : `저장이 거부되었습니다 — ${translateStudioError(outcome)}`);
    }
    setSaving(null);
  }, [saving, pending, results, store]);

  const editMeta = (m: Partial<Meta>) => {
    setMeta((cur) => ({ ...cur, ...m }));
    setMetaSeq((n) => n + 1);
    setNotice(null);
  };

  const save = (asNew = false) => {
    let m = meta;
    let rev = baseRev;
    if (asNew) {
      const taken = Object.values(doc.buildingTypes).some((t) => t.name === meta.name);
      m = { ...meta, id: dispatcher.ids().next('bt'), name: taken ? `${meta.name} 사본`.slice(0, 80) : meta.name };
      rev = 0;
      setMeta(m);
      setBaseRev(0);
    }
    const cur = editor.parts();
    const t = toBuildingType(editor.doc, m, cur);
    const c = checkDesign(doc, t, rev, cur.sources);
    if (!c.ok) {
      setSaveError(c.error);
      return;
    }
    setSaveError(null);
    setNotice(null);
    const ref = dispatcher.dispatch({ type: 'buildingType.upsert', buildingType: t, expectedRev: rev });
    if (ref !== null) setSaving({ ref, id: m.id, seq: asNew ? `${editor.draftVersion}:${metaSeq + 1}` : seq, rev });
    if (asNew) setMetaSeq((n) => n + 1);
  };

  // A new design takes the name of what it was started from until the user types a name.
  const [nameTyped, setNameTyped] = useState(false);
  const onLoad = (next: StudioDoc, info: LoadInfo) =>
    leave(() => {
      editor.replace(next);
      setLossyNote(info.lossy ? 'template' : null);
      if (!nameTyped && !req.type) editMeta({ name: info.name.slice(0, 80), zone: info.zone });
      sceneRef.current?.frame();
    });

  const leave = (action: () => void) => {
    if (dirty) setConfirmLeave(() => action);
    else action();
  };

  const close = () => leave(closeStudio);

  const precise = () =>
    leave(() => {
      const id = req.type?.id;
      if (id) {
        store.set({ panel: 'buildings', toolOptions: { ...store.getState().toolOptions, buildingTypeId: id } });
        req.onPrecise?.(id);
      }
      closeStudio();
    });

  const tool = TOOL_INFO.find((t) => t.id === editor.tool)!;
  const floors = Math.min(30, editor.floorsUsed() + 1);
  const error = saveError ?? (check && !check.ok && bt.parts.length > 0 ? check.error : null);
  const conflict = error === CONFLICT_KO;
  const status = baseRev ? `r${baseRev} 수정 중` : '새 설계';

  return (
    <div className={`studio${collapsed ? ' st-collapsed' : ''}`} data-studio>
      <canvas ref={canvasRef} className="studio-canvas" />

      <header className="panel st-top">
        <b className="st-title">건물 스튜디오</b>
        <input type="text" aria-label="설계 이름" value={meta.name} maxLength={80} onChange={(e) => {
            setNameTyped(true);
            editMeta({ name: e.target.value });
          }} />
        <select aria-label="용도" value={meta.zone} onChange={(e) => editMeta({ zone: e.target.value as Zone })}>
          {Object.entries(ZONE_KO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted">{status}</span>
        <div className="sep" />
        <button title="되돌리기 (Ctrl+Z)" disabled={!editor.history.canUndo} onClick={() => editor.undo()}>
          되돌리기
        </button>
        <button title="다시하기 (Ctrl+Shift+Z)" disabled={!editor.history.canRedo} onClick={() => editor.redo()}>
          다시하기
        </button>
        <div className="spacer" />
        <Gauge label="파츠" n={b.parts} max={BUDGET_MAX.parts} />
        <Gauge label="블록" n={b.cells} max={BUDGET_MAX.cells} />
        <Gauge label="장식" n={b.props} max={BUDGET_MAX.props} />
        <div className="sep" />
        <button className="primary" data-studio-save disabled={!!saving || !check?.ok} title={check && !check.ok ? check.error : '도시에 저장'} onClick={() => save()}>
          {saving ? '저장 중…' : '저장'}
        </button>
        <button data-studio-close onClick={() => close()}>
          닫기
        </button>
      </header>

      <div className="panel st-views" role="group" aria-label="시점">
        {VIEW_BUTTONS.map((v) => (
          <button key={v} data-view={v} title={`${VIEW_LABEL[v]} 보기`} onClick={() => sceneRef.current?.setView(v)}>
            {VIEW_LABEL[v]}
          </button>
        ))}
        <div className="sep" />
        <button data-studio-panels className={collapsed ? 'active' : ''} title="좌우 패널 접기/펴기 (Tab)" onClick={() => setCollapsed((c) => !c)}>
          패널 {collapsed ? '펴기' : '접기'}
        </button>
        <button data-studio-help title="조작법 보기" aria-label="조작법 보기" onClick={() => setGuide(true)}>
          ?
        </button>
      </div>

      {guide && (
        <div className="panel st-guide" data-studio-guide role="note">
          <b>시점 돌리기</b>
          <div>회전: 우클릭 드래그 · 트랙패드는 Alt+드래그 · Q/E 키 (한 번에 15°)</div>
          <div>이동: 휠 버튼 드래그 · Shift+우클릭 드래그 · 확대/축소: 휠</div>
          <div>위의 앞·오른쪽·뒤·왼쪽·위 버튼이나 V 키로 건물 뒤쪽까지 바로 이동합니다. Tab = 패널 접기.</div>
          <label>
            <input type="checkbox" checked={guideSkip} onChange={(e) => setGuideSkip(e.target.checked)} /> 다시 보지 않기
          </label>
          <button
            data-studio-guide-close
            onClick={() => {
              if (guideSkip) rememberGuideDismissed();
              setGuide(false);
            }}
          >
            닫기
          </button>
        </div>
      )}

      <nav className="panel st-tools" aria-label="스튜디오 도구">
        {TOOL_INFO.map((t) => (
          <button key={t.id} data-studio-tool={t.id} className={editor.tool === t.id ? 'active' : ''} title={`${t.label} (${t.key})`} onClick={() => editor.set('tool', t.id)}>
            <span className="st-key">{t.key}</span>
            {t.label}
          </button>
        ))}
        <hr />
        <div className="st-label">브러시</div>
        <div className="row speed">
          <button className={editor.brush === 1 ? 'active' : ''} onClick={() => editor.set('brush', 1)} title="2m 한 칸">
            1×1
          </button>
          <button className={editor.brush === 2 ? 'active' : ''} onClick={() => editor.set('brush', 2)} title="4m 큰 브러시">
            2×2
          </button>
        </div>
        <div className="st-label">대칭</div>
        <div className="row speed">
          <button data-sym="x" className={editor.sym.x ? 'active' : ''} onClick={() => editor.set('sym', { ...editor.sym, x: !editor.sym.x })} title="좌우 대칭 (x = 0)">
            좌우
          </button>
          <button data-sym="z" className={editor.sym.z ? 'active' : ''} onClick={() => editor.set('sym', { ...editor.sym, z: !editor.sym.z })} title="앞뒤 대칭 (z = 0)">
            앞뒤
          </button>
        </div>
        <hr />
        <button title="카메라 맞추기 (F)" onClick={() => sceneRef.current?.frame()}>
          화면 맞춤
        </button>
      </nav>

      <div className="panel st-floor" aria-label="현재 층">
        <div className="st-legend" title="건물 도구로 배치하면 이 쪽이 도로를 향합니다">
          <span className="st-front-mark" aria-hidden="true" />
          정면(도로 쪽)
        </div>
        <div className="st-label">층</div>
        <button className={editor.floor === null ? 'active' : ''} onClick={() => editor.set('floor', null)}>
          전체
        </button>
        <input
          type="range"
          className="st-floor-range"
          aria-label="현재 층"
          min={1}
          max={floors}
          value={(editor.floor ?? floors - 1) + 1}
          onChange={(e) => editor.set('floor', Number(e.target.value) - 1)}
        />
        <b>{editor.floor === null ? '—' : `${editor.floor + 1}층`}</b>
        {editor.floor !== null && (
          <button title="현재 층보다 위층 표시" onClick={() => editor.set('upperHidden', !editor.upperHidden)}>
            위층 {editor.upperHidden ? '숨김' : '반투명'}
          </button>
        )}
      </div>

      <StudioPanel editor={editor} onLoad={onLoad} />

      <div className="st-bottom">
        {lossyNote && (
          <div className="panel st-banner warn" data-studio-lossy>
            <span>
              2m 격자에 맞춰집니다 — 모양이 조금 바뀔 수 있습니다.
              {lossyNote === 'open' ? ' 원본은 그대로 두고 사본으로 편집합니다.' : ''}
            </span>
            {lossyNote === 'open' && req.type && <button onClick={precise}>정밀 모드로 편집</button>}
            <button onClick={() => setLossyNote(null)}>확인</button>
          </div>
        )}
        {conv.unrounded.length > 0 && (
          <div className="panel st-banner warn" data-studio-unrounded>
            <span>
              둥근 모서리는 직사각형 덩어리에만 적용됩니다 — 덩어리 {conv.unrounded.length}개가 직각으로 저장됩니다. 직사각형으로 되돌리면 다시 둥글어집니다.
            </span>
          </div>
        )}
        {error && (
          <div className="panel st-banner error" data-studio-error>
            <span>{error}</span>
            {conflict && <button onClick={() => save(true)}>새 이름으로 저장</button>}
          </div>
        )}
        {notice && !dirty && (
          <div className="panel st-banner ok" data-studio-notice>
            <span>{notice}</span>
            <button className="primary" onClick={closeStudio}>
              배치하러 가기
            </button>
          </div>
        )}
        {confirmLeave && (
          <div className="panel st-banner warn">
            <span>저장하지 않은 변경이 있습니다.</span>
            <button
              className="danger"
              onClick={() => {
                setConfirmLeave(null);
                confirmLeave();
              }}
            >
              변경 버리기
            </button>
            <button onClick={() => setConfirmLeave(null)}>계속 편집</button>
          </div>
        )}
        <div className={`panel st-hint${editor.hint ? ' alert' : ''}`}>{editor.hint || tool.hint}</div>
        <div className="st-nav-legend" data-studio-legend>
          회전: 우클릭 드래그 · Alt+드래그 · Q/E &nbsp;|&nbsp; 이동: 휠 버튼 드래그 · Shift+우 드래그 &nbsp;|&nbsp; 확대: 휠
        </div>
      </div>

      {bt.parts.length > 0 && (
        <div className="panel st-metrics">
          <MetricsPanel type={bt} />
        </div>
      )}
    </div>
  );
}
