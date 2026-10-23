// Small 3D preview for the building/vehicle editors. One WebGL context while mounted.
// Turns slowly until the user drags it (orbit); the wheel zooms. Lit and tone-mapped like the city.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
      c.geometry.dispose();
      const m = c.material as THREE.Material | THREE.Material[];
      for (const x of Array.isArray(m) ? m : [m]) x.dispose();
    }
  });
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  sun: THREE.DirectionalLight;
  orbit: { yaw: number; pitch: number; dist: number; targetY: number; auto: boolean };
}

export function PartPreview({ build, deps, height }: { build: () => THREE.Object3D; deps: unknown; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<Ctx | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#dbeafe', '#56603f', 1.25));
    const sun = new THREE.DirectionalLight('#fff3dd', 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.3;
    scene.add(sun, sun.target);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3f4b3a' }));
    ground.name = 'preview-ground';
    ground.receiveShadow = true;
    scene.add(ground);
    const camera = new THREE.PerspectiveCamera(35, 2, 0.1, 5000);
    const root = new THREE.Group();
    scene.add(root);
    const orbit = { yaw: Math.PI / 4, pitch: 0.5, dist: 50, targetY: 5, auto: true };
    ctxRef.current = { renderer, scene, camera, root, sun, orbit };

    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      orbit.auto = false;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      orbit.yaw -= (e.clientX - drag.x) * 0.01;
      orbit.pitch = Math.min(1.45, Math.max(0.05, orbit.pitch + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      orbit.dist = Math.min(4000, Math.max(5, orbit.dist * Math.exp(e.deltaY * 0.001)));
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });

    let raf = 0;
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (orbit.auto) orbit.yaw += ((now - last) / 1000) * 0.4;
      last = now;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      }
      const c = Math.cos(orbit.pitch);
      camera.position.set(Math.sin(orbit.yaw) * c * orbit.dist, orbit.targetY + Math.sin(orbit.pitch) * orbit.dist, Math.cos(orbit.yaw) * c * orbit.dist);
      camera.lookAt(0, orbit.targetY, 0);
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      disposeTree(scene);
      renderer.dispose();
      ctxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    // Add the new object before disposing the old one so shared shader programs stay compiled.
    const old = [...ctx.root.children];
    const obj = build();
    ctx.root.add(obj);
    ctx.renderer.compile(ctx.scene, ctx.camera);
    for (const c of old) {
      ctx.root.remove(c);
      disposeTree(c);
    }
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.set(-center.x, 0, -center.z);
    const r = Math.max(size.x, size.y, size.z, 1);
    const ground = ctx.scene.getObjectByName('preview-ground');
    if (ground) ground.scale.setScalar(Math.max(size.x, size.z) * 0.9 + 1);
    ctx.orbit.dist = r * 2.1;
    ctx.orbit.targetY = size.y * 0.4;
    const sc = ctx.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 0.5;
    sc.far = r * 6;
    sc.updateProjectionMatrix();
    ctx.sun.position.set(-r * 1.2, r * 2, r * 0.9);
  }, [deps]);

  return <canvas ref={canvasRef} className="preview-canvas" style={height ? { height } : undefined} />;
}
