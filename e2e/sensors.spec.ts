import { expect, test, type Page } from '@playwright/test';

// Phase 6b-2 (ADR 0013 §5): roadside sensors — place with the sector + covered-lane preview, rotate, edit
// in the inspector, see it on a collaborator's screen, use it in the simulator (reports vs sensors + reports),
// and lose it with its road. Needs the collaboration server (E2E_SERVER=1).

interface SensorStats {
  drawn: { cctv: number; radar: number; smartpole: number };
  total: number;
  sectors: number;
  coveredLanes: number;
}
interface Sensor {
  id: string;
  kind: string;
  heading: number;
  fov: number;
  range: number;
  segmentId: string;
}
interface CityHook {
  store: {
    getState(): {
      doc: { sensors: Record<string, Sensor>; buildings: Record<string, unknown> };
      connection: string;
      simStatus: string;
      clientId: string;
      tool: string;
      selection: { kind: string; id: string } | null;
      presence: Record<string, { tool: string; ghost: unknown[] }>;
    };
  };
  sensors(): SensorStats;
  sensorProbe(id: string): { pos: { x: number; z: number }; yaw: number; covered: { x: number; z: number }[] } | null;
  simmode: {
    store: { getState(): { phase: string; tick: number; events: { kind: string; status: string; detected?: string }[]; compare: unknown } };
    detection(): { pulses: number; undetected: number; labels: string[] };
  };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const hook = <T>(page: Page, fn: (h: CityHook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__smartcity)`) as Promise<T>;

async function screen(page: Page, x: number, z: number) {
  return page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
}

async function moveWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(120);
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

async function online(page: Page) {
  await page.waitForFunction(() => {
    const h = (window as unknown as { __smartcity?: CityHook }).__smartcity;
    return !!h && h.store.getState().connection === 'online' && h.store.getState().simStatus === 'ready';
  });
}

const sensorList = (page: Page) => hook(page, (h) => Object.values(h.store.getState().doc.sensors));
const stats = (page: Page) => hook(page, (h) => h.sensors());
/** Road z = −48 runs along x; a 4-lane road's sidewalk middle is 8.25 m from its centerline. */
const ROAD_Z = -48;
const WALK = 8.25;

test('phase 6b-2: sensors — preview, place, rotate, edit, collaborate, simulate, removed with the road', async ({ page, browser }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const room = `e2e-sensors-${Date.now().toString(36)}`;
  await page.goto(`/?room=${room}`);
  await online(page);
  await lookAt(page, -220, 380, 360, 0, 0);

  // A grid of 4-lane roads and a few buildings (as the simulator test).
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-road-type="road-4"]').click();
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
  for (const [x, z] of [[-96, -125], [0, -125], [96, -30], [-96, 70], [0, 125], [-96, 30], [96, 125], [0, 30], [96, -100]] as const) await clickWorld(page, x, z);
  await expect.poll(() => hook(page, (h) => Object.keys(h.store.getState().doc.buildings).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(8);

  // ---- sensor tool (key 0): kinds with the model-value note ----
  await page.keyboard.press('0');
  expect(await hook(page, (h) => h.store.getState().tool)).toBe('sensor');
  const opts = page.locator('section[aria-label="센서 도구 옵션"]');
  await expect(opts).toBeVisible();
  await expect(opts.locator('[data-sensor-kind]')).toHaveCount(3);
  await expect(opts).toContainText('보정 전 모의 값');
  await expect(opts).toContainText('건물 가림 미반영');
  await expect(opts.locator('[data-sensor-kind="cctv"]')).toHaveClass(/active/);

  // ---- preview: sector + covered lanes before placing ----
  await lookAt(page, -60, 140, 40, 0, ROAD_Z);
  await moveWorld(page, 0, ROAD_Z + WALK);
  const label = page.locator('[data-draw-label]');
  await expect(label).toContainText(/차선 구간 [1-9]\d*개/);
  await expect(label).toContainText('건물 가림 미반영');
  const bearing = async () => Number((await label.textContent())!.match(/방위 (\d+)°/)![1]);
  const b0 = await bearing();
  // Existing sensors' sectors show while the tool is active (none yet).
  expect((await stats(page)).sectors).toBe(0);
  await page.screenshot({ path: 'test-results/p6b2-preview.png' });

  // ---- wheel rotates the view while a spot is offered ----
  await page.mouse.wheel(0, 100);
  await expect.poll(bearing).toBe((b0 + 15) % 360);
  await page.mouse.wheel(0, -100);
  await expect.poll(bearing).toBe(b0);

  // ---- click: one sensor.place ----
  const at = await screen(page, 0, ROAD_Z + WALK);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await sensorList(page)).length, { timeout: 10_000 }).toBe(1);
  const placed = (await sensorList(page))[0]!;
  expect(placed.kind).toBe('cctv');
  await expect.poll(async () => (await stats(page)).drawn.cctv).toBe(1);
  await expect.poll(async () => (await stats(page)).sectors).toBe(1); // tool active: every sensor's sector
  expect((await stats(page)).coveredLanes).toBeGreaterThan(0);

  // ---- the select tool: sector only for the selected sensor; inspector edits ----
  await page.keyboard.press('1');
  await page.mouse.move(at.x + 200, at.y + 120);
  await expect.poll(async () => (await stats(page)).sectors).toBe(0); // nothing by default
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => hook(page, (h) => h.store.getState().selection)).toEqual({ kind: 'sensor', id: placed.id });
  await expect.poll(async () => (await stats(page)).sectors).toBe(1);
  const insp = page.locator('.panel', { has: page.locator('[data-sensor-remove]') });
  await expect(insp).toContainText('보정 전 모의 값');
  const h0 = placed.heading;
  await page.locator('[data-sensor-turn="15"]').click();
  await expect.poll(async () => (await sensorList(page))[0]!.heading).toBeCloseTo(h0 + Math.PI / 12, 6);
  await page.locator('[data-sensor-field="fov"]').fill('120');
  await page.locator('[data-sensor-field="fov"]').press('Enter');
  await expect.poll(async () => (await sensorList(page))[0]!.fov).toBeCloseTo((120 * Math.PI) / 180, 6);
  await page.locator('[data-sensor-field="range"]').fill('150');
  await page.locator('[data-sensor-field="range"]').press('Enter');
  await expect.poll(async () => (await sensorList(page))[0]!.range).toBe(150);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/p6b2-placed.png' });

  // ---- a collaborator sees the sensor, its edits and the sensor tool's ghost ----
  const other = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await other.goto(`/?room=${room}`);
  await online(other);
  await lookAt(other, -60, 140, 40, 0, ROAD_Z);
  await expect.poll(async () => (await sensorList(other)).map((s) => [s.id, s.fov, s.range])).toEqual([[placed.id, (await sensorList(page))[0]!.fov, 150]]);
  await expect.poll(async () => (await stats(other)).drawn.cctv).toBe(1);
  expect((await stats(other)).sectors).toBe(0); // not selected there, layer off
  await other.locator('[data-overlay-sensors]').check();
  await expect.poll(async () => (await stats(other)).sectors).toBe(1);
  const meId = await hook(page, (h) => h.store.getState().clientId);
  // (The range field still has focus, so the toolbar button rather than the 0 key.)
  await page.locator('[data-tool="sensor"]').click();
  await moveWorld(page, 60, ROAD_Z - WALK);
  await expect.poll(() => other.evaluate((id) => {
    const p = (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().presence[id];
    return p ? { tool: p.tool, ghost: p.ghost.length } : null;
  }, meId), { timeout: 5000 }).toMatchObject({ tool: 'sensor' });
  expect((await other.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().presence[id]!.ghost.length, meId))).toBeGreaterThan(3);
  await other.waitForTimeout(400);
  await other.screenshot({ path: 'test-results/p6b2-peer.png' });
  await page.keyboard.press('1');

  // ---- simulator: sensors + reports on screen, an accident the CCTV covers, then preset ② ----
  const probe = (await hook(page, (h) => h.sensorProbe(Object.keys(h.store.getState().doc.sensors)[0]!)))!;
  expect(probe.covered.length).toBeGreaterThan(0);
  const target = probe.covered.reduce((a, b) => (Math.hypot(b.x - probe.pos.x - 40 * Math.cos(probe.yaw), b.z - probe.pos.z - 40 * Math.sin(probe.yaw)) < Math.hypot(a.x - probe.pos.x - 40 * Math.cos(probe.yaw), a.z - probe.pos.z - 40 * Math.sin(probe.yaw)) ? b : a));
  await page.waitForTimeout(1000);
  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-simmode-sensor-count]')).toContainText('사본 센서 1개');
  // A copy with sensors starts in "센서+신고".
  await expect(page.locator('[data-simmode-detection="sensors"]')).toHaveClass(/active/);
  await page.locator('[data-simmode-event="accident"]').click();
  await page.locator('[data-simmode-param="duration"]').fill('40');
  await lookAt(page, target.x - 70, 130, target.z + 90, target.x, target.z);
  await clickWorld(page, target.x, target.z);
  await expect(page.locator('[data-simmode-eventrow="accident"][data-status="ok"]')).toHaveCount(1);
  await page.locator('.speed button', { hasText: '4×' }).click();
  // The city learns of it: a pulse with "CCTV 감지" (or "신고 접수" if the camera missed it) at the accident.
  await expect.poll(() => hook(page, (h) => h.simmode.detection().labels), { timeout: 60_000, intervals: [100] }).toEqual(expect.arrayContaining([expect.stringMatching(/CCTV 감지|신고 접수/)]));
  const detected = await hook(page, (h) => h.simmode.detection());
  console.log('detection marks:', JSON.stringify(detected));
  await expect(page.locator('[data-detect-label]').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/p6b2-detect.png' });
  await expect(page.locator('[data-simmode-detected]')).toContainText(/CCTV 감지|신고 접수/);
  await expect(page.locator('[data-simmode-detection-kpi]')).toContainText('인지 1/1건');

  await expect.poll(() => hook(page, (h) => h.simmode.store.getState().tick), { timeout: 60_000 }).toBeGreaterThan(1900);
  await page.locator('.speed button').first().click(); // pause
  await page.locator('[data-simmode-preset="detection"]').click();
  await expect(page.locator('[data-simmode-compare]')).toContainText('신고만 / 센서+신고');
  await page.locator('[data-simmode-compare]').click();
  await expect(page.locator('[data-simmode-result][data-preset="detection"]')).toBeVisible({ timeout: 150_000 });
  const rows = await page.locator('[data-simmode-detection-row]').evaluateAll((els) => els.map((e) => ({ side: e.getAttribute('data-simmode-detection-row'), delay: Number(e.getAttribute('data-avg-delay')), detected: Number(e.getAttribute('data-detected')), tracked: Number(e.getAttribute('data-tracked')) })));
  console.log('detection compare:', JSON.stringify(rows));
  const sensorsSide = rows.find((r) => r.side === 'on')!;
  const reportsSide = rows.find((r) => r.side === 'off')!;
  expect(sensorsSide.tracked).toBe(1);
  expect(reportsSide.tracked).toBe(1);
  expect(sensorsSide.detected).toBe(1);
  expect(reportsSide.detected).toBe(1);
  expect(sensorsSide.delay).toBeLessThanOrEqual(reportsSide.delay);
  await expect(page.locator('[data-simmode-result]')).toContainText('센서+신고');
  // The reports-only side's 0 % coverage is explained, not left to mislead.
  await expect(page.locator('[data-simmode-detection-row="off"] [data-simmode-cover]')).toHaveAttribute('title', '신고만 모드에서는 센서를 쓰지 않아 0%');
  await expect(page.locator('[data-simmode-cover-note]')).toContainText('신고만 모드에서는 센서를 쓰지 않아 0%');
  await page.locator('[data-simmode-detection-table]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/p6b2-compare.png' });
  await page.locator('[data-simmode-exit]').click();
  await expect(page.locator('[data-simmode-banner]')).toHaveCount(0);

  // ---- deleting the road deletes its sensor (both clients) ----
  await lookAt(page, -60, 140, 40, 0, ROAD_Z);
  await page.keyboard.press('4');
  await clickWorld(page, 0, ROAD_Z);
  await expect.poll(async () => (await sensorList(page)).length, { timeout: 10_000 }).toBe(0);
  await expect.poll(async () => (await sensorList(other)).length, { timeout: 10_000 }).toBe(0);
  await expect.poll(async () => (await stats(page)).total).toBe(0);
  await expect.poll(async () => (await stats(other)).drawn.cctv).toBe(0);
  await other.close();
  expect(errors.filter((e) => !/WebSocket connection to .*\/ws.* failed/.test(e))).toEqual([]);
});
