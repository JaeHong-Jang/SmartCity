// Click vs drag: a press becomes a drag once the pointer travels CLICK_SLOP_PX screen pixels.

export const CLICK_SLOP_PX = 5;

export type GesturePhase = 'idle' | 'pressed' | 'dragging' | 'cancelled';

export class DragGesture {
  phase: GesturePhase = 'idle';
  private x = 0;
  private y = 0;

  constructor(private readonly slop = CLICK_SLOP_PX) {}

  down(x: number, y: number): void {
    this.phase = 'pressed';
    this.x = x;
    this.y = y;
  }

  /** Returns true exactly once: on the move that turns the press into a drag. */
  move(x: number, y: number): boolean {
    if (this.phase !== 'pressed') return false;
    if (Math.hypot(x - this.x, y - this.y) < this.slop) return false;
    this.phase = 'dragging';
    return true;
  }

  /** Ends the gesture; returns what it was ('pressed' = a click). */
  up(): GesturePhase {
    const p = this.phase;
    this.phase = 'idle';
    return p;
  }

  /** Esc / pointercancel: ignore the rest of this press. */
  cancel(): void {
    if (this.phase !== 'idle') this.phase = 'cancelled';
  }
}
