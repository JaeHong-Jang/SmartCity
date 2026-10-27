import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCommand, createEmptyDoc, DOC_VERSION, docProblem, normalizeDoc } from '@smartcity/shared';
import type { CityDoc, Command } from '@smartcity/shared';

export interface LoadedRoom {
  doc: CityDoc;
  seq: number;
  /**
   * No checkpoint of the current DOC_VERSION on disk (none yet, or an older version that was migrated in
   * memory). Such a room must write a checkpoint before it logs any command: a server of the older
   * version would otherwise replay the new commands onto its own doc and silently drop what it does not
   * know (e.g. `round`, Sol P5d #1); a current-version checkpoint makes it refuse the room instead.
   */
  stale: boolean;
  /** The checkpoint on disk is of an older DOC_VERSION (migrated in memory). */
  migrated: boolean;
}

interface Checkpoint {
  schema: 1;
  seq: number;
  doc: CityDoc;
}

// Room ids are validated against ROOM_ID_RE before reaching here, so joining paths is safe.
const logPath = (dir: string, room: string) => join(dir, `${room}.log.jsonl`);
const checkpointPath = (dir: string, room: string) => join(dir, `${room}.json`);

// Log files whose directory exists and whose size we track, so appends skip mkdir/exists/stat.
// Absent = unknown: the next append prepares the directory and stats the file again.
const knownLogSize = new Map<string, number>();

/** Shown to clients when a room's checkpoint cannot be loaded. */
export const ROOM_UNREADABLE = '도시 파일을 읽을 수 없습니다 — 관리자 확인 필요';

/**
 * The room's checkpoint exists but cannot be served (unreadable, or written by a newer server).
 * The room is refused instead of starting empty, so a later checkpoint can never overwrite the file.
 */
export class RoomLoadError extends Error {}

/** `Date` as an ISO time that is also a valid file name on Windows (no colons). */
const fileStamp = (d: Date): string => d.toISOString().replace(/:/g, '-');

function readCheckpoint(cp: string): Checkpoint {
  const parsed = JSON.parse(readFileSync(cp, 'utf8')) as Checkpoint;
  const doc = parsed?.doc as unknown;
  if (parsed?.schema !== 1 || !Number.isInteger(parsed.seq) || parsed.seq < 0) throw new Error('not a checkpoint');
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc) || typeof (doc as CityDoc).version !== 'number' || (doc as CityDoc).version < 1) {
    throw new Error('checkpoint has no doc');
  }
  return parsed;
}

/** Keep a copy of an unreadable checkpoint next to it, named by its modification time (once per version of the file). */
function preserveCorrupt(dir: string, room: string, cp: string): void {
  try {
    const copy = join(dir, `${room}.corrupt-${fileStamp(statSync(cp).mtime)}.json`);
    if (existsSync(copy)) return;
    copyFileSync(cp, copy, constants.COPYFILE_EXCL);
    console.error(`[persist] ${room}: unreadable checkpoint preserved as ${copy}`);
  } catch (e) {
    console.error(`[persist] ${room}: could not preserve the unreadable checkpoint (${(e as Error).message})`);
  }
}

export function loadRoom(dir: string, room: string): LoadedRoom {
  knownLogSize.delete(logPath(dir, room));
  let doc: CityDoc | null = null;
  let seq = 0;
  let migrated = false;
  const cp = checkpointPath(dir, room);
  if (existsSync(cp)) {
    let parsed: Checkpoint;
    try {
      parsed = readCheckpoint(cp);
    } catch (e) {
      // Starting empty here would let the next checkpoint replace the city: refuse the room.
      console.error(`[persist] ${room}: bad checkpoint, room refused (${(e as Error).message})`);
      preserveCorrupt(dir, room, cp);
      // The cause tells a read error (errno) from bad contents (the backup snapshot needs the difference).
      throw new RoomLoadError(ROOM_UNREADABLE, { cause: e });
    }
    if (parsed.doc.version > DOC_VERSION) {
      console.error(`[persist] ${room}: checkpoint doc v${parsed.doc.version} is newer than v${DOC_VERSION}, room refused`);
      throw new RoomLoadError('이 도시 파일은 더 새로운 버전의 서버가 만들었습니다 — 관리자 확인 필요');
    }
    migrated = parsed.doc.version < DOC_VERSION;
    let problem: string | null;
    try {
      doc = normalizeDoc(parsed.doc);
      problem = docProblem(doc);
    } catch (e) {
      problem = `does not migrate: ${(e as Error).message}`;
    }
    if (problem) {
      // E.g. `nodes: []` would accept edits that the next checkpoint silently drops.
      console.error(`[persist] ${room}: checkpoint doc is malformed, room refused (${problem})`);
      preserveCorrupt(dir, room, cp);
      throw new RoomLoadError(ROOM_UNREADABLE);
    }
    seq = parsed.seq;
  }
  if (!doc) doc = createEmptyDoc();

  const lp = logPath(dir, room);
  if (existsSync(lp)) seq = replayLog(lp, room, doc, seq);
  return { doc, seq, stale: migrated || !existsSync(cp), migrated };
}

