import type { IdGen, Vec2 } from '@smartcity/shared';
import type { Dispatch } from '../app/dispatch';
import type { ClientStore, ToolId } from '../app/store';

export interface ToolPointer {
  /** Ground position (y = 0) under the pointer. */
  pos: Vec2;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface PreviewLine {
  pts: Vec2[];
  width: number;
  color: string;
}

export interface PreviewPoint {
  pos: Vec2;
  radius: number;
  color: string;
}

export interface PreviewBuilding {
  typeId: string;
  pos: Vec2;
  rotation: number;
  ok: boolean;
}

export interface ToolPreview {
  lines: PreviewLine[];
  points: PreviewPoint[];
  building?: PreviewBuilding;
}

export const EMPTY_PREVIEW: ToolPreview = { lines: [], points: [] };

export interface ToolContext {
  store: ClientStore;
  dispatch: Dispatch;
  ids(): IdGen;
  /** The tool's preview/ghost changed; overlays and presence refresh. */
  changed(): void;
}

export interface Tool {
  id: ToolId;
  onPointerDown(e: ToolPointer): void;
  onPointerMove(e: ToolPointer): void;
  onPointerUp(e: ToolPointer): void;
  /** Pointer left the viewport: drop hover-only state (not an in-progress drawing). */
  onLeave?(): void;
  /** Return true when the key was handled. */
  onKey?(e: KeyboardEvent): boolean;
  cancel(): void;
  /** Polyline shared with collaborators as presence ghost. */
  ghost(): Vec2[];
  /** Rich local preview drawn by the overlay layer. */
  preview(): ToolPreview;
}
