import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { appendLog, backupCheckpoint, backupDir, loadRoom, LogCorruptedError, pruneBackups, RoomLoadError, writeCheckpoint } = await import('./persistence.js');
const { cloneJson, createEmptyDoc, DOC_VERSION, FACILITY_PRESETS, GROWTH_PRESETS, BASE_GROWTH_PRESET_IDS, LIMITS } = await import('@smartcity/shared');
const { Client, Room } = await import('./room.js');
const { RoomManager } = await import('./roomManager.js');

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

describe('checkpoint safety (P0 data safety)', () => {
  const cpFile = () => join(dir, 'r.json');
  const city = (n: number) => {
    const doc = createEmptyDoc();
    for (let i = 0; i < n; i++) doc.nodes[`n${i}`] = { id: `n${i}`, pos: { x: i * 40, z: 0 } };
    return doc;
  };

  it('refuses a room whose checkpoint does not parse, keeping the original and a copy', () => {
    const body = '{"schema":1,"seq":114,"doc":{"version":6,"nodes":{';
    writeFileSync(cpFile(), body);
    writeFileSync(log, `${record(115, 'late', 0)}\n`);
    expect(() => loadRoom(dir, 'r')).toThrow(RoomLoadError);
    expect(readFileSync(cpFile(), 'utf8')).toBe(body);
    expect(readFileSync(log, 'utf8')).toBe(`${record(115, 'late', 0)}\n`);
    const copies = readdirSync(dir).filter((f) => /^r\.corrupt-.+\.json$/.test(f));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(body);
    // Retried joins neither start empty nor pile up copies of the same file.
    expect(() => loadRoom(dir, 'r')).toThrow(RoomLoadError);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1);
  });

  it('refuses valid JSON that is not a checkpoint', () => {
    writeFileSync(cpFile(), JSON.stringify({ seq: 3, doc: city(1) }));
    expect(() => loadRoom(dir, 'r')).toThrow(RoomLoadError);
    writeFileSync(cpFile(), JSON.stringify({ schema: 1, seq: 3, doc: { version: DOC_VERSION } }));
    expect(() => loadRoom(dir, 'r')).toThrow(RoomLoadError);
  });

  it('refuses a checkpoint from a newer doc version without touching it', () => {
    const body = JSON.stringify({ schema: 1, seq: 9, doc: { ...city(2), version: DOC_VERSION + 1 } });
    writeFileSync(cpFile(), body);
    expect(() => loadRoom(dir, 'r')).toThrow(/새로운 버전/);
    expect(readFileSync(cpFile(), 'utf8')).toBe(body);
  });

  it('backs up the replaced checkpoint, once per distinct content', () => {
    writeCheckpoint(dir, 'r', 1, city(1));
    expect(existsSync(backupDir(dir, 'r'))).toBe(false); // nothing to back up yet
    writeCheckpoint(dir, 'r', 2, city(2));
    writeCheckpoint(dir, 'r', 2, city(2)); // replaces the seq 1 file: backed up
    writeCheckpoint(dir, 'r', 2, city(2)); // replaces an identical file: skipped
    const files = readdirSync(backupDir(dir, 'r'));
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(-\d+)?\.json$/.test(f))).toBe(true);
    const seqs = files.map((f) => JSON.parse(readFileSync(join(backupDir(dir, 'r'), f), 'utf8')).seq);
    expect(seqs.sort()).toEqual([1, 2]);
    expect(loadRoom(dir, 'r').seq).toBe(2);
  });

  it('never blocks the checkpoint when the backup fails', () => {
    writeCheckpoint(dir, 'r', 1, city(1));
    mkdirSync(join(dir, 'backups'));
    writeFileSync(backupDir(dir, 'r'), 'not a directory');
    writeCheckpoint(dir, 'r', 2, city(2));
    expect(loadRoom(dir, 'r').seq).toBe(2);
  });

  it('keeps the newest 30 plus one per day for 14 days', () => {
    const bdir = join(dir, 'b');
    mkdirSync(bdir);
    const now = new Date('2026-10-25T12:00:00.000Z');
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/:/g, '-');
    const names: string[] = [];
    // 40 backups a minute apart today, then 4 per day for the 20 days before.
    for (let i = 0; i < 40; i++) names.push(`${stamp(now.getTime() - i * 60_000)}.json`);
    for (let d = 1; d <= 20; d++) for (let h = 0; h < 4; h++) names.push(`${stamp(now.getTime() - d * 86_400_000 - h * 3_600_000)}.json`);
    names.push(`${stamp(now.getTime() - 3 * 86_400_000 - 30 * 60_000)}.prewipe.json`);
    names.push(`${stamp(now.getTime() - 15 * 86_400_000)}.prewipe.json`);
    names.push('notes.txt');
    for (const n of names) writeFileSync(join(bdir, n), '{}');
    pruneBackups(bdir, now);
    const left = readdirSync(bdir).sort().reverse();
    const recent = names.slice(0, 30);
    for (const n of recent) expect(left).toContain(n);
    expect(left).not.toContain(names[30]);
    // Days 1..14 keep their newest backup (00:00 of that day relative to now); older days nothing.
    for (let d = 1; d <= 14; d++) expect(left).toContain(`${stamp(now.getTime() - d * 86_400_000)}.json`);
    expect(left).not.toContain(`${stamp(now.getTime() - 15 * 86_400_000)}.json`);
    expect(left).toContain(names.at(-3));
    expect(left).not.toContain(names.at(-2));
    expect(left).toContain('notes.txt');
    // 30 recent + 14 daily (today's newest is already among the recent) + 1 prewipe + the foreign file.
    expect(left).toHaveLength(30 + 14 + 1 + 1);
  });

  it('warns and keeps a protected backup when a checkpoint empties a big city', () => {
    const doc = city(0);
    for (let i = 0; i < 10; i++) doc.segments[`s${i}`] = {} as never;
    writeCheckpoint(dir, 'r', 5, doc);
    const room = new Room('r', dir, doc, 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    room.doc.segments = {};
    room.checkpoint();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/empties the city/));
    warn.mockRestore();
    room.dispose();
    const pre = readdirSync(backupDir(dir, 'r')).filter((f) => f.endsWith('.prewipe.json'));
    expect(pre).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(join(backupDir(dir, 'r'), pre[0]!), 'utf8')).doc.segments)).toHaveLength(10);
    expect(Object.keys(loadRoom(dir, 'r').doc.segments)).toHaveLength(0);
  });
});

