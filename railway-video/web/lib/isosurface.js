// 密度ボリュームから等値面メッシュを作る（マーチングキューブ法）。
// 位相最適化の反復途中の密度場を毎フレーム補間しながらメッシュ化するために使う。
// 入力: セル中心値 vol[ix + nx*(iy + ny*iz)]（解析エンジンと同じ並び）
// 出力: 解析座標系 (x: 橋軸, y: 橋軸直角, z: 鉛直) の非インデックス三角形
import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';

// 立方体の辺 → 両端の頂点番号（頂点は 0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4-7: z+1 側）
const EDGE = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const CORNER = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

export class IsoMesher {
  constructor(nx, ny, nz, h, maxVerts = 1800000) {
    Object.assign(this, { nx, ny, nz, h });
    this.px = nx + 2; this.py = ny + 2; this.pz = nz + 2;
    const n = this.px * this.py * this.pz;
    this.vol = new Float32Array(n);   // 周囲1セルをゼロで囲んだボリューム
    this.aux = new Float32Array(n);   // 頂点に載せる付帯量（応力など）
    this.gx = new Float32Array(n); this.gy = new Float32Array(n); this.gz = new Float32Array(n);
    this.positions = new Float32Array(maxVerts * 3);
    this.normals = new Float32Array(maxVerts * 3);
    this.values = new Float32Array(maxVerts);
    this.count = 0;
    this.offs = CORNER.map(([i, j, k]) => i + this.px * (j + this.py * k));
  }

  _fill(dst, a, b, mix, scale) {
    const { nx, ny, nz, px, py } = this;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      let s = nx * (j + ny * k);
      let d = 1 + px * (j + 1 + py * (k + 1));
      if (b && mix > 0) for (let i = 0; i < nx; i++, s++, d++) dst[d] = (a[s] + (b[s] - a[s]) * mix) * scale;
      else for (let i = 0; i < nx; i++, s++, d++) dst[d] = a[s] * scale;
    }
  }

  // 密度ボリュームを読み込む（a と b を mix で線形補間）。scale は 0..1 への換算係数
  load(a, b = null, mix = 0, scale = 1 / 255) { this._fill(this.vol, a, b, mix, scale); return this; }
  loadAux(a, b = null, mix = 0, scale = 1) { this._fill(this.aux, a, b, mix, scale); return this; }

  build(iso = 0.5) {
    const { px, py, pz, h, vol, aux, gx, gy, gz, offs } = this;
    const sxy = px * py;
    for (let k = 1; k < pz - 1; k++) for (let j = 1; j < py - 1; j++) {
      let q = 1 + px * (j + py * k);
      for (let i = 1; i < px - 1; i++, q++) {
        gx[q] = vol[q + 1] - vol[q - 1];
        gy[q] = vol[q + px] - vol[q - px];
        gz[q] = vol[q + sxy] - vol[q - sxy];
      }
    }
    const P = this.positions, N = this.normals, V = this.values;
    const ev = new Float32Array(12 * 7); // 辺ごとの頂点 (x,y,z,nx,ny,nz,value)
    const f = new Float32Array(8);
    let n = 0;
    const limit = V.length - 15;
    for (let k = 0; k < pz - 1; k++) for (let j = 0; j < py - 1; j++) for (let i = 0; i < px - 1; i++) {
      const q = i + px * (j + py * k);
      let ci = 0;
      for (let c = 0; c < 8; c++) { f[c] = vol[q + offs[c]]; if (f[c] < iso) ci |= 1 << c; }
      const bits = edgeTable[ci];
      if (bits === 0) continue;
      for (let e = 0; e < 12; e++) {
        if (!(bits & (1 << e))) continue;
        const a = EDGE[e][0], b = EDGE[e][1];
        const t = (iso - f[a]) / (f[b] - f[a]);
        const qa = q + offs[a], qb = q + offs[b];
        const ca = CORNER[a], cb = CORNER[b];
        const o = e * 7;
        // 周囲1セル分の詰め物と、セル中心（+0.5）を考慮して実座標へ
        ev[o] = (i + ca[0] + (cb[0] - ca[0]) * t - 0.5) * h;
        ev[o + 1] = (j + ca[1] + (cb[1] - ca[1]) * t - 0.5) * h;
        ev[o + 2] = (k + ca[2] + (cb[2] - ca[2]) * t - 0.5) * h;
        let ax = -(gx[qa] + (gx[qb] - gx[qa]) * t);
        let ay = -(gy[qa] + (gy[qb] - gy[qa]) * t);
        let az = -(gz[qa] + (gz[qb] - gz[qa]) * t);
        const l = Math.hypot(ax, ay, az) || 1;
        ev[o + 3] = ax / l; ev[o + 4] = ay / l; ev[o + 5] = az / l;
        ev[o + 6] = aux[qa] + (aux[qb] - aux[qa]) * t;
      }
      for (let ti = ci << 4; triTable[ti] !== -1; ti += 3) {
        if (n > limit) throw new Error('IsoMesher: 頂点バッファが不足しています');
        // 三角形表の順でそのまま外向き（反時計回り）になる。球の体積テストで確認済み
        for (let c = 0; c < 3; c++) {
          const o = triTable[ti + c] * 7, m = n * 3;
          P[m] = ev[o]; P[m + 1] = ev[o + 1]; P[m + 2] = ev[o + 2];
          N[m] = ev[o + 3]; N[m + 1] = ev[o + 4]; N[m + 2] = ev[o + 5];
          V[n++] = ev[o + 6];
        }
      }
    }
    this.count = n;
    return n;
  }

  // 閉曲面の符号付き体積（発散定理）。検証用：外向きなら正で、ボクセル体積とほぼ一致する
  signedVolume() {
    const P = this.positions;
    let v = 0;
    for (let i = 0; i < this.count * 3; i += 9) {
      v += P[i] * (P[i + 4] * P[i + 8] - P[i + 5] * P[i + 7])
        - P[i + 1] * (P[i + 3] * P[i + 8] - P[i + 5] * P[i + 6])
        + P[i + 2] * (P[i + 3] * P[i + 7] - P[i + 4] * P[i + 6]);
    }
    return v / 6;
  }
}
