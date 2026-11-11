"""構造格子上の3次元線形弾性FEM（8節点六面体要素）。

ジェネレーティブデザイン（位相最適化）の解析エンジン。要素ごとにヤング率を変えられる。
単位は SI（N, m, Pa）。節点番号は n = ix + (nx+1)*(iy + (ny+1)*iz)、
要素番号は e = ix + nx*(iy + ny*iz)。自由度は節点あたり (ux, uy, uz)。
"""
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import pyamg


def hex8_ke(nu):
    """一辺1・ヤング率1の立方体要素の剛性行列（2x2x2 ガウス積分）。"""
    lam = nu / ((1 + nu) * (1 - 2 * nu))
    mu = 1 / (2 * (1 + nu))
    D = np.zeros((6, 6))
    D[:3, :3] = lam
    D[np.arange(3), np.arange(3)] += 2 * mu
    D[np.arange(3, 6), np.arange(3, 6)] = mu
    # 節点の局所座標（要素内の節点順は GRID.edof と一致させる）
    xi_n = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
                     [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], float) * 2 - 1
    g = 1 / np.sqrt(3)
    Ke = np.zeros((24, 24))
    for gx in (-g, g):
        for gy in (-g, g):
            for gz in (-g, g):
                B = _bmatrix(xi_n, (gx, gy, gz))
                Ke += B.T @ D @ B * (1 / 8)  # ヤコビアン行列式 = (1/2)^3
    return Ke, D


def _bmatrix(xi_n, p):
    """一辺1の立方体要素のひずみ-変位行列（自然座標 p ∈ [-1,1]^3）。"""
    dN = np.zeros((8, 3))
    for a in range(8):
        s = xi_n[a]
        dN[a, 0] = s[0] * (1 + s[1] * p[1]) * (1 + s[2] * p[2]) / 8
        dN[a, 1] = s[1] * (1 + s[0] * p[0]) * (1 + s[2] * p[2]) / 8
        dN[a, 2] = s[2] * (1 + s[0] * p[0]) * (1 + s[1] * p[1]) / 8
    dN *= 2  # d/dx = d/dxi * 2（一辺1なので dxi/dx = 2）
    B = np.zeros((6, 24))
    for a in range(8):
        dx, dy, dz = dN[a]
        c = 3 * a
        B[0, c] = dx
        B[1, c + 1] = dy
        B[2, c + 2] = dz
        B[3, c], B[3, c + 1] = dy, dx
        B[4, c + 1], B[4, c + 2] = dz, dy
        B[5, c], B[5, c + 2] = dz, dx
    return B


