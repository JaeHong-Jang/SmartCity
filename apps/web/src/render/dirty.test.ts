import { describe, expect, it } from 'vitest';
import type { Command } from '@smartcity/shared';
import { commandDomains, D_BUILDINGS, D_BUS_LINES, D_PARCELS, D_ROADS, D_VEHICLE_TYPES, touchesSelection } from './dirty';

const building = { id: 'b1', typeId: 'house', pos: { x: 0, z: 0 }, rotation: 0 };

describe('commandDomains', () => {
  it('classifies commands and unions batches', () => {
    expect(commandDomains({ type: 'segment.remove', id: 's' })).toBe(D_ROADS);
    expect(commandDomains({ type: 'building.remove', id: 'b' })).toBe(D_BUILDINGS);
    expect(commandDomains({ type: 'vehicleType.remove', id: 'v' })).toBe(D_VEHICLE_TYPES);
    expect(commandDomains({ type: 'busLine.remove', id: 'l' })).toBe(D_BUS_LINES);
    expect(commandDomains({ type: 'meta.update', name: 'x' })).toBe(0);
    const batch: Command = { type: 'batch', commands: [{ type: 'parcel.remove', id: 'p' }, { type: 'building.remove', id: 'b' }] };
    expect(commandDomains(batch)).toBe(D_PARCELS | D_BUILDINGS);
  });
});

describe('touchesSelection', () => {
  it('only reacts to commands that can change the selected entity', () => {
    const move: Command = { type: 'building.move', id: 'b1', pos: { x: 1, z: 1 }, rotation: 0 };
    expect(touchesSelection(move, { kind: 'building', id: 'b1' })).toBe(true);
    expect(touchesSelection(move, { kind: 'building', id: 'b2' })).toBe(false);
    expect(touchesSelection({ type: 'building.place', building: { ...building, id: 'b3' } }, { kind: 'building', id: 'b1' })).toBe(false);
    expect(touchesSelection({ type: 'parcel.remove', id: 'p1' }, { kind: 'building', id: 'b1' })).toBe(false);
    expect(touchesSelection({ type: 'parcel.remove', id: 'p1' }, { kind: 'parcel', id: 'p1' })).toBe(true);
    expect(touchesSelection({ type: 'node.move', id: 'n', pos: { x: 0, z: 0 } }, { kind: 'segment', id: 's' })).toBe(true);
    expect(touchesSelection({ type: 'node.move', id: 'n', pos: { x: 0, z: 0 } }, { kind: 'building', id: 'b1' })).toBe(false);
    expect(touchesSelection({ type: 'batch', commands: [move] }, { kind: 'building', id: 'b1' })).toBe(true);
  });
});
