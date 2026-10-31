import { expect, test, type Page } from '@playwright/test';

// Phase 8a (ADR 0015 §2, §6): the AI control room in simulator mode — agents with eye / brain / body colors,
// states and evidence; an accident, a fire and a closure → detection, dispatch, signal priority and re-route
// decisions in the log; picking a decision highlights its target on the map. The control room shares the
// screen with the existing simulator panels without overlapping them. Needs the collaboration server
// (E2E_SERVER=1).

interface Decision {
  seq: number;
  tick: number;
  agent: string;
  verdict: string;
  action: string;
  text: string;
  eventId: string | null;
  target: { kind: string; id: string; x: number; z: number } | null;
}
interface SimHook {
  store: { getState(): { phase: string; tick: number; control: { agents: { id: string; state: string }[]; decisions: Decision[]; total: number } | null; events: { kind: string; status: string }[] } };
  controlMark(): { shown: boolean; x: number; z: number; label: string };
}
interface CityHook {
  store: { getState(): { doc: { buildings: Record<string, { id: string; typeId: string; pos: { x: number; z: number } }>; sensors: Record<string, unknown> }; connection: string; simStatus: string } };
  simmode: SimHook;
  sensorProbe(id: string): { pos: { x: number; z: number }; yaw: number; covered: { x: number; z: number }[] } | null;
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
  cameraTarget(): { x: number; z: number };
}
type W = { __smartcity: CityHook };

