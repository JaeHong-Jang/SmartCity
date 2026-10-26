// P5b road drawing controls (ADR 0012 §2): angle snap to an exact 45°, a tangent curve from a road's
// dead end, a free-hand S road (several connected pieces), a refused too-sharp stroke, Enter/double click.
// Run: E2E_SERVER=1 E2E_WEB_PORT=5186 E2E_SERVER_PORT=8796 npx playwright test e2e/drawing.spec.ts
import { expect, test, type Page } from '@playwright/test';

interface Seg {
  a: string;
  b: string;
  control?: { x: number; z: number };
}
interface Hook {
  store: {
    getState(): {
      doc: { segments: Record<string, Seg>; nodes: Record<string, { id: string; pos: { x: number; z: number } }> };
      toolHint: string;
    };
  };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.store.getState());
const screen = (page: Page, x: number, z: number) => page.evaluate(([x, z]) => (window as unknown as { __smartcity: Hook }).__smartcity.worldToScreen(x!, z!), [x, z]);
const segCount = async (page: Page) => Object.keys((await state(page)).doc.segments).length;

async function moveTo(page: Page, x: number, z: number, steps = 4) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps });
}

async function clickWorld(page: Page, x: number, z: number) {
  await moveTo(page, x, z);
  await page.waitForTimeout(60);
  const p = await screen(page, x, z);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(450);
}

/** Press, drag through the world points, release (free-hand strokes). */
async function dragWorld(page: Page, pts: [number, number][], release = true) {
  await moveTo(page, pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, z] of pts.slice(1)) await moveTo(page, x, z, 2);
  await page.waitForTimeout(200);
  if (release) await page.mouse.up();
}

test('P5b drawing: 45° angle snap, tangent curve, free S road, refused sharp stroke, Enter/double click', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket connection to .*\/ws.* failed/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`/?room=e2e-draw-${Date.now().toString(36)}`);
  if (process.env.E2E_SERVER === '1') await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(0, 420, 360, 0, 90));
  await page.waitForTimeout(500);
  await page.locator('[data-tool="road"]').click();
  await expect(page.locator('[data-road-mode="straight"]')).toHaveAttribute('aria-pressed', 'true');

  // 1) Angle snap: the end is pulled onto the 45° guide (the cursor is ~2 m off it).
  await clickWorld(page, -200, -40);
  await moveTo(page, -136, -102);
  await page.waitForTimeout(400);
  await expect(page.locator('[data-draw-label]')).toContainText('각도');
  await page.screenshot({ path: 'test-results/p5b-angle.png' });
  const p = await screen(page, -136, -102);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBe(1);
  await page.keyboard.press('Enter');
  const diag = await state(page).then((s) => {
    const seg = Object.values(s.doc.segments)[0]!;
    const a = s.doc.nodes[seg.a]!.pos;
    const b = s.doc.nodes[seg.b]!.pos;
    return { dx: b.x - a.x, dz: b.z - a.z };
  });
  expect(Math.abs(Math.abs(diag.dx) - Math.abs(diag.dz))).toBeLessThan(1e-9);
  expect(Math.abs(diag.dx)).toBeGreaterThan(40);

  // 2) Curve mode from a road's dead end: the curve leaves along the road (control on its line).
  await clickWorld(page, -200, 96);
  await clickWorld(page, -104, 96);
  await page.keyboard.press('Enter');
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBe(2);
  await page.keyboard.press('c');
  await expect(page.locator('[data-road-mode="curve"]')).toHaveAttribute('aria-pressed', 'true');
  await clickWorld(page, -104, 96);
  await moveTo(page, -40, 160);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/p5b-curve-preview.png' });
  await clickWorld(page, -40, 160);
  await page.keyboard.press('Enter');
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBe(3);
  const curve = Object.values((await state(page)).doc.segments).find((s) => s.control)!;
  expect(curve.control!.z).toBeCloseTo(96, 6);
  expect(curve.control!.x).toBeGreaterThan(-104);

  // 3) Free-hand S road: one stroke, several connected curve pieces.
  await page.keyboard.press('b');
  await expect(page.locator('[data-road-mode="free"]')).toHaveAttribute('aria-pressed', 'true');
  const s: [number, number][] = [];
  for (let i = 0; i <= 48; i++) s.push([-8 + i * 4, 200 + 44 * Math.sin((i / 48) * 2 * Math.PI)]);
  await dragWorld(page, s, false);
  await expect(page.locator('[data-draw-label]')).toContainText('자유 곡선');
  await page.screenshot({ path: 'test-results/p5b-free-preview.png' });
  await page.mouse.up();
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBeGreaterThanOrEqual(6);
  const free = await state(page).then((st) => {
    const segs = Object.values(st.doc.segments).filter((x) => x.control && st.doc.nodes[x.a]!.pos.z > 150);
    const deg = new Map<string, number>();
    for (const x of segs) for (const n of [x.a, x.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    return { pieces: segs.length, ends: [...deg.values()].filter((d) => d === 1).length };
  });
  expect(free.pieces).toBeGreaterThanOrEqual(3);
  expect(free.ends).toBe(2);

  // 4) A hairpin zig-zag is refused in the preview, with the reason; nothing is built.
  const before = await segCount(page);
  await dragWorld(
    page,
    [
      [-80, 10],
      [-50, 10],
      [-30, 10],
      [-50, 14],
      [-80, 18],
      [-50, 22],
      [-30, 26],
    ],
    false,
  );
  await expect(page.locator('[data-draw-label]')).toContainText(/곡선이 너무 급합니다|자기 자신과 교차/);
  await page.screenshot({ path: 'test-results/p5b-free-refused.png' });
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(await segCount(page)).toBe(before);

  // 5) Straight again: a double click ends the stroke (no duplicate point); Enter ends it too.
  await page.locator('[data-road-mode="straight"]').click();
  await clickWorld(page, 40, 24);
  const q = await screen(page, 120, 24);
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.dblclick(q.x, q.y);
  await page.waitForTimeout(500);
  expect(await segCount(page)).toBe(before + 1);
  expect((await state(page)).toolHint).toMatch(/^도로 시작점을 클릭하세요/);
  const nodesAt = await state(page).then((st) => Object.values(st.doc.nodes).filter((n) => Math.hypot(n.pos.x - 120, n.pos.z - 24) < 1).length);
  expect(nodesAt).toBe(1);
  await clickWorld(page, 40, 64);
  await clickWorld(page, 120, 64);
  await page.locator('[data-road-finish]').click();
  expect((await state(page)).toolHint).toMatch(/^도로 시작점을 클릭하세요/);
  expect(await segCount(page)).toBe(before + 2);

  await page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(-20, 260, 330, -20, 120));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/p5b-result.png' });
  expect(errors).toEqual([]);
});
