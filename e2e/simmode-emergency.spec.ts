import { expect, test, type Page } from '@playwright/test';

// Phase 4c2-①: fire and medical calls in simulator mode: facilities, dispatch, rendering, signal priority,
// ON/OFF response-time comparison. Needs the collaboration server (E2E_SERVER=1).

interface Row {
  kind: string;
  status: string;
  buildingId?: string;
  response?: string;
  dispatchNote?: string;
  result?: string;
  active: boolean;
}
interface SimHook {
  store: { getState(): { phase: string; tick: number; events: Row[]; facilities: { fireStation: number; hospital: number } } };
  workers(): number;
  emergency(): { drawn: boolean; fires: number; medical: number; damaged: number; fireTrucks: number; ambulances: number; preempted: number };
}
interface CityHook {
  store: { getState(): { doc: { buildings: Record<string, { id: string; typeId: string; pos: { x: number; z: number } }> }; connection: string; simStatus: string } };
  simmode: SimHook;
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}
type W = { __smartcity: CityHook; __seen?: { trucks: number; ambulances: number; preempted: number; fires: number; medical: number } };

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as W).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}
const lookAt = async (page: Page, px: number, py: number, pz: number, tx: number, tz: number) => {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as W).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(300);
};
const sim = <T>(page: Page, fn: (s: SimHook) => T) => page.evaluate((src) => new Function('s', `return (${src})(s)`)((window as unknown as W).__smartcity.simmode), fn.toString()) as Promise<T>;

