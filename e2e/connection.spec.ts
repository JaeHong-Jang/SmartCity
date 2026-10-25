// P0 data safety (ADR 0011): a server room that cannot be reached never opens this browser's own
// city under the same name; offline solo mode is explicit, separately stored and clearly marked.
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

interface CityHook {
  store: {
    getState(): {
      doc: { segments: object; buildings: object };
      connection: string;
      ready: boolean;
    };
  };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const hook = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState();
    return { connection: s.connection, ready: s.ready, segments: Object.keys(s.doc.segments).length };
  });

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

/** Draw two crossing roads in offline solo mode and wait until they are saved; returns the road count. */
async function buildOfflineCity(page: Page, room: string): Promise<number> {
  await page.goto(`/?offline=1&room=${room}`);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await hook(page);
  await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(-150, 260, 250, 0, 0));
  await page.waitForTimeout(300);
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -120, 0);
  await clickWorld(page, 120, 0);
  await page.keyboard.press('Escape');
  await clickWorld(page, 0, -100);
  await clickWorld(page, 0, 100);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).segments, { timeout: 5000 }).toBeGreaterThanOrEqual(4);
  const roads = (await state(page)).segments;
  const saved = (r: string) =>
    page.evaluate((r) => {
      const raw = localStorage.getItem(`smartcity:offline:${r}`);
      return raw ? Object.keys(JSON.parse(raw).doc.segments).length : 0;
    }, r);
  await expect.poll(() => saved(room), { timeout: 5000 }).toBe(roads);
  return roads;
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('unreachable server: overlay and retries, never the local city; offline mode is explicit and migrates the old key', async ({ page }) => {
  const errors = pageErrors(page);
  const room = `e2e-conn-${Date.now().toString(36)}`;
  const roads = await buildOfflineCity(page, room);
  await expect(page.locator('[data-conn-banner="offline"]')).toContainText(`서버의 '${room}' 도시와 별개`);
  // What a save looked like before the key split: only the legacy key.
  const legacy = await page.evaluate((r) => {
    const raw = localStorage.getItem(`smartcity:offline:${r}`)!;
    localStorage.setItem(`smartcity:local:${r}`, raw);
    localStorage.removeItem(`smartcity:offline:${r}`);
    return raw;
  }, room);

  // Every socket is dropped: the server room is unreachable.
  await page.routeWebSocket(/\/ws$/, (ws) => ws.close());
  await page.goto(`/?room=${room}`);
  await hook(page);
  const overlay = page.locator('[data-connect-overlay]');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(overlay).toContainText('서버에 연결하는 중');
  await expect(page.locator('[data-connect-attempt]')).toContainText(/\d+번째 시도, 다음 시도 \d+초 후/, { timeout: 10_000 });
  await expect.poll(async () => Number((await page.locator('[data-connect-attempt]').textContent())?.match(/(\d+)번째/)?.[1]), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  // Retry now starts another attempt at once.
  const before = Number((await page.locator('[data-connect-attempt]').textContent())?.match(/(\d+)번째/)?.[1]);
  await page.locator('[data-connect-retry]').click();
  await expect.poll(async () => Number((await page.locator('[data-connect-attempt]').textContent())?.match(/(\d+)번째/)?.[1])).toBeGreaterThan(before);
  const s = await state(page);
  expect(s).toEqual({ connection: 'connecting', ready: false, segments: 0 });
  await expect(page.locator('.conn-banner')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/connection-overlay.png' });

  // Offline solo mode only by choice: red banner, its own key, the legacy save copied and kept.
  await page.locator('[data-connect-offline]').click();
  await expect(page).toHaveURL(/offline=1/);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await expect(page.locator('[data-conn-banner="offline"]')).toBeVisible();
  await hook(page);
  await expect.poll(async () => (await state(page)).segments).toBe(roads);
  const keys = await page.evaluate((r) => ({ offline: localStorage.getItem(`smartcity:offline:${r}`), legacy: localStorage.getItem(`smartcity:local:${r}`) }), room);
  expect(keys.legacy).toBe(legacy);
  expect(keys.offline).toBe(legacy);
  await page.screenshot({ path: 'test-results/connection-offline-banner.png' });

  // Back to the server room: the overlay again (still unreachable), not the offline city.
  await page.locator('[data-conn-reconnect]').click();
  await expect(page).not.toHaveURL(/offline=1/);
  await expect(page.locator('[data-connect-overlay]')).toBeVisible({ timeout: 10_000 });
  await hook(page);
  expect((await state(page)).segments).toBe(0);
  expect(errors).toEqual([]);
});

test('server comes up later: joins on its own, notices the offline city, reconnects without going offline', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (starts apps/server)');
  const errors = pageErrors(page);
  const room = `e2e-conn2-${Date.now().toString(36)}`;
  const roads = await buildOfflineCity(page, room);

  let allow = false;
  const live: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (!allow) return void ws.close();
    ws.connectToServer();
    live.push(ws);
  });
  await page.goto(`/?room=${room}`);
  await expect(page.locator('[data-connect-overlay]')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  allow = true; // the server is reachable from now on: the next automatic attempt joins
  await expect(page.locator('[data-connect-overlay]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.badge')).toContainText('온라인');
  await hook(page);
  expect(await state(page)).toEqual({ connection: 'online', ready: true, segments: 0 });

  // The offline city of the same name is pointed out, not merged.
  const notice = page.locator('[data-offline-notice]');
  await expect(notice).toContainText(`'${room}' 도시가 있습니다 (건물 0·도로 ${roads}`);
  await page.screenshot({ path: 'test-results/connection-offline-notice.png' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-offline-export]').click()]);
  const file = await download.path();
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).segments)).toHaveLength(roads);

  // The server goes away mid-session: reconnecting (edits blocked), never offline.
  allow = false;
  for (const ws of live.splice(0)) await ws.close();
  await expect(page.locator('[data-conn-banner="reconnecting"]')).toContainText('서버 재연결 중 — 편집은 연결 후 가능');
  for (let i = 0; i < 6; i++) {
    expect((await state(page)).connection).toBe('reconnecting');
    await page.waitForTimeout(500);
  }
  await expect(page.locator('[data-connect-overlay]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/connection-reconnecting.png' });
  allow = true;
  await expect(page.locator('.badge')).toContainText('온라인', { timeout: 15_000 });
  await expect(page.locator('.conn-banner')).toHaveCount(0);

  // The exported file goes into a fresh server room through the regular import.
  await page.locator('.hidden-file').setInputFiles(file);
  await expect(page).toHaveURL(/room=import-/, { timeout: 10_000 });
  await hook(page);
  await expect.poll(async () => (await state(page)).segments, { timeout: 15_000 }).toBe(roads);
  expect(errors).toEqual([]);
});

