"""BGM をコードで合成する（オリジナル曲、外部素材なし）。

  python3 tools/music.py  →  out/music.wav
章の切り替わり（render/timeline.json）に合わせて、和音のパッド・ベース・分散和音・打楽器を重ねる。
"""
import json
import os
import wave
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt

ROOT = os.path.join(os.path.dirname(__file__), '..')
SR = 44100
BAR = 2.0                                           # 1小節 2秒（120 BPM、4拍子）
rng = np.random.default_rng(1)


def hz(n):                                          # MIDI ノート番号 → 周波数
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a, r, curve=2.0):
    """立ち上がり a 秒・余韻 r 秒の包絡線（n サンプル）。"""
    e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    e[:na] = np.linspace(0, 1, na) ** curve
    e[n - nr:] *= np.linspace(1, 0, nr) ** curve
    return e


class Mix:
    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.dry = np.zeros((self.n, 2))
        self.wet = np.zeros(self.n)                 # リバーブへ送る成分

    def add(self, t, sig, gain=1.0, pan=0.0, send=0.3):
        i = int(t * SR)
        if i >= self.n:
            return
        sig = sig[:self.n - i] * gain
        self.dry[i:i + len(sig), 0] += sig * np.sqrt(0.5 * (1 - pan))
        self.dry[i:i + len(sig), 1] += sig * np.sqrt(0.5 * (1 + pan))
        self.wet[i:i + len(sig)] += sig * send


