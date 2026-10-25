// State of the AI building assistant chat (ADR 0009 §5): messages, the running request and the
// proposal under review. A pure reducer so the protocol handling is testable.

import type { Command, ServerMessage } from '@smartcity/shared';

export interface AiMessage {
  id: number;
  role: 'user' | 'assistant' | 'progress' | 'error';
  text: string;
  reqId: number;
}

export interface AiProposal {
  reqId: number;
  commands: Command[];
  summary: string;
}

export interface AiState {
  /** null until the server told us (offline mode never does). */
  enabled: boolean | null;
  model: string | null;
  messages: AiMessage[];
  /** reqId of the request in flight. */
  running: number | null;
  nextReq: number;
  nextMsg: number;
  proposal: AiProposal | null;
}

export type AiEvent =
  | { kind: 'ask'; text: string; /** Pictures sent with it. */ images?: number }
  | { kind: 'cancel' }
  | { kind: 'discard' }
  | { kind: 'server'; msg: ServerMessage };

export const MAX_MESSAGES = 60;

export const initialAi = (): AiState => ({ enabled: null, model: null, messages: [], running: null, nextReq: 1, nextMsg: 1, proposal: null });

function push(s: AiState, role: AiMessage['role'], text: string, reqId: number): AiState {
  const messages = [...s.messages, { id: s.nextMsg, role, text, reqId }].slice(-MAX_MESSAGES);
  return { ...s, messages, nextMsg: s.nextMsg + 1 };
}

/** Drop the live progress note of `reqId` (the next message replaces it). */
function withoutProgress(s: AiState, reqId: number): AiState {
  return { ...s, messages: s.messages.filter((m) => !(m.role === 'progress' && m.reqId === reqId)) };
}

export function reduceAi(s: AiState, ev: AiEvent): AiState {
  switch (ev.kind) {
    case 'ask': {
      if (s.running !== null) return s;
      const reqId = s.nextReq;
      return push({ ...s, running: reqId, nextReq: reqId + 1, proposal: null }, 'user', ev.images ? `${ev.text} [이미지 ${ev.images}장]` : ev.text, reqId);
    }
    case 'cancel': {
      if (s.running === null) return s;
      return push(withoutProgress({ ...s, running: null }, s.running), 'error', '요청을 취소했습니다', s.running);
    }
    case 'discard':
      return { ...s, proposal: null };
    case 'server': {
      const m = ev.msg;
      switch (m.t) {
        case 'ai.status':
          return { ...s, enabled: m.enabled, model: m.model };
        case 'ai.progress': {
          if (m.reqId !== s.running) return s;
          const last = s.messages[s.messages.length - 1];
          if (last && last.role === 'progress' && last.reqId === m.reqId) {
            return { ...s, messages: [...s.messages.slice(0, -1), { ...last, text: m.note }] };
          }
          return push(s, 'progress', m.note, m.reqId);
        }
        case 'ai.proposal':
          if (m.reqId !== s.running) return s;
          return push(withoutProgress({ ...s, running: null, proposal: { reqId: m.reqId, commands: m.commands, summary: m.summary } }, m.reqId), 'assistant', m.summary, m.reqId);
        case 'ai.error':
          if (m.reqId !== s.running) return s;
          return push(withoutProgress({ ...s, running: null }, m.reqId), 'error', m.error, m.reqId);
        default:
          return s;
      }
    }
  }
}