test('a room the server refuses (unreadable city file) says so on the overlay and is never replaced', async ({ page }) => {
  const errors = pageErrors(page);
  await page.routeWebSocket(/\/ws$/, (ws) =>
    ws.onMessage(() => {
      ws.send(JSON.stringify({ t: 'error', error: '도시 파일을 읽을 수 없습니다 — 관리자 확인 필요' }));
      void ws.close({ code: 1011 });
    }),
  );
  await page.goto(`/?room=e2e-refused-${Date.now().toString(36)}`);
  await expect(page.locator('[data-connect-error]')).toContainText('도시 파일을 읽을 수 없습니다 — 관리자 확인 필요', { timeout: 10_000 });
  await hook(page);
  await page.waitForTimeout(2000);
  expect(await state(page)).toEqual({ connection: 'connecting', ready: false, segments: 0 });
  await expect(page.locator('[data-connect-overlay]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a socket that opens but never sends welcome is dropped and retried (Sol review #4)', async ({ page }) => {
  const errors = pageErrors(page);
  let sockets = 0;
  await page.routeWebSocket(/\/ws$/, () => {
    sockets++; // accepted, then silence: no welcome, no close
  });
  await page.goto(`/?room=e2e-silent-${Date.now().toString(36)}`);
  await expect(page.locator('[data-connect-overlay]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => sockets, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-connect-attempt]')).toContainText(/[2-9]번째 시도|\d{2,}번째 시도/, { timeout: 15_000 });
  await hook(page);
  expect(await state(page)).toEqual({ connection: 'connecting', ready: false, segments: 0 });
  expect(errors).toEqual([]);
});

test('an offline save that cannot be read is not opened and stays untouched (Sol review #3)', async ({ page }) => {
  const errors = pageErrors(page);
  const room = `e2e-unread-${Date.now().toString(36)}`;
  // A save written by a newer app version (v99) with a city this version cannot read.
  const raw = JSON.stringify({ seq: 9, savedAt: 1, doc: { version: 99, meta: { name: '미래 도시' }, nodes: { kept: { id: 'kept', pos: { x: 0, z: 0 } } } } });
  await page.addInitScript(
    ([k, v]) => {
      if (localStorage.getItem(k!) === null) localStorage.setItem(k!, v!);
    },
    [`smartcity:offline:${room}`, raw],
  );
  await page.goto(`/?offline=1&room=${room}`);
  const card = page.locator('[data-offline-error]');
  await expect(card).toContainText('오프라인 도시 저장본을 읽을 수 없습니다');
  await expect(card).toContainText('v99');
  await expect(page.locator('[data-conn-banner="offline"]')).toBeVisible();
  await hook(page);
  expect(await state(page)).toEqual({ connection: 'offline', ready: false, segments: 0 });
  await page.screenshot({ path: 'test-results/connection-offline-unreadable.png' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-offline-export-raw]').click()]);
  expect(readFileSync(await download.path(), 'utf8')).toBe(raw);
  await page.waitForTimeout(1500); // longer than the offline save delay
  expect(await page.evaluate((k) => localStorage.getItem(k), `smartcity:offline:${room}`)).toBe(raw);
  expect(errors).toEqual([]);
});
