// Mountains on the horizon (ADR 0014 §3, P7a): three low-poly ridge rings in one mesh (one draw call),
// around the camera like the sky dome and inside its radius, so they always stand beyond the city's haze
// and keep the same apparent size at any zoom. Render-only.
//
// Atmospheric perspective in their own shader (no scene fog, no tone mapping, as the sky): each ring is
// mixed toward the horizon color, the farther the paler, and the foot of every ridge is exactly the
// horizon color, which is also the color of the fully fogged ground — the mountains rise out of the haze
// with no seam, by day and by night.

import * as THREE from 'three';
import type { RenderQuality } from '../app/quality';

/** Ring radii as fractions of the sky dome radius, and ridge elevations above the horizon (degrees). */
export const MOUNTAIN_LAYERS = [
  { radius: 0.7, base: 1.1, amp: 2.4, haze: 0.34, color: '#46604f', phase: 0.0 },
  { radius: 0.82, base: 1.7, amp: 2.9, haze: 0.52, color: '#587066', phase: 2.1 },
  { radius: 0.94, base: 2.3, amp: 2.7, haze: 0.68, color: '#6a8081', phase: 4.4 },
] as const;
/** Lowest ridge of all rings above the horizon, degrees (tests sample below it). */
export const MOUNTAIN_MIN_ELEVATION = Math.min(...MOUNTAIN_LAYERS.map((l) => l.base));
const SEGMENTS = 256;
/** Indices of one ring (2 rows of quads around). */
const RING_INDICES = SEGMENTS * 2 * 6;
const NIGHT_BODY = '#0c1424';

/** Ridge height in [0, 1] at azimuth `a` (seamless around the circle: integer frequencies). */
export function ridge(a: number, phase: number): number {
  const n = 0.55 * Math.sin(3 * a + phase) + 0.3 * Math.sin(7 * a + phase * 1.7 + 1) + 0.15 * Math.sin(13 * a + phase * 2.3 + 2) + 0.08 * Math.sin(29 * a + phase * 3.1 + 3);
  return Math.pow(0.5 + 0.5 * (n / 1.08), 1.4);
}

/** Unit geometry (dome radius 1): per ring a foot row on the ground, a shoulder and the ridge, leaning away from the center. */
export function mountainGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const t: number[] = [];
  const layer: number[] = [];
  const index: number[] = [];
  MOUNTAIN_LAYERS.forEach((l, li) => {
    const first = pos.length / 3;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const e = ((l.base + l.amp * ridge(a, l.phase)) * Math.PI) / 180;
      const h = l.radius * Math.tan(e);
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      for (const [k, y, tt] of [
        [1, 0, 0],
        [1.02, h * 0.6, 0.6],
        [1.045, h, 1],
      ] as const) {
        pos.push(cx * l.radius * k, y, cz * l.radius * k);
        t.push(tt);
        layer.push(li);
      }
    }
    for (let i = 0; i < SEGMENTS; i++) {
      for (let r = 0; r < 2; r++) {
        const a = first + i * 3 + r;
        const b = a + 3;
        // Counter-clockwise seen from the center (where the camera is): front faces.
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

export interface Mountains {
  mesh: THREE.Mesh;
  /** Horizon (= fog) color (linear), night factor 0..1 and the direction toward the key light. */
  setColors(horizon: THREE.Color, night: number, lightDir: THREE.Vector3): void;
  /** Keep the rings centered on the camera (x/z) and scaled with its far plane, inside the sky dome. */
  follow(camera: THREE.PerspectiveCamera): void;
  /** 'low' draws only the nearest ring (still one draw call). */
  setQuality(quality: RenderQuality): void;
  /** Rings drawn now. */
  readonly rings: number;
  dispose(): void;
}

export function createMountains(): Mountains {
  const uniforms = {
    uHorizon: { value: new THREE.Color() },
    uNight: { value: 0 },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uBody: { value: MOUNTAIN_LAYERS.map((l) => new THREE.Color(l.color)) },
    uHaze: { value: new THREE.Vector3(...MOUNTAIN_LAYERS.map((l) => l.haze)) },
    uNightBody: { value: new THREE.Color(NIGHT_BODY) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    toneMapped: false,
    vertexShader: `
      attribute float aT;
      attribute float aLayer;
      varying float vT;
      varying float vLayer;
      varying vec3 vN;
      void main() {
        vT = aT;
        vLayer = aLayer;
        vN = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uHorizon;
      uniform float uNight;
      uniform vec3 uSun;
      uniform vec3 uBody[3];
      uniform vec3 uHaze;
      uniform vec3 uNightBody;
      varying float vT;
      varying float vLayer;
      varying vec3 vN;
      void main() {
        int li = int(vLayer + 0.5);
        vec3 day = li == 0 ? uBody[0] : (li == 1 ? uBody[1] : uBody[2]);
        float haze = li == 0 ? uHaze.x : (li == 1 ? uHaze.y : uHaze.z);
        // Slopes toward the sun a little lighter by day.
        float shade = 0.8 + 0.35 * max(dot(normalize(vN), uSun), 0.0);
        vec3 body = mix(day * shade, uNightBody, uNight);
        // The foot melts into the haze: exactly the horizon color on the ground.
        haze = mix(1.0, haze, smoothstep(0.0, 0.6, vT));
        gl_FragColor = vec4(mix(body, uHorizon, haze), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const geo = mountainGeometry();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'mountains';
  mesh.frustumCulled = false;
  // After the city and the ground (hidden pixels fail the depth test), before the sky dome.
  mesh.renderOrder = 2.5;
  return {
    mesh,
    setColors(horizon, night, lightDir) {
      uniforms.uHorizon.value.copy(horizon);
      uniforms.uNight.value = night;
      uniforms.uSun.value.copy(lightDir);
    },
    follow(camera) {
      mesh.position.set(camera.position.x, 0, camera.position.z);
      mesh.scale.setScalar(camera.far * 0.9);
    },
    setQuality(quality) {
      geo.setDrawRange(0, quality === 'low' ? RING_INDICES : Infinity);
    },
    get rings() {
      return Math.min(MOUNTAIN_LAYERS.length, Math.round(Math.min(geo.drawRange.count, geo.index!.count) / RING_INDICES));
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
