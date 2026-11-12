// 04 維持管理 — トンネル覆工のデジタルツイン（変状検出と進行予測）
// 合成データ（data/tunnel/）上の検出結果と予測を、トンネル内を進みながら見せる。
import * as THREE from 'three';
import { createStage, boxMesh, COLORS } from '../lib/stage.js';
import { makeTrack } from '../lib/models.js';
import { chapter, subtitles, panel, prompt, tag } from '../lib/hud.js';
import { clamp, lerp, seg, ease, easeInOut, fetchJson, el } from '../lib/util.js';

const T = { enter: 0, scan: 4.5, future: 12.5, rank: 20.5, exit: 26.5, end: 31 };
const CW = 7200, CH = 736;                           // ひび割れを描く展開キャンバス（1画素 = 2.5cm）

export async function create({ canvas, hud }) {
  const M = await fetchJson('/data/tunnel/meta.json');
  const { L, R, half_arc: HA, thresh: TH, cracks } = M;
  const ZC = -R * Math.cos(HA / R);                  // 覆工中心の高さ（脚部が z=0 になるように）
  const onLining = (s, u, inset = 0) => new THREE.Vector3(s, (R - inset) * Math.sin(u / R), (R - inset) * Math.cos(u / R) + ZC);
  const V = (v) => new THREE.Vector3(v.x, v.z, -v.y);

  const st = createStage(canvas, { fog: 0.008, bloom: 0.55, shadows: false });
  const { scene, camera, world } = st;
  st.key.intensity = 0; st.rim.intensity = 0;
  scene.children.filter((c) => c.isHemisphereLight).forEach((h) => { h.intensity = 0.10; });

  // --- 覆工 -----------------------------------------------------------------
  const NS = 180, NU = 48;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= NU; j++) for (let i = 0; i <= NS; i++) {
    const p = onLining((i / NS) * L, lerp(-HA, HA, j / NU));
    pos.push(p.x, p.y, p.z); uv.push(i / NS, j / NU);
  }
  for (let j = 0; j < NU; j++) for (let i = 0; i < NS; i++) {
    const q = i + (NS + 1) * j;
    idx.push(q, q + NS + 1, q + 1, q + 1, q + NS + 1, q + NS + 2);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)).setIndex(idx);
  lg.computeVertexNormals();
  const map = await new THREE.TextureLoader().loadAsync('/data/tunnel/lining.png');
  map.flipY = false; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const g = cv.getContext('2d');
  const glow = new THREE.CanvasTexture(cv);
  glow.flipY = false; glow.colorSpace = THREE.SRGBColorSpace; glow.anisotropy = 8;
  const lining = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ map, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 1.8 }));
  world.add(lining);
  // 路盤と軌道
  world.add(boxMesh([0, -R, -0.7], [L, R, 0.0], new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.95 })));
  const track = makeTrack({ x0: 0, x1: L, off: 2.0, poles: 1e9, bed: false });
  track.position.z = 0.18;
  world.add(track);
  // 坑内照明（側壁の灯具）と出口の光
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9c4).multiplyScalar(1.5) });
  for (let s = 6; s < L; s += 12) for (const side of [-1, 1]) {
    const p = onLining(s, side * 5.6, 0.12);
    const l = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.2), lampMat);
    l.position.copy(p);
    world.add(l);
  }
  const exit = new THREE.Mesh(new THREE.CircleGeometry(R * 1.1, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xcfe6ff).multiplyScalar(1.5), fog: false }));
  exit.rotation.y = -Math.PI / 2;
  exit.position.set(L + 0.5, 0, ZC + 0.6);
  world.add(exit);
  // 計測リング（走査光）と検査車の灯り
  const ringPts = [];
  for (let j = 0; j <= 64; j++) ringPts.push(new THREE.Vector3(0, (R - 0.06) * Math.sin(lerp(-HA, HA, j / 64) / R), (R - 0.06) * Math.cos(lerp(-HA, HA, j / 64) / R) + ZC));
  const ring = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ringPts), 96, 0.07, 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.cyan).multiplyScalar(4) }));
  world.add(ring);
  const ringLight = new THREE.PointLight(COLORS.cyan, 70, 40, 1.6);
  world.add(ringLight);
  const carLight = new THREE.PointLight(0xffe6c8, 26, 80, 1.3);
  world.add(carLight);

  // --- ひび割れ（検出できたものだけを描く。見落としは数として示す） ----------------
  const found = cracks.filter((c) => c.detected);
  for (const c of cracks) {
    c.mid = c.pts[Math.floor(c.pts.length / 2)];
    c.s0 = Math.min(...c.pts.map((p) => p[0]));
  }
  const widthAt = (c, yr) => Math.max(0.05, c.fit.a + c.fit.b * (M.years.at(-1) + yr));   // yr: 現在からの年数
  const color = (w, a = 1) => {
    const k = clamp((w - 0.5 * TH) / (0.5 * TH));
    return `rgba(${255}, ${Math.round(lerp(190, 70, k))}, ${Math.round(lerp(90, 60, k))}, ${a})`;
  };
  const drawCracks = (sRing, yr, focus) => {
    g.clearRect(0, 0, CW, CH);
    g.lineCap = g.lineJoin = 'round';
    for (const c of found) {
      if (c.s0 > sRing) continue;
      const w = widthAt(c, yr), hot = focus > 0 && c.rank <= 5;
      g.strokeStyle = color(w, focus > 0 && !hot ? lerp(1, 0.28, focus) : 1);
      g.lineWidth = 2.0 + 3.4 * w + (hot ? 3.0 * focus : 0);
      g.beginPath();
      c.pts.forEach(([s, u], i) => { if (s <= sRing) g[i ? 'lineTo' : 'moveTo']((s / L) * CW, ((u + HA) / (2 * HA)) * CH); });
      g.stroke();
    }
    glow.needsUpdate = true;
  };

  // --- 文字 ---------------------------------------------------------------
  chapter(hud, '04', '維持管理', 'PREDICTIVE MAINTENANCE');
  const ask = prompt(hud, 'このトンネル、次の10年でどこから手を入れるべき？', 0.8, T.scan + 3);
  const D = M.detection;
  const sub = subtitles(hud, [
    [1.0, 4.2, '走るだけで、<em>覆工の全面</em>を記録する。'],
    [5.0, 12.0, `ひび割れ <strong>${D.n_detected} 本</strong>を自動で抽出。見落とし ${D.n - D.n_detected} 本も、隠さず数える。`],
    [13.0, 20.0, '過去の検査記録から、<em>10年先の姿</em>を確率で描く。'],
    [21.0, 26.0, `今は基準内。でも5年以内に超える。そんな <strong>${M.n_soon} 本</strong>を先に見つける。`],
    [27.0, 30.6, '壊れてから直す、から、<em>壊れる前に手を打つ</em>、へ。'],
  ]);
  const p = panel(hud, 'LINING INSPECTION', [['det', '検出したひび割れ'], ['len', '総延長'], ['yr', '表示時点'], ['over', `幅 ${TH.toFixed(1)} mm 以上`]]);
  const mc = document.createElement('canvas');
  mc.width = 800; mc.height = 356;
  p.node.appendChild(mc);
  el(p.node, 'cap', `変状展開図（上：0–${L / 2} m　下：${L / 2}–${L} m）`);
  const g2 = mc.getContext('2d');
  const drawMap = (sRing) => {
    g2.fillStyle = 'rgba(130,190,230,.08)'; g2.clearRect(0, 0, 800, 356);
    for (const r of [0, 1]) {
      g2.fillRect(0, r * 186, 800, 164);
      g2.drawImage(cv, r * CW / 2, 0, CW / 2, CH, 0, r * 186, 800, 164);
      const x = (sRing / L - r * 0.5) * 2 * 800;
      if (x >= 0 && x <= 800) { g2.fillStyle = '#58d6ff'; g2.fillRect(x - 1.5, r * 186, 3, 164); g2.fillStyle = 'rgba(130,190,230,.08)'; }
    }
  };
  const hero = cracks.find((c) => c.rank === 1);
  const chart = el(hud, 'chart', `<h3>CRACK No.${hero.id} ／ ひび割れ幅の推移と予測</h3>`);
  const hc = document.createElement('canvas');
  hc.width = 1520; hc.height = 360; hc.style.width = '760px'; hc.style.height = '180px';
  chart.appendChild(hc);
  el(chart, 'legend', '<span style="--c:#eaf3fa">検査の実測</span><span style="--c:#58d6ff">予測（中央）と90%区間</span><span style="--c:#ffb454">要対策の幅</span>');
  const g3 = hc.getContext('2d');
  const drawChart = (yr) => {
    const X = (t) => 70 + (t / 20) * 1430, Y = (w) => 330 - (w / 1.9) * 310, now = M.years.at(-1);
    g3.clearRect(0, 0, 1520, 360);
    g3.font = '22px "JetBrains Mono"'; g3.fillStyle = '#8497a9';
    for (const w of [0, 0.5, 1.0, 1.5]) { g3.fillText(w.toFixed(1), 8, Y(w) + 8); g3.fillRect(70, Y(w), 1430, 1); }
    g3.fillText('mm', 8, 24); g3.fillText('10年前', X(0) - 4, 356); g3.fillText('現在', X(10) - 24, 356); g3.fillText('10年後', X(20) - 84, 356);
    g3.strokeStyle = '#ffb454'; g3.lineWidth = 3; g3.setLineDash([12, 8]);
    g3.beginPath(); g3.moveTo(70, Y(TH)); g3.lineTo(1500, Y(TH)); g3.stroke(); g3.setLineDash([]);
    const f = hero.fit, P5 = hero.pred['5'], P10 = hero.pred['10'], sd0 = M.forecast.noise_sd * 1.645;
    const k = clamp(yr / 10);
    if (k > 0) {
      const fan = [[10, f.a + f.b * 10 - sd0, f.a + f.b * 10 + sd0], [15, P5.lo, P5.hi], [20, P10.lo, P10.hi]];
      const cut = (a, b, tt) => a + (b - a) * tt;
      const end = 10 + 10 * k, pts = fan.filter((q) => q[0] <= end);
      const i = fan.findIndex((q) => q[0] > end);
      if (i > 0) { const tt = (end - fan[i - 1][0]) / 5; pts.push([end, cut(fan[i - 1][1], fan[i][1], tt), cut(fan[i - 1][2], fan[i][2], tt)]); }
      g3.fillStyle = 'rgba(88,214,255,.22)'; g3.beginPath();
      pts.forEach((q, n) => g3[n ? 'lineTo' : 'moveTo'](X(q[0]), Y(q[2])));
      [...pts].reverse().forEach((q) => g3.lineTo(X(q[0]), Y(q[1])));
      g3.closePath(); g3.fill();
      g3.strokeStyle = '#58d6ff'; g3.lineWidth = 5; g3.beginPath(); g3.moveTo(X(10), Y(f.a + f.b * 10)); g3.lineTo(X(end), Y(f.a + f.b * end)); g3.stroke();
    }
    g3.strokeStyle = 'rgba(234,243,250,.5)'; g3.lineWidth = 3; g3.beginPath(); g3.moveTo(X(0), Y(f.a)); g3.lineTo(X(now), Y(f.a + f.b * now)); g3.stroke();
    g3.fillStyle = '#eaf3fa';
    M.years.forEach((t, n) => { g3.beginPath(); g3.arc(X(t), Y(hero.widths[n]), 9, 0, 7); g3.fill(); });
  };
  const tags = cracks.filter((c) => c.rank <= 5).map((c) => [
    tag(hud, `<i>優先 ${c.rank}</i> No.${c.id}　${c.widths.at(-1).toFixed(2)} → ${c.pred['5'].mean.toFixed(2)} mm　超過確率 ${(c.pred['5'].p_exceed * 100).toFixed(0)}%`), c]);
  el(hud, 'note', '※ 覆工画像・検査記録はすべて合成データです');

  return {
    duration: T.end,
    render(t) {
      // 検査車の位置：ゆっくり前進し、最後は出口へ加速する
      const cx = lerp(4, 46, seg(t, 0, T.exit)) + lerp(0, 110, ease(seg(t, T.exit, T.end + 0.5)) ** 2);
      const cam = new THREE.Vector3(cx, -1.3, 2.5);
      camera.position.copy(V(cam));
      camera.lookAt(V(new THREE.Vector3(cx + 30, 0.3 * Math.sin(t * 0.3), 3.3 + 0.4 * Math.sin(t * 0.21))));
      camera.fov = 62;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      carLight.position.set(cx + 3, 0, 3.4);

      const sRing = t < T.scan ? cx + 2 : lerp(cx + 2, L + 5, easeInOut(seg(t, T.scan, T.future - 1.5)));
      ring.position.x = sRing;
      ring.visible = sRing < L;
      ringLight.position.set(sRing, 0, 3.6);
      ringLight.intensity = ring.visible ? 70 : 0;
      const yr = 10 * easeInOut(seg(t, T.future + 0.8, T.rank - 1.2));
      const focus = ease(seg(t, T.rank, T.rank + 1.2)) * (1 - ease(seg(t, T.exit, T.exit + 1)));
      drawCracks(t < T.scan ? 0 : sRing, yr, focus);
      const fl = 1 + 0.25 * Math.sin(t * 9) * focus;
      lining.material.emissiveIntensity = 1.8 * fl;

      sub(t); ask(t);
      const shown = found.filter((c) => c.s0 <= (t < T.scan ? 0 : sRing));
      p.set('det', `${shown.length}<small>本／全 ${D.n} 本</small>`);
      p.set('len', `${shown.reduce((a, c) => a + 0.25 * (c.pts.length - 1), 0).toFixed(0)}<small>m</small>`);
      p.set('yr', yr < 0.05 ? '現在' : `${yr.toFixed(1)}<small>年後</small>`, yr > 0.05 ? 'warn' : '');
      const over = shown.filter((c) => widthAt(c, yr) >= TH).length;
      p.set('over', `${over}<small>本</small>`, over > M.n_now ? 'warn' : '');
      drawMap(sRing);
      p.node.style.opacity = ease(seg(t, T.scan - 1, T.scan)) * (1 - ease(seg(t, T.exit + 1, T.exit + 2)));
      chart.style.opacity = ease(seg(t, T.future - 0.4, T.future + 0.6)) * (1 - ease(seg(t, T.exit, T.exit + 1)));
      drawChart(yr);
      tags.forEach(([fn, c]) => {
        const ahead = c.mid[0] - cx;
        fn(camera, V(onLining(c.mid[0], c.mid[1], 0.5)), ahead > 6 && ahead < 95 ? focus : 0);
      });
      st.render();
    },
  };
}
