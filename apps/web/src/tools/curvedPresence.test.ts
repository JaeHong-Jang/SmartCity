// Sol P5d review #2: the presence ghost of a rounded building must stay a valid client message.
// 80 × 80 m with round 40 gave 65 points (> MAX_GHOST_POINTS), parseClientMessage returned null and the
// server closes a socket after 20 malformed messages.
import { describe, expect, it, vi } from 'vitest';
import { applyCommand, buildingFootprints, createEmptyDoc, IdGen, MAX_GHOST_POINTS, parseClientMessage, type BuildingType } from '@smartcity/shared';
import { ClientStore } from '../app/store';
import { closedRing } from '../app/ring';
import { BuildingTool } from './buildingTool';
import { PickIndex } from './picking';
import { ghostPolyline } from './selectTool';
import type { ToolContext, ToolPointer } from './types';

function tower(size: number): BuildingType {
  const house = createEmptyDoc().buildingTypes.house!;
  return { ...house, id: `tower${size}`, name: 'tower', parts: [{ ...house.parts[0]!, width: size, depth: size, roof: 'flat', round: size / 2 }] };
}

function presenceOf(ghost: { x: number; z: number }[]): string {
  return JSON.stringify({ t: 'presence', presence: { cursor: { x: 0, z: 0 }, tool: 'building', ghost, selection: null } });
}

describe('presence ghosts of rounded buildings', () => {
  // 80 m is Sol's repro; 300 m (round 150, 32 chords per corner = 128 corners) is the largest allowed.
  it.each([80, 300])('the building tool ghost of a %i m round tower parses', (size) => {
    const store = new ClientStore('main', '나');
    const doc = createEmptyDoc();
    const t = tower(size);
    expect(applyCommand(doc, { type: 'buildingType.upsert', buildingType: t }).ok).toBe(true);
    store.receive({ t: 'welcome', clientId: 'me', tag: 'T', color: '#ff0000', room: 'main', seq: 0, doc, peers: [] });
    store.setToolOptions({ buildingTypeId: t.id });
    const ctx: ToolContext = { store, dispatch: vi.fn(() => 1), ids: () => new IdGen('T'), changed: () => {}, pan: { start: () => true, move: () => {}, end: () => {} }, focus: () => {} };
    const tool = new BuildingTool(ctx, () => new PickIndex(store.getState().doc));
    const at: ToolPointer = { pos: { x: 0, z: -400 }, client: { x: 0, y: 0 }, button: 0, shift: true, ctrl: false, alt: false };
    tool.onPointerMove(at);
    const ghost = tool.ghost();
    const full = closedRing(buildingFootprints({ pos: { x: 0, z: -400 }, rotation: 0 }, doc.buildingTypes[t.id]!)[0]!);
    expect(full.length).toBeGreaterThan(MAX_GHOST_POINTS);
    expect(ghost.length).toBeLessThanOrEqual(MAX_GHOST_POINTS);
    // Still the closed outline (first = last), thinned evenly.
    expect(ghost[0]).toEqual(full[0]);
    expect(ghost.at(-1)).toEqual(full.at(-1));
    expect(parseClientMessage(presenceOf(ghost))).not.toBeNull();
  });

  it('a select-tool drag ghost of the largest round tower parses', () => {
    const t = tower(300);
    const ghost = ghostPolyline(buildingFootprints({ pos: { x: 0, z: 0 }, rotation: 0.3 }, t).map(closedRing));
    expect(parseClientMessage(presenceOf(ghost))).not.toBeNull();
  });
});
