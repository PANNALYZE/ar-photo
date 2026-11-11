"""3次元位相最適化（SIMP法）。複数荷重ケースの重み付きコンプライアンス最小化。

密度フィルタ + ヘビサイド射影 + 最適性規準法（OC）。
設計変数 x → フィルタ x̃ → 射影 ρ（物理密度）→ E = Emin + ρ^p (E0 - Emin)。
"""
import time
import numpy as np
from scipy import ndimage
from fem3d import Solver


def cone_kernel(rmin):
    r = int(np.floor(rmin))
    a = np.arange(-r, r + 1)
    dz, dy, dx = np.meshgrid(a, a, a, indexing='ij')
    return np.maximum(0, rmin - np.sqrt(dx ** 2 + dy ** 2 + dz ** 2))


class Filter:
    """円錐重みの密度フィルタ（領域外はゼロ詰め、重み和で正規化）。"""

    def __init__(self, shape, rmin):
        self.k = cone_kernel(rmin)
        self.shape = shape
        self.Hs = ndimage.convolve(np.ones(shape), self.k, mode='constant')

    def fwd(self, x):
        return ndimage.convolve(x.reshape(self.shape), self.k, mode='constant').ravel() / self.Hs.ravel()

    def adj(self, g):
        return ndimage.convolve((g / self.Hs.ravel()).reshape(self.shape), self.k, mode='constant').ravel()


def project(xt, beta, eta=0.5):
    t = np.tanh(beta * eta)
    d = t + np.tanh(beta * (1 - eta))
    return (t + np.tanh(beta * (xt - eta))) / d, beta * (1 - np.tanh(beta * (xt - eta)) ** 2) / d


def optimize(grid, fixed, loads, norm, volfrac, pn=6.0, solid=None, void=None,
             E0=30e9, Emin_ratio=1e-4, penal=3.0, rmin=1.8, iters=80,
             beta_schedule=((0, 1), (25, 2), (40, 4), (55, 8), (68, 16)),
             symmetry=(), x_init=None, rebuild_every=1, on_iter=None, log=print):
    """loads: 荷重ベクトルのリスト。symmetry: 対称を強制する軸（'x','y'）。

    目的関数は基準値 norm[i]（比較対象とする設計のコンプライアンス）に対する比 r_i = c_i / norm[i] の
    p ノルム J = (Σ r_i^pn)^(1/pn)。pn を大きくすると「最も不利な荷重ケースの最小化」に近づく。
    norm=None のときは初期（一様密度）のコンプライアンスを基準にする。

    戻り値: dict(rho=物理密度, history=[...], u=[各荷重ケースの変位])
    """
    nel = grid.nel
    shape = (grid.nz, grid.ny, grid.nx)
    solid = np.zeros(nel, bool) if solid is None else solid
    void = np.zeros(nel, bool) if void is None else void
    design = ~(solid | void)
    filt = Filter(shape, rmin)
    solver = Solver(grid, fixed, tol=1e-5)
    Emin = E0 * Emin_ratio
    x = np.full(nel, volfrac) if x_init is None else x_init.copy()
    betas = dict(beta_schedule)
    beta = 1.0
    us = [None] * len(loads)
    history = []

    def symmetrize(a):
        a = a.reshape(shape)
        if 'x' in symmetry:
            a = 0.5 * (a + a[:, :, ::-1])
        if 'y' in symmetry:
            a = 0.5 * (a + a[:, ::-1, :])
        return a.ravel()

    def physical(xv, b):
        rho, drho = project(filt.fwd(xv), b)
        rho = rho.copy()
        rho[solid], rho[void] = 1.0, 0.0
        return rho, drho

    t0 = time.time()
    for it in range(iters):
        if it in betas:
            beta = float(betas[it])
        rho, drho = physical(x, beta)
        E = Emin + rho ** penal * (E0 - Emin)
        K = grid.assemble(E, fixed)
        if it % rebuild_every == 0 or it in betas:
            solver.rebuild(K)
        cs, dcs = [], []
        for i, f in enumerate(loads):
            us[i] = solver.solve(K, f, x0=us[i])
            Ue = us[i][grid.edof]
            ce = np.einsum('ij,jk,ik->i', Ue, grid.Ke, Ue)  # E=1 あたりの要素ひずみエネルギー×2
            cs.append(float(E @ ce))
            dcs.append(-penal * rho ** (penal - 1) * (E0 - Emin) * ce)
        if norm is None:
            norm = cs[:]
        r = np.array(cs) / np.array(norm)
        obj = float((r ** pn).sum() ** (1 / pn))
        w = r ** (pn - 1) / np.array(norm) * obj ** (1 - pn)   # ∂J/∂c_i
        dc = sum(w[i] * dcs[i] for i in range(len(loads)))
        # 連鎖律：物理密度 → 射影 → フィルタ
        dc[~design] = 0
        dc = symmetrize(filt.adj(dc * drho))
        dv = np.ones(nel)
        dv[~design] = 0
        dv = symmetrize(filt.adj(dv * drho))
        # OC 更新（体積制約は物理密度で評価、ラグランジュ乗数を二分法で求める）
        move = 0.1 if beta < 8 else 0.05
        l1, l2 = 1e-12, 1e12
        target = volfrac * design.sum()
        ratio = np.sqrt(np.maximum(-dc, 0) / np.maximum(dv, 1e-30))
        while (l2 - l1) / (l1 + l2) > 1e-4:
            lm = np.sqrt(l1 * l2)
            xn = np.clip(x * ratio / np.sqrt(lm), np.maximum(x - move, 0), np.minimum(x + move, 1))
            rn, _ = physical(xn, beta)
            if rn[design].sum() > target:
                l1 = lm
            else:
                l2 = lm
        change = float(np.abs(xn - x).max())
        x = symmetrize(xn)
        gray = float((4 * rho[design] * (1 - rho[design])).mean())
        rec = dict(iter=it, objective=obj, compliance=cs, ratio=r.tolist(), volume=float(rho[design].mean()),
                   beta=beta, change=change, grayness=gray, cg_iters=solver.iters[-len(loads):],
                   elapsed=time.time() - t0)
        history.append(rec)
        log(f"it {it:3d} J {obj:7.4f} 比 [{' '.join(f'{v:.3f}' for v in r)}] vol {rec['volume']:.4f} "
            f"β {beta:4.1f} gray {gray:.3f} cg {rec['cg_iters']} t {rec['elapsed']:.0f}s")
        if on_iter:
            on_iter(it, rho, rec)
    rho, _ = physical(x, beta)
    return dict(rho=rho, x=x, history=history, u=us, norm=list(norm))
