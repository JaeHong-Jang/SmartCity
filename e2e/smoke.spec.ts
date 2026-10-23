import { expect, test, type Page } from '@playwright/test';

interface HookBuilding {
  id: string;
  typeId: string;
  pos: { x: number; z: number };
  rotation: number;
}

interface CityHook {
  store: {
    getState(): {
      doc: {
        segments: object;
        buildings: Record<string, HookBuilding>;
        busLines: object;
        closures: object;
        parcels: Record<string, { zone: string }>;
        nodes: Record<string, { id: string; pos: { x: number; z: number } }>;
      };
      connection: string;
      simStatus: string;
      simStats: { vehicles: number } | null;
      peers: unknown[];
      presence: Record<string, unknown>;
      selection: { kind: string; id: string } | null;
      toolOptions: { snapStep: number };
    };
  };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
  cameraTarget(): { x: number; z: number };
}

/** Console errors, minus the expected failed WebSocket attempt when no server is reachable. */
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

async function screen(page: Page, x: number, z: number) {
  return page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
}

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

async function counts(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState();
    return {
      segments: Object.keys(s.doc.segments).length,
      buildings: Object.keys(s.doc.buildings).length,
      lines: Object.keys(s.doc.busLines).length,
      closures: Object.keys(s.doc.closures).length,
      sim: s.simStatus,
      vehicles: s.simStats?.vehicles ?? 0,
    };
  });
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number) {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(300);
}

