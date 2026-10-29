// P6a: tool/side panels fit between the top bar and the status bar and scroll inside (wheel = list,
// not camera zoom), right drag rotates the city camera (Shift+right / middle drag pans, a right tap
// still cancels the road tool), and the color palette sets volume colors through the usual save.
// Run: E2E_SERVER=1 E2E_WEB_PORT=5187 E2E_SERVER_PORT=8797 npx playwright test e2e/p6a-ui.spec.ts
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  store: {
    getState(): {
      doc: {
        segments: Record<string, { a: string; b: string }>;
        nodes: Record<string, { pos: { x: number; z: number } }>;
        buildings: Record<string, { typeId: string }>;
        buildingTypes: Record<string, { id: string; parts: { color: string; roofColor: string }[] }>;
      };
      toolOptions: { buildingTypeId: string };
    };
  };
  renderer: { cam: { controls: { azimuthAngle: number; distance: number } } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
  cameraTarget(): { x: number; z: number };
}

const H = 'window.__smartcity';
const hook = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const h = ${H}; return ${fn}; })()`) as Promise<T>;
const cam = (page: Page) => hook<{ az: number; dist: number; t: { x: number; z: number } }>(page, '({ az: h.renderer.cam.controls.azimuthAngle, dist: h.renderer.cam.controls.distance, t: h.cameraTarget() })');
const screen = (page: Page, x: number, z: number) => hook<{ x: number; y: number }>(page, `h.worldToScreen(${x}, ${z})`);
const segCount = (page: Page) => hook<number>(page, 'Object.keys(h.store.getState().doc.segments).length');

async function start(page: Page, height: number) {
  await page.setViewportSize({ width: 1280, height });
  await page.goto(`/?room=e2e-p6a-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  if (process.env.E2E_SERVER === '1') await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(0, 330, 230, 0, 0));
  await page.waitForTimeout(500);
}

/** Waits until the camera stops moving (damping is slow under software GL). */
async function settle(page: Page) {
  let prev = await cam(page);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const c = await cam(page);
    if (Math.abs(c.az - prev.az) < 1e-4 && Math.abs(c.t.x - prev.t.x) < 0.05 && Math.abs(c.t.z - prev.t.z) < 0.05) return c;
    prev = c;
  }
  return prev;
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

async function drag(page: Page, button: 'right' | 'middle', dx: number, dy: number) {
  const vp = page.viewportSize()!;
  const x = vp.width / 2;
  const y = vp.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 16 });
  await page.mouse.up({ button });
}

test('P6a panels: the building list fits a 700 px window, scrolls with the wheel and its last type can be placed', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, 700);
  await page.keyboard.press('3');
  const panel = page.locator('.tool-options');
  const list = panel.locator('.list');
  const status = await box(page.locator('.statusbar'));
  const items = list.locator('button');
  const count = await items.count();
  expect(count).toBeGreaterThan(20);

  // Fits above the status bar and scrolls inside.
  const pb = await box(panel);
  expect(pb.y + pb.height).toBeLessThanOrEqual(status.y);
  const overflow = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
  expect(overflow.oy).toBe('auto');
  expect(overflow.sh).toBeGreaterThan(overflow.ch);

  // The wheel over the list scrolls it; the camera does not zoom.
  const before = await cam(page);
  const lb = await box(list);
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  const scrolled = await list.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(scrolled.top).toBeGreaterThan(0);
  expect(scrolled.top).toBeGreaterThanOrEqual(scrolled.max - 2);
  expect(Math.abs((await cam(page)).dist - before.dist)).toBeLessThan(0.5);

  // The last type is fully visible inside the list and can be chosen and placed.
  const last = items.last();
  const lastBox = await box(last);
  const listBox = await box(list);
  expect(lastBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
  const lastId = (await last.getAttribute('data-building-type'))!;
  await last.click();
  expect(await hook<string>(page, 'h.store.getState().toolOptions.buildingTypeId')).toBe(lastId);
  await expect(last).toHaveClass(/active/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/p6a-panel-scroll.png' });
  const p = await screen(page, 40, 30);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.waitForTimeout(300);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => hook<string[]>(page, 'Object.values(h.store.getState().doc.buildings).map((b) => b.typeId)'), { timeout: 5000 }).toContain(lastId);

  // A tool change scrolls the chosen item back into view.
  await page.keyboard.press('2');
  await page.keyboard.press('3');
  await page.waitForTimeout(200);
  const active = await box(page.locator('.tool-options .list > .active'));
  const lb2 = await box(page.locator('.tool-options .list'));
  expect(active.y + active.height).toBeLessThanOrEqual(lb2.y + lb2.height + 1);

  // Right side panel (building editor) fits too and scrolls.
  await page.locator('.tabs button', { hasText: '건물' }).click();
  const side = await box(page.locator('.side'));
  expect(side.y + side.height).toBeLessThanOrEqual(status.y);
  const body = page.locator('.side-body');
  const sideScroll = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(sideScroll).toBe(true);
  // Right end of the editor's first row: the design list scrolls itself, the 3D preview zooms itself
  // (by design) and a placement toast may cover the left part.
  const sb = await box(body);
  const row = await box(body.locator('h3').first());
  await page.mouse.move(sb.x + sb.width - 30, row.y + row.height / 2);
  const d0 = (await cam(page)).dist;
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs((await cam(page)).dist - d0)).toBeLessThan(0.5);

  // A 600 px window: toolbar, tool panel and side panel all stay above the status bar.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(400);
  const status600 = await box(page.locator('.statusbar'));
  for (const sel of ['.toolbar', '.tool-options', '.side']) {
    const b = await box(page.locator(sel));
    expect(b.y + b.height, sel).toBeLessThanOrEqual(status600.y);
  }
  // The zoning tool (9) sits below the fold of the toolbar at this height: scroll to it and click.
  await page.locator('[data-tool="zoning"]').click();
  await expect(page.locator('.tool-options')).toHaveAttribute('aria-label', '조닝 도구 옵션');
  await page.keyboard.press('3');
  await page.screenshot({ path: 'test-results/p6a-small-600.png' });
});

