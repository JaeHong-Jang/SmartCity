import { expect, test, type Page } from '@playwright/test';

// Phase 4c1: simulator mode on a private copy. Needs the collaboration server (E2E_SERVER=1) so the
// "no cmd / AI frame leaves the browser" proof runs over a real WebSocket.

interface SimHook {
  store: { getState(): { phase: string; tick: number; progress: number; events: { status: string; kind: string; active: boolean; ended: boolean }[]; compare: { on: unknown[]; off: unknown[] } | null; error: string | null } };
  workers(): number;
  drawnBuildings(): number;
  liveBuildings(): number;
  scene(): { drawn: boolean; obstacles: number; closedLanes: number; surgeRings: number };
  controller: { enter(): void; exit(): void };
}
interface CityHook {
  store: { getState(): { doc: { buildings: Record<string, { pos: { x: number; z: number } }> }; connection: string; simStatus: string; seq: number } };
  simmode: SimHook;
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

async function screen(page: Page, x: number, z: number) {
  return page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
}

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number) {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(300);
}

const simState = (page: Page) => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.simmode.store.getState());
const workers = (page: Page) => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.simmode.workers());
const sceneStats = (page: Page) => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.simmode.scene());

test('phase 4c1: simulator mode — private copy, events, ON/OFF comparison, no server traffic', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const sent: { t: string }[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload)) as { t?: string; type?: string };
        sent.push({ t: String(m.t ?? m.type) }); // the keepalive is {"type":"ping"}
      } catch {
        /* binary or partial */
      }
    });
  });

  await page.goto(`/?room=e2e-sim-${Date.now().toString(36)}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __smartcity?: CityHook }).__smartcity;
    return !!h && h.store.getState().connection === 'online' && h.store.getState().simStatus === 'ready';
  });
  await lookAt(page, -220, 380, 360, 0, 0);

  // A grid of 4-lane roads and a few buildings (built the same way as the vehicles test).
  await page.locator('[data-tool="road"]').click();
  // The 4-lane avenue (matched on its lane count).
  await page.locator('.tool-options .list button').filter({ hasText: '4차선' }).first().click();
  for (const v of [-144, -48, 48, 144]) {
    await clickWorld(page, -192, v);
    await clickWorld(page, 192, v);
    await page.keyboard.press('Escape');
  }
  for (const v of [-144, -48, 48, 144]) {
    await clickWorld(page, v, -192);
    await clickWorld(page, v, 192);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('3');
  for (const [x, z] of [[-96, -125], [0, -125], [96, -30], [-96, 70], [0, 125]] as const) await clickWorld(page, x, z);
  for (const [x, z] of [[-96, 30], [96, 125], [0, 30]] as const) await clickWorld(page, x, z);
  await clickWorld(page, 96, -100);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(8);
  // Let the server confirm the last commands before snapshotting the doc.
  await page.waitForTimeout(1500);

  const docBefore = await page.evaluate(() => JSON.stringify((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc));
  const seqBefore = await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().seq);
  const framesBefore = sent.length;

  // ---- enter: warm-up, then ready ----
  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-banner]')).toContainText('다른 사용자에게 영향 없음');
  await expect(page.locator('[data-simmode-banner]')).toContainText(`seq ${seqBefore}`);
  await expect(page.locator('[data-simmode-warmup]')).toBeVisible();
  expect(await workers(page)).toBe(1);
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
  // Shared editing is locked: the toolbar ignores clicks.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.toolbar')!).pointerEvents)).toBe('none');

  // ---- keyboard cannot edit the shared city either ----
  expect(await page.locator('.density').isDisabled()).toBe(true);
  expect(await page.locator('.city-name').isDisabled()).toBe(true);
  expect(await page.locator('[data-tool]').first().isDisabled()).toBe(true);
  const nameBefore = await page.locator('.city-name').inputValue();
  const keyFrom = sent.length;
  await page.mouse.click(10, 10);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
  }
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Delete');
  await page.locator('.city-name').click({ force: true, trial: false }).catch(() => undefined);
  await page.keyboard.type('xyz');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(await page.locator('.city-name').inputValue()).toBe(nameBefore);
  expect(sent.slice(keyFrom).filter((m) => m.t === 'cmd' || m.t.startsWith('ai.'))).toEqual([]);

  // ---- frozen view: a second client adds a building; the live city gets it, the simulator view does not ----
  const counts = () => page.evaluate(() => { const m = (window as unknown as { __smartcity: CityHook }).__smartcity.simmode; return { live: m.liveBuildings(), drawn: m.drawnBuildings() }; });
  const c0 = await counts();
  expect(c0.live).toBe(c0.drawn);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.waitForFunction(() => {
    const h = (window as unknown as { __smartcity?: CityHook }).__smartcity;
    return !!h && h.store.getState().connection === 'online';
  });
  await lookAt(other, -220, 380, 360, 0, 0);
  await other.keyboard.press('3');
  await clickWorld(other, -96, 125);
  await expect.poll(async () => (await counts()).live, { timeout: 10_000 }).toBe(c0.live + 1);
  expect((await counts()).drawn).toBe(c0.drawn);
  await other.close();

  // ---- events: closure on a main road, accident on another, a surge at a building ----
  await page.locator('[data-simmode-event="closure"]').click();
  await page.locator('[data-simmode-param="duration"]').fill('90');
  await clickWorld(page, 0, -48);
  await page.locator('[data-simmode-event="accident"]').click();
  await page.locator('[data-simmode-param="duration"]').fill('60');
  await clickWorld(page, 48, 96);
  const bpos = await page.evaluate(() => {
    const b = Object.values((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings)[0]!;
    return b.pos;
  });
  await page.locator('[data-simmode-event="surge"]').click();
  await clickWorld(page, bpos.x, bpos.z);
  await expect(page.locator('[data-simmode-eventrow]')).toHaveCount(3);
  await expect(page.locator('[data-simmode-eventrow][data-status="ok"]')).toHaveCount(3);

  // ---- run at 4× until the events act, then check the scene shows them ----
  await page.locator('.speed button', { hasText: '4×' }).click();
  await expect.poll(async () => (await simState(page)).tick, { timeout: 60_000 }).toBeGreaterThan(1700);
  await expect.poll(async () => (await sceneStats(page)).surgeRings, { timeout: 20_000 }).toBeGreaterThan(0);
  console.log('events:', JSON.stringify((await simState(page)).events));
  const scene = await sceneStats(page);
  console.log('scene:', JSON.stringify(scene));
  expect(scene.drawn).toBe(true);
  expect(scene.closedLanes).toBeGreaterThan(0);
  expect(scene.obstacles).toBeGreaterThan(0);
  expect(scene.surgeRings).toBeGreaterThan(0);
  const accident = await screen(page, 48, 96);
  await lookAt(page, -40, 150, 260, 20, 40);
  await page.screenshot({ path: 'test-results/phase4c-simmode.png' });
  expect(accident.x).toBeGreaterThan(0);

  // ---- ending an event: it leaves the sim's active events and the row says so ----
  const closureRow = page.locator('[data-simmode-eventrow="closure"]');
  await expect(closureRow).not.toContainText('종료됨');
  expect(await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.simmode.store.getState().events.find((e) => e.kind === 'closure')?.active)).toBe(true);
  await closureRow.locator('[data-simmode-end]').click();
  await expect(closureRow).toContainText('종료됨', { timeout: 30_000 });
  const ended = await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.simmode.store.getState().events.find((e) => e.kind === 'closure'));
  expect(ended?.active).toBe(false);
  expect(ended?.ended).toBe(true);
  await expect(closureRow.locator('[data-simmode-end]')).toHaveCount(0);
  await expect.poll(async () => (await sceneStats(page)).closedLanes, { timeout: 15_000 }).toBe(0);

  // ---- compare ----
  await page.locator('.speed button').first().click(); // pause the copy
  await page.locator('[data-simmode-compare]').click();
  await expect(page.locator('[data-simmode-progress]')).toBeVisible();
  expect(await workers(page)).toBe(2);
  await expect(page.locator('[data-simmode-result]')).toBeVisible({ timeout: 150_000 });
  expect(await workers(page)).toBe(1);
  await expect(page.locator('[data-simmode-result]')).toContainText('게임 모델');
  expect(await page.locator('[data-simmode-line="on"]').count()).toBe(5);
  expect(await page.locator('[data-simmode-line="off"]').count()).toBe(5);
  for (const side of ['on', 'off'] as const) {
    const pts = await page.locator(`[data-simmode-line="${side}"]`).evaluateAll((els) => els.map((e) => (e.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean).length));
    expect(Math.min(...pts)).toBeGreaterThan(5);
  }
  // Both lines of every chart sit on identical x positions (same sim ticks).
  const xs = (side: string) => page.locator(`[data-simmode-line="${side}"]`).evaluateAll((els) => els.map((e) => (e.getAttribute('points') ?? '').trim().split(/\s+/).map((p) => p.split(',')[0])));
  expect(await xs('on')).toEqual(await xs('off'));
  await expect(page.locator('[data-simmode-table]')).toContainText('미완료');
  await page.screenshot({ path: 'test-results/phase4c-compare.png' });

  // ---- nothing but presence/ping left the browser while in simulator mode ----
  const during = sent.slice(framesBefore).map((m) => m.t);
  console.log('frames during simulator mode:', JSON.stringify(during.reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {})));
  expect(during.filter((t) => t === 'cmd' || t.startsWith('ai.'))).toEqual([]);

  // ---- exit: the shared city is exactly as before ----
  await page.locator('[data-simmode-exit]').click();
  await expect(page.locator('[data-simmode-banner]')).toHaveCount(0);
  expect(await workers(page)).toBe(0);
  const docAfter = await page.evaluate(() => JSON.stringify((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc));
  expect(docAfter).not.toBe(docBefore); // the second client's building arrived meanwhile ...
  expect((await counts()).drawn).toBe(c0.live + 1); // ... and the renderer is back on the live doc
  expect(JSON.parse(docAfter).buildings).toMatchObject(JSON.parse(docBefore).buildings);
  expect(Object.keys(JSON.parse(docAfter).segments)).toEqual(Object.keys(JSON.parse(docBefore).segments));
  await expect.poll(async () => (await sceneStats(page)).drawn).toBe(false);
  expect(sent.slice(framesBefore).filter((m) => m.t === 'cmd' || m.t.startsWith('ai.'))).toEqual([]);

  // ---- repeated enter / exit leaks no worker ----
  for (let i = 0; i < 10; i++) {
    await page.locator('[data-simmode-enter]').click();
    await expect(page.locator('[data-simmode-banner]')).toBeVisible();
    expect(await workers(page)).toBe(1);
    await page.locator('[data-simmode-exit]').click();
    await expect(page.locator('[data-simmode-banner]')).toHaveCount(0);
    expect(await workers(page)).toBe(0);
  }
  expect(sent.slice(framesBefore).filter((m) => m.t === 'cmd' || m.t.startsWith('ai.'))).toEqual([]);
  expect(errors.filter((e) => !/WebSocket connection to .*\/ws.* failed/.test(e))).toEqual([]);
});
