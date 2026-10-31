// P7b (ADR 0014 §6): modern procedural vehicles. Close-ups of every model class by day and by night (a
// showroom snapshot fed to the renderer's vehicle layer on a real road), then real traffic on a road grid.
// Screenshots: test-results/p7b-*.png.
import { expect, test, type Page } from '@playwright/test';

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/WebSocket connection to .*\/ws.* failed/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function clickWorld(page: Page, x: number, z: number) {
  const p = await hook<{ x: number; y: number }>(page, `h.worldToScreen(${x}, ${z})`);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number, settle = 600) {
  await hook(page, `h.lookAt(${px}, ${py}, ${pz}, ${tx}, ${tz})`);
  await page.waitForTimeout(settle);
}

async function road(page: Page, label: string, a: [number, number], b: [number, number]) {
  await page.locator('[data-tool="road"]').click();
  await page.locator('.tool-options button', { hasText: label }).click();
  await clickWorld(page, a[0], a[1]);
  await clickWorld(page, b[0], b[1]);
  await page.keyboard.press('Escape');
}

/** Showroom row: [x, kind] where kind is a car class name, a default type id, or 'fire!' / 'ambulance!' (dispatched). */
const ROW: [number, string][] = [
  [0, 'sedan'], [7, 'suv'], [14, 'hatch'], [21, 'van'], [30, 'pickup'], [37, 'taxi'], [44, 'police'],
  [62, 'truck'], [78, 'city-bus'], [96, 'ambulance'], [110, 'fire!'], [124, 'ambulance!'],
];

test('p7b: vehicle models close up, day and night', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-p7b-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await lookAt(page, 60, 320, 260, 60, 0, 300);
  await road(page, '4차선 도로', [-40, 0], [160, 0]);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length')).toBeGreaterThan(0);
  await page.locator('[data-tool="select"]').click();

  // Feed the vehicle layer a fixed snapshot: one vehicle per model, heading +x in the right-hand lane.
  const lod = await hook<number[]>(
    page,
    `(async () => {
      const vm = await import('/src/render/vehicleModels.ts');
      const row = ${JSON.stringify(ROW)};
      const types = ['sedan', 'suv', 'truck', 'city-bus', 'ambulance'];
      const STRIDE = 6; // VEHICLE_STRIDE: x, z, heading, type, speed, id
      const v = new Float32Array(row.length * STRIDE);
      const dispatches = [];
      let next = 1000;
      row.forEach(([x, kind], i) => {
        const cls = vm.CAR_CLASSES.indexOf(kind);
        // Appearance classes come from the default sedan or SUV type's mix.
        const group = cls >= 0 && vm.CLASS_MIX.suv.some(([c]) => c === kind) ? 'suv' : 'sedan';
        let id;
        if (cls >= 0) { id = next; while (vm.carClassOf(id, group) !== cls) id++; next = id + 1; }
        else id = 90000 + i;
        const t = cls >= 0 ? (group === 'suv' ? 1 : 0) : types.indexOf(kind.replace('!', '') === 'fire' ? 'ambulance' : kind.replace('!', ''));
        if (kind.endsWith('!')) dispatches.push({ eventId: 'e' + i, kind: kind === 'fire!' ? 'fire' : 'medical', vehicleId: id, stage: 'enroute', facilityId: 'f', buildingId: 'b' });
        v.set([x, 1.75, 0, t, 0, id], i * STRIDE);
      });
      const scenario = { dispatches, incidents: [], damagedBuildings: [], preempted: [], obstacles: [], closedLanes: [] };
      const snap = { vehicles: v, vehicleCount: row.length, vehicleTypeIds: types, graphRevision: 1, scenario };
      const fake = { latest: () => snap, previous: () => null, previousAt: () => 0, latestAt: () => 0 };
      h.renderer.vehicles.stream = fake;
      h.renderer.emergency.stream = fake;
      await new Promise((r) => setTimeout(r, 300));
      return h.renderer.vehicles.lodCounts;
    })()`,
  );
  console.log('showroom LOD counts at the overview:', JSON.stringify(lod));

  // [file, camera x, y, z, target x, z]: right side 3/4 views; front 3/4 for the lights.
  const SHOTS: [string, number, number, number, number, number][] = [
    ['cars', 4, 3.2, 13, 11, 1.75],
    ['cars2', 30, 3.2, 12, 37, 1.75],
    ['bus-truck', 60, 4.5, 20, 72, 1.75],
    ['emergency', 100, 4.2, 19, 112, 1.75],
    ['front', 54, 2.6, 7, 40, 1.75],
  ];
  for (const [phase, time] of [['day', 12], ['night', 22]] as const) {
    await hook(page, `h.perf.setDayTime(${time} * 3600)`);
    for (const [name, px, py, pz, tx, tz] of SHOTS) {
      await lookAt(page, px, py, pz, tx, tz);
      await page.screenshot({ path: `test-results/p7b-${name}-${phase}.png` });
    }
  }
  const near = await hook<number[]>(page, 'h.renderer.vehicles.lodCounts');
  expect(near[0]).toBeGreaterThan(0);
  // Dispatched vehicles are counted by the emergency layer, drawn once by the vehicle layer.
  expect(await hook(page, 'h.simmode.emergency()')).toMatchObject({ fireTrucks: 1, ambulances: 1 });
  expect(errors).toEqual([]);
});

test('p7b: traffic on the road, day and night', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-p7b-traffic-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await lookAt(page, -220, 380, 360, 0, 0, 300);
  for (const v of [-144, -48, 48, 144]) await road(page, '4차선 도로', [-192, v], [192, v]);
  for (const v of [-144, -48, 48, 144]) await road(page, '4차선 도로', [v, -192], [v, 192]);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length'), { timeout: 8000 }).toBeGreaterThanOrEqual(40);
  await page.keyboard.press('3');
  for (const [x, z] of [[-96, -125], [0, -125], [96, -30], [-96, 70], [0, 125]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: /^아파트/ }).click();
  for (const [x, z] of [[-96, 30], [96, 125], [0, 30]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: /^오피스 타워/ }).click();
  await clickWorld(page, 96, -100);
  await page.keyboard.press('1');
  await page.locator('.speed button', { hasText: '4×' }).click();
  await page.mouse.move(800, 870);
  await expect.poll(() => hook<number>(page, 'h.store.getState().simStats?.vehicles ?? 0'), { timeout: 30_000 }).toBeGreaterThan(20);
  await page.waitForTimeout(4000);
  await page.locator('.speed button', { hasText: '1×' }).click();
  for (const [phase, time] of [['day', 12], ['night', 21.5]] as const) {
    await hook(page, `h.perf.setDayTime(${time} * 3600)`);
    await lookAt(page, 20, 26, 95, 48, 48, 1200);
    await page.screenshot({ path: `test-results/p7b-traffic-${phase}.png` });
    await lookAt(page, -220, 380, 360, 0, 0, 1200);
    await page.screenshot({ path: `test-results/p7b-traffic-overview-${phase}.png` });
    console.log(phase, 'LOD counts (overview):', JSON.stringify(await hook<number[]>(page, 'h.renderer.vehicles.lodCounts')), 'stats:', JSON.stringify(await hook(page, 'h.perf.stats()')));
  }
  expect(errors).toEqual([]);
});
