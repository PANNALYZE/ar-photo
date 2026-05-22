/**
 * sprite-quality — sprite-animで作られたmaterialを後から調整するパッチ
 *
 * 半透明ブレンディングで色が薄く見える問題を解決するため:
 *   transparent: false / alphaTest: 0.5
 * に切り替えてエッジを「不透明 or 完全透明」のクッキリ表示にする。
 *
 * sprite-anim と同じ要素に付けるだけで動作する。
 */
AFRAME.registerComponent("sprite-quality", {
  init: function () {
    var self = this;
    this._applied = false;

    // sprite-animがmaterialを作るまでポーリングして待つ
    this._check = function () {
      if (self._applied) return;
      var spr = self.el.components["sprite-anim"];
      if (spr && spr.material) {
        self.applyFix(spr);
        self._applied = true;
        return true;
      }
      return false;
    };

    if (!this._check()) {
      this._interval = setInterval(function () {
        if (self._check()) clearInterval(self._interval);
      }, 100);
      // 安全弁: 10秒で諦める
      setTimeout(function () {
        if (self._interval) clearInterval(self._interval);
      }, 10000);
    }
  },

  applyFix: function (spr) {
    var mat = spr.material;
    // 半透明合成は維持(エッジを滑らかに保つため)
    // alphaTestは低めにして、ほぼ透明な部分のみカット
    mat.transparent = true;
    mat.alphaTest = 0.1;
    mat.needsUpdate = true;

    // テクスチャの色空間をsRGBに設定(A-FrameのcolorManagement: trueとの整合)
    // これをやらないとCanvasTexture(デフォルトNoColorSpace)が薄く描画される
    var tex = spr.texture;
    if (tex) {
      if (THREE.SRGBColorSpace !== undefined) {
        // Three.js r152+
        tex.colorSpace = THREE.SRGBColorSpace;
      } else if (THREE.sRGBEncoding !== undefined) {
        // Three.js r151以前
        tex.encoding = THREE.sRGBEncoding;
      }
      tex.needsUpdate = true;
    }
  },

  remove: function () {
    if (this._interval) clearInterval(this._interval);
  },
});