/** The log could not be restored to a record boundary; the room must stop accepting writes. */
export class LogCorruptedError extends Error {}

/**
 * Replay log records newer than `seq` into `doc` and repair the file in place so the next append
 * starts on a record boundary. Only the damaged tail is ever cut; valid records are never rewritten.
 * Appends produce strictly increasing seqs, contiguous after the checkpoint, of commands the server
 * already applied once. Anything else (a malformed or blank record before the last line, a seq out
 * of order, a gap, a command that does not replay) throws LogCorruptedError with the file untouched:
 * opening the room anyway would let the next checkpoint clear the log and lose what it held.
 */
function replayLog(lp: string, room: string, doc: CityDoc, seq: number): number {
  const buf = readFileSync(lp);
  let pos = 0;
  let last = -Infinity;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    let entry: { seq: number; cmd: Command };
    try {
      entry = JSON.parse(buf.subarray(pos, end).toString('utf8'));
    } catch {
      // A crash mid-write leaves a partial last record, always without its newline (records are
      // written whole, newline last). Any other damage is not something appends produce, so refuse
      // to guess rather than drop records.
      if (nl !== -1) {
        throw new LogCorruptedError(`${room}: log damaged at byte ${pos}, manual repair needed`);
      }
      console.error(`[persist] ${room}: dropping partial record at byte ${pos}`);
      truncateSync(lp, pos);
      return seq;
    }
    const bad = (why: string) => new LogCorruptedError(`${room}: log record at byte ${pos} ${why}, manual repair needed`);
    if (typeof entry !== 'object' || entry === null || !Number.isInteger(entry.seq) || typeof entry.cmd !== 'object' || entry.cmd === null) {
      throw bad('is not a {seq, cmd} record');
    }
    if (entry.seq <= last) throw bad(`has seq ${entry.seq} after ${last}`);
    last = entry.seq;
    // Records up to the checkpoint's seq were written before it (the log clear failed): skip them.
    if (entry.seq > seq) {
      if (entry.seq !== seq + 1) throw bad(`skips from seq ${seq} to ${entry.seq}`);
      // Already accepted by this server: replay under the rules it was accepted with.
      let res: ReturnType<typeof applyCommand>;
      try {
        res = applyCommand(doc, entry.cmd, { trusted: true });
      } catch (e) {
        res = { ok: false, error: (e as Error).message };
      }
      if (!res.ok) throw bad(`(seq ${entry.seq}) does not replay: ${res.error}`);
      seq = entry.seq;
    }
    if (nl === -1) {
      // Complete record without its newline: terminate it so the next append cannot glue onto it.
      appendFileSync(lp, '\n');
      return seq;
    }
    pos = nl + 1;
  }
  return seq;
}

/**
 * Append one record. `cmdJson` is the already-serialized command. On failure the file is cut back
 * to its previous length so a partial write never leaves a broken record behind.
 */
export function appendLog(dir: string, room: string, seq: number, cmdJson: string): void {
  const lp = logPath(dir, room);
  let before = knownLogSize.get(lp);
  if (before === undefined) {
    mkdirSync(dir, { recursive: true });
    before = existsSync(lp) ? statSync(lp).size : 0;
  }
  const line = `{"seq":${seq},"cmd":${cmdJson}}\n`;
  try {
    appendFileSync(lp, line);
    knownLogSize.set(lp, before + Buffer.byteLength(line));
  } catch (e) {
    knownLogSize.delete(lp);
    try {
      truncateSync(lp, before);
    } catch {
      throw new LogCorruptedError(`${room}: append failed and the log could not be restored`);
    }
    throw e;
  }
}

