// 03 施工 — デジタルリハーサル（営業線をまたぐ桁の夜間架設）
// 探索で選ばれた手順（data/build/plan.json）を、線路閉鎖間合いの早回しで再生する。
import * as THREE from 'three';
import { createStage, groundGrid, boxMesh, boxEdges, COLORS } from '../lib/stage.js';
import { makeTrain, makeTrack } from '../lib/models.js';
import { chapter, subtitles, panel, prompt } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fetchJson, el, fmt } from '../lib/util.js';

const T = { site: 0, search: 5.5, play: 11.5, done: 26, end: 31 };
const BOOM = 38, PIVOT_Z = 2.6, CARRY_Z = 16;        // ブーム長、ブーム根元の高さ、運搬時の吊荷下面高さ [m]
const START = 40;                                    // 線路閉鎖の開始 00:40

export async function create({ canvas, hud }) {
  const M = await fetchJson('/data/build/plan.json');
  const B = M.best, N = M.naive, WIN = M.window;
  const V = (x, y, z) => new THREE.Vector3(x, z, -y);

  const st = createStage(canvas, { fog: 0.0045, bloom: 0.5 });
  const { scene, camera, world } = st;
  const night = new THREE.Color(0x04070c), dawn = new THREE.Color(0x1a2a44);
  const center = V(-9, -9, 6);
  st.aim(center, 62);
  st.key.color.set(0xbfd0ff);                        // 夜間：月明かり＋投光器
  st.key.intensity = 1.1;
  const ground = groundGrid({ cell: 5 });
  ground.userData.setCenter(center.x, center.z);
  scene.add(ground);

  // --- 営業線（y 方向）と新設橋りょうの橋脚・前後の桁 ---------------------------
  const rail = makeTrack({ x0: -160, x1: 160, off: 2.0 });
  rail.rotation.z = Math.PI / 2;                     // x 向きの軌道を y 向きに
  rail.position.z = 0.55;
  world.add(rail);
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb4bcc4, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8fa3b5, roughness: 0.45, metalness: 0.55 });
  const steelNew = new THREE.MeshStandardMaterial({ color: 0xd4dde6, roughness: 0.4, metalness: 0.5, emissive: COLORS.cyan, emissiveIntensity: 0 });
  const solid = (min, max, mat) => { const m = boxMesh(min, max, mat); m.castShadow = m.receiveShadow = true; return m; };
  const px = M.pier_x, zs = M.seat_z, gd = M.girder_d;
  for (const s of [-1, 1]) {
    world.add(solid([s * px - 1.4, -4.2, 0], [s * px + 1.4, 4.2, zs - 0.9], concrete));
    world.add(solid([s * px - 1.9, -4.8, zs - 0.9], [s * px + 1.9, 4.8, zs], concrete));
    for (const k of [1, 2, 3]) {                     // 既に架かっている前後の径間
      const xa = s * (px + (k - 1) * 30), xb = s * (px + k * 30);
      world.add(solid([Math.min(xa, xb) + 0.15, -3.4, zs], [Math.max(xa, xb) - 0.15, 3.4, zs + gd], steel));
      world.add(solid([xb - 1.4, -4.2, 0], [xb + 1.4, 4.2, zs], concrete));
    }
  }
  // ヤードの作業床と投光器
  const yard = solid([-52, -44, 0], [-8.5, -6, 0.12], new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.95 }));
  yard.castShadow = false;
  world.add(yard);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2d6).multiplyScalar(4) });
  for (const [x, y] of [[-48, -40], [-12, -40], [-48, -8], [14, -30]]) {
    world.add(solid([x - 0.12, y - 0.12, 0], [x + 0.12, y + 0.12, 14], new THREE.MeshStandardMaterial({ color: 0x40484f })));
    const l = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.5), lampMat);
    l.position.set(x, y, 14.2);
    world.add(l);
    const sp = new THREE.PointLight(0xffe6bf, 420, 90, 1.6);
    sp.position.set(x, y, 13.5);
    world.add(sp);
  }

  // --- 架設する部材 ---------------------------------------------------------
  const parts = {};
  const gBox = (len, wy, d) => new THREE.BoxGeometry(len, wy, d);
  for (const g of M.girders) {
    const m = new THREE.Mesh(gBox(M.span, 1.3, gd), steelNew.clone());
    m.castShadow = m.receiveShadow = true;
    world.add(m);
    parts[g.id] = { mesh: m, final: new THREE.Vector3(0, g.y, zs + gd / 2), half: gd / 2 };
  }
  M.cross_x.forEach((x, k) => {
    const m = new THREE.Mesh(gBox(0.45, 4.8 - 1.3, 1.3), steelNew.clone());
    m.castShadow = true;
    world.add(m);
    parts[`C${k + 1}`] = { mesh: m, final: new THREE.Vector3(x, 0, zs + gd / 2), half: 0.65 };
  });
  const pre = new Set(B.order.slice(0, B.lifts.find((l) => l.id === 'G2').pre).map((k) => `C${k + 1}`)); // G2 に地組する横桁
  // 各部材のヤードでの置き場所（重心）
  const yg = M.yard.girder, yc = M.yard.cross;
  parts.G1.rest = new THREE.Vector3(yg[0], yg[1], 0.6 + gd / 2);
  parts.G2.rest = new THREE.Vector3(yg[0], yg[1] - 9, 0.6 + gd / 2);          // G1 が出たあと吊り位置へ横移動する
  let stack = 0;
  for (const id of Object.keys(parts)) if (id[0] === 'C' && !pre.has(id)) parts[id].rest = new THREE.Vector3(yc[0] + 1.6 * stack++, yc[1], 0.5 + 0.65);

  // --- クレーン -------------------------------------------------------------
  const crane = new THREE.Group();
  crane.position.set(B.site[0], B.site[1], 0);
  world.add(crane);
  const body = new THREE.MeshStandardMaterial({ color: 0xf2b23a, roughness: 0.55, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.8 });
  for (const s of [-1, 1]) crane.add(solid([-4.6, s * 3.4 - 0.75, 0], [4.6, s * 3.4 + 0.75, 1.5], dark));
  const upper = new THREE.Group();
  crane.add(upper);
  upper.add(solid([-6.5, -2.3, 1.6], [3.2, 2.3, 4.4], body), solid([-8.6, -2.6, 1.6], [-6.5, 2.6, 5.2], dark));
  const boom = new THREE.Group();
  boom.position.set(1.2, 0, PIVOT_Z);
  upper.add(boom);
  {                                                  // ラチスブーム（4本の主材＋斜材）
    const pts = [], w0 = 1.1, w1 = 0.45, n = 14;
    const corner = (i, a, b) => { const w = lerp(w0, w1, i / n); return new THREE.Vector3((i / n) * BOOM, a * w, b * w); };
    for (let i = 0; i < n; i++) for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      pts.push(corner(i, a, b), corner(i + 1, a, b), corner(i, a, b), corner(i + 1, -a, b), corner(i, a, b), corner(i + 1, a, -b));
    }
    boom.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffc85a })));
    const core = new THREE.Mesh(new THREE.BoxGeometry(BOOM, 0.5, 0.5), body);
    core.position.x = BOOM / 2;
    core.castShadow = true;
    boom.add(core);
  }
  const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xdfe8f0 }));
  cable.frustumCulled = false;
  world.add(cable);
  const hook = solid([-0.5, -0.5, -0.6], [0.5, 0.5, 0.6], body);
  world.add(hook);
  const sling = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].map(() => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xdfe8f0 }));
  sling.frustumCulled = false;
  world.add(sling);
  // 候補の据付位置（探索の場面で点滅）
  const sites = M.sites.map(([x, y]) => { const m = boxEdges([x - 4.6, y - 4.2, 0.1], [x + 4.6, y + 4.2, 5], COLORS.cyan, 0); world.add(m); return m; });
  // 計画された吊荷の軌跡
  const pathPts = [];
  B.lifts.forEach((L) => {
    for (let i = 0; i <= 40; i++) {
      const k = i / 40, a = THREE.MathUtils.degToRad(lerp(L.a0, L.a1, k)), r = lerp(L.r0, L.r1, k);
      pathPts.push(new THREE.Vector3(B.site[0] + r * Math.cos(a), B.site[1] + r * Math.sin(a), CARRY_Z + 2));
      if (i > 0 && i < 40) pathPts.push(pathPts.at(-1).clone());
    }
  });
  const paths = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pathPts),
    new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0 }));
  world.add(paths);
  // 始発列車
  const train = makeTrain({ cars: 8 });
  train.rotation.z = Math.PI / 2;
  train.position.set(-2.0, -400, 0.55);
  world.add(train);

  // --- 時刻 → クレーンと部材の姿勢 ------------------------------------------
  const lifts = B.lifts;
  const state = (tm) => {
    // 既定：全部材は置き場、フックは最初の吊り位置の上
    const pos = Object.fromEntries(Object.entries(parts).map(([id, p]) => [id, (p.rest || p.final).clone()]));
    if (tm > lifts[0].phases[2].t0) pos.G2.y = lerp(parts.G2.rest.y, yg[1], ease(seg(tm, lifts[0].phases[2].t0, lifts[0].phases[3].t1)));
    let ang = lifts[0].a0, rad = lifts[0].r0, hz = 12, held = null;
    for (let i = 0; i < lifts.length; i++) {
      const L = lifts[i], ph = L.phases, p = parts[L.id], prev = lifts[i - 1];
      const rest = pos[L.id].clone(), bottom = (c) => c - p.half;
      if (tm < ph[0].t0) break;
      const top = p.half + 2.2;                      // 部材重心からフックまでの高さ
      if (tm < ph[0].t1) {                           // 玉掛け：前の位置から吊り位置へ戻り、フックを下ろす
        const k = easeInOut(seg(tm, ph[0].t0, ph[0].t1 - 2));
        ang = lerp(prev ? prev.a1 : L.a0, L.a0, k); rad = lerp(prev ? prev.r1 : L.r0, L.r0, k);
        hz = lerp(prev ? CARRY_Z + 6 : 12, rest.z + top, ease(seg(tm, ph[0].t1 - 3, ph[0].t1)));
      } else {
        let c = rest.clone();
        const carry = CARRY_Z + p.half;
        if (tm < ph[1].t1) { ang = L.a0; rad = L.r0; c.z = lerp(rest.z, carry, easeInOut(seg(tm, ph[1].t0, ph[1].t1))); }
        else if (tm < ph[2].t1) {
          const k = easeInOut(seg(tm, ph[2].t0, ph[2].t1));
          ang = lerp(L.a0, L.a1, k); rad = lerp(L.r0, L.r1, k);
          const a = THREE.MathUtils.degToRad(ang);
          c.set(B.site[0] + rad * Math.cos(a), B.site[1] + rad * Math.sin(a), carry);
        } else {
          ang = L.a1; rad = L.r1;
          const k = seg(tm, ph[3].t0, ph[3].t1);
          c.copy(p.final); c.z = lerp(carry, p.final.z, easeInOut(k)) + 0.25 * Math.sin(k * 30) * (1 - k);
          if (tm >= ph[3].t1) c.copy(p.final);
        }
        pos[L.id].copy(c);
        hz = c.z + top;
        if (tm < ph[5].t0) held = L.id;
        else hz = lerp(p.final.z + top, CARRY_Z + 6, ease(seg(tm, ph[5].t0, ph[5].t1)));
      }
    }
    for (const id of pre) pos[id].copy(parts[id].final).sub(parts.G2.final).add(pos.G2);   // 地組した横桁は G2 と一体
    return { pos, ang, rad, hz, held };
  };

  // --- 文字 ---------------------------------------------------------------
  const chap = chapter(hud, '03', '施工', 'DIGITAL REHEARSAL');
  const ask = prompt(hud, `終電から始発まで ${WIN} 分。営業線の上に、主桁2本と横桁5本を架けたい。`, 0.8, T.search + 2.5);
  const sub = subtitles(hud, [
    [1.0, 5.2, '止められるのは、<em>終電から始発まで</em>。'],
    [6.0, 11.0, `<strong>${fmt(M.n_plans)} 通り</strong>の手順を、仮想の現場で先に試す。`],
    [12.0, 18.5, '据付位置、吊り順、班編成。<em>間に合う手順</em>だけが残る。'],
    [19.0, 25.5, `始発に間に合う確率 <strong>${(B.p_ok * 100).toFixed(1)}%</strong>。素朴な手順では ${(N.p_ok * 100).toFixed(0)}%。`],
    [26.6, 30.5, '現場は、<em>想定外</em>への備えに集中する。'],
  ]);
  const clock = el(hud, 'clock', '<div class="lab">線路閉鎖間合い 00:40 – 04:35</div><div class="time"></div><div class="bar"><i></i></div>');
  const p = panel(hud, 'REHEARSAL', [['n', '検討した手順'], ['runs', '乱数試行'], ['crane', 'クレーン負荷率（最大）'], ['fin', '完了見込み（中央値）']]);
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 300;
  p.node.appendChild(cv);
  el(p.node, 'cap', '工程（クレーン／ボルト班／手続き）');
  const g2 = cv.getContext('2d');
  const rows = ['クレーン', 'ボルト班1', 'ボルト班2', '手続き'];
  const gantt = (tm) => {
    g2.clearRect(0, 0, 800, 300);
    const X = (m) => 150 + (m / 250) * 640;
    g2.font = '24px "Noto Sans JP"';
    rows.forEach((r, i) => { g2.fillStyle = 'rgba(132,151,169,1)'; g2.fillText(r, 0, 44 + i * 66); g2.fillStyle = 'rgba(130,190,230,.10)'; g2.fillRect(150, 18 + i * 66, 640, 40); });
    for (const e of B.events) {
      const i = rows.indexOf(e.who);
      if (i < 0 || e.t0 > tm) continue;
      g2.fillStyle = e.who === 'クレーン' ? '#58d6ff' : e.who === '手続き' ? '#8497a9' : '#7de3a5';
      g2.fillRect(X(e.t0), 20 + i * 66, Math.max(2, X(Math.min(e.t1, tm)) - X(e.t0) - 2), 36);
    }
    g2.strokeStyle = '#ffb454'; g2.lineWidth = 3; g2.setLineDash([8, 6]);
    g2.beginPath(); g2.moveTo(X(WIN), 6); g2.lineTo(X(WIN), 290); g2.stroke(); g2.setLineDash([]);
    g2.fillStyle = '#ffb454'; g2.font = '22px "JetBrains Mono"'; g2.fillText('04:35', X(WIN) - 76, 292);
  };
  const chart = el(hud, 'chart', '<h3>MONTE CARLO ／ 完了時刻のばらつき</h3>');
  const hc = document.createElement('canvas');
  hc.width = 1520; hc.height = 320; hc.style.width = '760px'; hc.style.height = '160px';
  chart.appendChild(hc);
  el(chart, 'legend', `<span style="--c:#ffb454">素朴な手順（据付位置おまかせ・1班・地組なし）</span><span style="--c:#58d6ff">探索で選んだ手順</span>`);
  const g3 = hc.getContext('2d');
  const hist = (a) => { const h = new Array(64).fill(0); a.forEach((v) => { h[clamp(Math.floor((v - 150) / 3), 0, 63)]++; }); return h; };
  const hN = hist(N.samples), hB = hist(B.samples), hmax = Math.max(...hN, ...hB);
  const drawHist = (k) => {
    g3.clearRect(0, 0, 1520, 320);
    const X = (m) => 10 + ((m - 150) / 192) * 1500;
    [[hN, 'rgba(255,180,84,.85)'], [hB, 'rgba(88,214,255,.9)']].forEach(([h, c]) => {
      g3.fillStyle = c;
      h.forEach((v, i) => { const hh = (v / hmax) * 270 * k; g3.fillRect(X(150 + i * 3), 290 - hh, 1500 / 64 - 3, hh); });
    });
    g3.strokeStyle = '#ffffff'; g3.lineWidth = 3; g3.beginPath(); g3.moveTo(X(WIN), 0); g3.lineTo(X(WIN), 296); g3.stroke();
    g3.fillStyle = '#eaf3fa'; g3.font = '700 26px "Noto Sans JP"'; g3.fillText('始発前の期限 04:35', X(WIN) + 12, 30);
    g3.fillStyle = '#8497a9'; g3.font = '22px "JetBrains Mono"';
    for (const m of [160, 200, 240, 280, 320]) g3.fillText(`${m}分`, X(m) - 24, 316);
  };
  el(hud, 'note', '※ 作業時間・クレーン性能はデモ用の架空条件です');
  const hhmm = (m) => { const t = START + m; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const maxUtil = Math.max(...B.lifts.map((l) => l.util));

  return {
    duration: T.end,
    render(t) {
      const play = seg(t, T.play, T.done - 0.6);
      const tm = play * (B.median_min + 2);            // 再生中の現場時刻 [分]
      const dawnK = ease(seg(t, T.done - 2, T.end));
      scene.background.lerpColors(night, dawn, dawnK);
      scene.fog.color.copy(scene.background);

      const az = lerp(0.95, 0.38, easeInOut(seg(t, 0, T.end))), dist = lerp(150, 118, ease(seg(t, 0, T.play + 4)));
      const fin = ease(seg(t, T.done - 1.5, T.end));                       // 最後は低い視点へ降りていく
      const elv = lerp(lerp(0.56, 0.44, ease(seg(t, T.search, T.done))), 0.2, fin);
      const dd = dist * lerp(1, 0.72, fin);
      camera.position.set(center.x + dd * Math.sin(az) * Math.cos(elv), center.y + dd * Math.sin(elv), center.z + dd * Math.cos(az) * Math.cos(elv));
      camera.lookAt(center.x, center.y + 2, center.z);
      st.frameLeft(60, 70);
      camera.updateMatrixWorld();

      // クレーンと部材
      const s = state(tm);
      const a = THREE.MathUtils.degToRad(s.ang);
      upper.rotation.z = a;
      const reach = Math.max(4, s.rad - 1.2);
      boom.rotation.y = -Math.acos(clamp(reach / BOOM, 0, 1));
      const tip = new THREE.Vector3(B.site[0] + s.rad * Math.cos(a), B.site[1] + s.rad * Math.sin(a), PIVOT_Z + Math.sqrt(BOOM ** 2 - reach ** 2));
      const hk = new THREE.Vector3(tip.x, tip.y, Math.min(s.hz, tip.z - 2));
      cable.geometry.setFromPoints([tip, hk]);
      hook.position.copy(hk);
      for (const [id, pt] of Object.entries(parts)) {
        pt.mesh.position.copy(s.pos[id]);
        pt.mesh.material.emissiveIntensity = id === s.held ? 0.5 : 0;
      }
      if (s.held) {
        const c = s.pos[s.held], long = s.held[0] === 'G' ? [12, 0] : [0, 1.2], top = c.z + parts[s.held].half;
        sling.geometry.setFromPoints([hk, new THREE.Vector3(c.x - long[0], c.y - long[1], top), hk, new THREE.Vector3(c.x + long[0], c.y + long[1], top)]);
      }
      sling.visible = !!s.held;
      const searching = seg(t, T.search, T.play);
      sites.forEach((m, i) => {
        const on = searching > 0 && searching < 1 && Math.floor(searching * 40 + i * 1.7) % M.sites.length === i;
        const chosen = M.sites[i][0] === B.site[0] && M.sites[i][1] === B.site[1];
        m.material.opacity = on ? 0.9 : chosen ? ease(seg(t, T.play - 1.5, T.play - 0.6)) * (1 - ease(seg(t, T.play, T.play + 1))) : 0.12 * (searching > 0 && searching < 1 ? 1 : 0);
        m.material.color.set(chosen && searching > 0.75 ? COLORS.amber : COLORS.cyan);
      });
      crane.visible = t > T.play - 1.6;
      cable.visible = hook.visible = crane.visible;
      paths.material.opacity = 0.55 * ease(seg(t, T.play - 1.2, T.play)) * (1 - ease(seg(t, T.done - 2, T.done)));
      train.position.y = lerp(-150, 190, seg(t, T.done + 0.8, T.end + 1.5));

      // 文字
      sub(t); ask(t);
      chap.style.opacity = 1;
      const shown = t < T.play ? 0 : tm;
      clock.querySelector('.time').textContent = hhmm(Math.min(shown, B.median_min));
      clock.querySelector('.bar i').style.width = `${clamp(shown / WIN) * 100}%`;
      clock.style.opacity = ease(seg(t, 1.5, 2.5));
      const k = ease(seg(t, T.search, T.play - 1));
      p.set('n', fmt(Math.round(M.n_plans * k)));
      p.set('runs', fmt(Math.round(M.n_runs * k)));
      p.set('crane', t > T.play - 1 ? `${(maxUtil * 100).toFixed(0)}<small>% ≤ ${M.util_max * 100}%</small>` : '–', 'ok');
      p.set('fin', t > T.play - 1 ? `${hhmm(B.median_min)}<small>余裕 ${(WIN - B.median_min).toFixed(0)} 分</small>` : '–', 'ok');
      gantt(shown);
      p.node.style.opacity = ease(seg(t, T.search - 1, T.search));
      chart.style.opacity = ease(seg(t, T.search + 1, T.search + 2)) * (1 - ease(seg(t, T.done, T.done + 1)));
      drawHist(ease(seg(t, T.search + 1.5, T.play - 0.5)));
      st.render();
    },
  };
}
