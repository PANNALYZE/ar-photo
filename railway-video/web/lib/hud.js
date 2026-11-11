// 画面上の文字要素（章タイトル・字幕・計測パネル）
import { el, fade } from './util.js';

export function chapter(hud, no, jp, en) {
  return el(hud, 'chapter', `<div class="no"><b>${no}</b> / 05</div><div class="jp">${jp}</div><div class="en">${en}</div><div class="rule"></div>`);
}

// cues: [[開始秒, 終了秒, HTML], ...]
export function subtitles(hud, cues) {
  const node = el(hud, 'subtitle');
  let current = -1;
  return (t) => {
    const i = cues.findIndex(([a, b]) => t >= a && t < b);
    if (i !== current) { node.innerHTML = i < 0 ? '' : cues[i][2]; current = i; }
    node.style.opacity = i < 0 ? 0 : fade(t, cues[i][0], cues[i][1], 0.45);
  };
}

export function panel(hud, title, rows) {
  const node = el(hud, 'panel', `<h3>${title}</h3>` + rows.map(([k, label]) =>
    `<div class="row"><span>${label}</span><b data-k="${k}"></b></div>`).join(''));
  const cells = Object.fromEntries([...node.querySelectorAll('b')].map((b) => [b.dataset.k, b]));
  return { node, set: (k, html, cls = '') => { cells[k].innerHTML = html; cells[k].className = cls; } };
}

// 3D座標に追従するラベル
export function tag(hud, html, cls = '') {
  const node = el(hud, `tag ${cls}`, html);
  return (camera, vec3, opacity = 1) => {
    const p = vec3.clone().project(camera);
    node.style.left = `${(p.x * 0.5 + 0.5) * 1920}px`;
    node.style.top = `${(-p.y * 0.5 + 0.5) * 1080}px`;
    node.style.opacity = p.z < 1 ? opacity : 0;
  };
}

// 技術者の指示文。t0 から打ち込まれ、t1 で消える
export function prompt(hud, text, t0, t1, cps = 22) {
  const node = el(hud, 'prompt', '<div class="who">ENGINEER ▸ 指示</div><span></span><i class="caret"></i>');
  const span = node.querySelector('span'), caret = node.querySelector('.caret');
  return (t) => {
    const n = Math.max(0, Math.min(text.length, Math.floor((t - t0 - 0.4) * cps)));
    span.textContent = text.slice(0, n);
    caret.style.opacity = n < text.length || Math.floor(t * 2.5) % 2 ? 1 : 0;
    node.style.opacity = fade(t, t0, t1, 0.4);
  };
}
