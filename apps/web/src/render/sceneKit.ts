// Renderer and sun setup shared by the city, the building studio and the editor previews.

import * as THREE from 'three';

/** sRGB output, ACES tone mapping and PCF shadows. */
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
}

/** Shadow-casting warm sun; the caller positions it and sizes its shadow camera. */
export function createSun(intensity: number, shadowMapSize: number, normalBias: number): THREE.DirectionalLight {
  const sun = new THREE.DirectionalLight('#fff3dd', intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = normalBias;
  return sun;
}
