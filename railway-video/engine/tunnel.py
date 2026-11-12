"""維持管理章：トンネル覆工の変状検出と進行予測（すべて合成データ）。

1. 覆工の展開画像（合成）にひび割れを描き込み、線状構造フィルタで自動検出して正解と照合する
2. 過去6回の検査で測ったひび割れ幅（合成）から進行速度を推定し、
   5年以内に対策が必要な幅を超える確率を求めて補修の優先順位を付ける

  python3 engine/tunnel.py  →  data/tunnel/
"""
import json
import os
from math import erf, sqrt
import numpy as np
from scipy import ndimage
from skimage import draw, filters, morphology
from skimage.io import imsave

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'tunnel')
L, R, HALF_ARC = 180.0, 4.8, 9.2          # 延長 [m]、覆工半径 [m]、天端から脚部までの弧長 [m]
PX = 0.04                                 # 展開画像の画素寸法 [m]
YEARS = np.array([0, 2, 4, 6, 8, 10.0])   # 検査年（10 が現在）
THRESH, SIGMA_MEAS = 1.0, 0.04            # 要対策のひび割れ幅 [mm]、計測誤差 [mm]
JOINT = 10.5                              # 打継目の間隔 [m]
MIN_SIZE = 150                            # これより小さい検出片はノイズとして捨てる [画素]
THRESH_RIDGE = 0.015                      # 線状構造フィルタのしきい値


def make_cracks(rng, n=46):
    cracks = []
    for i in range(n):
        kind = rng.choice(['縦断', '横断', '斜め'], p=[0.4, 0.3, 0.3])
        if kind == '縦断':
            s, u, ang, length = rng.uniform(5, L - 20), rng.normal(0, 2.2), rng.normal(0, 0.12), rng.uniform(4, 15)
        elif kind == '横断':
            s = round(rng.uniform(1, L / JOINT - 1)) * JOINT + rng.normal(0, 0.6)
            u, ang, length = rng.uniform(-6, 2), np.pi / 2 + rng.normal(0, 0.15), rng.uniform(2, 7)
        else:
            s, u = rng.uniform(5, L - 10), rng.choice([-1, 1]) * rng.uniform(2.5, 6.5)
            ang, length = rng.choice([-1, 1]) * rng.uniform(0.5, 1.0), rng.uniform(2, 6)
        pts = [(s, u)]
        for _ in range(int(length / 0.25)):
            ang += rng.normal(0, 0.11)
            s, u = s + 0.25 * np.cos(ang), u + 0.25 * np.sin(ang)
            if not (0.5 < s < L - 0.5 and abs(u) < HALF_ARC - 0.4):
                break
            pts.append((s, u))
        active = rng.random() < 0.32
        w0 = float(np.clip(rng.lognormal(np.log(0.22), 0.45), 0.08, 0.6))
        rate = float(rng.uniform(0.025, 0.085) if active else abs(rng.normal(0, 0.006)))
        cracks.append(dict(id=i + 1, kind=str(kind), pts=np.round(pts, 3).tolist(), w0=w0, rate=rate, active=bool(active)))
    return cracks