test('P6a camera: right drag rotates, Shift+right and middle drag pan, a right tap still cancels the road', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, 700);
  const c0 = await settle(page);

  await drag(page, 'right', 220, 0);
  const c1 = await settle(page);
  expect(Math.abs(c1.az - c0.az)).toBeGreaterThan(0.3);
  expect(Math.hypot(c1.t.x - c0.t.x, c1.t.z - c0.t.z)).toBeLessThan(1);

  await page.keyboard.down('Shift');
  await drag(page, 'right', 200, 120);
  await page.keyboard.up('Shift');
  const c2 = await settle(page);
  expect(Math.abs(c2.az - c1.az)).toBeLessThan(0.01);
  expect(Math.hypot(c2.t.x - c1.t.x, c2.t.z - c1.t.z)).toBeGreaterThan(20);

  await drag(page, 'middle', -200, -100);
  const c3 = await settle(page);
  expect(Math.abs(c3.az - c2.az)).toBeLessThan(0.01);
  expect(Math.hypot(c3.t.x - c2.t.x, c3.t.z - c2.t.z)).toBeGreaterThan(20);
  await page.screenshot({ path: 'test-results/p6a-rotated.png' });

  // Road tool: a right tap cancels the started road; a right drag in the middle of a road does not.
  await page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(0, 330, 230, 0, 0));
  await settle(page);
  await page.keyboard.press('2');
  const segs0 = await segCount(page);
  const a = await screen(page, -100, 0);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await page.mouse.click(a.x, a.y);
  const b = await screen(page, 0, 0);
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-draw-label]')).toContainText(' m');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(b.x + 2, b.y + 1);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-draw-label]')).not.toContainText(' m');
  // Cancelled: the next click only starts a new road (no A–B segment).
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(600);
  expect(await segCount(page)).toBe(segs0);
  await page.keyboard.press('Escape');

  // Start again, turn the camera with a right drag mid-road, then finish: the road is still there.
  const a2 = await screen(page, -100, 40);
  await page.mouse.move(a2.x, a2.y, { steps: 4 });
  await page.mouse.click(a2.x, a2.y);
  await drag(page, 'right', 120, 0);
  await settle(page);
  const b2 = await screen(page, 60, 40);
  await page.mouse.move(b2.x, b2.y, { steps: 6 });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-draw-label]')).toContainText(' m');
  await page.mouse.click(b2.x, b2.y);
  await page.keyboard.press('Escape');
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBe(segs0 + 1);
  await page.screenshot({ path: 'test-results/p6a-road-after-rotate.png' });

  // Round trip (Sol P6a #1): a right drag 80 px out and back to where it was pressed is still a drag,
  // not a tap: the road in progress survives.
  const a3 = await screen(page, -100, -40);
  await page.mouse.move(a3.x, a3.y, { steps: 4 });
  await page.mouse.click(a3.x, a3.y);
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 80, cy, { steps: 8 });
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await settle(page);
  const b3 = await screen(page, 60, -40);
  await page.mouse.move(b3.x, b3.y, { steps: 6 });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-draw-label]')).toContainText(' m');
  await page.mouse.click(b3.x, b3.y);
  await page.keyboard.press('Escape');
  await expect.poll(() => segCount(page), { timeout: 5000 }).toBe(segs0 + 2);
});

