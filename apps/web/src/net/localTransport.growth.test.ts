import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, lotsAlongSegment, lotsToCommand, type Command, type ServerMessage } from '@smartcity/shared';
import { LocalTransport } from './localTransport';

const flush = () => Promise.resolve();

describe('LocalTransport growth', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Transport with a street and zoned lots; `got` collects what arrives after setup. */
  async function setup(): Promise<{ t: LocalTransport; got: ServerMessage[] }> {
    const t = new LocalTransport('solo', null, () => '나');
    const got: ServerMessage[] = [];
    t.onMessage((m) => got.push(m));
    t.connect();
    const cmds: Command[] = [
      { type: 'node.add', node: { id: 'a', pos: { x: -100, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 100, z: 0 } } },
      { type: 'segment.add', segment: { id: 'S1', a: 'a', b: 'b', roadTypeId: 'road-2' } },
    ];
    cmds.forEach((cmd, i) => t.send({ t: 'cmd', ref: i + 1, cmd }));
    await flush();
    const welcome = got.find((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
    // Build the lots against a doc that already has the street.
    for (const m of got) if (m.t === 'applied') applyCommand(welcome.doc, m.cmd);
    t.send({ t: 'cmd', ref: 10, cmd: lotsToCommand(lotsAlongSegment(welcome.doc, 'S1', 'right', 0, 1, 2, 'residential', 'z')) });
    await flush();
    got.length = 0;
    return { t, got };
  }

  it('grows every 5 s as a system command with a seq and no ref', async () => {
    const { t, got } = await setup();
    vi.advanceTimersByTime(4999);
    await flush();
    expect(got).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ t: 'applied', by: 'system', seq: 5, cmd: { type: 'batch' } });
    expect((got[0] as { ref?: number }).ref).toBeUndefined();
    t.close();
  });

  it('honours meta.growth and stops on close', async () => {
    const { t, got } = await setup();
    t.send({ t: 'cmd', ref: 20, cmd: { type: 'meta.update', growth: false } });
    await flush();
    got.length = 0;
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(got).toHaveLength(0);
    t.send({ t: 'cmd', ref: 21, cmd: { type: 'meta.update', growth: true } });
    t.close();
    got.length = 0;
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(got.filter((m) => m.t === 'applied' && m.by === 'system')).toHaveLength(0);
  });
});
