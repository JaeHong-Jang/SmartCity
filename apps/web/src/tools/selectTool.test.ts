import { describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyDoc, IdGen } from '@smartcity/shared';
import { ClientStore } from '../app/store';
import { PickIndex } from './picking';
import { SelectTool } from './selectTool';
import type { ToolContext, ToolPointer } from './types';

function setup() {
  const store = new ClientStore('main', '나');
  const doc = createEmptyDoc();
  store.receive({ t: 'welcome', clientId: 'me', tag: 'T', color: '#ff0000', room: 'main', seq: 0, doc, peers: [] });
  store.receive({ t: 'applied', seq: 1, cmd: { type: 'building.place', building: { id: 'b1', typeId: 'house', pos: { x: 40, z: 40 }, rotation: 0 } }, by: 'other' });
  const dispatch = vi.fn(() => 1);
  const ctx: ToolContext = {
    store,
    dispatch,
    ids: () => new IdGen('T'),
    changed: () => {},
    pan: { start: () => true, move: () => {}, end: () => {} },
    focus: () => {},
  };
  const tool = new SelectTool(ctx, () => new PickIndex(store.getState().doc));
  const at = (x: number, z: number, cx: number): ToolPointer => ({ pos: { x, z }, client: { x: cx, y: 0 }, button: 0, shift: false, ctrl: false, alt: false });
  return { store, tool, dispatch, at };
}

describe('SelectTool with remote edits (Sol review 2026-10-23 #1)', () => {
  it('drops a drag whose building was deleted by someone else before the drag started', () => {
    const { store, tool, dispatch, at } = setup();
    tool.onPointerDown(at(40, 40, 0));
    store.receive({ t: 'applied', seq: 2, cmd: { type: 'building.remove', id: 'b1' }, by: 'other' });
    expect(() => tool.onPointerMove(at(60, 40, 50))).not.toThrow();
    tool.onPointerUp(at(60, 40, 50));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('drops a drag whose building is deleted mid-drag', () => {
    const { store, tool, dispatch, at } = setup();
    tool.onPointerDown(at(40, 40, 0));
    tool.onPointerMove(at(50, 40, 50));
    store.receive({ t: 'applied', seq: 2, cmd: { type: 'building.remove', id: 'b1' }, by: 'other' });
    expect(() => tool.onPointerMove(at(60, 40, 80))).not.toThrow();
    tool.onPointerUp(at(60, 40, 80));
    expect(dispatch).not.toHaveBeenCalled();
    expect(applyCommand(store.getState().doc, { type: 'building.remove', id: 'b1' }).ok).toBe(false);
  });
});
