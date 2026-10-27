// Sol deploy recheck2 #1: a storage error on the backup's own copy must fail the backup, never make a
// healthy room look damaged. node:fs is wrapped so reads of the staging checkpoint fail with EIO.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyDoc } from '@smartcity/shared';
import type { Command } from '@smartcity/shared';

/** Reads of `<dir…>/city.json` fail (every staging copy of this test lives under `dir`). */
const fail = vi.hoisted(() => ({ dir: '', onlyUtf8: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((p: Parameters<typeof fs.readFileSync>[0], opts?: unknown) => {
    if (fail.dir && String(p).startsWith(fail.dir) && String(p).endsWith('/city.json') && (!fail.onlyUtf8 || opts === 'utf8')) throw Object.assign(new Error(`EIO: i/o error, read '${String(p)}'`), { code: 'EIO', errno: -5 });
    return (fs.readFileSync as (p: unknown, o?: unknown) => unknown)(p, opts);
  }) as typeof fs.readFileSync;
  return { ...fs, readFileSync, default: { ...fs, readFileSync } };
});

const { appendLog, loadRoom, writeCheckpoint } = await import('./persistence.js');
const { runSnapshot, snapshotDataDir } = await import('./snapshot.js');

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sc-snapshot-eio-'));
});
afterEach(() => {
  fail.dir = '';
  rmSync(base, { recursive: true, force: true });
});

function healthyRoom(dir: string): void {
  const doc = createEmptyDoc();
  writeCheckpoint(dir, 'city', 0, doc);
  const cmd: Command = { type: 'node.add', node: { id: 'n1', pos: { x: 1, z: 2 } } };
  expect(applyCommand(doc, cmd).ok).toBe(true);
  appendLog(dir, 'city', 1, JSON.stringify(cmd));
}

describe('backup snapshot under storage errors', () => {
  for (const onlyUtf8 of [false, true]) {
    it(`EIO reading the staging checkpoint (${onlyUtf8 ? "loadRoom's read only" : 'every read'}) fails the backup; the room is not called damaged`, () => {
      const dir = join(base, 'data');
      healthyRoom(dir);
      const out = join(base, 'out');
      fail.dir = join(base, 'out'); // out and out2
      fail.onlyUtf8 = onlyUtf8;
      const lines: string[] = [];
      expect(runSnapshot(dir, out, { retryDelayMs: 0 }, (l) => lines.push(l))).toBe(1);
      expect(lines.join('\n')).toMatch(/실패: city — 사본을 만들지 못함: storage error/);
      expect(lines.join('\n')).not.toContain('경고');
      const res = snapshotDataDir(dir, join(base, 'out2'), { retryDelayMs: 0 });
      expect(res.damaged).toEqual([]);
      fail.dir = '';
      // The live room was healthy all along.
      expect(loadRoom(dir, 'city').seq).toBe(1);
      expect(JSON.parse(readFileSync(join(base, 'out2', 'BACKUP-MANIFEST.json'), 'utf8')).damaged).toEqual([]);
    });
  }
});
