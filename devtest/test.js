import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const out = document.getElementById('metrics');
const log = (s) => { out.textContent = s; };
const errors = [];
window.addEventListener('error', e => errors.push(String(e.message)));

function now(){ return performance.now(); }
function fmt(ms){ return Math.round(ms) + ' ms'; }

async function main(){
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('view');
  const W = stage.clientWidth, H = stage.clientHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161b);
  const camera = new THREE.PerspectiveCamera(38, W/H, 0.1, 100);
  camera.position.set(0, 1.6, 7.2);
  camera.lookAt(0, 0.85, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.9;

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5);
  rim.position.set(4, 2, -4);
  scene.add(rim);

  const loader = new THREE.TextureLoader();
  const tex = (url, srgb=false) => new Promise((res, rej) => {
    loader.load(url, t => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      res(t);
    }, undefined, rej);
  });

  const tTex0 = now();
  const [base, normal, rough, height, ao, opacity,
         gateDiff, gateNor, gateArm] = await Promise.all([
    tex('./assets/bamboo/Bamboo_4k_Basecolor.jpg', true),
    tex('./assets/bamboo/Bamboo_4k_Normal.jpg'),
    tex('./assets/bamboo/Bamboo_4k_Roughness.jpg'),
    tex('./assets/bamboo/Bamboo_4k_Height.jpg'),
    tex('./assets/bamboo/Bamboo_4k_AO.jpg'),
    tex('./assets/bamboo/Bamboo_4k_Opacity.jpg'),
    tex('./assets/gate/maps/large_iron_gate_diff_2k.jpg', true),
    tex('./assets/gate/maps/large_iron_gate_nor_gl_2k.jpg'),
    tex('./assets/gate/maps/large_iron_gate_arm_2k.jpg')
  ]);
  const tTex = now() - tTex0;

  // ---- material ball (Bamboo) ----
  const ballGeo = new THREE.SphereGeometry(1, 192, 192);
  ballGeo.setAttribute('uv1', ballGeo.attributes.uv);
  const ballMat = new THREE.MeshPhysicalMaterial({
    map: base, normalMap: normal, roughnessMap: rough, aoMap: ao,
    displacementMap: height, displacementScale: 0.035,
    roughness: 1.0, metalness: 0.0, aoMapIntensity: 1.0
  });
  ballMat.normalScale.set(1, 1);
  const ball = new THREE.Mesh(ballGeo, ballMat);
  ball.position.set(-2.05, 0.95, 0);
  scene.add(ball);

  // ---- gate model with packed ARM (three maps .r/.g/.b natively) ----
  const tModel0 = now();
  const fbx = await new Promise((res, rej) => new FBXLoader().load('./assets/gate/Gate_001.fbx', res, undefined, rej));
  const tModel = now() - tModel0;

  let meshes = 0, tris = 0, mats = 0;
  fbx.traverse(o => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      const m = new THREE.MeshPhysicalMaterial({
        map: gateDiff, normalMap: gateNor,
        aoMap: gateArm, roughnessMap: gateArm, metalnessMap: gateArm,
        roughness: 1.0, metalness: 1.0, aoMapIntensity: 1.0
      });
      m.roughness = 0.9;
      if (g.attributes.uv) g.setAttribute('uv1', g.attributes.uv);
      o.material = m;
      mats++;
    }
  });
  const box = new THREE.Box3().setFromObject(fbx);
  const size = new THREE.Vector3(); box.getSize(size);
  const scale = 2.6 / Math.max(size.x, size.y, size.z);
  fbx.scale.setScalar(scale);
  fbx.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(fbx);
  fbx.position.y -= box2.min.y;
  fbx.position.x = 1.5;
  scene.add(fbx);

  // ---- first frame ----
  const tFirst0 = now();
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  const tFirst = now() - tFirst0;

  // ---- fps ----
  const N = 60;
  const px = new Uint8Array(4);
  const tFps0 = now();
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 0.6;
    camera.position.x = Math.sin(a) * 1.2;
    camera.position.z = 7.2 * Math.cos(a * 0.5);
    camera.lookAt(0, 0.85, 0);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // force sync
  }
  const tFps = Math.max(now() - tFps0, 0.001);
  const fps = (N / tFps) * 1000;

  // ---- channel swizzle test ----
  // default ARM: AO=tex.r, Rough=tex.g, Metal=tex.b
  // swizzled: swap rough/metal (Rough=tex.b, Metal=tex.g) -> should differ
  const swzScene = new THREE.Scene();
  swzScene.background = new THREE.Color(0x050608);
  swzScene.environment = envRT.texture;
  const swzLight = new THREE.DirectionalLight(0xffffff, 3.0);
  swzLight.position.set(2, 3, 4);
  swzScene.add(swzLight);
  const swzAmb = new THREE.AmbientLight(0xffffff, 0.6);
  swzScene.add(swzAmb);
  const swzCam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
  swzCam.position.set(0, 0, 3);

  const rtA = new THREE.WebGLRenderTarget(64, 64);
  const rtB = new THREE.WebGLRenderTarget(64, 64);

  const matA = new THREE.MeshPhysicalMaterial({ roughnessMap: gateArm, metalnessMap: gateArm, roughness: 1, metalness: 1 });
  const matB = matA.clone();
  let swzHit = false;
  matB.customProgramCacheKey = () => 'swz-v1';
  matB.onBeforeCompile = (shader) => {
    const before = shader.fragmentShader;
    shader.fragmentShader = before
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
          roughnessFactor *= texelRoughness.b;
        #endif
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = metalness;
        #ifdef USE_METALNESSMAP
          vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
          metalnessFactor *= texelMetalness.g;
        #endif
      `);
    swzHit = shader.fragmentShader !== before;
  };
  matB.needsUpdate = true;
  const ballA = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), matA);
  const ballB = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), matB);
  swzScene.add(ballA);
  renderer.setRenderTarget(rtA); renderer.render(swzScene, swzCam);
  swzScene.remove(ballA); swzScene.add(ballB);
  renderer.setRenderTarget(rtB); renderer.render(swzScene, swzCam);
  renderer.setRenderTarget(null);
  const pxA = new Uint8Array(64*64*4), pxB = new Uint8Array(64*64*4);
  renderer.readRenderTargetPixels(rtA, 0, 0, 64, 64, pxA);
  renderer.readRenderTargetPixels(rtB, 0, 0, 64, 64, pxB);
  let diff = 0;
  for (let i = 0; i < pxA.length; i += 4) diff += Math.abs(pxA[i]-pxB[i]) + Math.abs(pxA[i+1]-pxB[i+1]) + Math.abs(pxA[i+2]-pxB[i+2]);
  diff = diff / (64*64*3);

  // ---- restore & final frame ----
  camera.position.set(0, 1.6, 7.2);
  camera.lookAt(0, 0.85, 0);
  renderer.render(scene, camera);

  const texMem = [base, normal, rough, height, ao, gateDiff, gateNor, gateArm]
    .reduce((s, t) => s + (t.image.width * t.image.height * 4), 0);

  const metrics = {
    three: THREE.REVISION,
    gpu,
    canvas: `${W}x${H}`,
    textureLoadMs: Math.round(tTex),
    textureCount: 9,
    textureMemoryMB: +(texMem / 1048576).toFixed(1),
    fbxParseMs: Math.round(tModel),
    meshes, triangles: Math.round(tris), materials: mats,
    compileAndFirstFrameMs: Math.round(tFirst),
    frames: N, frameMsAvg: +(tFps / N).toFixed(1), fps: +fps.toFixed(1),
    swizzleCompiled: !renderer.getContext().getError(),
    swizzleHit: swzHit,
    swizzlePixelDiff: +diff.toFixed(2),
    errors
  };
  log(JSON.stringify(metrics, null, 2));
  document.title = 'DONE ' + metrics.fps;
  try { await fetch('/__metrics?' + encodeURIComponent(JSON.stringify(metrics))); } catch(e) {}
}

main().catch(e => {
  out.textContent = 'FAILED: ' + (e && e.stack || e);
  document.title = 'FAILED';
});
