// Consistent copy of a live data directory for the daily backup (deploy/backup.sh), taken while the
// server keeps running. A plain tar can pair an old checkpoint with a log the server has since
// cleared, and the restore then lacks edits that were already approved (Sol deploy review #2).
//
// Per room: checkpoint (C0), log (L), checkpoint again (C1), log again (L2). The copy is (C1, L) when
// C0 == C1 and L is a byte prefix of L2:
// - the checkpoint did not change while the log was read, so L is a state of the log at a time the
//   checkpoint on disk was C1: either the log after C1's clear (records C1.seq+1 .. a, contiguous) or,
//   in the moment between C1's rename and the clear, the older log whose records are all ≤ C1.seq and
//   skipped on replay (writeCheckpoint renames, then clears, with no append in between);
// - L being a prefix of L2 shows no clear happened during or right after the read, so L is not a mix
//   of old and new bytes (a clear followed by new records would start with a different seq).
// A partial last record is fine: loadRoom drops it, as after a crash. Every copy is then loaded with
// the real loadRoom. An inconsistent read or a load failure is retried with backoff.
//
// Outcomes (Sol deploy rechecks #1–#3):
// - A storage error anywhere (reading the room, writing or reading the copy, errno inside loadRoom)
//   fails the room, and so the whole backup: it says nothing about the data.
// - Only a data validation failure (bad JSON or doc, newer version, a log that does not replay) seen
//   twice on identical, unchanging bytes marks the room damaged. Its files are kept byte for byte at
//   their usual paths, so a restored server refuses the room exactly as the live one did (an unreadable
//   save is not "no save", ADR 0011) and the next backup preserves them again. BACKUP-MANIFEST.json
//   lists such rooms with the reason and the files' sha256.
// - A room that never yields a consistent copy fails the backup.

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOM_ID_RE } from '@smartcity/shared';
import { loadRoom, LogCorruptedError, RoomLoadError } from './persistence.js';

export interface SnapshotOptions {
  /** Read a file whole, or null when it does not exist (tests inject races here). */
  read?: (path: string) => Buffer | null;
  /** Called before every read step of a room (tests run live writes here). */
  onStep?: (room: string, step: 'cp0' | 'log' | 'cp1' | 'log2') => void;
  attempts?: number;
  /** First retry delay; doubled per attempt up to MAX_RETRY_DELAY_MS, plus jitter (0 = no waiting, tests). */
  retryDelayMs?: number;
}

/**
 * - ok: a consistent, loadable checkpoint + log pair is in `out`.
 * - damaged: the room's files do not validate as they sit on disk (the server refuses the room too);
 *   they are copied byte for byte to their usual paths and listed in the manifest.
 * - failed: a storage error, or the room kept changing while it was copied. The backup must fail.
 */
export type RoomSnapshot =
  | { room: string; status: 'ok' }
  | { room: string; status: 'failed'; reason: string }
  /** `files`: name → sha256 of the bytes kept. */
  | { room: string; status: 'damaged'; reason: string; files: Record<string, string> };
type Damaged = Extract<RoomSnapshot, { status: 'damaged' }>;
type Failed = Extract<RoomSnapshot, { status: 'failed' }>;

export interface SnapshotResult {
  rooms: string[];
  damaged: Damaged[];
  failed: Failed[];
}

/** At the copy's root. Upper case: never a room id (ROOM_ID_RE), so the server and later snapshots ignore it as a room. */
export const MANIFEST = 'BACKUP-MANIFEST.json';
const MAX_RETRY_DELAY_MS = 3000;
/** Modes of the copy, whatever the umask: the data root is 750 on the server (Sol deploy recheck #2). */
const DIR_MODE = 0o750;
const FILE_MODE = 0o640;

const readOrNull = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

const same = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b));
const isPrefix = (a: Buffer | null, b: Buffer | null): boolean => a === null || (b !== null && b.length >= a.length && b.subarray(0, a.length).equals(a));

const sleep = (ms: number): void => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A storage error (errno) anywhere in the error or its causes. */
function storageError(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x instanceof Error && depth < 8; x = x.cause, depth++) {
    if (typeof (x as NodeJS.ErrnoException).code === 'string') return true;
  }
  return false;
}

/** The files' contents do not validate (as opposed to a storage error or a bug). */
const dataError = (e: unknown): boolean => (e instanceof LogCorruptedError || e instanceof RoomLoadError) && !storageError(e);

