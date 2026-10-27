import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, normalizeDoc } from '@smartcity/shared';
import type { CityDoc, Command } from '@smartcity/shared';
import { appendLog, loadRoom, LogCorruptedError, RoomLoadError, writeCheckpoint } from './persistence.js';
import { MANIFEST, runSnapshot, snapshotDataDir, snapshotRoom } from './snapshot.js';

const ROOM = 'city';
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** A room written by the real persistence functions; remembers every state it went through. */
class LiveRoom {
  doc: CityDoc = createEmptyDoc();
  seq = 0;
  private n = 0;
  readonly states = new Map<number, string>();
  constructor(readonly dir: string) {
    this.remember();
  }
  private remember(): void {
    this.states.set(this.seq, JSON.stringify(normalizeDoc(cloneJson(this.doc))));
  }
  /** One approved edit: applied, then appended to the log (as Room.commit does). */
  append(): void {
    const cmd: Command = { type: 'node.add', node: { id: `n${++this.n}`, pos: { x: this.n * 10, z: 0 } } };
    expect(applyCommand(this.doc, cmd).ok).toBe(true);
    this.seq++;
    appendLog(this.dir, ROOM, this.seq, JSON.stringify(cmd));
    this.remember();
  }
  /** First half of writeCheckpoint: the new checkpoint is renamed into place, the log not yet cleared. */
  rename(): void {
    writeCheckpoint(this.dir, ROOM, this.seq, cloneJson(this.doc), false, true);
  }
  /** Second half: the log is cleared. */
  clear(): void {
    writeFileSync(join(this.dir, `${ROOM}.log.jsonl`), '');
  }
  run(op: Op): void {
    this[op]();
  }
}
type Op = 'append' | 'rename' | 'clear';

// The server's write history: checkpoints (rename + clear, adjacent) between bursts of edits.
const TIMELINE: Op[] = ['rename', 'clear', 'append', 'append', 'rename', 'clear', 'append', 'append', 'append', 'rename', 'clear', 'append', 'rename', 'clear', 'append', 'append'];
const STEPS = 8; // the first two attempts of a room (4 reads each)

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sc-snapshot-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

type Copier = (dir: string, out: string, onStep: () => void) => string | null;

/**
 * Starts the backup after `start` timeline ops; then before every read step i (of the first STEPS)
 * whose bit is set in `mask`, the server performs its next op. Returns the restored room and what the
 * live room had.
 */
function scenario(copy: Copier, start: number, mask: number, k: number) {
  const dir = join(base, `live-${k}`);
  const out = join(base, `out-${k}`);
  mkdirSync(dir);
  mkdirSync(out);
  const live = new LiveRoom(dir);
  let next = 0;
  for (; next < start; next++) live.run(TIMELINE[next]!);
  const startSeq = live.seq;
  let step = 0;
  const warning = copy(dir, out, () => {
    if (step < STEPS && mask & (1 << step) && next < TIMELINE.length) live.run(TIMELINE[next++]!);
    step++;
  });
  const restored = loadRoom(out, ROOM);
  return { warning, restored, startSeq, endSeq: live.seq, states: live.states };
}

const snapshotCopier: Copier = (dir, out, onStep) => {
  const r = snapshotRoom(dir, ROOM, out, { onStep, retryDelayMs: 0 });
  return r.status === 'ok' ? null : `${r.status}: ${r.reason}`;
};

