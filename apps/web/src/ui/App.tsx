import { useRef, useState, type ChangeEvent } from 'react';
import type { PanelId, SimSpeed } from '../app/store';
import { SNAP_STEPS, snapLabel } from '../tools/snap';
import { downloadText, exportDoc, startImport } from '../app/importExport';
import { startSampleCity } from '../app/sampleCity';
import { QUALITY_LABEL, setQuality } from '../app/quality';
import { formatClock } from '../render/dayNight';
import { AiPanel } from './AiPanel';
import { BuildingEditor } from './BuildingEditor';
import { BusLinePanel } from './BusLinePanel';
import { ConnectionBanner, ConnectOverlay, OfflineCityNotice, OfflineSaveError } from './Connection';
import { useDoc, useServices, useStore } from './context';
import { Dashboard } from './Dashboard';
import { GrowthHud } from './GrowthHud';
import { IconChart, IconCity, IconDownload, IconPause, IconUpload } from './Icons';
import { Inspector } from './Inspector';
import { PerfOverlay } from './PerfOverlay';
import { SimModeEnterButton, SimModeRoot } from './sim/SimMode';
import { useSimMode } from '../simmode/store';
import { RoadTypeEditor } from './RoadTypeEditor';
import { StudioOverlay } from './studio/StudioOverlay';
import { useStudioRequest } from './studio/studioHost';
import { Toasts } from './Toasts';
import { ToolOptions, Toolbar } from './Toolbar';
import { VehicleEditor } from './VehicleEditor';

const CONNECTION_KO = {
  connecting: { text: '연결 중…', color: '#fbbf24' },
  online: { text: '온라인', color: '#4ade80' },
  reconnecting: { text: '재연결 중…', color: '#fbbf24' },
  offline: { text: '오프라인(단독 모드)', color: '#94a3b8' },
} as const;

/** Game clock of the simulation, e.g. "07:32 · 1일차". */
function GameClock() {
  // Minute resolution: the clock text only changes once per game minute.
  const minute = useStore((s) => (s.simStats?.clock ? Math.floor(s.simStats.clock.dayTime / 60) : -1));
  const day = useStore((s) => s.simStats?.clock?.day ?? 0);
  if (minute < 0) return null;
  return (
    <span className="game-clock" data-clock title="게임 시계 (물리 1초 = 게임 10초)">
      {formatClock(minute * 60)} · {day}일차
    </span>
  );
}

function TopBar() {
  const { store, dispatcher, setName } = useServices();
  const { doc, version } = useDoc();
  const connection = useStore((s) => s.connection);
  const peers = useStore((s) => s.peers);
  const room = useStore((s) => s.room);
  const myName = useStore((s) => s.name);
  const clientId = useStore((s) => s.clientId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState(false);
  const simActive = useSimMode((s) => s.phase !== 'off');
  const c = CONNECTION_KO[connection];

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    const err = startImport(text, sessionStorage, (r) => {
      location.search = `?room=${r}`;
    });
    if (err) store.toast(`가져오기 실패: ${err}`, 'error');
  };

  return (
    <header className="panel topbar">
      <div className="brand">
        <IconCity />
        <span>스마트시티</span>
      </div>
      <input
        key={version}
        className="city-name"
        aria-label="도시 이름"
        disabled={simActive}
        defaultValue={doc.meta.name}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== doc.meta.name) dispatcher.dispatch({ type: 'meta.update', name: v.slice(0, 80) });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="room">방: {room}</span>
      <span className="badge" data-connection={connection}>
        <span className="dot" style={{ background: c.color }} />
        {c.text}
      </span>
      <button className={dashboard ? 'active' : ''} data-dashboard aria-expanded={dashboard} title="도시 현황 (설계 기준)" onClick={() => setDashboard(!dashboard)}>
        <span className="row" style={{ gap: 5 }}>
          <IconChart /> 도시 현황
        </span>
      </button>
      {dashboard && <Dashboard onClose={() => setDashboard(false)} />}
      <SimModeEnterButton />
      <GameClock />
      <div className="spacer" />
      <div className="peers" aria-label="접속자">
        {peers.map((p) => (
          <div key={p.clientId} className="avatar" title={p.clientId === clientId ? `${p.name} (나)` : p.name} style={{ background: p.color }}>
            {p.name.length > 2 ? p.name.slice(-2) : p.name}
          </div>
        ))}
        <span className="muted" style={{ marginLeft: 4 }}>
          {peers.length}명
        </span>
      </div>
      <div className="sep" />
      {nameDraft === null ? (
        <button title="내 이름 바꾸기" onClick={() => setNameDraft(myName)}>
          {myName}
        </button>
      ) : (
        <input
          type="text"
          autoFocus
          aria-label="내 이름"
          value={nameDraft}
          maxLength={32}
          style={{ width: 110 }}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft.trim() && nameDraft !== myName) setName(nameDraft);
            setNameDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setNameDraft(null);
          }}
        />
      )}
      <button title="도시를 JSON 파일로 내보내기" onClick={() => downloadText(`${doc.meta.name || 'city'}.json`, exportDoc(doc))}>
        <span className="row" style={{ gap: 5 }}>
          <IconDownload /> 내보내기
        </span>
      </button>
      <button title="JSON 파일을 새 방으로 가져오기" disabled={simActive} onClick={() => fileRef.current?.click()}>
        <span className="row" style={{ gap: 5 }}>
          <IconUpload /> 가져오기
        </span>
      </button>
      <button
        data-sample-city
        aria-label="현대 신도시 샘플 만들기"
        title="현대 신도시 샘플 만들기: 새 방에 계획도시(중앙녹지 대로·남향 아파트 단지·업무지구)를 만듭니다. 지금 도시는 그대로 남습니다"
        disabled={simActive}
        onClick={() =>
          startSampleCity(sessionStorage, (r) => {
            const q = new URLSearchParams(location.search);
            q.set('room', r);
            location.search = `?${q.toString()}`;
          })
        }
      >
        <span className="row" style={{ gap: 5 }}>
          <IconCity /> 신도시 샘플
        </span>
      </button>
      <input ref={fileRef} className="hidden-file" type="file" accept="application/json,.json" onChange={onImport} />
    </header>
  );
}

