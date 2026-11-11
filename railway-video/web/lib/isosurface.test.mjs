// 等値面メッシャの検証：球の体積・向き・法線が解析値と合うこと
import test from 'node:test';
import assert from 'node:assert/strict';
import { IsoMesher } from './isosurface.js';

test('球の等値面：体積が解析値に一致し、面は外向き', () => {
  const n = 48, h = 0.25, R = 4.0, c = (n * h) / 2;
  const vol = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot((i + 0.5) * h - c, (j + 0.5) * h - c, (k + 0.5) * h - c);
    vol[i + n * (j + n * k)] = Math.min(1, Math.max(0, 0.5 + (R - r) / (2 * h))); // 表面をまたぐ滑らかな密度
  }
  const m = new IsoMesher(n, n, n, h);
  m.load(vol, null, 0, 1);
  const count = m.build(0.5);
  assert.ok(count > 1000 && count % 3 === 0);
  const exact = (4 / 3) * Math.PI * R ** 3;
  const v = m.signedVolume();
  assert.ok(v > 0, '面が内向きです');
  assert.ok(Math.abs(v - exact) / exact < 0.01, `体積誤差 ${(Math.abs(v - exact) / exact * 100).toFixed(2)}%`);
  // 法線は半径方向を向く
  let worst = 1;
  for (let i = 0; i < count; i++) {
    const x = m.positions[3 * i] - c, y = m.positions[3 * i + 1] - c, z = m.positions[3 * i + 2] - c;
    const l = Math.hypot(x, y, z);
    worst = Math.min(worst, (x * m.normals[3 * i] + y * m.normals[3 * i + 1] + z * m.normals[3 * i + 2]) / l);
  }
  assert.ok(worst > 0.98, `法線のずれ cos=${worst}`);
});