test('P6a palette: swatch, HEX and recent colors change a volume through the normal save', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, 900);
  await page.evaluate(() => {
    try {
      localStorage.removeItem('smartcity:recentColors');
    } catch {
      // ignore
    }
  });
  await page.locator('.tabs button', { hasText: '건물' }).click();
  const id = await hook<string>(page, 'h.store.getState().toolOptions.buildingTypeId');
  const wall = page.locator('[data-color-trigger="벽 색"]');
  await wall.scrollIntoViewIfNeeded();
  await wall.click();
  const pop = page.locator('[data-color-pop]');
  await expect(pop).toBeVisible();
  const swatches = pop.locator('.color-grid').first().locator('button');
  expect(await swatches.count()).toBeGreaterThanOrEqual(24);
  const sw = await box(swatches.first());
  expect(sw.width).toBeGreaterThanOrEqual(22);
  expect(sw.height).toBeGreaterThanOrEqual(22);
  await expect(pop.locator('[data-swatch="#a5553f"]').first()).toHaveAttribute('title', /벽돌/);
  await page.screenshot({ path: 'test-results/p6a-palette.png' });
  await pop.locator('[data-swatch="#a5553f"]').first().click();
  await expect(pop).toBeHidden();
  await expect(wall).toHaveAttribute('aria-label', /#a5553f/);

  // HEX: an invalid value is refused with a message, a short form is normalized.
  const roof = page.locator('[data-color-trigger="지붕 색"]');
  await roof.click();
  const hex = pop.locator('[data-hex]');
  await hex.fill('zz12');
  await hex.press('Enter');
  await expect(pop.locator('.color-error')).toBeVisible();
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await hex.fill('#1A2');
  await hex.press('Enter');
  await expect(pop).toBeHidden();
  await expect(roof).toHaveAttribute('aria-label', /#11aa22/);

  // Keyboard: Enter opens with focus on the palette, Escape closes back to the button.
  await wall.focus();
  await page.keyboard.press('Enter');
  await expect(pop).toBeVisible();
  await expect(pop.locator('[data-swatch="#a5553f"]').first()).toBeFocused();
  await expect(pop.locator('[data-recent] [data-swatch="#a5553f"]')).toBeVisible();
  await expect(pop.locator('[data-recent] [data-swatch="#11aa22"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/p6a-palette-recent.png' });
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(wall).toBeFocused();

  // Tab past either end of the palette closes it, back on its button.
  await wall.click();
  await expect(pop).toBeVisible();
  await pop.locator('[data-hex]').focus();
  await page.keyboard.press('Tab');
  await expect(pop).toBeHidden();
  await expect(wall).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pop).toBeVisible();
  await pop.locator('.color-grid button').first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(pop).toBeHidden();

  // Keys held before the palette opened (Sol P6a #2): their release still reaches the camera and the
  // tools' window handlers, so W/Q stop and Shift/Control end.
  await page.evaluate(() => {
    const w = window as unknown as { __keyups: string[] };
    w.__keyups = [];
    window.addEventListener('keyup', (e) => w.__keyups.push(e.key));
  });
  for (const [key, moving] of [
    ['w', (a: Awaited<ReturnType<typeof cam>>, b: Awaited<ReturnType<typeof cam>>) => Math.hypot(b.t.x - a.t.x, b.t.z - a.t.z) > 0.5],
    ['q', (a: Awaited<ReturnType<typeof cam>>, b: Awaited<ReturnType<typeof cam>>) => Math.abs(b.az - a.az) > 0.005],
  ] as const) {
    // Close in, so a stuck W (pan speed ∝ distance) cannot reach the map boundary and stop there.
    await page.evaluate(() => (window as unknown as { __smartcity: Hook }).__smartcity.lookAt(0, 50, 35, 0, 0));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down(key);
    await page.waitForTimeout(300);
    await wall.click();
    await expect(pop).toBeVisible();
    await expect(pop.locator('.color-grid button.active, .color-grid button').first()).toBeVisible();
    const held0 = await cam(page);
    await page.waitForTimeout(300);
    expect(moving(held0, await cam(page)), `${key} moves the camera while held`).toBe(true);
    await page.keyboard.up(key);
    // Damping eases out first; a key still held would never settle.
    const r0 = await settle(page);
    await page.waitForTimeout(600);
    expect(moving(r0, await cam(page)), `${key} released inside the palette stops the camera`).toBe(false);
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
  }
  for (const key of ['Shift', 'Control']) {
    await page.keyboard.down(key);
    await wall.click();
    await expect(pop).toBeVisible();
    await page.keyboard.up(key);
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
  }
  expect(await page.evaluate(() => (window as unknown as { __keyups: string[] }).__keyups)).toEqual(expect.arrayContaining(['w', 'q', 'Shift', 'Control']));

  // Save: the command carries the picked colors.
  await page.locator('.side-body button.primary', { hasText: '저장' }).click();
  await expect
    .poll(() => hook<{ color: string; roofColor: string }>(page, `(({ color, roofColor }) => ({ color, roofColor }))(h.store.getState().doc.buildingTypes[${JSON.stringify(id)}].parts[0])`), { timeout: 5000 })
    .toEqual({ color: '#a5553f', roofColor: '#11aa22' });

  // Vehicle editor and bus lines use the same picker.
  await page.locator('.tabs button', { hasText: '차량' }).click();
  const vehicle = page.locator('[data-color-trigger="대표 색"]');
  await expect(vehicle).toBeVisible();
  await vehicle.click();
  await pop.locator('[data-swatch="#d62828"]').first().click();
  await expect(vehicle).toHaveAttribute('aria-label', /#d62828/);
});
