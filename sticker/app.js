/**
 * 背景透過スタンプメーカー
 *
 * すべての処理はブラウザ内で完結する（画像はサーバーに送信しない）。
 *  - AIで自動: @imgly/background-removal（ONNX / ISNet）を CDN から遅延読み込み
 *  - 色で消す: タップした色を塗りつぶし方式で透過（境界は半透明にしてフチのギザギザを抑える）
 *  - 手直し : 消しゴム / 復元ブラシ（2本指でズーム・移動）
 * 透過情報は「マスク」(0〜255) として元画像とは別に持ち、表示・書き出し時に合成する。
 */

const AI_MODULE_URL = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
const MAX_WORK_SIDE = 1600; // 処理用に縮小する長辺の最大値
const UNDO_LIMIT = 12;
const PRESETS = {
  sticker: { size: 320, limitKB: 512, label: "Discordスタンプ" },
  emoji: { size: 128, limitKB: 256, label: "Discord絵文字" },
  original: { size: 0, limitKB: 0, label: "元サイズ" },
};

const $ = (id) => document.getElementById(id);

// ---------- state ----------
let W = 0, H = 0;
let src = null;        // Uint8ClampedArray RGBA（元画像）
let mask = null;       // Uint8ClampedArray W*H（255=残す, 0=消す）
let disp = null;       // 表示用 ImageData
let srcCanvas = null;  // 元画像（AI入力用）
let fileBaseName = "sticker";
const undoStack = [];

let mode = "ai";       // ai | color | brush
let brushMode = "erase";
let preset = "sticker";
const view = { s: 1, tx: 0, ty: 0 };

const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const viewer = $("viewer");
const stage = $("stage");

// ---------- utils ----------
let toastTimer = 0;
function toast(msg, ms = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function canvasToBlob(c) {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
}

// ---------- load image ----------
async function decodeFile(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadFile(file) {
  if (!file) return;
  let img;
  try {
    img = await decodeFile(file);
  } catch (e) {
    console.error(e);
    toast("この画像は読み込めませんでした。PNGかJPEGで試してみてください。");
    return;
  }
  const iw = img.width, ih = img.height;
  const k = Math.min(1, MAX_WORK_SIDE / Math.max(iw, ih));
  W = Math.max(1, Math.round(iw * k));
  H = Math.max(1, Math.round(ih * k));

  srcCanvas = makeCanvas(W, H);
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, 0, 0, W, H);
  if (img.close) img.close();
  src = sctx.getImageData(0, 0, W, H).data;

  mask = new Uint8ClampedArray(W * H).fill(255);
  undoStack.length = 0;
  updateUndoBtn();

  canvas.width = W;
  canvas.height = H;
  disp = ctx.createImageData(W, H);
  render();

  fileBaseName = (file.name || "sticker").replace(/\.[^.]+$/, "").slice(0, 40) || "sticker";
  $("step-edit").hidden = false;
  $("step-export").hidden = false;
  fitView();
  scheduleExport();
  $("step-edit").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- render ----------
function render(x0 = 0, y0 = 0, x1 = W, y1 = H) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const d = disp.data;
  for (let y = y0; y < y1; y++) {
    let i = y * W + x0;
    let p = i * 4;
    for (let x = x0; x < x1; x++, i++, p += 4) {
      d[p] = src[p];
      d[p + 1] = src[p + 1];
      d[p + 2] = src[p + 2];
      d[p + 3] = (src[p + 3] * mask[i] + 127) / 255;
    }
  }
  ctx.putImageData(disp, 0, 0, x0, y0, x1 - x0, y1 - y0);
}

// ---------- undo ----------
function pushUndo() {
  undoStack.push(mask.slice());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  updateUndoBtn();
}
function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  mask = prev;
  render();
  updateUndoBtn();
  scheduleExport();
}
function updateUndoBtn() {
  $("undo").disabled = undoStack.length === 0;
}

// ---------- view (zoom / pan) ----------
function applyView() {
  stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
}
function fitScale() {
  const r = viewer.getBoundingClientRect();
  return Math.min(r.width / W, r.height / H);
}
function fitView() {
  if (!W) return;
  const r = viewer.getBoundingClientRect();
  view.s = fitScale();
  view.tx = (r.width - W * view.s) / 2;
  view.ty = (r.height - H * view.s) / 2;
  applyView();
}
function toImage(clientX, clientY) {
  const r = viewer.getBoundingClientRect();
  return {
    x: (clientX - r.left - view.tx) / view.s,
    y: (clientY - r.top - view.ty) / view.s,
  };
}
function zoomAt(clientX, clientY, newS) {
  const r = viewer.getBoundingClientRect();
  const fs = fitScale();
  newS = Math.min(Math.max(newS, fs * 0.5), Math.max(fs * 20, 8));
  const mx = clientX - r.left, my = clientY - r.top;
  const ix = (mx - view.tx) / view.s, iy = (my - view.ty) / view.s;
  view.s = newS;
  view.tx = mx - ix * newS;
  view.ty = my - iy * newS;
  applyView();
}

