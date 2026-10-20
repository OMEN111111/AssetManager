import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildMaterial, detectConfig } from './matlib';
import type { AssetDetail } from './types';

let renderer: THREE.WebGLRenderer | null = null;
let envTex: THREE.Texture | null = null;

function setup() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(512, 512, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

function baseScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171c);
  if (envTex) scene.environment = envTex;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-2.5, 4, 3.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
  fill.position.set(3, 1.5, -2.5);
  scene.add(fill);
  return scene;
}

export async function renderThumb(detail: AssetDetail): Promise<string> {
  setup();
  const r = renderer!;
  const scene = baseScene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);

  if (detail.type === 'model' || detail.type === 'scene') {
    const f = detail.files.find(x => /\.fbx$/i.test(x.rel_path));
    if (!f) throw new Error('no fbx');
    const obj = await new Promise<THREE.Group>((res, rej) =>
      new FBXLoader().load(`/api/file/${f.id}`, res, undefined, rej));
    const mat = await buildMaterial(detail.files, detectConfig(detail.files));
    obj.traverse((o: any) => {
      if (o.isMesh) {
        if (o.geometry?.attributes?.uv) o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
        o.material = mat;
      }
    });
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const s = 2.0 / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(s);
    obj.position.set(-center.x * s, -center.y * s, -center.z * s);
    scene.add(obj);
    camera.position.set(2.1, 1.5, 3.4);
    camera.lookAt(0, 0, 0);
  } else {
    const cfg = detectConfig(detail.files);
    const mat = await buildMaterial(detail.files, cfg);
    const g = new THREE.SphereGeometry(1, 128, 128);
    g.setAttribute('uv1', g.attributes.uv);
    const ball = new THREE.Mesh(g, mat);
    ball.rotation.y = -0.5;
    scene.add(ball);
    camera.position.set(0, 0.15, 3.1);
    camera.lookAt(0, 0, 0);
  }

  r.setSize(512, 512, false);
  r.render(scene, camera);
  const url = r.domElement.toDataURL('image/png');

  scene.traverse((o: any) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
  });
  return url;
}
