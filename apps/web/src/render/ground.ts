// Large ground plane with the 8 m / 64 m shader grid (distance fade), a fine grid at the current snap
// step drawn only around the cursor (radial and zoom fade against moiré), plus the buildable boundary.
// The grass varies in tone like real fields (world-space noise); the grid fades out before the haze
// and is faint unless an editing tool is active (ADR 0013 §6).
//
// The same grid is drawn on the city paving (ADR 0014 §2, P7a) while an editing tool is active, so
// placing on paved blocks and lots still shows it: `GRID_GLSL` and the shared `GRID_UNIFORMS`. The
// background grid darkens the surface; the snap step near the cursor is light lines plus a dot on the
// grid point the cursor snaps to, so the two never read as one.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';

/** Radius of the fine grid around the cursor, meters. */
export const FINE_GRID_RADIUS = 80;

/** Grid uniforms shared by the ground and paving materials (one renderer per page). */
export const GRID_UNIFORMS = {
  uHalf: { value: 2000 },
  uCursor: { value: new THREE.Vector2() },
  uFine: { value: 0 },
  uFineRadius: { value: FINE_GRID_RADIUS },
  /** Background grid contrast: 1 while editing, lower when only looking around. */
  uGrid: { value: 1 },
  /** 1 while an editing tool is active: the grid then shows on the paving too. */
  uGridPave: { value: 0 },
};

/**
 * Fragment helper: `cityGrid(color, worldPos, background, fine, dark)` returns `color` with the background
 * 8 m / 64 m lines (scaled by `background`, lines `dark` × the surface) and the snap step near the cursor
 * (scaled by `fine`).
 */
export const GRID_GLSL = `
uniform float uHalf;
uniform vec2 uCursor;
uniform float uFine;
uniform float uFineRadius;
uniform float uGrid;
uniform float uGridPave;
vec3 cityGrid(vec3 col, vec3 world, float background, float fine, float dark) {
  vec2 p = world.xz;
  float camDist = length(cameraPosition - world);
  float inside = step(abs(p.x), uHalf) * step(abs(p.y), uHalf);
  vec2 q8 = p / 8.0;
  vec2 fw8 = fwidth(q8);
  vec2 g8 = abs(fract(q8 - 0.5) - 0.5) / fw8;
  vec2 g64 = abs(fract(p / 64.0 - 0.5) - 0.5) / fwidth(p / 64.0);
  float l8 = 1.0 - min(min(g8.x, g8.y), 1.0);
  float l64 = 1.0 - min(min(g64.x, g64.y), 1.0);
  // 8 m lines while a cell spans enough pixels (no moiré at grazing angles), out to the usual editing
  // distances; both fade out before the haze starts (fog near ≥ 1.1 × camera distance).
  float px8 = 1.0 / max(max(fw8.x, fw8.y), 1e-4);
  float fade8 = smoothstep(4.0, 9.0, px8) * (1.0 - smoothstep(350.0, 900.0, camDist));
  float fade64 = 1.0 - smoothstep(500.0, 1600.0, camDist);
  col = mix(col, col * dark, inside * background * max(l8 * fade8 * 0.6, l64 * fade64 * 0.8));
  if (uFine > 0.0 && fine > 0.0) {
    // Snap grid: light lines only near the cursor, and only while a cell spans enough pixels.
    vec2 q = p / uFine;
    vec2 fw = fwidth(q);
    vec2 gf = abs(fract(q - 0.5) - 0.5) / fw;
    float lf = 1.0 - min(min(gf.x, gf.y), 1.0);
    float cellPx = 1.0 / max(max(fw.x, fw.y), 1e-4);
    float zoomFade = smoothstep(5.0, 14.0, cellPx);
    float radial = 1.0 - smoothstep(uFineRadius * 0.45, uFineRadius, distance(p, uCursor));
    col = mix(col, vec3(0.86, 0.93, 0.8), inside * fine * lf * zoomFade * radial * 0.3);
    // The grid point the cursor snaps to.
    vec2 sp = floor(uCursor / uFine + 0.5) * uFine;
    // At least ~3 px across when zoomed out, at most 40 % of a cell.
    float r = min(uFine * 0.4, max(max(0.35, uFine * 0.1), 3.0 * uFine / cellPx));
    float dotMask = 1.0 - smoothstep(r * 0.65, r, distance(p, sp));
    col = mix(col, vec3(1.0, 0.95, 0.62), inside * fine * dotMask * 0.85);
  }
  return col;
}`;

/** Snap point and step of the fine grid; steps of 0 (off) hide it. */
function syncFine(cursorOn: boolean, step: number): void {
  GRID_UNIFORMS.uFine.value = cursorOn && step > 0 ? step : 0;
}

export interface Ground {
  group: THREE.Group;
  setCursor(p: Vec2 | null): void;
  /** Snap step in meters (0 = off): highlighted around the cursor. */
  setStep(step: number): void;
  /** Grid contrast: 1 while editing (the paving shows the grid too), lower when only looking around. */
  setGridStrength(v: number): void;
  dispose(): void;
}

export function createGround(halfSize: number): Ground {
  const group = new THREE.Group();
  group.name = 'ground';
  // Far beyond the haze in every direction, so its edge is never seen (fog ends well before it).
  const size = halfSize * 2 + 24000;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: '#647a4d', roughness: 1, metalness: 0 });
  const uniforms = GRID_UNIFORMS;
  uniforms.uHalf.value = halfSize;
  let cursorOn = false;
  let step = 0;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGridWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGridWorld;
        ${GRID_GLSL}
        // Arithmetic hash (no sin: cheaper on integrated GPUs).
        float gHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float gNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 p = vGridWorld.xz;
          float inside = step(abs(p.x), uHalf) * step(abs(p.y), uHalf);
          // Fields: patches of greener and drier grass at a few hundred meters, finer mottling, more
          // variety outside the buildable square.
          float field = gNoise(p / 230.0);
          float mottle = gNoise(p / 13.0 + 7.0);
          float vary = mix(1.0, 0.55, inside);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.05, 0.84), smoothstep(0.45, 0.8, field) * vary);
          diffuseColor.rgb *= 1.0 + (field - 0.5) * 0.18 * vary + (mottle - 0.5) * 0.08;
          diffuseColor.rgb = cityGrid(diffuseColor.rgb, vGridWorld, uGrid, 1.0, 0.8);
        }`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground-plane';
  // Drawn after the city (roads, paving, buildings): the depth test then skips the hidden ground pixels.
  mesh.renderOrder = 2;
  group.add(mesh);

  // Boundary of the buildable area.
  const h = halfSize;
  const pts = [new THREE.Vector3(-h, 0.3, -h), new THREE.Vector3(h, 0.3, -h), new THREE.Vector3(h, 0.3, h), new THREE.Vector3(-h, 0.3, h), new THREE.Vector3(-h, 0.3, -h)];
  const border = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#d8e6c8', transparent: true, opacity: 0.6 }));
  group.add(border);
  return {
    group,
    setCursor(p) {
      cursorOn = p !== null;
      if (p) uniforms.uCursor.value.set(p.x, p.z);
      syncFine(cursorOn, step);
    },
    setStep(s) {
      if (s === step) return;
      step = s;
      syncFine(cursorOn, step);
    },
    setGridStrength(v) {
      uniforms.uGrid.value = v;
      // Only looking around: the paving stays clean (no grid over the city's concrete and lawns).
      uniforms.uGridPave.value = v >= 1 ? 1 : 0;
      border.material.opacity = 0.25 + 0.35 * v;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      border.geometry.dispose();
      border.material.dispose();
    },
  };
}
