// Connects the AI building assistant to rooms and clients: admission (AiGate), one job per room,
// cancellation on request / disconnect, and replies only to the asker (ADR 0009 §5).

import { randomBytes } from 'node:crypto';
import { lotsAlongSegment, lotsToCommand, type AiImage, type CityDoc, type Command, type ServerMessage, type Vec2 } from '@smartcity/shared';
import { AgentError, DEFAULT_LIMITS, runAgent, type AgentLimits } from './agent.js';
import { AiGate, DEFAULT_GATE } from './gate.js';
import { claudeModel, DEFAULT_MODEL, scriptedModel, type AiModel } from './model.js';
import type { ZoneLots } from './tools.js';

export interface AiRoom {
  readonly id: string;
  readonly doc: CityDoc;
}

export interface AiClient {
  readonly id: string;
  send(msg: ServerMessage): void;
}

const zoneLots: ZoneLots = (doc, segmentId, side, depth, zone, idPrefix) => {
  const lots = lotsAlongSegment(doc, segmentId, side, 0, 1, depth, zone, idPrefix);
  return lots.length ? lotsToCommand(lots) : null;
};

export class AiService {
  private readonly jobs = new Map<string, { reqId: number; abort: AbortController; finish: () => void }>();

  constructor(
    private readonly model: AiModel | null,
    private readonly gate = new AiGate(),
    private readonly limits?: AgentLimits,
  ) {}

  /** From the environment: SC_AI_FAKE=1 → scripted model; ANTHROPIC_API_KEY → Claude (SC_AI_MODEL); else disabled. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AiService {
    // SC_AI_MAX_PER_HOUR: server-wide requests per hour (positive integer; anything else keeps the default).
    const perHour = Number(env.SC_AI_MAX_PER_HOUR);
    const gate = new AiGate({ ...DEFAULT_GATE, ...(Number.isInteger(perHour) && perHour > 0 ? { perHour } : {}) });
    if (env.SC_AI_FAKE === '1') return new AiService(scriptedModel(), gate);
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) return new AiService(null, gate);
    return new AiService(claudeModel(key, env.SC_AI_MODEL?.trim() || DEFAULT_MODEL), gate);
  }

  /** For tests and diagnostics. */
  get gateLimits(): Readonly<import('./gate.js').GateLimits> {
    return this.gate.limits;
  }

  status(): ServerMessage {
    return { t: 'ai.status', enabled: this.model !== null, model: this.model?.name ?? null };
  }

  ask(room: AiRoom, client: AiClient, ip: string, reqId: number, text: string, focus: Vec2 | null, images?: AiImage[]): void {
    if (!this.model) return client.send({ t: 'ai.error', reqId, error: 'AI가 꺼져 있습니다(서버에 API 키가 없음)' });
    if (this.jobs.has(client.id)) return client.send({ t: 'ai.error', reqId, error: '이전 요청이 아직 처리 중입니다' });
    const admission = this.gate.admit(ip, room.id);
    if (!admission.ok) return client.send({ t: 'ai.error', reqId, error: admission.reason });
    const abort = new AbortController();
    const started = Date.now();
    // Idempotent cleanup shared by completion, deadline, cancel and disconnect: the slot is freed even if
    // the model call never settles (Sol 3b recheck #10).
    const finish = (): void => {
      clearTimeout(deadline);
      admission.release();
      if (this.jobs.get(client.id)?.abort === abort) this.jobs.delete(client.id);
    };
    // The deadline aborts the model call itself and reports the timeout (unless the user already cancelled).
    const deadline = setTimeout(() => {
      const cancelled = abort.signal.aborted;
      abort.abort();
      finish();
      if (!cancelled) client.send({ t: 'ai.error', reqId, error: '시간이 너무 오래 걸려 중단했습니다' });
    }, (this.limits ?? DEFAULT_LIMITS).maxMillis);
    this.jobs.set(client.id, { reqId, abort, finish });
    void runAgent({
      model: this.model,
      doc: room.doc,
      text,
      focus,
      ...(images?.length ? { images } : {}),
      tag: randomBytes(3).toString('hex'),
      zoneLots,
      signal: abort.signal,
      ...(this.limits ? { limits: this.limits } : {}),
      onProgress: (note) => !abort.signal.aborted && client.send({ t: 'ai.progress', reqId, note }),
    })
      .then((res) => {
        if (abort.signal.aborted) return;
        // Only the request length and usage are logged, never the text.
        console.log(`[ai] room=${room.id} chars=${text.length} images=${images?.length ?? 0} model=${this.model!.name} turns=${res.usage.turns} in=${res.usage.input} out=${res.usage.output} cmds=${res.commands.length} ms=${Date.now() - started}`);
        const commands: Command[] = res.commands;
        client.send({ t: 'ai.proposal', reqId, commands, summary: res.summary });
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        const known = e instanceof AgentError;
        if (!known) console.error(`[ai] room=${room.id} failed: ${(e as Error).message}`);
        client.send({ t: 'ai.error', reqId, error: known ? (e as Error).message : 'AI 요청이 실패했습니다. 잠시 후 다시 시도하세요' });
      })
      .finally(finish);
  }

  cancel(clientId: string, reqId: number): void {
    const job = this.jobs.get(clientId);
    if (job && job.reqId === reqId) {
      job.abort.abort();
      job.finish();
    }
  }

  /** Disconnect: abort the client's job; its late answer is dropped. */
  drop(clientId: string): void {
    const job = this.jobs.get(clientId);
    job?.abort.abort();
    job?.finish();
  }
}
