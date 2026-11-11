export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));        // 区間 [a,b] を 0→1 に
export const ease = (x) => x * x * (3 - 2 * x);
export const easeOut = (x) => 1 - (1 - x) ** 3;
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const fade = (t, a, b, d = 0.6) => ease(seg(t, a, a + d)) * (1 - ease(seg(t, b - d, b))); // 出て消える

export const fetchJson = async (url) => (await fetch(url)).json();
export const fetchBin = async (url, Type = Uint8Array) => new Type(await (await fetch(url)).arrayBuffer());

export function el(parent, cls, html = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent.appendChild(d);
  return d;
}
export const fmt = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
