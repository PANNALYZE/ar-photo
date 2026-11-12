"""技術開発章：自律実験ループによる制振装置（TMD）の探索（架空条件）。

列車の連行荷重で共振する単純桁に、支間中央の同調質量ダンパー（TMD）を付ける。
ガウス過程の代理モデルとベイズ最適化で「次に試す諸元」を自分で決めながら数値実験を回す。

  実験1（検証）：調和加振での最適同調。古典解（Den Hartog）を再発見できるか確かめる
  実験2（本題）：列車走行時の最大加速度を最小化する。こちらに閉じた解はない

  python3 engine/discovery.py  →  data/research/meta.json
"""
import json
import os
import numpy as np
from scipy.linalg import expm, cho_factor, cho_solve
from scipy.stats import norm

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'research')
SPAN, F1, ZETA1, M_PER_M = 40.0, 3.2, 0.015, 32000.0     # 支間 [m]、1次固有振動数 [Hz]、減衰定数、単位長さ質量 [kg/m]
CAR, N_CARS, AXLE_KN = 25.0, 12, 140.0                   # 車両長 [m]、両数、軸重 [kN]
AXLE_OFFSETS = np.array([2.5, 5.0, 20.0, 22.5])          # 車両内の軸位置 [m]
MU = 0.02                                                # TMD 質量比（1次モード質量に対して）
SPEEDS = np.arange(120.0, 361.0, 4.0)                    # 走行速度 [km/h]
DT, T_END = 0.004, 9.0
BOUNDS = np.array([[0.80, 1.10], [0.01, 0.30]])          # 探索範囲：振動数比 f、TMD 減衰定数 ζ
M1 = M_PER_M * SPAN / 2                                  # 1次モード質量
W1 = 2 * np.pi * F1


def system(f, zt, tmd=True):
    """状態 [q, z, q', z']（q: 桁中央の変位、z: TMD の変位）の連続系行列。"""
    k1, c1 = M1 * W1 ** 2, 2 * ZETA1 * M1 * W1
    if not tmd:
        return np.array([[0, 1.0], [-k1 / M1, -c1 / M1]]), np.array([0, 1 / M1])
    mt = MU * M1
    wt = f * W1
    kt, ct = mt * wt ** 2, 2 * zt * mt * wt
    A = np.zeros((4, 4))
    A[0, 2] = A[1, 3] = 1
    A[2] = [-(k1 + kt) / M1, kt / M1, -(c1 + ct) / M1, ct / M1]
    A[3] = [kt / mt, -kt / mt, ct / mt, -ct / mt]
    return A, np.array([0, 0, 1 / M1, 0])


def modal_force(t, v):
    """速度 v [m/s] の列車が桁の1次モードに与える力 Σ P sin(πx/L)。t は配列。"""
    axles = (np.arange(N_CARS)[:, None] * CAR + AXLE_OFFSETS[None, :]).ravel()
    x = v * t[:, None] - axles[None, :]
    return AXLE_KN * 1e3 * np.where((x >= 0) & (x <= SPAN), np.sin(np.pi * x / SPAN), 0).sum(1)


