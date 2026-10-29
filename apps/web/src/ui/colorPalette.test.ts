import { describe, expect, it } from 'vitest';
import { loadRecent, normalizeHex, PALETTE, pushRecent, RECENT_KEY, RECENT_MAX, saveRecent } from './colorPalette';

describe('palette', () => {
  it('has 24–32 distinct named #rrggbb colors', () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(24);
    expect(PALETTE.length).toBeLessThanOrEqual(32);
    for (const s of PALETTE) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.name.length).toBeGreaterThan(0);
    }
    expect(new Set(PALETTE.map((s) => s.color)).size).toBe(PALETTE.length);
    expect(new Set(PALETTE.map((s) => s.name)).size).toBe(PALETTE.length);
  });
});

describe('HEX validation', () => {
  it('accepts 6 and 3 digit forms with or without # and normalizes to lower-case #rrggbb', () => {
    expect(normalizeHex('#A5553F')).toBe('#a5553f');
    expect(normalizeHex('a5553f')).toBe('#a5553f');
    expect(normalizeHex(' #fff ')).toBe('#ffffff');
    expect(normalizeHex('1a2')).toBe('#11aa22');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '#', '#12345', '#1234567', 'red', '#gggggg', 'rgb(1,2,3)', '##123456', '#12 456']) expect(normalizeHex(bad)).toBeNull();
  });
});

describe('recent colors', () => {
  it('puts the newest first, drops duplicates and keeps at most RECENT_MAX', () => {
    let list: string[] = [];
    for (let i = 0; i < 10; i++) list = pushRecent(list, `#00000${i}`);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe('#000009');
    list = pushRecent(list, '#000005');
    expect(list[0]).toBe('#000005');
    expect(list.filter((c) => c === '#000005')).toHaveLength(1);
    expect(list).toHaveLength(RECENT_MAX);
  });

  it('round-trips through storage and ignores junk', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveRecent(storage, ['#112233', '#445566']);
    expect(loadRecent(storage)).toEqual(['#112233', '#445566']);
    mem.set(RECENT_KEY, '{not json');
    expect(loadRecent(storage)).toEqual([]);
    mem.set(RECENT_KEY, JSON.stringify(['#ABC', 'nope', 3, '#123456']));
    expect(loadRecent(storage)).toEqual(['#aabbcc', '#123456']);
    mem.set(RECENT_KEY, JSON.stringify({ a: 1 }));
    expect(loadRecent(storage)).toEqual([]);
  });

  it('survives storage that throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadRecent(throwing)).toEqual([]);
    expect(() => saveRecent(throwing, ['#000000'])).not.toThrow();
    expect(loadRecent(undefined)).toEqual([]);
    expect(() => saveRecent(undefined, ['#000000'])).not.toThrow();
  });
});
