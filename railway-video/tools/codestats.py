"""この動画を作っているコードの量を数える（結びの場面で表示する）。

  python3 tools/codestats.py [--started 2026-01-01T00:00:00Z] [--pad 10]  →  web/assets/codestats.json
--started には制作（対話）を始めた時刻を渡す。一度渡せば保存され、以後は経過時間だけ更新される。
--pad は、このあとの書き出しにかかる見込みの分数（完成時刻までの経過時間として表示するため）。
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'web', 'assets', 'codestats.json')
LANG = {'.py': 'Python', '.js': 'JavaScript', '.mjs': 'JavaScript', '.css': 'CSS / HTML', '.html': 'CSS / HTML'}
WALL = ['engine/fem3d.py', 'engine/topopt3d.py', 'web/scenes/design.js', 'engine/route.py', 'web/lib/isosurface.js',
        'engine/erection.py', 'engine/tunnel.py', 'engine/discovery.py', 'tools/music.py', 'web/scenes/plan.js']


def main():
    files = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True).stdout.split('\n')
    by, rows = {}, []
    for f in files:
        ext = os.path.splitext(f)[1]
        if ext not in LANG or not os.path.exists(os.path.join(ROOT, f)):
            continue
        n = sum(1 for _ in open(os.path.join(ROOT, f), encoding='utf-8'))
        by[LANG[ext]] = by.get(LANG[ext], 0) + n
        rows.append((f, n))
    prev = json.load(open(OUT)) if os.path.exists(OUT) else {}
    started = sys.argv[sys.argv.index('--started') + 1] if '--started' in sys.argv else prev.get('started')
    stats = dict(total=sum(by.values()), files=len(rows), by_lang=by, wall=WALL, started=started)
    if started:
        dt = datetime.now(timezone.utc) - datetime.fromisoformat(started.replace('Z', '+00:00'))
        pad = int(sys.argv[sys.argv.index('--pad') + 1]) if '--pad' in sys.argv else 0
        stats['elapsed_min'] = int(dt.total_seconds() // 60) + pad
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(stats, open(OUT, 'w'), ensure_ascii=False, indent=1)
    print(f"コード {stats['total']:,} 行 / {stats['files']} ファイル  {by}"
          + (f"  経過 {stats['elapsed_min'] // 60}時間{stats['elapsed_min'] % 60}分" if started else ''))


if __name__ == '__main__':
    main()
