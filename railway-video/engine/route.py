"""計画章：生成的ルート探索（架空の地形・架空の単価）。

A駅〜B駅を結ぶ線形案を進化計算（NSGA-II 型）で大量に生成し、
「建設コスト指数」と「環境・用地への影響指数」の2目的でパレート解を求める。
平面線形は制御点を通る3次スプライン、縦断は勾配制限つきの動的計画法で各案ごとに最適化する。

  python3 engine/route.py   →  data/plan/
"""
import json
import os
import numpy as np
from scipy.interpolate import CubicSpline
from scipy import ndimage

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'plan')
LX, LY, CELL = 16000.0, 8000.0, 40.0           # 対象範囲 16km × 8km、格子 40m
A, B = (1400.0, 4300.0), (14700.0, 3900.0)     # 起終点
K = 7                                          # 平面線形の自由な制御点の数
R_MIN, G_MAX = 2500.0, 0.020                   # 最小曲線半径 [m]、最急勾配
DS, DZ = 100.0, 2.0                            # 縦断DPの刻み（距離・高さ）
TYPES = ['土工', '高架橋', '橋りょう', 'トンネル']


def fbm(shape, rng, octaves=6, base=4):
    """フラクタルノイズ（低解像度の乱数格子を拡大して重ねる）。"""
    out = np.zeros(shape)
    for o in range(octaves):
        n = base * 2 ** o
        g = rng.standard_normal((n + 3, 2 * n + 3))
        out += ndimage.zoom(g, (shape[0] / (n + 3), shape[1] / (2 * n + 3)), order=3)[:shape[0], :shape[1]] / 2 ** o
    return out


def make_terrain(seed=7):
    rng = np.random.default_rng(seed)
    ny, nx = int(LY / CELL) + 1, int(LX / CELL) + 1
    y, x = np.meshgrid(np.linspace(0, LY, ny), np.linspace(0, LX, nx), indexing='ij')
    n1, n2 = fbm((ny, nx), rng), fbm((ny, nx), rng, octaves=5, base=3)
    # 山地：東寄りの南北に延びる山並み。北側に低い鞍部（峠）がある
    ridge = np.exp(-((x - 10300 - 900 * np.sin(y / 2300)) / 1700) ** 2)
    saddle = 1 - 0.62 * np.exp(-((y - 6500) / 900) ** 2)
    mountain = 330 * ridge * saddle * (1 + 0.28 * n1) + 70 * ridge * np.abs(n2)
    plain = 12 + 6 * n2 + 45 / (1 + np.exp(-(x - 12500) / 700))            # 西は低地、東は盆地（+45m）
    # 河川：南北に蛇行
    xr = 5100 + 650 * np.sin(y / 1500) + 250 * np.sin(y / 520 + 1)
    river_d = np.abs(x - xr)
    z = plain + mountain + 9 * n1 * (1 - ridge)
    z -= 9 * np.exp(-(river_d / 420) ** 2)
    river = river_d < 190
    z[river] = np.minimum(z[river], 3.0)
    z = ndimage.gaussian_filter(z, 1.2)
    z = np.where(z < 4, 2 + 2 * np.exp((z - 4) / 2), z)        # 窪地はなだらかに底上げ（完全な平面は作らない）
    # 市街地の密度（0..1）と保全区域
    blobs = [(1400, 4300, 1500, 1.0), (3300, 2700, 800, 0.7), (3000, 6200, 700, 0.6),
             (14700, 3900, 1100, 0.9), (13300, 5600, 600, 0.6), (6900, 5200, 520, 0.55), (7300, 1700, 450, 0.5)]
    urban = np.zeros_like(z)
    for bx, by, r, a in blobs:
        urban = np.maximum(urban, a * np.exp(-(((x - bx) ** 2 + (y - by) ** 2) / r ** 2)))
    urban *= (ridge < 0.35) & ~river
    protected = (((x - 6500) / 1050) ** 2 + ((y - 3700) / 800) ** 2 < 1) | (((x - 11800) / 700) ** 2 + ((y - 6700) / 900) ** 2 < 1)
    return dict(z=z, urban=urban, protected=protected.astype(float), river=river.astype(float), x=x, y=y)


