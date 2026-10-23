import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fault injection: the next append writes `partialBytes` of its data, then throws (like ENOSPC).
const fault = vi.hoisted(() => ({ partialBytes: -1, truncateFails: 0, failWrite: null as null | ((path: string) => boolean) }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    appendFileSync: (path: string, data: string) => {
      if (fault.partialBytes >= 0) {
        const n = fault.partialBytes;
        fault.partialBytes = -1;
        fs.appendFileSync(path, data.slice(0, n));
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      fs.appendFileSync(path, data);
    },
    truncateSync: (path: string, len?: number) => {
      if (fault.truncateFails > 0) {
        fault.truncateFails--;
        throw Object.assign(new Error('EIO: truncate failed'), { code: 'EIO' });
      }
      fs.truncateSync(path, len);
    },
    writeFileSync: (path: string, data: string) => {
      if (fault.failWrite?.(String(path))) throw Object.assign(new Error('EIO: write failed'), { code: 'EIO' });
      fs.writeFileSync(path, data);
    },
  };
});

const { appendLog, loadRoom, LogCorruptedError } = await import('./persistence.js');
const { Client, Room } = await import('./room.js');

function fakeClient() {
  const msgs: { t: string; seq?: number; error?: string }[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (d: string) => msgs.push(JSON.parse(d)) };
  return { client: new Client(ws as never, 'x'), msgs };
}

const node = (id: string, x: number) => JSON.stringify({ type: 'node.add', node: { id, pos: { x, z: 0 } } });
const record = (seq: number, id: string, x: number) => `{"seq":${seq},"cmd":${node(id, x)}}`;

let dir: string;
let log: string;
beforeEach(() => {
  fault.partialBytes = -1;
  fault.truncateFails = 0;
  fault.failWrite = null;
  dir = mkdtempSync(join(tmpdir(), 'sc-persist-'));
  log = join(dir, 'r.log.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('command log durability (Sol re-check #10-#12)', () => {
  it('cuts a partially written record back out when an append fails (#10)', () => {
    appendLog(dir, 'r', 1, node('n1', 0));
    fault.partialBytes = 20;
    expect(() => appendLog(dir, 'r', 2, node('n2', 40))).toThrow(/ENOSPC/);
    appendLog(dir, 'r', 2, node('n3', 80));
    const { doc, seq } = loadRoom(dir, 'r');
    expect(seq).toBe(2);
    expect(Object.keys(doc.nodes).sort()).toEqual(['n1', 'n3']);
  });

  it('terminates a complete last record that lost its newline before appending (#11)', () => {
    writeFileSync(log, record(1, 'n1', 0));
    expect(loadRoom(dir, 'r').seq).toBe(1);
    appendLog(dir, 'r', 2, node('n2', 40));
    const { doc, seq } = loadRoom(dir, 'r');
    expect(seq).toBe(2);
    expect(Object.keys(doc.nodes).sort()).toEqual(['n1', 'n2']);
  });

  it('repairs a damaged tail without rewriting the intact records (#12)', () => {
    const intact = `${record(1, 'n1', 0)}\n`;
    writeFileSync(log, `${intact}{"seq":2,"cmd":{"type":"node.a`);
    expect(loadRoom(dir, 'r').seq).toBe(1);
    expect(readFileSync(log, 'utf8')).toBe(intact);
  });

  it('refuses to drop records that follow mid-file damage', () => {
    const body = `${record(1, 'n1', 0)}\n{"seq":2,"cmd":{"ty\n${record(3, 'n3', 80)}\n`;
    writeFileSync(log, body);
    expect(() => loadRoom(dir, 'r')).toThrow(LogCorruptedError);
    expect(readFileSync(log, 'utf8')).toBe(body);
  });
});

describe('room write fencing under compound storage faults (Sol re-check 2)', () => {
  it('never replays a rejected command when the log could not be restored or cleared (#10)', () => {
    const room = new Room('r', dir, loadRoom(dir, 'r').doc, 0);
    const { client, msgs } = fakeClient();
    room.join(client);
    // Full record written, then the append reports failure; rollback truncate fails; the
    // recovery checkpoint renames fine but cannot clear the log.
    fault.partialBytes = 10_000;
    fault.truncateFails = 1;
    fault.failWrite = (p) => p.endsWith('.log.jsonl');
    room.command(client, 1, { type: 'node.add', node: { id: 'bad', pos: { x: 0, z: 0 } } });
    expect(msgs.at(-1)).toMatchObject({ t: 'rejected', error: 'storage error' });
    fault.failWrite = null;
    room.dispose();
    const { doc } = loadRoom(dir, 'r');
    expect(doc.nodes.bad).toBeUndefined();
  });

  it('resumes writes on its own once storage recovers (#13)', () => {
    const room = new Room('r', dir, loadRoom(dir, 'r').doc, 0);
    const { client, msgs } = fakeClient();
    room.join(client);
    fault.partialBytes = 5;
    fault.truncateFails = 1;
    fault.failWrite = () => true;
    room.command(client, 1, { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } });
    room.command(client, 2, { type: 'node.add', node: { id: 'b', pos: { x: 40, z: 0 } } });
    expect(msgs.filter((m) => m.t === 'rejected')).toHaveLength(2);
    fault.failWrite = null;
    (room as unknown as { checkpointIfDirty(): void }).checkpointIfDirty(); // the 30 s timer
    room.command(client, 3, { type: 'node.add', node: { id: 'c', pos: { x: 80, z: 0 } } });
    expect(msgs.at(-1)).toMatchObject({ t: 'applied' });
    room.dispose();
    const { doc } = loadRoom(dir, 'r');
    expect(Object.keys(doc.nodes)).toEqual(['c']);
  });
});