test('offline solo: draw roads, place buildings, transit and closures', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -150, 260, 250, 0, 0);

  // Road tool: a cross plus a parallel street and a curved road.
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -144, 0);
  await clickWorld(page, 144, 0);
  await page.keyboard.press('Escape');
  await clickWorld(page, 0, -120);
  await clickWorld(page, 0, 120);
  await page.keyboard.press('Escape');
  await clickWorld(page, -144, 72);
  await clickWorld(page, 144, 72);
  await page.keyboard.press('Escape');
  await page.locator('.tool-options button', { hasText: '4차선 도로' }).click();
  await clickWorld(page, 96, -120);
  await clickWorld(page, 96, 120);
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await page.locator('.tool-options button', { hasText: '2차선 도로' }).click();
  await clickWorld(page, -144, -24);
  await clickWorld(page, -80, -110);
  await clickWorld(page, -24, -120);
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await expect.poll(async () => (await counts(page)).segments, { timeout: 5000 }).toBeGreaterThanOrEqual(12);

  // Live preview while drawing: crossing roads are highlighted as future junctions.
  await clickWorld(page, -60, -60);
  const hover = await screen(page, 60, 110);
  await page.mouse.move(hover.x, hover.y, { steps: 5 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/smoke-road-preview.png' });
  await page.keyboard.press('Escape');

  // Buildings next to roads (auto-aligned).
  await page.keyboard.press('3');
  await clickWorld(page, 40, 20);
  await clickWorld(page, -40, 22);
  await page.locator('.tool-options button', { hasText: '아파트' }).click();
  await clickWorld(page, 45, 50);
  await page.locator('.tool-options button', { hasText: '오피스 타워' }).click();
  await clickWorld(page, -60, -40);
  await page.locator('.tool-options button', { hasText: '근린상가' }).click();
  await clickWorld(page, 130, 30);
  await expect.poll(async () => (await counts(page)).buildings, { timeout: 5000 }).toBeGreaterThanOrEqual(4);
  await page.locator('.tool-options button', { hasText: '시청' }).click();
  const ghostAt = await screen(page, -60, 40);
  await page.mouse.move(ghostAt.x, ghostAt.y, { steps: 5 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/smoke-building-ghost.png' });

  // Bus line along the main street, then close the south end of the north-south road.
  await page.keyboard.press('5');
  await clickWorld(page, -110, 3);
  await clickWorld(page, 50, 3);
  await clickWorld(page, 120, 75);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await counts(page)).lines, { timeout: 5000 }).toBe(1);
  await page.keyboard.press('6');
  await clickWorld(page, 0, 100);
  await expect.poll(async () => (await counts(page)).closures, { timeout: 5000 }).toBe(1);

  // Select the junction at the origin: the inspector opens with the signal editor.
  await page.keyboard.press('1');
  await clickWorld(page, 0, 0);
  await expect(page.locator('.side-body')).toContainText('교차점');

  await page.mouse.move(800, 860);
  await page.waitForTimeout(4000);
  const c = await counts(page);
  console.log('state after editing:', JSON.stringify(c));
  await page.screenshot({ path: 'test-results/smoke-overview.png' });

  await lookAt(page, -45, 55, 60, 0, 10);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/smoke-junction.png' });

  await page.locator('label.toggle', { hasText: '교통 흐름' }).click();
  await lookAt(page, -120, 210, 200, 0, 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/smoke-flow.png' });
  await page.locator('label.toggle', { hasText: '교통 흐름' }).click();
  await lookAt(page, -45, 55, 60, 0, 10);

  await page.locator('.tabs button', { hasText: '건물' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/smoke-building-editor.png' });

  // Export → import into a fresh room (replayed as command batches).
  const before = await counts(page);
  const exported = await page.evaluate(() => JSON.stringify((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc));
  await page.locator('input[type="file"]').setInputFiles({ name: 'city.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await page.waitForURL(/room=import-/);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await expect.poll(async () => (await counts(page)).segments, { timeout: 10_000 }).toBe(before.segments);
  const after = await counts(page);
  expect([after.buildings, after.lines, after.closures]).toEqual([before.buildings, before.lines, before.closures]);

  expect(errors).toEqual([]);
});

/** Press at world a, drag in small steps to world b, release (screen positions taken at press time). */
async function dragWorld(page: Page, a: [number, number], b: [number, number], opts: { before?: () => Promise<void>; screenshot?: string } = {}) {
  const p = await screen(page, a[0], a[1]);
  const q = await screen(page, b[0], b[1]);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 12 });
  await page.waitForTimeout(150);
  if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

test('phase 2a: parcels, moving and rotating buildings, ground pan, junction drag, grid, dashboard', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-2a-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -120, 220, 220, 20, 20);

  // Roads: a cross.
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -144, 0);
  await clickWorld(page, 144, 0);
  await page.keyboard.press('Escape');
  await clickWorld(page, 0, -120);
  await clickWorld(page, 0, 120);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await counts(page)).segments, { timeout: 5000 }).toBeGreaterThanOrEqual(4);

  // Parcel tool (7): commercial zone, drag a rectangle on the 8 m grid.
  await page.keyboard.press('7');
  await page.locator('.tool-options button[data-zone="commercial"]').click();
  await dragWorld(page, [16, 16], [96, 80], { screenshot: 'test-results/phase2a-parcel-ghost.png' });
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.parcels).map((p) => p.zone))).toEqual(['commercial']);

  // Buildings placed freely (Shift) inside the parcel: a shop, and a factory that breaks the zone's uses.
  await page.keyboard.press('3');
  await page.locator('.tool-options button', { hasText: '근린상가' }).click();
  await page.keyboard.down('Shift');
  await clickWorld(page, 48, 48);
  await page.locator('.tool-options button', { hasText: '공장' }).click();
  await clickWorld(page, 64, 32);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await counts(page)).buildings, { timeout: 5000 }).toBe(2);
  const shop = await page.evaluate(() => Object.values((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings).find((b) => b.typeId === 'shop')!);
  await expect(page.locator('.violation-badge')).toHaveCount(1);

  // Select tool: drag the shop to a new spot (one building.move on release, snapped to 8 m).
  await page.keyboard.press('1');
  await dragWorld(page, [shop.pos.x, shop.pos.z], [shop.pos.x + 14, shop.pos.z + 18], { screenshot: 'test-results/phase2a-move-ghost.png' });
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings[id]!.pos, shop.id)).not.toEqual(shop.pos);
  const moved = await page.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings[id]!, shop.id);
  expect(moved.pos.x % 8).toBe(0);
  expect(moved.pos.z % 8).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().selection)).toEqual({ kind: 'building', id: shop.id });

  // ] rotates the selected building by 15°.
  await page.keyboard.press(']');
  await expect
    .poll(() => page.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings[id]!.rotation, shop.id))
    .toBeCloseTo(moved.rotation + Math.PI / 12, 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/phase2a-rotated.png' });

  // Alt+drag places a copy.
  await page.keyboard.down('Alt');
  const at = await page.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings[id]!.pos, shop.id);
  await dragWorld(page, [at.x, at.z], [at.x - 16, at.z + 8]);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await counts(page)).buildings, { timeout: 5000 }).toBe(3);

  // Left-drag on empty ground pans the camera.
  const camBefore = await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.cameraTarget());
  await dragWorld(page, [-100, -80], [-60, -40]);
  const camAfter = await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.cameraTarget());
  expect(Math.hypot(camAfter.x - camBefore.x, camAfter.z - camBefore.z)).toBeGreaterThan(20);

  // Drag the junction at the origin: node.move, connected roads follow.
  await lookAt(page, -120, 220, 220, 20, 20);
  const center = await page.evaluate(() => Object.values((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.nodes).find((n) => n.pos.x === 0 && n.pos.z === 0)!.id);
  await dragWorld(page, [0, 0], [-16, -12], { screenshot: 'test-results/phase2a-node-drag.png' });
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.nodes[id]!.pos, center)).toEqual({ x: -16, z: -16 });

  // G cycles the snap step (8 → 4 → 2) and the bottom bar follows.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  expect(await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().toolOptions.snapStep)).toBe(2);
  await expect(page.locator('.statusbar button[data-snap="2"]')).toHaveClass(/active/);
  await lookAt(page, 10, 70, 110, 40, 40);
  const hover = await screen(page, 30, 60);
  await page.mouse.move(hover.x, hover.y, { steps: 4 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/phase2a-fine-grid.png' });

  // Parcel inspector: click an empty spot inside the parcel.
  await lookAt(page, -40, 160, 190, 50, 50);
  await clickWorld(page, 88, 74);
  await expect(page.locator('.side-body')).toContainText('필지');
  await expect(page.locator('.side-body')).toContainText('규제 위반');
  await page.screenshot({ path: 'test-results/phase2a-parcel-inspector.png' });

  // Dashboard.
  await page.locator('[data-dashboard]').click();
  await expect(page.locator('.dashboard')).toContainText('도시 현황 (설계 기준)');
  await expect(page.locator('.dashboard')).toContainText('교통(내 화면 미리보기)');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/phase2a-dashboard.png' });

  expect(errors).toEqual([]);
});

