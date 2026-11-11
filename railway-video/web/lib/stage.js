// 全シーン共通の3Dステージ（レンダラ・照明・床グリッド）。
// 解析エンジンの座標系 (x: 橋軸, y: 橋軸直角, z: 鉛直) のまま置けるよう、world グループを回転させておく。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const COLORS = { bg: 0x04070c, cyan: 0x58d6ff, amber: 0xffb454, concrete: 0xcdd4da, red: 0xff6b5e };

export function createStage(canvas, { fog = 0.0075, shadows = true, bloom = 0.42 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(1920, 1080, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.bg, fog);
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 900);
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  scene.add(new THREE.HemisphereLight(0x8fb8e8, 0x0a0e14, 0.55));
  const key = new THREE.DirectionalLight(0xffe6cc, 2.6);
  key.castShadow = shadows;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x58c8ff, 1.7);
  scene.add(rim, rim.target);

  // 光源を注視点のまわりに置く（影の範囲 size [m]）
  const aim = (center, size = 40) => {
    key.position.copy(center).add(new THREE.Vector3(-0.55, 0.95, 0.75).multiplyScalar(size * 2));
    key.target.position.copy(center);
    const c = key.shadow.camera;
    c.left = c.bottom = -size; c.right = c.top = size; c.near = 1; c.far = size * 5;
    c.updateProjectionMatrix();
    rim.position.copy(center).add(new THREE.Vector3(0.7, 0.45, -0.9).multiplyScalar(size * 2));
    rim.target.position.copy(center);
  };
  aim(new THREE.Vector3());

  // 発光（ブルーム）つきの合成。MSAA 付きの浮動小数ターゲットに描いてからトーンマップする
  let render = () => renderer.render(scene, camera);
  if (bloom > 0) {
    const target = new THREE.WebGLRenderTarget(1920, 1080, { samples: 4, type: THREE.HalfFloatType });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1920, 1080), bloom, 0.7, 0.82));
    composer.addPass(new OutputPass());
    render = () => composer.render();
  }
  // 被写体を画面左寄りに置く（右側の計測パネルと重ならないようにする）
  const frameLeft = (px = 170, py = 0) => camera.setViewOffset(1920, 1080, px, py, 1920, 1080);

  return { renderer, scene, camera, world, key, rim, aim, frameLeft, render: () => render() };
}

// 距離で減衰する床グリッド（影も受ける）
export function groundGrid({ size = 600, cell = 5, color = COLORS.cyan } = {}) {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.95, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const lines = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uCell: { value: cell }, uCenter: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec3 vP; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uCell; uniform vec2 uCenter; varying vec3 vP;
      float grid(vec2 p, float c){ vec2 q = p / c; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        float a = grid(vP.xz, uCell) * 0.07 + grid(vP.xz, uCell * 5.0) * 0.16;
        float d = length(vP.xz - uCenter);
        a *= exp(-d * 0.016);
        gl_FragColor = vec4(uColor, a);
      }`,
  }));
  lines.rotation.x = -Math.PI / 2;
  lines.position.y = 0.02;
  g.add(floor, lines);
  g.userData.setCenter = (x, z) => lines.material.uniforms.uCenter.value.set(x, z);
  return g;
}

// 直方体の稜線（設計領域や建築限界の表示用）。解析座標系の min/max を渡す
export function boxEdges(min, max, color, opacity = 1) {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return m;
}

export function boxMesh(min, max, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), material);
  m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return m;
}
