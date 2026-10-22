import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildMaterial, detectConfig } from './matlib';
import type { AssetDetail } from './types';
import { assertBinaryFbx } from './fbxcheck';

let renderer: THREE.WebGLRenderer | null = null;
let envTex: THREE.Texture | null = null;

function setup() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(512, 512, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

function baseScene(white: boolean) {
  const scene = new THREE.Scene();
  scene.background = white ? new THREE.Color(0xffffff) : null;
  if (envTex) scene.environment = envTex;
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-2.5, 4, 3.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.45);
  fill.position.set(3, 1.5, -2.5);
  scene.add(fill);
  return scene;
}

/** 按真实几何包围球自动取景，留出透明边距，保证主体不被裁切 */
function frameObject(camera: THREE.PerspectiveCamera, obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  let R = 0.001;
  obj.updateMatrixWorld(true);
  obj.traverse((o: any) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const s = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
    R = Math.max(R, s.center.distanceTo(center) + s.radius);
  });
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (R / Math.sin(fov / 2)) * 1.05;
  const dir = new THREE.Vector3(0.55, 0.28, 0.85).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(dist));
  camera.lookAt(center);
}

export async function renderThumb(detail: AssetDetail): Promise<string> {
  setup();
  const r = renderer!;
  const scene = baseScene(detail.type === 'model' || detail.type === 'scene');
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);

  if (detail.type === 'ies') {
    const f = detail.files.find(x => /\.ies$/i.test(x.rel_path));
    if (!f) throw new Error('no ies file');
    const txt = await (await fetch(`/api/file/${f.id}`)).text();
    const full = parseIesFull(txt);
    if (!full) throw new Error('ies parse failed');
    const tex = ies360Texture(full);
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x0e1013);
    let half = full.ver[full.ver.length - 1] || 30;
    for (let k = 1; k < full.cd.length; k++) {
      if ((full.cd[k][0] || 0) <= full.peak * 0.1) { half = full.ver[k]; break; }
    }
    const uni: any = {
      uIesTex: { value: tex },
      uLightPos: { value: new THREE.Vector3(0, 1.5, 1.0) },
      uIesColor: { value: new THREE.Color(0xffffff) },
      uIesIntensity: { value: 3.0 },
      uMaxPhi: { value: full.maxPhi },
      uMaxTheta: { value: full.maxTheta },
      uIesPeak: { value: full.peak },
      uIesGain: { value: 3.0 },
      uInnerRad: { value: (half * Math.PI) / 180 },
      uOuterRad: { value: (half * 2 * Math.PI) / 360 },
      uAxis: { value: new THREE.Vector3(0, -1, 0) },
      uBoth: { value: 0 },
      uAzOffset: { value: 0 }
    };
    const mat = iesMaterial({ color: 0xcccccc, roughness: 0.94, metalness: 0, side: THREE.DoubleSide }, uni);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), mat);
    floor.rotation.x = -Math.PI / 2; sc.add(floor);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.2), mat);
    wall.position.set(0, 1.6, 1.2); wall.rotation.y = Math.PI; sc.add(wall);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), mat);
    ceil.rotation.x = Math.PI / 2; ceil.position.y = 3.2; sc.add(ceil);
    const fixture = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.2, 20), new THREE.MeshStandardMaterial({ color: 0x33373f, metalness: 0.8, roughness: 0.4 }));
    fixture.add(body);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), new THREE.MeshBasicMaterial({ color: 0xfff7e8 }));
    lens.rotation.x = -Math.PI / 2; lens.position.y = -0.105; fixture.add(lens);
    fixture.position.set(0, 1.5, 1.0); sc.add(fixture);
    sc.add(new THREE.AmbientLight(0xffffff, 0.35));
    const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    cam.position.set(0, 1.5, -2.8); cam.lookAt(0, 1.5, 1.2);
    r.render(sc, cam);
    return r.domElement.toDataURL('image/png');
  }

  if (detail.type === 'model' || detail.type === 'scene') {
    const f = detail.files.find(x => /\.(fbx|obj|glb|gltf)$/i.test(x.rel_path));
    if (!f) throw new Error('no model file');
    const ext = (String(f.rel_path).match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
    const byName = new Map<string, number>();
    for (const it of detail.files) {
      const bn = String(it.rel_path).split('/').pop();
      if (bn) byName.set(bn.toLowerCase(), it.id);
    }
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      if (/^(data:|blob:|https?:)/i.test(url)) return url;
      let name = url;
      try { name = decodeURIComponent(url.split('?')[0]); } catch { /* keep */ }
      const id = byName.get(name.replace(/\\/g, '/').split('/').pop()!.toLowerCase());
      return id ? `/api/file/${id}` : url;
    });
    let obj: THREE.Object3D;
    if (ext === '.fbx') {
      await assertBinaryFbx(f.id, f.rel_path);
      obj = await new Promise<THREE.Group>((res, rej) => new FBXLoader(manager).load(`/api/file/${f.id}`, res, undefined, rej));
    } else if (ext === '.obj') {
      const mtl = detail.files.find(x => /\.mtl$/i.test(x.rel_path));
      const loader = new OBJLoader(manager);
      if (mtl) {
        const mtlLoader = new MTLLoader(manager);
        const mats: any = await new Promise((res, rej) => mtlLoader.load(`/api/file/${mtl.id}`, res, undefined, rej));
        if (mats?.preload) mats.preload();
        loader.setMaterials(mats);
      }
      obj = await new Promise<any>((res, rej) => loader.load(`/api/file/${f.id}`, res, undefined, rej));
    } else {
      const gl: any = await new Promise((res, rej) => new GLTFLoader(manager).load(`/api/file/${f.id}`, res, undefined, rej));
      obj = gl.scene || gl.scenes?.[0];
    }
    const mat = await buildMaterial(detail.files, detectConfig(detail.files, detail.slotMap));
    obj.traverse((o: any) => {
      if (o.isMesh) {
        if (o.geometry?.attributes?.uv) o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
        const own = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!own || !(own.map || own.emissiveMap)) o.material = mat;
      }
    });
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const s = 2.0 / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(s);
    obj.position.set(-center.x * s, -center.y * s, -center.z * s);
    scene.add(obj);
    frameObject(camera, obj);
  } else {
    const cfg = detectConfig(detail.files, detail.slotMap);
    const mat = await buildMaterial(detail.files, cfg);
    const g = new THREE.SphereGeometry(1, 128, 128);
    g.setAttribute('uv1', g.attributes.uv);
    const ball = new THREE.Mesh(g, mat);
    ball.rotation.y = -0.5;
    scene.add(ball);
    frameObject(camera, ball);
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
