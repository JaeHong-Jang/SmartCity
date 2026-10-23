// AI building assistant (ADR 0009 §5): chat, progress, and review of the proposal (preview in 3D,
// per-item conflicts, apply as the user's own batch).

import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_AI_TEXT, type CityDoc, type Vec2 } from '@smartcity/shared';
import { applicableBatch, itemLabel, proposalCatalog, proposalCenter, proposalItems } from '../app/proposal';
import { translateError } from '../app/store';
import { stopPosition } from '../render/busRoute';
import { useDoc, useServices, useStore } from './context';

/** Where the assistant should build: the selection, else the point the camera looks at. */
export function focusPoint(doc: CityDoc, sel: { kind: string; id: string } | null, camera: Vec2): Vec2 {
  if (sel?.kind === 'node') return doc.nodes[sel.id]?.pos ?? camera;
  if (sel?.kind === 'building') return doc.buildings[sel.id]?.pos ?? camera;
  if (sel?.kind === 'busStop') {
    const st = doc.busStops[sel.id];
    return (st && stopPosition(doc, st)) ?? camera;
  }
  if (sel?.kind === 'parcel') {
    const poly = doc.parcels[sel.id]?.polygon;
    if (poly?.length) return { x: poly.reduce((a, v) => a + v.x, 0) / poly.length, z: poly.reduce((a, v) => a + v.z, 0) / poly.length };
  }
  return camera;
}

export function AiPanel() {
  const { store, dispatcher, focus, send, cameraTarget } = useServices();
  const { doc, version } = useDoc();
  const ai = useStore((s) => s.ai);
  const status = useStore((s) => s.proposalStatus);
  const connection = useStore((s) => s.connection);
  const [text, setText] = useState('');
  const [applyRef, setApplyRef] = useState<number | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const result = useStore((s) => (applyRef === null ? undefined : s.results[applyRef]));
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [ai.messages]);

  useEffect(() => {
    if (applyRef === null || result === undefined) return;
    setApplyRef(null);
    if (result === 'ok') {
      store.aiEvent({ kind: 'discard' });
      store.toast('AI 제안을 적용했습니다 (Ctrl+Z로 되돌릴 수 있습니다)', 'success');
    } else setApplyError(translateError(result));
  }, [applyRef, result, store]);

  const items = useMemo(() => (ai.proposal ? proposalItems(ai.proposal.commands) : []), [ai.proposal]);
  const catalog = useMemo(() => proposalCatalog(items), [items]);
  const invalid = status && ai.proposal && status.reqId === ai.proposal.reqId ? status.invalid : {};
  const bad = Object.keys(invalid).length;
  const good = items.length - bad;

  const ask = (q: string) => {
    const t = q.trim();
    if (!t || ai.running !== null) return;
    const reqId = ai.nextReq;
    const s = store.getState();
    store.aiEvent({ kind: 'ask', text: t });
    setApplyError(null);
    send({ t: 'ai.ask', reqId, text: t, focus: focusPoint(s.doc, s.selection, cameraTarget()) });
  };
  const cancel = () => {
    if (ai.running === null) return;
    send({ t: 'ai.cancel', reqId: ai.running });
    store.aiEvent({ kind: 'cancel' });
  };
  const apply = () => {
    const batch = applicableBatch(items, invalid);
    if (!batch) return;
    setApplyError(null);
    setApplyRef(dispatcher.dispatch(batch));
  };
  const lastQuestion = [...ai.messages].reverse().find((m) => m.role === 'user')?.text;

  if (connection === 'offline') return <><h3>AI 건설 도우미</h3><span className="muted" data-ai-note>서버 연결 시 사용 가능</span></>;
  if (ai.enabled === false) {
    return (
      <>
        <h3>AI 건설 도우미</h3>
        <span className="muted" data-ai-note>AI 비활성: 서버에 ANTHROPIC_API_KEY가 없습니다 (apps/server/.env)</span>
      </>
    );
  }
  if (ai.enabled === null) return <><h3>AI 건설 도우미</h3><span className="muted" data-ai-note>AI 상태 확인 중…</span></>;

  return (
    <div className="ai-panel" data-ai-panel>
      <h3>AI 건설 도우미 {ai.model && <span className="muted">· {ai.model}</span>}</h3>
      <div className="ai-log" ref={logRef} aria-live="polite">
        {ai.messages.length === 0 && <span className="muted">예) "카페 지어줘", "이 도로 양옆에 상업지구 만들어줘". 선택한 위치(없으면 화면 중앙) 근처에 제안합니다.</span>}
        {ai.messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`} data-ai-msg={m.role}>
            {m.text}
          </div>
        ))}
      </div>
      {ai.proposal && (
        <div className="ai-proposal" data-ai-proposal>
          <div className="row">
            <b style={{ flex: 1 }}>제안 {good}/{items.length}개 적용 가능</b>
            <button
              onClick={() => {
                const c = proposalCenter(items);
                if (c) focus(c);
              }}
            >
              보기
            </button>
          </div>
          <ul className="ai-items">
            {items.map((it) => (
              <li key={it.index} className={it.index in invalid ? 'bad' : ''} title={it.index in invalid ? translateError(invalid[it.index]!) : undefined}>
                {itemLabel(doc, catalog, it.cmd)}
                {it.index in invalid && <small> · 충돌: {translateError(invalid[it.index]!)}</small>}
              </li>
            ))}
          </ul>
          {applyError && <div className="ai-msg error">거부됨: {applyError}</div>}
          <div className="row wrap">
            <button className="primary" data-ai-apply disabled={good === 0 || applyRef !== null} onClick={apply}>
              {bad === 0 ? '적용' : `가능한 항목만 적용 (${good}/${items.length})`}
            </button>
            {bad > 0 && lastQuestion && (
              <button
                data-ai-retry
                onClick={() => {
                  store.aiEvent({ kind: 'discard' });
                  ask(lastQuestion);
                }}
              >
                다시 요청
              </button>
            )}
            <button data-ai-discard onClick={() => store.aiEvent({ kind: 'discard' })}>
              취소
            </button>
          </div>
        </div>
      )}
      <div className="row" style={{ alignItems: 'stretch' }}>
        <textarea
          aria-label="AI에게 요청"
          rows={2}
          value={text}
          maxLength={MAX_AI_TEXT}
          placeholder="무엇을 지을까요?"
          style={{ flex: 1, resize: 'none' }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(text);
              if (ai.running === null && text.trim()) setText('');
            }
          }}
        />
        {ai.running !== null ? (
          <button data-ai-cancel className="danger" onClick={cancel}>
            중단
          </button>
        ) : (
          <button
            className="primary"
            data-ai-send
            disabled={!text.trim()}
            onClick={() => {
              ask(text);
              setText('');
            }}
          >
            보내기
          </button>
        )}
      </div>
      <span className="muted">{text.length}/{MAX_AI_TEXT} · 제안은 미리보기 후 승인해야 적용됩니다</span>
    </div>
  );
}