test('collaboration: two users share edits, cursors and ghosts', async ({ browser }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (starts apps/server)');
  const room = `e2e-collab-${Date.now().toString(36)}`;
  const a = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errA = trackErrors(a);
  const errB = trackErrors(b);
  await a.goto(`/?room=${room}`);
  await b.goto(`/?room=${room}`);
  await expect(a.locator('.badge')).toContainText('온라인');
  await expect(b.locator('.badge')).toContainText('온라인');
  for (const p of [a, b]) {
    await p.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
    await lookAt(p, -150, 260, 250, 0, 0);
  }

  await a.locator('[data-tool="road"]').click();
  await clickWorld(a, -120, 0);
  await clickWorld(a, 120, 0);
  await a.keyboard.press('Escape');
  await clickWorld(a, 0, -100);
  await clickWorld(a, 0, 100);
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await counts(b)).segments, { timeout: 5000 }).toBeGreaterThanOrEqual(4);

  // A starts drawing; B should see A's cursor label and ghost.
  await clickWorld(a, -100, 60);
  const p = await screen(a, 80, 60);
  await a.mouse.move(p.x, p.y, { steps: 6 });
  await expect(b.locator('.peer-label')).toBeVisible({ timeout: 5000 });
  await b.waitForTimeout(800);
  await b.screenshot({ path: 'test-results/smoke-collab-b.png' });
  await a.keyboard.press('Escape');

  // B selects a road: A sees it outlined in B's color with B's name badge.
  await b.keyboard.press('1');
  await clickWorld(b, 60, 2);
  await expect(a.locator('.peer-sel-label')).toBeVisible({ timeout: 5000 });
  await expect(a.locator('.peer-sel-label')).toContainText('편집 중');
  await a.waitForTimeout(500);
  await a.screenshot({ path: 'test-results/phase2a-peer-selection.png' });
  await a.screenshot({ path: 'test-results/smoke-collab-a.png' });
  expect(errA).toEqual([]);
  expect(errB).toEqual([]);
});

