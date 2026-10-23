// Routes pointer/keyboard/wheel input on the viewport to the active tool and publishes presence (≤15 Hz).
// Left presses capture the pointer so drags keep working outside the canvas; G cycles the snap step.

import type { Presence, Vec2 } from '@smartcity/shared';
import type { Dispatcher } from '../app/dispatch';
import type { ClientStore, ToolId } from '../app/store';
import { BuildingTool } from './buildingTool';
import { BulldozeTool } from './bulldozeTool';
import { BusLineTool } from './busLineTool';
import { ClosureTool } from './closureTool';
import { ParcelTool } from './parcelTool';
import { Picker } from './picking';
import { RoadTool } from './roadTool';
import { SelectTool } from './selectTool';
import { StreetTool } from './streetTool';
import { CLICK_SLOP_PX } from './gesture';
import { nextSnapStep, snapLabel } from './snap';
import { TOOL_META } from './toolMeta';
import type { GroundPan, Tool, ToolContext, ToolPointer, ToolPreview } from './types';

export const TOOL_KEYS: Record<string, ToolId> = Object.fromEntries(TOOL_META.map((t) => [t.key, t.id]));
const PRESENCE_MS = 1000 / 15;
/** Keys whose keyup the tools need (modifier state, rotation batching). */
const KEYUP_CODES = new Set(['ShiftLeft', 'ShiftRight', 'BracketLeft', 'BracketRight']);

