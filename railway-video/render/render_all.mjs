// 全シーンを区間ごとに書き出し、BGM と結合して 1 本の動画にする。
//   node render/render_all.mjs [--workers 3] [--chunk 5] [--only plan,design] [--credit 制作者名 --variant 名前]
// --credit はプロローグと結びに表示する制作者名（既定は Claude）。--variant を付けると出力が out/railway_ai_<名前>.mp4 になる。
// 区間ファイル（out/seg/）が残っていれば飛ばすので、途中で止まっても続きから再開できる。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WORKERS = Number(arg('workers', 3)), CHUNK = Number(arg('chunk', 5));
const only = arg('only', '').split(',').filter(Boolean);
const credit = arg('credit', ''), variant = arg('variant', '');
const CREDIT_SCENES = ['prologue', 'ending'];          // 制作者名が画面に出るシーン（variant ごとに別ファイル）
const segName = (scene, a) => `out/seg/${scene}${variant && CREDIT_SCENES.includes(scene) ? `_${variant}` : ''}_${String(a).padStart(3, '0')}.mp4`;
const query = (scene) => (credit && CREDIT_SCENES.includes(scene) ? ['--query', `&credit=${encodeURIComponent(credit)}`] : []);
const timeline = JSON.parse(readFileSync(path.join(ROOT, 'render/timeline.json'), 'utf8'));
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
});
mkdirSync(path.join(ROOT, 'out/seg'), { recursive: true });
mkdirSync(path.join(ROOT, 'web/assets'), { recursive: true });

// 0. 結びの場面で使う各章の代表カット
const TILES = { plan: 21, design: 37, build: 20, tunnel: 23, research: 20 };
for (const [scene, t] of Object.entries(TILES)) {
  const jpg = `web/assets/${scene}.jpg`;
  if (existsSync(path.join(ROOT, jpg)) && !process.argv.includes('--tiles')) continue;
  await run('node', ['render/capture.mjs', '--scene', scene, '--t', String(t), '--out', `out/_tile_${scene}.png`]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `out/_tile_${scene}.png`, '-vf', 'scale=960:540', '-q:v', '3', jpg]);
  console.log(`代表カット ${jpg}`);
}

// 1. 区間ごとの書き出し（並列）
const jobs = [];
for (const { scene, duration } of timeline) {
  if (only.length && !only.includes(scene)) continue;
  for (let a = 0; a < duration; a += CHUNK) {
    const b = Math.min(duration, a + CHUNK), file = segName(scene, a);
    if (existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).size > 1000) continue;
    jobs.push({ scene, a, b, file });
  }
}
console.log(`書き出す区間: ${jobs.length}（並列 ${WORKERS}）`);
const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  for (let j = jobs.shift(); j; j = jobs.shift()) {
    const tmp = j.file.replace('.mp4', '.part.mp4');
    await run('node', ['render/capture.mjs', '--scene', j.scene, '--from', String(j.a), '--to', String(j.b), '--out', tmp, ...query(j.scene)]);
    renameSync(path.join(ROOT, tmp), path.join(ROOT, j.file));
    console.log(`${j.file}  (${++done} 完了、残り ${jobs.length}、経過 ${((Date.now() - t0) / 60000).toFixed(1)} 分)`);
  }
}));

// 2. 結合（映像は無劣化で連結、BGM を重ねる）
if (!only.length) {
  const list = timeline.flatMap(({ scene, duration }) =>
    Array.from({ length: Math.ceil(duration / CHUNK) }, (_, i) => `file '${segName(scene, i * CHUNK).replace('out/', '')}'`));
  const final = `out/railway_ai${variant ? `_${variant}` : ''}.mp4`;
  writeFileSync(path.join(ROOT, 'out/concat.txt'), list.join('\n'));
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'out/concat.txt', '-i', 'out/music.wav',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', final]);
  console.log(`${final} を書き出しました`);
}