const SPEEDS: { v: SimSpeed; label: string }[] = [
  { v: 0, label: '정지' },
  { v: 1, label: '1×' },
  { v: 2, label: '2×' },
  { v: 4, label: '4×' },
];

function StatusBar() {
  const { store, dispatcher } = useServices();
  const render = useStore((s) => s.render);
  const stats = useStore((s) => s.simStats);
  const simStatus = useStore((s) => s.simStatus);
  const speed = useStore((s) => s.simSpeed);
  const overlays = useStore((s) => s.overlays);
  const quality = useStore((s) => s.quality);
  const density = useStore((s) => s.doc.meta.trafficDensity);
  const snapStep = useStore((s) => s.toolOptions.snapStep);
  const [densityDraft, setDensityDraft] = useState<number | null>(null);
  const simActive = useSimMode((s) => s.phase !== 'off');
  const simText = simStatus === 'ready' ? null : simStatus === 'starting' ? '시뮬레이션 준비 중' : '시뮬레이션 준비 중 (교통 엔진 대기)';

  return (
    <footer className="panel statusbar">
      <div className="stat">
        <span>FPS</span>
        <b>{render.fps}</b>
      </div>
      <div className="stat">
        <span>드로우콜</span>
        <b>{render.drawCalls}</b>
      </div>
      <div className="sep" />
      {simText ? (
        <span className="sim-note" data-sim-status={simStatus}>
          {simText}
        </span>
      ) : (
        <>
          <div className="stat">
            <span>차량</span>
            <b>{stats?.vehicles ?? 0}</b>
          </div>
          <div className="stat">
            <span>평균 속도</span>
            <b>{((stats?.avgSpeed ?? 0) * 3.6).toFixed(0)} km/h</b>
          </div>
          <div className="stat">
            <span>제거</span>
            <b>{stats?.removed ?? 0}</b>
          </div>
          {stats?.citizens && (
            <div className="stat" data-citizens title="시뮬레이션 시민: 집 / 직장·상점 / 보행 / 운전">
              <span>시민</span>
              <b>
                {stats.citizens.total}
                <small className="muted"> (보행 {stats.citizens.walking} · 운전 {stats.citizens.driving})</small>
              </b>
            </div>
          )}
        </>
      )}
      <div className="sep" />
      <div className="row speed" role="group" aria-label="시뮬레이션 속도">
        {SPEEDS.map((s) => (
          <button key={s.v} className={speed === s.v ? 'active' : ''} onClick={() => store.set({ simSpeed: s.v })} title={`시뮬레이션 ${s.label}`}>
            {s.v === 0 ? <IconPause /> : s.label}
          </button>
        ))}
      </div>
      <label className="row" title="교통 밀도 (모든 참여자에게 적용)">
        <span className="muted">교통 밀도</span>
        <input
          className="density"
          disabled={simActive}
          type="range"
          min={0}
          max={3}
          step={0.1}
          value={densityDraft ?? density}
          onChange={(e) => setDensityDraft(Number(e.target.value))}
          onPointerUp={() => {
            if (densityDraft !== null && densityDraft !== density) dispatcher.dispatch({ type: 'meta.update', trafficDensity: densityDraft });
            setDensityDraft(null);
          }}
          onKeyUp={() => {
            if (densityDraft !== null && densityDraft !== density) dispatcher.dispatch({ type: 'meta.update', trafficDensity: densityDraft });
            setDensityDraft(null);
          }}
        />
        <b style={{ width: 28 }}>{(densityDraft ?? density).toFixed(1)}</b>
      </label>
      <div className="sep" />
      <div className="row speed" role="group" aria-label="격자 스냅 (G)">
        <span className="muted" title="G 키로 순환">
          격자
        </span>
        {SNAP_STEPS.map((v) => (
          <button key={v} data-snap={v} className={snapStep === v ? 'active' : ''} onClick={() => store.setToolOptions({ snapStep: v })} title={`격자 스냅 ${snapLabel(v)}`}>
            {snapLabel(v)}
          </button>
        ))}
      </div>
      <div className="sep" />
      <label className="toggle">
        <input type="checkbox" checked={overlays.flow} onChange={(e) => store.set({ overlays: { ...overlays, flow: e.target.checked } })} />
        교통 흐름
      </label>
      <label className="toggle">
        <input type="checkbox" checked={overlays.shadows} onChange={(e) => store.set({ overlays: { ...overlays, shadows: e.target.checked } })} />
        그림자
      </label>
      <div className="row speed">
        <button
          data-quality={quality}
          className={quality === 'low' ? 'active' : ''}
          title="그래픽 품질 · 낮음: 산 1겹, 가로수·가로등을 가까이만, 가로수 그림자 없음 (이 브라우저에 기억)"
          onClick={() => setQuality(store, quality === 'low' ? 'normal' : 'low')}
        >
          그래픽: {QUALITY_LABEL[quality]}
        </button>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={overlays.violations} onChange={(e) => store.set({ overlays: { ...overlays, violations: e.target.checked } })} />
        규제 위반
      </label>
      <label className="toggle" title="모든 센서의 감시 범위(부채꼴)와 실제로 보는 차선 구간 · 보정 전 모의 값 · 건물 가림 미반영">
        <input type="checkbox" data-overlay-sensors checked={overlays.sensors} onChange={(e) => store.set({ overlays: { ...overlays, sensors: e.target.checked } })} />
        센서 범위
      </label>
      <div className="spacer" />
      <span className="muted" title="Phase 1: 차량은 각자의 브라우저에서 계산되어 참여자마다 다를 수 있습니다">
        교통은 참여자별 미리보기
      </span>
    </footer>
  );
}

