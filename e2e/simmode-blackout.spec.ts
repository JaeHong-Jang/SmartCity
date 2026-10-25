import { expect, test, type Page } from '@playwright/test';

// Phase 4c2-②: a substation blackout in simulator mode. Smart response OFF: signals go dark, the stopped-at-dark
// queue grows, ending the blackout restores them. Smart response ON with a short blackout: batteries hold.
// Needs the collaboration server (E2E_SERVER=1).

interface Row {
  kind: string;
  status: string;
  active: boolean;
  ended: boolean;
}
interface SimHook {
  store: { getState(): { phase: string; tick: number; events: Row[]; power: { dark: number; battery: number; buildings: number; queue: number } } };
  workers(): number;
}
interface CityHook {
  store: { getState(): { doc: { buildings: Record<string, { id: string; typeId: string; pos: { x: number; z: number } }> }; connection: string; simStatus: string } };
  simmode: SimHook;
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}
interface RenderHook {
  stats(): { drawn: boolean; discs: number; unpoweredBuildings: number; batteryLabels: number; coverageRings: number };
  darkHeads(): number;
}
type W = { __smartcity: CityHook; __smartcityBlackout: RenderHook; __seen?: { dark: number; battery: number; labels: number } };

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
const power = (page: Page) => page.evaluate(() => (window as unknown as W).__smartcity.simmode.store.getState().power);
const rows = (page: Page) => page.evaluate(() => (window as unknown as W).__smartcity.simmode.store.getState().events);
const render = (page: Page) => page.evaluate(() => ({ ...(window as unknown as W).__smartcityBlackout.stats(), dark: (window as unknown as W).__smartcityBlackout.darkHeads() }));

async function buildCity(page: Page) {
  await page.goto(`/?room=e2e-bo-${Date.now().toString(36)}`);
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
    await page.locator(`[data-building-type="${type}"]`).dispatchEvent('click');
    for (const [x, z] of pts) await clickWorld(page, x, z);
  };
  await place('svc-substation', [[-72, -48]]);
  await place('house', [[-72, 48], [-24, 48], [72, 48], [72, -48], [-72, 144], [72, 144]]);
  await place('apartment', [[-24, -144]]);
  await place('shop', [[24, -144], [-24, 144]]);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as W).__smartcity.store.getState().doc.buildings).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
  await page.waitForTimeout(1500);
}

async function enterSim(page: Page) {
  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
}

async function startSubstationBlackout(page: Page, minutes: number, sub: { x: number; z: number }) {
  await page.locator('[data-simmode-event="blackout"]').click();
  await expect(page.locator('[data-simmode-blackout-mode="substation"]')).toHaveClass(/active/);
  await expect(page.locator('[data-simmode-facility-hint]')).toHaveCount(0); // a substation exists
  await page.locator('[data-simmode-param="duration"]').fill(String(minutes));
  await expect.poll(async () => (await render(page)).coverageRings).toBeGreaterThan(0); // coverage circles while armed
  await clickWorld(page, sub.x, sub.z);
  await expect(page.locator('[data-simmode-eventrow="blackout"]')).toContainText('담당 구역 정전');
}

