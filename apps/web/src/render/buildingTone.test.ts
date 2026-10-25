import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, GROWTH_PRESETS } from '@smartcity/shared';
import { crossDoc } from '../test/fixtures';
import * as THREE from 'three';
import { BuildingLayer } from './buildings';
import { createBuildingMaterial } from './buildingGeometry';
import { rgbToHsl, shiftRgb, toneHex, toneShift, toneWallLinear, TONE_GLSL, TONE_CHROMA_EPS, TONE_DEN_EPS, SRGB, TONE_HUE_DEG, TONE_LIGHTNESS, TONE_SATURATION } from './buildingTone';

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

describe('building tone', () => {
  it('is the same for the same id and differs between ids', () => {
    expect(toneShift('g-1-a')).toEqual(toneShift('g-1-a'));
    expect(toneHex('#c98f6b', 'g-1-a')).toBe(toneHex('#c98f6b', 'g-1-a'));
    const tones = new Set(Array.from({ length: 40 }, (_, i) => toneHex('#c98f6b', `g-${i}-lot`)));
    expect(tones.size).toBeGreaterThan(20);
  });

  it('stays within ±8 % lightness, ±10 % saturation and ±4° hue ', () => {
    for (const t of GROWTH_PRESETS) {
      const base = rgbToHsl(...rgb(t.parts[0]!.color));
      for (let i = 0; i < 200; i++) {
        const [h, s, l] = rgbToHsl(...shiftRgb(...rgb(t.parts[0]!.color), toneShift(`g-${i}-x`)));
        expect(Math.abs(l / base[2] - 1)).toBeLessThanOrEqual(TONE_LIGHTNESS + 1e-6);
        if (base[1] > 0.02) {
          expect(Math.abs(s / base[1] - 1)).toBeLessThanOrEqual(TONE_SATURATION + 1e-6);
          const dh = Math.min(Math.abs(h - base[0]), 360 - Math.abs(h - base[0]));
          expect(dh).toBeLessThanOrEqual(TONE_HUE_DEG + 1e-6);
        }
      }
    }
  });
});

describe('BuildingLayer tone', () => {
  it('writes the id-hash shift per auto instance and zero for hand-placed ones', () => {
    const { doc } = crossDoc();
    for (const [id, x, auto] of [['m1', 30, false], ['a1', 60, true], ['a2', 90, true]] as const) {
      const building = { id, typeId: 'house', pos: { x, z: 30 }, rotation: 0, ...(auto ? { auto: true as const } : {}) };
      expect(applyCommand(doc, { type: 'building.place', building: cloneJson(building) }).ok).toBe(true);
    }
    const layer = new BuildingLayer();
    layer.update(doc);
    const mesh = layer.group.children[0] as unknown as { geometry: { getAttribute(n: string): { array: Float32Array } } };
    const tone = mesh.geometry.getAttribute('aTone').array;
    const slots = (layer as unknown as { slotOf: Map<string, { slot: number }> }).slotOf;
    const at = (id: string): number[] => Array.from(tone.subarray(slots.get(id)!.slot * 3, slots.get(id)!.slot * 3 + 3));
    expect(at('m1')).toEqual([0, 0, 0]);
    for (const id of ['a1', 'a2']) {
      const t = toneShift(id);
      const got = at(id);
      expect(got[0]).toBeCloseTo(t.dh, 4);
      expect(got[1]).toBeCloseTo(t.ds, 5);
      expect(got[2]).toBeCloseTo(t.dl, 5);
    }
    expect(at('a1')).not.toEqual(at('a2'));
  });

  it('every volume of every growth design stays within the tone limits for any id (each volume is toned from its own colour)', () => {
    for (const t of GROWTH_PRESETS) {
      for (const p of t.parts) {
        const base = rgbToHsl(...rgb(p.color));
        for (let i = 0; i < 60; i++) {
          const [h, s, l] = rgbToHsl(...shiftRgb(...rgb(p.color), toneShift(`g-${i}-q`)));
          expect(Math.abs(l / base[2] - 1)).toBeLessThanOrEqual(TONE_LIGHTNESS + 1e-6);
          if (base[1] > 0.02) {
            expect(Math.abs(s / base[1] - 1)).toBeLessThanOrEqual(TONE_SATURATION + 1e-6);
            expect(Math.min(Math.abs(h - base[0]), 360 - Math.abs(h - base[0]))).toBeLessThanOrEqual(TONE_HUE_DEG + 1e-6);
          }
        }
      }
    }
  });

  it('shader math (TS twin, exact sRGB as Three.js) keeps every preset volume within the contract for 2000 ids', () => {
    const base = new THREE.Color();
    const out = new THREE.Color();
    const rgb3 = { r: 0, g: 0, b: 0 };
    let cases = 0;
    let bad = 0;
    for (const t of GROWTH_PRESETS) {
      for (const p of t.parts) {
        base.set(p.color);
        const [h0, s0, l0] = rgbToHsl(...rgb(p.color));
        for (let i = 0; i < 2000; i++) {
          const lin = toneWallLinear([base.r, base.g, base.b], toneShift(`g-${i}`));
          out.setRGB(lin[0], lin[1], lin[2]);
          out.getRGB(rgb3, THREE.SRGBColorSpace);
          const [h, s, l] = rgbToHsl(rgb3.r, rgb3.g, rgb3.b);
          cases++;
          let ok = Math.abs(l / l0 - 1) <= TONE_LIGHTNESS;
          if (s0 > 0.02) ok &&= Math.abs(s / s0 - 1) <= TONE_SATURATION && Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0)) <= TONE_HUE_DEG;
          if (!ok) bad++;
        }
      }
    }
    expect(cases).toBeGreaterThan(60000);
    expect(bad).toBe(0);
  });

  it('the twin and the shader share their constants', () => {
    expect(TONE_GLSL).toContain(`d > ${TONE_CHROMA_EPS}`);
    expect(TONE_GLSL).toContain(`${TONE_DEN_EPS})`);
    for (const v of [SRGB.linearEdge, SRGB.srgbEdge, SRGB.offset, SRGB.scale, SRGB.gamma, SRGB.slope]) expect(TONE_GLSL).toContain(String(Number.isInteger(v) ? v.toFixed(1) : v));
    expect(TONE_GLSL).toContain('step(vec3(0.0031308), c)');
    expect(TONE_GLSL).toContain('step(vec3(0.04045), c)');
  });

  it('the facade shader tones only the wall colour (glass, windows and roofs stay as designed)', () => {
    const src = createBuildingMaterial();
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
    (src.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, null);
    const lines = shader.fragmentShader.split('\n').filter((l) => l.includes('toneWall('));
    expect(lines.filter((l) => !l.includes('vec3 toneWall('))).toHaveLength(1);
    expect(lines.join('\n')).toContain('vec3 wallC = toneWall(diffuseColor.rgb, vTone);');
    expect(shader.vertexShader).toContain('vTone = aTone;');
    expect(shader.fragmentShader).toContain(TONE_GLSL);
  });
});
