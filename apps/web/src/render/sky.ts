// Sky and haze (ADR 0013 §6, P6c-1): a gradient sky dome that meets the fog color at the horizon,
// and fog distances that follow the camera distance: the near city stays clear, the far ground and
// the plane's edge melt into haze.
//
// No horizon seam: three.js mixes fog *after* tone mapping and the output color-space conversion,
// with `fogColor` converted to the output space but never tone mapped. The sky therefore skips tone
// mapping too (toneMapped: false) and only converts to the output space, so at and below the horizon
// its pixels equal a fully fogged ground's: both are the horizon color in output space.

import * as THREE from 'three';

/** Fog start/end for a camera `distance` m from its target, written into `out` (no allocation). The target area is never fogged. */
export function fogRange(distance: number, out: { near: number; far: number } = { near: 0, far: 0 }): { near: number; far: number } {
  out.near = distance * 1.1 + 250;
  out.far = out.near + 900 + distance * 1.8;
  return out;
}

export interface Sky {
  mesh: THREE.Mesh;
  /** Horizon (= fog) and zenith colors, linear. */
  setColors(horizon: THREE.Color, zenith: THREE.Color): void;
  /** Keep the dome centered on the camera and inside its far plane. */
  follow(camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

export function createSky(): Sky {
  const uniforms = { uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    toneMapped: false,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        float t = pow(smoothstep(0.0, 0.5, h), 0.75);
        // Exactly the horizon (= fog) color at and below the horizon.
        gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  // Drawn after the opaque city and ground, so only pixels nothing covers are shaded (depth test on,
  // no depth write). Its radius stays inside the far plane; anything beyond it is already full haze.
  mesh.renderOrder = 3;
  return {
    mesh,
    setColors(horizon, zenith) {
      uniforms.uHorizon.value.copy(horizon);
      uniforms.uZenith.value.copy(zenith);
    },
    follow(camera) {
      mesh.position.copy(camera.position);
      mesh.scale.setScalar(camera.far * 0.9);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