const KEEP_RECENT = 30;
const KEEP_DAYS = 14;
const DAY_MS = 86_400_000;
/** `<UTC ISO with '-' for ':'>[-<n>][.prewipe].json`; `-<n>` tells apart backups made in the same millisecond. */
const BACKUP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)(?:-(\d+))?(\.prewipe)?\.json$/;

interface BackupName {
  file: string;
  day: string;
  at: number;
  n: number;
  prewipe: boolean;
}

export const backupDir = (dir: string, room: string): string => join(dir, 'backups', room);

/** Backups in `bdir`, newest first (by time, then collision number). Other files are ignored. */
function listBackups(bdir: string): BackupName[] {
  const out: BackupName[] = [];
  for (const file of readdirSync(bdir)) {
    const m = BACKUP_RE.exec(file);
    if (!m) continue;
    out.push({ file, day: m[1]!, at: Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`), n: m[5] ? Number(m[5]) : 0, prewipe: !!m[6] });
  }
  return out.sort((a, b) => b.at - a.at || b.n - a.n);
}

/**
 * Retention: the newest KEEP_RECENT backups, plus the newest backup of each UTC day of the last
 * KEEP_DAYS days. `.prewipe` backups (taken before a checkpoint that emptied the city) are kept for KEEP_DAYS days.
 */
export function pruneBackups(bdir: string, now: Date): void {
  const files = listBackups(bdir);
  const keep = new Set(files.filter((f) => !f.prewipe).slice(0, KEEP_RECENT).map((f) => f.file));
  const days = new Set<string>();
  for (const f of files) {
    if (now.getTime() - f.at > KEEP_DAYS * DAY_MS) continue;
    if (f.prewipe) keep.add(f.file);
    else if (!days.has(f.day)) {
      days.add(f.day);
      keep.add(f.file);
    }
  }
  for (const f of files) if (!keep.has(f.file)) unlinkSync(join(bdir, f.file));
}

/**
 * Copy the current checkpoint to `backups/<room>/<time>.json` (skipped when it equals the newest
 * backup, unless `prewipe`), then apply the retention policy. Copies never replace a file: a name
 * already taken gets the next `-<n>` suffix.
 */
export function backupCheckpoint(dir: string, room: string, now: Date, prewipe = false): void {
  const cp = checkpointPath(dir, room);
  if (!existsSync(cp)) return;
  const bdir = backupDir(dir, room);
  mkdirSync(bdir, { recursive: true });
  const newest = listBackups(bdir)[0]?.file;
  const same = newest !== undefined && statSync(join(bdir, newest)).size === statSync(cp).size && readFileSync(join(bdir, newest)).equals(readFileSync(cp));
  if (!same || prewipe) {
    for (let n = 0; ; n++) {
      const name = `${fileStamp(now)}${n ? `-${n}` : ''}${prewipe ? '.prewipe' : ''}.json`;
      try {
        copyFileSync(cp, join(bdir, name), constants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 999) throw e;
      }
    }
  }
  pruneBackups(bdir, now);
}

/**
 * Atomic checkpoint (tmp + rename), then clear the log. The file it replaces is backed up first;
 * a failed backup is logged and never blocks the checkpoint.
 */
/**
 * Write the checkpoint atomically (tmp + rename, previous file backed up) and reset the log. With
 * `keepLog` the log is left as it is: replay skips its records up to `seq`, so this only re-stamps the
 * file (used to put a current-version checkpoint on disk before a room logs its first command).
 */
export function writeCheckpoint(dir: string, room: string, seq: number, doc: CityDoc, prewipe = false, keepLog = false): void {
  mkdirSync(dir, { recursive: true });
  const cp = checkpointPath(dir, room);
  const tmp = `${cp}.tmp`;
  const body: Checkpoint = { schema: 1, seq, doc };
  const lp = logPath(dir, room);
  knownLogSize.delete(lp);
  writeFileSync(tmp, JSON.stringify(body));
  try {
    backupCheckpoint(dir, room, new Date(), prewipe);
  } catch (e) {
    console.error(`[persist] ${room}: backup failed (${(e as Error).message})`);
  }
  renameSync(tmp, cp);
  if (keepLog) return;
  writeFileSync(lp, '');
  knownLogSize.set(lp, 0);
}
