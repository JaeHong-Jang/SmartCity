// Bulldoze: hover highlights, click removes a road segment, building or bus stop.

import type { Command, Vec2 } from '@smartcity/shared';
import { highlightPreview } from './highlight';
import { pickAt, type PickIndex, type PickResult } from './picking';
import type { Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export class BulldozeTool implements Tool {
  readonly id = 'bulldoze' as const;
  private hover: PickResult | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly index: () => PickIndex,
  ) {}

  private pick(p: Vec2): PickResult | null {
    return pickAt(this.index(), p, { nodes: false });
  }

  onPointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    const hit = this.pick(e.pos);
    if (!hit) return;
    const prev = highlightPreview(this.ctx.store.getState().doc, this.index(), hit, '#ef4444');
    let cmd: Command | null = null;
    if (hit.kind === 'segment') cmd = { type: 'segment.remove', id: hit.id };
    else if (hit.kind === 'building') cmd = { type: 'building.remove', id: hit.id };
    else if (hit.kind === 'busStop') cmd = { type: 'busStop.remove', id: hit.id };
    if (cmd) this.ctx.dispatch(cmd, prev.lines.map((l) => l.pts));
    this.hover = null;
    this.ctx.changed();
  }

  onPointerMove(e: ToolPointer): void {
    const hit = this.pick(e.pos);
    if (hit?.id !== this.hover?.id) {
      this.hover = hit;
      this.ctx.changed();
    }
    const label = hit ? { segment: '도로', building: '건물', busStop: '정류장', node: '교차점' }[hit.kind] : null;
    const hint = label ? `클릭하면 ${label}을(를) 철거합니다` : '철거할 도로·건물·정류장 위에 올려 두세요';
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
    return this.hover ? highlightPreview(this.ctx.store.getState().doc, this.index(), this.hover, '#ef4444') : { lines: [], points: [] };
  }
}
