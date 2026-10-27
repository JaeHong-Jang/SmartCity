import { describe, expect, it } from 'vitest';
import { MAX_INVITE_LENGTH, parseClientMessage, PROTOCOL_VERSION } from './index.js';

const hello = (extra: Record<string, unknown>): string => JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'main', name: 'me', ...extra });

describe('hello invite password (protocol)', () => {
  it('keeps a hello without invite as before', () => {
    expect(parseClientMessage(hello({}))).toStrictEqual({ t: 'hello', protocol: PROTOCOL_VERSION, room: 'main', name: 'me' });
  });

  it('carries an invite up to the length limit', () => {
    expect(parseClientMessage(hello({ invite: 'open sesame' }))).toMatchObject({ t: 'hello', invite: 'open sesame' });
    expect(parseClientMessage(hello({ invite: 'x'.repeat(MAX_INVITE_LENGTH) }))).not.toBeNull();
    expect(parseClientMessage(hello({ invite: '' }))).toMatchObject({ invite: '' });
  });

  it('rejects an invite that is too long or not a string', () => {
    expect(parseClientMessage(hello({ invite: 'x'.repeat(MAX_INVITE_LENGTH + 1) }))).toBeNull();
    expect(parseClientMessage(hello({ invite: 1234 }))).toBeNull();
    expect(parseClientMessage(hello({ invite: null }))).toBeNull();
    expect(parseClientMessage(hello({ invite: ['a'] }))).toBeNull();
  });
});
