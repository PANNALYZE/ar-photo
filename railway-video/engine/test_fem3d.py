"""3次元FEMの検証：理論解と照合する。 実行: python3 -m pytest engine/ もしくは python3 engine/test_fem3d.py"""
import numpy as np
from fem3d import Grid, Solver


def _face_nodes(g, axis, value):
    X = g.node_coords()
    return np.where(np.isclose(X[:, axis], value))[0]


def test_patch_uniaxial_tension():
    """一様引張：u = σL/E が機械精度で再現されること（パッチテスト）。"""
    E, sigma, h = 30e9, 2e6, 0.5
    g = Grid(8, 3, 2, h, nu=0.2)
    X = g.node_coords()
    left = _face_nodes(g, 0, 0.0)
    # 対称条件：x=0 面は ux、y=0 面は uy、z=0 面は uz を拘束（ポアソン収縮は自由）
    fixed = np.concatenate([3 * left, 3 * _face_nodes(g, 1, 0.0) + 1, 3 * _face_nodes(g, 2, 0.0) + 2])
    f = np.zeros(g.ndof)
    right = _face_nodes(g, 0, 8 * h)
    for n in right:  # 面圧を節点に分配（面の負担面積）
        wy = h * (0.5 if X[n, 1] in (0.0, 3 * h) else 1.0)
        wz = h * (0.5 if X[n, 2] in (0.0, 2 * h) else 1.0)
        f[3 * n] = sigma * wy * wz
    K = g.assemble(np.full(g.nel, E), fixed)
    u = Solver(g, fixed, tol=1e-12).solve(K, f)
    exact = sigma * 8 * h / E
    assert np.allclose(u[3 * right], exact, rtol=1e-8)
    vm = g.von_mises(u, np.full(g.nel, E))
    assert np.allclose(vm, sigma, rtol=1e-8)


def cantilever_tip(n_depth, nu=0.0):
    """片持ち梁（L=8m, 断面1x1m）先端にせん断荷重。先端たわみを返す。"""
    E, P, L, b = 30e9, 1e5, 8.0, 1.0
    h = b / n_depth
    g = Grid(int(L / h), n_depth, n_depth, h, nu=nu)
    left = _face_nodes(g, 0, 0.0)
    fixed = (3 * left[:, None] + np.arange(3)).ravel()
    tip = _face_nodes(g, 0, L)
    X = g.node_coords()
    f = np.zeros(g.ndof)
    w = np.array([(0.5 if X[n, 1] in (0.0, b) else 1.0) * (0.5 if X[n, 2] in (0.0, b) else 1.0) for n in tip])
    f[3 * tip + 2] = -P * w / w.sum()
    K = g.assemble(np.full(g.nel, E), fixed)
    u = Solver(g, fixed, tol=1e-10).solve(K, f)
    fem = -u[3 * tip + 2].mean()
    I, A, G = b ** 4 / 12, b * b, E / (2 * (1 + nu))
    timoshenko = P * L ** 3 / (3 * E * I) + P * L / (5 / 6 * G * A)
    return fem, timoshenko


def test_cantilever_converges_to_timoshenko():
    """メッシュ細分化でティモシェンコ梁理論に収束すること。"""
    errs = []
    for nd in (2, 4, 8):
        fem, th = cantilever_tip(nd)
        errs.append(abs(fem - th) / th)
    assert errs[0] > errs[1] > errs[2], errs
    assert errs[2] < 0.01, errs


if __name__ == '__main__':
    test_patch_uniaxial_tension()
    print('パッチテスト OK')
    for nd in (2, 4, 8):
        fem, th = cantilever_tip(nd)
        print(f'片持ち梁 断面{nd}x{nd}分割: FEM={fem*1e3:.4f}mm 理論={th*1e3:.4f}mm 誤差={abs(fem-th)/th*100:.2f}%')
