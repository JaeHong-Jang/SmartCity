// P5a road fillets (ADR 0012 §1): a bent road drawn with "모서리 자동 둥글게" gets a curve segment and
// traffic; an existing sharp corner is rounded from the inspector; a corner with a bus stop shows why not.
// Run: E2E_SERVER=1 E2E_WEB_PORT=5186 E2E_SERVER_PORT=8796 npx playwright test e2e/fillet.spec.ts
import { expect, test, type Page } from '@playwright/test';

interface Seg {
  a: string;
  b: string;
  control?: { x: number; z: number };
}
interface Hook {
  store: {
    getState(): {
      doc: { segments: Record<string, Seg>; nodes: Record<string, { id: string; pos: { x: number; z: number } }>; busStops: Record<string, unknown> };
      simStats: { vehicles: number } | null;
      toolOptions: { autoFillet: boolean };
    };
    set(patch: Record<string, unknown>): void;
  };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const hook = (page: Page) => <T>(fn: (h: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__smartcity)`) as Promise<T>;

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as { __smartcity: Hook }).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number) {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(400);
}

const segCount = (page: Page) => hook(page)((s) => Object.keys(s.store.getState().doc.segments).length);
/** Curve segments whose control point is the given corner. */
const curvesAt = (page: Page, x: number, z: number) =>
  page.evaluate(
    ([x, z]) =>
      Object.values((window as unknown as { __smartcity: Hook }).__smartcity.store.getState().doc.segments).filter((s) => s.control && Math.abs(s.control.x - x!) < 1e-6 && Math.abs(s.control.z - z!) < 1e-6).length,
    [x, z],
  );
const nodeAt = (page: Page, x: number, z: number) =>
  page.evaluate(([x, z]) => Object.values((window as unknown as { __smartcity: Hook }).__smartcity.store.getState().doc.nodes).find((n) => n.pos.x === x && n.pos.z === z)?.id ?? null, [x, z]);

/** Draw a 3-point road with the road tool, waiting for each piece to be applied (optional preview shot before the last click). */
async function drawBent(page: Page, pts: [number, number][], previewShot?: string) {
  await page.keyboard.press('2');
  for (const [i, [x, z]] of pts.entries()) {
    const before = await segCount(page);
    if (previewShot && i === pts.length - 1) {
      const p = await page.evaluate(([x, z]) => (window as unknown as { __smartcity: Hook }).__smartcity.worldToScreen(x!, z!), [x, z]);
      await page.mouse.move(p.x, p.y, { steps: 6 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: previewShot });
    }
    await clickWorld(page, x, z);
    if (i > 0) await expect.poll(() => segCount(page), { timeout: 5000 }).toBeGreaterThan(before);
  }
  await page.keyboard.press('Escape');
}

test('P5a fillet: auto-rounded new road with traffic, inspector rounding, refusal reason', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket connection to .*\/ws.* failed/.test(m.text())) errors.push(m.text());
  });
  const h = hook(page);
  await page.goto(`/?room=e2e-fillet-${Date.now().toString(36)}`);
  if (process.env.E2E_SERVER === '1') await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await lookAt(page, -40, 420, 330, 0, 80);

  // 1) New bent road, automatic fillet on (default): the corner at (-48, -96) becomes a curve.
  await page.locator('[data-tool="road"]').click();
  await expect(page.locator('[data-auto-fillet]')).toHaveAttribute('aria-pressed', 'true');
  await drawBent(
    page,
    [
      [-192, -96],
      [-48, -96],
      [-48, 64],
    ],
    'test-results/p5a-preview.png',
  );
  await expect.poll(() => curvesAt(page, -48, -96), { timeout: 5000 }).toBe(1);
  expect(await nodeAt(page, -48, -96)).toBeNull();

  // Traffic: a few buildings along both legs, then vehicles drive.
  await page.keyboard.press('3');
  for (const [x, z] of [[-150, -76], [-120, -116], [-28, 20]] as const) await clickWorld(page, x, z);
  await page.locator('.tool-options button', { hasText: /^오피스 타워/ }).click();
  await clickWorld(page, -72, 30);
  await page.keyboard.press('1');
  await page.locator('.speed button', { hasText: '4×' }).click();
  await page.mouse.move(800, 870);
  await expect.poll(async () => (await h((s) => s.store.getState().simStats?.vehicles ?? 0)), { timeout: 60_000 }).toBeGreaterThan(0);

  // Close-up of the rounded corner (no wedge): opened and checked by hand for the report.
  await lookAt(page, -30, 70, -40, -58, -86);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/p5a-fillet.png' });

  // 2) A sharp corner drawn with the option off, then "모서리 둥글게" in the inspector.
  await lookAt(page, -40, 420, 330, 0, 80);
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-auto-fillet]').click();
  await expect(page.locator('[data-auto-fillet]')).toHaveAttribute('aria-pressed', 'false');
  await drawBent(page, [
    [48, -96],
    [192, -96],
    [192, 64],
  ]);
  expect(await curvesAt(page, 192, -96)).toBe(0);
  const sharp = await nodeAt(page, 192, -96);
  expect(sharp).not.toBeNull();
  await lookAt(page, 210, 70, -40, 182, -86);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/p5a-sharp.png' });
  await page.keyboard.press('1');
  await h((s) => s.store.set({ panel: 'inspector' }));
  await page.evaluate((id) => (window as unknown as { __smartcity: Hook }).__smartcity.store.set({ selection: { kind: 'node', id } }), sharp);
  await expect(page.locator('[data-fillet]')).toBeEnabled();
  await page.locator('[data-fillet]').click();
  await expect.poll(() => curvesAt(page, 192, -96), { timeout: 5000 }).toBe(1);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/p5a-manual.png' });

  // 3) A corner with a bus stop next to it: the button is disabled and the reason is shown.
  await lookAt(page, -40, 420, 330, 0, 80);
  await drawBent(page, [
    [48, 160],
    [192, 160],
    [192, 256],
  ]);
  const blocked = await nodeAt(page, 192, 160);
  expect(blocked).not.toBeNull();
  await page.keyboard.press('5');
  await clickWorld(page, 180, 166);
  await clickWorld(page, 80, 166);
  await page.keyboard.press('Enter');
  await expect.poll(async () => Object.keys((await h((s) => s.store.getState().doc.busStops)) as object).length, { timeout: 5000 }).toBe(2);
  await page.keyboard.press('1');
  await h((s) => s.store.set({ panel: 'inspector' }));
  await page.evaluate((id) => (window as unknown as { __smartcity: Hook }).__smartcity.store.set({ selection: { kind: 'node', id } }), blocked);
  await expect(page.locator('[data-fillet]')).toBeDisabled();
  await expect(page.locator('[data-fillet-reason]')).toHaveText('모서리 구간에 버스 정류장이 있습니다');
  expect(await curvesAt(page, 192, 160)).toBe(0);
  expect(errors).toEqual([]);
});
