// P7a (ADR 0014 §2·§3): street trees and lamps along the sidewalks (clear of stops and sensors, updated
// when they are added), lamps lit at night, brick sidewalks, mountains on the horizon, and the editing
// grid visible on the paving while a placement tool is active (faint / off the paving with the select tool).
// Offline rooms only (no collaboration server). Screenshots: test-results/p7a-*.png.
// Run: E2E_WEB_PORT=5193 npx playwright test e2e/p7a-streetscape.spec.ts
import { expect, test, type Page } from '@playwright/test';

interface Stats {
  trees: number;
  lamps: number;
  chunks: number;
  lastRebuilt: number;
  drawn: { tree0: number; tree1: number; tree2: number; lamp0: number; lamp1: number; glow: number };
  glowVisible: boolean;
  night: number;
  quality: 'normal' | 'low';
  treeShadows: boolean;
  mountainRings: number;
}

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
const stats = (page: Page) => hook<Stats>(page, 'h.renderer.streetscapeStats()');
const near = (page: Page, x: number, z: number, r: number) => hook<{ trees: { x: number; z: number }[]; lamps: { x: number; z: number }[] }>(page, `h.renderer.streetscapeNear(${x}, ${z}, ${r})`);

async function screen(page: Page, x: number, z: number) {
  return hook<{ x: number; y: number }>(page, `h.worldToScreen(${x}, ${z})`);
}

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

/** Renders once and reads the luminance of the canvas pixels in a row of ±`half` px around world (x, y, z). */
async function rowAt(page: Page, x: number, y: number, z: number, half = 3): Promise<number[]> {
  return hook<number[]>(
    page,
    `(() => {
      const r = h.renderer;
      const cam = r.cam.camera;
      const canvas = r.renderer.domElement;
      const gl = r.renderer.getContext();
      const v = cam.position.clone().set(${x}, ${y}, ${z}).project(cam);
      const px = Math.floor(((v.x + 1) / 2) * canvas.width);
      const py = Math.floor(((1 - v.y) / 2) * canvas.height);
      r.renderer.render(r.scene, cam);
      const n = 2 * ${half} + 1;
      const out = new Uint8Array(4 * n);
      gl.readPixels(px - ${half}, canvas.height - 1 - py, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      const lum = [];
      for (let i = 0; i < n; i++) lum.push(0.2126 * out[4 * i] + 0.7152 * out[4 * i + 1] + 0.0722 * out[4 * i + 2]);
      return lum;
    })()`,
  );
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

test('a small city has street trees and lamps; city, street level and night views', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const room = `e2e-p7a-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await hook(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, { grid: 7, buildings: 120 })`);
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 30_000 }).toBe(120);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await expect.poll(async () => (await stats(page)).trees, { timeout: 15_000 }).toBeGreaterThan(300);
  const s = await stats(page);
  expect(s.lamps).toBeGreaterThan(80);
  // Mountains and the streetscape are in the scene.
  expect(await hook<boolean>(page, '!!h.renderer.scene.getObjectByName("mountains") && !!h.renderer.scene.getObjectByName("streetscape")')).toBe(true);

  await page.locator('[data-view="city"]').click();
  await page.waitForTimeout(2500);
  const city = await stats(page);
  expect(city.drawn.tree2 + city.drawn.tree1).toBeGreaterThan(100);
  await page.screenshot({ path: 'test-results/p7a-city.png' });

  await page.locator('[data-view="eye"]').click();
  await page.waitForTimeout(2500);
  const eye = await stats(page);
  // Street level: the nearest trees use the detailed model.
  expect(eye.drawn.tree0).toBeGreaterThan(4);
  expect(eye.drawn.lamp0).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/p7a-eye.png' });

  // Night: lamp heads light up and glow; by day the glow pass is not drawn.
  expect(eye.glowVisible).toBe(false);
  await hook(page, 'h.perf.setDayTime(22 * 3600)');
  await page.waitForTimeout(1200);
  const night = await stats(page);
  expect(night.night).toBeGreaterThan(0.9);
  expect(night.glowVisible).toBe(true);
  expect(night.drawn.glow).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/p7a-night-eye.png' });
  await page.locator('[data-view="city"]').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/p7a-night-city.png' });
  expect(errors).toEqual([]);
});

