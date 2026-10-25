// The language model behind the AI building assistant. `claudeModel` calls the Claude API (key stays on
// the server); `scriptedModel` is a deterministic stand-in for tests and for `SC_AI_FAKE=1` e2e runs.

import Anthropic from '@anthropic-ai/sdk';

export interface ModelRequest {
  /** Output budget of this call (the loop passes what is left of the request budget). */
  maxTokens: number;
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface AiModel {
  readonly name: string;
  send(req: ModelRequest, signal: AbortSignal): Promise<Anthropic.Beta.BetaMessage>;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * Claude via the Messages API: adaptive thinking at medium effort, and server-side fallbacks so a
 * declined request is retried on a suitable model inside the same call.
 */
export function claudeModel(apiKey: string, model = DEFAULT_MODEL): AiModel {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    name: model,
    send: (req, signal) =>
      client.beta.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          tools: req.tools,
          messages: req.messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal },
      ),
  };
}

type Block = Anthropic.Beta.BetaContentBlock;

const message = (content: Block[], stop: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage =>
  ({
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) as unknown as Anthropic.Beta.BetaMessage;

let toolSeq = 0;
const call = (name: string, input: unknown): Block => ({ type: 'tool_use', id: `toolu_scripted_${++toolSeq}`, name, input }) as unknown as Block;

/** Last tool result text in the conversation (the scripted model reacts to it). */
function lastResult(req: ModelRequest): unknown {
  const last = req.messages[req.messages.length - 1];
  if (!last || !Array.isArray(last.content)) return null;
  for (const b of last.content) {
    if (b.type === 'tool_result' && typeof b.content === 'string') {
      try {
        return JSON.parse(b.content);
      } catch {
        return b.content;
      }
    }
  }
  return null;
}

const hasImage = (req: ModelRequest): boolean => {
  const first = req.messages[0];
  return !!first && Array.isArray(first.content) && first.content.some((b) => b.type === 'image');
};


const firstText = (req: ModelRequest): string => {
  const c = req.messages[0]?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') : '';
};

/** A request to build a road ("도로 깔아줘"): scripted as one 120 m road from a road end, plus 2 buildings beside it. */
const wantsRoad = (req: ModelRequest): boolean => /도로.*(깔|연결)/.test(firstText(req));

/** Candidate end points 120 m from `from`: straight on (away from `other`), then to either side. */
function roadEnds(from: { x: number; z: number }, other: { x: number; z: number }, half: number): { x: number; z: number }[] {
  const len = Math.hypot(from.x - other.x, from.z - other.z) || 1;
  const ux = (from.x - other.x) / len;
  const uz = (from.z - other.z) / len;
  const at = (dx: number, dz: number) => ({ x: Math.round(from.x + dx * 120), z: Math.round(from.z + dz * 120) });
  return [at(ux, uz), at(-uz, ux), at(uz, -ux)].filter((p) => Math.abs(p.x) <= half - 10 && Math.abs(p.z) <= half - 10);
}

const BRICK_CAFE = {
  name: 'AI 벽돌 카페',
  zone: 'commercial',
  roof: 'gable',
  blocks: [
    { x: -3, y: 0, z: -2, w: 6, d: 5, h: 2, color: '#b5523b', roof_color: null, facade_style: null, window_ratio: null, ground: null },
    { x: -2, y: 2, z: -2, w: 4, d: 4, h: 1, color: '#d8c3a5', roof_color: null, facade_style: null, window_ratio: null, ground: null },
  ],
};

/** Road script: overview -> add_road -> find_spots beside it -> design -> place 2 -> finish. */
function roadStep(req: ModelRequest, step: number): Anthropic.Beta.BetaMessage {
  if (step === 0) return message([call('get_city_overview', {})], 'tool_use');
  if (step === 1) {
    const ov = lastResult(req) as { mapHalfSize?: number; roads?: { from: { x: number; z: number }; to: { x: number; z: number } }[] } | null;
    const r = ov?.roads?.[0];
    if (!r || !ov?.mapHalfSize) return message([call('finish', { summary: '연결할 기존 도로가 없어요. 도로를 하나 그려 주세요.' })], 'tool_use');
    // Start at the end of the nearest road that is farther from the middle of the map (room to grow).
    const [from, other] = Math.hypot(r.from.x, r.from.z) >= Math.hypot(r.to.x, r.to.z) ? [r.from, r.to] : [r.to, r.from];
    const end = roadEnds(from, other, ov.mapHalfSize)[0];
    if (!end) return message([call('finish', { summary: '이 근처에는 도로를 놓을 공간이 없어요.' })], 'tool_use');
    return message([call('add_road', { points: [from, end], road_type: null, snap: true })], 'tool_use');
  }
  if (step === 2) {
    const road = lastResult(req) as { from?: { x: number; z: number }; to?: { x: number; z: number } } | null;
    if (!road?.from || !road.to) return message([call('finish', { summary: '도로를 놓지 못했어요.' })], 'tool_use');
    if (/도로만/.test(firstText(req))) return message([call('finish', { summary: '기존 도로 끝에서 이어지는 도로를 깔았어요.' })], 'tool_use');
    const mid = { x: (road.from.x + road.to.x) / 2, z: (road.from.z + road.to.z) / 2 };
    return message([call('find_spots', { x: mid.x, z: mid.z, near_building: null, near_road: null, width: 12, depth: 10, count: 2 })], 'tool_use');
  }
  if (step === 3) return message([call('create_building_design', BRICK_CAFE)], 'tool_use');
  if (step === 4) {
    const typeId = (lastResult(req) as { type_id?: string } | null)?.type_id;
    const spotsMsg = req.messages[req.messages.length - 3];
    let spots: { x: number; z: number; rotation_deg: number }[] = [];
    if (spotsMsg && Array.isArray(spotsMsg.content)) {
      for (const b of spotsMsg.content) if (b.type === 'tool_result' && typeof b.content === 'string') spots = (JSON.parse(b.content) as { spots: typeof spots }).spots;
    }
    if (!typeId || spots.length === 0) return message([call('finish', { summary: '도로를 놓았어요. 옆에 건물을 놓을 자리는 찾지 못했어요.' })], 'tool_use');
    return message([call('place_buildings', { items: spots.map((s) => ({ type_id: typeId, x: s.x, z: s.z, rotation_deg: s.rotation_deg })) })], 'tool_use');
  }
  return message([call('finish', { summary: '기존 도로 끝에서 이어지는 120 m 도로를 깔고 그 옆에 벽돌 카페를 지었어요.' })], 'tool_use');
}

/** A glass office (podium + tower, curtain wall) for requests that came with a picture. */
const IMAGE_DESIGN = {
  name: 'AI 유리 오피스',
  zone: 'office',
  roof: 'flat',
  blocks: [
    { x: -4, y: 0, z: -3, w: 8, d: 6, h: 2, color: '#8fa3b5', roof_color: '#4a5560', facade_style: 'ribbon', window_ratio: 0.6, ground: 'lobby' },
    { x: -2, y: 2, z: -2, w: 4, d: 4, h: 6, color: '#6f93b0', roof_color: '#3d4750', facade_style: 'curtain', window_ratio: 0.85, ground: null },
  ],
};

/**
 * Deterministic assistant: looks at the city, finds 3 spots near the focus, designs a small red-brick
 * building and places it on those spots, then finishes. Enough to exercise the whole flow without a key.
 */
export function scriptedModel(): AiModel {
  return {
    name: 'scripted',
    send: async (req) => {
      const picture = hasImage(req);
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      if (wantsRoad(req)) return roadStep(req, step);
      if (step === 0) return message([{ type: 'text', text: '도시를 살펴볼게요.', citations: null } as unknown as Block, call('get_city_overview', {})], 'tool_use');
      if (step === 1) return message([call('find_spots', { x: null, z: null, near_building: null, near_road: null, width: 12, depth: 10, count: 3 })], 'tool_use');
      if (step === 2) {
        const spots = (lastResult(req) as { spots?: { x: number; z: number; rotation_deg: number }[] } | null)?.spots ?? [];
        if (spots.length === 0) return message([call('finish', { summary: '근처에 건물을 놓을 빈자리가 없어요. 도로를 먼저 그려 주세요.' })], 'tool_use');
        return message(
          [
            call(
              'create_building_design',
              picture
                ? IMAGE_DESIGN
                : {
                    name: 'AI 벽돌 카페',
                    zone: 'commercial',
                    roof: 'gable',
                    blocks: [
                      { x: -3, y: 0, z: -2, w: 6, d: 5, h: 2, color: '#b5523b', roof_color: null, facade_style: null, window_ratio: null, ground: null },
                      { x: -2, y: 2, z: -2, w: 4, d: 4, h: 1, color: '#d8c3a5', roof_color: null, facade_style: null, window_ratio: null, ground: null },
                    ],
                  },
            ),
          ],
          'tool_use',
        );
      }
      if (step === 3) {
        const typeId = (lastResult(req) as { type_id?: string } | null)?.type_id;
        // Spots come from the find_spots result two turns back.
        const spotsMsg = req.messages[req.messages.length - 3];
        let spots: { x: number; z: number; rotation_deg: number }[] = [];
        if (spotsMsg && Array.isArray(spotsMsg.content)) {
          for (const b of spotsMsg.content) if (b.type === 'tool_result' && typeof b.content === 'string') spots = (JSON.parse(b.content) as { spots: typeof spots }).spots;
        }
        if (!typeId) return message([call('finish', { summary: '설계를 만들지 못했어요.' })], 'tool_use');
        return message([call('place_buildings', { items: spots.map((s) => ({ type_id: typeId, x: s.x, z: s.z, rotation_deg: s.rotation_deg })) })], 'tool_use');
      }
      return message([call('finish', { summary: picture ? '사진 속 건물을 2 m 블록으로 근사해 유리 오피스를 설계하고 도로변에 놓았어요. 실제보다 단순합니다.' : '포커스 근처 도로변에 빨간 벽돌 카페를 지었어요.' })], 'tool_use');
    },
  };
}