test('phase 4c2: substation blackout — dark signals without smart response, battery holds with it', async ({ page }) => {
  test.setTimeout(480_000);
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
  await buildCity(page);
  const subs = await page.evaluate(() => Object.values((window as unknown as W).__smartcity.store.getState().doc.buildings).filter((b) => b.typeId === 'svc-substation'));
  expect(subs).toHaveLength(1);
  const sub = subs[0]!.pos;
  const framesBefore = sent.length;

  // ---------- 스마트 대응 OFF ----------
  await enterSim(page);
  await expect(page.locator('[data-simmode-facilities]')).toContainText('변전소 1');
  await expect(page.locator('[data-simmode-supply-note]')).toContainText('커버리지 기반 공급 모델');
  await expect(page.locator('.sim-panel')).toContainText('신호 배터리');
  await page.locator('[data-simmode-policy]').uncheck();
  await startSubstationBlackout(page, 30, sub);
  await page.locator('.speed button', { hasText: '4×' }).click();

  await expect.poll(async () => (await power(page)).dark, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await render(page)).dark, { timeout: 10_000 }).toBeGreaterThan(0); // dark heads are drawn unlit
  const drawn = await render(page);
  console.log('OFF render:', JSON.stringify(drawn), 'power:', JSON.stringify(await power(page)));
  expect(drawn.discs).toBeGreaterThan(0);
  expect(drawn.unpoweredBuildings).toBeGreaterThan(0);
  await expect(page.locator('[data-simmode-eventrow="blackout"]')).toContainText('정전 중');
  await expect(page.locator('[data-simmode-power]')).toContainText('정전 신호');
  await expect.poll(async () => (await power(page)).queue, { timeout: 120_000 }).toBeGreaterThan(0); // vehicles stopped at dark junctions
  await lookAt(page, sub.x - 100, 130, sub.z + 150, 0, 0);
  await page.screenshot({ path: 'test-results/phase4c2-blackout.png' });

  // compare ON vs OFF while it is still dark
  await page.locator('.speed button').first().click();
  await page.locator('[data-simmode-compare]').click();
  await expect(page.locator('[data-simmode-result]')).toBeVisible({ timeout: 240_000 });
  expect(await page.locator('[data-simmode-line="on"]').count()).toBe(7);
  expect(await page.locator('[data-simmode-line="off"]').count()).toBe(7);
  await expect(page.locator('[data-metric="darkQueue"]')).toContainText('정전 교차로 대기');
  await expect(page.locator('[data-simmode-table]')).toContainText('정전/배터리 교차로·분');
  console.log('table:', (await page.locator('[data-simmode-table]').innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: 'test-results/phase4c2-blackout-compare.png' });

  // end the blackout: signals come back
  await page.locator('.speed button', { hasText: '4×' }).click();
  await page.locator('[data-simmode-eventrow="blackout"] [data-simmode-end]').click();
  await expect(page.locator('[data-simmode-eventrow="blackout"]')).toContainText('복구됨', { timeout: 60_000 });
  await expect.poll(async () => (await power(page)).dark, { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => (await render(page)).dark, { timeout: 10_000 }).toBe(0);
  expect((await render(page)).discs).toBe(0);
  await page.locator('[data-simmode-exit]').click();
  expect(await page.evaluate(() => (window as unknown as W).__smartcity.simmode.workers())).toBe(0);

  // ---------- 스마트 대응 ON, short blackout: the battery holds every signal ----------
  await enterSim(page);
  await expect(page.locator('[data-simmode-policy]')).toBeChecked();
  await startSubstationBlackout(page, 8, sub); // well under the 15 game minutes a battery lasts
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__seen = { dark: 0, battery: 0, labels: 0 };
    setInterval(() => {
      const st = w.__smartcity.simmode.store.getState().power;
      const s = w.__seen!;
      s.dark = Math.max(s.dark, st.dark, w.__smartcityBlackout.darkHeads());
      s.battery = Math.max(s.battery, st.battery);
      s.labels = Math.max(s.labels, w.__smartcityBlackout.stats().batteryLabels);
    }, 60);
  });
  await lookAt(page, -120, 220, 200, 0, 0); // close enough for the battery labels
  await page.locator('.speed button', { hasText: '4×' }).click();
  await expect.poll(async () => (await power(page)).battery, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect(page.locator('[data-simmode-eventrow="blackout"]')).toContainText('복구됨', { timeout: 120_000 });
  const seen = await page.evaluate(() => (window as unknown as W).__seen!);
  console.log('ON seen:', JSON.stringify(seen));
  expect(seen.battery).toBeGreaterThan(0);
  expect(seen.dark).toBe(0); // no signal ever went dark
  expect(seen.labels).toBeGreaterThan(0);

  expect(sent.slice(framesBefore).filter((t) => t === 'cmd' || t.startsWith('ai.'))).toEqual([]);
  expect(errors.filter((e) => !/WebSocket connection to .*\/ws.* failed/.test(e))).toEqual([]);
});
