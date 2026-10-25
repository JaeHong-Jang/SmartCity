// AI building assistant (ADR 0009 §5): chat, progress, and review of the proposal (preview in 3D,
// per-item conflicts, apply as the user's own batch).

import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_AI_TEXT, type AiImage, type CityDoc, type Vec2 } from '@smartcity/shared';
import { checkSource, compressImage, DEFAULT_IMAGE_TEXT, imageBudget } from '../app/aiImage';
import { confirmHighlight, liveBox, liveTargets, replayHighlight } from '../app/highlights';
import { itemLabel, proposalCatalog, proposalCenter, proposalItems, proposalRoadInfos } from '../app/proposal';
import { applyProposal } from '../app/proposalApply';
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
  const { store, dispatcher, focus, fit, send, cameraTarget } = useServices();
  const { doc, version } = useDoc();
  const ai = useStore((s) => s.ai);
  const status = useStore((s) => s.proposalStatus);
  const connection = useStore((s) => s.connection);
  const highlights = useStore((s) => s.highlights);
  const [text, setText] = useState('');
  const [images, setImages] = useState<{ id: number; blob: Blob; url: string }[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const imageSeq = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.url)), []);
  const [applyError, setApplyError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [ai.messages]);

  const waiting = useStore((s) => (s.ai.proposal ? (s.aiPending[s.ai.proposal.reqId] ?? 0) > 0 : false));
  const applying = useStore((s) => s.aiApplying !== null && s.aiApplying === s.ai.proposal?.reqId) || waiting;
  const items = useMemo(() => (ai.proposal ? proposalItems(ai.proposal.commands) : []), [ai.proposal]);
  const catalog = useMemo(() => proposalCatalog(items), [items]);
  const roadInfos = useMemo(() => proposalRoadInfos(doc, items, version), [doc, items, version]);
  const invalid = status && ai.proposal && status.reqId === ai.proposal.reqId ? status.invalid : {};
  const bad = Object.keys(invalid).length;
  const good = items.length - bad;

  const attach = (files: Iterable<File>) => {
    let count = images.length;
    const added: typeof images = [];
    for (const f of files) {
      const problem = checkSource(f, count);
      if (problem) {
        store.toast(problem, 'error');
        break;
      }
      added.push({ id: ++imageSeq.current, blob: f, url: URL.createObjectURL(f) });
      count++;
    }
    if (added.length) setImages((cur) => [...cur, ...added]);
  };
  const removeImage = (id: number) =>
    setImages((cur) => {
      cur.filter((i) => i.id === id).forEach((i) => URL.revokeObjectURL(i.url));
      return cur.filter((i) => i.id !== id);
    });
  const clearImages = () => {
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setImages([]);
  };
  /** Sends the request; true when it went out (the caller then clears the input). */
  const ask = async (q: string, pics: typeof images = images): Promise<boolean> => {
    const t = q.trim() || (pics.length ? DEFAULT_IMAGE_TEXT : '');
    if (!t || ai.running !== null || preparing) return false;
    let payload: AiImage[] = [];
    if (pics.length) {
      setPreparing(true);
      try {
        payload = await Promise.all(pics.map((p) => compressImage(p.blob, imageBudget(pics.length))));
      } catch {
        store.toast('이미지를 처리하지 못했습니다. 다른 이미지로 다시 시도해 주세요', 'error');
        return false;
      } finally {
        setPreparing(false);
      }
    }
    const reqId = store.getState().ai.nextReq;
    const s = store.getState();
    store.aiEvent({ kind: 'ask', text: t, ...(payload.length ? { images: payload.length } : {}) });
    setApplyError(null);
    send({ t: 'ai.ask', reqId, text: t, focus: focusPoint(s.doc, s.selection, cameraTarget()), ...(payload.length ? { images: payload } : {}) });
    return true;
  };
  const submit = async () => {
    if (await ask(text)) {
      setText('');
      clearImages();
    }
  };
  const cancel = () => {
    if (ai.running === null) return;
    send({ t: 'ai.cancel', reqId: ai.running });
    store.aiEvent({ kind: 'cancel' });
  };
  const apply = async () => {
    if (applying || items.length === 0) return;
    setApplyError(null);
    // One apply per proposal lives in the store: a second call (e.g. after reopening the panel) joins it.
    const r = await applyProposal(store, dispatcher.dispatch, items, invalid, ai.proposal?.summary ?? '', ai.proposal?.reqId ?? 0);
    if (r.applied === 0 && r.pending === 0 && r.lost === 0 && r.error) setApplyError(translateError(r.error));
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
    <div
      className={`ai-panel${dragOver ? ' drag' : ''}`}
      data-ai-panel
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        if (files.length) {
          e.preventDefault();
          attach(files);
        }
      }}
    >
      <h3>AI 건설 도우미 {ai.model && <span className="muted">· {ai.model}</span>}</h3>
      <div className="ai-log" ref={logRef} aria-live="polite">
        {ai.messages.length === 0 && <span className="muted">예) "카페 지어줘", "이 도로 양옆에 상업지구 만들어줘". 선택한 위치(없으면 화면 중앙) 근처에 제안합니다.</span>}
        {ai.messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`} data-ai-msg={m.role}>
            {m.text}
          </div>
        ))}
      </div>
      {highlights.items.length > 0 && (
        <div className="ai-recent">
          <b>최근 적용</b>
          <ul>
            {[...highlights.items].reverse().map((h) => {
              const live = liveTargets(h, doc);
              return (
                <li key={h.id} data-ai-applied={h.id}>
                  <span className="ai-recent-label" title={h.label}>
                    {h.label}
                  </span>
                  <small className="muted">
                    건물 {live.buildingIds.length} · 도로 {live.roadSegmentIds.length} · 필지 {live.parcelIds.length}
                  </small>
                  <button
                    data-ai-show
                    onClick={() => {
                      const box = liveBox(h, doc);
                      if (box) fit(box);
                      store.set({ highlights: replayHighlight(store.getState().highlights, h.id, Date.now()) });
                    }}
                  >
                    보기
                  </button>
                  <button data-ai-confirm disabled={h.confirmed} onClick={() => store.set({ highlights: confirmHighlight(store.getState().highlights, h.id) })}>
                    {h.confirmed ? '확인됨' : '확인'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
                {itemLabel(doc, catalog, it.cmd, roadInfos.get(it.index))}
                {it.index in invalid && <small> · 충돌: {translateError(invalid[it.index]!)}</small>}
              </li>
            ))}
          </ul>
          {applyError && <div className="ai-msg error">거부됨: {applyError}</div>}
          <div className="row wrap">
            <button className="primary" data-ai-apply disabled={good === 0 || applying} onClick={apply}>
              {waiting ? '결과 확인 중' : bad === 0 ? '적용' : `가능한 항목만 적용 (${good}/${items.length})`}
            </button>
            {bad > 0 && lastQuestion && (
              <button
                data-ai-retry
                onClick={() => {
                  store.aiEvent({ kind: 'discard' });
                  void ask(lastQuestion, []);
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
      {images.length > 0 && (
        <div className="ai-thumbs">
          {images.map((i) => (
            <span key={i.id} className="ai-thumb" data-ai-thumb>
              <img src={i.url} alt="첨부 이미지" />
              <button aria-label="첨부 제거" data-ai-thumb-remove onClick={() => removeImage(i.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row" style={{ alignItems: 'stretch' }}>
        <textarea
          aria-label="AI에게 요청"
          rows={2}
          value={text}
          maxLength={MAX_AI_TEXT}
          placeholder={images.length ? '이미지 설명 (비워도 됨)' : '무엇을 지을까요?'}
          style={{ flex: 1, resize: 'none' }}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              attach(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
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
            disabled={(!text.trim() && images.length === 0) || preparing}
            onClick={() => void submit()}
          >
            {preparing ? '준비 중…' : '보내기'}
          </button>
        )}
      </div>
      <div className="row">
        <button data-ai-attach disabled={images.length >= 2} title="사진·그림을 보고 비슷한 건물을 설계합니다 (최대 2장, 붙여넣기·끌어놓기도 가능)" onClick={() => fileRef.current?.click()}>
          이미지 첨부
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-ai-file
          onChange={(e) => {
            attach(e.target.files ?? []);
            e.target.value = '';
          }}
        />
        <span className="muted">{text.length}/{MAX_AI_TEXT} · 제안은 미리보기 후 승인해야 적용됩니다</span>
      </div>
    </div>
  );
}
