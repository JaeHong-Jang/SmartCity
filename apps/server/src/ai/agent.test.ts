import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { applyCommand, buildingFootprints, cloneJson, createEmptyDoc, polygonsOverlap, type CityDoc, type Command } from '@smartcity/shared';
import { AgentError, runAgent } from './agent.js';
import { AiGate } from './gate.js';
import { scriptedModel, type AiModel, type ModelRequest } from './model.js';
import { newSandbox, runTool } from './tools.js';

/** Two crossing 200 m roads and a house in the north-east corner. */
function town(): CityDoc {
  const doc = createEmptyDoc('ai', 3);
  const cmds: Command[] = [
    { type: 'node.add', node: { id: 'w', pos: { x: -100, z: 0 } } },
    { type: 'node.add', node: { id: 'e', pos: { x: 100, z: 0 } } },
    { type: 'node.add', node: { id: 'n', pos: { x: 0, z: -100 } } },
    { type: 'node.add', node: { id: 's', pos: { x: 0, z: 100 } } },
    { type: 'node.add', node: { id: 'c', pos: { x: 0, z: 0 } } },
    { type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'E', a: 'c', b: 'e', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'N', a: 'n', b: 'c', roadTypeId: 'road-2' } },
    { type: 'segment.add', segment: { id: 'S', a: 'c', b: 's', roadTypeId: 'road-2' } },
    { type: 'building.place', building: { id: 'house1', typeId: 'house', pos: { x: 30, z: -15 }, rotation: 0 } },
  ];
  expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
  return doc;
}

const msg = (content: unknown[], stop: string, out = 10): Anthropic.Beta.BetaMessage =>
  ({ content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: out } }) as unknown as Anthropic.Beta.BetaMessage;
const use = (name: string, input: unknown, id = name) => ({ type: 'tool_use', id, name, input });

/** Model that replays fixed replies and records what it was sent. */
function replay(replies: Anthropic.Beta.BetaMessage[]): AiModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return {
    name: 'replay',
    seen,
    send: async (req) => {
      seen.push(cloneJson(req));
      return replies[Math.min(seen.length - 1, replies.length - 1)]!;
    },
  };
}

const base = (doc: CityDoc, model: AiModel) => ({ model, doc, text: '카페 거리 만들어줘', focus: { x: 20, z: 20 }, tag: 't1', zoneLots: null, signal: new AbortController().signal });

