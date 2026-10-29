// P6c-1 (ADR 0013 §6): the camera frames the city once when entering a room that has one, the
// "도시 보기" / "눈높이 보기" buttons move it on demand, and collaborators' edits never move it.
// The city ground is paved where built up, and the zone colors are an overlay toggle.
// Run: E2E_SERVER=1 E2E_WEB_PORT=5194 E2E_SERVER_PORT=8804 npx playwright test e2e/p6c1-look.spec.ts
import { expect, test, type Page } from '@playwright/test';

interface Cam {
  t: { x: number; z: number };
  y: number;
  dist: number;
  polar: number;
}

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const cam = (page: Page) =>
  hook<Cam>(page, '({ t: h.cameraTarget(), y: h.renderer.cam.camera.position.y, dist: h.renderer.cam.controls.distance, polar: h.renderer.cam.controls.polarAngle })');
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);

/** Waits until the camera stops moving: unchanged over four samples (frames are slow under software GL). */
async function settle(page: Page): Promise<Cam> {
  await page.waitForTimeout(300);
  let prev = await cam(page);
  let still = 0;
  for (let i = 0; i < 80 && still < 4; i++) {
    await page.waitForTimeout(200);
    const c = await cam(page);
    const same = Math.abs(c.dist - prev.dist) < 0.05 && Math.abs(c.t.x - prev.t.x) < 0.05 && Math.abs(c.t.z - prev.t.z) < 0.05 && Math.abs(c.y - prev.y) < 0.05;
    still = same ? still + 1 : 0;
    prev = c;
  }
  return prev;
}

const CENTER = { x: 900, z: -600 };

test('frames a city once on entry; the view buttons frame it again and go to street level', async ({ page }) => {
  const room = `e2e-p6c1-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  // Empty city: the start camera looks at the origin from a modest height.
  const empty = await settle(page);
  expect(Math.hypot(empty.t.x, empty.t.z)).toBeLessThan(1);
  expect(empty.y).toBeLessThan(200);

  // A town away from the origin, then enter the room again.
  await hook(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, { grid: 5, buildings: 40, offset: ${JSON.stringify(CENTER)} })`);
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 30_000 }).toBe(40);
  const fitted = await settle(page);
  expect(Math.hypot(fitted.t.x - CENTER.x, fitted.t.z - CENTER.z)).toBeLessThan(40);
  // Low angle (≈19° above the horizon), not a map view from straight above.
  expect(fitted.polar).toBeGreaterThan((60 * Math.PI) / 180);
  await page.screenshot({ path: 'test-results/p6c1-look-entry.png' });

  // Paving: the built-up blocks are concrete; zone fill is off until toggled.
  const pave = await hook<{ paved: boolean; lawn: boolean }>(page, `(() => {
    const g = h.renderer.scene.getObjectByName('paving');
    return { paved: g.getObjectByName('paving-concrete').visible, lawn: g.getObjectByName('paving-lawn').visible };
  })()`);
  expect(pave.paved).toBe(true);
  await page.locator('[data-overlay="zones"]').click();
  await expect.poll(() => hook<boolean>(page, 'h.store.getState().overlays.zones')).toBe(true);
  await page.locator('[data-overlay="zones"]').click();

  // Looking elsewhere, then "도시 보기" comes back to the city.
  await hook(page, 'h.lookAt(-1500, 300, -1500, -1600, -1600)');
  await page.locator('[data-view="city"]').click();
  const city = await settle(page);
  expect(Math.hypot(city.t.x - CENTER.x, city.t.z - CENTER.z)).toBeLessThan(40);

  // "눈높이 보기": a few meters above the street, looking along a road.
  await page.locator('[data-view="eye"]').click();
  const eye = await settle(page);
  expect(eye.y).toBeLessThan(15);
  expect(eye.polar).toBeGreaterThan((80 * Math.PI) / 180);
  await page.screenshot({ path: 'test-results/p6c1-look-eye.png' });
});

test('a big city enters on its densest district; "도시 보기" again shows the whole city, and back', async ({ page }) => {
  const room = `e2e-p6c1-dist-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  // 9 × 9 roads, 120 m blocks: about 1 km across, larger than one district (600 m).
  await hook(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, { grid: 9, buildings: 300 })`);
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 30_000 }).toBe(300);
  const district = await settle(page);
  expect(district.polar).toBeGreaterThan((60 * Math.PI) / 180);
  // Downtown (the towers) is around the origin.
  expect(Math.hypot(district.t.x, district.t.z)).toBeLessThan(150);
  await expect(page.locator('[data-view="city"]')).toHaveAttribute('title', /한 번 더 누르면 도시 전체/);

  await page.locator('[data-view="city"]').click();
  const full = await settle(page);
  expect(full.dist).toBeGreaterThan(district.dist * 1.2);

  await page.locator('[data-view="city"]').click();
  const again = await settle(page);
  expect(Math.abs(again.dist - district.dist) / district.dist).toBeLessThan(0.02);

  // From anywhere else, the first press is the district view again.
  await hook(page, 'h.lookAt(-1500, 300, -1500, -1600, -1600)');
  await page.locator('[data-view="city"]').click();
  const back = await settle(page);
  expect(back.dist).toBeLessThan(full.dist * 0.85);
  expect(Math.hypot(back.t.x, back.t.z)).toBeLessThan(150);
});