def lining_image(cracks, rng):
    """覆工の展開画像（濃淡）と、ひび割れの正解マスクを作る。"""
    h, w = int(2 * HALF_ARC / PX), int(L / PX)
    base = 0.62 + 0.05 * ndimage.gaussian_filter(rng.standard_normal((h, w)), 40) / 0.012
    base += 0.03 * ndimage.gaussian_filter(rng.standard_normal((h, w)), 4) / 0.07 + 0.025 * rng.standard_normal((h, w))
    for k in range(1, int(L / JOINT) + 1):                 # 打継目
        c = int(k * JOINT / PX)
        base[:, c - 1:c + 1] -= 0.10
    for _ in range(26):                                    # 漏水跡・汚れ（縦に流れる筋）
        c, r0 = rng.integers(40, w - 40), rng.integers(0, h // 2)
        ln, wd = rng.integers(60, 220), rng.integers(6, 22)
        stain = np.zeros((h, w))
        stain[r0:r0 + ln, c - wd // 2:c + wd // 2] = 1
        base -= 0.11 * ndimage.gaussian_filter(stain, (18, 5))
    truth = np.zeros((h, w), bool)
    img = np.clip(base, 0, 1)
    for c in cracks:
        w_now = c['w0'] + c['rate'] * YEARS[-1]
        m = np.zeros((h, w))
        p = np.array(c['pts'])
        rr, cc = (p[:, 1] + HALF_ARC) / PX, p[:, 0] / PX
        for a in range(len(p) - 1):
            r_, c_, v = draw.line_aa(int(rr[a]), int(cc[a]), int(rr[a + 1]), int(cc[a + 1]))
            ok = (r_ >= 0) & (r_ < h) & (c_ >= 0) & (c_ < w)
            m[r_[ok], c_[ok]] = np.maximum(m[r_[ok], c_[ok]], v[ok])
            truth[r_[ok], c_[ok]] |= v[ok] > 0.5
        img -= np.clip(0.16 + 0.32 * w_now, 0, 0.5) * ndimage.gaussian_filter(m, 0.6)   # 幅が広いほど濃く写る
    return np.clip(img, 0, 1), truth


def detect(img, truth, cracks):
    """線状構造フィルタでひび割れを抽出し、正解と照合する。"""
    ridge = filters.sato(img, sigmas=[1.0, 1.6], black_ridges=True)
    mask = ridge > THRESH_RIDGE
    for k in range(1, int(L / JOINT) + 1):                 # 位置が分かっている打継目は検出対象から外す
        c = int(k * JOINT / PX)
        mask[:, c - 4:c + 5] = False
    mask = morphology.remove_small_objects(mask, max_size=MIN_SIZE)
    near_det = ndimage.binary_dilation(mask, iterations=3)
    near_truth = ndimage.binary_dilation(truth, iterations=4)
    h, w = img.shape
    hit = 0
    for c in cracks:
        p = np.array(c['pts'])
        rr = np.clip(((p[:, 1] + HALF_ARC) / PX).astype(int), 0, h - 1)
        cc = np.clip((p[:, 0] / PX).astype(int), 0, w - 1)
        c['found'] = float(near_det[rr, cc].mean())
        c['detected'] = bool(c['found'] >= 0.6)
        hit += c['detected']
    precision = float((mask & near_truth).sum() / max(mask.sum(), 1))
    return mask, dict(recall=hit / len(cracks), precision=precision, n=len(cracks), n_detected=int(hit))


def forecast(cracks, rng):
    """検査履歴から進行速度を推定（全体の傾向へ寄せる経験ベイズ）し、5年後・10年後を予測する。"""
    t = YEARS
    tb, sxx, n = t.mean(), ((t - t.mean()) ** 2).sum(), len(t)
    for c in cracks:
        c['widths'] = (c['w0'] + c['rate'] * t + rng.normal(0, SIGMA_MEAS, n)).round(3).tolist()
    y = np.array([c['widths'] for c in cracks])
    b = ((t - tb) * (y - y.mean(1, keepdims=True))).sum(1) / sxx
    a = y.mean(1) - b * tb
    s2 = float((((y - a[:, None] - b[:, None] * t) ** 2).sum(1) / (n - 2)).mean())
    var_b = s2 / sxx
    tau2 = max(b.var() - var_b, 1e-8)
    for i, c in enumerate(cracks):
        # 進行中か休止中かの見極め：個別の傾きを全体平均へ縮約
        k = tau2 / (tau2 + var_b)
        bi = b.mean() + k * (b[i] - b.mean())
        ai = y[i].mean() - bi * tb
        pred = {}
        for hzn in (5, 10):
            tt = t[-1] + hzn
            mean = ai + bi * tt
            sd = sqrt(s2 * (1 + 1 / n) + (tt - tb) ** 2 * var_b * k)
            pred[str(hzn)] = dict(mean=float(mean), lo=float(mean - 1.645 * sd), hi=float(mean + 1.645 * sd),
                                  p_exceed=float(0.5 * (1 - erf((THRESH - mean) / (sd * sqrt(2))))))
        crown = max(0.0, 1 - abs(np.mean([p[1] for p in c['pts']])) / 4.0)        # 天端に近いほど重く見る
        c.update(fit=dict(a=float(ai), b=float(bi)), pred=pred, score=float(pred['5']['p_exceed'] * (1 + 0.6 * crown)))
        c['true_10'] = float(c['w0'] + c['rate'] * (t[-1] + 10))
    cover = float(np.mean([c['pred']['10']['lo'] <= c['true_10'] <= c['pred']['10']['hi'] for c in cracks]))
    return dict(noise_sd=sqrt(s2), coverage_10y=cover)


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(5)
    cracks = make_cracks(rng)
    img, truth = lining_image(cracks, rng)
    mask, det = detect(img, truth, cracks)
    fc = forecast(cracks, rng)
    ranked = sorted(cracks, key=lambda c: -c['score'])
    for r, c in enumerate(ranked):
        c['rank'] = r + 1
    # 描画用の覆工テクスチャ（展開画像を縮小）と検出マスク
    small = ndimage.zoom(img, 0.5, order=1)
    rgb = np.stack([small * 0.93, small * 0.95, small], -1)
    imsave(os.path.join(OUT, 'lining.png'), (np.clip(rgb, 0, 1) * 255).astype(np.uint8), check_contrast=False)
    imsave(os.path.join(OUT, 'detected.png'), (ndimage.zoom(mask.astype(float), 0.5, order=1) > 0.3).astype(np.uint8) * 255, check_contrast=False)
    meta = dict(L=L, R=R, half_arc=HALF_ARC, years=YEARS.tolist(), thresh=THRESH, joint=JOINT, detection=det, forecast=fc,
                total_length=float(sum(0.25 * (len(c['pts']) - 1) for c in cracks)),
                n_now=int(sum(c['widths'][-1] >= THRESH for c in cracks)),
                n_soon=int(sum(c['widths'][-1] < THRESH and c['pred']['5']['p_exceed'] > 0.5 for c in cracks)), cracks=cracks)
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False)
    print(f"ひび割れ {det['n']} 本（総延長 {meta['total_length']:.0f} m） 検出 {det['n_detected']} 本  再現率 {det['recall'] * 100:.0f}%  適合率 {det['precision'] * 100:.0f}%")
    print(f"計測誤差の推定 {fc['noise_sd']:.3f} mm（設定 {SIGMA_MEAS}）  10年後予測の90%区間に真値が入った割合 {fc['coverage_10y'] * 100:.0f}%")
    print(f"現時点で {THRESH} mm 以上: {meta['n_now']} 本 ／ 今は基準内だが5年以内に超える見込み: {meta['n_soon']} 本")
    for c in ranked[:5]:
        print(f"  {c['rank']}位 No.{c['id']:2d} {c['kind']} 現在 {c['widths'][-1]:.2f} mm → 5年後 {c['pred']['5']['mean']:.2f} mm  超過確率 {c['pred']['5']['p_exceed'] * 100:.0f}%")


if __name__ == '__main__':
    main()
