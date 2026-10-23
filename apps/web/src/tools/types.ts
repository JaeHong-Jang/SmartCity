import type { IdGen, Vec2 } from '@smartcity/shared';
import type { Dispatch } from '../app/dispatch';
import type { ClientStore, ToolId } from '../app/store';

export interface ToolPointer {
  /** Ground position (y = 0) under the pointer. */
  pos: Vec2;
  /** Client-space pixel position (click vs drag threshold, camera pan). */
  client: { x: number; y: number };
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
  /** Ghost tint: green/blue = ok, orange = regulation warning, red = blocked. */
  color: string;
}

export interface ToolPreview {
  lines: PreviewLine[];
  points: PreviewPoint[];
  building?: PreviewBuilding;
}

/** Left-drag camera pan over the ground plane: the point under the cursor stays under the cursor. */
export interface GroundPan {
  start(clientX: number, clientY: number): boolean;
  move(clientX: number, clientY: number): void;
  end(): void;
}

export interface ToolContext {
  store: ClientStore;
  dispatch: Dispatch;
  ids(): IdGen;
  /** The tool's preview/ghost changed; overlays and presence refresh. */
  changed(): void;
  pan: GroundPan;
  /** Fly the camera to a point. */
  focus(p: Vec2): void;
}

export interface Tool {
  id: ToolId;
  onPointerDown(e: ToolPointer): void;
  onPointerMove(e: ToolPointer): void;
  onPointerUp(e: ToolPointer): void;
  /** Pointer left the viewport: drop hover-only state (not an in-progress drawing). */
  onLeave?(): void;
  /** Right click without drag: return true when handled (otherwise the tool is cancelled). */
  onSecondaryClick?(): boolean;
  /** Return true when the key was handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Return true to consume the wheel event (the camera does not zoom). */
  onWheel?(e: WheelEvent): boolean;
  cancel(): void;
  /** Polyline shared with collaborators as presence ghost. */
  ghost(): Vec2[];
  /** Rich local preview drawn by the overlay layer. */
  preview(): ToolPreview;
}