test('real traffic on a road grid', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-grid-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -220, 380, 360, 0, 0);
  await page.locator('[data-tool="road"]').click();
  await page.locator('.tool-options button', { hasText: '4차선 도로' }).click();
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
  await expect.poll(async () => (await counts(page)).segments, { timeout: 8000 }).toBeGreaterThanOrEqual(40);
  // A few buildings so demand has origins and destinations.
  await page.keyboard.press('3');
  for (const [x, z] of [[-96, -125], [0, -125], [96, -30], [-96, 70], [0, 125]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: '아파트' }).click();
  for (const [x, z] of [[-96, 30], [96, 125], [0, 30]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: '오피스 타워' }).click();
  await clickWorld(page, 96, -100);
  await page.keyboard.press('1');
  await page.locator('.speed button', { hasText: '4×' }).click();
  await page.mouse.move(800, 870);
  await expect.poll(async () => (await counts(page)).vehicles, { timeout: 30_000 }).toBeGreaterThan(20);
  await page.waitForTimeout(4000);
  console.log('grid state:', JSON.stringify(await counts(page)));
  await page.screenshot({ path: 'test-results/traffic-grid.png' });
  await lookAt(page, -20, 45, 55, 48, 48);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/traffic-closeup.png' });
  await page.locator('label.toggle', { hasText: '교통 흐름' }).click();
  await lookAt(page, -220, 380, 360, 0, 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/traffic-flow.png' });
  expect(errors).toEqual([]);
});

test('phase 2b: street features, citizens walking out of homes, building studio', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-2b-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -40, 260, 260, 0, 20);
  const state = () => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState() as unknown as {
    doc: { features: Record<string, { kind: string; signal?: boolean }>; segments: Record<string, { schoolZone?: boolean }>; buildingTypes: Record<string, unknown> };
    simStats: { pedestrians?: number; citizens?: { total: number; walking: number } } | null;
  });

  // A cross of two-lane roads (with sidewalks).
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -160, 0);
  await clickWorld(page, 160, 0);
  await page.keyboard.press('Escape');
  await clickWorld(page, 0, -120);
  await clickWorld(page, 0, 120);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await counts(page)).segments, { timeout: 5000 }).toBeGreaterThanOrEqual(4);

  // Street tool (8): a mid-block crosswalk and a speed bump, far from the junction.
  await page.keyboard.press('8');
  await page.locator('[data-street-mode="signalCrosswalk"]').click();
  await clickWorld(page, 90, 0);
  await page.locator('[data-street-mode="speedBump"]').click();
  await clickWorld(page, -90, 0);
  await expect.poll(async () => Object.values((await state()).doc.features).map((f) => f.kind).sort(), { timeout: 5000 }).toEqual(['crosswalk', 'speedBump']);
  // Too close to the junction: refused (red ghost, nothing placed).
  await clickWorld(page, 8, 0);
  await page.waitForTimeout(300);
  expect(Object.keys((await state()).doc.features)).toHaveLength(2);
  await page.screenshot({ path: 'test-results/phase2b-street-features.png' });

  // Homes first, workplaces after (citizens must still find jobs), all next to the roads.
  await page.keyboard.press('3');
  await page.locator('.tool-options button', { hasText: '아파트' }).click();
  await clickWorld(page, -60, 30);
  await clickWorld(page, 60, -30);
  await page.locator('.tool-options button', { hasText: '오피스 타워' }).click();
  await clickWorld(page, 60, 34);
  await page.locator('.tool-options button', { hasText: '근린상가' }).click();
  await clickWorld(page, -60, -26);
  await expect.poll(async () => (await counts(page)).buildings, { timeout: 5000 }).toBe(4);

  // Citizens leave their homes and walk: run at 4× until pedestrians are out.
  await page.locator('.row.speed button', { hasText: '4×' }).first().click();
  await expect.poll(async () => (await state()).simStats?.pedestrians ?? 0, { timeout: 150_000, intervals: [2000] }).toBeGreaterThan(0);
  const citizens = (await state()).simStats!.citizens!;
  expect(citizens.total).toBeGreaterThan(0);
  await lookAt(page, -10, 70, 90, 0, 10);
  await page.screenshot({ path: 'test-results/phase2b-pedestrians.png' });

  // Building studio: stack a few blocks with clicks and save a new design.
  const typesBefore = Object.keys((await state()).doc.buildingTypes).length;
  await page.locator('[role="tab"]', { hasText: '건물' }).click();
  await page.locator('[data-studio-new]').click();
  await expect(page.locator('[data-studio]')).toBeVisible();
  const canvas = page.locator('[data-studio] canvas').first();
  const box = (await canvas.boundingBox())!;
  for (const [dx, dy] of [[0, 0], [0, 0], [30, 10], [-30, 10]]) {
    await page.mouse.click(box.x + box.width / 2 + dx!, box.y + box.height / 2 + dy!);
    await page.waitForTimeout(150);
  }
  await expect(page.locator('[data-studio-save]')).toBeEnabled({ timeout: 5000 });
  await page.screenshot({ path: 'test-results/phase2b-studio.png' });
  await page.locator('[data-studio-save]').click();
  await expect(page.locator('[data-studio-notice]')).toBeVisible({ timeout: 5000 });
  expect(Object.keys((await state()).doc.buildingTypes).length).toBe(typesBefore + 1);

  expect(errors).toEqual([]);
});

