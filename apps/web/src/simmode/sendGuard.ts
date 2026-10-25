// Defense in depth for the edit lock (ADR 0010 §1): while simulator mode is active nothing that edits the
// shared city (`cmd`) or asks the shared AI (`ai.*`) may leave the browser, whatever UI path produced it.

import type { ClientMessage } from '@smartcity/shared';

export const SIM_LOCK_TOAST = '시뮬레이터 모드에서는 공유 도시를 편집할 수 없습니다';

export function isSharedEditMessage(msg: ClientMessage): boolean {
  return msg.t === 'cmd' || msg.t.startsWith('ai.');
}

/** Send `msg` unless it is a shared edit during simulator mode (then warn + notify and drop it). Returns whether it was sent. */
export function guardedSend(msg: ClientMessage, locked: () => boolean, send: (m: ClientMessage) => void, notify: (text: string) => void): boolean {
  if (locked() && isSharedEditMessage(msg)) {
    console.warn(`[simmode] 공유 도시로 보내는 메시지를 차단했습니다: ${msg.t}`);
    notify(SIM_LOCK_TOAST);
    return false;
  }
  send(msg);
  return true;
}
