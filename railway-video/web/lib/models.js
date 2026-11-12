// 複数のシーンで使う小道具（列車・軌道・架線）。解析座標系（x: 進行方向, z: 鉛直）で作る。
import * as THREE from 'three';
import { boxMesh, COLORS } from './stage.js';

// 列車：先頭が x=0、後方へ -x に伸びる。レール上面が z=0
export function makeTrain({ cars = 6, car = 20, gap = 0.6, width = 2.95, glow = 1.25 } = {}) {
  const train = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9eef3, roughness: 0.28, metalness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b0f14, emissive: 0xffd9a0, emissiveIntensity: glow });
  const stripe = new THREE.MeshStandardMaterial({ color: 0x0c2a3a, emissive: COLORS.cyan, emissiveIntensity: 1.3 });
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(6) });
  for (let c = 0; c < cars; c++) {
    const x1 = -c * (car + gap), x0 = x1 - car, w = width / 2;
    const body = boxMesh([x0, -w, 0.5], [x1, w, 3.95], shell);
    if (c === 0) {                                   // 先頭車は前面を絞る
      const p = body.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getX(i) > 0) { p.setY(i, p.getY(i) * 0.5); if (p.getZ(i) > 0) p.setZ(i, p.getZ(i) - 1.5); p.setX(i, p.getX(i) + 2.2); }
      body.geometry.computeVertexNormals();
      for (const y of [-0.5, 0.5]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), lamp); l.position.set(2.3, y, 1.15); train.add(l); }
    }
    body.castShadow = true;
    train.add(body);
    for (const s of [-1, 1]) {
      train.add(boxMesh([x0 + 1.2, s * (w + 0.01) - 0.01, 2.25], [x1 - (c === 0 ? 3.5 : 1.2), s * (w + 0.01) + 0.01, 3.1], glass));
      train.add(boxMesh([x0 + 0.2, s * (w + 0.012) - 0.01, 1.55], [x1 - (c === 0 ? 1.5 : 0.2), s * (w + 0.012) + 0.01, 1.7], stripe));
    }
  }
  return train;
}

// 複線の軌道と架線（x 方向に x0〜x1）。軌道中心は y = ±off、レール上面が z=0
export function makeTrack({ x0, x1, off = 2.0, poles = 25, bed = true } = {}) {
  const g = new THREE.Group();
  const rail = new THREE.MeshStandardMaterial({ color: 0x9fb0be, roughness: 0.35, metalness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x55626e, roughness: 0.5, metalness: 0.7 });
  if (bed) {
    const b = boxMesh([x0, -off - 2.4, -0.55], [x1, off + 2.4, -0.16], new THREE.MeshStandardMaterial({ color: 0x2a3037, roughness: 1 }));
    b.receiveShadow = true;
    g.add(b);
  }
  for (const c of [-off, off]) for (const s of [-0.7175, 0.7175]) g.add(boxMesh([x0, c + s - 0.035, -0.16], [x1, c + s + 0.035, 0], rail));
  const wire = new THREE.LineBasicMaterial({ color: 0x8da2b3 });
  for (let x = x0 + poles / 2; x < x1; x += poles) for (const side of [-1, 1]) {
    const y = side * (off + 2.9);
    g.add(boxMesh([x - 0.11, y - 0.11, -0.5], [x + 0.11, y + 0.11, 7.0], steel));
    g.add(boxMesh([x - 0.05, Math.min(y, side * off), 6.3], [x + 0.05, Math.max(y, side * off), 6.42], steel));
  }
  for (const c of [-off, off]) for (const z of [5.3, 6.3]) {
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x0, c, z), new THREE.Vector3(x1, c, z)]), wire));
  }
  return g;
}