describe('AI building assistant', () => {
  it('proposes a new design and buildings that apply cleanly to the real doc, without touching it', async () => {
    const doc = town();
    const before = JSON.stringify(doc);
    const res = await runAgent(base(doc, scriptedModel()));
    expect(JSON.stringify(doc)).toBe(before);
    expect(res.commands.map((c) => c.type)).toEqual(['buildingType.upsert', 'building.place', 'building.place', 'building.place']);
    expect(res.summary).toMatch(/카페/);
    // Applied as a user batch on the live doc: valid, and the new buildings overlap nothing.
    expect(applyCommand(doc, { type: 'batch', commands: res.commands })).toEqual({ ok: true });
    const placed = res.commands.flatMap((c) => (c.type === 'building.place' ? [c.building] : []));
    for (const b of placed) {
      expect(b.id.startsWith('ai-t1-')).toBe(true);
      const mine = buildingFootprints(b, doc.buildingTypes[b.typeId]!);
      for (const o of Object.values(doc.buildings)) {
        if (o.id === b.id) continue;
        const other = buildingFootprints(o, doc.buildingTypes[o.typeId]!);
        expect(mine.some((p) => other.some((q) => polygonsOverlap(p, q)))).toBe(false);
      }
    }
  });

  it('returns tool errors to the model, which can correct itself', async () => {
    const model = replay([
      msg([use('place_buildings', { items: [{ type_id: 'nope', x: 0, z: 0, rotation_deg: 0 }] }, 'a')], 'tool_use'),
      msg([use('place_buildings', { items: [{ type_id: 'house', x: 0, z: 0, rotation_deg: 0 }] }, 'b')], 'tool_use'),
      msg([use('finish', { summary: '고쳤어요' }, 'c')], 'tool_use'),
    ]);
    const res = await runAgent(base(town(), model));
    const r1 = model.seen[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(r1[0]!.content).toMatch(/unknown design/);
    // The road crossing is no place for a house: refused by the same checks as a user placement.
    const r2 = model.seen[2]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(r2[0]!.content).toMatch(/road/);
    expect(res.commands).toEqual([]);
    expect(res.summary).toBe('고쳤어요');
  });

  it('enforces turn, token and cancellation limits', async () => {
    const loop = replay([msg([use('get_city_overview', {})], 'tool_use')]);
    await expect(runAgent({ ...base(town(), loop), limits: { maxTurns: 3, maxInputTokens: 1e9, maxOutputTokens: 1e9, maxMillis: 1e9 } })).rejects.toThrow(AgentError);
    expect(loop.seen.length).toBe(3);

    const hungry = replay([msg([use('get_city_overview', {})], 'tool_use', 50_000)]);
    await expect(runAgent({ ...base(town(), hungry), limits: { maxTurns: 10, maxInputTokens: 1e9, maxOutputTokens: 40_000, maxMillis: 1e9 } })).rejects.toThrow(/한도/);
    // Checked right after the turn that crossed it: no further model call.
    expect(hungry.seen.length).toBe(1);

    const ac = new AbortController();
    ac.abort();
    await expect(runAgent({ ...base(town(), loop), signal: ac.signal })).rejects.toThrow(/취소/);
  });

  it('stops on refusal and on truncated output instead of running tools', async () => {
    await expect(runAgent(base(town(), replay([msg([], 'refusal')])))).rejects.toThrow(/처리할 수 없/);
    await expect(runAgent(base(town(), replay([msg([use('place_buildings', { items: [] })], 'max_tokens')])))).rejects.toThrow(/길어/);
  });

  it('validates untrusted tool inputs and bounds the work before doing it', () => {
    const sb = newSandbox(town(), 't2', null, null);
    expect(runTool(sb, 'find_spots', { x: null, z: null, near_building: null, near_road: null, width: 12, depth: 10, count: 999 }).content).toMatch(/count/);
    const huge = { name: '탑', zone: 'office', roof: 'flat', blocks: [{ x: -16, y: 0, z: -16, w: 32, d: 32, h: 30, color: '#888888' }] };
    expect(runTool(sb, 'create_building_design', huge).content).toMatch(/too many cells/);
    expect(runTool(sb, 'create_building_design', { ...huge, blocks: [{ x: 0, y: 0, z: 0, w: 2, d: 2, h: 1, color: 'red' }] }).content).toMatch(/#rrggbb/);
    expect(runTool(sb, 'zone_along_road', { segment_id: 'E', side: 'left', zone: 'commercial', depth: 2 }).isError).toBe(true);
    expect(runTool(sb, 'nope', {}).isError).toBe(true);
    expect(sb.commands).toEqual([]);
  });

  it('finds spots that face the road and keep clear of roads and buildings', () => {
    const doc = town();
    const sb = newSandbox(doc, 't3', { x: 40, z: -20 }, null);
    const out = JSON.parse(runTool(sb, 'find_spots', { x: null, z: null, near_building: null, near_road: null, width: 14, depth: 12, count: 6 }).content) as {
      spots: { x: number; z: number; rotation_deg: number }[];
    };
    expect(out.spots.length).toBe(6);
    const probe = { ...doc.buildingTypes['shop']!, parts: [{ ...doc.buildingTypes['shop']!.parts[0]!, width: 14, depth: 12 }] };
    const test = cloneJson(doc);
    test.buildingTypes['probe'] = probe;
    out.spots.forEach((s, i) => {
      const r = applyCommand(test, { type: 'building.place', building: { id: `p${i}`, typeId: 'probe', pos: { x: s.x, z: s.z }, rotation: (s.rotation_deg * Math.PI) / 180 } });
      expect(r).toEqual({ ok: true });
    });
    const house = buildingFootprints(doc.buildings['house1']!, doc.buildingTypes['house']!);
    for (const s of out.spots) {
      const fp = buildingFootprints({ pos: { x: s.x, z: s.z }, rotation: (s.rotation_deg * Math.PI) / 180 }, probe);
      expect(fp.some((p) => house.some((q) => polygonsOverlap(p, q)))).toBe(false);
    }
  });
});

describe('AI gate (server-wide cost limits)', () => {
  it('limits concurrency, one job per room, per-IP and per-hour requests', () => {
    let t = 0;
    const g = new AiGate({ maxConcurrent: 2, perHour: 4, perIpWindowMs: 1000, perIpMax: 2 }, () => t);
    const a = g.admit('1.1.1.1', 'r1');
    expect(a.ok).toBe(true);
    expect(g.admit('2.2.2.2', 'r1')).toMatchObject({ ok: false, reason: expect.stringMatching(/이미/) });
    const b = g.admit('2.2.2.2', 'r2');
    expect(b.ok).toBe(true);
    expect(g.admit('3.3.3.3', 'r3')).toMatchObject({ ok: false, reason: expect.stringMatching(/바쁩/) });
    if (a.ok) a.release();
    if (a.ok) a.release(); // idempotent
    const c = g.admit('1.1.1.1', 'r1');
    expect(c.ok).toBe(true);
    if (c.ok) c.release();
    if (b.ok) b.release();
    // 1.1.1.1 has used its 2 requests in the window.
    expect(g.admit('1.1.1.1', 'r1')).toMatchObject({ ok: false, reason: expect.stringMatching(/잦/) });
    expect(g.admit('4.4.4.4', 'r4').ok).toBe(true);
    // 4 requests this hour: the server-wide cap applies to everyone, even after the IP window passes.
    t = 2000;
    expect(g.admit('5.5.5.5', 'r5')).toMatchObject({ ok: false, reason: expect.stringMatching(/시간당/) });
    t = 3_600_001;
    expect(g.admit('5.5.5.5', 'r5').ok).toBe(true);
  });
});

describe('AI protocol messages', () => {
  it('parses ai.ask / ai.cancel and rejects malformed or oversized requests', async () => {
    const { parseClientMessage, MAX_AI_TEXT } = await import('@smartcity/shared');
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 1, text: '  카페  ', focus: { x: 1, z: 2 } }))).toEqual({ t: 'ai.ask', reqId: 1, text: '카페', focus: { x: 1, z: 2 } });
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 2, text: '공원', focus: null }))).toEqual({ t: 'ai.ask', reqId: 2, text: '공원', focus: null });
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 3, text: '   ', focus: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 4, text: 'x'.repeat(MAX_AI_TEXT + 1), focus: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 1.5, text: 'a', focus: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 5, text: 'a', focus: { x: 'a', z: 1 } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'ai.cancel', reqId: 5 }))).toEqual({ t: 'ai.cancel', reqId: 5 });
  });
});