// ---------- color removal ----------
function seedColor(x, y) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const p = (yy * W + xx) * 4;
      r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/**
 * (sx, sy) の色に近い部分を透過する。
 * 許容範囲内は完全に透明、境界の1px（許容範囲の2倍まで）は距離に応じて半透明にする。
 */
function removeColorAt(sx, sy, tol, contiguous) {
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return 0;
  const [cr, cg, cb] = seedColor(sx, sy);
  const N = W * H;
  const dist = (i) => {
    const p = i * 4;
    const dr = src[p] - cr, dg = src[p + 1] - cg, db = src[p + 2] - cb;
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7;
  };
  const hidden = (i) => mask[i] === 0 || src[i * 4 + 3] === 0;
  const filled = new Uint8Array(N);
  let count = 0;

  if (contiguous) {
    const stack = new Int32Array(N);
    let sp = 0;
    const start = sy * W + sx;
    stack[sp++] = start;
    filled[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      count++;
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
      for (let k = 0; k < 4; k++) {
        const j = nb[k];
        if (j < 0 || j >= N || filled[j]) continue;
        if (hidden(j) || dist(j) <= tol) {
          filled[j] = 1;
          stack[sp++] = j;
        }
      }
    }
  } else {
    for (let i = 0; i < N; i++) {
      if (dist(i) <= tol) { filled[i] = 1; count++; }
    }
  }

  // 境界を半透明に（アンチエイリアスの残りカスを軽減）
  const soft = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (filled[i]) continue;
    const x = i % W;
    if ((x > 0 && filled[i - 1]) || (x < W - 1 && filled[i + 1]) ||
        (i >= W && filled[i - W]) || (i < N - W && filled[i + W])) {
      const d = dist(i);
      if (d < tol * 2) soft[i] = Math.round(((d - tol) / tol) * 255);
    }
  }
  for (let i = 0; i < N; i++) {
    if (filled[i]) mask[i] = 0;
    else if (soft[i] >= 0) mask[i] = Math.min(mask[i], soft[i]);
  }
  return count;
}

function autoRemoveCorners() {
  const tol = +$("tol").value;
  const corners = [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]];
  let any = false;
  pushUndo();
  for (const [x, y] of corners) {
    const i = Math.max(0, y) * W + Math.max(0, x);
    if (mask[i] === 0 || src[i * 4 + 3] === 0) continue;
    removeColorAt(Math.max(0, x), Math.max(0, y), tol, true);
    any = true;
  }
  if (!any) {
    undoStack.pop();
    updateUndoBtn();
    toast("四隅はもう透明になっています");
    return;
  }
  render();
  scheduleExport();
}

// ---------- brush ----------
let stroke = null;
function brushRadiusImg() {
  return (+$("brush-size").value / 2) / view.s;
}
function paintDot(cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(H, Math.ceil(cy + r + 1));
  const erase = brushMode === "erase";
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const cov = Math.min(1, Math.max(0, r - Math.sqrt(dx * dx + dy * dy) + 0.5));
      if (cov <= 0) continue;
      const i = y * W + x;
      if (erase) mask[i] = Math.min(mask[i], 255 * (1 - cov));
      else mask[i] = Math.max(mask[i], 255 * cov);
    }
  }
  return [x0, y0, x1, y1];
}
function paintLine(a, b) {
  const r = brushRadiusImg();
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, r / 3)));
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const [x0, y0, x1, y1] = paintDot(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r);
    bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1);
  }
  render(bx0, by0, bx1, by1);
}

// ---------- pointer handling ----------
const pointers = new Map();
let pinch = null;
let tap = null;  // { x, y, moved } 色モードのタップ判定 / 1本指パン
let pan = null;

function updateCursor(e) {
  const cur = $("brush-cursor");
  if (mode !== "brush" || !W || e.pointerType === "touch") { cur.hidden = true; return; }
  const r = viewer.getBoundingClientRect();
  const size = +$("brush-size").value;
  cur.hidden = false;
  cur.style.width = cur.style.height = size + "px";
  cur.style.left = e.clientX - r.left + "px";
  cur.style.top = e.clientY - r.top + "px";
}