/** Camera and cursor hooks the controller needs from the renderer. */
export interface ViewHooks {
  pan: GroundPan;
  focus(p: Vec2): void;
  /** Ground point under the cursor (null = left the viewport), for the fine grid. */
  cursor(p: Vec2 | null): void;
}

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export class ToolController {
  readonly picker = new Picker();
  private tools: Record<ToolId, Tool>;
  private active: Tool;
  private lastPointer: ToolPointer | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private lastPresence = '';
  private presenceTimer: ReturnType<typeof setInterval>;
  private unsub: () => void;
  private lastDocVersion: number;
  private lastSnap: number;
  private lastStreetMode: string;

  constructor(
    private readonly store: ClientStore,
    dispatcher: Dispatcher,
    private readonly dom: HTMLElement,
    private readonly pickGround: (clientX: number, clientY: number) => Vec2 | null,
    private readonly onPreview: (p: ToolPreview) => void,
    private readonly sendPresence: (p: Presence) => void,
    private readonly view: ViewHooks,
  ) {
    const index = () => {
      const s = this.store.getState();
      return this.picker.get(s.doc, s.docVersion);
    };
    const ctx: ToolContext = {
      store,
      dispatch: dispatcher.dispatch,
      ids: () => dispatcher.ids(),
      changed: () => this.onPreview(this.active.preview()),
      pan: view.pan,
      focus: (p) => view.focus(p),
    };
    this.tools = {
      select: new SelectTool(ctx, index),
      road: new RoadTool(ctx),
      building: new BuildingTool(ctx, index),
      bulldoze: new BulldozeTool(ctx, index),
      busLine: new BusLineTool(ctx, index),
      closure: new ClosureTool(ctx, index),
      parcel: new ParcelTool(ctx),
      street: new StreetTool(ctx, index),
    };
    this.active = this.tools[store.getState().tool];
    this.lastDocVersion = store.getState().docVersion;
    this.lastSnap = store.getState().toolOptions.snapStep;
    this.lastStreetMode = store.getState().toolOptions.streetMode;

    dom.addEventListener('pointerdown', this.down);
    dom.addEventListener('pointermove', this.move);
    dom.addEventListener('pointerup', this.up);
    dom.addEventListener('pointercancel', this.cancel);
    dom.addEventListener('pointerleave', this.leave);
    // Capture phase: runs before camera-controls' wheel zoom on the same element.
    dom.addEventListener('wheel', this.wheel, { capture: true, passive: false });
    window.addEventListener('keydown', this.key);
    window.addEventListener('keyup', this.key);
    this.unsub = store.subscribe(this.onStore);
    this.presenceTimer = setInterval(this.publishPresence, PRESENCE_MS);
  }

  private onStore = (): void => {
    const s = this.store.getState();
    if (s.tool !== this.active.id) {
      this.active.cancel();
      this.active = this.tools[s.tool];
      this.store.set({ toolHint: '' });
      if (this.lastPointer) this.active.onPointerMove(this.lastPointer);
      this.onPreview(this.active.preview());
    }
    if (s.docVersion !== this.lastDocVersion || s.toolOptions.snapStep !== this.lastSnap || s.toolOptions.streetMode !== this.lastStreetMode) {
      this.lastDocVersion = s.docVersion;
      this.lastSnap = s.toolOptions.snapStep;
      this.lastStreetMode = s.toolOptions.streetMode;
      // The doc or the snap step changed under the cursor: refresh snapping and validity.
      if (this.lastPointer) this.active.onPointerMove(this.lastPointer);
    }
  };

  private pointer(e: PointerEvent): ToolPointer | null {
    const pos = this.pickGround(e.clientX, e.clientY);
    if (!pos) return null;
    return { pos, client: { x: e.clientX, y: e.clientY }, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
  }

  private down = (e: PointerEvent): void => {
    if (e.button === 2) {
      this.rightDown = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const p = this.pointer(e);
    if (!p) return;
    // Alt+drag must not trigger the browser's own Alt handling.
    if (e.altKey) e.preventDefault();
    this.dom.setPointerCapture?.(e.pointerId);
    this.lastPointer = p;
    this.active.onPointerDown(p);
  };

  private move = (e: PointerEvent): void => {
    const p = this.pointer(e);
    if (!p) return;
    this.lastPointer = { ...p, button: -1 };
    this.view.cursor(p.pos);
    this.active.onPointerMove(p);
  };

  private cancel = (e: PointerEvent): void => {
    if (this.dom.hasPointerCapture?.(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.active.cancel();
  };

  private wheel = (e: WheelEvent): void => {
    if (this.active.onWheel?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private up = (e: PointerEvent): void => {
    if (e.button === 2 && this.rightDown) {
      const moved = Math.hypot(e.clientX - this.rightDown.x, e.clientY - this.rightDown.y);
      this.rightDown = null;
      // A right click without dragging cancels; a drag pans the camera.
      if (moved < CLICK_SLOP_PX && !this.active.onSecondaryClick?.()) this.active.cancel();
      return;
    }
    if (this.dom.hasPointerCapture?.(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    const p = this.pointer(e);
    if (p) this.active.onPointerUp(p);
  };

  private leave = (): void => {
    this.lastPointer = null;
    this.view.cursor(null);
    this.active.onLeave?.();
  };

  private key = (e: KeyboardEvent): void => {
    if (isTyping()) return;
    if (e.type === 'keydown' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = TOOL_KEYS[e.key];
      if (t) {
        this.store.set({ tool: t });
        e.preventDefault();
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        const step = nextSnapStep(this.store.getState().toolOptions.snapStep);
        this.store.setToolOptions({ snapStep: step });
        this.store.toast(`격자 스냅: ${snapLabel(step)}`, 'info', 'snap');
        e.preventDefault();
        return;
      }
    }
    if (e.type === 'keyup' && !KEYUP_CODES.has(e.code)) return;
    if (this.active.onKey?.(e)) e.preventDefault();
  };

  private publishPresence = (): void => {
    const s = this.store.getState();
    if (!s.ready || s.connection === 'offline') return;
    const sel = s.selection?.id ?? null;
    const presence: Presence = { cursor: this.lastPointer?.pos ?? null, tool: this.active.id, ghost: this.active.ghost(), selection: sel };
    const key = JSON.stringify(presence);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    this.sendPresence(presence);
  };

  dispose(): void {
    clearInterval(this.presenceTimer);
    this.unsub();
    this.dom.removeEventListener('pointerdown', this.down);
    this.dom.removeEventListener('pointermove', this.move);
    this.dom.removeEventListener('pointerup', this.up);
    this.dom.removeEventListener('pointercancel', this.cancel);
    this.dom.removeEventListener('pointerleave', this.leave);
    this.dom.removeEventListener('wheel', this.wheel, { capture: true });
    window.removeEventListener('keydown', this.key);
    window.removeEventListener('keyup', this.key);
  }
}
