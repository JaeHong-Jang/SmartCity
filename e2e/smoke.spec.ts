import { expect, test, type Page } from '@playwright/test';

interface CityHook {
  store: { getState(): { doc: { segments: object; buildings: object; busLines: object; closures: object }; connection: string; simStatus: string; simStats: { vehicles: number } | null; peers: unknown[]; presence: Record<string, unknown> } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
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
