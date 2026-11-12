import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { registerWidget } from '../bh-profile.ts';
import type { Dataset } from '../mocks/seed.ts';

type SceneData = Dataset['widgets']['scene'];

const WIDTH = 480;
const HEIGHT = 240;
const LAYERS = ['Продажи', 'Себестоимость', 'Маржа'];

export function Scene3d({ data }: { data: SceneData }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true });
    } catch {
      // Headless без GPU может отказать в контексте: экран должен остаться проходимым.
      scene.current = null;
      return;
    }
    renderer.setSize(WIDTH, HEIGHT, false);

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
    camera.position.set(4, 3, 6);
    camera.lookAt(0, 0, 0);
    world.add(new THREE.AmbientLight(0xffffff, 0.8));

    const maxValue = Math.max(...data.objects.map((object) => object.value), 1);
    data.objects.forEach((object, index) => {
      const height = Math.max((object.value / maxValue) * 3, 0.2);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, height, 0.8),
        new THREE.MeshStandardMaterial({ color: 0x2f6fed }),
      );
      mesh.name = object.name;
      mesh.position.set(index * 1.1 - (data.objects.length * 1.1) / 2, height / 2, 0);
      world.add(mesh);
    });

    scene.current = world;
    renderer.render(world, camera);

    const onContextLost = (): void => {
      scene.current = null;
    };
    element.addEventListener('webglcontextlost', onContextLost);

    return () => {
      element.removeEventListener('webglcontextlost', onContextLost);
      scene.current = null;
      renderer.dispose();
    };
  }, [data]);

  useEffect(() => registerWidget({
    descriptor: { widget: 'scene', kind: 'scene', node: '[data-testid="widget-scene"]' },
    extract: () => ({ objects: data.objects.map(({ name, value }) => ({ name, value })) }),
    sceneInfo: () => {
      const world = scene.current;
      if (world === null) return null;
      return { objects: world.children.length, layers: [...LAYERS] };
    },
  }), [data]);

  return (
    <section className="widget" data-testid="widget-scene">
      <h2>3D-сцена</h2>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} data-testid="scene-canvas" />
    </section>
  );
}
