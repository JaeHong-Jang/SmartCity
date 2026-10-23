// City-builder camera: left button is reserved for tools, right drag pans over the ground,
// middle drag rotates, wheel zooms toward the cursor. Keyboard: WASD/arrows pan, Q/E rotate, R/F zoom.

import * as THREE from 'three';
import CameraControls from 'camera-controls';

CameraControls.install({ THREE });

export const MIN_DISTANCE = 20;
export const MAX_DISTANCE = 2500;

const keys = new Set<string>();
const tmpTarget = new THREE.Vector3();

export interface CityCamera {
  camera: THREE.PerspectiveCamera;
  controls: CameraControls;
  /** Advance damping and keyboard motion; returns true while the camera moves. */
  update(dt: number): boolean;
  dispose(): void;
}

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

export function createCityCamera(dom: HTMLElement, halfSize: number): CityCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 12000);
  const controls = new CameraControls(camera, dom);
  controls.mouseButtons.left = CameraControls.ACTION.NONE;
  controls.mouseButtons.right = CameraControls.ACTION.SCREEN_PAN;
  controls.mouseButtons.middle = CameraControls.ACTION.ROTATE;
  controls.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
  controls.touches.one = CameraControls.ACTION.TOUCH_SCREEN_PAN;
  controls.touches.two = CameraControls.ACTION.TOUCH_DOLLY_ROTATE;
  controls.dollyToCursor = true;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.minPolarAngle = 0.05;
  // Never look from below the ground.
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.smoothTime = 0.12;
  controls.draggingSmoothTime = 0.06;
  controls.dollySpeed = 0.6;
  controls.setBoundary(new THREE.Box3(new THREE.Vector3(-halfSize - 200, 0, -halfSize - 200), new THREE.Vector3(halfSize + 200, 0, halfSize + 200)));
  controls.setLookAt(-180, 260, 260, 0, 0, 0, false);

  const down = (e: KeyboardEvent): void => {
    if (isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    keys.add(e.code);
  };
  const up = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const blur = (): void => keys.clear();
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  const noMenu = (e: Event): void => e.preventDefault();
  dom.addEventListener('contextmenu', noMenu);

  return {
    camera,
    controls,
    update(dt: number): boolean {
      if (keys.size > 0 && !isTyping()) {
        const dist = controls.distance;
        const pan = dist * 1.1 * dt;
        let fx = 0;
        let fz = 0;
        if (keys.has('KeyW') || keys.has('ArrowUp')) fz += 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) fz -= 1;
        if (keys.has('KeyD') || keys.has('ArrowRight')) fx += 1;
        if (keys.has('KeyA') || keys.has('ArrowLeft')) fx -= 1;
        if (fx !== 0) controls.truck(fx * pan, 0, true);
        if (fz !== 0) controls.forward(fz * pan, true);
        if (keys.has('KeyQ')) controls.rotate(-1.4 * dt, 0, true);
        if (keys.has('KeyE')) controls.rotate(1.4 * dt, 0, true);
        if (keys.has('KeyR')) controls.dolly(dist * 1.5 * dt, true);
        if (keys.has('KeyF')) controls.dolly(-dist * 1.5 * dt, true);
      }
      const moved = controls.update(dt);
      // Depth precision: scale the near plane with zoom so thin road layers never z-fight.
      const near = Math.min(60, Math.max(0.5, controls.distance * 0.02));
      if (Math.abs(near - camera.near) > 0.01) {
        camera.near = near;
        camera.far = Math.max(6000, controls.distance * 6);
        camera.updateProjectionMatrix();
      }
      // Keep the orbit target on the ground plane.
      controls.getTarget(tmpTarget);
      if (Math.abs(tmpTarget.y) > 0.01) controls.setTarget(tmpTarget.x, 0, tmpTarget.z, false);
      return moved;
    },
    dispose(): void {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      dom.removeEventListener('contextmenu', noMenu);
      controls.dispose();
    },
  };
}
