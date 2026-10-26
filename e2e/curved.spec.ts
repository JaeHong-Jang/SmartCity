import { expect, test, type Page } from '@playwright/test';

// Phase 5d (ADR 0012 §4): rounded volumes. A round tower made in the building editor is placed in the
// city; the collision check follows the rounded outline (a road past the corner is allowed next to the
// round tower, refused next to the same square tower); the studio's per-volume radius is saved; and a
// client of another protocol version is told to reload instead of retrying.

interface HookPart {
  round?: number;
  width: number;
  depth: number;
}
interface HookDoc {
  buildingTypes: Record<string, { id: string; name: string; parts: HookPart[] }>;
  buildings: Record<string, { typeId: string; pos: { x: number; z: number } }>;
  segments: Record<string, { a: string; b: string }>;
  nodes: Record<string, { pos: { x: number; z: number } }>;
}
interface CityHook {
  store: { getState(): { doc: HookDoc } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const docOf = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __smartcity: CityHook }).__smartcity.store.getState().doc)) as HookDoc);
const screen = (page: Page, x: number, z: number) => page.evaluate(([x, z]) => (window as unknown as { __smartcity: CityHook }).__smartcity.worldToScreen(x!, z!), [x, z]);
const typeNamed = async (page: Page, name: string) => Object.values((await docOf(page)).buildingTypes).find((t) => t.name === name);

async function clickWorld(page: Page, x: number, z: number) {
  const p = await screen(page, x, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

async function lookAt(page: Page, px: number, py: number, pz: number, tx: number, tz: number) {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as { __smartcity: CityHook }).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(500);
}

const volume = (page: Page, label: string) => page.locator('.bp-volume label', { hasText: label }).locator('input');

/** Draw one straight road; returns how many segments the doc has afterwards. */
async function road(page: Page, a: [number, number], b: [number, number]): Promise<number> {
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, a[0], a[1]);
  await clickWorld(page, b[0], b[1]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  return Object.keys((await docOf(page)).segments).length;
}

/**
 * Hover the selected design with the building tool at a grid point (Shift = free placement, no road
 * alignment), report the tool's verdict (the ghost colour follows it), then click.
 */
async function tryPlace(page: Page, x: number, z: number): Promise<string> {
  await page.locator('button', { hasText: '배치하기' }).click();
  const p = await screen(page, x, z);
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.waitForTimeout(600);
  const hint = await page.evaluate(() => (window as unknown as { __smartcity: { store: { getState(): { toolHint: string } } } }).__smartcity.store.getState().toolHint);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(800);
  return hint;
}

test('phase 5d: a round tower from the editor, collision on its rounded outline, studio radius saved', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?room=e2e-5d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await lookAt(page, 80, 330, 160, 80, -60);

  // Building editor (precise mode): a 20 × 20 m, 10-floor volume made round with the preset button.
  await page.locator('[role="tab"]', { hasText: '건물' }).click();
  await page.locator('button', { hasText: '+ 새 설계' }).click();
  await page.locator('input[maxlength="80"]').fill('원형 타워');
  await volume(page, '폭(m)').fill('20');
  await volume(page, '깊이(m)').fill('20');
  await volume(page, '층수').fill('10');
  await page.locator('[data-round-circle]').click();
  await expect(page.locator('[data-round]')).toHaveValue('10');
  await page.locator('button.primary', { hasText: /^저장$/ }).click();
  await expect.poll(async () => (await typeNamed(page, '원형 타워'))?.parts[0]?.round, { timeout: 5000 }).toBe(10);

  // The same tower with square corners, as a copy.
  await page.locator('button', { hasText: '복제해서 새 설계로' }).first().click();
  await page.locator('input[maxlength="80"]').fill('사각 타워');
  await page.locator('[data-round]').fill('0');
  await page.locator('button.primary', { hasText: /^저장$/ }).click();
  await expect.poll(async () => !!(await typeNamed(page, '사각 타워')), { timeout: 5000 }).toBe(true);
  expect((await typeNamed(page, '사각 타워'))!.parts[0]).not.toHaveProperty('round');

  // Two 45° roads, each passing 17 m from where a tower will stand: road-2's surface (6 m half width)
  // starts 11 m out — past the circle (10 m) but over the square's corner (14.1 m).
  expect(await road(page, [-120, 64], [40, -96])).toBe(1);
  expect(await road(page, [40, 64], [200, -96])).toBe(2);
  const doc = await docOf(page);
  const sums = Object.values(doc.segments)
    .map((seg) => [doc.nodes[seg.a]!.pos, doc.nodes[seg.b]!.pos].map((p) => Math.round(p.x + p.z)))
    .sort((a, b) => a[0]! - b[0]!);
  expect(sums).toEqual([
    [-56, -56],
    [104, 104],
  ]);

  // The square tower 17 m from the second road: its corner is on the road, so the ghost is blocked.
  const squareHint = await tryPlace(page, 160, -80);
  expect(squareHint).toContain('도로와 겹쳐 배치할 수 없습니다');
  expect(Object.keys((await docOf(page)).buildings)).toHaveLength(0);
  await expect(page.locator('.toast', { hasText: '도로와 겹치거나' }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // The round tower at the same distance from the first road fits.
  await page.locator('.bp-designs button', { hasText: '원형 타워' }).click();
  const roundHint = await tryPlace(page, 0, -80);
  expect(roundHint).toContain('자유 배치');
  expect(roundHint).not.toContain('도로와 겹쳐');
  await expect.poll(async () => Object.keys((await docOf(page)).buildings).length, { timeout: 5000 }).toBe(1);
  const roundId = (await typeNamed(page, '원형 타워'))!.id;
  const placed = Object.values((await docOf(page)).buildings);
  expect(placed.map((b) => [b.typeId, b.pos])).toEqual([[roundId, { x: 0, z: -80 }]]);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/p5d-placed.png' });

  // Close-up of the round tower: windows spread evenly around the curved wall.
  await lookAt(page, 30, 26, -38, 0, -80);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/p5d-curved.png' });

  // Studio: select the volume and lower the radius to 4 m, save, reopen: the radius stays.
  await lookAt(page, 80, 330, 160, 80, -60);
  await page.locator('.bp-designs button', { hasText: '원형 타워' }).click();
  await page.locator('[data-studio-open]').click();
  await expect(page.locator('[data-studio]')).toBeVisible();
  if (await page.locator('[data-studio-guide-close]').isVisible()) await page.locator('[data-studio-guide-close]').click();
  await page.locator('[data-studio-tool="select"]').click();
  const canvas = page.locator('[data-studio] canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-studio-round]')).toBeEnabled({ timeout: 5000 });
  await expect(page.locator('[data-studio-round-value]')).toHaveText('10m');
  await page.locator('[data-studio-round]').fill('4');
  await expect(page.locator('[data-studio-round-value]')).toHaveText('4m');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/p5d-studio.png' });
  await page.locator('[data-studio-save]').click();
  await expect.poll(async () => (await typeNamed(page, '원형 타워'))?.parts[0]?.round, { timeout: 8000 }).toBe(4);
  await page.locator('[data-studio-close]').click();
  await expect(page.locator('[data-studio]')).toHaveCount(0);
  await page.locator('[data-studio-open]').click();
  if (await page.locator('[data-studio-guide-close]').isVisible()) await page.locator('[data-studio-guide-close]').click();
  await page.locator('[data-studio-tool="select"]').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-studio-round-value]')).toHaveText('4m', { timeout: 5000 });
  await page.locator('[data-studio-close]').click();
  expect(errors).toEqual([]);
});

