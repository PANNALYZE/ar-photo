// プロローグ — ひとつの指示が打ち込まれ、この動画の制作が始まる
import { seg, ease, clamp, fetchJson, el, fmt } from '../lib/util.js';

export async function create({ canvas, hud, params }) {
  canvas.style.display = 'none';
  const credit = params.get('credit') || 'Claude';
  const tl = await fetchJson('/render/timeline.json');
  const P = tl.find((s) => s.scene === 'prologue');
  const frames = tl.reduce((a, s) => a + s.duration, 0) * 30;
  const term = el(hud, 'term');
  el(term, 'bar', `<span class="dot"></span><b>${credit}</b><i>1 session ／ railway-video</i>`);
  const you = el(term, 'you', '<div class="who">YOU ▸</div><span></span><i class="caret"></i>');
  const span = you.querySelector('span'), caret = you.querySelector('.caret');
  const reply = el(term, 'reply', `<div class="who">${credit} ▸</div><span></span>`);
  const rs = reply.querySelector('span');
  const lines = P.log.map(([, verb, what, note]) =>
    el(term, 'log', `<b class="v-${verb}">● ${verb}</b><span>${what.replace('{frames}', fmt(frames))}</span><i>${note}</i>`));
  const prog = el(term, 'prog', '<div class="lab">RENDERING</div><div class="track"><i></i></div><div class="pct"></div>');
  const flash = el(hud, 'flash');

  return {
    duration: P.duration,
    render(t) {
      const n = clamp(Math.floor((t - P.type_start) * P.cps), 0, P.prompt.length);
      span.textContent = P.prompt.slice(0, n);
      caret.style.opacity = t < P.enter && (n < P.prompt.length || Math.floor(t * 2.5) % 2) ? 1 : 0;
      you.classList.toggle('sent', t >= P.enter);
      you.style.opacity = ease(seg(t, 0.3, 0.9));
      term.querySelector('.bar').style.opacity = ease(seg(t, 0.2, 0.8));
      reply.style.opacity = ease(seg(t, P.reply_at - 0.2, P.reply_at + 0.1));
      rs.textContent = P.reply.slice(0, clamp(Math.floor((t - P.reply_at) * 60), 0, P.reply.length));
      lines.forEach((ln, i) => {
        const k = ease(seg(t, P.log[i][0], P.log[i][0] + 0.18));
        ln.style.opacity = k;
        ln.style.transform = `translateX(${(1 - k) * -18}px)`;
      });
      const pk = ease(seg(t, P.render_at, P.duration - 0.9));
      prog.style.opacity = ease(seg(t, P.render_at - 0.1, P.render_at + 0.2));
      prog.querySelector('.track i').style.width = `${pk * 100}%`;
      prog.querySelector('.pct').textContent = `${fmt(Math.round(pk * frames))} / ${fmt(frames)}`;
      flash.style.opacity = ease(seg(t, P.enter, P.enter + 0.06)) * (1 - ease(seg(t, P.enter + 0.06, P.enter + 0.5))) * 0.5
        + ease(seg(t, P.duration - 0.95, P.duration - 0.55));
      term.style.transform = `scale(${1 + 0.05 * ease(seg(t, P.render_at, P.duration))})`;
    },
  };
}
