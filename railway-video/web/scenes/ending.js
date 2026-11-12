// 結び — 5つの章を並べ、すべてがコードから生まれたことと、その量を明かす
import { seg, ease, fade, el, lerp, fetchJson, fmt } from '../lib/util.js';

const TILES = [['01', '計画', 'plan'], ['02', '設計', 'design'], ['03', '施工', 'build'], ['04', '維持管理', 'tunnel'], ['05', '技術開発', 'research']];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function create({ canvas, hud, params }) {
  canvas.style.display = 'none';
  const credit = params.get('credit') || 'Claude';
  const tl = await fetchJson('/render/timeline.json');
  const E = tl.find((s) => s.scene === 'ending');
  const frames = tl.reduce((a, s) => a + s.duration, 0) * 30;
  const S = await fetchJson('/web/assets/codestats.json');

  // 背景を流れる実際のソースコード
  const wall = el(hud, 'wall');
  const texts = await Promise.all(S.wall.map(async (f) => `# ── ${f}\n${await (await fetch(`/${f}`)).text()}`));
  const cols = Array.from({ length: 5 }, (_, i) => {
    const c = el(wall, 'col');
    c.innerHTML = `<pre>${esc([texts[i], texts[i + 5], texts[i]].join('\n'))}</pre>`;
    return c.firstChild;
  });

  const row = el(hud, 'tiles');
  const tiles = TILES.map(([no, jp, key]) => el(row, 'tile', `<img src="/web/assets/${key}.jpg"><div><b>${no}</b>${jp}</div>`));
  await Promise.all(tiles.map((t) => t.querySelector('img').decode().catch(() => {})));
  const a = el(hud, 'title e1', 'この映像の地形も、構造解析も、最適化も、<br>工程も、予測も、音楽も、編集も。');
  const b = el(hud, 'title e2', `すべて <b>${credit}</b> が、ひとつの対話の中でつくりました。`);
  const langs = Object.entries(S.by_lang).map(([k, v]) => `${k} <b>${fmt(v)}</b>`).join('　／　');
  const code = el(hud, 'code', `
    <div class="lab">ALL OF IT IS CODE</div>
    <div class="num"><span></span><small>行</small></div>
    <div class="sub">${langs}　／　<b>${S.files}</b> ファイル</div>
    <div class="zero"><div><b>0</b>画像素材</div><div><b>0</b>映像素材</div><div><b>0</b>音源素材</div><div><b>${fmt(frames)}</b>フレームを生成</div>
      ${S.elapsed_min ? `<div><b>${Math.floor(S.elapsed_min / 60)}<u>時間</u>${S.elapsed_min % 60}<u>分</u></b>対話の開始から完成まで</div>` : ''}</div>`);
  const num = code.querySelector('.num span');
  const c = el(hud, 'title e3', '<small>計算は AI が担い、</small><b>判断するのは、技術者。</b>');
  const made = el(hud, 'made', `<div class="by">CREATED BY</div><div class="name">${credit}</div><div class="motto">ひとつの対話。すべて、コード。</div>`);
  const d = el(hud, 'title e4', '数値・条件はすべてデモ用の架空設定です　／　公開ライブラリ（three.js・NumPy・SciPy ほか）とフォントを使用');

  return {
    duration: E.duration,
    render(t) {
      const codeK = fade(t, E.code_at, E.judge_at, 0.7);
      tiles.forEach((tile, i) => {
        const k = ease(seg(t, 0.4 + i * 0.3, 1.3 + i * 0.3));
        tile.style.opacity = k * (1 - ease(seg(t, E.code_at - 1.0, E.code_at - 0.2)));
        tile.style.transform = `translateY(${lerp(30, 0, k)}px)`;
      });
      a.style.opacity = fade(t, 2.4, E.code_at - 0.3, 0.6);
      b.style.opacity = fade(t, 4.2, E.code_at - 0.3, 0.6);
      wall.style.opacity = 0.5 * ease(seg(t, E.code_at - 0.4, E.code_at + 0.8)) * (1 - 0.6 * ease(seg(t, E.judge_at - 0.5, E.judge_at + 0.5)))
        * (1 - 0.35 * ease(seg(t, E.credit_at - 0.5, E.credit_at + 0.5)));
      cols.forEach((pre, i) => { pre.style.transform = `translateY(${-(t - E.code_at + 2) * (150 + 55 * ((i * 3) % 5)) - i * 400}px)`; });
      code.style.opacity = codeK;
      num.textContent = fmt(Math.round(S.total * (1 - (1 - seg(t, E.code_at + 0.3, E.code_at + 3.0)) ** 3)));
      code.querySelectorAll('.zero > div').forEach((z, i) => { z.style.opacity = ease(seg(t, E.code_at + 3.2 + i * 0.5, E.code_at + 3.6 + i * 0.5)); });
      code.querySelector('.sub').style.opacity = ease(seg(t, E.code_at + 2.2, E.code_at + 2.9));
      c.style.opacity = fade(t, E.judge_at + 0.2, E.credit_at - 0.1, 0.6);
      const mk = ease(seg(t, E.credit_at, E.credit_at + 0.9));
      made.style.opacity = mk;
      made.style.transform = `scale(${lerp(1.06, 1, mk)})`;
      d.style.opacity = ease(seg(t, E.credit_at + 1.0, E.credit_at + 1.8)) * 0.9;
    },
  };
}
