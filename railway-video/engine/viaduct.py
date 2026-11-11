"""設計章：道路をまたぐ鉄道高架橋ブロックのジェネレーティブデザイン（架空条件）。

設計領域  : 橋軸 x=30m × 橋軸直角 y=10.8m × 高さ z=12m の箱
固定条件  : 床版（上面 0.6m）は中実、交差道路の建築限界は空洞、フーチング4か所で固定
荷重ケース: ①鉛直（死荷重＋複線列車荷重） ②橋軸直角方向水平 ③橋軸方向水平
※ 荷重値・寸法はすべてデモ用の架空値。設計標準に基づく照査ではない。
"""
import json
import sys
import numpy as np
from fem3d import Grid
from topopt3d import optimize

LX, LY, LZ = 30.0, 10.8, 12.0
DECK_T = 0.6
ROAD_HALF_W, ROAD_H = 7.0, 5.4          # 交差道路の建築限界（幅14m×高さ5.4m）
PAD = 2.4                                # フーチング天端の固定範囲（一辺）
PAD_X, PAD_Y = (5.4, LX - 5.4), (2.4, LY - 2.4)
TRACK_Y, TRACK_HALF_W = (LY / 2 - 2.15, LY / 2 + 2.15), 0.9
DEAD_KN_M, LIVE_KN_M_PER_TRACK, KH = 100.0, 60.0, 0.3
VOLFRAC = 0.09


def build(h):
    nx, ny, nz = round(LX / h), round(LY / h), round(LZ / h)
    g = Grid(nx, ny, nz, h)
    C, X = g.elem_centers(), g.node_coords()
    solid = C[:, 2] > LZ - DECK_T
    void = (np.abs(C[:, 0] - LX / 2) < ROAD_HALF_W) & (C[:, 2] < ROAD_H)
    bottom = np.isclose(X[:, 2], 0)
    pad = np.zeros(g.nnode, bool)
    for px in PAD_X:
        for py in PAD_Y:
            pad |= bottom & (np.abs(X[:, 0] - px) <= PAD / 2 + 1e-9) & (np.abs(X[:, 1] - py) <= PAD / 2 + 1e-9)
    fixed = (3 * np.where(pad)[0][:, None] + np.arange(3)).ravel()
    top = np.where(np.isclose(X[:, 2], LZ))[0]

    def spread(nodes, total, comp):
        """total [N] を節点集合へ負担面積比で分配する。"""
        w = np.ones(len(nodes))
        for ax, L in ((0, LX), (1, LY)):
            w *= np.where(np.isclose(X[nodes, ax], 0) | np.isclose(X[nodes, ax], L), 0.5, 1.0)
        f = np.zeros(g.ndof)
        f[3 * nodes + comp] = total * w / w.sum()
        return f

    dead = DEAD_KN_M * 1e3 * LX
    live = LIVE_KN_M_PER_TRACK * 1e3 * LX
    fv = spread(top, -dead, 2)
    for ty in TRACK_Y:
        fv += spread(top[np.abs(X[top, 1] - ty) <= TRACK_HALF_W + 1e-9], -live, 2)
    total_w = dead + 2 * live
    loads = [fv, spread(top, KH * total_w, 1), spread(top, KH * total_w, 0)]
    return g, fixed, loads, solid, void


