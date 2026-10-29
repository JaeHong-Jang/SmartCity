import { describe, expect, it } from 'vitest';
import { CLICK_SLOP_PX, DragGesture } from './gesture';

// Right press in the ToolController: 'pressed' on release = a click (cancels the tool), anything else
// = camera work (rotate, Shift = pan).
describe('click vs drag', () => {
  it('a release where it was pressed, or a jitter under the slop, is a click', () => {
    const g = new DragGesture();
    g.down(100, 100);
    expect(g.move(103, 102)).toBe(false);
    expect(g.up()).toBe('pressed');
  });

  it('moving CLICK_SLOP_PX or more is a drag', () => {
    const g = new DragGesture();
    g.down(0, 0);
    expect(g.move(CLICK_SLOP_PX, 0)).toBe(true);
    expect(g.up()).toBe('dragging');
  });

  it('a round trip (80 px out and back to the start) stays a drag', () => {
    const g = new DragGesture();
    g.down(200, 200);
    for (let x = 200; x <= 280; x += 10) g.move(x, 200);
    for (let x = 280; x >= 200; x -= 10) g.move(x, 200);
    expect(g.up()).toBe('dragging');
  });

  it('a cancelled press is not a click, and the next press starts fresh', () => {
    const g = new DragGesture();
    g.down(0, 0);
    g.cancel();
    expect(g.up()).toBe('cancelled');
    expect(g.phase).toBe('idle');
    g.down(0, 0);
    expect(g.up()).toBe('pressed');
  });
});