describe('Sol review of the data-safety change', () => {
  const cpFile = () => join(dir, 'r.json');
  const checkpointWith = (mutate: (doc: Record<string, unknown>) => void, seq = 1) => {
    const doc = createEmptyDoc() as unknown as Record<string, unknown>;
    (doc.nodes as Record<string, unknown>).n0 = { id: 'n0', pos: { x: 0, z: 0 } };
    mutate(doc);
    const body = JSON.stringify({ schema: 1, seq, doc });
    writeFileSync(cpFile(), body);
    return body;
  };

  it('#1 refuses a checkpoint whose collections are arrays or missing, or whose entities are malformed', () => {
    // Sol: `nodes: []` loaded, node.add succeeded, and the node was gone after checkpoint + reload.
    const cases: [string, (d: Record<string, unknown>) => void][] = [
      ['nodes is an array', (d) => (d.nodes = [])],
      ['buildings is an array', (d) => (d.buildings = [])],
      ['vehicleTypes missing', (d) => delete d.vehicleTypes],
      ['closures is a string', (d) => (d.closures = 'x')],
      ['node id differs from its key', (d) => ((d.nodes as Record<string, unknown>).n0 = { id: 'other', pos: { x: 0, z: 0 } })],
      ['node without a position', (d) => ((d.nodes as Record<string, unknown>).n0 = { id: 'n0' })],
      ['segment to a missing node', (d) => ((d.segments as Record<string, unknown>).s1 = { id: 's1', a: 'n0', b: 'gone', roadTypeId: 'road-2' })],
      ['building of an unknown type', (d) => ((d.buildings as Record<string, unknown>).b1 = { id: 'b1', typeId: 'nope', pos: { x: 0, z: 0 }, rotation: 0 })],
      ['meta missing', (d) => delete d.meta],
    ];
    for (const [what, mutate] of cases) {
      const body = checkpointWith(mutate);
      expect(() => loadRoom(dir, 'r'), what).toThrow(RoomLoadError);
      expect(readFileSync(cpFile(), 'utf8'), what).toBe(body);
    }
    expect(readdirSync(dir).filter((f) => f.startsWith('r.corrupt-')).length).toBeGreaterThanOrEqual(1);
    // The same doc without the damage loads.
    checkpointWith(() => {});
    expect(Object.keys(loadRoom(dir, 'r').doc.nodes)).toEqual(['n0']);
  });

  it('#2 refuses a log whose middle record does not replay, and keeps the log', () => {
    const body = `${record(1, 'n1', 0)}\n{"seq":2,"cmd":{"type":"unknown"}}\n${record(3, 'n3', 80)}\n`;
    writeFileSync(log, body);
    expect(() => loadRoom(dir, 'r')).toThrow(LogCorruptedError);
    expect(readFileSync(log, 'utf8')).toBe(body);
  });

  it('#2 refuses out-of-order, duplicate, skipped and malformed records, and damage that kept its newline', () => {
    const bodies = {
      duplicate: `${record(1, 'n1', 0)}\n${record(1, 'n2', 40)}\n`,
      backwards: `${record(1, 'n1', 0)}\n${record(3, 'n3', 80)}\n${record(2, 'n2', 40)}\n`,
      gap: `${record(1, 'n1', 0)}\n${record(3, 'n3', 80)}\n`,
      notARecord: `${record(1, 'n1', 0)}\n{"seq":"2","cmd":{}}\n`,
      array: `[1,2]\n`,
      blankLine: `${record(1, 'n1', 0)}\n\n${record(2, 'n2', 40)}\n`,
      damagedLastLine: `${record(1, 'n1', 0)}\n{"seq":2,"cmd":{"ty\n`,
    };
    for (const [what, body] of Object.entries(bodies)) {
      writeFileSync(log, body);
      expect(() => loadRoom(dir, 'r'), what).toThrow(LogCorruptedError);
      expect(readFileSync(log, 'utf8'), what).toBe(body);
    }
  });

  it('#2 still repairs only an unterminated final record, and skips records the checkpoint already holds', () => {
    writeFileSync(log, `${record(1, 'n1', 0)}\n${record(2, 'n2', 40)}\n{"seq":3,"cmd":{"type":"node.a`);
    expect(loadRoom(dir, 'r').seq).toBe(2);
    expect(readFileSync(log, 'utf8')).toBe(`${record(1, 'n1', 0)}\n${record(2, 'n2', 40)}\n`);
    // A checkpoint at seq 2 whose log clear failed, then appends 3 and 4.
    const doc = createEmptyDoc();
    doc.nodes.n1 = { id: 'n1', pos: { x: 0, z: 0 } };
    doc.nodes.n2 = { id: 'n2', pos: { x: 40, z: 0 } };
    writeFileSync(cpFile(), JSON.stringify({ schema: 1, seq: 2, doc }));
    writeFileSync(log, `${record(1, 'n1', 0)}\n${record(2, 'n2', 40)}\n${record(3, 'n3', 80)}\n${record(4, 'n4', 120)}\n`);
    const r = loadRoom(dir, 'r');
    expect(r.seq).toBe(4);
    expect(Object.keys(r.doc.nodes).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('#5 never overwrites a backup made in the same millisecond', () => {
    const now = new Date('2026-10-25T12:00:00.000Z');
    const contents = ['A', 'B', 'C'].map((v, i) => JSON.stringify({ schema: 1, seq: i, doc: v }));
    for (const c of contents) {
      writeFileSync(cpFile(), c);
      backupCheckpoint(dir, 'r', now);
    }
    writeFileSync(cpFile(), contents[2]!);
    backupCheckpoint(dir, 'r', now, true);
    const bdir = backupDir(dir, 'r');
    const files = readdirSync(bdir).sort();
    expect(files).toEqual([
      '2026-10-25T12-00-00.000Z-1.json',
      '2026-10-25T12-00-00.000Z-2.json',
      '2026-10-25T12-00-00.000Z.json',
      '2026-10-25T12-00-00.000Z.prewipe.json',
    ]);
    const byName = (f: string) => readFileSync(join(bdir, f), 'utf8');
    expect(byName('2026-10-25T12-00-00.000Z.json')).toBe(contents[0]);
    expect(byName('2026-10-25T12-00-00.000Z-1.json')).toBe(contents[1]);
    expect(byName('2026-10-25T12-00-00.000Z-2.json')).toBe(contents[2]);
  });

  it('#5 rotation orders same-millisecond names by their suffix', () => {
    const bdir = join(dir, 'b');
    mkdirSync(bdir);
    const now = new Date('2026-10-25T12:00:00.000Z');
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/:/g, '-');
    const old = stamp(now.getTime() - 3 * 86_400_000);
    for (const n of ['', '-1', '-2', '-10']) writeFileSync(join(bdir, `${old}${n}.json`), '{}');
    for (let i = 0; i < 30; i++) writeFileSync(join(bdir, `${stamp(now.getTime() - i * 60_000)}.json`), '{}');
    // The newest 30 (n0..n29 of today) are kept regardless; of the old day only its newest, `-10`.
    pruneBackups(bdir, now);
    const left = readdirSync(bdir);
    expect(left.filter((f) => f.startsWith(old))).toEqual([`${old}-10.json`]);
    expect(left).toHaveLength(31);
    // Today's newest is the one with the highest suffix in the same millisecond.
    writeFileSync(join(bdir, `${stamp(now.getTime())}-1.json`), '{}');
    pruneBackups(bdir, now);
    expect(readdirSync(bdir)).toContain(`${stamp(now.getTime())}-1.json`);
    expect(readdirSync(bdir)).not.toContain(`${stamp(now.getTime() - 29 * 60_000)}.json`);
  });
});

describe('Sol recheck #6: logs written before a migration still replay', () => {
  // Presets each migration adds; a doc of that version never had them.
  const addedBy = (version: number) => [
    ...GROWTH_PRESETS.filter((t) => version < 4 && BASE_GROWTH_PRESET_IDS.includes(t.id)),
    ...GROWTH_PRESETS.filter((t) => version < 5 && !BASE_GROWTH_PRESET_IDS.includes(t.id)),
    ...FACILITY_PRESETS.filter(() => version < 6),
  ];
  const design = (id: string, parts: unknown = undefined) => {
    const t = cloneJson(createEmptyDoc().buildingTypes.house!) as unknown as Record<string, unknown>;
    return { ...t, id, name: id, ...(parts === undefined ? {} : { parts }) };
  };

  for (const version of [3, 4, 5]) {
    it(`v${version}: a design added one below the limit replays after the migration pushes past it`, () => {
      const doc = createEmptyDoc() as unknown as { version: number; buildingTypes: Record<string, unknown> };
      for (const t of addedBy(version)) delete doc.buildingTypes[t.id];
      doc.version = version;
      for (let i = 0; Object.keys(doc.buildingTypes).length < LIMITS.buildingTypes - 1; i++) doc.buildingTypes[`d${i}`] = design(`d${i}`);
      writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 5, doc }));
      // Accepted by the server of that version: 1999 designs, one more fits.
      const upsert = (seq: number, id: string, parts?: unknown) => `${JSON.stringify({ seq, cmd: { type: 'buildingType.upsert', buildingType: design(id, parts) } })}\n`;
      writeFileSync(log, upsert(6, 'mine') + `${JSON.stringify({ seq: 7, cmd: { type: 'buildingType.remove', id: 'd0' } })}\n`);
      const r = loadRoom(dir, 'r');
      expect(r.seq).toBe(7);
      expect(r.doc.version).toBe(DOC_VERSION);
      expect(r.doc.buildingTypes.mine).toBeDefined();
      expect(r.doc.buildingTypes.d0).toBeUndefined();
      expect(Object.keys(r.doc.buildingTypes).length).toBeGreaterThan(LIMITS.buildingTypes);
      for (const t of addedBy(version)) expect(r.doc.buildingTypes[t.id]).toBeDefined();

      // Trusted replay still validates structure: a malformed design in the same position refuses.
      writeFileSync(log, upsert(6, 'broken', 'not parts'));
      expect(() => loadRoom(dir, 'r')).toThrow(LogCorruptedError);
    });
  }
});