def run_train(f=None, zt=None, speeds=SPEEDS, history=False):
    """全速度を同時に時刻歴積分し、桁中央の最大加速度 [m/s²] を速度ごとに返す。"""
    tmd = f is not None
    A, B = system(f, zt, tmd)
    n = A.shape[0]
    # 区間内で力を一定とみなす離散化：x_{k+1} = Ad x_k + Bd F_k
    Mx = np.zeros((n + 1, n + 1))
    Mx[:n, :n], Mx[:n, n] = A * DT, B * DT
    E = expm(Mx)
    Ad, Bd = E[:n, :n], E[:n, n]
    t = np.arange(0, T_END, DT)
    F = np.stack([modal_force(t, v / 3.6) for v in speeds])            # (速度, 時刻)
    x = np.zeros((len(speeds), n))
    acc_row = A[n // 2] if tmd else A[1]
    peak = np.zeros(len(speeds))
    hist = np.zeros((len(t), n)) if history else None
    for k in range(len(t)):
        acc = x @ acc_row + F[:, k] / M1
        peak = np.maximum(peak, np.abs(acc))
        if history:
            hist[k] = x[0]
        x = x @ Ad.T + F[:, k:k + 1] * Bd[None, :]
    return (peak, t, hist) if history else peak


def harmonic_peak(f, zt):
    """調和加振での変位応答倍率の最大値（主系の減衰は無視、Den Hartog と同じ問題設定）。"""
    r = np.linspace(0.7, 1.3, 1200)
    num = (2 * zt * r * f) ** 2 + (r ** 2 - f ** 2) ** 2
    den = (2 * zt * r * f) ** 2 * (r ** 2 - 1 + MU * r ** 2) ** 2 + (MU * f ** 2 * r ** 2 - (r ** 2 - 1) * (r ** 2 - f ** 2)) ** 2
    return float(np.sqrt(num / den).max())


class BayesOpt:
    """ガウス過程（RBF カーネル）＋期待改善量による逐次実験計画。"""

    def __init__(self, fn, rng, n_init=8, length=(0.18, 0.22), noise=1e-4):
        self.fn, self.rng, self.ls, self.noise = fn, rng, np.array(length), noise
        self.X, self.y, self.snap = [], [], []
        u = (np.stack([rng.permutation(n_init), rng.permutation(n_init)], 1) + rng.random((n_init, 2))) / n_init   # ラテン超方格
        for p in u:
            self.add(p)

    def to_real(self, u):
        return BOUNDS[:, 0] + np.asarray(u) * (BOUNDS[:, 1] - BOUNDS[:, 0])

    def add(self, u):
        self.X.append(np.asarray(u))
        self.y.append(self.fn(*self.to_real(u)))

    def kernel(self, a, b):
        d = (a[:, None, :] - b[None, :, :]) / self.ls
        return np.exp(-0.5 * (d ** 2).sum(-1))

    def posterior(self, Q):
        X, y = np.array(self.X), np.log(np.array(self.y))             # 対数で学習（桁が大きく変わるため）
        m, s = y.mean(), y.std() + 1e-9
        Kc = cho_factor(self.kernel(X, X) + self.noise * np.eye(len(X)))
        Ks = self.kernel(Q, X)
        mu = Ks @ cho_solve(Kc, (y - m) / s)
        var = np.clip(1 - np.einsum('ij,ji->i', Ks, cho_solve(Kc, Ks.T)), 1e-12, None)
        return mu, np.sqrt(var), (np.log(min(self.y)) - m) / s, m, s

    def step(self, grid=None):
        Q = self.rng.random((4000, 2))
        mu, sd, best, _, _ = self.posterior(Q)
        z = (best - mu) / sd
        ei = sd * (z * norm.cdf(z) + norm.pdf(z))
        if grid is not None:                                          # 描画用に代理モデルの平均面を残す
            gm, _, _, m, s = self.posterior(grid)
            self.snap.append(dict(n=len(self.y), mean=np.exp(gm * s + m).round(4).tolist()))
        self.add(Q[np.argmax(ei)])

    def best(self):
        i = int(np.argmin(self.y))
        return self.to_real(self.X[i]), float(self.y[i])


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(2)
    G = 28
    gu = (np.arange(G) + 0.5) / G
    grid = np.stack(np.meshgrid(gu, gu, indexing='ij'), -1).reshape(-1, 2)

    # --- 実験1：古典解の再発見 --------------------------------------------
    bo1 = BayesOpt(harmonic_peak, rng)
    for _ in range(40):
        bo1.step()
    (f1, z1), h1 = bo1.best()
    f_dh, z_dh = 1 / (1 + MU), np.sqrt(3 * MU / (8 * (1 + MU)))
    h_dh = harmonic_peak(f_dh, z_dh)
    print(f"実験1 古典解 f={f_dh:.4f} ζ={z_dh:.4f} 応答倍率 {h_dh:.3f}（理論値 √(1+2/μ) = {np.sqrt(1 + 2 / MU):.3f}）")
    print(f"      AI探索 f={f1:.4f} ζ={z1:.4f} 応答倍率 {h1:.3f}（{len(bo1.y)} 回の実験、古典解との差 {(h1 / h_dh - 1) * 100:+.1f}%）")

    # --- 実験2：列車走行時の最大加速度 ------------------------------------
    cost = lambda f, z: float(run_train(f, z).max())                  # noqa: E731
    bo2 = BayesOpt(cost, rng)
    for i in range(40):
        bo2.step(grid if i % 5 == 0 or i == 39 else None)
    (f2, z2), a2 = bo2.best()
    base = run_train()
    dh = run_train(f_dh, z_dh)
    opt = run_train(f2, z2)
    v_res = F1 * CAR * 3.6
    truth = np.array([cost(*bo2.to_real(u)) for u in grid])           # 答え合わせ用の総当たり
    print(f"実験2 共振速度（理論）{v_res:.0f} km/h ／ 制振なしの最大加速度 {base.max():.2f} m/s²（{SPEEDS[base.argmax()]:.0f} km/h）")
    print(f"      古典解のTMD {dh.max():.2f} m/s² ／ AI探索のTMD {a2:.2f} m/s²（f={f2:.3f} ζ={z2:.3f}、{len(bo2.y)} 回の実験）")
    print(f"      総当たり {G * G} 回の最小値 {truth.min():.2f} m/s²　低減率 {(1 - a2 / base.max()) * 100:.0f}%")

    v_show = float(SPEEDS[base.argmax()])
    _, t, h0 = run_train(speeds=np.array([v_show]), history=True)
    _, _, h2 = run_train(f2, z2, speeds=np.array([v_show]), history=True)
    step = 3
    meta = dict(
        span=SPAN, f1=F1, zeta1=ZETA1, car=CAR, n_cars=N_CARS, axle_kN=AXLE_KN, mu=MU, v_res=v_res, v_show=v_show,
        bounds=BOUNDS.tolist(), speeds=SPEEDS.tolist(), grid=G,
        exp1=dict(den_hartog=[f_dh, z_dh, h_dh], found=[float(f1), float(z1), h1], n=len(bo1.y),
                  X=[bo1.to_real(u).tolist() for u in bo1.X], y=bo1.y),
        exp2=dict(found=[float(f2), float(z2), a2], n=len(bo2.y), X=[bo2.to_real(u).tolist() for u in bo2.X], y=bo2.y,
                  U=[np.asarray(u).tolist() for u in bo2.X], snaps=bo2.snap, truth=truth.round(4).tolist(), truth_min=float(truth.min())),
        curves=dict(none=base.round(4).tolist(), den_hartog=dh.round(4).tolist(), found=opt.round(4).tolist()),
        history=dict(dt=DT * step, none=(h0[::step, 0] * 1e3).round(4).tolist(), tmd=(h2[::step, 0] * 1e3).round(4).tolist(),
                     tmd_z=(h2[::step, 1] * 1e3).round(4).tolist()),
    )
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False)


if __name__ == '__main__':
    main()
