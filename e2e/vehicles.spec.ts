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

test('phase 4b: varied car models and colors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?offline=1&room=e2e-veh-${Date.now().toString(36)}`);
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
  await page.locator('.tool-options button', { hasText: /^아파트/ }).click();
  for (const [x, z] of [[-96, 30], [96, 125], [0, 30]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: /^오피스 타워/ }).click();
  await clickWorld(page, 96, -100);
  await page.keyboard.press('1');
  await page.locator('.speed button', { hasText: '4×' }).click();
  await page.mouse.move(800, 870);
  await expect.poll(async () => (await counts(page)).vehicles, { timeout: 30_000 }).toBeGreaterThan(20);
  await page.waitForTimeout(4000);
  console.log('grid state:', JSON.stringify(await counts(page)));
  await page.screenshot({ path: 'test-results/traffic-grid.png' });
  await lookAt(page, 40, 36, 80, 40, 40);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/phase4b-vehicles.png' });
  expect(errors).toEqual([]);
});
