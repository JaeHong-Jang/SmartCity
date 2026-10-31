// AI 관제실 (ADR 0015 §6, P8a minimum): the agents (eye / brain / body color, state, evidence) and the recent
// decision log of the simulated copy; picking a decision highlights its target on the map and moves the
// camera there. Reads the simulator-mode store only.

import { AGENTS, type Decision } from '@smartcity/sim';
import { agentInfo, agentName, decisionTime, evidenceLines, offReason, ROLE_COLOR, ROLE_LABEL, STATE_LABEL, VERDICT_LABEL } from '../../simmode/controlText';
import { simModeStore, useSimMode } from '../../simmode/store';
import { useServices } from '../context';

/** Decisions listed (newest first); the sim keeps a bounded audit log and sends the last 30. */
const SHOWN = 12;

export function ControlRoom() {
  const control = useSimMode((s) => s.control);
  const selected = useSimMode((s) => s.selectedDecision);
  const { focus } = useServices();
  const states = new Map(control?.agents.map((a) => [a.id, a.state]) ?? []);
  const decisions = (control?.decisions ?? []).slice(-SHOWN).reverse();
  const pick = (d: Decision): void => {
    if (selected?.seq === d.seq) {
      simModeStore.set({ selectedDecision: null });
      return;
    }
    simModeStore.set({ selectedDecision: d });
    if (d.target) focus({ x: d.target.x, z: d.target.z });
  };
  return (
    <aside className="panel sim-control" data-simmode-control aria-label="AI 관제실">
      <h3>
        AI 관제실 <span className="muted">· 관측된 사건만으로 판단하는 규칙 기반 에이전트</span>
      </h3>
      <ul className="ctl-agents" data-simmode-agents>
        {AGENTS.map((a) => {
          const state = states.get(a.id) ?? 'off';
          return (
            <li key={a.id} data-agent={a.id} data-state={state} title={a.evidence.map((e) => e.note).join('\n')}>
              <span className="ctl-roles">
                {a.roles.map((r) => (
                  <i key={r} data-role={r} style={{ background: ROLE_COLOR[r] }}>
                    {ROLE_LABEL[r]}
                  </i>
                ))}
              </span>
              <b className="ctl-name">{agentName(a.id)}</b>
              <span className={`ctl-state ${state}`}>{STATE_LABEL[state]}</span>
              <span className="ctl-evidence" data-agent-evidence>
                근거 {evidenceLines(a).join(' / ')}
                {state === 'off' && offReason(a) ? ` · ${offReason(a)}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <h3>
        최근 결정 <span className="muted">· 총 {control?.total ?? 0}건{control && control.repeated > 0 ? ` · 대기 중 요청 ${control.repeated}회 집계` : ''}</span>
      </h3>
      <ol className="ctl-log" data-simmode-decisions>
        {decisions.length === 0 && <li className="muted">아직 없음 · 사건을 넣으면 감지·출동·우선신호·우회 결정이 여기에 남습니다</li>}
        {decisions.map((d) => {
          const role = agentInfo(d.agent).roles[0]!;
          return (
            <li key={d.seq}>
              <button
                data-decision={d.seq}
                data-decision-agent={d.agent}
                data-decision-action={d.action}
                data-verdict={d.verdict}
                className={selected?.seq === d.seq ? 'active' : ''}
                disabled={!d.target}
                title={d.target ? '지도에서 대상 보기' : '지도 대상 없음'}
                onClick={() => pick(d)}
              >
                <span className="ctl-time">{decisionTime(d)}</span>
                <span className="ctl-agent" style={{ color: ROLE_COLOR[role] }}>
                  {d.agent}
                </span>
                <span className="ctl-text">
                  {d.verdict !== 'accepted' && <em className={`ctl-verdict ${d.verdict}`}>{VERDICT_LABEL[d.verdict]}</em>}
                  {d.text}
                </span>
                <span className="ctl-reason muted">{d.reason}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="muted ctl-note">근거 = 출처 유형 · 성과 상태 [보고서 참고문헌]. 다른 도시·조건의 수치이며 모델 효과로 쓰지 않음 (게임 모델, 보정 전 값)</p>
    </aside>
  );
}
