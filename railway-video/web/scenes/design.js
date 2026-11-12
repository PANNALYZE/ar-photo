// 02 設計 — ジェネレーティブデザイン × 3次元FEM
// 位相最適化の反復履歴（data/design/）を、密度場を補間しながら毎フレーム等値面にして見せる。
import * as THREE from 'three';
import { createStage, groundGrid, boxEdges, boxMesh, COLORS } from '../lib/stage.js';
import { IsoMesher } from '../lib/isosurface.js';
import { chapter, subtitles, panel, tag, prompt } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fetchJson, fetchBin, el, fmt } from '../lib/util.js';

const T = { setup: 0, evolve: 5.5, verify: 25, beauty: 33, end: 40 };
const BLOCKS = [-3, -2, -1, 1, 2, 3, 4]; // 完成形の場面で前後に並べる標準ブロック

export async function create({ canvas, hud }) {
  const meta = await fetchJson('/data/design/meta.json');
  const frames = await fetchBin('/data/design/frames.bin');
  const stress = await fetchBin('/data/design/stress.bin');
  const { nx, ny, nz, h, nel, nframes, domain: D } = meta;
  const frame = (i) => frames.subarray(i * nel, (i + 1) * nel);
  const V = (x, y, z) => new THREE.Vector3(x, z, -y); // 解析座標 → 画面座標

  const st = createStage(canvas);
  const { scene, camera, world } = st;
  const center = V(D.LX / 2, D.LY / 2, 5.2);
  st.frameLeft(190, -20);
  const ground = groundGrid();
  ground.userData.setCenter(center.x, center.z);
  scene.add(ground);

  // --- 構造体（等値面メッシュ） -----------------------------------------
  const mesher = new IsoMesher(nx, ny, nz, h);
  const geo = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(mesher.positions, 3), normal: new THREE.BufferAttribute(mesher.normals, 3),
    aValue: new THREE.BufferAttribute(mesher.values, 1), aAO: new THREE.BufferAttribute(mesher.ao, 1),
  };
  for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a.setUsage(THREE.DynamicDrawUsage));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(D.LX / 2, D.LY / 2, D.LZ / 2), 40);
  const uStress = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.concrete, roughness: 0.86, metalness: 0.0 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uStress = uStress;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aValue; attribute float aAO; varying float vValue; varying float vAO; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvValue = aValue; vAO = aAO; vObj = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uStress; varying float vValue; varying float vAO; varying vec3 vObj;
        vec3 ramp(float x){
          vec3 a = vec3(0.10,0.22,0.48), b = vec3(0.16,0.66,0.95), c = vec3(0.88,0.94,0.90), d = vec3(1.0,0.66,0.22), e = vec3(0.95,0.22,0.16);
          x = pow(clamp(x, 0.0, 1.0), 0.6);
          return x < 0.25 ? mix(a,b,x*4.0) : x < 0.5 ? mix(b,c,(x-0.25)*4.0) : x < 0.75 ? mix(c,d,(x-0.5)*4.0) : mix(d,e,(x-0.75)*4.0);
        }
        float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(hash3(i), hash3(i+vec3(1,0,0)), f.x), mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x), mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float grain = vnoise(vObj * 1.7) * 0.55 + vnoise(vObj * 7.0) * 0.3 + vnoise(vObj * 31.0) * 0.15;  // コンクリートの色むら
        float occ = 1.0 - 0.72 * smoothstep(0.40, 0.82, vAO);                                            // 入隅の陰り
        diffuseColor.rgb = mix(diffuseColor.rgb * (0.86 + 0.2 * grain), ramp(vValue), uStress) * occ;`);
  };
  const body = new THREE.Mesh(geo, mat);
  body.castShadow = body.receiveShadow = true;
  body.frustumCulled = false;
  world.add(body);

  let lastKey = '';
  const remesh = (f, iso, withStress) => {
    const i = clamp(Math.floor(f), 0, nframes - 1), j = Math.min(i + 1, nframes - 1);
    const key = `${f.toFixed(4)}|${iso.toFixed(3)}|${withStress}`;
    if (key === lastKey) return;
    lastKey = key;
    mesher.load(frame(i), frame(j), f - i);
    if (withStress) mesher.loadAux(stress, null, 0, 1 / 255);
    geo.setDrawRange(0, mesher.build(iso));
    for (const a of Object.values(attrs)) a.needsUpdate = true;
  };

  // --- 与条件の表示（設計領域・建築限界・フーチング・荷重） ---------------
  const given = new THREE.Group();
  world.add(given);
  const rx0 = D.LX / 2 - D.road_half_w, rx1 = D.LX / 2 + D.road_half_w;
  given.add(
    boxEdges([0, 0, 0], [D.LX, D.LY, D.LZ], COLORS.cyan, 0.55),
    boxEdges([rx0, -3, 0], [rx1, D.LY + 3, D.road_h], COLORS.amber, 0.9),
    boxMesh([rx0, -3, 0], [rx1, D.LY + 3, D.road_h],
      new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide })));
  const padMat = new THREE.MeshStandardMaterial({ color: 0x7d8791, roughness: 0.9 });
  const addPads = (group, x0) => {
    for (const px of D.pad_x) for (const py of D.pad_y) {
      const p = boxMesh([x0 + px - D.pad / 2 - 0.6, py - D.pad / 2 - 0.6, -1.2], [x0 + px + D.pad / 2 + 0.6, py + D.pad / 2 + 0.6, 0.03], padMat);
      p.receiveShadow = true;
      group.add(p);
    }
  };
  addPads(world, 0);
  // 交差道路
  const road = new THREE.Group();
  world.add(road);
  const asphalt = boxMesh([rx0 + 0.6, -90, 0], [rx1 - 0.6, 90, 0.04], new THREE.MeshStandardMaterial({ color: 0x10151c, roughness: 0.62 }));
  asphalt.receiveShadow = true;
  road.add(asphalt);
  const dash = new THREE.MeshBasicMaterial({ color: 0x8794a0 });
  for (let y = -88; y < 90; y += 9) road.add(boxMesh([D.LX / 2 - 0.08, y, 0.05], [D.LX / 2 + 0.08, y + 4, 0.06], dash));
  for (const x of [rx0 + 1.1, rx1 - 1.1]) road.add(boxMesh([x - 0.06, -90, 0.05], [x + 0.06, 90, 0.06], dash));
  // 軌道（レール）
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9fb0be, roughness: 0.35, metalness: 0.9 });
  const rails = (group, x0, x1) => {
    for (const ty of D.track_y) for (const s of [-0.7175, 0.7175]) group.add(boxMesh([x0, ty + s - 0.035, D.LZ], [x1, ty + s + 0.035, D.LZ + 0.16], railMat));
  };
  rails(world, -0.1, D.LX + 0.1);
  // 荷重矢印
  const arrows = new THREE.Group();
  world.add(arrows);
  const arrow = (from, dir, len, color) => {
    const a = new THREE.ArrowHelper(new THREE.Vector3(...dir).normalize(), new THREE.Vector3(...from), len, color, 0.55, 0.3);
    a.line.material.transparent = a.cone.material.transparent = true;
    arrows.add(a);
  };
  for (const ty of D.track_y) for (let x = 1.5; x < D.LX; x += 3) arrow([x, ty, D.LZ + 3.4], [0, 0, -1], 3.0, COLORS.cyan);
  for (let x = 3; x < D.LX; x += 6) arrow([x, -3.2, D.LZ - 0.3], [0, 1, 0], 2.8, COLORS.amber);
  for (const y of [2.4, D.LY - 2.4]) arrow([-3.2, y, D.LZ - 0.3], [1, 0, 0], 2.8, COLORS.amber);
  const setOpacity = (group, o) => group.traverse((m) => {
    if (m.material) { m.material.opacity = (m.userData.o0 ??= m.material.opacity) * o; m.visible = o > 0.002; }
  });

  // --- 完成形の場面：前後の標準ブロック、高欄、架線、列車 ------------------
  const line = new THREE.Group();
  line.visible = false;
  world.add(line);
  for (const k of BLOCKS) {
    const m = new THREE.Mesh(geo, mat);
    m.position.x = k * D.LX;
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    line.add(m);
    addPads(line, k * D.LX);
  }
  const X0 = BLOCKS[0] * D.LX, X1 = (BLOCKS.at(-1) + 1) * D.LX;
  rails(line, X0, -0.1); rails(line, D.LX + 0.1, X1);
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9c1c8, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x55626e, roughness: 0.5, metalness: 0.7 });
  for (const y of [0, D.LY - 0.22]) {
    const w = boxMesh([X0, y, D.LZ], [X1, y + 0.22, D.LZ + 1.15], concrete);
    w.castShadow = true;
    line.add(w);
  }
  const wire = new THREE.LineBasicMaterial({ color: 0x8195a6 });
  for (let x = X0 + 7.5; x < X1; x += 15) for (const [y, dir] of [[-0.25, 1], [D.LY + 0.25, -1]]) {
    const ty = dir > 0 ? D.track_y[0] : D.track_y[1];
    line.add(boxMesh([x - 0.11, y - 0.11, D.LZ - 0.4], [x + 0.11, y + 0.11, D.LZ + 7.0], steel));
    line.add(boxMesh([x - 0.05, Math.min(y, ty), D.LZ + 6.3], [x + 0.05, Math.max(y, ty), D.LZ + 6.42], steel));
  }
  for (const ty of D.track_y) for (const z of [D.LZ + 5.3, D.LZ + 6.3]) {
    line.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(X0, ty, z), new THREE.Vector3(X1, ty, z)]), wire));
  }
  const train = new THREE.Group();
  line.add(train);
  const CAR = 20, GAP = 0.6, NCAR = 6, TW = 2.95;
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9eef3, roughness: 0.28, metalness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b0f14, emissive: 0xffd9a0, emissiveIntensity: 1.25 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0x0c2a3a, emissive: COLORS.cyan, emissiveIntensity: 1.3 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xffffff });
  lamp.color.multiplyScalar(6);
  for (let c = 0; c < NCAR; c++) {
    const x1 = -c * (CAR + GAP), x0 = x1 - CAR;
    const car = boxMesh([x0, -TW / 2, 0.5], [x1, TW / 2, 3.95], shell);
    if (c === 0) {  // 先頭車：前面を絞って流線形にする
      const p = car.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getX(i) > 0) { p.setY(i, p.getY(i) * 0.5); if (p.getZ(i) > 0) p.setZ(i, p.getZ(i) - 1.5); p.setX(i, p.getX(i) + 2.2); }
      car.geometry.computeVertexNormals();
      for (const y of [-0.5, 0.5]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), lamp); l.position.set(2.3, y, 1.15); train.add(l); }
    }
    car.castShadow = true;
    train.add(car);
    for (const s of [-1, 1]) {
      train.add(boxMesh([x0 + 1.2, s * (TW / 2 + 0.01) - 0.01, 2.25], [x1 - (c === 0 ? 3.5 : 1.2), s * (TW / 2 + 0.01) + 0.01, 3.1], glass));
      train.add(boxMesh([x0 + 0.2, s * (TW / 2 + 0.012) - 0.01, 1.55], [x1 - (c === 0 ? 1.5 : 0.2), s * (TW / 2 + 0.012) + 0.01, 1.7], stripe));
    }
  }
  train.position.set(0, D.track_y[0], D.LZ + 0.16);

  // --- 文字 ---------------------------------------------------------------
  const chap = chapter(hud, '02', '設計', 'GENERATIVE DESIGN × 3D FEM');
  const ask = prompt(hud, '交差道路の建築限界を守り、同じコンクリート量で最も剛な高架橋を。', 0.8, T.evolve + 3);
  const sub = subtitles(hud, [
    [0.6, 5.2, '与えるのは、<em>条件</em>だけ。'],
    [6.0, 13.5, '形は、<em>力の流れ</em>からAIが導き出す。'],
    [14.0, 24.5, '3次元FEMを反復するたび、不要な材料が消えていく。'],
    [25.3, 32.6, meta.claim_html],
    [33.4, 39.4, '設計者は、<em>条件と判断</em>に集中する。'],
  ]);
  const p = panel(hud, 'TOPOLOGY OPTIMIZATION', [
    ['el', '要素数'], ['dof', '自由度'], ['it', '反復'], ['vol', '体積率'], ['obj', '従来型比（最も不利な荷重）'],
  ]);
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 240;
  p.node.appendChild(cv);
  el(p.node, 'cap', 'コンプライアンスの従来型比（1.0 未満で従来型より高剛性）');
  const g2 = cv.getContext('2d');
  const objs = meta.iters.map((r) => r.objective);
  const drawGraph = (f) => {
    g2.clearRect(0, 0, 800, 240);
    const lo = Math.log10(Math.min(...objs, 1)) - 0.12, hi = Math.log10(Math.max(...objs)) + 0.05;
    const X = (i) => 10 + (i / (nframes - 1)) * 780, Y = (v) => 14 + (1 - (Math.log10(v) - lo) / (hi - lo)) * 212;
    g2.setLineDash([10, 8]); g2.strokeStyle = 'rgba(255,180,84,.75)'; g2.lineWidth = 2;   // 従来型 = 1.0 の線
    g2.beginPath(); g2.moveTo(10, Y(1)); g2.lineTo(790, Y(1)); g2.stroke(); g2.setLineDash([]);
    g2.fillStyle = 'rgba(255,180,84,.9)'; g2.font = '24px "JetBrains Mono"'; g2.fillText('1.0', 744, Y(1) - 8);
    g2.strokeStyle = '#58d6ff'; g2.lineWidth = 4; g2.lineJoin = 'round'; g2.beginPath();
    const n = Math.floor(f);
    for (let i = 0; i <= n; i++) g2[i ? 'lineTo' : 'moveTo'](X(i), Y(objs[i]));
    const last = n < nframes - 1 ? objs[n] * (objs[n + 1] / objs[n]) ** (f - n) : objs[n];
    g2.lineTo(X(f), Y(last)); g2.stroke();
    g2.fillStyle = '#eaf3fa'; g2.beginPath(); g2.arc(X(f), Y(last), 7, 0, 7); g2.fill();
    return last;
  };
  const tDomain = tag(hud, `<i>設計領域</i> ${D.LX} × ${D.LY} × ${D.LZ} m`, 'c');
  const tClear = tag(hud, `<i>建築限界（交差道路）</i> ${D.road_half_w * 2} × ${D.road_h} m`);
  const tLoad = tag(hud, '<i>列車荷重・地震時水平力</i>', 'c');
  el(hud, 'note', '※ 寸法・荷重は架空条件／線形弾性解析による剛性の比較');

  return {
    duration: T.end,
    render(t) {
      const beauty = t >= T.beauty;
      line.visible = beauty;
      if (!beauty) {
        // 構造物のまわりをゆっくり回り込む
        const az = lerp(-0.72, 0.42, easeInOut(seg(t, 0, T.beauty))) + 0.05 * Math.sin(t * 0.4);
        const dist = lerp(78, 60, ease(seg(t, 0, 9)));
        const elev = lerp(0.30, 0.17, ease(seg(t, T.verify - 2, T.beauty)));
        camera.position.set(center.x + dist * Math.sin(az) * Math.cos(elev), center.y + dist * Math.sin(elev) + 1.5,
          center.z + dist * Math.cos(az) * Math.cos(elev));
        camera.lookAt(center.x, center.y + 0.6, center.z);
        st.frameLeft(190, -20);
        st.aim(center, 30);
      } else {
        // 完成形：道路から見上げる。列車が通過する
        const k = seg(t, T.beauty, T.end);
        camera.position.copy(V(lerp(-13, -6, k), lerp(-33, -29, k), lerp(2.2, 3.0, k)));
        camera.lookAt(V(D.LX / 2 + 16, D.LY / 2, 8.8));
        st.frameLeft(0, 0);
        st.aim(V(D.LX / 2 + 15, D.LY / 2, 5), 75);
        train.position.x = lerp(-75, 170, k);
      }
      camera.updateMatrixWorld();

      // 与条件の表示は最適化が進むと薄れる
      const gv = ease(seg(t, 0.2, 1.6)) * lerp(1, 0, ease(seg(t, T.evolve + 6, T.evolve + 10)));
      setOpacity(given, gv);
      setOpacity(arrows, ease(seg(t, 2.2, 3.4)) * lerp(1, 0, ease(seg(t, T.evolve + 2, T.evolve + 5))));

      // 反復の進行
      const prog = ease(seg(t, T.evolve, T.verify - 1.5));
      const f = prog * (nframes - 1);
      const iso = lerp(0.3, 0.5, seg(f, 4, 16));
      const sv = ease(seg(t, T.verify, T.verify + 1.5)) * (1 - ease(seg(t, T.beauty - 1.6, T.beauty - 0.2)));
      uStress.value = sv;
      remesh(f, iso, sv > 0);

      // 文字
      sub(t); ask(t);
      chap.style.opacity = 1 - ease(seg(t, T.beauty - 0.8, T.beauty));
      const it = Math.min(Math.floor(f), nframes - 1), r = meta.iters[it];
      const stg = meta.stages[r.stage - 1];
      p.set('el', fmt(stg.nel));
      p.set('dof', fmt(stg.ndof));
      p.set('it', `${String(it + 1).padStart(2, '0')}<small>/ ${nframes}</small>`);
      p.set('vol', `${(r.volume * 100).toFixed(1)}<small>%</small>`);
      const last = drawGraph(f);
      p.set('obj', last.toFixed(3), last < 1 ? 'ok' : 'warn');
      p.node.style.opacity = ease(seg(t, T.evolve - 1.2, T.evolve)) * (1 - ease(seg(t, T.beauty - 0.8, T.beauty)));
      tDomain(camera, V(D.LX + 1.5, D.LY, D.LZ + 1.8), gv);
      tClear(camera, V(D.LX / 2, -3, D.road_h + 0.9), gv);
      tLoad(camera, V(1.5, D.LY / 2, D.LZ + 5.2), ease(seg(t, 2.4, 3.4)) * (1 - ease(seg(t, T.evolve + 2, T.evolve + 4))));
      st.render();
    },
  };
}