describe('Sol 3b review fixes (AI)', () => {
  it('#3 the deadline aborts a hanging model call, reports it and frees the slot', async () => {
    const { AiService } = await import('./service.js');
    let sawAbort = false;
    const hang: AiModel = {
      name: 'hang',
      send: (_req, signal) =>
        new Promise((_, rej) =>
          signal.addEventListener('abort', () => {
            sawAbort = true;
            rej(new Error('aborted'));
          }),
        ),
    };
    const svc = new AiService(hang, new AiGate({ maxConcurrent: 1, perHour: 100, perIpWindowMs: 1000, perIpMax: 100 }), { maxTurns: 5, maxInputTokens: 1e9, maxOutputTokens: 1e9, maxMillis: 30 });
    const got: unknown[] = [];
    const client = { id: 'c1', send: (m: unknown) => got.push(m) };
    svc.ask({ id: 'r', doc: town() }, client, 'ip', 1, '카페', null);
    await new Promise((r) => setTimeout(r, 80));
    expect(sawAbort).toBe(true);
    expect(got).toContainEqual({ t: 'ai.error', reqId: 1, error: expect.stringMatching(/오래/) });
    // Slot is free again: a new request is admitted (and times out the same way).
    svc.ask({ id: 'r2', doc: town() }, { id: 'c2', send: (m: unknown) => got.push(m) }, 'ip', 2, '카페', null);
    expect(got.some((m) => (m as { t: string; reqId: number }).reqId === 2 && /바쁩/.test(JSON.stringify(m)))).toBe(false);
  });

  it('#4 budgets are checked before a finish or a plain answer is accepted', async () => {
    const big = replay([msg([use('finish', { summary: '끝' })], 'tool_use', 50_000)]);
    await expect(runAgent({ ...base(town(), big), limits: { maxTurns: 5, maxInputTokens: 1e9, maxOutputTokens: 40_000, maxMillis: 1e9 } })).rejects.toThrow(/한도/);
    // The next call only gets what is left of the output budget.
    const two = replay([msg([use('get_city_overview', {})], 'tool_use', 30_000), msg([use('finish', { summary: '끝' })], 'tool_use', 100)]);
    await runAgent({ ...base(town(), two), limits: { maxTurns: 5, maxInputTokens: 1e9, maxOutputTokens: 40_000, maxMillis: 1e9 } });
    expect(two.seen.map((r) => r.maxTokens)).toEqual([16000, 10000]);
  });

  it('#5 the 200-command proposal limit counts commands inside batches', () => {
    const lots = (n: number): Command => ({ type: 'batch', commands: Array.from({ length: n }, () => ({ type: 'meta.update', name: 'x' }) as Command) });
    const sb = newSandbox(town(), 't5', null, () => lots(150));
    expect(runTool(sb, 'zone_along_road', { segment_id: 'E', side: 'left', zone: 'commercial', depth: 2 }).isError).toBe(false);
    expect(runTool(sb, 'zone_along_road', { segment_id: 'W', side: 'left', zone: 'commercial', depth: 2 }).content).toMatch(/proposal is full/);
    expect(sb.leaves).toBe(150);
  });

  it('#6 SC_AI_MAX_PER_HOUR sets the server-wide hourly cap', async () => {
    const { AiService } = await import('./service.js');
    expect(AiService.fromEnv({ ANTHROPIC_API_KEY: 'dummy', SC_AI_MAX_PER_HOUR: '5' }).gateLimits.perHour).toBe(5);
    expect(AiService.fromEnv({ ANTHROPIC_API_KEY: 'dummy', SC_AI_MAX_PER_HOUR: 'lots' }).gateLimits.perHour).toBe(60);
  });
});

describe('Sol 3b recheck #10', () => {
  it('cancel and disconnect free the slot even when the model call never settles', async () => {
    const { AiService } = await import('./service.js');
    const never: AiModel = { name: 'never', send: () => new Promise(() => {}) };
    for (const how of ['cancel', 'drop'] as const) {
      const svc = new AiService(never, new AiGate({ maxConcurrent: 1, perHour: 100, perIpWindowMs: 1000, perIpMax: 100 }), { maxTurns: 5, maxInputTokens: 1e9, maxOutputTokens: 1e9, maxMillis: 10_000 });
      const got: { t: string; reqId?: number; error?: string }[] = [];
      svc.ask({ id: 'r1', doc: town() }, { id: 'c1', send: (m) => got.push(m as never) }, 'ip', 1, '카페', null);
      if (how === 'cancel') svc.cancel('c1', 1);
      else svc.drop('c1');
      svc.ask({ id: 'r2', doc: town() }, { id: 'c2', send: (m) => got.push(m as never) }, 'ip', 2, '공원', null);
      expect(got.filter((m) => m.reqId === 2 && m.t === 'ai.error')).toEqual([]);
      svc.drop('c2');
    }
  });
});