class Evaluator:
    def __init__(self, T):
        self.T = T
        self.xk = np.linspace(A[0], B[0], K + 2)

    def sample(self, name, x, y):
        return ndimage.map_coordinates(self.T[name], [y / CELL, x / CELL], order=1, mode='nearest')

    def plan(self, yk):
        """制御点 → 平面線形（等間隔 DS の点列）と最小曲線半径。"""
        cs = CubicSpline(self.xk, np.concatenate([[A[1]], yk, [B[1]]]), bc_type=((1, 0.0), (1, 0.0)))
        xf = np.linspace(A[0], B[0], 800)
        d1, d2 = cs(xf, 1), cs(xf, 2)
        radius = np.min((1 + d1 ** 2) ** 1.5 / np.maximum(np.abs(d2), 1e-9))
        s = np.concatenate([[0], np.cumsum(np.hypot(np.diff(xf), np.diff(cs(xf))))])
        st = np.arange(0, s[-1], DS)
        xs = np.interp(st, s, xf)
        return xs, cs(xs), st, radius

    def evaluate(self, yk, full=False):
        xs, ys, st, radius = self.plan(yk)
        g = self.sample('z', xs, ys)
        urban, prot, river = (self.sample(n, xs, ys) for n in ('urban', 'protected', 'river'))
        river = river > 0.3
        zl = np.arange(0.0, 420.0, DZ)                      # 軌道高さの候補
        h = zl[None, :] - g[:, None]                        # (測点, 高さ)
        land = 1 + 9 * urban[:, None]                       # 市街地の土工は用地・立体交差の負担が大きい
        d = -h
        c_emb = np.where(h >= 0, 1.5 + 0.10 * h ** 2 * land, np.inf)
        c_cut = np.where(h < 0, 1.5 + 0.14 * d ** 2 * land, np.inf)
        c_via = np.where(h >= 3, 7 + 0.25 * h, np.inf)
        c_tun = np.where(d >= 12, 16.0, np.inf)
        c_bri = np.where(h >= 6, 14 + 0.25 * h, 1e4)        # 河川上は橋りょう必須（桁下 6m 以上）
        stack = np.stack([np.minimum(c_emb, c_cut), c_via, np.full_like(h, np.inf), c_tun])
        stack[:, river, :] = np.inf
        stack[2][river] = c_bri[river]
        cost = stack.min(axis=0) * DS
        kind = stack.argmin(axis=0)
        # 縦断の動的計画法：隣の測点へは高さ ±1 段（= 勾配 DZ/DS 以内）しか動けない
        n, m = cost.shape
        acc = np.full(m, np.inf)
        j0 = int(round((g[0] + 8) / DZ))                    # A駅は高架駅（地上+8m）
        acc[j0] = 0
        back = np.zeros((n, m), np.int8)
        pad = np.full(1, np.inf)
        for i in range(1, n):
            cand = np.stack([np.concatenate([pad, acc[:-1]]), acc, np.concatenate([acc[1:], pad])])
            b = cand.argmin(axis=0)
            acc = cand[b, np.arange(m)] + cost[i]
            back[i] = b - 1
        j = int(round((g[-1] + 8) / DZ))                    # B駅も高架駅
        total = acc[j]
        path = np.zeros(n, int)
        for i in range(n - 1, -1, -1):
            path[i] = j
            j += back[i, j]
        kinds = kind[np.arange(n), path]
        w = np.array([1.0, 0.6, 0.6, 0.05])[kinds]          # 地表への影響の重み（トンネルは小さい）
        impact = float((urban * w + prot * np.where(kinds == 3, 0.3, 6.0)).sum() * DS / 1000)
        violation = max(0.0, R_MIN / radius - 1)
        res = dict(cost=float(total / 1000), impact=impact, length=float(st[-1] + DS), violation=violation)
        if full:
            res.update(x=xs, y=ys, s=st, ground=g, z=zl[path], kind=kinds, radius=float(radius))
        return res


def nondominated_rank(F, viol):
    """制約違反なしを優先した非優越ソート（2目的）。戻り値はランク（0 が最良）。"""
    n = len(F)
    rank = np.full(n, -1)
    Fp = F + viol[:, None] * 1e6
    remaining = np.arange(n)
    r = 0
    while len(remaining):
        f = Fp[remaining]
        dom = (f[:, None, :] <= f[None, :, :]).all(-1) & (f[:, None, :] < f[None, :, :]).any(-1)
        front = ~dom.any(axis=0)
        rank[remaining[front]] = r
        remaining = remaining[~front]
        r += 1
    return rank


def crowding(F):
    d = np.zeros(len(F))
    for k in range(F.shape[1]):
        o = np.argsort(F[:, k])
        span = F[o[-1], k] - F[o[0], k] or 1
        d[o[0]] = d[o[-1]] = np.inf
        d[o[1:-1]] += (F[o[2:], k] - F[o[:-2], k]) / span
    return d


