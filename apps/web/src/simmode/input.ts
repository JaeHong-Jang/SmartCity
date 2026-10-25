// Pointer/keyboard routing while simulator mode is active. Installed before the ToolController so its
// listeners on the same canvas never see the left button (the shared editing tools stay inert) and window
// capture listeners swallow tool shortcuts. Left-drag still pans the camera; a click picks an event target.

import type { Vec2 } from '@smartcity/shared';
import { CLICK_SLOP_PX } from '../tools/gesture';
import { PickIndex } from '../tools/picking';
import type { GroundPan } from '../tools/types';
import type { SimModeController } from './controller';
import { accidentAt, buildingAt, segmentAt } from './pick';
import { simModeStore } from './store';

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function installSimModeInput(
  canvas: HTMLElement,
  controller: SimModeController,
  pickGround: (clientX: number, clientY: number) => Vec2 | null,
  pan: GroundPan,
): () => void {
  let down: { x: number; y: number; panning: boolean } | null = null;
  let index: PickIndex | null = null;
  let indexDoc: unknown = null;

  const pickIndex = (): PickIndex | null => {
    const doc = controller.copyCityDoc();
    if (!doc) return null;
    if (indexDoc !== doc) {
      index = new PickIndex(doc);
      indexDoc = doc;
    }
    return index;
  };

  const click = (p: Vec2): void => {
    const armed = simModeStore.getState().armed;
    const idx = pickIndex();
    if (!armed || !idx) return;
    if (armed.kind === 'closure') {
      const id = segmentAt(idx, p);
      if (id) controller.placeClosure(id, armed);
    } else if (armed.kind === 'accident') {
      const graph = controller.roadGraph();
      const spot = graph && accidentAt(idx, graph, p);
      if (spot) controller.placeAccident(spot.segmentId, spot.lane, spot.s, armed);
    } else if (armed.kind === 'blackout') {
      if (armed.blackoutMode === 'area') controller.placeBlackoutArea(p.x, p.z, armed);
      else {
        const id = buildingAt(idx, p);
        if (id) controller.placeBlackoutSubstation(id, armed);
      }
    } else {
      const id = buildingAt(idx, p);
      if (!id) return;
      if (armed.kind === 'surge') controller.placeSurge(id, armed);
      else controller.placeEmergency(armed.kind, id);
    }
  };

  const onDown = (e: PointerEvent): void => {
    if (!controller.active || e.button !== 0) return;
    e.stopImmediatePropagation();
    canvas.setPointerCapture?.(e.pointerId);
    down = { x: e.clientX, y: e.clientY, panning: pan.start(e.clientX, e.clientY) };
  };
  const onMove = (e: PointerEvent): void => {
    if (!controller.active || !down) return;
    e.stopImmediatePropagation();
    if (down.panning && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= CLICK_SLOP_PX) pan.move(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent): void => {
    if (!controller.active || e.button !== 0) return;
    e.stopImmediatePropagation();
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const d = down;
    down = null;
    pan.end();
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_SLOP_PX) {
      const p = pickGround(e.clientX, e.clientY);
      if (p) click(p);
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!controller.active || isTyping()) return;
    e.stopPropagation();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
  };
}