/**
 * Renders once and reads two canvas pixels in the same column: the sky just above the horizon
 * (elevation ≈ 0.3°) and the ground ~5 km away (far past the fog end, inside the ground plane).
 */
async function horizonPixels(page: Page) {
  return hook<{ sky: number[]; ground: number[]; rows: number[] }>(
    page,
    `(() => {
      const r = h.renderer;
      const cam = r.cam.camera;
      const canvas = r.renderer.domElement;
      const gl = r.renderer.getContext();
      const fwd = new cam.position.constructor();
      cam.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      const row = (p) => {
        const v = p.clone().project(cam);
        return { x: Math.round(((v.x + 1) / 2) * canvas.width), y: Math.round(((1 - v.y) / 2) * canvas.height) };
      };
      const far = cam.position.clone().addScaledVector(fwd, 1e5);
      far.y = cam.position.y + 0.005 * 1e5;
      const s = row(far);
      const g = row(cam.position.clone().addScaledVector(fwd, 5000).setY(0));
      r.renderer.render(r.scene, cam);
      const read = (x, y) => {
        const px = new Uint8Array(4);
        gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      };
      return { sky: read(s.x, s.y), ground: read(g.x, g.y), rows: [s.y, g.y] };
    })()`,
  );
}

test('no seam where the sky meets the fully fogged ground, by day and by night', async ({ page }) => {
  await page.goto(`/?offline=1&room=e2e-p6c1-sky-${Date.now().toString(36)}`);
  await ready(page);
  // Low camera looking toward the horizon (polar ≈ 84°), from inside the buildable square.
  await hook(page, 'h.lookAt(0, 30, 300, 0, 0)');
  for (const [label, time] of [['day', 12], ['night', 22]] as const) {
    await hook(page, `h.perf.setDayTime(${time} * 3600)`);
    await page.waitForTimeout(800);
    const px = await horizonPixels(page);
    // Different rows (the ground sample is below the horizon), same color within 2/255 per channel.
    expect(px.rows[1]! - px.rows[0]!, label).toBeGreaterThan(4);
    for (let i = 0; i < 3; i++) expect(Math.abs(px.sky[i]! - px.ground[i]!), `${label} ${px.sky} vs ${px.ground}`).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `test-results/p6c1-look-horizon-${label}.png` });
  }
});

test("a collaborator's edits never move my camera", async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (two clients in one room)');
  const room = `e2e-p6c1-co-${Date.now().toString(36)}`;
  await page.goto(`/?room=${room}`);
  await expect(page.locator('.badge')).toContainText('온라인');
  await ready(page);
  const mine = await settle(page);

  const other = await page.context().newPage();
  await other.goto(`/?room=${room}`);
  await expect(other.locator('.badge')).toContainText('온라인');
  await ready(other);
  await hook(other, 'h.lookAt(-150, 260, 250, 0, 0)');
  await other.waitForTimeout(400);
  // The other client draws two roads (the first content of the room) through the road tool.
  await other.locator('[data-tool="road"]').click();
  for (const [a, b] of [[[-120, 0], [120, 0]], [[0, -100], [0, 100]]] as const) {
    for (const [x, z] of [a, b]) {
      const p = await hook<{ x: number; y: number }>(other, `h.worldToScreen(${x}, ${z})`);
      await other.mouse.move(p.x, p.y, { steps: 3 });
      await other.mouse.click(p.x, p.y);
      await other.waitForTimeout(150);
    }
    await other.keyboard.press('Escape');
  }
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(800);
  const still = await cam(page);
  expect(Math.abs(still.t.x - mine.t.x) + Math.abs(still.t.z - mine.t.z)).toBeLessThan(0.01);
  expect(Math.abs(still.dist - mine.dist)).toBeLessThan(0.01);

  // Re-entering frames the city (it has one now); later edits by the other client still do not move it.
  await page.reload();
  await expect(page.locator('.badge')).toContainText('온라인');
  await ready(page);
  const framed = await settle(page);
  expect(framed.polar).toBeGreaterThan((60 * Math.PI) / 180);
  const p = await hook<{ x: number; y: number }>(other, 'h.worldToScreen(-120, 80)');
  await other.mouse.click(p.x, p.y);
  const q = await hook<{ x: number; y: number }>(other, 'h.worldToScreen(120, 80)');
  await other.mouse.click(q.x, q.y);
  await other.keyboard.press('Escape');
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length'), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(800);
  const kept = await cam(page);
  expect(Math.abs(kept.t.x - framed.t.x) + Math.abs(kept.t.z - framed.t.z)).toBeLessThan(0.01);
  expect(Math.abs(kept.dist - framed.dist)).toBeLessThan(0.01);
  await other.close();
});
