// P7d (ADR 0014 §7): "신도시 샘플" opens a fresh room and builds the generated new town there with ONE batch
// through a real server (the server validates it and it fits one WebSocket frame); the room the button was
// pressed in stays as it was; the invite password carries over; the requester's camera shows the center; a few
// seconds of traffic run without errors. Screenshots: test-results/p7d-*.png.
// This spec starts its own server with an invite password (random port, throwaway data dir, scripted AI) and
// routes the page's /ws to it, so it runs with or without E2E_SERVER:
//   E2E_WEB_PORT=5194 npx playwright test e2e/p7d-sample.spec.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';

const CODE = 'e2e-p7d-code';
let server: ChildProcess;
let port = 0;
let dataDir = '';

test.beforeAll(async () => {
  dataDir = mkdtempSync(join('test-results', 'p7d-data-'));
  server = spawn(join('node_modules', '.bin', 'tsx'), ['apps/server/src/main.ts'], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SC_INVITE_CODE: CODE, SC_AI_FAKE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise<number>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on :(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    server.once('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
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

/** Forward every page socket on /ws to this spec's server; returns the largest frame the page sent (bytes). */
async function proxy(page: Page): Promise<() => number> {
  let largest = 0;
  await page.routeWebSocket(/\/ws$/, (route) => {
    const up = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: string[] = [];
    route.onMessage((m) => {
      largest = Math.max(largest, Buffer.byteLength(String(m)));
      if (up.readyState === WebSocket.OPEN) up.send(m);
      else queue.push(String(m));
    });
    up.on('open', () => queue.splice(0).forEach((m) => up.send(m)));
    up.on('message', (d) => route.send(d.toString()));
    up.on('close', (code, reason) => void route.close(code === 1005 || code === 1006 ? {} : { code, reason: reason.toString() }));
    up.on('error', () => void route.close());
    route.onClose(() => up.close());
  });
  return () => largest;
}

type Counts = { nodes: number; segments: number; buildings: number };

/** Joins `room` as a plain client: the server's doc at welcome (counts); with `cmd`, also sends it and waits until applied. */
async function joinRoom(room: string, cmd?: unknown): Promise<Counts> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const counts = await new Promise<Counts>((resolve, reject) => {
    let atWelcome: Counts | null = null;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: 4, room, name: 'e2e', invite: CODE })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { t: string; doc?: Record<'nodes' | 'segments' | 'buildings', object>; error?: string };
      if (m.t === 'welcome') {
        const doc = m.doc!;
        atWelcome = { nodes: Object.keys(doc.nodes).length, segments: Object.keys(doc.segments).length, buildings: Object.keys(doc.buildings).length };
        if (cmd) ws.send(JSON.stringify({ t: 'cmd', ref: 1, cmd }));
        else resolve(atWelcome);
      } else if (m.t === 'applied' && atWelcome) resolve(atWelcome);
      else if (m.t === 'rejected' || m.t === 'error') reject(new Error(m.error));
    });
    ws.on('error', reject);
  });
  ws.close();
  return counts;
}

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);

test('신도시 샘플: a fresh room gets the whole new town in one batch; the old room is untouched', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /THREE\.WebGLProgram|shader/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const largestFrame = await proxy(page);

  // The room the button is pressed in already has a node (made by another client).
  const home = `e2e-p7d-${Date.now().toString(36)}`;
  await joinRoom(home, { type: 'node.add', node: { id: 'keep', pos: { x: 10, z: 10 } } });
  await page.goto(`/?room=${home}`);
  await page.locator('[data-invite-input]').fill(CODE);
  await page.locator('[data-invite-submit]').click();
  await expect(page.locator('.badge')).toContainText('온라인', { timeout: 20_000 });
  await ready(page);
  expect(await hook<number>(page, 'Object.keys(h.store.getState().doc.nodes).length')).toBe(1);

  await page.locator('[data-sample-city]').click();
  await page.waitForURL(/room=newtown-[0-9a-f]{8}/, { timeout: 20_000 });
  const room = new URL(page.url()).searchParams.get('room')!;
  // The remembered invite password joins the new room without asking.
  await expect(page.locator('.badge')).toContainText('온라인', { timeout: 20_000 });
  await expect(page.locator('[data-connect-overlay]')).toHaveCount(0);
  await ready(page);

  const expected = await page.evaluate(async () => {
    const mod = (await import(/* @vite-ignore */ '/@id/@smartcity/shared')) as typeof import('@smartcity/shared');
    const cmds = mod.sampleCityPlan().batch.commands;
    const n = (t: string) => cmds.filter((c) => c.type === t).length;
    return { buildings: n('building.place'), segments: n('segment.add'), nodes: n('node.add'), parcels: n('parcel.upsert'), commands: cmds.length };
  });
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 60_000 }).toBe(expected.buildings);
  const got = await hook<{ segments: number; parcels: number; lines: number; growth: boolean | undefined; seq: number }>(
    page,
    '(() => { const s = h.store.getState(); return { segments: Object.keys(s.doc.segments).length, parcels: Object.keys(s.doc.parcels).length, lines: Object.keys(s.doc.busLines).length, growth: s.doc.meta.growth, seq: s.seq }; })()',
  );
  expect(got).toEqual({ segments: expected.segments, parcels: expected.parcels, lines: 2, growth: false, seq: 1 });
  await expect(page.locator('.toast.success')).toContainText('현대 신도시 샘플 완료');
  // One frame carried the whole city.
  expect(largestFrame()).toBeGreaterThan(50_000);
  expect(largestFrame()).toBeLessThanOrEqual(512 * 1024);
  // The server has it too, and the first room is as it was.
  expect(await joinRoom(room)).toEqual({ nodes: expected.nodes, segments: expected.segments, buildings: expected.buildings });
  expect(await joinRoom(home)).toEqual({ nodes: 1, segments: 0, buildings: 0 });

  // The requester's camera went to the center (the densest district: downtown).
  await page.waitForTimeout(2500);
  const target = await hook<{ x: number; z: number }>(page, 'h.cameraTarget()');
  expect(Math.hypot(target.x, target.z)).toBeLessThan(300);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/p7d-city.png' });

  // Traffic: a few seconds at 4×, vehicles and both bus lines running, no errors.
  await expect.poll(() => hook<string>(page, 'h.store.getState().simStatus'), { timeout: 60_000 }).toBe('ready');
  await hook(page, 'h.store.set({ simSpeed: 4 })');
  await page.waitForTimeout(8000);
  const sim = await hook<{ vehicles: number; time: number }>(page, '({ vehicles: h.store.getState().simStats?.vehicles ?? 0, time: h.store.getState().simStats?.time ?? 0 })');
  expect(sim.time).toBeGreaterThan(5);
  expect(sim.vehicles).toBeGreaterThan(12);
  await page.screenshot({ path: 'test-results/p7d-city-traffic.png' });

  // Eye level on a street near the center, the whole town (city view pressed again), and the night.
  await page.locator('[data-view="eye"]').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7d-eye.png' });
  await hook(page, 'h.renderer.viewCity()');
  await page.waitForTimeout(2500);
  await hook(page, 'h.renderer.viewCity()');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7d-overview.png' });
  await hook(page, 'h.renderer.viewCity()');
  await hook(page, 'h.perf.setDayTime(21.5 * 3600)');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/p7d-night.png' });

  expect(errors).toEqual([]);
});
