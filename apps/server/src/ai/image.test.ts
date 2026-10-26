import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { applyCommand, cloneJson, createEmptyDoc, type CityDoc, type Command } from '@smartcity/shared';
import { runAgent } from './agent.js';
import { scriptedModel, type AiModel, type ModelRequest } from './model.js';
import { newSandbox, runTool, TOOLS } from './tools.js';

function town(): CityDoc {
  const doc = createEmptyDoc('ai', 3);
  const cmds: Command[] = [
    { type: 'node.add', node: { id: 'w', pos: { x: -100, z: 0 } } },
    { type: 'node.add', node: { id: 'e', pos: { x: 100, z: 0 } } },
    { type: 'segment.add', segment: { id: 'W', a: 'w', b: 'e', roadTypeId: 'road-2' } },
  ];
  expect(applyCommand(doc, { type: 'batch', commands: cmds })).toEqual({ ok: true });
  return doc;
}

const msg = (content: unknown[], stop: string): Anthropic.Beta.BetaMessage =>
  ({ content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } }) as unknown as Anthropic.Beta.BetaMessage;

const IMG = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
const run = (doc: CityDoc, model: AiModel, images?: (typeof IMG)[]) => ({
  model,
  doc,
  text: '이 이미지와 비슷한 건물을 설계해줘',
  ...(images ? { images } : {}),
  focus: { x: 0, z: 10 },
  tag: 't1',
  zoneLots: null,
  signal: new AbortController().signal,
});

describe('AI images', () => {
  it('puts the images before the text in the first user message', async () => {
    const seen: ModelRequest[] = [];
    const model: AiModel = {
      name: 'spy',
      send: async (req) => {
        seen.push(cloneJson(req));
        return msg([{ type: 'tool_use', id: 'f', name: 'finish', input: { summary: '됐어요' } }], 'tool_use');
      },
    };
    await runAgent(run(town(), model, [IMG, { ...IMG, mediaType: 'image/png' }]));
    const content = seen[0]!.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[];
    expect(content.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect(content[0]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: IMG.data });
    expect(content[2]!.text).toContain('비슷한 건물');
  });

  it('keeps a plain string first message without images', async () => {
    const seen: ModelRequest[] = [];
    const model: AiModel = { name: 'spy', send: async (req) => (seen.push(cloneJson(req)), msg([{ type: 'tool_use', id: 'f', name: 'finish', input: { summary: 'x' } }], 'tool_use')) };
    await runAgent(run(town(), model));
    expect(typeof seen[0]!.messages[0]!.content).toBe('string');
  });

  it('scripted model answers a picture with the glass office script', async () => {
    const doc = town();
    const res = await runAgent(run(doc, scriptedModel(), [IMG]));
    const design = res.commands.find((c) => c.type === 'buildingType.upsert');
    expect(design?.type === 'buildingType.upsert' && design.buildingType.name).toBe('AI 유리 오피스');
    expect(res.commands.some((c) => c.type === 'building.place')).toBe(true);
    expect(applyCommand(doc, { type: 'batch', commands: res.commands })).toEqual({ ok: true });
    const plain = await runAgent(run(town(), scriptedModel()));
    expect(plain.commands.find((c) => c.type === 'buildingType.upsert')).toMatchObject({ buildingType: { name: 'AI 벽돌 카페' } });
  });
});

describe('create_building_design facade and origin', () => {
  const block = { x: 0, y: 0, z: 0, w: 4, d: 4, h: 3, color: '#336699' };
  const make = (blocks: unknown[]) => {
    const sb = newSandbox(town(), 't', null, null);
    const r = runTool(sb, 'create_building_design', { name: 'T', zone: 'office', roof: 'flat', blocks });
    return { sb, r };
  };

  it('marks the design as made by the AI', () => {
    const { sb, r } = make([block]);
    expect(r.isError).toBe(false);
    const cmd = sb.commands[0]!;
    expect(cmd.type === 'buildingType.upsert' && cmd.buildingType.origin).toBe('ai');
    expect(Object.values(sb.doc.buildingTypes).find((t) => t.name === 'T')?.origin).toBe('ai');
  });

  it('applies roof color and facade per block', () => {
    const { sb } = make([
      { ...block, roof_color: '#112233', facade_style: 'curtain', window_ratio: 0.8, ground: 'lobby' },
      { ...block, x: 6, roof_color: null, facade_style: null, window_ratio: null, ground: null },
    ]);
    const t = Object.values(sb.doc.buildingTypes).find((x) => x.name === 'T')!;
    const glass = t.parts.find((p) => p.facade);
    expect(glass?.facade).toEqual({ style: 'curtain', windowRatio: 0.8, ground: 'lobby' });
    expect(glass?.roofColor).toBe('#112233');
    const plain = t.parts.find((p) => !p.facade);
    expect(plain?.roofColor).toBe('#5f646b');
  });

  it('rejects bad facade values with a readable error', () => {
    expect(make([{ ...block, facade_style: 'glass' }]).r.content).toMatch(/facade_style/);
    expect(make([{ ...block, window_ratio: 2 }]).r.content).toMatch(/window_ratio/);
    expect(make([{ ...block, ground: 'x', facade_style: 'grid' }]).r.content).toMatch(/ground/);
    expect(make([{ ...block, roof_color: 'red' }]).r.content).toMatch(/roof_color/);
  });
});