viewer.addEventListener("pointerdown", (e) => {
  if (!W) return;
  viewer.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    // 2本指 → ピンチ。描きかけのストロークは取り消す
    if (stroke) {
      const prev = undoStack.pop();
      if (prev) { mask = prev; render(); }
      updateUndoBtn();
      stroke = null;
    }
    tap = null; pan = null;
    const [p1, p2] = [...pointers.values()];
    pinch = {
      d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
      s0: view.s,
      mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2,
      tx0: view.tx, ty0: view.ty,
    };
    return;
  }
  if (pointers.size > 2) return;

  if (mode === "brush") {
    pushUndo();
    const p = toImage(e.clientX, e.clientY);
    stroke = { last: p };
    paintLine(p, p);
  } else {
    tap = { x: e.clientX, y: e.clientY, moved: false };
    pan = { x: e.clientX, y: e.clientY, tx0: view.tx, ty0: view.ty };
  }
});

viewer.addEventListener("pointermove", (e) => {
  updateCursor(e);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const r = viewer.getBoundingClientRect();
    const fs = fitScale();
    const s = Math.min(Math.max(pinch.s0 * d / pinch.d0, fs * 0.5), Math.max(fs * 20, 8));
    const ix = (pinch.mx - r.left - pinch.tx0) / pinch.s0;
    const iy = (pinch.my - r.top - pinch.ty0) / pinch.s0;
    view.s = s;
    view.tx = mx - r.left - ix * s;
    view.ty = my - r.top - iy * s;
    applyView();
    return;
  }
  if (stroke) {
    const p = toImage(e.clientX, e.clientY);
    paintLine(stroke.last, p);
    stroke.last = p;
    return;
  }
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (tap && Math.hypot(dx, dy) > 8) tap.moved = true;
    if (!tap || tap.moved) {
      view.tx = pan.tx0 + dx;
      view.ty = pan.ty0 + dy;
      applyView();
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    return;
  }
  if (stroke) {
    stroke = null;
    scheduleExport();
  }
  if (tap && !tap.moved && mode === "color" && e.type === "pointerup") {
    const p = toImage(tap.x, tap.y);
    if (p.x >= 0 && p.y >= 0 && p.x < W && p.y < H) {
      pushUndo();
      removeColorAt(p.x, p.y, +$("tol").value, $("contiguous").checked);
      render();
      scheduleExport();
    }
  }
  tap = null; pan = null;
}
viewer.addEventListener("pointerup", endPointer);
viewer.addEventListener("pointercancel", endPointer);
viewer.addEventListener("pointerleave", () => ($("brush-cursor").hidden = true));
viewer.addEventListener("wheel", (e) => {
  if (!W) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, view.s * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
// iOS Safari のページ拡大ジェスチャーを抑止（キャンバス上のみ）
viewer.addEventListener("gesturestart", (e) => e.preventDefault());

// ---------- AI ----------
let aiModule = null;
async function runAI() {
  if (!W) return;
  const btn = $("ai-run");
  const prog = $("ai-progress");
  const fill = $("ai-progress-fill");
  const text = $("ai-progress-text");
  btn.disabled = true;
  prog.hidden = false;
  fill.style.width = "0%";
  text.textContent = "AIを準備中…";
  try {
    if (!aiModule) aiModule = await import(AI_MODULE_URL);
    const input = await canvasToBlob(srcCanvas);
    const model = $("ai-model").value;
    const result = await aiModule.removeBackground(input, {
      model,
      output: { format: "image/png" },
      progress: (key, current, total) => {
        if (key.startsWith("fetch")) {
          const pct = total ? Math.round((current / total) * 100) : 0;
          fill.style.width = pct + "%";
          text.textContent = `AIモデルを読み込み中… ${pct}%（初回のみ）`;
        } else if (key.startsWith("compute")) {
          fill.style.width = "100%";
          text.textContent = "背景を解析中…";
        }
      },
    });
    const bmp = await createImageBitmap(result);
    const tmp = makeCanvas(W, H);
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(bmp, 0, 0, W, H);
    const out = tctx.getImageData(0, 0, W, H).data;
    pushUndo();
    for (let i = 0, p = 3; i < W * H; i++, p += 4) mask[i] = out[p];
    render();
    scheduleExport();
    text.textContent = "完了！ 気になる所は「手直し」で調整できます。";
    fill.style.width = "100%";
  } catch (e) {
    console.error(e);
    text.textContent = "AIの処理に失敗しました。通信環境を確認するか、「色で消す」を試してください。";
    fill.style.width = "0%";
  } finally {
    btn.disabled = false;
  }
}

// ---------- export ----------
function contentBBox(threshold = 8) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    let i = y * W;
    for (let x = 0; x < W; x++, i++) {
      if ((src[i * 4 + 3] * mask[i]) / 255 > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 縮小は半分ずつ段階的に行い、ジャギーを抑える */
function scaledCrop(source, sx, sy, sw, sh, dw, dh) {
  let cur = makeCanvas(sw, sh);
  cur.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  let cw = sw, ch = sh;
  while (cw / 2 >= dw && ch / 2 >= dh) {
    const next = makeCanvas(cw / 2, ch / 2);
    const nctx = next.getContext("2d");
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next; cw = next.width; ch = next.height;
  }
  const out = makeCanvas(dw, dh);
  const octx = out.getContext("2d");
  octx.imageSmoothingQuality = "high";
  octx.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

/** 1次元の二乗距離変換（Felzenszwalb & Huttenlocher） */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** 不透明部分からの距離（ユークリッド距離変換）でフチ取りレイヤーを作る */
function drawWithOutline(octx, piece, x, y, width, color) {
  const cw = octx.canvas.width, ch = octx.canvas.height;
  if (width > 0) {
    const tmp = makeCanvas(cw, ch);
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(piece, x, y);
    const img = tctx.getImageData(0, 0, cw, ch);
    const px = img.data;
    const BIG = 1e10;
    const n = Math.max(cw, ch);
    const f = new Float64Array(n), d = new Float64Array(n);
    const v = new Int32Array(n), z = new Float64Array(n + 1);
    const dist = new Float64Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) dist[i] = px[i * 4 + 3] >= 128 ? 0 : BIG;
    for (let xx = 0; xx < cw; xx++) {
      for (let yy = 0; yy < ch; yy++) f[yy] = dist[yy * cw + xx];
      edt1d(f, ch, d, v, z);
      for (let yy = 0; yy < ch; yy++) dist[yy * cw + xx] = d[yy];
    }
    for (let yy = 0; yy < ch; yy++) {
      const row = yy * cw;
      for (let xx = 0; xx < cw; xx++) f[xx] = dist[row + xx];
      edt1d(f, cw, d, v, z);
      for (let xx = 0; xx < cw; xx++) dist[row + xx] = d[xx];
    }
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    for (let i = 0, p = 0; i < cw * ch; i++, p += 4) {
      const cov = Math.min(1, Math.max(0, width + 0.5 - Math.sqrt(dist[i])));
      const a = Math.max(cov * 255, px[p + 3]);
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = a;
    }
    tctx.putImageData(img, 0, 0);
    octx.drawImage(tmp, 0, 0);
  }
  octx.drawImage(piece, x, y);
}

async function buildExport() {
  const bb = contentBBox();
  if (!bb) return null;
  const marginPct = +$("margin").value / 100;
  const outlineOn = $("outline-on").checked;
  const outlineColor = $("outline-color").value;
  const p = PRESETS[preset];

  let outW, outH, dw, dh, ow;
  if (p.size) {
    const S = p.size;
    ow = outlineOn ? Math.max(1, (+$("outline-width").value * S) / 320) : 0;
    const box = S * (1 - 2 * marginPct) - 2 * ow;
    const k = box / Math.max(bb.w, bb.h);
    dw = Math.max(1, Math.round(bb.w * k));
    dh = Math.max(1, Math.round(bb.h * k));
    outW = outH = S;
  } else {
    const big = Math.max(bb.w, bb.h);
    ow = outlineOn ? Math.max(1, Math.round((+$("outline-width").value * big) / 320)) : 0;
    const pad = Math.round(big * marginPct) + Math.ceil(ow);
    dw = bb.w; dh = bb.h;
    outW = bb.w + pad * 2;
    outH = bb.h + pad * 2;
  }

  const piece = scaledCrop(canvas, bb.x, bb.y, bb.w, bb.h, dw, dh);
  const out = makeCanvas(outW, outH);
  const octx = out.getContext("2d");
  drawWithOutline(octx, piece, Math.round((outW - dw) / 2), Math.round((outH - dh) / 2), ow, outlineColor);
  const blob = await canvasToBlob(out);
  return { canvas: out, blob };
}

let exportTimer = 0;
let exportSeq = 0;
let lastExport = null;
let chatUrl = null;
function scheduleExport() {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(refreshExport, 250);
}
async function refreshExport() {
  if (!W) return;
  const seq = ++exportSeq;
  const res = await buildExport();
  if (seq !== exportSeq) return;
  const info = $("size-info");
  const oc = $("out-canvas");
  lastExport = res;
  if (!res) {
    oc.width = oc.height = 1;
    info.textContent = "画像がすべて消えています。「元に戻す」で戻してください。";
    info.classList.add("warn");
    $("download").disabled = $("share").disabled = true;
    return;
  }
  oc.width = res.canvas.width;
  oc.height = res.canvas.height;
  oc.getContext("2d").drawImage(res.canvas, 0, 0);
  if (chatUrl) URL.revokeObjectURL(chatUrl);
  chatUrl = URL.createObjectURL(res.blob);
  $("chat-dark").src = $("chat-light").src = chatUrl;

  const p = PRESETS[preset];
  const kb = res.blob.size / 1024;
  const sizeText = `${res.canvas.width}×${res.canvas.height}px ・ ${kb.toFixed(kb < 10 ? 1 : 0)}KB`;
  if (p.limitKB && kb > p.limitKB) {
    info.textContent = `${sizeText}：${p.label}の上限 ${p.limitKB}KB を超えています。余白を増やすかフチ取りを外してみてください。`;
    info.classList.add("warn");
  } else {
    info.textContent = p.limitKB ? `${sizeText}（${p.label}の上限 ${p.limitKB}KB 以内 ✓）` : sizeText;
    info.classList.remove("warn");
  }
  $("download").disabled = $("share").disabled = false;
}

function exportFileName() {
  const suffix = preset === "original" ? "transparent" : `${preset}_${PRESETS[preset].size}`;
  return `${fileBaseName}_${suffix}.png`;
}

function download() {
  if (!lastExport) return;
  const url = URL.createObjectURL(lastExport.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function share() {
  if (!lastExport) return;
  const file = new File([lastExport.blob], exportFileName(), { type: "image/png" });
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    if (e.name !== "AbortError") toast("共有できませんでした。「PNGを保存」を使ってください。");
  }
}

// ---------- UI wiring ----------
$("file-input").addEventListener("change", (e) => {
  loadFile(e.target.files[0]);
  e.target.value = "";
});

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    mode = t.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.dataset.panel !== mode));
    viewer.classList.toggle("mode-color", mode === "color");
    viewer.classList.toggle("mode-brush", mode === "brush");
    if (mode !== "brush") $("brush-cursor").hidden = true;
  })
);

