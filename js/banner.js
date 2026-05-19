/**
 * banner — A-Frameカスタムコンポーネント
 *
 * Canvasに動的にテキストを描画して、ふきだし風の横断幕としてAR上に表示する。
 * テキストの "|" で改行する(複数行対応)。
 *
 * 属性:
 *   text         — 表示テキスト("|"区切りで改行)
 *   bgColor      — 背景色
 *   textColor    — 文字色
 *   borderColor  — 枠線色
 *   planeWidth   — 表示プレーン幅(m)
 *   planeHeight  — 表示プレーン高さ(m)
 *   canvasWidth  — Canvas解像度(px)
 *   canvasHeight — Canvas解像度(px)
 *   tailDown     — true なら吹き出しの尻尾を下向きに(キャラ側)
 */
AFRAME.registerComponent("banner", {
  schema: {
    text: { type: "string", default: "おめでとう！" },
    bgColor: { type: "color", default: "#fff8e1" },
    textColor: { type: "color", default: "#d84315" },
    borderColor: { type: "color", default: "#ff7043" },
    planeWidth: { type: "number", default: 1.9 },
    planeHeight: { type: "number", default: 0.6 },
    canvasWidth: { type: "number", default: 1200 },
    canvasHeight: { type: "number", default: 400 },
    tailDown: { type: "boolean", default: true },
  },

  init: function () {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.data.canvasWidth;
    this.canvas.height = this.data.canvasHeight;
    this.ctx = this.canvas.getContext("2d");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.geometry = new THREE.PlaneGeometry(
      this.data.planeWidth,
      this.data.planeHeight
    );
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    var mesh = new THREE.Mesh(this.geometry, this.material);
    this.el.setObject3D("mesh", mesh);

    this.draw();
  },

  update: function (oldData) {
    if (!this.texture) return;
    if (oldData && oldData.canvasWidth !== this.data.canvasWidth) {
      this.canvas.width = this.data.canvasWidth;
    }
    if (oldData && oldData.canvasHeight !== this.data.canvasHeight) {
      this.canvas.height = this.data.canvasHeight;
    }
    if (
      oldData &&
      (oldData.planeWidth !== this.data.planeWidth ||
        oldData.planeHeight !== this.data.planeHeight)
    ) {
      this.geometry.dispose();
      this.geometry = new THREE.PlaneGeometry(
        this.data.planeWidth,
        this.data.planeHeight
      );
      this.el.getObject3D("mesh").geometry = this.geometry;
    }
    this.draw();
  },

  draw: function () {
    var ctx = this.ctx;
    var w = this.canvas.width;
    var h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // 余白
    var pad = 16;
    // 吹き出し本体の領域(尻尾分を下に確保)
    var tailHeight = this.data.tailDown ? h * 0.15 : 0;
    var bubbleX = pad;
    var bubbleY = pad;
    var bubbleW = w - pad * 2;
    var bubbleH = h - pad * 2 - tailHeight;
    var radius = Math.min(bubbleH / 2, 60);

    // ふきだし本体(角丸 + 尻尾)パス
    this.bubblePath(ctx, bubbleX, bubbleY, bubbleW, bubbleH, radius, this.data.tailDown);

    // 影
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = this.data.bgColor;
    ctx.fill();
    ctx.restore();

    // 枠線
    ctx.lineWidth = 8;
    ctx.strokeStyle = this.data.borderColor;
    this.bubblePath(ctx, bubbleX, bubbleY, bubbleW, bubbleH, radius, this.data.tailDown);
    ctx.stroke();

    // テキスト描画(複数行 "|" で改行)
    var lines = (this.data.text || "").split("|");
    var fontFamily = '"Yu Gothic", "Hiragino Sans", "Meiryo", sans-serif';
    var maxTextWidth = bubbleW - 60;
    var availableHeight = bubbleH - 30;
    var lineGap = 1.15;

    // フォントサイズを自動で決定: 各行が幅に収まる & 合計高さが収まる最大サイズ
    var maxFontSize = bubbleH / (lines.length * lineGap + 0.3);
    var minFontSize = 24;
    var fontSize = maxFontSize;

    function fits(size) {
      ctx.font = "bold " + size + "px " + fontFamily;
      for (var i = 0; i < lines.length; i++) {
        if (ctx.measureText(lines[i]).width > maxTextWidth) return false;
      }
      var totalH = lines.length * size * lineGap;
      return totalH <= availableHeight;
    }

    while (fontSize > minFontSize && !fits(fontSize)) {
      fontSize -= 2;
    }
    ctx.font = "bold " + fontSize + "px " + fontFamily;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var totalH = lines.length * fontSize * lineGap;
    var startY = bubbleY + bubbleH / 2 - totalH / 2 + (fontSize * lineGap) / 2;

    ctx.lineWidth = Math.max(4, fontSize * 0.1);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";

    for (var j = 0; j < lines.length; j++) {
      var ty = startY + j * fontSize * lineGap;
      ctx.strokeText(lines[j], w / 2, ty);
      ctx.fillStyle = this.data.textColor;
      ctx.fillText(lines[j], w / 2, ty);
    }

    this.texture.needsUpdate = true;
  },

  bubblePath: function (ctx, x, y, w, h, r, tailDown) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);

    if (tailDown) {
      // 下辺中央あたりに尻尾
      var tailBaseLeft = x + w * 0.52;
      var tailBaseRight = x + w * 0.62;
      var tailTip = x + w * 0.55;
      var tailH = (this.canvas.height - y - h) * 0.85;
      ctx.lineTo(tailBaseRight, y + h);
      ctx.lineTo(tailTip, y + h + tailH);
      ctx.lineTo(tailBaseLeft, y + h);
    }

    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  },

  remove: function () {
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
    if (this.texture) this.texture.dispose();
    this.el.removeObject3D("mesh");
  },
});
