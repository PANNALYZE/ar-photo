// 06 結び — 5つの章を並べ、この映像そのものが AI の仕事であることを明かす
import { seg, ease, fade, el, lerp } from '../lib/util.js';

const TILES = [['01', '計画', 'plan'], ['02', '設計', 'design'], ['03', '施工', 'build'], ['04', '維持管理', 'tunnel'], ['05', '技術開発', 'research']];

export async function create({ canvas, hud }) {
  canvas.style.display = 'none';
  const row = el(hud, 'tiles');
  const tiles = TILES.map(([no, jp, key]) => el(row, 'tile', `<img src="/web/assets/${key}.jpg"><div><b>${no}</b>${jp}</div>`));
  await Promise.all(tiles.map((t) => t.querySelector('img').decode().catch(() => {})));
  const a = el(hud, 'title e1', 'この映像の地形も、構造解析も、最適化も、<br>工程も、予測も、音楽も、編集も。');
  const b = el(hud, 'title e2', 'すべて <b>AI が、ひとつの対話の中で</b>つくりました。');
  const c = el(hud, 'title e3', '<small>計算は AI が担い、</small><b>判断するのは、技術者。</b>');
  const d = el(hud, 'title e4', 'Generated with Claude　／　数値・条件はすべてデモ用の架空設定です');
  return {
    duration: 16,
    render(t) {
      tiles.forEach((tile, i) => {
        const k = ease(seg(t, 0.4 + i * 0.35, 1.4 + i * 0.35));
        tile.style.opacity = k * (1 - 0.72 * ease(seg(t, 9.6, 11)));
        tile.style.transform = `translateY(${lerp(30, 0, k)}px)`;
      });
      a.style.opacity = fade(t, 3.0, 9.6, 0.7);
      b.style.opacity = fade(t, 5.2, 9.6, 0.7);
      c.style.opacity = fade(t, 10.2, 16.4, 0.8);
      d.style.opacity = ease(seg(t, 11.5, 12.5)) * 0.9;
    },
  };
}