def pad(freq, dur):
    """ゆっくり立ち上がる持続音：少しずつ音程をずらした倍音の束。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for det in (-0.006, 0.0, 0.007):
        for h, a in ((1, 1.0), (2, 0.42), (3, 0.2), (4, 0.09), (5, 0.04)):
            out += a * np.sin(2 * np.pi * freq * h * (1 + det) * t + rng.uniform(0, 6.28))
    return out * env(n, dur * 0.35, dur * 0.45) * (1 + 0.15 * np.sin(2 * np.pi * 0.21 * t)) / 5


def pluck(freq, dur=0.5, bright=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = sum(a * np.sin(2 * np.pi * freq * h * t) * np.exp(-t * (5 + 3 * h) / dur * 1.2)
              for h, a in ((1, 1.0), (2, 0.5 * bright), (3, 0.28 * bright), (4, 0.12 * bright)))
    return out * env(n, 0.004, 0.05)


def bass(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t)) * env(n, 0.08, 0.5)


def kick():
    t = np.arange(int(0.45 * SR)) / SR
    return np.sin(2 * np.pi * (42 * t + 60 * (1 - np.exp(-t * 28)) / 28)) * np.exp(-t * 9)


def noise(dur, lo, hi):
    x = rng.standard_normal(int(dur * SR))
    return sosfilt(butter(2, [lo, hi], btype='band', fs=SR, output='sos'), x)


def boom():
    t = np.arange(int(4.0 * SR)) / SR
    return np.sin(2 * np.pi * (34 * t + 50 * (1 - np.exp(-t * 6)) / 6)) * np.exp(-t * 1.1) + 0.25 * noise(4.0, 40, 400) * np.exp(-t * 3)


def riser(dur=3.0):
    x = noise(dur, 600, 7000)
    k = np.linspace(0, 1, len(x))
    return x * k ** 3 * (1 - k ** 40)


# 和音進行（各 2 小節）。D マイナーを基調に、結びは F メジャーの明るい響きへ
MINOR = [(38, [62, 65, 69, 72]), (34, [58, 62, 65, 69]), (41, [60, 65, 69, 72]), (36, [60, 64, 67, 74])]
MAJOR = [(41, [60, 65, 69, 72]), (36, [60, 64, 67, 72]), (38, [62, 65, 69, 72]), (34, [58, 62, 65, 70])]


def main():
    tl = json.load(open(os.path.join(ROOT, 'render', 'timeline.json')))
    starts = dict(zip([s['scene'] for s in tl], np.cumsum([0] + [s['duration'] for s in tl])))
    total = sum(s['duration'] for s in tl)
    m = Mix(total + 1.0)
    # 章ごとの音量設計（パッド, ベース, 分散和音, キック, 時計の刻み）
    level = dict(opening=(0.7, 0.0, 0.0, 0.0, 0.0), plan=(0.8, 0.6, 0.45, 0.0, 0.0), design=(0.9, 0.9, 0.8, 0.7, 0.0),
                 build=(0.7, 0.9, 0.5, 0.8, 0.9), tunnel=(1.0, 0.5, 0.25, 0.0, 0.0), research=(0.9, 1.0, 0.9, 0.8, 0.3),
                 ending=(1.1, 0.9, 0.6, 0.0, 0.0))
    for s in tl:
        name, t0, dur = s['scene'], starts[s['scene']], s['duration']
        lp, lb, la, lk, lt = level[name]
        prog = MAJOR if name == 'ending' else MINOR
        nb = int(np.ceil(dur / BAR))
        for b in range(0, nb, 2):                   # 2小節ごとに和音が変わる
            root, tones = prog[(b // 2) % 4]
            t, length = t0 + b * BAR, min(2 * BAR + 1.2, dur - b * BAR + 1.0)
            for i, note in enumerate(tones):
                m.add(t, pad(hz(note), length), 0.11 * lp, pan=(-0.6, 0.6, -0.25, 0.25)[i], send=0.6)
            if lb:
                m.add(t, bass(hz(root), min(2 * BAR, dur - b * BAR)), 0.085 * lb, send=0.05)
            if la:                                  # 8分音符の分散和音
                pat = [0, 2, 1, 3, 2, 1, 3, 2] if name != 'tunnel' else [0, None, None, 2, None, None, 3, None]
                for k in range(16):
                    tt = t + k * BAR / 8
                    if tt >= t0 + dur - 0.1 or pat[k % 8] is None:
                        continue
                    note = tones[pat[k % 8]] + (12 if k % 16 >= 8 and name in ('design', 'research') else 0)
                    m.add(tt, pluck(hz(note + 12), 0.6 if name != 'tunnel' else 2.0, 0.6 + 0.4 * la), 0.075 * la,
                          pan=0.5 * np.sin(k * 1.3), send=0.45 if name != 'tunnel' else 0.9)
            if lk:
                for k in range(4):                  # 1・3拍目のキック
                    tt = t + k * BAR / 2
                    if tt < t0 + dur - 0.3:
                        m.add(tt, kick(), 0.2 * lk, send=0.04)
            if lt:                                  # 時計の刻み（施工章）
                for k in range(32):
                    tt = t + k * BAR / 8
                    if tt < t0 + dur - 0.1:
                        tick = noise(0.03, 3000, 9000) * np.exp(-np.arange(int(0.03 * SR)) / SR * 160)
                        m.add(tt, tick, (0.05 if k % 2 else 0.09) * lt, pan=0.3 * (-1) ** k, send=0.15)
        if t0 > 0:                                  # 章の頭：上昇音 → 低い打音
            m.add(t0 - 3.0, riser(), 0.06, send=0.5)
            m.add(t0, boom(), 0.3, send=0.25)
    # 導入：列車が通過する風切り音
    w = noise(9.0, 80, 2600)
    k = np.linspace(0, 1, len(w))
    m.add(2.5, w * np.exp(-((k - 0.72) / 0.16) ** 2), 0.3, send=0.3)
    m.add(0.0, boom(), 0.3, send=0.3)
    # 結び：最後の和音を伸ばす
    for i, note in enumerate([53, 60, 65, 69, 72, 77]):
        m.add(total - 7.5, pad(hz(note), 8.2), 0.12, pan=(i - 2.5) / 3, send=0.7)

    # リバーブ（減衰する雑音との畳み込み）
    n_ir = int(3.2 * SR)
    t_ir = np.arange(n_ir) / SR
    out = m.dry.copy()
    for ch in (0, 1):
        ir = rng.standard_normal(n_ir) * np.exp(-t_ir * 2.1) * (t_ir > 0.012)
        ir = sosfilt(butter(2, [180, 6500], btype='band', fs=SR, output='sos'), ir)
        out[:, ch] += 0.055 * fftconvolve(m.wet, ir)[:m.n]
    fade_out = np.clip((total - np.arange(m.n) / SR) / 3.5, 0, 1) ** 1.5
    out *= (np.clip(np.arange(m.n) / SR / 0.8, 0, 1) * fade_out)[:, None]
    out = np.tanh(out * 0.85 / np.percentile(np.abs(out), 99.95)) * 0.9      # 軽いソフトクリップ（歪ませない）
    path = os.path.join(ROOT, 'out', 'music.wav')
    with wave.open(path, 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes((out[:int(total * SR)] * 32767).astype(np.int16).tobytes())
    print(f'{path}  {total:.0f} 秒')


if __name__ == '__main__':
    main()
