import { test, type Page } from '@playwright/test';

// Phase 4b: variety of grown buildings (screenshot only). Needs the server's growth director.

interface CityHook {
  store: { getState(): { doc: { buildings: Record<string, { auto?: boolean; typeId: string }> } } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const hook = (page: Page) => page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc.buildings);

async function screen(page: Page, x: number, z: number) {
  return page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
}

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

async function dragWorld(page: Page, a: [number, number], b: [number, number]) {
  const p = await screen(page, a[0], a[1]);
  const q = await screen(page, b[0], b[1]);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number) {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(400);
}

test('phase 4b: grown buildings differ in shape and colour', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the growth director runs on the server)');
  test.setTimeout(300_000);
  await page.goto(`/?room=e2e-4b-bld-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, -40, 260, 260, 0, 20);

  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -180, 0);
  await clickWorld(page, 180, 0);
  await page.keyboard.press('Escape');

  await page.keyboard.press('9');
  await page.locator('[data-zoning-zone="residential"]').click();
  await page.locator('[data-zoning-depth="4"]').click();
  await dragWorld(page, [-150, 14], [150, 14]);
  await page.locator('[data-zoning-zone="commercial"]').click();
  await page.locator('[data-zoning-depth="2"]').click();
  await dragWorld(page, [-150, -14], [150, -14]);
  await page.keyboard.press('1');

  await page.locator('.speed button', { hasText: '4×' }).click();
  const grown = async () => Object.values(await hook(page)).filter((b) => b.auto);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && (await grown()).length < 18) await page.waitForTimeout(3000);
  const types = (await grown()).map((b) => b.typeId);
  console.log('grown', types.length, JSON.stringify(types.reduce<Record<string, number>>((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {})));
  await lookAt(page, -10, 55, 105, -10, 22);
  await page.screenshot({ path: 'test-results/phase4b-buildings.png' });
});
