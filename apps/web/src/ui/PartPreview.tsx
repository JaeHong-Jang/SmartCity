// Small rotating 3D preview for the building/vehicle editors. One WebGL context while mounted.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      const m = c.material as THREE.Material | THREE.Material[];
      for (const x of Array.isArray(m) ? m : [m]) x.dispose();
    }
  });
}

export function PartPreview({ build, deps }: { build: () => THREE.Object3D; deps: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; root: THREE.Group } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#e0f2fe', '#334155', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 2);
    sun.position.set(3, 5, 2);
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3f4b3a' }));
    ground.name = 'preview-ground';
    scene.add(ground);
    const camera = new THREE.PerspectiveCamera(35, 2, 0.1, 5000);
    const root = new THREE.Group();
    scene.add(root);
    ctxRef.current = { renderer, scene, camera, root };
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      }
      root.rotation.y = ((performance.now() - t0) / 1000) * 0.5;
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      disposeTree(scene);
      renderer.dispose();
      ctxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const c of [...ctx.root.children]) {
      ctx.root.remove(c);
      disposeTree(c);
    }
    const obj = build();
    ctx.root.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.set(-center.x, 0, -center.z);
    const r = Math.max(size.x, size.y, size.z, 1);
    const ground = ctx.scene.getObjectByName('preview-ground');
    if (ground) ground.scale.setScalar(Math.max(size.x, size.z) * 0.9 + 1);
    ctx.camera.position.set(r * 1.6, r * 1.1 + size.y * 0.3, r * 1.6);
    ctx.camera.lookAt(0, size.y * 0.4, 0);
  }, [deps]);

  return <canvas ref={canvasRef} className="preview-canvas" />;
}
