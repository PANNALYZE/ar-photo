// 02 設計 — ジェネレーティブデザイン × 3次元FEM
// 位相最適化の反復履歴（data/design/）を、密度場を補間しながら毎フレーム等値面にして見せる。
import * as THREE from 'three';
import { createStage, groundGrid, boxEdges, boxMesh, COLORS } from '../lib/stage.js';
import { IsoMesher } from '../lib/isosurface.js';
import { chapter, subtitles, panel, tag } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fade, fetchJson, fetchBin, el, fmt } from '../lib/util.js';

const T = { setup: 0, evolve: 5.5, verify: 25, beauty: 33, end: 40 };

export async function create({ canvas, hud }) {
  const meta = await fetchJson('/data/design/meta.json');
  const frames = await fetchBin('/data/design/frames.bin');
  const stress = await fetchBin('/data/design/stress.bin');
  const { nx, ny, nz, h, nel, nframes, domain: D } = meta;
  const frame = (i) => frames.subarray(i * nel, (i + 1) * nel);

  const st = createStage(canvas);
  const { scene, camera, world } = st;
  const center = new THREE.Vector3(D.LX / 2, 5.2, -D.LY / 2);
  st.aim(center, 30);
  st.frameLeft(190, -20);
  const ground = groundGrid();
  ground.userData.setCenter(center.x, center.z);
  scene.add(ground);

  // --- 構造体（等値面メッシュ） -----------------------------------------
  const mesher = new IsoMesher(nx, ny, nz, h);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(mesher.positions, 3).setUsage(THREE.DynamicDrawUsage);
  const aNor = new THREE.BufferAttribute(mesher.normals, 3).setUsage(THREE.DynamicDrawUsage);
  const aVal = new THREE.BufferAttribute(mesher.values, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos).setAttribute('normal', aNor).setAttribute('aValue', aVal);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(D.LX / 2, D.LY / 2, D.LZ / 2), 40);
  const uStress = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.concrete, roughness: 0.84, metalness: 0.02 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uStress = uStress;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aValue; varying float vValue;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvValue = aValue;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uStress; varying float vValue;
        vec3 ramp(float x){
          vec3 a = vec3(0.10,0.22,0.48), b = vec3(0.16,0.66,0.95), c = vec3(0.88,0.94,0.90), d = vec3(1.0,0.66,0.22), e = vec3(0.95,0.22,0.16);
          x = pow(clamp(x, 0.0, 1.0), 0.6);
          return x < 0.25 ? mix(a,b,x*4.0) : x < 0.5 ? mix(b,c,(x-0.25)*4.0) : x < 0.75 ? mix(c,d,(x-0.5)*4.0) : mix(d,e,(x-0.75)*4.0);
        }`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, ramp(vValue), uStress);');
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
    const n = mesher.build(iso);
    aPos.needsUpdate = aNor.needsUpdate = aVal.needsUpdate = true;
    geo.setDrawRange(0, n);
  };

  // --- 与条件の表示（設計領域・建築限界・フーチング・荷重） ---------------
  const given = new THREE.Group();
  world.add(given);
  const domainBox = boxEdges([0, 0, 0], [D.LX, D.LY, D.LZ], COLORS.cyan, 0.55);
  const rx0 = D.LX / 2 - D.road_half_w, rx1 = D.LX / 2 + D.road_half_w;
  const clearBox = boxEdges([rx0, -3, 0], [rx1, D.LY + 3, D.road_h], COLORS.amber, 0.9);
  const clearFill = boxMesh([rx0, -3, 0], [rx1, D.LY + 3, D.road_h],
    new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
  given.add(domainBox, clearBox, clearFill);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x8a949e, roughness: 0.9 });
  for (const px of D.pad_x) for (const py of D.pad_y) {
    const p = boxMesh([px - D.pad / 2 - 0.6, py - D.pad / 2 - 0.6, -1.2], [px + D.pad / 2 + 0.6, py + D.pad / 2 + 0.6, 0.02], padMat);
    p.receiveShadow = true;
    world.add(p);
  }
  // 交差道路
  const road = new THREE.Group();
  world.add(road);
  road.add(boxMesh([rx0 + 0.6, -80, 0], [rx1 - 0.6, 80, 0.04], new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.7 })));
  road.children[0].receiveShadow = true;
  const dash = new THREE.MeshBasicMaterial({ color: 0x9aa7b3 });
  for (let y = -78; y < 80; y += 9) road.add(boxMesh([D.LX / 2 - 0.08, y, 0.05], [D.LX / 2 + 0.08, y + 4, 0.06], dash));
  for (const x of [rx0 + 1.1, rx1 - 1.1]) road.add(boxMesh([x - 0.06, -80, 0.05], [x + 0.06, 80, 0.06], dash));
  // 軌道（レール）
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9fb0be, roughness: 0.35, metalness: 0.9 });
  const track = new THREE.Group();
  world.add(track);
  for (const ty of D.track_y) for (const s of [-0.7175, 0.7175]) {
    track.add(boxMesh([-0.2, ty + s - 0.035, D.LZ], [D.LX + 0.2, ty + s + 0.035, D.LZ + 0.16], railMat));
  }
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
  const setOpacity = (group, o) => group.traverse((m) => { if (m.material) { m.material.opacity = (m.userData.o0 ??= m.material.opacity) * o; m.visible = o > 0.002; } });

  // --- 文字 ---------------------------------------------------------------
  chapter(hud, '02', '設計', 'GENERATIVE DESIGN × 3D FEM');
  const sub = subtitles(hud, [
    [0.6, 5.2, '与えるのは、<em>条件</em>だけ。'],
    [6.0, 13.5, '形は、<em>力の流れ</em>からAIが導き出す。'],
    [14.0, 24.5, '3次元FEMを反復するたび、不要な材料が消えていく。'],
    [25.3, 32.6, '同じコンクリート量で、剛性は従来型の <strong data-gain></strong>。'],
    [33.4, 39.4, '設計者は、<em>条件と判断</em>に集中する。'],
  ]);
  const p = panel(hud, 'TOPOLOGY OPTIMIZATION', [
    ['el', '要素数'], ['dof', '自由度'], ['it', '反復'], ['vol', '体積率'], ['obj', '目的関数（初期比）'],
  ]);
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 240;
  p.node.appendChild(cv);
  el(p.node, 'cap', '重み付きコンプライアンス（3荷重ケース）の収束');
  const g2 = cv.getContext('2d');
  const objs = meta.iters.map((r) => r.objective);
  const drawGraph = (f) => {
    g2.clearRect(0, 0, 800, 240);
    const lo = Math.log10(Math.min(...objs)) - 0.1, hi = Math.log10(objs[0]) + 0.05;
    const X = (i) => 10 + (i / (nframes - 1)) * 780, Y = (v) => 14 + (1 - (Math.log10(v) - lo) / (hi - lo)) * 212;
    g2.strokeStyle = 'rgba(130,190,230,.18)'; g2.lineWidth = 1;
    for (let k = 0; k < 4; k++) { g2.beginPath(); g2.moveTo(10, 14 + k * 70.6); g2.lineTo(790, 14 + k * 70.6); g2.stroke(); }
    g2.strokeStyle = '#58d6ff'; g2.lineWidth = 4; g2.lineJoin = 'round'; g2.beginPath();
    const n = Math.floor(f);
    for (let i = 0; i <= n; i++) g2[i ? 'lineTo' : 'moveTo'](X(i), Y(objs[i]));
    const fr = f - n, last = n < nframes - 1 ? objs[n] * (objs[n + 1] / objs[n]) ** fr : objs[n];
    g2.lineTo(X(f), Y(last)); g2.stroke();
    g2.fillStyle = '#eaf3fa'; g2.beginPath(); g2.arc(X(f), Y(last), 7, 0, 7); g2.fill();
    return last;
  };
  const gain = Math.min(...meta.stiffness_gain);
  const tDomain = tag(hud, `<i>設計領域</i> ${D.LX} × ${D.LY} × ${D.LZ} m`, 'c');
  const tClear = tag(hud, `<i>建築限界（交差道路）</i> ${D.road_half_w * 2} × ${D.road_h} m`);
  const tLoad = tag(hud, '<i>列車荷重・地震時水平力</i>', 'c');
  el(hud, 'note', '※ 寸法・荷重はデモ用の架空条件です');

  const V = (x, y, z) => new THREE.Vector3(x, z, -y); // 解析座標 → 画面座標

  return {
    duration: T.end,
    render(t) {
      // カメラ：構造物のまわりをゆっくり回り込む
      const az = lerp(-0.72, 0.5, easeInOut(seg(t, 0, T.end))) + 0.05 * Math.sin(t * 0.4);
      const dist = lerp(78, 60, ease(seg(t, 0, 9))) + lerp(0, -6, ease(seg(t, T.beauty, T.end)));
      const elev = lerp(0.30, 0.16, ease(seg(t, T.verify - 2, T.beauty + 3)));
      camera.position.set(center.x + dist * Math.sin(az) * Math.cos(elev), center.y + dist * Math.sin(elev) + 1.5,
        center.z + dist * Math.cos(az) * Math.cos(elev));
      camera.lookAt(center.x, center.y + 0.6, center.z);
      camera.updateMatrixWorld();

      // 与条件の表示は最適化が進むと薄れる
      const gv = ease(seg(t, 0.2, 1.6)) * lerp(1, 0, ease(seg(t, T.evolve + 6, T.evolve + 10)));
      setOpacity(given, gv);
      setOpacity(arrows, ease(seg(t, 2.2, 3.4)) * lerp(1, 0, ease(seg(t, T.evolve + 2, T.evolve + 5))));

      // 反復の進行：序盤はゆっくり、形が見えてからは速く
      const prog = ease(seg(t, T.evolve, T.verify - 1.5));
      const f = prog * (nframes - 1);
      const iso = lerp(0.3, 0.5, seg(f, 4, 16));
      const sv = ease(seg(t, T.verify, T.verify + 1.5)) * (1 - ease(seg(t, T.beauty - 0.5, T.beauty + 1.5)));
      uStress.value = sv;
      remesh(f, iso, sv > 0);

      // 文字
      sub(t);
      hud.querySelectorAll('[data-gain]').forEach((n) => { n.textContent = `${gain.toFixed(1)} 倍以上`; });
      const it = Math.min(Math.floor(f), nframes - 1), r = meta.iters[it];
      const stg = meta.stages[r.stage - 1];
      p.set('el', fmt(stg.nel));
      p.set('dof', fmt(stg.ndof));
      p.set('it', `${String(it + 1).padStart(2, '0')}<small>/ ${nframes}</small>`);
      p.set('vol', `${(r.volume * 100).toFixed(1)}<small>%</small>`);
      const last = drawGraph(f);
      p.set('obj', `${(last / objs[0] * 100).toFixed(2)}<small>%</small>`, prog >= 1 ? 'ok' : '');
      p.node.style.opacity = ease(seg(t, T.evolve - 1.2, T.evolve));
      tDomain(camera, V(D.LX + 1.5, D.LY, D.LZ + 1.8), gv);
      tClear(camera, V(D.LX / 2, -3, D.road_h + 0.9), gv);
      tLoad(camera, V(1.5, D.LY / 2, D.LZ + 5.2), ease(seg(t, 2.4, 3.4)) * (1 - ease(seg(t, T.evolve + 2, T.evolve + 4))));
      st.render();
    },
  };
}