describe('v7 rounded volumes (ADR 0012 §4)', () => {
  it('loads a v6 checkpoint as v7 with every design unchanged, then replays a logged rounded design', () => {
    const doc = { ...cloneJson(createEmptyDoc()), version: 6 };
    const types = JSON.stringify(doc.buildingTypes);
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 2, doc }));
    const tower = { ...cloneJson(createEmptyDoc().buildingTypes.house!), id: 'tower', parts: [{ ...cloneJson(createEmptyDoc().buildingTypes.house!.parts[0]!), width: 12, depth: 12, roof: 'flat', round: 6 }] };
    writeFileSync(log, `${JSON.stringify({ seq: 3, cmd: { type: 'buildingType.upsert', buildingType: tower } })}\n`);
    const r = loadRoom(dir, 'r');
    expect(DOC_VERSION).toBe(8);
    expect(r.doc.version).toBe(DOC_VERSION);
    const { tower: added, ...rest } = r.doc.buildingTypes;
    expect(JSON.stringify(rest)).toBe(types);
    expect(added!.parts[0]!.round).toBe(6);
  });

  // Sol P5d review #1: a v6 room opened by the v7 server, a rounded design accepted, then a crash before
  // the next checkpoint and a rollback to the v6 server. The v6 server's loader (HEAD before P5d) refuses
  // a checkpoint whose doc.version is above its DOC_VERSION 6, and otherwise replays the log onto its
  // own doc, dropping `round` without a word.
  const OLD_DOC_VERSION = 6;
  const oldServerOpens = (room: string): boolean => {
    const cp = JSON.parse(readFileSync(join(dir, `${room}.json`), 'utf8')) as { doc: { version: number } };
    return !(cp.doc.version > OLD_DOC_VERSION);
  };
  const roundDesign = () => {
    const house = cloneJson(createEmptyDoc().buildingTypes.house!);
    return { type: 'buildingType.upsert' as const, buildingType: { ...house, id: 'tower', rev: undefined, parts: [{ ...house.parts[0]!, width: 20, depth: 20, roof: 'flat' as const, round: 10 }] } };
  };

  it('a migrated room is on disk at v7 before it logs a rounded design, so the v6 server refuses it', () => {
    const v6 = { ...cloneJson(createEmptyDoc()), version: 6 };
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 0, doc: v6 }));
    expect(oldServerOpens('r')).toBe(true);
    const rooms = new RoomManager(dir);
    const room = rooms.get('r');
    // Written right at load, before any command (with the usual backup of the v6 file).
    expect(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).doc.version).toBe(DOC_VERSION);
    expect(readdirSync(join(dir, 'backups', 'r'))).toHaveLength(1);
    expect(room.system(roundDesign())).toMatchObject({ ok: true, seq: 1 });
    // Crash: no further checkpoint. The log holds the rounded design...
    expect(readFileSync(log, 'utf8')).toContain('"round":10');
    // ...but the v6 server refuses the room instead of replaying it without the radius,
    expect(oldServerOpens('r')).toBe(false);
    // while the v7 server gets it back.
    expect(loadRoom(dir, 'r').doc.buildingTypes.tower!.parts[0]!.round).toBe(10);
    room.dispose();
  });

  it('a room with no checkpoint yet writes a v7 one before its first command (log kept)', () => {
    const room = new RoomManager(dir).get('r');
    expect(existsSync(join(dir, 'r.json'))).toBe(false); // a mere visit writes nothing
    expect(room.system(roundDesign()).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'))).toMatchObject({ seq: 0, doc: { version: DOC_VERSION } });
    expect(oldServerOpens('r')).toBe(false);
    room.dispose();
  });

  it('refuses commands while the version checkpoint cannot be written, and logs nothing', () => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 0, doc: { ...cloneJson(createEmptyDoc()), version: 6 } }));
    fault.failWrite = (path) => path.endsWith('r.json.tmp');
    const room = new RoomManager(dir).get('r');
    expect(room.system(roundDesign())).toEqual({ ok: false, error: 'storage error' });
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
    expect(room.doc.buildingTypes.tower).toBeUndefined();
    expect(oldServerOpens('r')).toBe(true); // still the untouched v6 file
    // Once the disk recovers, the next command first stamps v7, then is logged.
    fault.failWrite = null;
    expect(room.system(roundDesign()).ok).toBe(true);
    expect(oldServerOpens('r')).toBe(false);
    room.dispose();
  });
});