test('trees and lamps move out of the way of a new bus stop and sensor (only that chunk is rebuilt)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?offline=1&room=e2e-p7a-avoid-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await ready(page);
  await hook(page, 'h.lookAt(-150, 260, 250, 0, 0)');
  await page.waitForTimeout(300);
  // Two 4-lane roads crossing (their four halves in three 256 m chunks).
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-road-type="road-4"]').click();
  for (const [a, b] of [
    [[-144, 0], [144, 0]],
    [[0, -120], [0, 120]],
  ] as const) {
    await clickWorld(page, a[0], a[1]);
    await clickWorld(page, b[0], b[1]);
    await page.keyboard.press('Escape');
  }
  await expect.poll(async () => (await stats(page)).trees, { timeout: 10_000 }).toBeGreaterThan(40);
  const before = await stats(page);
  // The sidewalk on the +z side of the road z = 0 (a 4-lane road: curb at 7 m, trees 0.75 m in).
  const TREE_Z = 7.75;
  expect((await near(page, 96, TREE_Z, 12)).trees.length).toBeGreaterThan(0);

  // A bus line with a stop next to x = 96 on that side of the road (traffic toward −x).
  await page.locator('[data-tool="busLine"]').click();
  await clickWorld(page, 96, 4);
  await clickWorld(page, -96, -4);
  await page.keyboard.press('Enter');
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.busStops).length'), { timeout: 5000 }).toBe(2);
  const stop = await hook<{ x: number; z: number; side: number }>(
    page,
    `(() => {
      const doc = h.store.getState().doc;
      const st = Object.values(doc.busStops).find((s) => {
        const seg = doc.segments[s.segmentId];
        const g = h.renderer.roadNetwork.segments.get(s.segmentId);
        const p = g.centerline[0], q = g.centerline[g.centerline.length - 1];
        const x = p.x + (q.x - p.x) * s.t;
        return Math.abs(x - 96) < 12 && seg;
      });
      const g = h.renderer.roadNetwork.segments.get(st.segmentId);
      const p = g.centerline[0], q = g.centerline[g.centerline.length - 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const tx = (q.x - p.x) / len, tz = (q.z - p.z) / len;
      // Right normal of a → b is (−tz, tx); a forward stop is on the right side.
      const side = st.dir === 'forward' ? 1 : -1;
      return { x: p.x + (q.x - p.x) * st.t, z: p.z + (q.z - p.z) * st.t, side: side * Math.sign(tx) };
    })()`,
  );
  // Rebuilt on the next frame (slow under software GL): wait for the trees to go, then only the stops' chunks were redone.
  await expect.poll(async () => (await stats(page)).trees, { timeout: 10_000 }).toBeLessThan(before.trees);
  expect((await stats(page)).lastRebuilt).toBeLessThanOrEqual(2);
  const stopSide = await near(page, stop.x, stop.z + stop.side * TREE_Z, 8);
  expect(stopSide.trees).toEqual([]);
  // The other side of the road keeps its trees.
  expect((await near(page, stop.x, stop.z - stop.side * TREE_Z, 14)).trees.length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // A sensor on the other sidewalk at x = −60: no tree within 2.5 m of it.
  await page.locator('[data-tool="sensor"]').click();
  await clickWorld(page, -60, -8.25);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.sensors).length'), { timeout: 10_000 }).toBe(1);
  const pos = await hook<{ x: number; z: number }>(page, '(() => { const s = Object.values(h.store.getState().doc.sensors)[0]; return h.sensorProbe(s.id).pos; })()');
  await expect.poll(async () => (await near(page, pos.x, pos.z, 2.5)).trees.length, { timeout: 5000 }).toBe(0);
  expect((await stats(page)).lastRebuilt).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await hook(page, `h.lookAt(${stop.x - 30}, 9, ${stop.z + stop.side * 30}, ${stop.x + 10}, ${stop.z})`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/p7a-stop.png' });
});