document.querySelectorAll("[data-brush]").forEach((b) =>
  b.addEventListener("click", () => {
    brushMode = b.dataset.brush;
    document.querySelectorAll("[data-brush]").forEach((x) => x.classList.toggle("active", x === b));
  })
);

document.querySelectorAll("[data-bg]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-bg]").forEach((x) => x.classList.toggle("active", x === b));
    viewer.classList.remove("bg-checker", "bg-dark", "bg-light");
    viewer.classList.add("bg-" + b.dataset.bg);
  })
);

document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    preset = b.dataset.preset;
    document.querySelectorAll("[data-preset]").forEach((x) => x.classList.toggle("active", x === b));
    scheduleExport();
  })
);

const bindOutput = (inputId, outId, onChange) => {
  const input = $(inputId);
  const sync = () => {
    $(outId).textContent = input.value;
    if (onChange) onChange();
  };
  input.addEventListener("input", sync);
  sync();
};
bindOutput("tol", "tol-val");
bindOutput("brush-size", "brush-val");
bindOutput("margin", "margin-val", scheduleExport);
bindOutput("outline-width", "outline-val", scheduleExport);
$("outline-color").addEventListener("input", scheduleExport);
$("outline-on").addEventListener("change", () => {
  $("outline-opts").hidden = !$("outline-on").checked;
  scheduleExport();
});

$("ai-run").addEventListener("click", runAI);
$("auto-edge").addEventListener("click", () => W && autoRemoveCorners());
$("undo").addEventListener("click", undo);
$("reset-view").addEventListener("click", fitView);
$("reset-mask").addEventListener("click", () => {
  if (!W) return;
  pushUndo();
  mask.fill(255);
  render();
  scheduleExport();
});
$("invert-mask").addEventListener("click", () => {
  if (!W) return;
  pushUndo();
  for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
  render();
  scheduleExport();
});
$("download").addEventListener("click", download);
$("share").addEventListener("click", share);

// Web Share API でファイル共有できる端末（主にスマホ）だけ「共有」ボタンを出す
try {
  const probe = new File([new Blob()], "x.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [probe] })) $("share").hidden = false;
} catch (e) { /* not supported */ }

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitView, 150);
});
