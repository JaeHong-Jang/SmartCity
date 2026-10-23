import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

describe('Client tag', () => {
  it('differs across server restarts (fresh module state), so new ids never collide with persisted ones', async () => {
    const tagAfterBoot = async (): Promise<string> => {
      vi.resetModules();
      const { Client } = await import('./room.js');
      return new Client({} as WebSocket, 'x').tag;
    };
    const first = await tagAfterBoot();
    const second = await tagAfterBoot();
    expect(first).not.toBe(second);
  });
});