test('the building tool shows the grid on paving and the snap point; the select tool keeps the paving clean', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?offline=1&room=e2e-p7a-grid-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('오프라인(단독 모드)');
  await ready(page);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await hook(page, 'h.lookAt(0, 70, 30, 0, 0)');
  await page.waitForTimeout(400);
  // A residential lot (paved) dragged with the parcel tool.
  await page.locator('[data-tool="parcel"]').click();
  const a = await screen(page, -40, -32);
  const b = await screen(page, 40, 32);
  await page.mouse.move(a.x, a.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.parcels).length'), { timeout: 5000 }).toBe(1);
  await expect.poll(() => hook<boolean>(page, 'h.renderer.scene.getObjectByName("paving-concrete").visible')).toBe(true);
  // Straight down onto the lot; the cursor far away (no snap highlight near the samples).
  await hook(page, 'h.lookAt(0, 90, 0.01, 0, 0)');
  await page.waitForTimeout(500);
  const away = await screen(page, -150, 0);
  const lineVsCell = async () => {
    // Across the x = 16 line vs. the middle of the cell next to it (same z, paving height).
    const line = Math.min(...(await rowAt(page, 16, 0.02, 4)));
    const cell = mean(await rowAt(page, 20, 0.02, 4));
    return cell - line;
  };

  await page.locator('[data-tool="building"]').click();
  await page.mouse.move(away.x, away.y);
  await page.waitForTimeout(400);
  const editing = await lineVsCell();
  expect(editing).toBeGreaterThan(5);

  // Snap step 8 m (default): light snap lines and the snapped grid point near the cursor.
  const c = await screen(page, 8.6, 7.4);
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(400);
  const dot = Math.max(...(await rowAt(page, 8, 0.02, 8)));
  const cellNear = mean(await rowAt(page, 12, 0.02, 4));
  expect(dot).toBeGreaterThan(cellNear + 20);
  await page.screenshot({ path: 'test-results/p7a-grid-building.png' });

  await page.keyboard.press('Escape');
  await page.locator('[data-tool="select"]').click();
  await page.mouse.move(away.x, away.y);
  await page.waitForTimeout(400);
  expect(Math.abs(await lineVsCell())).toBeLessThanOrEqual(2);
  await page.screenshot({ path: 'test-results/p7a-grid-select.png' });
});

test('graphics quality: 낮음 draws one mountain ring, nearer tree LODs and no tree shadows, remembered per browser', async ({ page }) => {
  test.setTimeout(180_000);
  const room = `e2e-p7a-q-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await page.evaluate(() => localStorage.removeItem('smartcity.render.quality'));
  await hook(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, { grid: 5, buildings: 40 })`);
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await expect.poll(async () => (await stats(page)).trees, { timeout: 15_000 }).toBeGreaterThan(100);
  await page.locator('[data-view="eye"]').click();
  await page.waitForTimeout(2500);
  const normal = await stats(page);
  expect(normal).toMatchObject({ quality: 'normal', treeShadows: true, mountainRings: 3 });
  await expect(page.locator('[data-quality]')).toHaveText('그래픽: 보통');

  await page.locator('[data-quality]').click();
  await expect(page.locator('[data-quality]')).toHaveText('그래픽: 낮음');
  await expect.poll(async () => (await stats(page)).quality).toBe('low');
  await page.waitForTimeout(500);
  const low = await stats(page);
  expect(low).toMatchObject({ treeShadows: false, mountainRings: 1 });
  expect(low.drawn.tree0 + low.drawn.tree1).toBeLessThan(normal.drawn.tree0 + normal.drawn.tree1);
  expect(await page.evaluate(() => localStorage.getItem('smartcity.render.quality'))).toBe('low');
  await page.screenshot({ path: 'test-results/p7a-quality-low.png' });

  // Remembered after a reload; the simulation is not involved (same doc, same traffic settings).
  await page.reload();
  await ready(page);
  await expect.poll(async () => (await stats(page)).quality).toBe('low');
  expect(await hook<string>(page, 'h.store.getState().quality')).toBe('low');
  await page.locator('[data-quality]').click();
  await expect.poll(async () => (await stats(page)).mountainRings).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem('smartcity.render.quality'))).toBe('normal');
});
