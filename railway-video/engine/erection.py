"""施工章：営業線をまたぐ桁架設のデジタルリハーサル（架空条件）。

終電から始発までの線路閉鎖間合い（235分）に、主桁2本と横桁5本を1台のクレーンで架設する。
クレーンの据付位置・横桁の架設順・ボルト班の数・地組の有無を総当たりし、
作業時間のばらつきを乱数で振った離散事象シミュレーション（モンテカルロ）で
「始発に間に合う確率」が最も高い手順を選ぶ。

  python3 engine/erection.py  →  data/build/plan.json
"""
import itertools
import json
import os
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'build')
WINDOW = 235.0                                   # 線路閉鎖間合い [分]（00:40〜04:35）
SPAN, PIER_X, SEAT_Z, GIRDER_D = 42.0, 21.0, 9.0, 2.2
GIRDERS = [dict(id='G1', y=-2.4, mass=58.0), dict(id='G2', y=2.4, mass=58.0)]
CROSS_X = [-14.0, -7.0, 0.0, 7.0, 14.0]
CROSS_MASS, RIG_MASS = 3.0, 4.0
YARD = dict(girder=(-33.0, -15.0), cross=(-24.0, -27.0))   # 地組ヤード（桁の重心位置）
CAP_R = np.array([9, 14, 20, 26, 32, 38, 44.0])            # 作業半径 [m]
CAP_T = np.array([230, 170, 122, 88, 64, 48, 36.0])        # 定格総荷重 [t]（架空の性能表）
UTIL_MAX, SLEW_RATE = 0.85, 28.0                           # 許容負荷率、旋回速度 [度/分]
CRANE_SITES = [(x, y) for x in (-30, -24, -18, -12) for y in (-14, -20, -26)]

# 作業時間の中央値 [分] と対数正規のばらつき σ
DUR = dict(close=(12, 0.10), prep=(9, 0.20), rig_g=(8, 0.25), hoist_g=(6, 0.15), align_g=(13, 0.35),
           minfix_g=(7, 0.30), fix_g=(16, 0.30), unhook_g=(5, 0.20),
           rig_c=(3, 0.25), hoist_c=(3, 0.15), align_c=(5, 0.35), minfix_c=(3, 0.30), fix_c=(6, 0.30), unhook_c=(2, 0.2),
           inspect=(15, 0.15), reopen=(10, 0.10))


def capacity(r):
    return float(np.interp(r, CAP_R, CAP_T)) if CAP_R[0] <= r <= CAP_R[-1] else 0.0


def polar(site, p):
    dx, dy = p[0] - site[0], p[1] - site[1]
    return float(np.hypot(dx, dy)), float(np.degrees(np.arctan2(dy, dx)))


def build_lifts(site, order, preassemble):
    """クレーンの吊り作業の列を作る。負荷率が許容を超えれば None。"""
    lifts = []
    n_pre = 3 if preassemble else 0                 # 地組：横桁3本を G2 に付けてから吊る
    for g in GIRDERS:
        mass = g['mass'] + (CROSS_MASS * n_pre if g['id'] == 'G2' else 0)
        lifts.append(dict(id=g['id'], kind='g', mass=mass, pick=YARD['girder'], place=(0.0, g['y']),
                          z=SEAT_Z, pre=n_pre if g['id'] == 'G2' else 0))
    done_pre = sorted(order[:n_pre])
    for k in order:
        if k in done_pre:
            continue
        lifts.append(dict(id=f'C{k + 1}', kind='c', mass=CROSS_MASS, pick=YARD['cross'], place=(CROSS_X[k], 0.0),
                          z=SEAT_Z + 0.5, pre=0))
    for L in lifts:
        L['r0'], L['a0'] = polar(site, L['pick'])
        L['r1'], L['a1'] = polar(site, L['place'])
        L['util'] = max((L['mass'] + RIG_MASS) / max(capacity(r), 1e-9) for r in (L['r0'], L['r1']))
        if L['util'] > UTIL_MAX:
            return None
    return lifts


