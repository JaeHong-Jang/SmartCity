import { describe, expect, it } from 'vitest';
import { AUTH_LIMITED, AUTH_NEEDED, AUTH_WRONG, InviteGate, inviteConfigError } from './invite.js';

describe('InviteGate', () => {
  it('admits only the exact code; a missing one is not counted as a guess', () => {
    const g = new InviteGate('Seoul-2026', { maxFailures: 2, windowMs: 1000 }, () => 0);
    expect(g.check('a', 'Seoul-2026')).toBeNull();
    for (const bad of ['seoul-2026', 'Seoul-2026 ', 'Seoul-202', '', 'x'.repeat(128)]) expect(new InviteGate('Seoul-2026').check('a', bad)).toBe(AUTH_WRONG);
    for (let i = 0; i < 5; i++) expect(g.check('a', undefined)).toBe(AUTH_NEEDED);
    expect(g.check('a', 'Seoul-2026')).toBeNull();
  });

  it('refuses an address after too many wrong codes until the window passes, without comparing', () => {
    let now = 0;
    const g = new InviteGate('right', { maxFailures: 3, windowMs: 1000 }, () => now);
    for (let i = 0; i < 3; i++) expect(g.check('ip1', 'wrong')).toBe(AUTH_WRONG);
    expect(g.check('ip1', 'right')).toBe(AUTH_LIMITED);
    expect(g.check('ip1', undefined)).toBe(AUTH_LIMITED);
    expect(g.check('ip2', 'right')).toBeNull();
    now = 999;
    expect(g.check('ip1', 'right')).toBe(AUTH_LIMITED);
    now = 1000;
    expect(g.check('ip1', 'right')).toBeNull();
  });
});

describe('inviteConfigError (SC_REQUIRE_INVITE, Sol deploy review #1)', () => {
  it('is fatal only when the deployment requires a password and it is missing or blank', () => {
    for (const code of [undefined, '', '   ', '\t\n']) expect(inviteConfigError({ SC_REQUIRE_INVITE: '1', SC_INVITE_CODE: code })).toMatch(/SC_INVITE_CODE is empty/);
    expect(inviteConfigError({ SC_REQUIRE_INVITE: '1', SC_INVITE_CODE: 'x' })).toBeNull();
    // Dev and tests (unset): the password stays optional.
    for (const code of [undefined, '', 'x']) expect(inviteConfigError({ SC_INVITE_CODE: code })).toBeNull();
    expect(inviteConfigError({ SC_REQUIRE_INVITE: '0' })).toBeNull();
  });
});
