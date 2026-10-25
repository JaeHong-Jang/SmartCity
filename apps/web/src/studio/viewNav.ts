// Pure camera-navigation logic of the building studio: named views -> angles, key -> action, and the
// V cycle. "front" is the road side (+z, the orange arrow): camera-controls azimuth 0 looks from +z.

export type ViewName = 'front' | 'right' | 'back' | 'left' | 'top' | 'home';

/** Views reachable with the V key, in order (home is only the Home key / "전체" button). */
export const VIEW_CYCLE: readonly ViewName[] = ['front', 'right', 'back', 'left', 'top'];

export const VIEW_LABEL: Record<ViewName, string> = { front: '앞(도로 쪽)', right: '오른쪽', back: '뒤', left: '왼쪽', top: '위', home: '전체' };

const SIDE_POLAR = (70 * Math.PI) / 180;

/** Target angles in radians; `home` has none (the scene frames the whole design). */
export function viewAngles(view: Exclude<ViewName, 'home'>): { azimuth: number; polar: number } {
  switch (view) {
    case 'front':
      return { azimuth: 0, polar: SIDE_POLAR };
    case 'right':
      return { azimuth: Math.PI / 2, polar: SIDE_POLAR };
    case 'back':
      return { azimuth: Math.PI, polar: SIDE_POLAR };
    case 'left':
      return { azimuth: -Math.PI / 2, polar: SIDE_POLAR };
    case 'top':
      return { azimuth: 0, polar: 0 };
  }
}

/** Next view of the V cycle; anything not in the cycle (null, home) starts at the front. */
export function nextView(current: ViewName | null): Exclude<ViewName, 'home'> {
  const i = current ? VIEW_CYCLE.indexOf(current) : -1;
  return VIEW_CYCLE[(i + 1) % VIEW_CYCLE.length] as Exclude<ViewName, 'home'>;
}

/** Tool shortcut digit (1-6) of a key, by `code` so only the top-row digits count, never the numpad. */
export function toolDigit(code: string): string | null {
  const m = /^Digit([1-6])$/.exec(code);
  return m ? m[1]! : null;
}

/** A pointer press that only moves the camera (Shift+right drag pan, Alt+left drag rotate): never a tool/erase. */
export function isCameraOnlyPress(button: number, shift: boolean, alt: boolean): boolean {
  return (button === 2 && shift) || (button === 0 && alt);
}

export type NavAction =
  | { type: 'rotate'; azimuthDeg: number; polarDeg: number }
  | { type: 'view'; view: ViewName }
  | { type: 'cycle' }
  | { type: 'panels' };

export interface KeyMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

const STEP = 15;
const BIG_STEP = 90;
const TILT = 10;

/** Navigation action of a key (by `code`, so it works with a Korean IME), or null. */
export function navAction(code: string, m: KeyMods): NavAction | null {
  if (m.alt || m.meta) return null;
  if (m.ctrl) {
    if (code === 'Numpad1') return { type: 'view', view: 'back' };
    if (code === 'Numpad3') return { type: 'view', view: 'left' };
    return null;
  }
  const yaw = m.shift ? BIG_STEP : STEP;
  switch (code) {
    case 'KeyQ':
      return { type: 'rotate', azimuthDeg: -yaw, polarDeg: 0 };
    case 'KeyE':
      return { type: 'rotate', azimuthDeg: yaw, polarDeg: 0 };
    case 'ArrowLeft':
      return { type: 'rotate', azimuthDeg: -STEP, polarDeg: 0 };
    case 'ArrowRight':
      return { type: 'rotate', azimuthDeg: STEP, polarDeg: 0 };
    case 'ArrowUp':
      return { type: 'rotate', azimuthDeg: 0, polarDeg: -TILT };
    case 'ArrowDown':
      return { type: 'rotate', azimuthDeg: 0, polarDeg: TILT };
    case 'KeyV':
      return { type: 'cycle' };
    case 'Numpad1':
      return { type: 'view', view: 'front' };
    case 'Numpad3':
      return { type: 'view', view: 'right' };
    // Blender-style numpad: 4/6 turn, 8/2 tilt. Other numpad digits do nothing (never tools).
    case 'Numpad4':
      return { type: 'rotate', azimuthDeg: -STEP, polarDeg: 0 };
    case 'Numpad6':
      return { type: 'rotate', azimuthDeg: STEP, polarDeg: 0 };
    case 'Numpad8':
      return { type: 'rotate', azimuthDeg: 0, polarDeg: -TILT };
    case 'Numpad2':
      return { type: 'rotate', azimuthDeg: 0, polarDeg: TILT };
    case 'Numpad7':
      return { type: 'view', view: 'top' };
    case 'Home':
      return { type: 'view', view: 'home' };
    case 'Tab':
      return m.shift ? null : { type: 'panels' };
    default:
      return null;
  }
}