def conventional(g, solid, void, target_cells):
    """比較用：従来型のラーメン高架橋（柱4本＋縦梁2本＋横梁2本）を同体積でボクセル化する。

    断面寸法を格子に合わせて総当たりし、設計領域内の体積が目標以上で最も近いものを選ぶ
    （＝従来型のほうがわずかに材料が多い、従来型に有利な側の比較）。
    候補のうち、柱幅に対する比率が 梁幅 1.0・縦梁せい 2.0・横梁せい 1.5 に最も近いものを採用する。
    戻り値: (密度, 寸法の辞書)
    """
    C, h = g.elem_centers(), g.h
    design = ~(solid | void)
    below = C[:, 2] < LZ - DECK_T
    eps = 1e-6

    def layout(col, bw, dl, dc):
        r = np.zeros(g.nel, bool)
        for px in PAD_X:
            for py in PAD_Y:
                r |= (np.abs(C[:, 0] - px) < col / 2 + eps) & (np.abs(C[:, 1] - py) < col / 2 + eps) & below
        for py in PAD_Y:                                   # 縦梁（橋軸方向、全長）
            r |= (np.abs(C[:, 1] - py) < bw / 2 + eps) & (C[:, 2] > LZ - DECK_T - dl) & below
        for px in PAD_X:                                   # 横梁（橋軸直角方向、全幅）
            r |= (np.abs(C[:, 0] - px) < bw / 2 + eps) & (C[:, 2] > LZ - DECK_T - dc) & below
        return r & design

    best = None
    for i in range(1, 6):                                  # 幅は中心線の両側に同数セルずつ
        col = 2 * i * h - h * 0.5
        for j in range(1, i + 1):
            bw = 2 * j * h - h * 0.5
            for kl in range(2, 14):
                for kc in range(2, kl + 1):
                    dl, dc = kl * h, kc * h
                    n = int(layout(col, bw, dl, dc).sum())
                    if not (target_cells <= n <= 1.04 * target_cells):
                        continue
                    cw, bww = 2 * i * h, 2 * j * h
                    score = abs(bww / cw - 1.0) + abs(dl / cw - 2.0) + abs(dc / cw - 1.5) + 5 * (n / target_cells - 1)
                    if best is None or score < best[0]:
                        best = (score, col, bw, dl, dc, dict(column_m=cw, beam_w_m=bww, long_beam_d_m=dl, cross_beam_d_m=dc))
    if best is None:
        raise RuntimeError('体積が合う従来型の寸法が見つかりません')
    _, col, bw, dl, dc, dims = best
    return (layout(col, bw, dl, dc) | solid).astype(float), dims


def baseline(h, log=print):
    """従来型を h の格子で解析し、荷重ケースごとのコンプライアンス（最適化の基準値）を返す。"""
    from fem3d import Solver
    g, fixed, loads, solid, void = build(h)
    design = ~(solid | void)
    rho, dims = conventional(g, solid, void, VOLFRAC * design.sum())
    E = 30e9 * (1e-4 + rho * (1 - 1e-4))
    K = g.assemble(E, fixed)
    solver = Solver(g, fixed, tol=1e-7)
    cs = [float(f @ solver.solve(K, f)) for f in loads]
    log(f"従来型（基準）: {dims}  体積率 {rho[design].mean():.4f}  コンプライアンス {['%.1f' % c for c in cs]}")
    return cs, dims


def upsample(a, shape):
    """密度場を各軸2倍に細分化する（最近傍）。"""
    a = a.reshape(shape)
    return a.repeat(2, axis=0).repeat(2, axis=1).repeat(2, axis=2).ravel()


def run(h_coarse, out, log=print):
    """粗格子で形を育て、細格子に引き継いで仕上げる2段階の最適化。

    目的関数は「従来型のコンプライアンスに対する比」の最大値（p ノルム近似）の最小化。
    """
    stages = [
        dict(h=h_coarse, iters=45, beta=((0, 1), (22, 2), (34, 4)), rebuild=1),
        dict(h=h_coarse / 2, iters=27, beta=((0, 4), (8, 8), (17, 16)), rebuild=3),
    ]
    norm, dims = baseline(h_coarse / 2, log)
    x, meta = None, []
    for si, st in enumerate(stages):
        g, fixed, loads, solid, void = build(st['h'])
        log(f"--- 段階{si + 1}: 格子 {g.nx}x{g.ny}x{g.nz} = {g.nel:,} 要素 / {g.ndof:,} 自由度")
        frames = []
        res = optimize(g, fixed, loads, norm, VOLFRAC, solid=solid, void=void,
                       iters=st['iters'], beta_schedule=st['beta'], rmin=max(1.5, 0.75 / st['h']),
                       symmetry=('x', 'y'), x_init=x, rebuild_every=st['rebuild'],
                       on_iter=lambda it, rho, rec: frames.append((rho * 255).astype(np.uint8)), log=log)
        shape = (g.nz, g.ny, g.nx)
        np.savez_compressed(f'{out}_stage{si + 1}.npz', frames=np.array(frames), final=res['rho'],
                            shape=shape, h=st['h'])
        meta.append(dict(h=st['h'], shape=shape, nel=g.nel, ndof=g.ndof, history=res['history']))
        json.dump(dict(stages=meta, norm=norm, conventional=dims), open(out + '.json', 'w'))
        x = upsample(res['x'], shape)
    return res


if __name__ == '__main__':
    run(float(sys.argv[1]) if len(sys.argv) > 1 else 0.6, sys.argv[2] if len(sys.argv) > 2 else '../data/viaduct',
        log=lambda s: print(s, flush=True))