class Grid:
    def __init__(self, nx, ny, nz, h, nu=0.2):
        self.nx, self.ny, self.nz, self.h, self.nu = nx, ny, nz, h, nu
        self.nel = nx * ny * nz
        self.nnode = (nx + 1) * (ny + 1) * (nz + 1)
        self.ndof = 3 * self.nnode
        ke1, self.D = hex8_ke(nu)
        self.Ke = ke1 * h  # 3次元では剛性は E*h に比例
        ix, iy, iz = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing='ij')
        ix, iy, iz = (a.transpose(2, 1, 0).ravel() for a in (ix, iy, iz))
        n0 = ix + (nx + 1) * (iy + (ny + 1) * iz)
        offs = np.array([0, 1, nx + 1, nx + 2])
        offs = np.concatenate([offs, offs + (nx + 1) * (ny + 1)])
        self.enode = n0[:, None] + offs[None, :]                     # (nel, 8)
        self.edof = (3 * self.enode[:, :, None] + np.arange(3)).reshape(self.nel, 24)
        self._pattern = None

    # --- 座標・節点選択 -------------------------------------------------
    def node_coords(self):
        n = np.arange(self.nnode)
        ix = n % (self.nx + 1)
        iy = (n // (self.nx + 1)) % (self.ny + 1)
        iz = n // ((self.nx + 1) * (self.ny + 1))
        return np.stack([ix, iy, iz], axis=1) * self.h

    def elem_centers(self):
        e = np.arange(self.nel)
        ix = e % self.nx
        iy = (e // self.nx) % self.ny
        iz = e // (self.nx * self.ny)
        return (np.stack([ix, iy, iz], axis=1) + 0.5) * self.h

    # --- 全体剛性行列 ---------------------------------------------------
    def _build_pattern(self, fixed):
        """CSR の疎構造と「要素成分 → CSR data 位置」の対応を一度だけ作る。"""
        iK = np.repeat(self.edof, 24, axis=1).ravel()
        jK = np.tile(self.edof, (1, 24)).ravel()
        isfixed = np.zeros(self.ndof, bool)
        isfixed[fixed] = True
        keep = ~(isfixed[iK] | isfixed[jK])
        key = iK.astype(np.int64) * self.ndof + jK
        # 拘束自由度の対角成分も構造に含める（単位行列を入れるため）
        diag_key = np.arange(self.ndof, dtype=np.int64) * (self.ndof + 1)
        uniq, inv = np.unique(np.concatenate([key, diag_key]), return_inverse=True)
        rows = (uniq // self.ndof).astype(np.int32)
        cols = (uniq % self.ndof).astype(np.int32)
        indptr = np.zeros(self.ndof + 1, np.int64)
        np.add.at(indptr, rows + 1, 1)
        indptr = np.cumsum(indptr)
        self._pattern = dict(
            inv=inv[:key.size].astype(np.int32), keep=keep, nnz=uniq.size,
            cols=cols, indptr=indptr, diag_pos=inv[key.size:], isfixed=isfixed)

    def assemble(self, E_el, fixed):
        """要素ヤング率 E_el（nel,）から全体剛性行列を組む。拘束自由度は単位対角に置換。"""
        if self._pattern is None:
            self._build_pattern(fixed)
        p = self._pattern
        vals = (E_el[:, None] * self.Ke.ravel()[None, :]).ravel()
        vals *= p['keep']
        data = np.bincount(p['inv'], weights=vals, minlength=p['nnz'])
        # 拘束自由度の対角は剛性の代表値にして条件数を保つ
        data[p['diag_pos'][p['isfixed']]] = E_el.max() * self.h
        return sp.csr_matrix((data, p['cols'], p['indptr']), shape=(self.ndof, self.ndof))

    def rigid_body_modes(self):
        """AMG 前処理に与える近零空間（並進3 + 回転3）。"""
        X = self.node_coords()
        X = X - X.mean(axis=0)
        B = np.zeros((self.ndof, 6))
        B[0::3, 0] = B[1::3, 1] = B[2::3, 2] = 1
        B[1::3, 3], B[2::3, 3] = -X[:, 2], X[:, 1]
        B[0::3, 4], B[2::3, 4] = X[:, 2], -X[:, 0]
        B[0::3, 5], B[1::3, 5] = -X[:, 1], X[:, 0]
        return B

    # --- 応力 -----------------------------------------------------------
    def von_mises(self, u, E_el):
        """要素中心のミーゼス応力（nel,）。"""
        xi_n = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
                         [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], float) * 2 - 1
        B = _bmatrix(xi_n, (0, 0, 0)) / self.h
        s = (u[self.edof] @ B.T) @ self.D.T * E_el[:, None]
        sx, sy, sz, txy, tyz, tzx = s.T
        return np.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2)
                       + 3 * (txy ** 2 + tyz ** 2 + tzx ** 2))


class Solver:
    """AMG 前処理付き共役勾配法。前処理は rebuild() を呼ぶまで再利用する。"""

    def __init__(self, grid, fixed, tol=1e-6):
        self.grid, self.fixed, self.tol = grid, np.asarray(fixed), tol
        self.B = grid.rigid_body_modes()
        self.M = None
        self.iters = []

    def rebuild(self, K):
        ml = pyamg.smoothed_aggregation_solver(
            K.tobsr(blocksize=(3, 3)), B=self.B, max_coarse=400,
            strength=('symmetric', {'theta': 0.0}), smooth=('jacobi', {'omega': 4.0 / 3.0}))
        self.M = ml.aspreconditioner(cycle='V')

    def solve(self, K, f, x0=None):
        if self.M is None:
            self.rebuild(K)
        f = f.copy()
        f[self.fixed] = 0
        count = [0]

        def cb(_):
            count[0] += 1
        u, info = spla.cg(K, f, x0=x0, M=self.M, rtol=self.tol, maxiter=4000, callback=cb)
        if info != 0:
            raise RuntimeError(f'CG が収束しませんでした (info={info})')
        self.iters.append(count[0])
        u[self.fixed] = 0
        return u
