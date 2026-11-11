// 01 計画 — 生成的ルート探索
// 架空の地形の上で、進化計算が生成した線形案（data/plan/）が世代ごとに収束していく様子を見せる。
import * as THREE from 'three';
import { createStage, groundGrid, COLORS } from '../lib/stage.js';
import { chapter, subtitles, panel, tag, prompt } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fetchJson, fetchBin, el, fmt } from '../lib/util.js';

const T = { rise: 0, swarm: 5.5, result: 17.5, fly: 24.5, end: 31 };
const S = 0.01, VE = 2.5;                       // 1単位 = 100m、鉛直方向は 2.5 倍に強調
const KIND_COLOR = [0xdfe6ec, COLORS.cyan, COLORS.amber, 0xb794ff];
const KIND_CSS = ['#dfe6ec', '#58d6ff', '#ffb454', '#b794ff'];

export async function create({ canvas, hud }) {
  const meta = await fetchJson('/data/plan/meta.json');
  const height = await fetchBin('/data/plan/height.bin', Float32Array);
  const layers = await fetchBin('/data/plan/layers.bin');
  const { nx, ny, cell, LX, LY, gens, routes } = meta;
  const H = (x, y) => {                          // 地盤高（双一次補間）
    const fx = clamp(x / cell, 0, nx - 1.001), fy = clamp(y / cell, 0, ny - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j, q = i + nx * j;
    return (height[q] * (1 - a) + height[q + 1] * a) * (1 - b) + (height[q + nx] * (1 - a) + height[q + nx + 1] * a) * b;
  };
  const P = (x, y, z) => new THREE.Vector3(x * S, y * S, z * S * VE);          // world グループ内の座標
  const W = (x, y, z) => new THREE.Vector3(x * S, z * S * VE, -y * S);         // 画面（ワールド）座標

  const st = createStage(canvas, { fog: 0.0019, bloom: 0.5 });
  const { scene, camera, world, renderer } = st;
  renderer.localClippingEnabled = true;
  const center = W(LX / 2, LY / 2, 0);
  st.aim(center, 105);
  st.key.shadow.bias = -0.002;          // 広い平坦地で影のちらつきが出ないよう余裕を持たせる
  st.key.shadow.normalBias = 0.35;
  const ground = groundGrid({ size: 1400, cell: 10 });
  ground.position.y = -0.4;
  ground.userData.setCenter(center.x, center.z);
  scene.add(ground);

  // --- 地形 ---------------------------------------------------------------
  const tg = new THREE.BufferGeometry();
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), hh = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = i + nx * j;
    pos.set([i * cell * S, j * cell * S, height[q] * S * VE], q * 3);
    uv.set([i / (nx - 1), j / (ny - 1)], q * 2);
    hh[q] = height[q];
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  for (let j = 0, k = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const q = i + nx * j;
    idx.set([q, q + 1, q + nx, q + 1, q + nx + 1, q + nx], k); k += 6;
  }
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)).setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    .setAttribute('aH', new THREE.BufferAttribute(hh, 1)).setIndex(new THREE.BufferAttribute(idx, 1));
  tg.computeVertexNormals();
  const ltex = new THREE.DataTexture(layers, nx, ny, THREE.RGBAFormat);
  ltex.magFilter = ltex.minFilter = THREE.LinearFilter;
  ltex.needsUpdate = true;
  const U = { uLayers: { value: ltex }, uLayerMix: { value: 0 }, uZmax: { value: meta.zmax }, uDim: { value: 1 }, uSize: { value: new THREE.Vector2(LX, LY) } };
  const tmat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  tmat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH; varying float vH; varying vec2 vUv2;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = aH; vUv2 = uv;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uLayers; uniform float uLayerMix, uZmax, uDim; uniform vec2 uSize; varying float vH; varying vec2 vUv2;
        float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec4 L = texture2D(uLayers, vUv2);
        float hN = clamp(vH / uZmax, 0.0, 1.0);
        vec3 base = mix(vec3(0.075, 0.10, 0.13), vec3(0.50, 0.56, 0.62), pow(hN, 0.75));
        diffuseColor.rgb = mix(base, vec3(0.03, 0.12, 0.26), smoothstep(0.2, 0.7, L.b));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float f = vH / 20.0;
        float contour = 1.0 - smoothstep(0.0, 1.4, abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-6));
        float f5 = vH / 100.0;
        contour = contour * 0.5 + (1.0 - smoothstep(0.0, 1.6, abs(fract(f5 - 0.5) - 0.5) / max(fwidth(f5), 1e-6)));
        vec2 m = vUv2 * uSize;
        vec2 g = m / 70.0;                                           // 市街地：街区の灯り
        float lot = step(0.22, fract(g.x)) * step(0.22, fract(g.y));
        float lit = step(1.0 - L.r * 0.95, hash2(floor(g)));
        float hatch = step(0.55, fract((m.x + m.y) / 130.0));        // 保全区域：斜線
        totalEmissiveRadiance += uDim * (vec3(0.20, 0.62, 0.86) * contour * 0.11
          + uLayerMix * (vec3(1.0, 0.66, 0.26) * lot * lit * (0.25 + L.r)
          + vec3(0.30, 0.92, 0.55) * smoothstep(0.3, 0.6, L.g) * (0.10 + 0.22 * hatch))
          + vec3(0.10, 0.42, 0.95) * smoothstep(0.2, 0.7, L.b) * 0.45);`);
  };
  const terrain = new THREE.Mesh(tg, tmat);
  terrain.castShadow = terrain.receiveShadow = true;
  world.add(terrain);

  // --- 線形案の群れ（全世代を1つの線分バッファに入れ、世代で表示を切り替える） -------
  const NP = 56, perCurve = (NP - 1) * 2;
  const total = gens.reduce((a, g) => a + g.curves.length, 0) * perCurve;
  const cp = new Float32Array(total * 3), cg = new Float32Array(total), cr = new Float32Array(total);
  let k = 0;
  gens.forEach((g, gi) => g.curves.forEach((c, ci) => {
    const curve = new THREE.CatmullRomCurve3(c.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const pts = curve.getPoints(NP - 1).map((p) => P(p.x, p.y, H(p.x, p.y) + 14));
    const rk = g.feasible[ci] ? g.rank[ci] : 9;
    for (let i = 0; i < NP - 1; i++) for (const p of [pts[i], pts[i + 1]]) {
      cp.set([p.x, p.y, p.z], k * 3); cg[k] = gi; cr[k] = rk; k++;
    }
  }));
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(cp, 3)).setAttribute('aGen', new THREE.BufferAttribute(cg, 1))
    .setAttribute('aRank', new THREE.BufferAttribute(cr, 1));
  const SU = { uGen: { value: -1 }, uFade: { value: 1 } };
  const swarm = new THREE.LineSegments(sg, new THREE.ShaderMaterial({
    uniforms: SU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aGen, aRank; uniform float uGen; varying float vA; varying float vR;
      void main(){ float age = uGen - aGen; vA = step(0.0, age) * exp(-age / 2.2); vR = aRank;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uFade; varying float vA; varying float vR;
      void main(){ vec3 c = vR < 0.5 ? vec3(0.35, 0.86, 1.0) : mix(vec3(0.55, 0.62, 0.95), vec3(1.0, 0.45, 0.35), step(8.5, vR));
        float a = vA * uFade * (vR < 0.5 ? 1.0 : 0.34);
        if (a < 0.004) discard; gl_FragColor = vec4(c * a, a); }`,
  }));
  swarm.frustumCulled = false;
  world.add(swarm);

  // --- 選ばれた線形（構造種別ごとに色分け）と比較用の直線案 ------------------------
  const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  const routeGroup = new THREE.Group();
  world.add(routeGroup);
  const R = routes.balance;
  const track = R.x.map((x, i) => P(x, R.y[i], R.z[i]));
  const trackCurve = new THREE.CatmullRomCurve3(track);
  for (let i = 0; i < R.kind.length;) {
    let j = i;
    while (j < R.kind.length && R.kind[j] === R.kind[i]) j++;
    const pts = track.slice(Math.max(0, i - 1), Math.min(track.length, j + 1));
    if (pts.length >= 2) {
      const tunnel = R.kind[i] === 3;
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, tunnel ? 0.16 : 0.24, 8),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(KIND_COLOR[R.kind[i]]).multiplyScalar(tunnel ? 1.0 : 1.25), clippingPlanes: [clip],
          transparent: tunnel, opacity: tunnel ? 0.75 : 1, depthTest: !tunnel }));
      m.renderOrder = tunnel ? 5 : 1;
      routeGroup.add(m);
    }
    i = j;
  }
  const pier = [];
  R.kind.forEach((kd, i) => { if (kd === 1 || kd === 2) pier.push(track[i], P(R.x[i], R.y[i], R.ground[i])); });
  routeGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pier),
    new THREE.LineBasicMaterial({ color: 0xbfe9ff, clippingPlanes: [clip] })));
  const Sr = routes.straight;
  const straight = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Sr.x.map((x, i) => P(x, Sr.y[i], Math.max(Sr.z[i], Sr.ground[i]) + 20))),
    new THREE.LineDashedMaterial({ color: COLORS.amber, dashSize: 1.2, gapSize: 0.9, transparent: true, depthTest: false }));
  straight.computeLineDistances();
  world.add(straight);
  // 起終点の標識
  const beam = (xy) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 14, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(2.2) }));
    m.rotation.x = Math.PI / 2;
    m.position.copy(P(xy[0], xy[1], H(xy[0], xy[1]))).add(new THREE.Vector3(0, 0, 7));
    world.add(m);
    return m;
  };
  const beams = [beam(meta.A), beam(meta.B)];
  // 走行視点で先頭を示す光点
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(5) }));
  world.add(head);

  // --- 文字 ---------------------------------------------------------------
  const chap = chapter(hud, '01', '計画', 'GENERATIVE ROUTE SEARCH');
  const ask = prompt(hud, 'A駅〜B駅の新線。保全区域を避け、コストと環境・用地への影響を両立する線形を。', 0.8, T.swarm + 3.5);
  const dC = (R.cost / Sr.cost - 1) * 100, dI = (R.impact / Sr.impact - 1) * 100;
  const sub = subtitles(hud, [
    [1.0, 5.2, '地形、市街地、保全区域。<em>条件</em>を読み込む。'],
    [6.0, 11.5, `線形案を<em>生成</em>し、評価し、また生成する。`],
    [11.9, 17.2, `<strong>${fmt(meta.n_eval)} 案</strong>。人が一生かけても描ききれない数を、数分で。`],
    [18.0, 24.2, `直線案に比べ、コスト <strong>${dC.toFixed(0)}%</strong>、環境・用地への影響 <strong>${dI.toFixed(0)}%</strong>。`],
    [25.0, 30.4, '技術者は、<em>選ぶ理由</em>を語ることに集中する。'],
  ]);
  const p = panel(hud, 'ROUTE CANDIDATES', [['n', '評価した線形案'], ['gen', '世代'], ['front', 'パレート解']]);
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 520;
  p.node.appendChild(cv);
  el(p.node, 'cap', '横軸：建設コスト指数　縦軸：環境・用地への影響指数');
  const g2 = cv.getContext('2d');
  const allF = gens.flatMap((g) => g.F.filter((_, i) => g.feasible[i]));
  const c0 = Math.min(...allF.map((f) => f[0])) - 2, c1 = Math.min(Math.max(...allF.map((f) => f[0])), c0 + 22);
  const i1 = Math.min(Math.max(...allF.map((f) => f[1])), 26);
  const SX = (c) => 20 + clamp((c - c0) / (c1 - c0)) * 760, SY = (v) => 500 - clamp(v / i1) * 480;
  const scatter = (gf, showPick) => {
    g2.clearRect(0, 0, 800, 520);
    g2.strokeStyle = 'rgba(130,190,230,.25)'; g2.lineWidth = 2; g2.strokeRect(20, 20, 760, 480);
    const gi = Math.min(Math.floor(gf), gens.length - 1);
    for (let a = Math.max(0, gi - 40); a <= gi; a++) {
      const g = gens[a], old = (gi - a) / 40;
      for (let i = 0; i < g.F.length; i += 2) {
        if (!g.feasible[i]) continue;
        g2.fillStyle = g.rank[i] === 0 && a === gi ? '#58d6ff' : `rgba(150,170,230,${0.42 * (1 - old)})`;
        const r = g.rank[i] === 0 && a === gi ? 7 : 4;
        g2.fillRect(SX(g.F[i][0]) - r / 2, SY(g.F[i][1]) - r / 2, r, r);
      }
    }
    if (showPick > 0) {
      g2.globalAlpha = showPick;
      const mark = (r, color, label, dx) => {
        g2.strokeStyle = g2.fillStyle = color; g2.lineWidth = 4;
        g2.beginPath(); g2.arc(SX(r.cost), SY(r.impact), 15, 0, 7); g2.stroke();
        g2.font = '700 26px "Noto Sans JP"'; g2.fillText(label, SX(r.cost) + dx, SY(r.impact) + 9);
      };
      mark(Sr, '#ffb454', '直線案', -112);
      mark(R, '#7de3a5', '採用案', 26);
      g2.globalAlpha = 1;
    }
  };
  // 縦断図
  const chart = el(hud, 'chart', '<h3>LONGITUDINAL PROFILE ／ 縦断図（採用案）</h3>');
  const pc = document.createElement('canvas');
  pc.width = 1520; pc.height = 360; pc.style.width = '760px'; pc.style.height = '180px';
  chart.appendChild(pc);
  el(chart, 'legend', meta.types.map((n, i) => `<span style="--c:${KIND_CSS[i]}">${n} ${R.km_by_type[n].toFixed(1)} km</span>`).join(''));
  const g3 = pc.getContext('2d');
  const drawProfile = (prog, mark = -1) => {
    const n = R.z.length, zm = Math.max(...R.ground) * 1.08;
    const X = (i) => 10 + (i / (n - 1)) * 1500, Y = (z) => 350 - (z / zm) * 330;
    g3.clearRect(0, 0, 1520, 360);
    g3.beginPath(); g3.moveTo(X(0), 360);
    R.ground.forEach((z, i) => g3.lineTo(X(i), Y(z)));
    g3.lineTo(X(n - 1), 360); g3.closePath();
    g3.fillStyle = 'rgba(120,150,180,.22)'; g3.fill();
    g3.strokeStyle = 'rgba(160,190,215,.7)'; g3.lineWidth = 2; g3.stroke();
    g3.lineWidth = 7; g3.lineCap = 'round';
    const m = Math.floor(prog * (n - 1));
    for (let i = 0; i < m; i++) {
      g3.strokeStyle = KIND_CSS[R.kind[i]];
      g3.beginPath(); g3.moveTo(X(i), Y(R.z[i])); g3.lineTo(X(i + 1), Y(R.z[i + 1])); g3.stroke();
    }
    if (mark >= 0) {                                   // 走行視点の現在位置
      g3.strokeStyle = '#ffffff'; g3.lineWidth = 3;
      g3.beginPath(); g3.moveTo(10 + mark * 1500, 14); g3.lineTo(10 + mark * 1500, 352); g3.stroke();
    }
  };
  const tags = [
    [tag(hud, '<i>A駅</i>', 'big'), W(meta.A[0], meta.A[1], H(...meta.A) + 620)],
    [tag(hud, '<i>B駅</i>', 'big'), W(meta.B[0], meta.B[1], H(...meta.B) + 620)],
    [tag(hud, '<i>保全区域</i>', 'g'), W(6500, 3700, 260)],
    [tag(hud, '<i>河川</i>', 'c'), W(4700, 900, 160)],
    [tag(hud, `<i>山地</i> 標高 ${meta.zmax.toFixed(0)} m`, 'c'), W(10300, 2300, meta.zmax + 240)],
    [tag(hud, '<i>市街地</i>'), W(3200, 2300, 260)],
  ];
  el(hud, 'note', '※ 地形・単価・影響指数はすべてデモ用の架空条件です');

  return {
    duration: T.end,
    render(t) {
      const fly = ease(seg(t, T.fly - 0.2, T.fly + 1.8));
      const u = lerp(0.02, 0.9, easeInOut(seg(t, T.fly, T.end + 1)));       // 走行視点の位置（線形上のパラメータ）
      // 俯瞰：南西の空からゆっくり回り込む
      const az = lerp(-0.42, 0.06, easeInOut(seg(t, 0, T.fly))), dist = lerp(240, 204, ease(seg(t, 0, 8)));
      const elev = lerp(0.62, 0.5, ease(seg(t, 4, 16)));
      const over = new THREE.Vector3(center.x + dist * Math.sin(az) * Math.cos(elev), dist * Math.sin(elev), center.z + dist * Math.cos(az) * Math.cos(elev));
      const overAt = new THREE.Vector3(center.x + 6, 0, center.z + 4);
      // 走行視点：線形の少し後ろ上空から前方を見る
      const toWorld = (v) => new THREE.Vector3(v.x, v.z, -v.y);
      const ahead = toWorld(trackCurve.getPoint(Math.min(1, u + 0.16)));
      const back = toWorld(trackCurve.getPoint(Math.max(0, u - 0.05)));
      const chase = back.clone().add(new THREE.Vector3(0, 3.4 + 2.2 * Math.sin(u * Math.PI), 2.6));  // 山越えでは少し高く
      camera.position.lerpVectors(over, chase, fly);
      camera.lookAt(new THREE.Vector3().lerpVectors(overAt, ahead, fly));
      camera.fov = lerp(30, 46, fly);
      camera.updateProjectionMatrix();
      st.frameLeft(lerp(215, 0, fly), lerp(-30, -90, fly));
      camera.updateMatrixWorld();

      terrain.scale.z = lerp(0.02, 1, ease(seg(t, 0.2, 3.6)));
      U.uLayerMix.value = ease(seg(t, 2.2, 4.2));
      U.uDim.value = lerp(1, 0.75, fly);
      const gf = lerp(0, gens.length - 1, ease(seg(t, T.swarm, T.result - 1)) ** 1.25);
      SU.uGen.value = t < T.swarm ? -1 : gf;
      SU.uFade.value = 1 - ease(seg(t, T.result - 0.6, T.result + 1.2));
      const reveal = ease(seg(t, T.result + 0.3, T.result + 3.6));
      clip.constant = lerp(meta.A[0] - 100, meta.B[0] + 200, reveal) * S;
      routeGroup.visible = t > T.result;
      straight.material.opacity = ease(seg(t, T.result, T.result + 1)) * (1 - fly) * 0.9;
      beams.forEach((b) => { b.scale.z = ease(seg(t, 2.8, 4.2)); b.visible = t > 2.8; });
      head.visible = fly > 0.05;
      head.position.copy(trackCurve.getPoint(Math.min(1, u + 0.012)));

      sub(t); ask(t);
      chap.style.opacity = 1 - fly;
      const gi = Math.min(Math.floor(gf), gens.length - 1);
      p.set('n', t < T.swarm ? '0' : fmt(Math.round(lerp(gens[gi].n_eval, gens[Math.min(gi + 1, gens.length - 1)].n_eval, gf - gi))));
      p.set('gen', `${String(t < T.swarm ? 0 : gi + 1).padStart(3, '0')}<small>/ ${gens.length}</small>`);
      p.set('front', t < T.swarm ? '–' : String(gens[gi].rank.filter((r, i) => r === 0 && gens[gi].feasible[i]).length));
      scatter(t < T.swarm ? -1 : gf, ease(seg(t, T.result, T.result + 1)));
      p.node.style.opacity = ease(seg(t, T.swarm - 1.2, T.swarm)) * (1 - fly);
      chart.style.opacity = ease(seg(t, T.result + 0.6, T.result + 1.6));
      drawProfile(t < T.fly ? reveal : 1, fly > 0.5 ? u : -1);
      const tv = ease(seg(t, 2.6, 4.0)) * (1 - ease(seg(t, T.swarm + 4, T.swarm + 6)));
      tags.forEach(([fn, v], i) => fn(camera, v, i < 2 ? ease(seg(t, 2.8, 4.0)) * (1 - fly) : tv));
      st.render();
    },
  };
}
