import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCommand, createEmptyDoc, normalizeDoc } from '@smartcity/shared';
import type { CityDoc, Command } from '@smartcity/shared';

export interface LoadedRoom {
  doc: CityDoc;
  seq: number;
}

interface Checkpoint {
  schema: 1;
  seq: number;
  doc: CityDoc;
}

// Room ids are validated against ROOM_ID_RE before reaching here, so joining paths is safe.
const logPath = (dir: string, room: string) => join(dir, `${room}.log.jsonl`);
const checkpointPath = (dir: string, room: string) => join(dir, `${room}.json`);

export function loadRoom(dir: string, room: string): LoadedRoom {
  let doc: CityDoc | null = null;
  let seq = 0;
  const cp = checkpointPath(dir, room);
  if (existsSync(cp)) {
    try {
      const parsed = JSON.parse(readFileSync(cp, 'utf8')) as Checkpoint;
      if (parsed.schema === 1 && Number.isInteger(parsed.seq) && parsed.doc) {
        doc = normalizeDoc(parsed.doc);
        seq = parsed.seq;
      }
    } catch (e) {
      console.error(`[persist] ${room}: bad checkpoint, replaying log only (${(e as Error).message})`);
    }
  }
  if (!doc) doc = createEmptyDoc();

  const lp = logPath(dir, room);
  if (existsSync(lp)) seq = replayLog(lp, room, doc, seq);
  return { doc, seq };
}

/** The log could not be restored to a record boundary; the room must stop accepting writes. */
export class LogCorruptedError extends Error {}

/**
 * Replay log records newer than `seq` into `doc` and repair the file in place so the next append
 * starts on a record boundary. Only the damaged tail is ever cut; valid records are never rewritten.
 */
function replayLog(lp: string, room: string, doc: CityDoc, seq: number): number {
  const buf = readFileSync(lp);
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    let entry: { seq: number; cmd: Command } | null = null;
    try {
      entry = end > pos ? JSON.parse(buf.subarray(pos, end).toString('utf8')) : null;
    } catch {
      // A crash mid-write leaves a partial last record. Damage followed by more data is not
      // something appends produce, so refuse to guess rather than drop later records.
      if (nl !== -1 && buf.subarray(nl + 1).toString('utf8').trim() !== '') {
        throw new LogCorruptedError(`${room}: log damaged at byte ${pos}, manual repair needed`);
      }
      console.error(`[persist] ${room}: dropping partial record at byte ${pos}`);
      truncateSync(lp, pos);
      return seq;
    }
    if (entry && Number.isInteger(entry.seq) && entry.seq > seq) {
      // Already accepted by this server: replay under the rules it was accepted with.
      const res = applyCommand(doc, entry.cmd, { trusted: true });
      if (res.ok) seq = entry.seq;
      else console.error(`[persist] ${room}: replay of seq ${entry.seq} failed: ${res.error}`);
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
  mkdirSync(dir, { recursive: true });
  const lp = logPath(dir, room);
  const before = existsSync(lp) ? statSync(lp).size : 0;
  try {
    appendFileSync(lp, `{"seq":${seq},"cmd":${cmdJson}}\n`);
  } catch (e) {
    try {
      truncateSync(lp, before);
    } catch {
      throw new LogCorruptedError(`${room}: append failed and the log could not be restored`);
    }
    throw e;
  }
}

/** Atomic checkpoint (tmp + rename), then clear the log. */
export function writeCheckpoint(dir: string, room: string, seq: number, doc: CityDoc): void {
  mkdirSync(dir, { recursive: true });
  const cp = checkpointPath(dir, room);
  const tmp = `${cp}.tmp`;
  const body: Checkpoint = { schema: 1, seq, doc };
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, cp);
  writeFileSync(logPath(dir, room), '');
}
