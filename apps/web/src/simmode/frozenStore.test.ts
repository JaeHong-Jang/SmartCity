import { describe, expect, it } from 'vitest';
import { cloneJson } from '@smartcity/shared';
import { ClientStore } from '../app/store';
import { createFrozenView } from './frozenStore';

describe('frozen store view', () => {
  it('reports the copy while frozen, the live doc after, and asks the renderer to rebuild both times', () => {
    const real = new ClientStore('r', 'n');
    const f = createFrozenView(real);
    const resets: string[] = [];
    f.view.onReset((d) => resets.push(d.meta.name));
    const copy = cloneJson(real.getState().doc);
    copy.meta.name = 'copy';
    expect(f.view.getState().doc).toBe(real.getState().doc);

    f.freeze(copy);
    expect(f.view.getState().doc).toBe(copy);
    expect(f.view.getState().selection).toBeNull();
    const a = f.view.getState();
    expect(f.view.getState()).toBe(a); // stable between frames
    // a live change keeps the frozen doc but passes other state through
    real.set({ render: { fps: 99, drawCalls: 1, triangles: 1 } });
    expect(f.view.getState().doc).toBe(copy);
    expect(f.view.getState().render.fps).toBe(99);

    f.thaw();
    expect(f.view.getState().doc).toBe(real.getState().doc);
    expect(resets).toEqual(['copy', real.getState().doc.meta.name]);
  });

  it('passes writes through to the real store', () => {
    const real = new ClientStore('r', 'n');
    const f = createFrozenView(real);
    f.freeze(cloneJson(real.getState().doc));
    f.view.set({ simSpeed: 4 });
    expect(real.getState().simSpeed).toBe(4);
  });
});
