// AI roads e2e (scripted model: server runs with SC_AI_FAKE=1, the real Claude API is never called):
// ask for a road -> preview/review item -> apply -> the road count grows, the new road joins the old
// network (one connected component) and the applied result is highlighted.
import { expect, test, type Page } from '@playwright/test';

interface Seg {
  a: string;
  b: string;
}
interface Hook {
  store: { getState(): { doc: { segments: Record<string, Seg>; nodes: Record<string, unknown> }; highlights: { items: { roadSegmentIds: string[]; segmentIds: string[]; bbox: unknown }[] } } };
  renderer: { highlightStats(): { beacons: number; pulsingBuildings: number; lots: number; roads: number } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
}

const hook = (page: Page) => <T>(fn: (h: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__smartcity)`) as Promise<T>;

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as { __smartcity: Hook }).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

test('AI road: review item, apply, joined to the network and highlighted', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the AI assistant runs on the server)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const h = hook(page);

  await page.goto(`/?room=e2e-airoad-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await h((s) => s.lookAt(-40, 260, 260, 0, 20));
  await page.waitForTimeout(300);

  // One road to connect to.
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -180, 0);
  await clickWorld(page, 180, 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  const roadsBefore = await h((s) => Object.keys(s.store.getState().doc.segments).length);
  expect(roadsBefore).toBe(1);

  await page.locator('[role="tab"]', { hasText: 'AI' }).click();
  await expect(page.locator('[data-ai-panel]')).toBeVisible({ timeout: 5000 });
  await page.locator('textarea[aria-label="AI에게 요청"]').fill('이 동네에 도로 깔아줘');
  await page.locator('[data-ai-send]').click();
  await expect(page.locator('[data-ai-proposal]')).toBeVisible({ timeout: 20_000 });

  // The road is one review item, not a pile of nodes and segments.
  const items = page.locator('[data-ai-proposal] .ai-items li');
  await expect(items.filter({ hasText: /^도로 \d+ m \(연결 \d+, 분할 \d+\)/ })).toHaveCount(1);
  expect(await items.filter({ hasText: '건물:' }).count()).toBe(2);
  await expect(items.locator('small')).toHaveCount(0); // nothing in conflict
  // Nothing is built before approval.
  expect(await h((s) => Object.keys(s.store.getState().doc.segments).length)).toBe(roadsBefore);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/ai-road-preview.png' });

  await page.locator('[data-ai-apply]').click();
  await expect(page.locator('[data-ai-applied]')).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => h((s) => Object.keys(s.store.getState().doc.segments).length), { timeout: 5000 }).toBeGreaterThan(roadsBefore);

  // The whole road network is still one piece, and the new road is the AI's.
  const net = await h((s) => {
    const { segments } = s.store.getState().doc;
    const ids = Object.keys(segments);
    const adj = new Map<string, string[]>();
    for (const id of ids) {
      const { a, b } = segments[id]!;
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    }
    const start = segments[ids[0]!]!.a;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const n of adj.get(queue.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    return { nodes: adj.size, reached: seen.size, aiSegments: ids.filter((id) => id.startsWith('ai-')).length };
  });
  expect(net.aiSegments).toBeGreaterThanOrEqual(1);
  expect(net.reached).toBe(net.nodes);
  await expect.poll(async () => (await h((s) => s.renderer.highlightStats())).beacons, { timeout: 5000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/ai-road-applied.png' });
  expect(errors).toEqual([]);
});

test('AI road only: the applied road is highlighted (entry with segments, glow band, beacon)', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the AI assistant runs on the server)');
  test.setTimeout(240_000);
  const h = hook(page);
  await page.goto(`/?room=e2e-airoad2-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await h((s) => s.lookAt(-40, 260, 260, 0, 20));
  await page.waitForTimeout(300);
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -180, 0);
  await clickWorld(page, 180, 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');

  await page.locator('[role="tab"]', { hasText: 'AI' }).click();
  await page.locator('textarea[aria-label="AI에게 요청"]').fill('도로만 깔아줘');
  await page.locator('[data-ai-send]').click();
  await expect(page.locator('[data-ai-proposal]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-ai-proposal] .ai-items li')).toHaveCount(1);
  await page.locator('[data-ai-apply]').click();
  await expect(page.locator('[data-ai-applied]')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('[data-ai-applied] small')).toContainText('도로 1');

  const entry = await h((s) => s.store.getState().highlights.items.map((i) => ({ roads: i.roadSegmentIds.length, segs: i.segmentIds.length, hasBox: !!i.bbox })));
  expect(entry).toEqual([{ roads: 1, segs: 1, hasBox: true }]);
  await expect.poll(async () => (await h((s) => s.renderer.highlightStats())).roads, { timeout: 5000 }).toBeGreaterThan(0);
  expect((await h((s) => s.renderer.highlightStats())).beacons).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/ai-road-only-highlight.png' });
});