test('phase 5d: a client of another protocol version is refused and asked to reload, without retrying', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the real server refuses the hello)');
  let hellos = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { t: string; protocol?: number };
      // Pretend to be an app from before rounded volumes (protocol 1).
      if (msg.t === 'hello') {
        hellos++;
        msg.protocol = 1;
      }
      server.send(JSON.stringify(msg));
    });
  });
  await page.goto(`/?room=e2e-5d-proto-${Date.now().toString(36)}`);
  await expect(page.locator('[data-connect-outdated]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-connect-outdated] h2')).toHaveText('앱을 새로고침하세요');
  await expect(page.locator('[data-connect-error]')).toContainText('앱을 새로고침하세요 — 버전이 다릅니다');
  await expect(page.locator('[data-connect-reload]')).toBeVisible();
  await expect(page.locator('[data-connect-retry]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/p5d-protocol.png' });
  await page.waitForTimeout(4000);
  expect(hellos).toBe(1);
});

// Sol P5d review #5: a tab already in the city whose reconnect lands on a server of another version.
test('phase 5d: a reconnect refused for protocol shows the reload notice and keeps the city, edits blocked', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the real server refuses the hello)');
  let old = false;
  let hellos = 0;
  const live: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    live.push(ws);
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { t: string; protocol?: number };
      if (msg.t === 'hello') {
        hellos++;
        // After the first session, the "server" is one of another version.
        if (old) msg.protocol = 1;
      }
      server.send(JSON.stringify(msg));
    });
  });
  await page.goto(`/?room=e2e-5d-reproto-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: CityHook }).__smartcity);
  await expect(page.locator('.badge')).toContainText('온라인', { timeout: 15_000 });
  await road(page, [-80, 0], [80, 0]);
  expect(Object.keys((await docOf(page)).segments)).toHaveLength(1);

  old = true;
  for (const ws of live.splice(0)) await ws.close();
  await expect(page.locator('[data-connect-outdated]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-connect-error]')).toContainText('앱을 새로고침하세요 — 버전이 다릅니다');
  const st = await page.evaluate(() => {
    const s = (window as unknown as { __smartcity: { store: { getState(): { ready: boolean; connection: string; doc: HookDoc } } } }).__smartcity.store.getState();
    return { ready: s.ready, connection: s.connection, segments: Object.keys(s.doc.segments).length };
  });
  // The city is still shown, and editing stays blocked (not online).
  expect(st).toEqual({ ready: true, connection: 'reconnecting', segments: 1 });
  const n = hellos;
  await page.waitForTimeout(4000);
  expect(hellos).toBe(n); // no retry loop
  await page.screenshot({ path: 'test-results/p5d-reconnect-protocol.png' });
});
