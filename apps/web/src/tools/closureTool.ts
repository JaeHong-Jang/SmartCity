// Closure tool: click a road segment to close or reopen it.

import type { Vec2 } from '@smartcity/shared';
import { highlightPreview } from './highlight';
import type { PickIndex } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export class ClosureTool implements Tool {
  readonly id = 'closure' as const;
  private hover: string | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const hit = this.index().nearestSegment(e.pos);
    if (!hit) return;
    const doc = this.ctx.store.getState().doc;
    const closed = hit.id in doc.closures;
    this.ctx.dispatch(closed ? { type: 'closure.remove', segmentId: hit.id } : { type: 'closure.set', closure: { segmentId: hit.id, reason: '도로 폐쇄' } }, [hit.curve]);
  }

  onPointerMove(e: ToolPointer): void {
    const hit = this.index().nearestSegment(e.pos);
    const id = hit?.id ?? null;
    if (id !== this.hover) {
      this.hover = id;
      this.ctx.changed();
    }
    const closed = id ? id in this.ctx.store.getState().doc.closures : false;
    const hint = id ? (closed ? '클릭하면 도로를 다시 엽니다' : '클릭하면 도로를 폐쇄합니다') : '폐쇄하거나 다시 열 도로를 클릭하세요';
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerUp(): void {}

  onLeave(): void {
    this.cancel();
  }

  cancel(): void {
    this.hover = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    return [];
  }

  preview(): ToolPreview {
    if (!this.hover) return { lines: [], points: [] };
    const closed = this.hover in this.ctx.store.getState().doc.closures;
    return highlightPreview(this.ctx.store.getState().doc, this.index(), { kind: 'segment', id: this.hover }, closed ? '#4ade80' : '#f97316');
  }
}
