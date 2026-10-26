// Connection state on screen (ADR 0011): the overlay while the server room has not answered, the
// banners for offline solo mode and reconnecting, the notice about an offline city saved here, and
// the error shown instead of an offline city whose save cannot be read.

import { useEffect, useState } from 'react';
import { downloadText, exportDoc } from '../app/importExport';
import { offlineSeenKey, readOfflineSave } from '../net/localTransport';
import { useServices, useStore } from './context';

/** Reload this room as the server room, or in offline solo mode. */
function openRoom(room: string, offline: boolean): void {
  const p = new URLSearchParams(location.search);
  p.set('room', room);
  if (offline) p.set('offline', '1');
  else p.delete('offline');
  location.search = p.toString();
}

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Download the offline save of `room`: the city as an importable JSON, or the raw text when it cannot be read. */
function exportOfflineSave(room: string): boolean {
  const save = readOfflineSave(localStore(), room);
  if (save.status === 'ok') downloadText(`${save.doc.meta.name || room}-offline.json`, exportDoc(save.doc));
  else if (save.status === 'unreadable') downloadText(`${room}-offline-raw.json`, save.raw);
  return save.status !== 'none';
}

/** Seconds until `at`, refreshed twice a second while `at` is set. */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export function ConnectOverlay() {
  const { retryConnect } = useServices();
  // The reload notice also covers a tab that was already in the city (refused on a reconnect).
  const wait = useStore((s) => (s.connectWait?.refresh ? s.connectWait : s.ready || s.connection === 'offline' ? null : s.connectWait));
  const room = useStore((s) => s.room);
  const secs = useSecondsUntil(wait?.retryAt ?? null);
  if (!wait) return null;
  if (wait.refresh) {
    // Another app version: retrying cannot help, and the old page must not edit this city.
    return (
      <div className="connect-overlay" data-connect-overlay data-connect-outdated role="alertdialog" aria-modal="true" aria-labelledby="connect-title">
        <div className="panel connect-card">
          <h2 id="connect-title">앱을 새로고침하세요</h2>
          <p className="connect-error" data-connect-error>
            {wait.error}
          </p>
          <p className="muted">서버가 다른 버전의 앱을 쓰고 있어 연결하지 않았습니다. 새로고침하면 새 버전으로 다시 연결합니다.</p>
          <div className="row connect-actions">
            <button className="primary" data-connect-reload onClick={() => location.reload()}>
              새로고침
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="connect-overlay" data-connect-overlay role="alertdialog" aria-modal="true" aria-labelledby="connect-title">
      <div className="panel connect-card">
        <h2 id="connect-title">서버에 연결하는 중…</h2>
        <p data-connect-attempt>
          ({wait.attempt}번째 시도{secs !== null && `, 다음 시도 ${secs}초 후`})
        </p>
        {wait.error && (
          <p className="connect-error" data-connect-error>
            {wait.error}
          </p>
        )}
        <p className="muted">
          방 '{room}'의 도시는 서버에 있습니다. 연결되면 이 화면은 자동으로 사라집니다.
        </p>
        <div className="row connect-actions">
          <button className="primary" data-connect-retry onClick={retryConnect}>
            지금 다시 시도
          </button>
          <button data-connect-offline title="서버의 도시와 별개인, 이 브라우저에만 저장되는 도시를 엽니다" onClick={() => openRoom(room, true)}>
            오프라인 단독 모드로 열기
          </button>
        </div>
      </div>
    </div>
  );
}

/** Persistent strip at the top: red in offline solo mode, yellow while an established session reconnects. */
export function ConnectionBanner() {
  const connection = useStore((s) => s.connection);
  const ready = useStore((s) => s.ready);
  const room = useStore((s) => s.room);
  const kind = connection === 'offline' ? 'offline' : ready && connection === 'reconnecting' ? 'reconnecting' : null;
  useEffect(() => {
    document.body.toggleAttribute('data-conn-banner', kind !== null);
  }, [kind]);
  if (!kind) return null;
  if (kind === 'reconnecting') {
    return (
      <div className="conn-banner reconnecting" data-conn-banner="reconnecting" role="status">
        서버 재연결 중 — 편집은 연결 후 가능
      </div>
    );
  }
  return (
    <div className="conn-banner offline" data-conn-banner="offline" role="status">
      <span>
        <b>오프라인 단독 모드</b> — 이 도시는 이 브라우저에만 저장되며 서버의 '{room}' 도시와 별개입니다
      </span>
      <button data-conn-reconnect onClick={() => openRoom(room, false)}>
        서버에 다시 연결
      </button>
    </div>
  );
}

export function OfflineCityNotice() {
  const { store } = useServices();
  const note = useStore((s) => s.offlineCity);
  const room = useStore((s) => s.room);
  if (!note) return null;
  const when = note.savedAt === null ? '수정 시각 알 수 없음' : `마지막 수정 ${new Date(note.savedAt).toLocaleString('ko-KR')}`;
  const exportCity = () => {
    if (!exportOfflineSave(room)) store.toast('오프라인 도시가 더 이상 없습니다', 'error');
  };
  const close = () => {
    try {
      sessionStorage.setItem(offlineSeenKey(room), note.seen);
    } catch {
      // Not remembered: it shows again after a reload.
    }
    store.set({ offlineCity: null });
  };
  return (
    <div className="panel offline-notice" data-offline-notice role="status">
      {note.unreadable ? (
        <p>
          이 브라우저에 '{room}' 오프라인 도시 저장본이 있지만 읽을 수 없습니다 ({note.unreadable}). 원본을 내보내 보관할 수 있습니다.
        </p>
      ) : (
        <p>
          이 브라우저에 오프라인으로 만든 '{room}' 도시가 있습니다 (건물 {note.buildings}·도로 {note.roads}, {when})
        </p>
      )}
      <p className="muted">
        서버 도시와 자동으로 합치지 않습니다. 내보낸 JSON은 상단 '가져오기'로 새 방에 넣을 수 있습니다.
      </p>
      <div className="row connect-actions">
        {!note.unreadable && (
          <button data-offline-open onClick={() => openRoom(room, true)}>
            오프라인 도시 열기
          </button>
        )}
        <button data-offline-export onClick={exportCity}>
          {note.unreadable ? '원본 내보내기' : 'JSON으로 내보내기'}
        </button>
        <button data-offline-close onClick={close}>
          닫기
        </button>
      </div>
    </div>
  );
}

/** Offline solo mode was asked for, but the city saved here cannot be read: nothing is opened or saved. */
export function OfflineSaveError() {
  const { store } = useServices();
  const reason = useStore((s) => s.offlineError);
  const room = useStore((s) => s.room);
  if (reason === null) return null;
  return (
    <div className="connect-overlay" data-offline-error role="alertdialog" aria-modal="true" aria-labelledby="offline-error-title">
      <div className="panel connect-card">
        <h2 id="offline-error-title">오프라인 도시 저장본을 읽을 수 없습니다</h2>
        <p className="connect-error">{reason}</p>
        <p className="muted">
          빈 도시로 열면 첫 편집에서 저장본이 덮어써지므로 열지 않았습니다. 이 브라우저의 저장본은 그대로 남아 있습니다. 원본을 내보내 보관하거나 관리자에게 전달하세요.
        </p>
        <div className="row connect-actions">
          <button className="primary" data-offline-export-raw onClick={() => exportOfflineSave(room) || store.toast('저장본이 더 이상 없습니다', 'error')}>
            원본 내보내기
          </button>
          <button data-offline-error-server onClick={() => openRoom(room, false)}>
            서버의 '{room}' 도시로 열기
          </button>
        </div>
      </div>
    </div>
  );
}