def simulate(lifts, crews, rng=None, trace=False):
    """離散事象シミュレーション。rng=None なら中央値で決定論的に流す。戻り値は完了時刻 [分]。"""
    def d(key):
        m, s = DUR[key]
        return m if rng is None else m * float(np.exp(rng.normal(0, s)))

    def slew(a, b):
        return abs((b - a + 180) % 360 - 180) / SLEW_RATE * (1.0 if rng is None else float(np.exp(rng.normal(0, 0.12))))

    t = d('close') + d('prep')
    free = [t] * crews                               # ボルト班が空く時刻
    events = [dict(name='線路閉鎖・き電停止', t0=0, t1=t, who='手続き')]
    angle = lifts[0]['a0']
    for L in lifts:
        k = L['kind']
        seq = [('玉掛け', d('rig_' + k) + slew(angle, L['a0'])), ('巻上げ', d('hoist_' + k)),
               ('旋回・起伏', slew(L['a0'], L['a1']) + 1.5), ('位置合わせ', d('align_' + k))]
        ph = []
        for name, dur in seq:
            ph.append(dict(name=name, t0=t, t1=t + dur))
            t += dur
        c = int(np.argmin(free))                     # 最小限の仮固定が済むまでクレーンは荷を保持する
        s = max(t, free[c])
        mf, fx = d('minfix_' + k), d('fix_' + k) * (1 + 0.5 * L['pre'])
        ph.append(dict(name='仮固定（保持）', t0=t, t1=s + mf))
        t = s + mf
        free[c] = t + fx
        events.append(dict(name=f"{L['id']} 本締め", t0=t, t1=free[c], who=f'ボルト班{c + 1}'))
        un = d('unhook_' + k)
        ph.append(dict(name='玉外し', t0=t, t1=t + un))
        t += un
        angle = L['a1']
        if trace:
            L['phases'] = ph
        events.append(dict(name=f"{L['id']} 架設", t0=ph[0]['t0'], t1=t, who='クレーン'))
    t = max(t, max(free))
    t_ins = t + d('inspect')
    t_end = t_ins + d('reopen')
    events += [dict(name='跡確認・建築限界測定', t0=t, t1=t_ins, who='手続き'), dict(name='線路開通', t0=t_ins, t1=t_end, who='手続き')]
    return (t_end, events) if trace else t_end


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(11)
    plans = []
    for site in CRANE_SITES:
        for pre in (False, True):
            for order in itertools.permutations(range(5)):
                lifts = build_lifts(site, order, pre)
                for crews in (1, 2, 3):
                    plans.append(dict(site=site, pre=pre, order=order, crews=crews, lifts=lifts,
                                      t=simulate(lifts, crews) if lifts else None))
    feasible = [p for p in plans if p['t'] is not None]
    feasible.sort(key=lambda p: (p['t'], p['crews']))
    # 上位の手順を乱数試行で比較する（同じ確率なら班の少ないほうを選ぶ）
    top = feasible[:150]
    for p in top:
        s = np.array([simulate(p['lifts'], p['crews'], rng) for _ in range(300)])
        p['p_ok'] = float((s <= WINDOW).mean())
    best = max(top, key=lambda p: (round(p['p_ok'], 2), -p['crews'], -p['t']))
    naive = next(p for p in plans if p['t'] is not None and not p['pre'] and p['order'] == (0, 1, 2, 3, 4) and p['crews'] == 1)
    out = {}
    for key, p in (('best', best), ('naive', naive)):
        s = np.array([simulate(p['lifts'], p['crews'], rng) for _ in range(4000)])
        t_end, events = simulate(p['lifts'], p['crews'], trace=True)
        out[key] = dict(site=p['site'], preassemble=p['pre'], order=[int(k) for k in p['order']], crews=p['crews'],
                        median_min=t_end, p_ok=float((s <= WINDOW).mean()), p95_min=float(np.percentile(s, 95)),
                        samples=np.round(s, 1).tolist(), lifts=p['lifts'], events=events)
        print(f"{key:5s} 据付位置 {p['site']} 地組 {p['pre']} 班 {p['crews']} 順 {p['order']}  "
              f"中央値 {t_end:.0f} 分  95% {out[key]['p95_min']:.0f} 分  間に合う確率 {out[key]['p_ok'] * 100:.1f}%  "
              f"最大負荷率 {max(L['util'] for L in p['lifts']) * 100:.0f}%")
    meta = dict(window=WINDOW, n_plans=len(plans), n_feasible=len(feasible), n_runs=len(top) * 300 + 8000,
                span=SPAN, pier_x=PIER_X, seat_z=SEAT_Z, girder_d=GIRDER_D, girders=GIRDERS, cross_x=CROSS_X,
                yard=YARD, sites=CRANE_SITES, cap_r=CAP_R.tolist(), cap_t=CAP_T.tolist(), util_max=UTIL_MAX,
                all_medians=sorted(round(p['t'], 1) for p in feasible)[::7], **out)
    json.dump(meta, open(os.path.join(OUT, 'plan.json'), 'w'), ensure_ascii=False)
    print(f"検討した手順 {len(plans):,} 通り（実行可能 {len(feasible):,}）、乱数試行 {meta['n_runs']:,} 回")


if __name__ == '__main__':
    main()