describe('backup snapshot of a live room (Sol deploy review #2)', () => {
  it('restores a state the room really had, never older than when the backup started, at every interleaving', () => {
    let k = 0;
    let runs = 0;
    for (let start = 2; start <= TIMELINE.length; start++) {
      for (let mask = 0; mask < 1 << STEPS; mask++) {
        const r = scenario(snapshotCopier, start, mask, k++);
        const where = `start=${start} mask=${mask.toString(2)}`;
        expect(r.warning, where).toBeNull();
        expect(r.restored.seq, where).toBeGreaterThanOrEqual(r.startSeq);
        expect(r.restored.seq, where).toBeLessThanOrEqual(r.endSeq);
        expect(JSON.stringify(r.restored.doc), where).toBe(r.states.get(r.restored.seq));
        rmSync(join(base, `live-${k - 1}`), { recursive: true });
        rmSync(join(base, `out-${k - 1}`), { recursive: true });
        runs++;
      }
    }
    expect(runs).toBe(15 * 256);
  }, 120_000);

  it('the same harness catches the plain copy order (checkpoint, then log) losing an approved edit', () => {
    // What tar did: read the checkpoint, then the log, each once.
    const naive: Copier = (dir, out, onStep) => {
      onStep();
      copyFileSync(join(dir, `${ROOM}.json`), join(out, `${ROOM}.json`));
      onStep();
      onStep();
      copyFileSync(join(dir, `${ROOM}.log.jsonl`), join(out, `${ROOM}.log.jsonl`));
      return null;
    };
    // Edits 1..2 logged after checkpoint 0; between the two reads the server checkpoints at 2 and clears.
    const r = scenario(naive, 4, 0b110, 0);
    expect(r.startSeq).toBe(2);
    expect(r.restored.seq).toBe(0); // approved edits 1 and 2 lost
  });

  it('retries a log read that straddled a clear (old bytes followed by new ones)', () => {
    const dir = join(base, 'live');
    const out = join(base, 'out');
    mkdirSync(dir);
    mkdirSync(out);
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    for (let i = 0; i < 3; i++) live.append();
    const lp = join(dir, `${ROOM}.log.jsonl`);
    let torn = false;
    const read = (p: string): Buffer | null => {
      if (!existsSync(p)) return null;
      if (p !== lp || torn) return readFileSync(p);
      torn = true;
      const old = readFileSync(p);
      live.rename();
      live.clear();
      live.append();
      live.append();
      const now = readFileSync(p);
      return Buffer.concat([old.subarray(0, 20), now.subarray(20)]);
    };
    expect(snapshotRoom(dir, ROOM, out, { read, retryDelayMs: 0 })).toEqual({ room: ROOM, status: 'ok' });
    const restored = loadRoom(out, ROOM);
    expect(restored.seq).toBe(5);
    expect(JSON.stringify(restored.doc)).toBe(live.states.get(5));
  });

  it('replay relies on: log records up to the checkpoint are skipped, a log starting after seq+1 is refused', () => {
    const dir = join(base, 'replay');
    mkdirSync(dir);
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    live.append();
    live.rename(); // checkpoint 2 on disk, log still holds 1..2
    live.append(); // 3 follows (never happens without a clear, but replay must still be exact)
    expect(loadRoom(dir, ROOM).seq).toBe(3);
    // A log that starts after checkpoint+1 cannot be replayed: the room is refused, not opened short.
    const gap = join(base, 'gap');
    mkdirSync(gap);
    copyFileSync(join(dir, `${ROOM}.json`), join(gap, `${ROOM}.json`));
    writeFileSync(join(gap, `${ROOM}.log.jsonl`), `{"seq":4,"cmd":{"type":"node.add","node":{"id":"z","pos":{"x":0,"z":5}}}}\n`);
    expect(() => loadRoom(gap, ROOM)).toThrow(LogCorruptedError);
  });

  it('copies the whole data dir: rooms as pairs, the server backups and preserved files as they are, no .tmp', () => {
    const dir = join(base, 'data');
    mkdirSync(join(dir, 'backups', ROOM), { recursive: true });
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    writeFileSync(join(dir, 'backups', ROOM, '2026-10-27T00-00-00.000Z.json'), '{"old":1}');
    writeFileSync(join(dir, `${ROOM}.corrupt-2026-10-27T00-00-00.000Z.json`), 'broken');
    writeFileSync(join(dir, `${ROOM}.json.tmp`), 'half');
    writeFileSync(join(dir, 'broken.json'), '{nope');
    const out = join(base, 'snap');
    const res = snapshotDataDir(dir, out, { retryDelayMs: 0 });
    expect(res.rooms).toEqual(['broken', ROOM]);
    expect(res.failed).toEqual([]);
    // A room unreadable on disk is kept byte for byte where it was, and listed in the manifest.
    expect(res.damaged.map((r) => r.room)).toEqual(['broken']);
    expect(readFileSync(join(out, 'broken.json'), 'utf8')).toBe('{nope');
    expect(readdirSync(out).filter((f) => f.startsWith('broken.'))).toEqual(['broken.json']); // no loadRoom side files
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST), 'utf8'));
    expect(manifest.rooms).toEqual([ROOM]);
    expect(manifest.damaged).toEqual([{ room: 'broken', reason: expect.stringContaining('JSON'), sha256: { 'broken.json': sha256('{nope') } }]);
    expect(loadRoom(out, ROOM).seq).toBe(1);
    expect(readFileSync(join(out, 'backups', ROOM, '2026-10-27T00-00-00.000Z.json'), 'utf8')).toBe('{"old":1}');
    expect(readFileSync(join(out, `${ROOM}.corrupt-2026-10-27T00-00-00.000Z.json`), 'utf8')).toBe('broken');
    expect(existsSync(join(out, `${ROOM}.json.tmp`))).toBe(false);
  });

  it('a room that keeps changing past every retry fails the snapshot and leaves no copy of it (Sol recheck #1)', () => {
    const dir = join(base, 'busy');
    const out = join(base, 'busy-out');
    mkdirSync(dir);
    mkdirSync(out);
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    for (let i = 0; i < 10; i++) live.append();
    // Sol's case on every attempt: the checkpoint is read at seq a, then the server checkpoints, clears and
    // logs a+1 before the log is read (a naive pair would be checkpoint a + log starting at a+2).
    const onStep = (_room: string, step: string) => {
      if (step !== 'log') return;
      live.append();
      live.rename();
      live.clear();
      live.append();
    };
    const r = snapshotRoom(dir, ROOM, out, { onStep, retryDelayMs: 0, attempts: 5 });
    expect(r).toMatchObject({ room: ROOM, status: 'failed' });
    expect(readdirSync(out)).toEqual([]);
    // The live room itself is healthy: it is not mistaken for a damaged one.
    expect(loadRoom(dir, ROOM).seq).toBe(live.seq);

    const lines: string[] = [];
    expect(runSnapshot(dir, join(base, 'busy-out2'), { onStep, retryDelayMs: 0, attempts: 5 }, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain(`실패: ${ROOM}`);
    // Corrupt rooms alone only warn: the snapshot is still usable.
    const bad = join(base, 'bad');
    mkdirSync(bad);
    writeFileSync(join(bad, 'broken.json'), '{nope');
    expect(runSnapshot(bad, join(base, 'bad-out'), { retryDelayMs: 0 }, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-2)).toContain('경고: broken');
  });

  it('writes the copy with restrictive modes whatever the umask (Sol recheck #2)', () => {
    const dir = join(base, 'modes');
    mkdirSync(join(dir, 'backups', ROOM), { recursive: true });
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    writeFileSync(join(dir, 'backups', ROOM, '2026-10-27T00-00-00.000Z.json'), '{}', { mode: 0o666 });
    const old = process.umask(0o000);
    try {
      snapshotDataDir(dir, join(base, 'modes-out'), { retryDelayMs: 0 });
    } finally {
      process.umask(old);
    }
    const mode = (p: string) => statSync(join(base, 'modes-out', p)).mode & 0o777;
    expect(mode('.')).toBe(0o750);
    expect(mode(`${ROOM}.json`)).toBe(0o640);
    expect(mode(`${ROOM}.log.jsonl`)).toBe(0o640);
    expect(mode('backups')).toBe(0o750);
    expect(mode(`backups/${ROOM}`)).toBe(0o750);
    expect(mode(`backups/${ROOM}/2026-10-27T00-00-00.000Z.json`)).toBe(0o640);
  });

  it('a restored damaged room is refused as before (never an empty city) and preserved again by the next backup (Sol recheck2 #2)', () => {
    const dir = join(base, 'live-dmg');
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    live.append();
    writeFileSync(join(dir, 'broken.json'), '{nope');
    // A log that does not replay onto its checkpoint (gap after seq 0).
    writeCheckpoint(dir, 'badlog', 0, createEmptyDoc());
    writeFileSync(join(dir, 'badlog.log.jsonl'), '{"seq":5,"cmd":{"type":"node.add","node":{"id":"z","pos":{"x":0,"z":0}}}}\n');
    const first = snapshotDataDir(dir, join(base, 'snap1'), { retryDelayMs: 0 });
    expect(first.failed).toEqual([]);
    expect(first.damaged.map((r) => r.room)).toEqual(['badlog', 'broken']);

    // Restore = the copy becomes the data dir.
    const restored = join(base, 'restored');
    cpSync(join(base, 'snap1'), restored, { recursive: true });
    const before = { broken: readFileSync(join(restored, 'broken.json')), log: readFileSync(join(restored, 'badlog.log.jsonl')) };
    expect(() => loadRoom(restored, 'broken')).toThrow(RoomLoadError);
    expect(() => loadRoom(restored, 'badlog')).toThrow(LogCorruptedError);
    expect(readFileSync(join(restored, 'broken.json')).equals(before.broken)).toBe(true);
    expect(readFileSync(join(restored, 'badlog.log.jsonl')).equals(before.log)).toBe(true);
    const healthy = loadRoom(restored, ROOM);
    expect(healthy.seq).toBe(2);
    expect(JSON.stringify(healthy.doc)).toBe(live.states.get(2));

    // The next backup of the restored dir keeps the damaged files again, same bytes.
    const second = snapshotDataDir(restored, join(base, 'snap2'), { retryDelayMs: 0 });
    expect(second.failed).toEqual([]);
    expect(second.damaged.map((r) => [r.room, r.files])).toEqual(first.damaged.map((r) => [r.room, r.files]));
    expect(readFileSync(join(base, 'snap2', 'broken.json'), 'utf8')).toBe('{nope');
    expect(loadRoom(join(base, 'snap2'), ROOM).seq).toBe(2);
  });

  it('a storage error reading the room fails it (never "damaged")', () => {
    const dir = join(base, 'eio-src');
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    const read = (p: string): Buffer | null => {
      if (p.endsWith(`${ROOM}.json`)) throw Object.assign(new Error(`EIO: i/o error, read '${p}'`), { code: 'EIO' });
      return existsSync(p) ? readFileSync(p) : null;
    };
    const out = join(base, 'eio-src-out');
    mkdirSync(out);
    expect(snapshotRoom(dir, ROOM, out, { read, retryDelayMs: 0 })).toMatchObject({ status: 'failed', reason: expect.stringContaining('EIO') });
    expect(readdirSync(out)).toEqual([]);
    const lines: string[] = [];
    expect(runSnapshot(dir, join(base, 'eio-src-out2'), { read, retryDelayMs: 0 }, (l) => lines.push(l))).toBe(1);
  });

  it('a copy that cannot be written fails the room', () => {
    const dir = join(base, 'ro-src');
    const live = new LiveRoom(dir);
    live.rename();
    live.clear();
    live.append();
    const out = join(base, 'ro-out');
    mkdirSync(out);
    chmodSync(out, 0o500);
    try {
      expect(snapshotRoom(dir, ROOM, out, { retryDelayMs: 0 })).toMatchObject({ status: 'failed', reason: expect.stringContaining('storage error') });
    } finally {
      chmodSync(out, 0o700);
    }
  });
});
