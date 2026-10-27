// The deployment scripts in deploy/ (Sol deploy review #1–#3), run locally with stand-ins for curl and
// systemctl where they would touch the machine.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, createEmptyDoc } from '@smartcity/shared';
import type { Command } from '@smartcity/shared';
import { appendLog, loadRoom, RoomLoadError, writeCheckpoint } from './persistence.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const deploy = (f: string) => join(repo, 'deploy', f);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sc-deploy-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('smartcity.service refuses to start without an invite password (#1)', () => {
  const unit = readFileSync(deploy('smartcity.service'), 'utf8');

  it('sets SC_REQUIRE_INVITE=1, checks the password before every start and does not restart a refused start', () => {
    expect(unit).toMatch(/^Environment=SC_REQUIRE_INVITE=1$/m);
    expect(unit).toMatch(/^ExecStartPre=\/bin\/sh -c '.*SC_INVITE_CODE.*'$/m);
    expect(unit).toMatch(/^RestartPreventExitStatus=78$/m);
    // The env file comes after Environment= (it may override it, the template keeps it at 1).
    expect(readFileSync(deploy('setup.sh'), 'utf8')).toMatch(/^SC_REQUIRE_INVITE=1$/m);
  });

  it('its ExecStartPre (as systemd runs it: $$ → $) fails for an empty or blank password only', () => {
    const script = /^ExecStartPre=\/bin\/sh -c '(.*)'$/m.exec(unit)![1]!.replaceAll('$$', '$');
    const run = (code: string | undefined) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      if (code !== undefined) env.SC_INVITE_CODE = code;
      return spawnSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' });
    };
    for (const blank of [undefined, '', '   ', '\t ']) {
      const r = run(blank);
      expect(r.status, JSON.stringify(blank)).toBe(78);
      expect(r.stderr).toContain('SC_INVITE_CODE is empty');
    }
    for (const ok of ['x', ' open sesame ', 'a$b*c']) expect(run(ok).status, ok).toBe(0);
  });

  it('the server itself exits 78 with a clear line when SC_REQUIRE_INVITE=1 and the password is blank', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      cwd: repo,
      env: { PATH: process.env.PATH, PORT: '0', DATA_DIR: join(tmp, 'data'), SC_REQUIRE_INVITE: '1', SC_INVITE_CODE: '  ', SC_AI_FAKE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toContain('SC_REQUIRE_INVITE=1 but SC_INVITE_CODE is empty');
    expect(r.stdout).not.toContain('listening');
  }, 40_000);
});