def search(ev, pop=160, gens=110, seed=3, log=print):
    rng = np.random.default_rng(seed)
    lo, hi = 400.0, LY - 400.0
    base = np.linspace(A[1], B[1], K + 2)[1:-1]
    P = np.clip(base + rng.normal(0, 1500, (pop, K)) + rng.normal(0, 1200, (pop, 1)), lo, hi)
    R = [ev.evaluate(p) for p in P]
    history, n_eval = [], pop
    for gen in range(gens):
        F = np.array([[r['cost'], r['impact']] for r in R])
        viol = np.array([r['violation'] for r in R])
        rank = nondominated_rank(F, viol)
        history.append(dict(gen=gen, n_eval=n_eval, P=P.copy(), F=F.copy(), viol=viol.copy(), rank=rank.copy()))
        if gen % 10 == 0:
            ok = viol == 0
            log(f"世代 {gen:3d}  評価 {n_eval:6d} 案  実行可能 {ok.sum():3d}  コスト最小 {F[ok, 0].min() if ok.any() else float('nan'):.0f}"
                f"  影響最小 {F[ok, 1].min() if ok.any() else float('nan'):.1f}")
        # 親選択（トーナメント）→ 交叉 → 突然変異
        cd = np.zeros(pop)
        for r in np.unique(rank):
            cd[rank == r] = crowding(F[rank == r])
        a, b = rng.integers(0, pop, (2, pop))
        win = np.where((rank[a] < rank[b]) | ((rank[a] == rank[b]) & (cd[a] > cd[b])), a, b)
        mates = rng.permutation(win)
        w = rng.uniform(-0.25, 1.25, (pop, K))
        C = P[win] * w + P[mates] * (1 - w)
        sigma = 900 * (1 - gen / gens) + 120
        C += rng.normal(0, sigma, (pop, K)) * (rng.random((pop, K)) < 0.3)
        C += rng.normal(0, sigma * 0.5, (pop, 1)) * (rng.random((pop, 1)) < 0.15)
        C = np.clip(C, lo, hi)
        RC = [ev.evaluate(c) for c in C]
        n_eval += pop
        # 親＋子から次世代を選ぶ
        P2, R2 = np.vstack([P, C]), R + RC
        F2 = np.array([[r['cost'], r['impact']] for r in R2])
        v2 = np.array([r['violation'] for r in R2])
        rk = nondominated_rank(F2, v2)
        cd2 = np.zeros(2 * pop)
        for r in np.unique(rk):
            cd2[rk == r] = crowding(F2[rk == r])
        keep = np.lexsort((-cd2, rk))[:pop]
        P, R = P2[keep], [R2[i] for i in keep]
    return P, R, history, n_eval


def main():
    os.makedirs(OUT, exist_ok=True)
    T = make_terrain()
    ev = Evaluator(T)
    P, R, history, n_eval = search(ev)
    F = np.array([[r['cost'], r['impact']] for r in R])
    viol = np.array([r['violation'] for r in R])
    front = np.where((nondominated_rank(F, viol) == 0) & (viol == 0))[0]
    front = front[np.argsort(F[front, 0])]
    fn = (F[front] - F[front].min(0)) / np.ptp(F[front], axis=0)
    picks = dict(cost=front[0], impact=front[-1], balance=front[np.argmin(0.3 * fn[:, 0] + 0.7 * fn[:, 1])])   # 採用案：影響を重視した折れ点
    straight = ev.evaluate(np.linspace(A[1], B[1], K + 2)[1:-1], full=True)

    def pack(r):
        runs = {t: float((r['kind'] == i).sum() * DS / 1000) for i, t in enumerate(TYPES)}
        return dict(cost=r['cost'], impact=r['impact'], length_km=r['length'] / 1000, min_radius=r['radius'],
                    max_grade=float(np.abs(np.diff(r['z'])).max() / DS), km_by_type=runs,
                    x=r['x'].round(1).tolist(), y=r['y'].round(1).tolist(), z=r['z'].tolist(),
                    ground=r['ground'].round(1).tolist(), kind=r['kind'].tolist())

    routes = {k: pack(ev.evaluate(P[i], full=True)) for k, i in picks.items()}
    routes['straight'] = pack(straight)
    # 描画用：各世代の案（平面線形の点列を粗く）と目的関数値
    gens = []
    for hgen in history:
        curves = []
        for p in hgen['P'][:64]:
            xs, ys, _, _ = ev.plan(p)
            curves.append(np.stack([xs[::8], ys[::8]], 1).round(0).astype(int).tolist())
        gens.append(dict(n_eval=hgen['n_eval'], F=hgen['F'].round(2).tolist(), rank=hgen['rank'].tolist(),
                         feasible=(hgen['viol'] == 0).tolist(), curves=curves))
    ny, nx = T['z'].shape
    T['z'].astype(np.float32).tofile(os.path.join(OUT, 'height.bin'))
    layers = np.stack([T['urban'], T['protected'], T['river'], np.zeros_like(T['z'])], -1)
    (np.clip(layers, 0, 1) * 255).astype(np.uint8).tofile(os.path.join(OUT, 'layers.bin'))
    meta = dict(nx=nx, ny=ny, cell=CELL, LX=LX, LY=LY, A=A, B=B, n_eval=n_eval, r_min=R_MIN, g_max=G_MAX,
                types=TYPES, routes=routes, front=F[front].round(2).tolist(), gens=gens,
                zmax=float(T['z'].max()))
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False)
    for k, r in routes.items():
        print(f"{k:9s} コスト {r['cost']:7.0f}  影響 {r['impact']:6.1f}  延長 {r['length_km']:.1f}km  最小半径 {r['min_radius']:.0f}m"
              f"  最急勾配 {r['max_grade'] * 1000:.0f}‰  {r['km_by_type']}")
    print(f"評価した案: {n_eval:,}  パレート解: {len(front)}")


if __name__ == '__main__':
    main()
