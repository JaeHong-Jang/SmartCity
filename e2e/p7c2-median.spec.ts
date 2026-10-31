// P7c-2 (ADR 0014 §2·§4): an 8-lane median boulevard drawn with the road tool gets a raised planted median
// with a row of trees, cut before the junction and at a mid-block crosswalk; a speed bump covers both driving
// areas but not the median. Offline room only. Screenshots: test-results/p7c2-*.png (eye level, city, night).
// Run: E2E_WEB_PORT=5193 npx playwright test e2e/p7c2-median.spec.ts
import { expect, test, type Page } from '@playwright/test';

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
const near = (page: Page, x: number, z: number, r: number) => hook<{ trees: { x: number; z: number }[]; lamps: { x: number; z: number }[] }>(page, `h.renderer.streetscapeNear(${x}, ${z}, ${r})`);

async function clickWorld(page: Page, x: number, z: number) {
  const p = await hook<{ x: number; y: number }>(page, `h.worldToScreen(${x}, ${z})`);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

/** Road mesh vertices (world space) that `filter` (a JS expression of x, y, z) keeps. */
const roadVertices = (page: Page, filter: string) =>
  hook<{ x: number; y: number; z: number }[]>(
    page,
    `(() => {
      const out = [];
      for (const m of h.renderer.scene.getObjectByName('roads').children) {
        const a = m.geometry.getAttribute('position').array;
        for (let i = 0; i < a.length; i += 3) {
          const x = a[i], y = a[i + 1], z = a[i + 2];
          if (${filter}) out.push({ x, y, z });
        }
      }
      return out;
    })()`,
  );

// Road heights (render/roads.ts): markings at 0.08, sidewalks and the median island at 0.2, hedge top 0.8.
const Y_WALK = 0.2;
const MEDIAN_HALF = 3;
const CURB_HALF = 17;

test('an 8-lane median boulevard: tree row on the median, cut before the junction and at a crosswalk, bump off the median', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /THREE\.WebGLProgram|shader/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(`/?offline=1&room=e2e-p7c2-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await ready(page);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await hook(page, 'h.lookAt(0, 700, 1, 0, 0)');
  await page.waitForTimeout(400);

  // Two 8-lane median boulevards crossing at (0, 0).
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-road-type="road-8-median"]').click();
  for (const [a, b] of [
    [[-240, 0], [240, 0]],
    [[0, -160], [0, 160]],
  ] as const) {
    await clickWorld(page, a[0], a[1]);
    await clickWorld(page, b[0], b[1]);
    await page.keyboard.press('Escape');
  }
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length'), { timeout: 10_000 }).toBe(4);
  expect(await hook<string[]>(page, '[...new Set(Object.values(h.store.getState().doc.segments).map((s) => s.roadTypeId))]')).toEqual(['road-8-median']);

  // A speed bump on the east arm, a mid-block crosswalk on the west arm.
  await page.locator('[data-tool="street"]').click();
  await page.locator('[data-street-mode="speedBump"]').click();
  await clickWorld(page, 120, 8);
  await page.locator('[data-street-mode="crosswalk"]').click();
  await clickWorld(page, -120, 8);
  await expect.poll(() => hook<string[]>(page, 'Object.values(h.store.getState().doc.features).map((f) => f.kind).sort()'), { timeout: 5000 }).toEqual(['crosswalk', 'speedBump']);
  await page.keyboard.press('Escape');
  // The road network is rebuilt on the next frame (slow under software GL): wait for the crosswalk in it.
  await expect.poll(() => hook<number>(page, "h.renderer.roadNetwork.crossings.filter((c) => c.kind === 'midblock').length"), { timeout: 10_000 }).toBe(1);

  // Where the lanes (and the median) start at the junction, the bump's and the crosswalk's x.
  const geo = await hook<{ start: number; bumpX: number; crossX: number; crossHalf: number }>(
    page,
    `(() => {
      const doc = h.store.getState().doc;
      const net = h.renderer.roadNetwork;
      const east = [...net.segments.values()].find((g) => Math.min(...g.centerline.map((p) => p.x)) > -1 && Math.abs(g.centerline[0].z) < 1);
      const atJunction = Math.abs(east.centerline[0].x) < 1 ? east.laneStartA : east.laneStartB;
      const pos = (f) => {
        const g = net.segments.get(f.segmentId);
        const p = g.centerline[0], q = g.centerline[g.centerline.length - 1];
        return p.x + (q.x - p.x) * f.t;
      };
      const feats = Object.values(doc.features);
      const cw = net.crossings.find((c) => c.kind === 'midblock');
      return { start: atJunction, bumpX: pos(feats.find((f) => f.kind === 'speedBump')), crossX: (cw.a.x + cw.b.x) / 2, crossHalf: cw.width / 2 };
    })()`,
  );
  expect(geo.start).toBeGreaterThan(20);
  expect(geo.bumpX).toBeGreaterThan(100);
  expect(geo.crossX).toBeLessThan(-100);

  // Tree row on the median center line (z = 0), about every 9 m on both arms.
  await expect.poll(async () => (await near(page, 130, 0, 60)).trees.filter((t) => Math.abs(t.z) < 0.01).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
  const row = (await near(page, 0, 0, 260)).trees.filter((t) => Math.abs(t.z) < 0.01 || Math.abs(t.x) < 0.01);
  expect(row.filter((t) => t.x < 0 && Math.abs(t.z) < 0.01).length).toBeGreaterThanOrEqual(8);
  // Cut before the junction: no median tree (or island) inside the lanes' start.
  for (const t of row) expect(Math.max(Math.abs(t.x), Math.abs(t.z))).toBeGreaterThanOrEqual(geo.start);
  const islandInJunction = await roadVertices(
    page,
    `y >= ${Y_WALK - 0.001} && ((Math.abs(z) < ${MEDIAN_HALF - 0.01} && Math.abs(x) < ${geo.start - 0.01}) || (Math.abs(x) < ${MEDIAN_HALF - 0.01} && Math.abs(z) < ${geo.start - 0.01}))`,
  );
  expect(islandInJunction).toEqual([]);
  // The island runs along the arms (raised top and hedge: vertices at its ends), from the junction to the road end.
  const east = (await roadVertices(page, `y >= ${Y_WALK - 0.001} && Math.abs(z) < ${MEDIAN_HALF - 0.01} && x > 0`)).map((v) => v.x);
  expect(Math.min(...east)).toBeLessThan(geo.start + 2);
  expect(Math.max(...east)).toBeGreaterThan(230);
  // Cut across the crosswalk: nothing raised on the zebra, and island ends just outside it on both sides.
  const atCross = await roadVertices(page, `y >= ${Y_WALK - 0.001} && Math.abs(z) <= ${MEDIAN_HALF} && Math.abs(x - ${geo.crossX}) < ${geo.crossHalf + 2}`);
  expect(atCross.filter((v) => Math.abs(v.x - geo.crossX) < geo.crossHalf)).toEqual([]);
  expect(atCross.some((v) => v.x < geo.crossX) && atCross.some((v) => v.x > geo.crossX)).toBe(true);
  expect(row.filter((t) => Math.abs(t.x - geo.crossX) < geo.crossHalf + 1.5)).toEqual([]);

  // The speed bump: both driving areas (3 … 17 m off the center line), never across the median.
  const bump = await roadVertices(page, `y > 0.082 && y < 0.19 && Math.abs(x - ${geo.bumpX}) <= 1.01`);
  expect(bump.length).toBeGreaterThan(0);
  const offs = bump.map((v) => Math.abs(v.z));
  expect(Math.min(...offs)).toBeGreaterThanOrEqual(MEDIAN_HALF - 1e-3);
  expect(Math.max(...offs)).toBeCloseTo(CURB_HALF, 2);
  expect(bump.some((v) => v.z > 0) && bump.some((v) => v.z < 0)).toBe(true);

  // Screenshots: the median from eye level, the bump and junction from above, city view, night.
  await page.keyboard.press('1');
  await hook(page, `h.lookAt(${geo.bumpX + 45}, 1.7, 6.2, ${geo.bumpX - 60}, -1.5)`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7c2-eye.png' });
  await hook(page, `h.lookAt(${geo.bumpX - 18}, 34, 42, ${geo.bumpX - 4}, 0)`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-results/p7c2-bump.png' });
  await hook(page, `h.lookAt(${geo.crossX + 40}, 70, 70, ${geo.crossX + 50}, 0)`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-results/p7c2-junction.png' });
  await page.locator('[data-view="city"]').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7c2-city.png' });
  const render = await hook<{ drawCalls: number; triangles: number }>(page, 'h.perf.stats()');
  console.log(`p7c2 city view: ${JSON.stringify(render)}`);

  await hook(page, 'h.perf.setDayTime(22 * 3600)');
  await hook(page, `h.lookAt(${geo.bumpX + 45}, 1.7, 6.2, ${geo.bumpX - 60}, -1.5)`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7c2-night.png' });
  await page.locator('[data-view="city"]').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7c2-night-city.png' });
  await hook(page, 'h.perf.setDayTime(null)');
  expect(errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket/i.test(e))).toEqual([]);
});
