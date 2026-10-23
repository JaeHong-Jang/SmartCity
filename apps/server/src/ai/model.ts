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

/**
 * Deterministic assistant: looks at the city, finds 3 spots near the focus, designs a small red-brick
 * building and places it on those spots, then finishes. Enough to exercise the whole flow without a key.
 */
export function scriptedModel(): AiModel {
  return {
    name: 'scripted',
    send: async (req) => {
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      if (step === 0) return message([{ type: 'text', text: '도시를 살펴볼게요.', citations: null } as unknown as Block, call('get_city_overview', {})], 'tool_use');
      if (step === 1) return message([call('find_spots', { x: null, z: null, near_building: null, near_road: null, width: 12, depth: 10, count: 3 })], 'tool_use');
      if (step === 2) {
        const spots = (lastResult(req) as { spots?: { x: number; z: number; rotation_deg: number }[] } | null)?.spots ?? [];
        if (spots.length === 0) return message([call('finish', { summary: '근처에 건물을 놓을 빈자리가 없어요. 도로를 먼저 그려 주세요.' })], 'tool_use');
        return message(
          [
            call('create_building_design', {
              name: 'AI 벽돌 카페',
              zone: 'commercial',
              roof: 'gable',
              blocks: [
                { x: -3, y: 0, z: -2, w: 6, d: 5, h: 2, color: '#b5523b' },
                { x: -2, y: 2, z: -2, w: 4, d: 4, h: 1, color: '#d8c3a5' },
              ],
            }),
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
      return message([call('finish', { summary: '포커스 근처 도로변에 빨간 벽돌 카페를 지었어요.' })], 'tool_use');
    },
  };
}
