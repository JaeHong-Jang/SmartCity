// Large ground plane with the 8 m / 64 m shader grid (distance fade), a fine grid at the current snap
// step drawn only around the cursor (radial and zoom fade against moiré), plus the buildable boundary.

import * as THREE from 'three';
import type { Vec2 } from '@smartcity/shared';

/** Radius of the fine grid around the cursor, meters. */
export const FINE_GRID_RADIUS = 80;

export interface Ground {
  group: THREE.Group;
  setCursor(p: Vec2 | null): void;
  /** Snap step in meters (0 = off). Steps ≥ 8 m are already covered by the major grid. */
  setStep(step: number): void;
  dispose(): void;
}

export function createGround(halfSize: number): Ground {
  const group = new THREE.Group();
  group.name = 'ground';
  const size = halfSize * 2 + 8000;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: '#5f7a4e', roughness: 1, metalness: 0 });
  const uniforms = {
    uHalf: { value: halfSize },
    uCursor: { value: new THREE.Vector2() },
    uFine: { value: 0 },
    uFineRadius: { value: FINE_GRID_RADIUS },
  };
  let cursorOn = false;
  let step = 0;
  const syncFine = (): void => {
    uniforms.uFine.value = cursorOn && step > 0 && step < 8 ? step : 0;
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGridWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;\nuniform float uHalf;\nuniform vec2 uCursor;\nuniform float uFine;\nuniform float uFineRadius;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 p = vGridWorld.xz;
          float camDist = length(cameraPosition - vGridWorld);
          vec2 g8 = abs(fract(p / 8.0 - 0.5) - 0.5) / fwidth(p / 8.0);
          vec2 g64 = abs(fract(p / 64.0 - 0.5) - 0.5) / fwidth(p / 64.0);
          float l8 = 1.0 - min(min(g8.x, g8.y), 1.0);
          float l64 = 1.0 - min(min(g64.x, g64.y), 1.0);
          float fade8 = 1.0 - smoothstep(150.0, 600.0, camDist);
          float fade64 = 1.0 - smoothstep(1200.0, 3500.0, camDist);
          float inside = step(abs(p.x), uHalf) * step(abs(p.y), uHalf);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.82, inside * max(l8 * fade8 * 0.55, l64 * fade64 * 0.8));
          if (uFine > 0.0) {
            // Fine snap grid: only near the cursor, and only while a cell spans enough pixels.
            vec2 q = p / uFine;
            vec2 fw = fwidth(q);
            vec2 gf = abs(fract(q - 0.5) - 0.5) / fw;
            float lf = 1.0 - min(min(gf.x, gf.y), 1.0);
            float cellPx = 1.0 / max(max(fw.x, fw.y), 1e-4);
            float zoomFade = smoothstep(5.0, 14.0, cellPx);
            float radial = 1.0 - smoothstep(uFineRadius * 0.45, uFineRadius, distance(p, uCursor));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.93, 0.8), inside * lf * zoomFade * radial * 0.26);
          }
          // Outside the buildable square: slightly darker and desaturated.
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.78, 0.8, 0.76), diffuseColor.rgb, inside);
        }`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground-plane';
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
      syncFine();
    },
    setStep(s) {
      if (s === step) return;
      step = s;
      syncFine();
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      border.geometry.dispose();
      border.material.dispose();
    },
  };
}