describe('tool schemas', () => {
  // The Messages API rejected `enum` next to a `type` array (400 "Enum value ... does not match
  // declared type"), found with a real call; nullable enums must be written as anyOf.
  it('never combine enum with a type array', () => {
    const bad: string[] = [];
    const walk = (s: unknown, path: string): void => {
      if (!s || typeof s !== 'object') return;
      const o = s as Record<string, unknown>;
      if (Array.isArray(o.type) && 'enum' in o) bad.push(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const t of TOOLS) walk(t.input_schema, t.name);
    expect(bad).toEqual([]);
  });
});

describe('create_building_design centering', () => {
  it('centers off-center blocks on the building origin', () => {
    const sb = newSandbox(town(), 't1', null, null);
    const block = { y: 0, w: 8, d: 6, h: 3, color: '#decdaa', roof_color: null, facade_style: null, window_ratio: null, ground: null };
    const r = runTool(sb, 'create_building_design', { name: '치우친 건물', zone: 'commercial', roof: 'flat', blocks: [{ ...block, x: 4, z: 6 }] });
    expect(r.isError).toBe(false);
    const id = (JSON.parse(r.content) as { type_id: string }).type_id;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const p of sb.doc.buildingTypes[id]!.parts) {
      xs.push(p.offset.x - p.width / 2, p.offset.x + p.width / 2);
      zs.push(p.offset.z - p.depth / 2, p.offset.z + p.depth / 2);
    }
    // 8 × 6 cells of 2 m: a 16 × 12 m footprint centered on the origin.
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([-8, 8, -6, 6]);
  });

  // Odd cell counts, negative coordinates and several blocks: the center stays within half a cell
  // (1 m) of the origin and on the 2 m grid (Sol 4a review #3; tolerance documented in recenter()).
  it.each([
    ['odd', [{ x: 4, z: 6, w: 3, d: 3 }]],
    ['negative', [{ x: -14, z: -9, w: 5, d: 2 }]],
    ['multi', [{ x: 2, z: -3, w: 4, d: 3 }, { x: 6, z: -3, w: 1, d: 6 }]],
  ])('%s blocks end up within 1 m of the origin', (_name, rects) => {
    const sb = newSandbox(town(), 't2', null, null);
    const blocks = rects.map((r) => ({ ...r, y: 0, h: 2, color: '#decdaa', roof_color: null, facade_style: null, window_ratio: null, ground: null }));
    const r = runTool(sb, 'create_building_design', { name: '홀수', zone: 'commercial', roof: 'flat', blocks });
    expect(r.isError).toBe(false);
    const id = (JSON.parse(r.content) as { type_id: string }).type_id;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const p of sb.doc.buildingTypes[id]!.parts) {
      for (const v of p.footprint ?? [
        { x: p.offset.x - p.width / 2, z: p.offset.z - p.depth / 2 },
        { x: p.offset.x + p.width / 2, z: p.offset.z + p.depth / 2 },
      ]) {
        xs.push(v.x);
        zs.push(v.z);
      }
    }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    expect(Math.abs(cx)).toBeLessThanOrEqual(1);
    expect(Math.abs(cz)).toBeLessThanOrEqual(1);
    // Bounds stay on the 2 m grid.
    for (const v of [...xs, ...zs]) expect(Math.abs(v % 2)).toBe(0);
  });
});

describe('create_building_design corner_radius (ADR 0012 §4)', () => {
  const block = { x: -5, y: 0, z: -5, w: 10, d: 10, h: 8, color: '#c8d0d8', roof_color: null, facade_style: 'curtain', window_ratio: 0.7, ground: null };
  const design = (blocks: unknown[], roof = 'gable') => {
    const sb = newSandbox(town(), 't3', null, null);
    const r = runTool(sb, 'create_building_design', { name: '원형 타워', zone: 'office', roof, blocks });
    return { r, parts: r.isError ? [] : sb.doc.buildingTypes[(JSON.parse(r.content) as { type_id: string }).type_id]!.parts };
  };

  it('is a strict nullable number in the schema (anyOf null, required), with no enum next to a type array', () => {
    const tool = TOOLS.find((t) => t.name === 'create_building_design')!;
    const items = (tool.input_schema as { properties: { blocks: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.blocks.items;
    expect(items.properties.corner_radius).toMatchObject({ anyOf: [{ type: 'number' }, { type: 'null' }] });
    expect(items.required).toContain('corner_radius');
  });

  it('rounds a square block into a round tower (clamped to half its side, flat roof)', () => {
    const tower = design([{ ...block, corner_radius: 10 }]);
    expect(tower.r.isError).toBe(false);
    expect(tower.parts).toHaveLength(1);
    expect(tower.parts[0]).toMatchObject({ width: 20, depth: 20, round: 10, roof: 'flat' });
    expect(design([{ ...block, corner_radius: 30 }]).parts[0]!.round).toBe(10);
    expect(design([{ ...block, corner_radius: 3 }]).parts[0]!.round).toBe(3);
  });

  it('null, missing and 0 mean square corners (field omitted, roof kept)', () => {
    for (const b of [{ ...block, corner_radius: null }, { ...block, corner_radius: 0 }, block]) {
      const { r, parts } = design([b]);
      expect(r.isError).toBe(false);
      expect(parts[0]).not.toHaveProperty('round');
      expect(parts[0]!.roof).toBe('gable');
    }
  });

  it('refuses negative and non-numeric radii', () => {
    for (const bad of [-1, 33, '5', Infinity]) expect(design([{ ...block, corner_radius: bad }]).r.isError, String(bad)).toBe(true);
  });
});
