import { expect, test, type Page } from '@playwright/test';

// Phase 5c: building placement is smooth and snaps to curved roads. The command always carries the
// target pose (not the eased ghost), and T-hold turns the building continuously.

interface HookDoc {
  segments: Record<string, { a: string; b: string; control?: { x: number; z: number } }>;
  nodes: Record<string, { pos: { x: number; z: number } }>;
  buildings: Record<string, { id: string; pos: { x: number; z: number }; rotation: number }>;
}
interface CityHook {
  store: { getState(): { doc: HookDoc; toolOptions: { buildingRotation: number; snapStep: number }; toolHint: string } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const screen = (page: Page, x: number, z: number) => page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __smartcity: CityHook }).__smartcity.store.getState();
    return JSON.parse(JSON.stringify({ doc: s.doc, opts: s.toolOptions, hint: s.toolHint })) as { doc: HookDoc; opts: { buildingRotation: number }; hint: string };
  });

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

async function moveWorld(page: Page, x: number, z: number, steps = 6) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps });
}

async function start(page: Page) {
  await page.goto(`/?room=e2e-5c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await page.evaluate(() => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(0, 330, 230, 0, -40));
  await page.waitForTimeout(400);
}

test('phase 5c: a building next to a curved road aligns to the arc-length secant', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1');
  await start(page);
  // Curved road: start, control, end.
  await page.locator('[data-tool="road"]').click();
  await page.keyboard.press('c');
  await clickWorld(page, -120, 0);
  await clickWorld(page, 0, 100);
  await clickWorld(page, 120, 0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => Object.keys((await state(page)).doc.segments).length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

  await page.keyboard.press('3');
  // A point on the curve at t = 0.25 and a spot 14 m beside it, on the outer (convex) side.
  const t = 0.25;
  const px = -120 + 240 * t;
  const pz = 2 * t * (1 - t) * 100;
  const tan = { x: 240, z: 200 * (1 - 2 * t) };
  const tl = Math.hypot(tan.x, tan.z);
  const n = { x: -tan.z / tl, z: tan.x / tl };
  await moveWorld(page, px + n.x * 14, pz + n.z * 14, 10);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/placement-curve.png' });
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => Object.keys((await state(page)).doc.buildings).length, { timeout: 5000 }).toBe(1);

  const { doc } = await state(page);
  const b = Object.values(doc.buildings)[0]!;
  const seg = Object.values(doc.segments)[0]!;
  expect(seg.control).toBeTruthy();
  // Local tangent of the curve at the point nearest the building.
  const a = doc.nodes[seg.a]!.pos;
  const e = doc.nodes[seg.b]!.pos;
  const c = seg.control!;
  const at = (u: number) => ({ x: (1 - u) ** 2 * a.x + 2 * u * (1 - u) * c.x + u * u * e.x, z: (1 - u) ** 2 * a.z + 2 * u * (1 - u) * c.z + u * u * e.z });
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const p = at(i / 1000);
    const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
    if (d < bestD) [best, bestD] = [i / 1000, d];
  }
  const p0 = at(Math.max(0, best - 0.001));
  const p1 = at(Math.min(1, best + 0.001));
  const tl2 = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const tangent = { x: (p1.x - p0.x) / tl2, z: (p1.z - p0.z) / tl2 };
  const front = { x: Math.sin(b.rotation), z: Math.cos(b.rotation) };
  // Front is perpendicular to the road direction (secant within a few degrees of the tangent) and points at it.
  expect(Math.abs(front.x * tangent.x + front.z * tangent.z)).toBeLessThan(0.12);
  const toRoad = { x: at(best).x - b.pos.x, z: at(best).z - b.pos.z };
  expect(front.x * toRoad.x + front.z * toRoad.z).toBeGreaterThan(0);
  // And it is turned away from the flat default, following the 22° bend of the road there.
  expect(Math.abs(b.rotation)).toBeGreaterThan(0.2);
});

test('phase 5c: clicking right after a fast move commands the target, not the eased ghost', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1');
  await start(page);
  await page.keyboard.press('3');
  await moveWorld(page, 100, -146, 1);
  // No settling time: the 3D ghost is still far from where the click lands.
  const p = await screen(page, -98, -146);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => Object.keys((await state(page)).doc.buildings).length, { timeout: 5000 }).toBe(1);
  const b = Object.values((await state(page)).doc.buildings)[0]!;
  // Far from roads: free placement on the 8 m grid at the click point.
  expect(b.pos.x).toBeCloseTo(-96, 6);
  expect(b.pos.z).toBeCloseTo(-144, 6);
});

test('phase 5c: holding T and moving the mouse turns the building continuously', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1');
  await start(page);
  await page.keyboard.press('3');
  await moveWorld(page, 58, -146, 4);
  await page.waitForTimeout(150);
  await page.keyboard.down('t');
  await moveWorld(page, 81, -144, 8);
  await moveWorld(page, 56, -119, 8);
  await page.keyboard.up('t');
  const { opts } = await state(page);
  // Quarter-ish sweep around the anchor: 135° of travel, 15° steps.
  expect(opts.buildingRotation).toBeCloseTo((-135 * Math.PI) / 180, 1);
  await page.mouse.click((await screen(page, 56, -119)).x, (await screen(page, 56, -119)).y);
  await expect.poll(async () => Object.keys((await state(page)).doc.buildings).length, { timeout: 5000 }).toBe(1);
  const b = Object.values((await state(page)).doc.buildings)[0]!;
  expect(b.rotation).toBeCloseTo((-135 * Math.PI) / 180, 1);
  // Held-key state is clean: a stray mouse move afterwards does not keep turning.
  await moveWorld(page, 20, -119, 4);
  expect((await state(page)).opts.buildingRotation).toBeCloseTo(opts.buildingRotation, 9);
});
