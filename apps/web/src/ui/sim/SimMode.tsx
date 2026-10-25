// Simulator-mode UI: entry button, banner, event palette, policy, compare panel (ADR 0010).

import { useEffect, useRef } from 'react';
import './blackout.css';
import { CLOCK_SCALE } from '@smartcity/sim';
import { formatClock } from '../../render/dayNight';
import { simModeController } from '../../simmode/instance';
import { alignKpiSeries, inclusiveResponseTime, KPI_METRICS, rebaseSeries } from '../../simmode/kpiSeries';
import { blackoutState, dispatchText, incidentText, powerSummaryText } from '../../simmode/emergencyText';
import { facilityHint, FACILITY_SUMMARY, SUPPLY_MODEL_NOTE } from '../../simmode/facilities';
import { DEFAULT_ARMED, useSimMode, type EventKind, type EventRow } from '../../simmode/store';
import { ticksToGameMin, WARMUP_GAME_MIN, WARMUP_TICKS } from '../../simmode/time';
import { useServices, useStore } from '../context';
import { KpiChart } from './KpiChart';

export function SimModeEnterButton() {
  const phase = useSimMode((s) => s.phase);
  const ready = useStore((s) => s.ready && s.simStatus === 'ready');
  if (phase !== 'off') return null;
  return (
    <button data-simmode-enter disabled={!ready} title="현재 도시의 사본에서 사고·통제·행사를 실험합니다 (다른 사용자에게 영향 없음)" onClick={() => simModeController().enter()}>
      시뮬레이터
    </button>
  );
}

function Banner() {
  const s = useSimMode((x) => x);
  const warming = s.phase === 'warming';
  return (
    <div className="panel sim-banner" data-simmode-banner data-phase={s.phase}>
      <b>시뮬레이터 모드</b>
      <span>
        사본(seq {s.baseSeq}, {formatClock(s.baseDayTime)} 기준)
      </span>
      <span>다른 사용자에게 영향 없음</span>
      <span className="muted">게임 모델(보정 전 값) · 현재 설계로 새 실험</span>
      {warming ? (
        <span data-simmode-warmup className="sim-progress-wrap">
          준비 운행 {WARMUP_GAME_MIN}분 <progress value={s.progress} max={1} /> {Math.round(s.progress * 100)}%
        </span>
      ) : (
        <span data-simmode-ready className="ok-text">
          준비 완료 · 사본 {Math.floor(ticksToGameMin(s.tick))}분 경과
        </span>
      )}
      {s.error && (
        <span className="sim-error" role="alert">
          {s.error}
        </span>
      )}
      <div className="spacer" />
      <button data-simmode-restart onClick={() => simModeController().restart()} title="공유 도시의 최신 상태로 사본을 다시 만듭니다">
        최신 도시로 다시 시작
      </button>
      <button className="primary" data-simmode-exit onClick={() => simModeController().exit()}>
        나가기
      </button>
    </div>
  );
}

const EVENT_BUTTONS: { kind: EventKind; label: string; hint: string }[] = [
  { kind: 'closure', label: '도로 통제', hint: '도로를 클릭하면 전 차선이 통제됩니다' },
  { kind: 'accident', label: '사고', hint: '도로의 차선 위치를 클릭하세요' },
  { kind: 'surge', label: '행사·수요 급증', hint: '건물을 클릭하세요' },
  { kind: 'fire', label: '화재', hint: '불을 낼 건물을 클릭하세요' },
  { kind: 'medical', label: '응급 환자', hint: '환자가 생길 건물을 클릭하세요' },
  { kind: 'blackout', label: '정전', hint: '변전소를 클릭하거나(담당 구역 정전), 구역 정전은 땅을 클릭하세요' },
];

function NumField({ label, value, min, max, onChange, id }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; id: string }) {
  return (
    <label className="sim-num">
      <span>{label}</span>
      <input
        type="number"
        data-simmode-param={id}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
    </label>
  );
}

function remainingText(e: EventRow, tick: number, fatal: boolean): string {
  if (e.status === 'rejected') return `거부됨: ${e.error ?? ''}`;
  if (e.status === 'pending') return fatal ? '확인 중단됨' : '확인 중';
  if (e.ended) return '종료됨';
  if (!e.active) return `예정 · ${Math.ceil(ticksToGameMin(Math.max(0, e.startTick - tick)))}분 후 시작`;
  if (e.endTick === null) return '진행 중 (수동 종료)';
  if (tick >= e.endTick) return '종료 중';
  return `남은 ${Math.ceil(ticksToGameMin(e.endTick - tick))}분`;
}

