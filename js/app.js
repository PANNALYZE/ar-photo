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
    // Get the video element created by MindAR
    var video = document.querySelector("video");
    if (!video) return;

    // Get the A-Frame renderer and canvas
    var renderer = scene.renderer;
    var arCanvas = renderer.domElement;
    if (!arCanvas) return;

    // Force a render right now so the canvas has the current frame
    var camera = scene.camera;
    var sceneObj = scene.object3D;
    renderer.render(sceneObj, camera);

    // Create composite canvas
    var canvas = document.createElement("canvas");
    var width = arCanvas.width;
    var height = arCanvas.height;
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");

    // Step 1: Draw video frame (fill canvas, center-crop to match aspect ratio)
    var videoAspect = video.videoWidth / video.videoHeight;
    var canvasAspect = width / height;
    var sx, sy, sw, sh;

    if (videoAspect > canvasAspect) {
      // Video is wider — crop sides
      sh = video.videoHeight;
      sw = sh * canvasAspect;
      sx = (video.videoWidth - sw) / 2;
      sy = 0;
    } else {
      // Video is taller — crop top/bottom
      sw = video.videoWidth;
      sh = sw / canvasAspect;
      sx = 0;
      sy = (video.videoHeight - sh) / 2;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);

    // Step 2: Draw A-Frame AR overlay on top (contains the AR character)
    try {
      ctx.drawImage(arCanvas, 0, 0, width, height);
    } catch (e) {
      console.error("AR canvas draw failed:", e);
    }

    // Step 3: Export as blob (iOS-safe, avoids toDataURL memory issues)
    canvas.toBlob(
      function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        photoPreview.src = url;
        // Set download link
        var downloadBtn = document.getElementById("download-btn");
        downloadBtn.href = url;
        photoModal.style.display = "flex";

        // Free canvas memory
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
    // Revoke previous blob URL to free memory
    if (photoPreview.src.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview.src);
    }
    photoPreview.src = "";
  });
});