const hook = <T>(page: Page, fn: (h: CityHook) => T) => page.evaluate((src) => new Function('h', `return (${src})(h)`)((window as unknown as W).__smartcity), fn.toString()) as Promise<T>;

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as W).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}
const lookAt = async (page: Page, px: number, py: number, pz: number, tx: number, tz: number) => {
  await page.evaluate(([a, b, c, d, e]) => (window as unknown as W).__smartcity.lookAt(a!, b!, c!, d!, e!), [px, py, pz, tx, tz]);
  await page.waitForTimeout(300);
};
const decisions = (page: Page) => hook(page, (h) => h.simmode.store.getState().control?.decisions ?? []);

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('phase 8a: AI control room — agents, decision log (detection, dispatch, signal priority, re-route), map highlight', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`/?room=e2e-p8a-${Date.now().toString(36)}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __smartcity?: CityHook }).__smartcity;
    return !!h && h.store.getState().connection === 'online' && h.store.getState().simStatus === 'ready';
  });
  await lookAt(page, -220, 380, 360, 0, 0);

  // A grid of 4-lane roads (signalized junctions), homes, shops, a fire station and a hospital.
  await page.locator('[data-tool="road"]').click();
  await page.locator('[data-road-type="road-4"]').click();
  for (const v of [-144, -48, 48, 144]) {
    await clickWorld(page, -192, v);
    await clickWorld(page, 192, v);
    await page.keyboard.press('Escape');
  }
  for (const v of [-144, -48, 48, 144]) {
    await clickWorld(page, v, -192);
    await clickWorld(page, v, 192);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('3');
  for (const [x, z] of [[-96, -125], [0, -125], [96, -30], [-96, 70], [0, 125], [-96, 30], [96, 125], [0, 30], [96, -100]] as const) await clickWorld(page, x, z);
  const place = async (type: string, x: number, z: number) => {
    await page.locator(`[data-building-type="${type}"]`).dispatchEvent('click');
    await clickWorld(page, x, z);
  };
  await place('svc-fire-station', -96, -80);
  await place('svc-hospital', 96, 80);
  await expect.poll(() => hook(page, (h) => Object.values(h.store.getState().doc.buildings).map((b) => b.typeId)), { timeout: 10_000 }).toEqual(expect.arrayContaining(['svc-fire-station', 'svc-hospital']));
  // One CCTV on the road z = −48 (the eye, A1).
  await page.keyboard.press('0');
  await lookAt(page, -60, 140, 40, 0, -48);
  await clickWorld(page, 0, -48 + 8.25);
  await expect.poll(() => hook(page, (h) => Object.keys(h.store.getState().doc.sensors).length), { timeout: 10_000 }).toBe(1);
  await page.keyboard.press('1');
  const probe = (await hook(page, (h) => h.sensorProbe(Object.keys(h.store.getState().doc.sensors)[0]!)))!;
  const accidentAt = probe.covered.reduce((a, b) => (Math.hypot(b.x - probe.pos.x - 40 * Math.cos(probe.yaw), b.z - probe.pos.z - 40 * Math.sin(probe.yaw)) < Math.hypot(a.x - probe.pos.x - 40 * Math.cos(probe.yaw), a.z - probe.pos.z - 40 * Math.sin(probe.yaw)) ? b : a));
  await page.waitForTimeout(1500);

  // ---- enter: the control room lists every agent with its role colors, state and evidence ----
  await page.locator('[data-simmode-enter]').click();
  await expect(page.locator('[data-simmode-ready]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-simmode-detection="sensors"]')).toHaveClass(/active/);
  const room = page.locator('[data-simmode-control]');
  await expect(room).toBeVisible();
  await expect(room.locator('[data-agent]')).toHaveCount(9);
  await expect(room.locator('[data-agent="A1"]')).toHaveAttribute('data-state', 'idle'); // sensors mode: the eye is on
  await expect(room.locator('[data-agent="A5"]')).toHaveAttribute('data-state', 'idle'); // 스마트 대응 ON
  for (const off of ['A2', 'A3', 'A6', 'A7', 'A8']) await expect(room.locator(`[data-agent="${off}"]`)).toHaveAttribute('data-state', 'off');
  await expect(room.locator('[data-agent="A1"] [data-role="eye"]')).toBeVisible();
  await expect(room.locator('[data-agent="A4"] [data-agent-evidence]')).toContainText('학술 · 성과 실측 [17]');
  await expect(room.locator('[data-agent="A3"] [data-agent-evidence]')).toContainText('P8b 예정');
  await page.screenshot({ path: 'test-results/p8a-1-room.png' });

  // Coexists with the simulator panels: no two of them overlap.
  const boxes = async () => {
    const out: [string, Box][] = [];
    for (const sel of ['.sim-banner', '.sim-panel', '.sim-control', '.sim-lock-note', '.sim-compare', '.statusbar']) {
      const l = page.locator(sel);
      if ((await l.count()) > 0 && (await l.first().isVisible())) out.push([sel, (await l.first().boundingBox())!]);
    }
    const bad: string[] = [];
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (overlap(out[i]![1], out[j]![1])) bad.push(`${out[i]![0]} × ${out[j]![0]}`);
    return bad;
  };
  expect(await boxes()).toEqual([]);

  // ---- an accident the CCTV covers, a fire, a closure on a busy road ----
  await page.locator('[data-simmode-event="accident"]').click();
  await page.locator('[data-simmode-param="duration"]').fill('60');
  await lookAt(page, accidentAt.x - 70, 130, accidentAt.z + 90, accidentAt.x, accidentAt.z);
  await clickWorld(page, accidentAt.x, accidentAt.z);
  await lookAt(page, -220, 380, 360, 0, 0);
  // The fire: the building farthest from the station (south-east); the closure: the west part of road z = 48.
  const far = (await hook(page, (h) => Object.values(h.store.getState().doc.buildings).filter((b) => !b.typeId.startsWith('svc-')))).sort((a, b) => b.pos.x + b.pos.z - (a.pos.x + a.pos.z))[0]!;
  await page.locator('[data-simmode-event="fire"]').click();
  await clickWorld(page, far.pos.x, far.pos.z);
  await page.locator('[data-simmode-event="closure"]').click();
  await page.locator('[data-simmode-param="duration"]').fill('60');
  await clickWorld(page, -96, 48);
  await expect(page.locator('[data-simmode-eventrow][data-status="ok"]')).toHaveCount(3);
  await page.locator('.speed button', { hasText: '4×' }).click();

  // ---- the decision log: detection (A1 sensor or A0 citizen report), dispatch and signal priority (A4), re-route (A5) ----
  const want = (d: Decision[]) => ({
    detect: d.some((x) => x.action === 'observe' && x.verdict === 'accepted' && (x.agent === 'A1' || x.agent === 'A0') && x.text.includes('사고')),
    dispatch: d.some((x) => x.agent === 'A4' && x.action === 'dispatch' && x.verdict === 'accepted'),
    signal: d.some((x) => x.agent === 'A4' && x.action === 'signal' && x.verdict === 'accepted'),
    reroute: d.some((x) => x.agent === 'A5' && x.action === 'reroute'),
  });
  const seen: Decision[] = [];
  await expect
    .poll(
      async () => {
        for (const d of await decisions(page)) if (!seen.some((s) => s.seq === d.seq)) seen.push(d);
        return want(seen);
      },
      { timeout: 150_000, intervals: [250] },
    )
    .toEqual({ detect: true, dispatch: true, signal: true, reroute: true });
  console.log('decisions:', JSON.stringify(seen.map((d) => `${d.tick} ${d.agent} ${d.verdict} ${d.text}`)));
  await page.locator('.speed button').first().click(); // pause: the log stays put for the clicks
  await expect(room.locator('[data-decision]').first()).toBeVisible();
  await expect(room.locator('[data-decision-agent="A4"]').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/p8a-2-log.png' });
  expect(await boxes()).toEqual([]);

  // ---- pick a decision: its target is highlighted on the map and the camera goes there ----
  const shown = new Set((await room.locator('[data-decision]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-decision'))))));
  const listed = (await decisions(page)).filter((d) => shown.has(d.seq));
  const pickOne = listed.filter((d) => d.target !== null).reverse().find((d) => d.agent === 'A4' && d.action === 'dispatch') ?? listed.filter((d) => d.target !== null).at(-1)!;
  const btn = room.locator(`[data-decision="${pickOne.seq}"]`);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(btn).toHaveClass(/active/);
  await expect.poll(() => hook(page, (h) => h.simmode.controlMark().shown)).toBe(true);
  const mark = await hook(page, (h) => h.simmode.controlMark());
  expect(mark.x).toBeCloseTo(pickOne.target!.x, 3);
  expect(mark.z).toBeCloseTo(pickOne.target!.z, 3);
  expect(mark.label).toContain(pickOne.agent);
  await expect(page.locator('[data-control-mark]')).toBeVisible();
  await expect.poll(async () => {
    const t = await hook(page, (h) => h.cameraTarget());
    return Math.hypot(t.x - pickOne.target!.x, t.z - pickOne.target!.z);
  }, { timeout: 5000 }).toBeLessThan(5);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/p8a-3-highlight.png' });

  // A signal-priority decision marks its junction.
  const sig = listed.filter((d) => d.agent === 'A4' && d.action === 'signal' && d.target !== null).at(-1);
  if (sig) {
    const b = room.locator(`[data-decision="${sig.seq}"]`);
    await b.scrollIntoViewIfNeeded();
    await b.click();
    await expect.poll(() => hook(page, (h) => h.simmode.controlMark().label)).toContain('우선신호');
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/p8a-4-signal.png' });
    // Picking it again clears the mark.
    await b.click();
    await expect.poll(() => hook(page, (h) => h.simmode.controlMark().shown)).toBe(false);
  }
  expect(errors).toEqual([]);
});