/** Write the pair to `out` and read it back: a copy that does not come back byte for byte is a storage error. */
function put(out: string, room: string, c: Buffer | null, l: Buffer | null): void {
  for (const [name, data] of [[`${room}.json`, c], [`${room}.log.jsonl`, l]] as const) {
    const p = join(out, name);
    rmSync(p, { force: true });
    if (!data) continue;
    writeFileSync(p, data, { mode: FILE_MODE });
    if (!readFileSync(p).equals(data)) throw Object.assign(new Error(`${p}: copy reads back different`), { code: 'EBADCOPY' });
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Copy one room's checkpoint and log from `dir` into `out` as a consistent pair (see the file comment). */
export function snapshotRoom(dir: string, room: string, out: string, opts: SnapshotOptions = {}): RoomSnapshot {
  const read = opts.read ?? readOrNull;
  const step = opts.onStep ?? (() => {});
  const attempts = opts.attempts ?? 12;
  const delay = opts.retryDelayMs ?? 100;
  const cp = join(dir, `${room}.json`);
  const lp = join(dir, `${room}.log.jsonl`);
  let why = '';
  /** The last consistent, unchanging pair that did not validate: the same bytes twice = damaged on disk. */
  let invalid: { c: Buffer | null; l: Buffer | null } | null = null;
  try {
    for (let i = 0; i < attempts; i++) {
      if (i > 0 && delay > 0) sleep(Math.min(MAX_RETRY_DELAY_MS, delay * 2 ** (i - 1)) + Math.random() * delay);
      step(room, 'cp0');
      const c0 = read(cp);
      step(room, 'log');
      const log = read(lp);
      step(room, 'cp1');
      const c1 = read(cp);
      step(room, 'log2');
      const log2 = read(lp);
      if (!same(c0, c1) || !isPrefix(log, log2)) {
        why = 'the room kept changing while it was copied';
        continue;
      }
      put(out, room, c1, log);
      try {
        // Same check the server makes when it opens the room (it may only drop a partial last record).
        loadRoom(out, room);
        return { room, status: 'ok' };
      } catch (e) {
        if (!dataError(e)) throw e;
        why = (e as Error).message + ((e as Error).cause instanceof Error ? ` (${((e as Error).cause as Error).message})` : '');
        // loadRoom keeps a copy of an unreadable checkpoint next to it: not part of this backup's copy.
        for (const f of readdirSync(out)) if (f.startsWith(`${room}.corrupt-`)) rmSync(join(out, f), { force: true });
        if (invalid && same(invalid.c, c1) && same(invalid.l, log) && same(log, log2)) {
          // The files exactly as on disk (loadRoom may have cut a partial record from the copy).
          put(out, room, c1, log);
          const files: Record<string, string> = {};
          if (c1) files[`${room}.json`] = sha256(c1);
          if (log) files[`${room}.log.jsonl`] = sha256(log);
          return { room, status: 'damaged', reason: why, files };
        }
        put(out, room, null, null);
        invalid = same(log, log2) ? { c: c1, l: log } : null;
      }
    }
  } catch (e) {
    try {
      put(out, room, null, null);
    } catch {
      // The backup fails anyway; the staging copy is thrown away.
    }
    return { room, status: 'failed', reason: `storage error: ${(e as Error).message}` };
  }
  return { room, status: 'failed', reason: why };
}

/** Make every directory under `root` (itself included) 750 and every file 640. */
function restrictModes(root: string): void {
  chmodSync(root, DIR_MODE);
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) restrictModes(p);
    else chmodSync(p, FILE_MODE);
  }
}

/**
 * Copy `dataDir` into `out` (created): every room as a consistent checkpoint + log pair (damaged rooms
 * byte for byte), everything else (the server's own `backups/`, preserved corrupt files) as it is, and
 * MANIFEST. `*.tmp` files and an older MANIFEST are skipped. Directories end up 750, files 640.
 */
export function snapshotDataDir(dataDir: string, out: string, opts: SnapshotOptions = {}): SnapshotResult {
  mkdirSync(out, { recursive: true, mode: DIR_MODE });
  const rooms = new Set<string>();
  const roomFile = /^(.+?)(\.json|\.log\.jsonl)$/;
  for (const name of readdirSync(dataDir)) {
    const m = roomFile.exec(name);
    if (m && ROOM_ID_RE.test(m[1]!)) rooms.add(m[1]!);
  }
  const results = [...rooms].sort().map((room) => snapshotRoom(dataDir, room, out, opts));
  for (const name of readdirSync(dataDir)) {
    const m = roomFile.exec(name);
    if ((m && rooms.has(m[1]!)) || name.endsWith('.tmp') || name === MANIFEST) continue;
    const src = join(dataDir, name);
    const dst = join(out, name);
    if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true, filter: (s) => !s.endsWith('.tmp') });
    else if (existsSync(src)) copyFileSync(src, dst);
  }
  const damaged = results.filter((r): r is Damaged => r.status === 'damaged');
  const failed = results.filter((r): r is Failed => r.status === 'failed');
  const manifest = {
    note: 'damaged = files that do not validate as they were on disk (the server refuses these rooms); kept byte for byte at their usual paths',
    rooms: results.filter((r) => r.status === 'ok').map((r) => r.room),
    damaged: damaged.map(({ room, reason, files }) => ({ room, reason, sha256: files })),
  };
  writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: FILE_MODE });
  restrictModes(out);
  return { rooms: [...rooms].sort(), damaged, failed };
}

/**
 * The backup's snapshot step (snapshotMain.ts): 0 = usable (damaged rooms only warn), 1 = a room could
 * not be copied (storage error, or it kept changing), so no archive may be made from `out`.
 */
export function runSnapshot(dataDir: string, out: string, opts: SnapshotOptions = {}, log: (line: string) => void = console.error): number {
  let res: SnapshotResult;
  try {
    res = snapshotDataDir(dataDir, out, opts);
  } catch (e) {
    log(`실패: 데이터 디렉터리를 복사하지 못함: ${(e as Error).message}`);
    return 1;
  }
  for (const r of res.damaged) log(`경고: ${r.room} — 서버도 읽을 수 없는 방(거부됨). 원래 파일 그대로 보존, ${MANIFEST}에 기록: ${r.reason}`);
  for (const r of res.failed) log(`실패: ${r.room} — 사본을 만들지 못함: ${r.reason}`);
  log(`스냅샷: 방 ${res.rooms.length}개, 손상(보존) ${res.damaged.length}개, 실패 ${res.failed.length}개`);
  return res.failed.length ? 1 : 0;
}
