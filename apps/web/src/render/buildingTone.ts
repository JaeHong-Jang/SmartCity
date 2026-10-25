// Per-building wall tone variation (ADR 0010 §7), render only: the document and snapshots never see it.
// Automatic-growth buildings get their wall colour nudged by a hash of the building id so a street of the
// same design does not look stamped. The shift is a deterministic function of the id.

import { hash01 } from '@smartcity/shared';

/** The contract: lightness ±8 %, saturation ±10 % (both relative), hue ±4°. */
export const TONE_LIGHTNESS = 0.08;
export const TONE_SATURATION = 0.1;
export const TONE_HUE_DEG = 4;
/** Shifts are drawn inside the contract with a margin, so float error (shader is float32) can never exceed it. */
const DRAW_LIGHTNESS = 0.07;
const DRAW_SATURATION = 0.09;
const DRAW_HUE_DEG = 3.5;

export interface ToneShift {
  /** Hue shift, degrees. */
  dh: number;
  /** Relative saturation change. */
  ds: number;
  /** Relative lightness change. */
  dl: number;
}

const signed = (key: string, id: string): number => hash01(0, 0, `${id}#${key}`) * 2 - 1;

export function toneShift(buildingId: string): ToneShift {
  return {
    dh: signed('h', buildingId) * DRAW_HUE_DEG,
    ds: signed('s', buildingId) * DRAW_SATURATION,
    dl: signed('l', buildingId) * DRAW_LIGHTNESS,
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** rgb in 0..1 → [h 0..360, s, l]. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** The colour (rgb 0..1) with the shift applied in HSL. */
export function shiftRgb(r: number, g: number, b: number, t: ToneShift): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h + t.dh, clamp01(s * (1 + t.ds)), clamp01(l * (1 + t.dl)));
}

const hex2 = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

/** '#rrggbb' wall colour toned for this building (for tests and previews). */
export function toneHex(hex: string, buildingId: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = shiftRgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, toneShift(buildingId));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

// Shared by the shader (TONE_GLSL is generated from them) and its TS twin below.
/** Hue/saturation are treated as 0 below this chroma. */
export const TONE_CHROMA_EPS = 1e-5;
/** Floor of the saturation denominator. */
export const TONE_DEN_EPS = 1e-5;
/** sRGB transfer function (Three.js SRGBToLinear / LinearToSRGB). */
export const SRGB = { linearEdge: 0.0031308, srgbEdge: 0.04045, slope: 12.92, offset: 0.055, scale: 1.055, gamma: 2.4 } as const;

const glslNum = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const g = glslNum;

const fmod = (x: number, y: number): number => x - y * Math.floor(x / y);
/** GLSL step(edge, x): 1 when x >= edge. */
const step = (edge: number, x: number): number => (x >= edge ? 1 : 0);
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;

const toSrgb = (c: number): number => mix(c * SRGB.slope, SRGB.scale * Math.pow(Math.max(c, 0), 1 / SRGB.gamma) - SRGB.offset, step(SRGB.linearEdge, c));
const toLinear = (c: number): number => mix(c / SRGB.slope, Math.pow((c + SRGB.offset) / SRGB.scale, SRGB.gamma), step(SRGB.srgbEdge, c));

/**
 * TS twin of the shader's `toneWall`, step for step (same branches, epsilons and HSL → RGB form):
 * the linear wall colour toned by `t`, returned linear. Tests evaluate this twin; `TONE_GLSL` is the shader.
 */
export function toneWallLinear(lin: readonly [number, number, number], t: ToneShift): [number, number, number] {
  if (t.dh === 0 && t.ds === 0 && t.dl === 0) return [lin[0], lin[1], lin[2]];
  const r = toSrgb(Math.max(lin[0], 0));
  const gg = toSrgb(Math.max(lin[1], 0));
  const b = toSrgb(Math.max(lin[2], 0));
  const mx = Math.max(r, gg, b);
  const mn = Math.min(r, gg, b);
  let l = (mx + mn) * 0.5;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d > TONE_CHROMA_EPS) {
    s = d / Math.max(1 - Math.abs(2 * l - 1), TONE_DEN_EPS);
    if (mx === r) h = fmod((gg - b) / d, 6);
    else if (mx === gg) h = (b - r) / d + 2;
    else h = (r - gg) / d + 4;
    h *= 60;
  }
  h += t.dh;
  s = clamp01(s * (1 + t.ds));
  l = clamp01(l * (1 + t.dl));
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number): number => {
    const k = fmod(n + h / 30, 12);
    return toLinear(l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1)));
  };
  return [ch(0), ch(8), ch(4)];
}

/** GLSL of `toneWall(vec3 linear, vec3 (hue°, sat, light))`, mirroring toneWallLinear. */
export const TONE_GLSL = `
        vec3 toneToSrgb(vec3 c) { return mix(c * ${g(SRGB.slope)}, ${g(SRGB.scale)} * pow(max(c, vec3(0.0)), vec3(1.0 / ${g(SRGB.gamma)})) - ${g(SRGB.offset)}, step(vec3(${g(SRGB.linearEdge)}), c)); }
        vec3 toneToLinear(vec3 c) { return mix(c / ${g(SRGB.slope)}, pow((c + ${g(SRGB.offset)}) / ${g(SRGB.scale)}, vec3(${g(SRGB.gamma)})), step(vec3(${g(SRGB.srgbEdge)}), c)); }
        vec3 toneWall(vec3 lin, vec3 t) {
          if (t == vec3(0.0)) return lin;
          vec3 c = toneToSrgb(max(lin, vec3(0.0)));
          float mx = max(c.r, max(c.g, c.b));
          float mn = min(c.r, min(c.g, c.b));
          float l = (mx + mn) * 0.5;
          float d = mx - mn;
          float h = 0.0;
          float s = 0.0;
          if (d > ${g(TONE_CHROMA_EPS)}) {
            s = d / max(1.0 - abs(2.0 * l - 1.0), ${g(TONE_DEN_EPS)});
            if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
            else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
            else h = (c.r - c.g) / d + 4.0;
            h *= 60.0;
          }
          h += t.x;
          s = clamp(s * (1.0 + t.y), 0.0, 1.0);
          l = clamp(l * (1.0 + t.z), 0.0, 1.0);
          vec3 k = mod(vec3(0.0, 8.0, 4.0) + h / 30.0, 12.0);
          float a = s * min(l, 1.0 - l);
          return toneToLinear(l - a * max(vec3(-1.0), min(min(k - 3.0, 9.0 - k), vec3(1.0))));
        }
`;
