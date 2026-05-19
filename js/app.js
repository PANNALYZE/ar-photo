/**
 * sprite-anim — A-Frameカスタムコンポーネント
 * スプライトシート画像のUVをフレーム単位で切り替えてアニメーション表示する
 *
 * 属性:
 *   src         — スプライトシート画像のパス
 *   columns     — アトラスの列数
 *   rows        — アトラスの行数
 *   row         — 再生するアニメーション行
 *   frames      — その行のフレーム数
 *   fps         — フレームレート
 *   planeWidth  — 表示プレーンの幅(m)
 *   planeHeight — 表示プレーンの高さ(m)
 *   chromaKey   — 黒透過処理を行うかどうか
 *
 * 黒背景のスプライトシートをCanvasで透過処理してからテクスチャ化する。
 * texture.repeat と texture.offset でUVを切り替えてフレームを更新する。
 */
AFRAME.registerComponent("sprite-anim", {
  schema: {
    src: { type: "string" },
    columns: { type: "number", default: 8 },
    rows: { type: "number", default: 9 },
    row: { type: "number", default: 0 },
    frames: { type: "number", default: 6 },
    fps: { type: "number", default: 8 },
    planeWidth: { type: "number", default: 0.92 },
    planeHeight: { type: "number", default: 1.0 },
    chromaKey: { type: "boolean", default: true },
    chromaThreshold: { type: "number", default: 25 },
  },

  init: function () {
    var self = this;
    this.currentFrame = 0;
    this.elapsed = 0;

    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      var canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Chroma key: 黒に近いピクセルをα=0にする
      if (self.data.chromaKey) {
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var data = imageData.data;
        var t = self.data.chromaThreshold;
        for (var i = 0; i < data.length; i += 4) {
          if (data[i] < t && data[i + 1] < t && data[i + 2] < t) {
            data[i + 3] = 0;
          }
        }
        ctx.putImageData(imageData, 0, 0);
      }

      var texture = new THREE.CanvasTexture(canvas);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.repeat.set(1 / self.data.columns, 1 / self.data.rows);
      // 1行目(row 0)から表示
      texture.offset.set(0, 1 - 1 / self.data.rows);

      var geometry = new THREE.PlaneGeometry(
        self.data.planeWidth,
        self.data.planeHeight
      );
      var material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
      });
      var mesh = new THREE.Mesh(geometry, material);
      self.el.setObject3D("mesh", mesh);

      self.texture = texture;
      self.material = material;
      self.geometry = geometry;
      self.updateUV();
    };
    img.onerror = function () {
      console.error("sprite-anim: failed to load image", self.data.src);
    };
    img.src = this.data.src;
  },

  update: function (oldData) {
    if (!this.texture) return;
    // row や frames が変わったら現在フレームをリセット
    if (oldData && (oldData.row !== this.data.row || oldData.frames !== this.data.frames)) {
      this.currentFrame = 0;
      this.elapsed = 0;
      this.updateUV();
    }
    this.texture.repeat.set(1 / this.data.columns, 1 / this.data.rows);
  },

  updateUV: function () {
    if (!this.texture) return;
    var col = this.currentFrame;
    var row = this.data.row;
    this.texture.offset.x = col / this.data.columns;
    this.texture.offset.y = 1 - (row + 1) / this.data.rows;
  },

  tick: function (time, delta) {
    if (!this.texture) return;
    this.elapsed += delta;
    var frameDuration = 1000 / this.data.fps;
    if (this.elapsed >= frameDuration) {
      // 経過時間からフレーム進める数を計算
      var advance = Math.floor(this.elapsed / frameDuration);
      this.elapsed -= advance * frameDuration;
      this.currentFrame = (this.currentFrame + advance) % this.data.frames;
      this.updateUV();
    }
  },

  remove: function () {
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
    if (this.texture) this.texture.dispose();
    this.el.removeObject3D("mesh");
  },
});

// ===================================================================
// メインアプリロジック
// ===================================================================
document.addEventListener("DOMContentLoaded", function () {
  var scene = document.querySelector("a-scene");
  var loadingScreen = document.getElementById("loading-screen");
  var scanHint = document.getElementById("scan-hint");
  var captureBtn = document.getElementById("capture-btn");
  var photoModal = document.getElementById("photo-modal");
  var photoPreview = document.getElementById("photo-preview");
  var closeModalBtn = document.getElementById("close-modal-btn");
  var target = document.querySelector("[mindar-image-target]");

  // --- AR Scene Ready ---
  scene.addEventListener("arReady", function () {
    loadingScreen.style.display = "none";
    scanHint.style.display = "block";
    captureBtn.style.display = "block";
  });

  // --- AR Error ---
  scene.addEventListener("arError", function () {
    loadingScreen.querySelector("p").textContent =
      "カメラの起動に失敗しました。ブラウザの設定からカメラの使用を許可してください。";
    loadingScreen.querySelector(".spinner").style.display = "none";
  });

  // --- Target Found / Lost ---
  target.addEventListener("targetFound", function () {
    scanHint.style.display = "none";
  });

  target.addEventListener("targetLost", function () {
    scanHint.style.display = "block";
  });

  // --- Photo Capture ---
  captureBtn.addEventListener("click", function () {
    capturePhoto();
  });

  function capturePhoto() {
    var video = document.querySelector("video");
    if (!video) return;

    var renderer = scene.renderer;
    var arCanvas = renderer.domElement;
    if (!arCanvas) return;

    // 強制レンダー(現在フレームをcanvasに反映)
    var camera = scene.camera;
    var sceneObj = scene.object3D;
    renderer.render(sceneObj, camera);

    // 合成キャンバス
    var canvas = document.createElement("canvas");
    var width = arCanvas.width;
    var height = arCanvas.height;
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");

    // 1: ビデオフレームを描画(センタークロップ)
    var videoAspect = video.videoWidth / video.videoHeight;
    var canvasAspect = width / height;
    var sx, sy, sw, sh;

    if (videoAspect > canvasAspect) {
      sh = video.videoHeight;
      sw = sh * canvasAspect;
      sx = (video.videoWidth - sw) / 2;
      sy = 0;
    } else {
      sw = video.videoWidth;
      sh = sw / canvasAspect;
      sx = 0;
      sy = (video.videoHeight - sh) / 2;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);

    // 2: A-Frame ARオーバーレイを上書き
    try {
      ctx.drawImage(arCanvas, 0, 0, width, height);
    } catch (e) {
      console.error("AR canvas draw failed:", e);
    }

    // 3: Blob化(iOS対応)
    canvas.toBlob(
      function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        photoPreview.src = url;
        var downloadBtn = document.getElementById("download-btn");
        downloadBtn.href = url;
        photoModal.style.display = "flex";

        canvas.width = 0;
        canvas.height = 0;
      },
      "image/jpeg",
      0.92
    );
  }

  // --- Close Modal ---
  closeModalBtn.addEventListener("click", function () {
    photoModal.style.display = "none";
    if (photoPreview.src.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview.src);
    }
    photoPreview.src = "";
  });
});
