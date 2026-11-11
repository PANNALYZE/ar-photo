"""設計章の後処理：最適化結果の再解析・従来型との比較・描画用データの書き出し。

  python3 tools/design_post.py            # data/viaduct_stage*.npz → data/design/
出力（data/design/）
  frames.bin        uint8  [nframes][nel]   反復ごとの密度（細格子にそろえて平滑化）
  stress.bin        uint8  [nel]            最終形状のミーゼス応力（3荷重ケースの包絡、0-255）
  disp.bin          float32[3][nel][3]      最終形状の要素中心変位（荷重ケースごと）
  conventional.bin  uint8  [nel]            比較用の従来型ラーメン高架橋（同体積）
  meta.json         格子・履歴・検証結果
"""
import json
import os
import sys
import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'engine'))
from fem3d import Solver  # noqa: E402
import viaduct  # noqa: E402

DATA = os.path.join(os.path.dirname(__file__), '..', 'data')
OUT = os.path.join(DATA, 'design')
E0, EMIN = 30e9, 30e9 * 1e-4


def analyse(g, fixed, loads, rho):
    """白黒化した形状を再解析し、荷重ケースごとの指標を返す。"""
    E = EMIN + rho * (E0 - EMIN)
    K = g.assemble(E, fixed)
    solver = Solver(g, fixed, tol=1e-7)
    X = g.node_coords()
    top = np.isclose(X[:, 2], viaduct.LZ)
    out, us, vms = [], [], []
    for f in loads:
        u = solver.solve(K, f)
        vm = g.von_mises(u, E)
        vm[rho < 0.5] = 0
        disp = np.linalg.norm(u.reshape(-1, 3)[top], axis=1)
        out.append(dict(compliance=float(f @ u), deck_disp_max_mm=float(disp.max() * 1e3),
                        vm_p999_MPa=float(np.percentile(vm[rho >= 0.5], 99.9) / 1e6)))
        us.append(u)
        vms.append(vm)
    return out, us, vms


def main():
    os.makedirs(OUT, exist_ok=True)
    stages = []
    for si in (1, 2):
        p = os.path.join(DATA, f'viaduct_stage{si}.npz')
        if os.path.exists(p):
            stages.append(np.load(p))
    hist = json.load(open(os.path.join(DATA, 'viaduct.json')))
    fine = stages[-1]
    nz, ny, nx = (int(v) for v in fine['shape'])
    h = float(fine['h'])
    if len(stages) == 1:  # 段階1だけのとき（動作確認用）：2倍に細分化した格子を最終格子とみなす
        nz, ny, nx, h = nz * 2, ny * 2, nx * 2, h / 2

    frames, iters = [], []
    for si, st in enumerate(stages):
        shp = tuple(int(v) for v in st['shape'])
        for k, fr in enumerate(st['frames']):
            v = fr.reshape(shp).astype(np.float32)
            if shp != (nz, ny, nx):
                v = v.repeat(2, 0).repeat(2, 1).repeat(2, 2)
                v = ndimage.gaussian_filter(v, 1.0, mode='nearest')
            else:
                v = ndimage.gaussian_filter(v, 0.6, mode='nearest')
            frames.append(np.clip(v, 0, 255).astype(np.uint8).ravel())
            r = hist['stages'][si]['history'][k]
            iters.append(dict(stage=si + 1, objective=r['objective'], volume=r['volume'],
                              beta=r['beta'], grayness=r['grayness'], compliance=r['compliance']))
    np.array(frames).tofile(os.path.join(OUT, 'frames.bin'))

    # --- 最終形状を白黒化して再解析、従来型と比較 ---------------------------
    g, fixed, loads, solid, void = viaduct.build(h)
    rho = fine['final'].astype(float)
    if rho.size != g.nel:
        rho = viaduct.upsample(rho, tuple(int(v) for v in fine['shape']))
    design = ~(solid | void)
    bw = (rho >= 0.5).astype(float)
    gen, us, vms = analyse(g, fixed, loads, bw)
    conv_rho, col = viaduct.conventional(g, solid, void, bw[design].sum())
    conv, _, _ = analyse(g, fixed, loads, conv_rho)
    vol_m3 = lambda r: float(r[design].sum() * h ** 3)  # noqa: E731

    vm_env = np.max(vms, axis=0)
    scale = float(np.percentile(vm_env[bw >= 0.5], 99.5))
    (np.clip(vm_env / scale, 0, 1) * 255).astype(np.uint8).tofile(os.path.join(OUT, 'stress.bin'))
    np.array([u.reshape(-1, 3)[g.enode].mean(axis=1) for u in us], np.float32).tofile(os.path.join(OUT, 'disp.bin'))
    (conv_rho * 255).astype(np.uint8).tofile(os.path.join(OUT, 'conventional.bin'))

    names = ['鉛直（死荷重＋列車荷重）', '橋軸直角方向 水平', '橋軸方向 水平']
    meta = dict(
        nx=nx, ny=ny, nz=nz, h=h, nel=g.nel, ndof=g.ndof, nframes=len(frames), iters=iters,
        stages=[dict(h=s['h'], nel=s['nel'], ndof=s['ndof'], iters=len(s['history']),
                     seconds=s['history'][-1]['elapsed']) for s in hist['stages']],
        domain=dict(LX=viaduct.LX, LY=viaduct.LY, LZ=viaduct.LZ, deck_t=viaduct.DECK_T,
                    road_half_w=viaduct.ROAD_HALF_W, road_h=viaduct.ROAD_H, pad=viaduct.PAD,
                    pad_x=viaduct.PAD_X, pad_y=viaduct.PAD_Y, track_y=viaduct.TRACK_Y,
                    volfrac=viaduct.VOLFRAC),
        stress_scale_MPa=scale / 1e6, load_cases=names,
        generative=dict(volume_m3=vol_m3(bw), cases=gen),
        conventional=dict(volume_m3=vol_m3(conv_rho), column_m=col, cases=conv),
        stiffness_gain=[c['compliance'] / g_['compliance'] for c, g_ in zip(conv, gen)],
    )
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
    print(f"格子 {nx}x{ny}x{nz}  フレーム {len(frames)}")
    print(f"体積 [m3]: 生成 {meta['generative']['volume_m3']:.1f} / 従来型 {meta['conventional']['volume_m3']:.1f}"
          f"（柱 {col:.2f} m 角）")
    for n, a, b, r in zip(names, gen, conv, meta['stiffness_gain']):
        print(f"{n}: 床版最大変位 生成 {a['deck_disp_max_mm']:.2f} mm / 従来 {b['deck_disp_max_mm']:.2f} mm, "
              f"コンプライアンス比（従来/生成） {r:.2f}")


if __name__ == '__main__':
    main()