describe('update.sh fails closed when it cannot count connected users (#3)', () => {
  /** Runs check_clients with fake curl/systemctl; returns exit status and output. */
  function check(o: { active: boolean; curlExit?: number; body?: string; force?: boolean }) {
    const bin = join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\n[ "$FAKE_ACTIVE" = 1 ]\n');
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nif [ "$FAKE_CURL_EXIT" != 0 ]; then echo "curl: (28) Operation timed out" >&2; exit "$FAKE_CURL_EXIT"; fi\nprintf "%s" "$FAKE_BODY"\n');
    chmodSync(join(bin, 'systemctl'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(tmp, 'env'), 'PORT=8799\n');
    const r = spawnSync('bash', ['-c', `source "$1"; ENV_FILE="$2"; force=$3; check_clients; echo PROCEED`, 'bash', deploy('update.sh'), join(tmp, 'env'), o.force ? '1' : '0'], {
      env: { PATH: `${bin}:${process.env.PATH}`, FAKE_ACTIVE: o.active ? '1' : '0', FAKE_CURL_EXIT: String(o.curlExit ?? 0), FAKE_BODY: o.body ?? '' },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr, proceeds: r.stdout.includes('PROCEED') };
  }

  it('a running server whose /health times out (curl 28) stops the update; --force goes on', () => {
    const r = check({ active: true, curlExit: 28 });
    expect(r.status).toBe(2);
    expect(r.proceeds).toBe(false);
    expect(r.out).toContain('접속자 수를 확인하지 못했습니다');
    expect(check({ active: true, curlExit: 28, force: true }).proceeds).toBe(true);
  });

  it('an unparsable answer stops it too', () => {
    for (const body of ['', 'oops', '{"ok":false,"clients":0}', '{"ok":true,"rooms":1}', '<html>502</html>']) {
      const r = check({ active: true, body });
      expect(r.status, body).toBe(2);
      expect(r.proceeds, body).toBe(false);
    }
  });

  it('goes on only for a parsed 0 or a stopped service; connected users stop it unless --force', () => {
    expect(check({ active: true, body: '{"ok":true,"rooms":0,"clients":0}' }).proceeds).toBe(true);
    expect(check({ active: false, curlExit: 7 }).proceeds).toBe(true);
    const busy = check({ active: true, body: '{"ok":true,"rooms":1,"clients":3}' });
    expect(busy.status).toBe(2);
    expect(busy.out).toContain('접속자 3명');
    expect(check({ active: true, body: '{"ok":true,"rooms":1,"clients":3}', force: true }).proceeds).toBe(true);
  });
});

describe('backup.sh archives a consistent copy of the data dir (#2, rechecks)', () => {
  const runBackup = (env: Record<string, string>) =>
    spawnSync('bash', ['-c', 'umask 022; exec bash "$0"', deploy('backup.sh')], {
      env: { PATH: process.env.PATH!, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('writes YYYY-MM-DD.tar.gz: rooms load with every logged edit, a damaged room stays refused, manifest, modes 750/640', () => {
    const data = join(tmp, 'smartcity');
    const doc = createEmptyDoc();
    writeCheckpoint(data, 'main', 0, doc);
    for (let s = 1; s <= 3; s++) {
      const cmd: Command = { type: 'node.add', node: { id: `n${s}`, pos: { x: s * 10, z: 0 } } };
      expect(applyCommand(doc, cmd).ok).toBe(true);
      appendLog(data, 'main', s, JSON.stringify(cmd));
    }
    mkdirSync(join(data, 'backups', 'main'), { recursive: true });
    writeFileSync(join(data, 'backups', 'main', '2026-10-27T00-00-00.000Z.json'), '{}');
    writeFileSync(join(data, 'broken.json'), '{nope');
    const backups = join(tmp, 'backups');
    const r = runBackup({ DATA_DIR: data, BACKUP_DIR: backups, APP_DIR: repo });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('경고: broken');
    const archives = readdirSync(backups);
    expect(archives).toHaveLength(1); // staging and temp files are gone
    expect(archives[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.tar\.gz$/);
    const restore = join(tmp, 'restore');
    mkdirSync(restore);
    expect(spawnSync('tar', ['-xpzf', join(backups, archives[0]!), '-C', restore]).status).toBe(0);
    const root = join(restore, 'smartcity');
    const room = loadRoom(root, 'main');
    expect(room.seq).toBe(3);
    expect(Object.keys(room.doc.nodes).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(readdirSync(join(root, 'backups', 'main')).length).toBeGreaterThanOrEqual(1);
    // The damaged room is where it was, byte for byte: the restored server refuses it as the live one did.
    expect(readFileSync(join(root, 'broken.json'), 'utf8')).toBe('{nope');
    expect(() => loadRoom(root, 'broken')).toThrow(RoomLoadError);
    expect(readFileSync(join(root, 'broken.json'), 'utf8')).toBe('{nope');
    expect(JSON.parse(readFileSync(join(root, 'BACKUP-MANIFEST.json'), 'utf8')).damaged.map((d: { room: string }) => d.room)).toEqual(['broken']);
    expect(existsSync(join(root, 'unverified'))).toBe(false);
    const mode = (p: string) => statSync(join(root, p)).mode & 0o777;
    for (const d of ['.', 'backups', 'backups/main']) expect(mode(d), d).toBe(0o750);
    for (const f of ['main.json', 'main.log.jsonl', 'broken.json', 'BACKUP-MANIFEST.json']) expect(mode(f), f).toBe(0o640);
    expect(statSync(join(backups, archives[0]!)).mode & 0o777).toBe(0o600);
  }, 70_000);

  it('a failed snapshot keeps every existing archive: no replace, no rotation, exit 1, no leftovers', () => {
    // Stand-in for the snapshot step failing (a room that kept changing past every retry; that decision
    // itself is tested in snapshot.test.ts): writes part of a copy, then exits 1.
    const app = join(tmp, 'app');
    mkdirSync(join(app, 'apps', 'server', 'src'), { recursive: true });
    symlinkSync(join(repo, 'node_modules'), join(app, 'node_modules'));
    writeFileSync(join(app, 'apps', 'server', 'src', 'snapshotMain.ts'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync(process.argv[3]!, { recursive: true });\nwriteFileSync(`${process.argv[3]}/main.json`, 'partial');\nconsole.error('실패: main');\nprocess.exit(1);\n");
    const data = join(tmp, 'smartcity');
    mkdirSync(data);
    const backups = join(tmp, 'backups');
    mkdirSync(backups);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const names = [today, ...Array.from({ length: 15 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`)].map((d) => `${d}.tar.gz`);
    for (const n of names) writeFileSync(join(backups, n), `old ${n}`);
    const r = runBackup({ DATA_DIR: data, BACKUP_DIR: backups, APP_DIR: app });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('백업 실패');
    expect(readdirSync(backups).sort()).toEqual([...names].sort()); // 16 > KEEP: nothing rotated, nothing left over
    for (const n of names) expect(readFileSync(join(backups, n), 'utf8')).toBe(`old ${n}`);
  }, 70_000);
});
