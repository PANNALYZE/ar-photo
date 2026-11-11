// シーンを決定論的に描画して静止画／連番フレームを書き出す。
//   静止画: node render/capture.mjs --scene design --t 12 --out out/design.png
//   動画  : node render/capture.mjs --scene design --from 0 --to 40 --out out/design.mp4
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('scene', 'design');
const fps = Number(arg('fps', 30));
const W = Number(arg('w', 1920)), H = Number(arg('h', 1080));
const out = arg('out', `out/${scene}.png`);

const server = await startServer();
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log(`[page] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/web/scene.html?scene=${scene}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const frame = async (t) => {
  await page.evaluate(async (tt) => { await window.__render(tt); await document.fonts.ready; }, t);
};

if (out.endsWith('.mp4')) {
  const from = Number(arg('from', 0));
  const to = Number(arg('to', await page.evaluate(() => window.__duration)));
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps),
    '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await frame(from + i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 97 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 30 === 0) console.log(`${scene} ${i}/${n} フレーム  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
} else {
  const t0 = Date.now();
  await frame(Number(arg('t', 0)));
  await page.screenshot({ path: out });
  console.log(`${out} （描画 ${Date.now() - t0}ms）`);
}
await browser.close();
server.close();