describe('v8 roadside sensors (ADR 0013 §4)', () => {
  const road = (): string =>
    [
      { seq: 1, cmd: { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } } },
      { seq: 2, cmd: { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } } },
      { seq: 3, cmd: { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } } },
    ]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join('');
  const sensor = { id: 'cam', kind: 'cctv', segmentId: 'ab', t: 0.5, side: 'right', heading: 0, fov: Math.PI / 2, range: 120 };
  // The v7 server (HEAD before P6b-1) refuses a checkpoint whose doc.version is above its DOC_VERSION 7.
  const OLD_DOC_VERSION = 7;
  const oldServerOpens = (room: string): boolean => !(JSON.parse(readFileSync(join(dir, `${room}.json`), 'utf8')).doc.version > OLD_DOC_VERSION);

  it('loads a v7 checkpoint as v8 (empty sensors) and replays a logged sensor and its removal with the road', () => {
    const v7 = { ...cloneJson(createEmptyDoc()), version: 7 } as Record<string, unknown>;
    delete v7.sensors;
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 0, doc: v7 }));
    writeFileSync(log, road() + `${JSON.stringify({ seq: 4, cmd: { type: 'sensor.place', sensor } })}\n`);
    const r = loadRoom(dir, 'r');
    expect(DOC_VERSION).toBe(8);
    expect(r.doc.version).toBe(8);
    expect(r.doc.sensors).toEqual({ cam: sensor });
    appendLog(dir, 'r', 5, JSON.stringify({ type: 'segment.remove', id: 'ab' }));
    expect(loadRoom(dir, 'r').doc.sensors).toEqual({});
  });

  it('a migrated room is on disk at v8 before it logs a sensor, so the v7 server refuses it instead of dropping it', () => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 0, doc: { ...cloneJson(createEmptyDoc()), version: 7 } }));
    expect(oldServerOpens('r')).toBe(true);
    const room = new RoomManager(dir).get('r');
    expect(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).doc.version).toBe(8);
    for (const c of [
      { type: 'node.add', node: { id: 'a', pos: { x: 0, z: 0 } } },
      { type: 'node.add', node: { id: 'b', pos: { x: 200, z: 0 } } },
      { type: 'segment.add', segment: { id: 'ab', a: 'a', b: 'b', roadTypeId: 'road-2' } },
      { type: 'sensor.place', sensor },
    ] as const)
      expect(room.system(c as never).ok).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('"sensor.place"');
    expect(oldServerOpens('r')).toBe(false);
    expect(loadRoom(dir, 'r').doc.sensors.cam).toEqual(sensor);
    room.dispose();
  });

  it.each([{ segmentId: 'gone' }, { kind: 'bogus' }, { side: 'wrong' }, { t: 2 }, { fov: 0 }, { range: -1 }])('a malformed stored sensor %o refuses the room (docProblem, same rules as sensor.place)', (bad) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 0, doc: { ...cloneJson(createEmptyDoc()), version: 7 } }));
    writeFileSync(log, road());
    const doc = loadRoom(dir, 'r').doc;
    doc.sensors = { cam: { ...sensor, ...bad } as never };
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ schema: 1, seq: 3, doc }));
    writeFileSync(log, '');
    expect(() => loadRoom(dir, 'r')).toThrow(RoomLoadError);
  });
});