async function buildCity(page: Page, withFacilities: boolean) {
  await page.goto(`/?room=e2e-em-${Date.now().toString(36)}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __smartcity?: CityHook }).__smartcity;
    return !!h && h.store.getState().connection === 'online' && h.store.getState().simStatus === 'ready';
  });
  await lookAt(page, -220, 380, 360, 0, 0);
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-road-type="road-2"]').click();
  for (const v of [-96, 0, 96]) {
    await clickWorld(page, -192, v);
    await clickWorld(page, 192, v);
    await page.keyboard.press('Escape');
    await clickWorld(page, v, -192);
    await clickWorld(page, v, 192);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('3');
  const place = async (type: string, pts: [number, number][]) => {
    await page.locator(`[data-building-type="${type}"]`).dispatchEvent('click'); // the list can be taller than the viewport
    for (const [x, z] of pts) await clickWorld(page, x, z);
  };
  if (withFacilities) {
    await place('svc-fire-station', [[-72, -48]]);
    await place('svc-hospital', [[72, -48]]);
  }
  await place('house', [[-72, 48], [-24, 48], [72, 48], [-72, 144], [72, 144]]);
  await place('apartment', [[-24, -144]]);
  await place('shop', [[24, -144], [-24, 144]]);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as W).__smartcity.store.getState().doc.buildings).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(withFacilities ? 10 : 8);
  await page.waitForTimeout(1500);
}

const buildingsOf = (page: Page, type: string) =>
  page.evaluate((t) => Object.values((window as unknown as W).__smartcity.store.getState().doc.buildings).filter((b) => b.typeId === t).sort((a, b) => (a.id < b.id ? -1 : 1)), type);

test('phase 4c2: no facility → hint, fire still created and shown as undispatchable', async ({ page }) => {
  test.setTimeout(240_000);
  await buildCity(page, false);
  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-simmode-facilities]')).toContainText('소방서 0 · 병원 0');
  await page.locator('[data-simmode-event="fire"]').click();
  await expect(page.locator('[data-simmode-facility-hint]')).toContainText('소방서가 없어 출동할 수 없습니다');
  const house = (await buildingsOf(page, 'house'))[0]!;
  await clickWorld(page, house.pos.x, house.pos.z);
  await page.locator('[data-simmode-event="medical"]').click();
  await expect(page.locator('[data-simmode-facility-hint]')).toContainText('병원이 없어');
  await expect(page.locator('[data-simmode-eventrow="fire"]')).toHaveCount(1); // still created
  await page.locator('.speed button', { hasText: '4×' }).click();
  await expect(page.locator('[data-simmode-eventrow="fire"]')).toContainText('출동 불가', { timeout: 60_000 });
});

test('phase 4c2: fire and medical call with a station and a hospital, preemption, ON/OFF response times', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const sent: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload)) as { t?: string; type?: string };
        sent.push(String(m.t ?? m.type));
      } catch {
        /* partial */
      }
    }),
  );
  await buildCity(page, true);
  expect((await buildingsOf(page, 'svc-fire-station')).length).toBe(1);
  expect((await buildingsOf(page, 'svc-hospital')).length).toBe(1);
  const framesBefore = sent.length;

  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-simmode-facilities]')).toContainText('소방서 1 · 병원 1');
  await expect(page.locator('[data-simmode-policy]')).toBeChecked(); // 스마트 대응 ON
  await expect(page.locator('.sim-panel')).toContainText('긴급차량 신호 우선');

  const houses = await buildingsOf(page, 'house');
  await page.locator('[data-simmode-event="fire"]').click();
  await expect(page.locator('[data-simmode-facility-hint]')).toHaveCount(0); // a station exists
  await clickWorld(page, houses[3]!.pos.x, houses[3]!.pos.z);
  await page.locator('[data-simmode-event="medical"]').click();
  await expect(page.locator('[data-simmode-facility-hint]')).toHaveCount(0);
  await clickWorld(page, houses[2]!.pos.x, houses[2]!.pos.z);
  await expect(page.locator('[data-simmode-eventrow="fire"]')).toContainText('화재');
  await expect(page.locator('[data-simmode-eventrow="medical"]')).toContainText('응급 환자');

  // Watch what is drawn while it plays (the vehicles are on the road only for a short while).
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__seen = { trucks: 0, ambulances: 0, preempted: 0, fires: 0, medical: 0 };
    setInterval(() => {
      const e = w.__smartcity.simmode.emergency();
      const s = w.__seen!;
      s.trucks = Math.max(s.trucks, e.fireTrucks);
      s.ambulances = Math.max(s.ambulances, e.ambulances);
      s.preempted = Math.max(s.preempted, e.preempted);
      s.fires = Math.max(s.fires, e.fires);
      s.medical = Math.max(s.medical, e.medical);
    }, 80);
  });
  await page.locator('.speed button', { hasText: '4×' }).click();

  // Fire truck on its way: screenshot with the burning building and the truck in view.
  await expect.poll(() => sim(page, (s) => s.emergency().fireTrucks), { timeout: 90_000 }).toBeGreaterThan(0);
  await lookAt(page, houses[3]!.pos.x - 80, 90, houses[3]!.pos.z + 120, houses[3]!.pos.x, houses[3]!.pos.z);
  await page.screenshot({ path: 'test-results/phase4c2-fire.png' });

  // Both calls get answered: a row shows its response time.
  await expect
    .poll(async () => (await sim(page, (s) => s.store.getState().events)).filter((e) => e.response).length, { timeout: 120_000 })
    .toBe(2);
  const rows = await sim(page, (s) => s.store.getState().events);
  console.log('rows:', JSON.stringify(rows.map((r) => ({ k: r.kind, resp: r.response, note: r.dispatchNote, res: r.result }))));
  for (const r of rows) expect(r.response).toMatch(/\d/);
  await expect(page.locator('[data-simmode-eventrow="fire"]')).toContainText('대응');
  const seen = await page.evaluate(() => (window as unknown as W).__seen!);
  console.log('seen:', JSON.stringify(seen));
  expect(seen.trucks).toBeGreaterThan(0);
  expect(seen.ambulances).toBeGreaterThan(0);
  expect(seen.fires).toBeGreaterThan(0);
  expect(seen.medical).toBeGreaterThan(0);
  expect(seen.preempted).toBeGreaterThan(0); // signal priority with smart response ON

  // Let the calls play out a little, then compare ON/OFF.
  await expect.poll(async () => (await sim(page, (s) => s.store.getState().tick)), { timeout: 90_000 }).toBeGreaterThan(2400);
  await page.locator('.speed button').first().click();
  await page.locator('[data-simmode-compare]').click();
  await expect(page.locator('[data-simmode-result]')).toBeVisible({ timeout: 240_000 });
  expect(await page.locator('[data-simmode-line="on"]').count()).toBe(6);
  expect(await page.locator('[data-simmode-line="off"]').count()).toBe(6);
  const resp = page.locator('[data-metric="avgResponseTime"]');
  await expect(resp).toBeVisible();
  for (const side of ['on', 'off']) {
    const n = await resp.locator(`[data-simmode-line="${side}"]`).evaluate((e) => (e.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean).length);
    expect(n).toBeGreaterThan(3);
  }
  await expect(page.locator('[data-simmode-table]')).toContainText('대응 시간');
  await expect(page.locator('[data-simmode-table]')).toContainText('출동 불가');
  const table = await page.locator('[data-simmode-table]').innerText();
  console.log('table:', table.replace(/\s+/g, ' '));
  await page.screenshot({ path: 'test-results/phase4c2-compare.png' });

  // Nothing but presence/ping left the browser; exit cleans up.
  expect(sent.slice(framesBefore).filter((t) => t === 'cmd' || t.startsWith('ai.'))).toEqual([]);
  await page.locator('[data-simmode-exit]').click();
  expect(await sim(page, (s) => s.workers())).toBe(0);
  await expect.poll(() => sim(page, (s) => s.emergency().drawn)).toBe(false);
  expect(errors.filter((e) => !/WebSocket connection to .*\/ws.* failed/.test(e))).toEqual([]);
});