test('phase 3b·3c: zoning grows buildings, AI assistant proposes and applies', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (growth director and AI run on the server)');
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.goto(`/?room=e2e-3b-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -40, 220, 220, 0, 20);
  const doc = () => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc as unknown as {
    parcels: Record<string, { auto?: boolean }>;
    buildings: Record<string, { auto?: boolean; typeId: string }>;
  });

  // One long road.
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -180, 0);
  await clickWorld(page, 180, 0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await counts(page)).segments, { timeout: 5000 }).toBe(1);

  // Zoning tool (9): paint residential along the south side, 2 cells deep.
  await page.keyboard.press('9');
  await page.locator('[data-zoning-zone="residential"]').click();
  await page.locator('[data-zoning-depth="2"]').click();
  await dragWorld(page, [-150, 14], [150, 14], { screenshot: 'test-results/phase3b-zoning-drag.png' });
  await expect.poll(async () => Object.values((await doc()).parcels).filter((p) => p.auto).length, { timeout: 5000 }).toBeGreaterThan(4);

  // The server's growth director builds on the lots (every 5 s while someone is connected).
  await expect.poll(async () => Object.values((await doc()).buildings).filter((b) => b.auto).length, { timeout: 60_000, intervals: [2000] }).toBeGreaterThan(0);
  await expect(page.locator('[data-growth-hud]')).toBeVisible();
  await page.screenshot({ path: 'test-results/phase3b-growth.png' });

  // AI assistant (scripted model on the server): ask, preview, apply.
  await page.keyboard.press('1');
  await page.locator('[role="tab"]', { hasText: 'AI' }).click();
  await expect(page.locator('[data-ai-panel]')).toBeVisible({ timeout: 5000 });
  await page.locator('textarea[aria-label="AI에게 요청"]').fill('도로 북쪽에 카페 지어줘');
  await page.locator('[data-ai-send]').click();
  await expect(page.locator('[data-ai-proposal]')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'test-results/phase3c-ai-proposal.png' });
  // Nothing is built before approval.
  const proposed = await page.evaluate(() => {
    const s = (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState() as unknown as { doc: { buildings: Record<string, unknown> } };
    return Object.keys(s.doc.buildings).filter((id) => id.startsWith('ai-')).length;
  });
  expect(proposed).toBe(0);
  await page.locator('[data-ai-apply]').click();
  await expect.poll(async () => Object.keys((await doc()).buildings).filter((id) => id.startsWith('ai-')).length, { timeout: 5000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/phase3c-ai-applied.png' });
  expect(errors).toEqual([]);
});
