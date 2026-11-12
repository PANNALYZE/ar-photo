# 鉄道構造物 × AI デモ動画

鉄道構造物の計画・設計・施工・維持管理・技術開発の「次の実務」を見せる約3分の動画です。
画面に出る解析結果は、すべてこのディレクトリのコードが実際に計算したものです（条件は架空）。

完成版は `dist/railway_ai.mp4`（1920×1080・30fps・193秒）です。

| 章 | 内容 | エンジン | シーン |
|---|---|---|---|
| 00 導入 | 夜の線路 | – | `web/scenes/opening.js` |
| 01 計画 | 生成的ルート探索（進化計算＋縦断の動的計画法） | `engine/route.py` | `plan.js` |
| 02 設計 | 位相最適化 × 3次元FEM によるジェネレーティブデザイン | `engine/fem3d.py` `topopt3d.py` `viaduct.py` | `design.js` |
| 03 施工 | 夜間桁架設のデジタルリハーサル（離散事象シミュレーション＋モンテカルロ） | `engine/erection.py` | `build.js` |
| 04 維持管理 | トンネル覆工のひび割れ検出と進行予測 | `engine/tunnel.py` | `tunnel.js` |
| 05 技術開発 | ベイズ最適化による制振装置の自律探索 | `engine/discovery.py` | `research.js` |
| 06 結び | – | – | `ending.js` |

## 作り方

```bash
npm install                      # three.js とフォント
pip install numpy scipy pyamg scikit-image

# 1. 解析（data/ に結果を書き出す）
python3 engine/route.py          # 約1.5分
python3 engine/erection.py
python3 engine/tunnel.py
python3 engine/discovery.py      # 約2分
(cd engine && python3 viaduct.py 0.6 ../data/viaduct)   # 約20分。結果は data/viaduct_stage*.npz に同梱済み
python3 tools/design_post.py     # 最終形状の再解析と描画用データ（約3分）

# 2. BGM と映像
python3 tools/music.py           # out/music.wav
node render/render_all.mjs       # out/railway_ai.mp4（区間ごとに書き出し、中断しても再開できる）
```

1カットだけ確認するとき：

```bash
node render/capture.mjs --scene design --t 29 --out out/design.png
node render/server.mjs           # ブラウザで /web/scene.html?scene=plan&play=1
```

## 検証

```bash
python3 engine/test_fem3d.py                 # 3次元FEM：パッチテスト、片持ち梁の理論解への収束
node --test web/lib/isosurface.test.mjs      # 等値面メッシュ：球の体積と法線
```

各エンジンは実行時に照合結果を表示します（例：`discovery.py` は調和加振の古典解と、列車走行の総当たり結果）。

## 前提と限界

- 地形・荷重・単価・作業時間・検査記録はすべてデモ用の架空値、または合成データです。
- 設計章の比較は線形弾性解析による剛性（コンプライアンス）のみで、設計標準に基づく照査ではありません。
  比較相手の従来型ラーメン高架橋は、同体積になるよう本コードが生成したものです。
- 技術開発章の桁は1次モードのみの簡易モデルです。
