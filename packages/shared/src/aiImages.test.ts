import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, createEmptyDoc, docToCommands, DOC_VERSION, MAX_AI_IMAGE_BYTES, parseClientMessage, type BuildingType } from './index.js';

/** Base64 of `bytes` zero bytes. */
const b64 = (bytes: number): string => 'A'.repeat(Math.floor(bytes / 3) * 4) + ['', 'AA==', 'AAA='][bytes % 3]!;
const ask = (extra: Record<string, unknown>): string => JSON.stringify({ t: 'ai.ask', reqId: 1, text: '비슷하게 지어줘', focus: null, ...extra });
const img = (data: string, mediaType = 'image/jpeg') => ({ mediaType, data });

describe('ai.ask images (protocol)', () => {
  it('accepts text only and up to two images', () => {
    expect(parseClientMessage(ask({}))).toMatchObject({ t: 'ai.ask', text: '비슷하게 지어줘' });
    const one = parseClientMessage(ask({ images: [img(b64(1000))] }));
    expect(one).toMatchObject({ t: 'ai.ask', images: [{ mediaType: 'image/jpeg' }] });
    expect(parseClientMessage(ask({ images: [img(b64(1000)), img(b64(900), 'image/webp')] }))).not.toBeNull();
    expect(parseClientMessage(ask({ images: [img(b64(10), 'image/png')] }))).not.toBeNull();
  });

  it('rejects three images, an empty list, and a bad media type', () => {
    expect(parseClientMessage(ask({ images: [img(b64(10)), img(b64(10)), img(b64(10))] }))).toBeNull();
    expect(parseClientMessage(ask({ images: [] }))).toBeNull();
    expect(parseClientMessage(ask({ images: [img(b64(10), 'image/gif')] }))).toBeNull();
    expect(parseClientMessage(ask({ images: [img(b64(10), 'text/html')] }))).toBeNull();
    expect(parseClientMessage(ask({ images: 'x' }))).toBeNull();
  });

  it('rejects data that is not base64 or is a data: URL', () => {
    for (const data of ['', 'abc', 'AAAA AAAA', 'data:image/png;base64,AAAA', 'AA=A', '@@@@']) {
      expect(parseClientMessage(ask({ images: [img(data)] }))).toBeNull();
    }
  });

  it('limits one image to 300,000 decoded bytes and the frame to 512 KB', () => {
    expect(parseClientMessage(ask({ images: [img(b64(MAX_AI_IMAGE_BYTES))] }))).not.toBeNull();
    expect(parseClientMessage(ask({ images: [img(b64(MAX_AI_IMAGE_BYTES + 1))] }))).toBeNull();
    // Two images that are each fine but together exceed the frame limit.
    expect(parseClientMessage(ask({ images: [img(b64(MAX_AI_IMAGE_BYTES)), img(b64(MAX_AI_IMAGE_BYTES))] }))).toBeNull();
  });

  it('still requires text: the client fills the default sentence for picture-only requests', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ai.ask', reqId: 1, text: '  ', focus: null, images: [img(b64(10))] }))).toBeNull();
  });
});

describe('BuildingType.origin', () => {
  const design = (extra: Partial<BuildingType> = {}): BuildingType => ({
    id: 'd1',
    name: 'AI 설계',
    zone: 'office',
    parts: [{ offset: { x: 0, z: 0 }, width: 8, depth: 8, floors: 3, floorHeight: 3.2, baseHeight: 0, roof: 'flat', color: '#888888', roofColor: '#555555' }],
    ...extra,
  });

  it('is kept by apply and the docToCommands replay, and old designs load unchanged', () => {
    const doc = createEmptyDoc();
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: design({ origin: 'ai' }), expectedRev: 0 })).toEqual({ ok: true });
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: { ...design(), id: 'd2' }, expectedRev: 0 })).toEqual({ ok: true });
    expect(doc.buildingTypes.d1!.origin).toBe('ai');
    expect('origin' in doc.buildingTypes.d2!).toBe(false);
    const replay = createEmptyDoc();
    for (const c of docToCommands(cloneJson(doc))) expect(applyCommand(replay, c)).toEqual({ ok: true });
    expect(replay.buildingTypes.d1!.origin).toBe('ai');
    expect('origin' in replay.buildingTypes.d2!).toBe(false);
    expect(replay.version).toBe(DOC_VERSION);
  });

  it('refuses any other origin and survives an edit that resends it', () => {
    const doc = createEmptyDoc();
    const bad = applyCommand(doc, { type: 'buildingType.upsert', buildingType: design({ origin: 'user' as 'ai' }), expectedRev: 0 });
    expect(bad.ok).toBe(false);
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: design({ origin: 'ai' }), expectedRev: 0 })).toEqual({ ok: true });
    const edited = { ...cloneJson(doc.buildingTypes.d1!), name: '고침' };
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: edited, expectedRev: 1 })).toEqual({ ok: true });
    expect(doc.buildingTypes.d1!.origin).toBe('ai');
  });
});
