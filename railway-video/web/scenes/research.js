// 05 技術開発 — 自律実験ループ（列車走行による桁の共振と制振装置の探索）
// data/research/meta.json の実験履歴（ベイズ最適化）と時刻歴応答を再生する。
import * as THREE from 'three';
import { createStage, groundGrid, boxMesh, COLORS } from '../lib/stage.js';
import { makeTrain } from '../lib/models.js';
import { chapter, subtitles, panel, prompt, tag } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fetchJson, el } from '../lib/util.js';

const T = { runA: 0.8, exp1: 6.5, exp2: 12.5, runB: 15.6, result: 22.2, end: 30 };
const SCALE = 600, DECK_Z = 10, DEPTH = 2.6;         // 変形の表示倍率、桁上面の高さ、桁高 [m]

export async function create({ canvas, hud }) {
  const M = await fetchJson('/data/research/meta.json');
  const { span: L, exp1: E1, exp2: E2, curves: C, history: Hs, speeds, bounds: BD, grid: G } = M;
  const V = (x, y, z) => new THREE.Vector3(x, z, -y);
  const v = M.v_show / 3.6;

  const st = createStage(canvas, { fog: 0.0042, bloom: 0.5 });
  const { scene, camera, world } = st;
  const center = V(L / 2, 0, 7);
  st.aim(center, 70);
  const ground = groundGrid({ cell: 5 });
  ground.userData.setCenter(center.x, center.z);
  scene.add(ground);

  // --- 橋りょう：変形する中央径間と、前後の径間 ---------------------------------
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb4bcc4, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9fb0be, roughness: 0.35, metalness: 0.9 });
  const solid = (min, max, mat) => { const m = boxMesh(min, max, mat); m.castShadow = m.receiveShadow = true; world.add(m); return m; };
  for (let k = -5; k <= 6; k++) {
    solid([k * L - 1.3, -3.2, 0], [k * L + 1.3, 3.2, DECK_Z - DEPTH - 0.2], concrete);
    if (k !== 0 && k <= 5) solid([k * L + 0.15, -4.6, DECK_Z - DEPTH], [(k + 1) * L - 0.15, 4.6, DECK_Z], concrete);
  }
  const gmat = new THREE.MeshStandardMaterial({ color: 0xcfd6dc, roughness: 0.85, emissive: 0xff5a3c, emissiveIntensity: 0 });
  const girder = new THREE.Mesh(new THREE.BoxGeometry(L - 0.3, 9.2, DEPTH, 48, 1, 1), gmat);
  girder.position.set(L / 2, 0, DECK_Z - DEPTH / 2);
  girder.castShadow = girder.receiveShadow = true;
  world.add(girder);
  const rails = [];
  for (const y of [-0.7175, 0.7175]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(L, 0.07, 0.16, 48, 1, 1), steel);
    r.position.set(L / 2, y, DECK_Z + 0.08);
    world.add(r);
    rails.push(r);
    world.add(boxMesh([-5 * L, y - 0.035, DECK_Z], [0, y + 0.035, DECK_Z + 0.16], steel), boxMesh([L, y - 0.035, DECK_Z], [7 * L, y + 0.035, DECK_Z + 0.16], steel));
  }
  const deformable = [girder, ...rails].map((m) => ({ m, base: m.geometry.attributes.position.array.slice() }));
  const deform = (q) => {                               // q: 桁中央の変位 [mm]
    for (const { m, base } of deformable) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = base[i * 3] + m.position.x;
        p.setZ(i, base[i * 3 + 2] + (q / 1000) * SCALE * Math.sin(Math.PI * clamp(x / L)));
      }
      p.needsUpdate = true;
    }
    girder.geometry.computeVertexNormals();
  };
  // 制振装置（TMD）：桁中央の下に吊った質量
  const tmd = new THREE.Group();
  const mass = boxMesh([-1.6, -2.2, -1.3], [1.6, 2.2, 0], new THREE.MeshStandardMaterial({ color: 0x1b2a33, emissive: COLORS.cyan, emissiveIntensity: 1.6, roughness: 0.4 }));
  const rod = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: COLORS.cyan }));
  rod.frustumCulled = false;
  tmd.add(mass, rod);
  world.add(tmd);
  const train = makeTrain({ cars: M.n_cars, car: M.car - 0.6, gap: 0.6 });
  train.position.set(-1000, 0, DECK_Z + 0.16);
  world.add(train);

  const sample = (arr, ts) => { const f = clamp(ts / Hs.dt, 0, arr.length - 1.001), i = Math.floor(f); return arr[i] + (arr[i + 1] - arr[i]) * (f - i); };
  const qmax = Math.max(...Hs.none.map(Math.abs));

  // --- 文字 ---------------------------------------------------------------
  chapter(hud, '05', '技術開発', 'AUTONOMOUS EXPERIMENTS');
  const ask = prompt(hud, '高速化で桁が共振する。制振装置の最適な諸元を見つけてほしい。', 0.8, T.exp1 + 1.5);
  const red = (1 - E2.found[2] / Math.max(...C.none)) * 100;
  const sub = subtitles(hud, [
    [1.2, 6.0, `時速 ${M.v_show.toFixed(0)} km。車両の通過周期が、桁の固有振動数と重なる。`],
    [7.0, 12.2, `まず答えのある問題で自分を試す。<em>古典解</em>を ${E1.n} 回の実験で再発見。`],
    [13.0, 18.3, '次に、<em>答えのない問題</em>へ。実験して、学んで、次の一手を決める。'],
    [18.8, 22.0, '同じ列車、同じ速度。桁は、もう暴れない。'],
    [22.8, 29.4, `最大加速度 <strong>−${red.toFixed(0)}%</strong>。総当たり ${G * G} 回と同じ答えに、${E2.n} 回で到達。`],
  ]);
  const p = panel(hud, 'EXPERIMENT LOOP', [['mode', '実験'], ['n', '実験回数'], ['best', '現在の最良値'], ['ref', '照合']]);
  const hm = document.createElement('canvas');
  hm.width = 800; hm.height = 560;
  p.node.appendChild(hm);
  el(p.node, 'cap', '横軸：振動数比 f　縦軸：TMD 減衰定数 ζ　（明るいほど応答が小さい）');
  const g2 = hm.getContext('2d');
  const HX = (f) => 60 + ((f - BD[0][0]) / (BD[0][1] - BD[0][0])) * 720, HY = (z) => 520 - ((z - BD[1][0]) / (BD[1][1] - BD[1][0])) * 500;
  const heat = (vals, alpha) => {
    const lo = Math.log(Math.min(...vals)), hi = Math.log(Math.max(...vals));
    const cw = 720 / G, ch = 500 / G;
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      const k = 1 - (Math.log(vals[i * G + j]) - lo) / (hi - lo);
      g2.fillStyle = `rgba(${Math.round(lerp(14, 88, k ** 2))},${Math.round(lerp(26, 214, k ** 2))},${Math.round(lerp(52, 255, k ** 1.5))},${alpha})`;
      g2.fillRect(60 + i * cw, 520 - (j + 1) * ch, cw + 0.6, ch + 0.6);
    }
  };
  const drawMap = (E, n, bg, bgAlpha, star) => {
    g2.clearRect(0, 0, 800, 560);
    g2.fillStyle = 'rgba(130,190,230,.07)'; g2.fillRect(60, 20, 720, 500);
    if (bg) heat(bg, bgAlpha);
    g2.fillStyle = '#8497a9'; g2.font = '22px "JetBrains Mono"';
    for (const f of [0.8, 0.9, 1.0, 1.1]) g2.fillText(f.toFixed(1), HX(f) - 20, 548);
    for (const z of [0.1, 0.2, 0.3]) g2.fillText(z.toFixed(1), 8, HY(z) + 8);
    let bi = 0;
    for (let i = 0; i < n; i++) if (E.y[i] < E.y[bi]) bi = i;
    for (let i = 0; i < n; i++) {
      g2.fillStyle = i < 8 ? 'rgba(234,243,250,.55)' : '#eaf3fa';
      g2.beginPath(); g2.arc(HX(E.X[i][0]), HY(E.X[i][1]), i === n - 1 ? 9 : 5, 0, 7); g2.fill();
    }
    if (n > 0) { g2.strokeStyle = '#7de3a5'; g2.lineWidth = 4; g2.beginPath(); g2.arc(HX(E.X[bi][0]), HY(E.X[bi][1]), 16, 0, 7); g2.stroke(); }
    if (star) {
      g2.strokeStyle = g2.fillStyle = '#ffb454'; g2.lineWidth = 3;
      const x = HX(E1.den_hartog[0]), y = HY(E1.den_hartog[1]);
      g2.beginPath(); g2.moveTo(x - 16, y); g2.lineTo(x + 16, y); g2.moveTo(x, y - 16); g2.lineTo(x, y + 16); g2.stroke();
      g2.font = '700 22px "Noto Sans JP"'; g2.fillText('古典解（Den Hartog）', x + 20, y - 12);
    }
    return n > 0 ? E.y[bi] : null;
  };
  const chart = el(hud, 'chart', '<h3>RESONANCE ／ 走行速度と桁中央の最大加速度</h3>');
  const hc = document.createElement('canvas');
  hc.width = 1520; hc.height = 340; hc.style.width = '760px'; hc.style.height = '170px';
  chart.appendChild(hc);
  el(chart, 'legend', '<span style="--c:#ffb454">制振なし</span><span style="--c:#58d6ff">AIが見つけた制振装置</span>');
  const g3 = hc.getContext('2d');
  const amax = Math.max(...C.none) * 1.12;
  const drawCurves = (kNone, kFound) => {
    const X = (s) => 70 + ((s - speeds[0]) / (speeds.at(-1) - speeds[0])) * 1430, Y = (a) => 300 - (a / amax) * 280;
    g3.clearRect(0, 0, 1520, 340);
    g3.font = '22px "JetBrains Mono"'; g3.fillStyle = '#8497a9';
    for (const a of [0, 0.4, 0.8]) { g3.fillText(a.toFixed(1), 8, Y(a) + 8); g3.fillRect(70, Y(a), 1430, 1); }
    for (const s of [120, 180, 240, 300, 360]) g3.fillText(`${s}`, X(s) - 20, 334);
    g3.fillText('km/h', 1436, 296); g3.fillText('m/s²', 8, 22);
    g3.strokeStyle = 'rgba(234,243,250,.6)'; g3.lineWidth = 2; g3.setLineDash([8, 8]);
    g3.beginPath(); g3.moveTo(X(M.v_res), 10); g3.lineTo(X(M.v_res), 300); g3.stroke(); g3.setLineDash([]);
    g3.fillStyle = '#eaf3fa'; g3.font = '700 22px "Noto Sans JP"'; g3.fillText(`共振速度（理論）${M.v_res.toFixed(0)} km/h`, X(M.v_res) - 330, 30);
    [[C.none, '#ffb454', kNone], [C.found, '#58d6ff', kFound]].forEach(([c, col, k]) => {
      if (k <= 0) return;
      g3.strokeStyle = col; g3.lineWidth = 5; g3.lineJoin = 'round'; g3.beginPath();
      const n = Math.max(2, Math.floor(k * c.length));
      for (let i = 0; i < n; i++) g3[i ? 'lineTo' : 'moveTo'](X(speeds[i]), Y(c[i]));
      g3.stroke();
    });
  };
  const tScale = tag(hud, `<i>変形は ${SCALE} 倍に強調</i>`, 'c');
  const tTmd = tag(hud, '<i>制振装置（TMD）</i>', 'c');
  el(hud, 'note', '※ 桁・列車の諸元はデモ用の架空条件です（1次モードのみの簡易モデル）');

  return {
    duration: T.end,
    render(t) {
      const az = lerp(-0.34, 0.2, easeInOut(seg(t, 0, T.end))), dist = lerp(150, 128, ease(seg(t, 0, 8)));
      camera.position.set(center.x + dist * Math.sin(az) * Math.cos(0.13), center.y + dist * Math.sin(0.13), center.z + dist * Math.cos(az) * Math.cos(0.13));
      camera.lookAt(center.x, center.y + 1, center.z);
      st.frameLeft(150, 120);
      camera.updateMatrixWorld();

      // 2回の走行：制振なし（A）と制振あり（B）
      const withTmd = t >= T.exp2 + 1.5;
      const ts = withTmd ? t - T.runB : t - T.runA;
      const q = ts > 0 ? sample(withTmd ? Hs.tmd : Hs.none, ts) : 0;
      deform(q);
      gmat.emissiveIntensity = 1.8 * clamp(Math.abs(q) / qmax) ** 3;
      train.position.x = ts > -3 ? v * ts + 2.5 : -1000;
      tmd.visible = withTmd;
      const zt = ts > 0 ? sample(Hs.tmd_z, ts) : 0;
      const zg = DECK_Z - DEPTH + (q / 1000) * SCALE;
      tmd.position.set(L / 2, 0, zg - 2.2 + ((zt - q) / 1000) * SCALE * 0.6);
      rod.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, zg - tmd.position.z)]);
      mass.material.emissiveIntensity = 1.2 + 0.6 * ease(seg(t, T.exp2 + 1.5, T.exp2 + 2.5));

      sub(t); ask(t);
      const n1 = Math.round(E1.n * seg(t, T.exp1 + 0.5, T.exp2 - 1.8)), n2 = Math.round(E2.n * seg(t, T.exp2 + 0.6, T.runB + 3.4));
      const second = t >= T.exp2;
      const snap = second ? [...E2.snaps].reverse().find((s) => s.n <= Math.max(n2, 8)) : null;
      const reveal = ease(seg(t, T.result + 1, T.result + 2.5));
      const best = second
        ? drawMap(E2, n2, reveal > 0 ? E2.truth : snap && snap.mean, reveal > 0 ? 1 : 0.9 * ease(seg(t, T.exp2 + 1, T.exp2 + 2)), false)
        : drawMap(E1, n1, null, 0, t > T.exp1 + 0.4);
      p.set('mode', second ? '② 列車走行（答えなし）' : '① 調和加振（検証）');
      p.set('n', `${second ? n2 : n1}<small>/ ${second ? E2.n : E1.n} 回</small>`);
      p.set('best', best == null ? '–' : second ? `${best.toFixed(2)}<small>m/s²</small>` : `${best.toFixed(2)}<small>倍</small>`);
      const done1 = !second && n1 >= E1.n, done2 = second && n2 >= E2.n;
      p.set('ref', done1 ? `古典解との差 ${((E1.found[2] / E1.den_hartog[2] - 1) * 100).toFixed(1)}%`
        : done2 ? `総当たり最小 ${E2.truth_min.toFixed(2)}` : '–', done1 || done2 ? 'ok' : '');
      p.node.querySelectorAll('.row b').forEach((b, i) => { if (i === 0 || i === 3) b.style.fontSize = '17px'; });
      p.node.style.opacity = ease(seg(t, T.exp1 - 0.8, T.exp1));
      chart.style.opacity = ease(seg(t, 2.6, 3.4));
      drawCurves(ease(seg(t, 3.0, 6.0)), ease(seg(t, T.runB + 3.2, T.result)));
      tScale(camera, V(L + 22, 0, DECK_Z + 8), ease(seg(t, 1.5, 2.5)) * (1 - ease(seg(t, T.exp1, T.exp1 + 1))));
      tTmd(camera, V(L / 2, 0, DECK_Z - DEPTH - 6.5), withTmd ? ease(seg(t, T.exp2 + 1.6, T.exp2 + 2.6)) * (1 - ease(seg(t, T.result, T.result + 1))) : 0);
      st.render();
    },
  };
}
