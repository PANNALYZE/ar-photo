// 00 導入 — 夜の線路。「鉄道は、止まれない。」
import * as THREE from 'three';
import { createStage, groundGrid } from '../lib/stage.js';
import { makeTrain, makeTrack } from '../lib/models.js';
import { lerp, seg, ease, fade, el } from '../lib/util.js';

export async function create({ canvas, hud }) {
  const st = createStage(canvas, { fog: 0.0105, bloom: 0.5 });
  const { scene, camera, world } = st;
  st.key.color.set(0x9fb6ff); st.key.intensity = 1.3;
  st.aim(new THREE.Vector3(0, 0, 0), 80);
  scene.add(groundGrid({ cell: 5 }));
  const track = makeTrack({ x0: -400, x1: 900, off: 2.0 });
  track.position.z = 0.6;                             // 道床を地面より上に
  world.add(track);
  const train = makeTrain({ cars: 10, glow: 1.6 });
  train.position.set(900, -2.0, 0.6);
  train.rotation.z = Math.PI;                         // 奥から手前へ走ってくる
  world.add(train);
  const head = new THREE.PointLight(0xfff0d0, 0, 160, 1.4);
  world.add(head);

  const line = (cls, html) => el(hud, `title ${cls}`, html);
  const l1 = line('l1', '鉄道は、<b>止まれない。</b>');
  const l2 = line('l2', '終電から始発まで。次の列車が来るまで。<br>限られた時間で、構造物をつくり、守り続ける。');
  const l3 = line('l3', '<small>INFRASTRUCTURE × AI</small>鉄道構造物の、<b>次の実務</b>');
  const l4 = line('l4', '計画　／　設計　／　施工　／　維持管理　／　技術開発');

  return {
    duration: 14,
    render(t) {
      const k = seg(t, 0, 14);
      camera.position.set(lerp(-40, -26, k), lerp(1.9, 2.6, k), lerp(8.2, 7.4, k));   // 線路脇の低い位置から
      camera.lookAt(70, 5.5, 6.0);                         // 列車は画面の左寄り、文字は中央
      camera.fov = 38; camera.updateProjectionMatrix();
      const x = lerp(620, -420, seg(t, 2.0, 11.5));
      train.position.x = x;
      head.position.set(x - 8, -2, 2.6);
      head.intensity = 800 * ease(seg(t, 2, 4));
      l1.style.opacity = fade(t, 0.6, 4.6, 0.7);
      l2.style.opacity = fade(t, 4.9, 9.2, 0.6);
      l3.style.opacity = fade(t, 9.6, 14.2, 0.7);
      l4.style.opacity = fade(t, 10.6, 14.2, 0.7);
      st.render();
    },
  };
}
