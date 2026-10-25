import { describe, expect, it } from 'vitest';
import { isCameraOnlyPress, navAction, toolDigit, nextView, viewAngles, VIEW_CYCLE, type KeyMods } from './viewNav';

const none: KeyMods = { shift: false, ctrl: false, alt: false, meta: false };

describe('viewAngles', () => {
  it('front looks from +z (the road side), the others turn around it', () => {
    expect(viewAngles('front').azimuth).toBe(0);
    expect(viewAngles('right').azimuth).toBeCloseTo(Math.PI / 2);
    expect(viewAngles('back').azimuth).toBeCloseTo(Math.PI);
    expect(viewAngles('left').azimuth).toBeCloseTo(-Math.PI / 2);
    expect(viewAngles('top').polar).toBe(0);
  });
  it('side views stay under the studio max polar angle', () => {
    for (const v of ['front', 'right', 'back', 'left'] as const) expect(viewAngles(v).polar).toBeLessThan(Math.PI / 2 - 0.04);
  });
});

describe('nextView', () => {
  it('cycles front -> right -> back -> left -> top -> front', () => {
    let v: ReturnType<typeof nextView> | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      v = nextView(v);
      seen.push(v);
    }
    expect(seen).toEqual([...VIEW_CYCLE, 'front']);
  });
  it('starts at the front from home', () => expect(nextView('home')).toBe('front'));
});

describe('navAction', () => {
  it('Q/E rotate 15 deg, Shift 90 deg', () => {
    expect(navAction('KeyQ', none)).toEqual({ type: 'rotate', azimuthDeg: -15, polarDeg: 0 });
    expect(navAction('KeyE', none)).toEqual({ type: 'rotate', azimuthDeg: 15, polarDeg: 0 });
    expect(navAction('KeyQ', { ...none, shift: true })).toEqual({ type: 'rotate', azimuthDeg: -90, polarDeg: 0 });
    expect(navAction('KeyE', { ...none, shift: true })).toEqual({ type: 'rotate', azimuthDeg: 90, polarDeg: 0 });
  });
  it('arrows rotate and tilt', () => {
    expect(navAction('ArrowLeft', none)).toMatchObject({ azimuthDeg: -15 });
    expect(navAction('ArrowRight', none)).toMatchObject({ azimuthDeg: 15 });
    expect(navAction('ArrowUp', none)).toMatchObject({ polarDeg: -10 });
    expect(navAction('ArrowDown', none)).toMatchObject({ polarDeg: 10 });
  });
  it('numpad and Home pick views', () => {
    expect(navAction('Numpad1', none)).toEqual({ type: 'view', view: 'front' });
    expect(navAction('Numpad3', none)).toEqual({ type: 'view', view: 'right' });
    expect(navAction('Numpad7', none)).toEqual({ type: 'view', view: 'top' });
    expect(navAction('Numpad1', { ...none, ctrl: true })).toEqual({ type: 'view', view: 'back' });
    expect(navAction('Numpad3', { ...none, ctrl: true })).toEqual({ type: 'view', view: 'left' });
    expect(navAction('Home', none)).toEqual({ type: 'view', view: 'home' });
  });
  it('numpad 4/6/8/2 move the camera, other numpad digits do nothing', () => {
    expect(navAction('Numpad4', none)).toMatchObject({ azimuthDeg: -15 });
    expect(navAction('Numpad6', none)).toMatchObject({ azimuthDeg: 15 });
    expect(navAction('Numpad8', none)).toMatchObject({ polarDeg: -10 });
    expect(navAction('Numpad2', none)).toMatchObject({ polarDeg: 10 });
    expect(navAction('Numpad5', none)).toBeNull();
  });
  it('V cycles, Tab toggles panels', () => {
    expect(navAction('KeyV', none)).toEqual({ type: 'cycle' });
    expect(navAction('Tab', none)).toEqual({ type: 'panels' });
  });
  it('ignores Ctrl/Alt/Meta combos that belong to others and unrelated keys', () => {
    expect(navAction('KeyQ', { ...none, ctrl: true })).toBeNull();
    expect(navAction('KeyE', { ...none, alt: true })).toBeNull();
    expect(navAction('KeyZ', none)).toBeNull();
    expect(navAction('KeyF', none)).toBeNull();
  });
});

describe('toolDigit', () => {
  it('accepts only top-row Digit1-6', () => {
    expect(toolDigit('Digit1')).toBe('1');
    expect(toolDigit('Digit6')).toBe('6');
    expect(toolDigit('Digit7')).toBeNull();
    for (const c of ['Numpad1', 'Numpad2', 'Numpad4', 'Numpad5', 'Numpad6']) expect(toolDigit(c)).toBeNull();
  });
});

describe('isCameraOnlyPress', () => {
  it('Shift+right and Alt+left are camera-only; plain right/left are not', () => {
    expect(isCameraOnlyPress(2, true, false)).toBe(true);
    expect(isCameraOnlyPress(0, false, true)).toBe(true);
    expect(isCameraOnlyPress(2, false, false)).toBe(false);
    expect(isCameraOnlyPress(0, false, false)).toBe(false);
    expect(isCameraOnlyPress(0, true, false)).toBe(false);
  });
});
