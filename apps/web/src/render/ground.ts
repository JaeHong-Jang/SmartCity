// Large ground plane with an 8 m shader grid that fades with distance, plus the buildable boundary.

import * as THREE from 'three';

export function createGround(halfSize: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground';
  const size = halfSize * 2 + 8000;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: '#5f7a4e', roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHalf = { value: halfSize };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGridWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;\nuniform float uHalf;')
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
  return group;
}
