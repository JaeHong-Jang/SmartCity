// Select tool: click a node / segment / building / bus stop to open it in the inspector.

import type { Vec2 } from '@smartcity/shared';
import { pickAt, type PickIndex, type PickResult } from './picking';
import { highlightPreview } from './highlight';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  private hover: PickResult | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const hit = pickAt(this.index(), e.pos);
    this.ctx.store.set({ selection: hit, panel: hit ? 'inspector' : this.ctx.store.getState().panel, phaseHighlight: null });
  }

  onPointerMove(e: ToolPointer): void {
    const hit = pickAt(this.index(), e.pos);
    if (hit?.id !== this.hover?.id || hit?.kind !== this.hover?.kind) {
      this.hover = hit;
      this.ctx.changed();
    }
    const hint = '클릭하여 도로·교차로·건물·정류장을 선택하세요';
    if (this.ctx.store.getState().toolHint !== hint) this.ctx.store.set({ toolHint: hint });
  }

  onPointerUp(): void {}

  onLeave(): void {
    this.cancel();
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.ctx.store.set({ selection: null, phaseHighlight: null });
      return true;
    }
    return false;
  }

  cancel(): void {
    this.hover = null;
    this.ctx.changed();
  }

  ghost(): Vec2[] {
    return [];
  }

  preview(): ToolPreview {
    return this.hover ? highlightPreview(this.ctx.store.getState().doc, this.index(), this.hover, '#bae6fd') : { lines: [], points: [] };
  }
}
