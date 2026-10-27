// Invite password (SC_INVITE_CODE): this spec starts its own isolated server with a code (random port,
// throwaway data dir, scripted AI) and routes the page's /ws to it, so it runs with or without E2E_SERVER.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';

const CODE = 'e2e-invite-code';
let server: ChildProcess;
let port = 0;
let dataDir = '';

test.beforeAll(async () => {
  dataDir = mkdtempSync(join('test-results', 'invite-data-'));
  server = spawn(join('node_modules', '.bin', 'tsx'), ['apps/server/src/main.ts'], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SC_INVITE_CODE: CODE, SC_AI_FAKE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise<number>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on :(\d+).*invite password required/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    server.once('exit', (code) => reject(new Error(`invite server exited (${code}): ${out}`)));
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Forward every page socket on /ws to the invite server; returns the number of sockets opened so far. */
async function proxyToInviteServer(page: Page): Promise<() => number> {
  let sockets = 0;
  await page.routeWebSocket(/\/ws$/, (route) => {
    sockets++;
    const up = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: string[] = [];
    route.onMessage((m) => (up.readyState === WebSocket.OPEN ? up.send(m) : queue.push(String(m))));
    up.on('open', () => queue.splice(0).forEach((m) => up.send(m)));
    up.on('message', (d) => route.send(d.toString()));
    up.on('close', (code, reason) => void route.close(code === 1005 || code === 1006 ? {} : { code, reason: reason.toString() }));
    up.on('error', () => void route.close());
    route.onClose(() => up.close());
  });
  return () => sockets;
}

function watchLeaks(page: Page): { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('framenavigated', (f) => logs.push(f.url()));
  return { errors, logs };
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __smartcity: { store: { getState(): { connection: string; ready: boolean } } } }).__smartcity.store.getState();
    return { connection: s.connection, ready: s.ready };
  });

test('invite password: asked on the overlay, wrong one refused, right one joins and is remembered', async ({ page }) => {
  const seen = watchLeaks(page);
  const sockets = await proxyToInviteServer(page);
  const room = `e2e-invite-${Date.now().toString(36)}`;
  await page.goto(`/?room=${room}`);

  // No password yet: the overlay asks for it, and nothing retries on its own.
  const card = page.locator('[data-connect-invite]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('[data-connect-error]')).toHaveText('초대 비밀번호가 필요합니다');
  await expect(page.locator('[data-invite-submit]')).toBeDisabled();
  await page.screenshot({ path: 'test-results/invite-overlay.png' });
  await page.waitForTimeout(3000);
  expect(sockets()).toBe(1);
  expect(await state(page)).toEqual({ connection: 'connecting', ready: false });

  // A wrong password (Enter) is refused and still not retried.
  await page.locator('[data-invite-input]').fill('not-the-code');
  await page.locator('[data-invite-input]').press('Enter');
  await expect(card.locator('[data-connect-error]')).toHaveText('초대 비밀번호가 틀렸습니다', { timeout: 10_000 });
  await page.screenshot({ path: 'test-results/invite-wrong.png' });
  await page.waitForTimeout(2000);
  expect(sockets()).toBe(2);
  await expect(page.locator('.toast.error')).toHaveCount(0);

  // The right one (button) joins.
  await page.locator('[data-invite-input]').fill(CODE);
  await page.locator('[data-invite-submit]').click();
  await expect(page.locator('[data-connect-overlay]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.badge')).toContainText('온라인');
  expect(await state(page)).toEqual({ connection: 'online', ready: true });
  expect(await page.evaluate(() => localStorage.getItem('smartcity:invite'))).toBe(CODE);

  // Next visit: the remembered password joins without asking.
  await page.reload();
  await expect(page.locator('.badge')).toContainText('온라인', { timeout: 15_000 });
  await expect(page.locator('[data-connect-overlay]')).toHaveCount(0);
  expect(sockets()).toBe(4);

  // The password never shows up in the URL or the console.
  expect(page.url()).not.toContain(CODE);
  expect(seen.logs.filter((l) => l.includes(CODE))).toEqual([]);
  expect(seen.errors).toEqual([]);
});