function emergencyRowText(e: EventRow, tick: number, fatal: boolean): string {
  if (e.status === 'pending' || e.status === 'rejected' || (!e.active && !e.ended && !e.endReason)) return remainingText(e, tick, fatal);
  // The incident and the vehicle can both say "이송 중": show each phrase once.
  const parts = [incidentText(e), ...dispatchText(e).split(' · ')].filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

/** Blackout row state: 정전 중 (남은 N분) → 복구됨. */
function blackoutRowText(e: EventRow, tick: number, fatal: boolean): string {
  return blackoutState(e, tick, ticksToGameMin) ?? remainingText(e, tick, fatal);
}

function Palette() {
  const s = useSimMode((x) => x);
  const c = simModeController();
  const ready = s.phase === 'ready' && !s.fatal;
  const armed = s.armed;
  const locked = s.events.length > 0;
  const { focus } = useServices();
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upd = (patch: Partial<NonNullable<typeof armed>>) => armed && c.setArmed({ ...armed, ...patch });
  return (
    <aside className="panel sim-panel" aria-label="사건 팔레트">
      <h3>사건</h3>
      <div className="row wrap">
        {EVENT_BUTTONS.map((b) => (
          <button key={b.kind} data-simmode-event={b.kind} className={armed?.kind === b.kind ? 'active' : ''} disabled={!ready} title={b.hint} onClick={() => c.setArmed(armed?.kind === b.kind ? null : { ...DEFAULT_ARMED[b.kind] })}>
            {b.label}
          </button>
        ))}
      </div>
      {armed && (
        <div className="sim-params">
          {armed.kind === 'blackout' && (
            <>
              <div className="sim-blackout-mode" role="group" aria-label="정전 방식">
                <button data-simmode-blackout-mode="substation" className={armed.blackoutMode === 'substation' ? 'active' : ''} onClick={() => upd({ blackoutMode: 'substation' })}>
                  변전소
                </button>
                <button data-simmode-blackout-mode="area" className={armed.blackoutMode === 'area' ? 'active' : ''} onClick={() => upd({ blackoutMode: 'area' })}>
                  구역
                </button>
              </div>
              {armed.blackoutMode === 'area' && <NumField id="radius" label="반경(m)" value={armed.radius} min={10} max={20000} onChange={(v) => upd({ radius: v })} />}
              <NumField id="duration" label="기간(게임 분)" value={armed.durationMin} min={1} max={600} onChange={(v) => upd({ durationMin: v })} />
            </>
          )}
          {armed.kind === 'fire' || armed.kind === 'medical' || armed.kind === 'blackout' ? null : armed.kind !== 'surge' ? (
            <NumField id="duration" label="기간(게임 분)" value={armed.durationMin} min={1} max={600} onChange={(v) => upd({ durationMin: v })} />
          ) : (
            <>
              <NumField id="people" label="인원" value={armed.people} min={1} max={2000} onChange={(v) => upd({ people: v })} />
              <NumField id="inflow" label="유입(분)" value={armed.inflowMin} min={0} max={240} onChange={(v) => upd({ inflowMin: v })} />
              <NumField id="stay" label="체류(분)" value={armed.stayMin} min={0} max={480} onChange={(v) => upd({ stayMin: v })} />
              <NumField id="outflow" label="유출(분)" value={armed.outflowMin} min={0} max={240} onChange={(v) => upd({ outflowMin: v })} />
            </>
          )}
          <span className="muted" data-simmode-arm-hint>
            {EVENT_BUTTONS.find((b) => b.kind === armed.kind)!.hint}
          </span>
          {armed.kind === 'blackout' && armed.blackoutMode === 'substation' && facilityHint('blackout', s.facilities) && (
            <span className="sim-error" data-simmode-facility-hint role="status">
              {facilityHint('blackout', s.facilities)}
            </span>
          )}
          {(armed.kind === 'fire' || armed.kind === 'medical') && facilityHint(armed.kind, s.facilities) && (
            <span className="sim-error" data-simmode-facility-hint role="status">
              {facilityHint(armed.kind, s.facilities)}
            </span>
          )}
        </div>
      )}
      <span className="muted" data-simmode-facilities title="사본 도시의 시설 (설계의 service 종류 기준) · 커버리지 기반 공급 모델">
        시설 · {FACILITY_SUMMARY(s.facilities)}
      </span>
      <span className="sim-supply-note" data-simmode-supply-note>
        {SUPPLY_MODEL_NOTE}
      </span>
      <h3>스마트 대응: 우회 안내 + 긴급차량 신호 우선 + 신호 배터리</h3>
      <label className="toggle" title={locked ? '사건을 넣은 뒤에는 바꿀 수 없습니다. 비교 실행이 반대 정책을 돌려 줍니다' : '정보를 가진 차량이 사건 시작·종료 때 경로를 다시 찾습니다'}>
        <input type="checkbox" data-simmode-policy checked={s.policy.reroute} disabled={!ready || locked} onChange={(e) => c.setPolicy({ ...s.policy, reroute: e.target.checked })} />
        스마트 대응 {s.policy.reroute ? 'ON' : 'OFF'}
      </label>
      <label className="sim-num">
        <span>정보 차량 비율 {Math.round(s.policy.informedShare * 100)}%</span>
        <input
          type="range"
          data-simmode-share
          min={0}
          max={100}
          step={5}
          value={Math.round(s.policy.informedShare * 100)}
          disabled={!ready || locked}
          onChange={(e) => c.setPolicy({ ...s.policy, informedShare: Number(e.target.value) / 100 })}
        />
      </label>
      <h3>활성·예정 사건</h3>
      <ul className="sim-events" data-simmode-events>
        {s.events.length === 0 && <li className="muted">아직 없음</li>}
        {s.events.map((e) => {
          return (
            <li
              key={e.eventId}
              data-simmode-eventrow={e.kind}
              data-status={e.status}
              onMouseEnter={() => {
                if (hover.current) clearTimeout(hover.current);
                hover.current = setTimeout(() => focus(e.pos), 350);
              }}
              onMouseLeave={() => hover.current && clearTimeout(hover.current)}
            >
              <span className="sim-ev-label">{e.label}</span>
              <span className="muted">{e.kind === 'fire' || e.kind === 'medical' ? emergencyRowText(e, s.tick, s.fatal) : e.kind === 'blackout' ? blackoutRowText(e, s.tick, s.fatal) : remainingText(e, s.tick, s.fatal)}</span>
              {e.note && (
                <span className="muted" data-simmode-note>
                  {e.note}
                </span>
              )}
              {e.endError && (
                <span className="sim-error" data-simmode-end-error role="alert">
                  종료 거부됨: {e.endError}
                </span>
              )}
              <button data-simmode-view onClick={() => focus(e.pos)}>
                보기
              </button>
              {e.kind !== 'surge' && e.active && e.status !== 'rejected' && (
                <button data-simmode-end onClick={() => c.endEvent(e.eventId)}>
                  종료
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {(s.power.dark > 0 || s.power.battery > 0 || s.power.buildings > 0 || s.events.some((e) => e.kind === 'blackout' && e.active)) && (
        <span className="sim-power-line" data-simmode-power title="사건별 수치가 아니라 도시 전체의 현재 값입니다">
          {powerSummaryText(s.power)}
        </span>
      )}
      <div className="row wrap">
        {s.phase === 'comparing' ? (
          <button className="danger" data-simmode-compare-cancel onClick={() => c.cancelCompare()}>
            비교 취소
          </button>
        ) : (
          <button className="primary" data-simmode-compare disabled={!ready || s.aligning || s.tick < WARMUP_TICKS + 60} onClick={() => c.compare()} title="반대 정책을 별도 워커에서 같은 tick까지 돌려 KPI를 비교합니다">
            ON/OFF 비교 실행
          </button>
        )}
      </div>
    </aside>
  );
}

function fmtMin(sec: number): string {
  return ((sec * CLOCK_SCALE) / 60).toFixed(1);
}

function ComparePanel() {
  const phase = useSimMode((s) => s.phase);
  const progress = useSimMode((s) => s.progress);
  const cmp = useSimMode((s) => s.compare);
  if (phase === 'comparing') {
    return (
      <aside className="panel sim-compare" data-simmode-comparing>
        <h3>비교 실행 중</h3>
        <progress data-simmode-progress value={progress} max={1} />
        <span className="muted">{Math.round(progress * 100)}% · 화면 사본은 일시정지됩니다</span>
      </aside>
    );
  }
  if (!cmp) return null;
  // Charts and table count from the end of warm-up (counters rebased to the tick-1200 grid point).
  const rows = alignKpiSeries(rebaseSeries(cmp.on, WARMUP_TICKS), rebaseSeries(cmp.off, WARMUP_TICKS), cmp.untilTick).filter((r) => r.tick >= WARMUP_TICKS);
  const last = rows[rows.length - 1];
  const on = last?.on;
  const off = last?.off;
  const line = (k: typeof on, label: string) =>
    k && (
      <tr data-simmode-row={label}>
        <th>{label}</th>
        <td>{k.completed}</td>
        <td>{fmtMin(k.avgTravelTime)}분</td>
        <td>{Math.round(k.congestionLength)}m</td>
        <td>{k.noRoute + k.waitingToDepart}</td>
        <td>{k.rerouted}</td>
        <td data-simmode-inclusive>{k.responses + k.respondingNow > 0 ? `${inclusiveResponseTime(k).toFixed(1)}분` : '—'}</td>
        <td data-simmode-arrived-avg>{k.responses > 0 ? `${k.avgResponseTime.toFixed(1)}분` : '—'}</td>
        <td>
          대응 {k.responses}건 · 미도착 {k.respondingNow}건
        </td>
        <td>
          {k.extinguished} / {k.damaged} / {k.medicalCompleted}
        </td>
        <td>{k.dispatchFailed}</td>
        <td>
          {k.darkJunctionMinutes.toFixed(1)} / {k.batteryJunctionMinutes.toFixed(1)}
        </td>
        <td>
          {k.inProgress} / {k.droppedTrips}
        </td>
      </tr>
    );
  return (
    <aside className="panel sim-compare" data-simmode-result>
      <h3>스마트 대응 ON / OFF 비교 · 준비 운행 이후 (sim tick {WARMUP_TICKS}–{cmp.untilTick})</h3>
      <div className="sim-legend">
        <span className="swatch-on" /> ON <span className="swatch-off" /> OFF
      </div>
      <div className="sim-charts">
        {KPI_METRICS.map((m) => (
          <KpiChart key={m.id} rows={rows} metric={m} />
        ))}
      </div>
      <div className="sim-table-wrap">
      <table className="sim-table" data-simmode-table>
        <thead>
          <tr>
            <th>준비 운행 이후</th>
            <th>완료</th>
            <th>평균 통행</th>
            <th>정체</th>
            <th>경로없음+대기</th>
            <th>재탐색</th>
            <th>대응 시간(미도착 포함)</th>
            <th>도착 평균</th>
            <th>대응 · 미도착</th>
            <th>진화/피해/이송</th>
            <th>출동 불가</th>
            <th>정전/배터리 교차로·분</th>
            <th>미완료 / 포기</th>
          </tr>
        </thead>
        <tbody>
          {line(on, 'ON')}
          {line(off, 'OFF')}
        </tbody>
      </table>
      </div>
      <p className="muted" data-simmode-response-note>
        평균 대응 시간: 도착 전 출동은 경과 시간으로 계산(하한). 도착한 차량만의 평균은 "도착 평균"입니다.
      </p>
      <p className="muted">미완료 = 아직 도로 위에 있는 차량, 포기 = 경로 없음·막힌 출발지로 시작하지 못한 통행. ON이 항상 낫지 않을 수 있음 — 게임 모델(보정 전 값).</p>
    </aside>
  );
}

/** Mounted once in App: toggles the body flag that greys out the shared editing UI, renders the panels. */
export function SimModeRoot() {
  const active = useSimMode((s) => s.phase !== 'off');
  useEffect(() => {
    document.body.toggleAttribute('data-simmode', active);
    return () => document.body.removeAttribute('data-simmode');
  }, [active]);
  if (!active) return null;
  return (
    <>
      <Banner />
      <Palette />
      <ComparePanel />
      <div className="panel sim-lock-note">공유 도시 편집 도구는 시뮬레이터 모드에서 잠겨 있습니다</div>
    </>
  );
}