const TABS: { id: PanelId; label: string }[] = [
  { id: 'inspector', label: '속성' },
  { id: 'roadTypes', label: '도로' },
  { id: 'buildings', label: '건물' },
  { id: 'vehicles', label: '차량' },
  { id: 'busLines', label: '노선' },
  { id: 'ai', label: 'AI' },
];

function SidePanel() {
  const { store } = useServices();
  const panel = useStore((s) => s.panel);
  return (
    <aside className={`panel side${panel === 'buildings' ? ' side-wide' : ''}`} aria-label="편집 패널">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={panel === t.id} className={panel === t.id ? 'active' : ''} onClick={() => store.set({ panel: panel === t.id ? null : t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      {panel && (
        <div className="side-body">
          {panel === 'inspector' && <Inspector />}
          {panel === 'roadTypes' && <RoadTypeEditor />}
          {panel === 'buildings' && <BuildingEditor />}
          {panel === 'vehicles' && <VehicleEditor />}
          {panel === 'busLines' && <BusLinePanel />}
          {panel === 'ai' && <AiPanel />}
        </div>
      )}
    </aside>
  );
}

function ToolHint() {
  const hint = useStore((s) => s.toolHint);
  if (!hint) return null;
  return <div className="panel hint">{hint}</div>;
}

function StudioHost() {
  const req = useStudioRequest();
  return req ? <StudioOverlay key={req.key} req={req} /> : null;
}

export function App() {
  return (
    <>
      <StudioHost />
      <TopBar />
      <Toolbar />
      <ToolOptions />
      <GrowthHud />
      <SimModeRoot />
      <SidePanel />
      <ToolHint />
      <Toasts />
      <StatusBar />
      {import.meta.env.DEV && <PerfOverlay />}
      <OfflineCityNotice />
      <ConnectionBanner />
      <ConnectOverlay />
      <OfflineSaveError />
    </>
  );
}
