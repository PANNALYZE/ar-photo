/**
 * orientation-fix — A-Frameカスタムコンポーネント
 *
 * 画面の向き(縦/横)が変わったときにMindARを再初期化する。
 * MindARは起動時のカメラ映像のアスペクト比でAR投影を計算するため、
 * 回転後はそのままだとARがズレる/表示されない。
 *
 * <a-scene> に付けて使う。
 */
AFRAME.registerComponent("orientation-fix", {
  init: function () {
    var self = this;
    this.timer = null;

    this.onChange = function () {
      if (self.timer) clearTimeout(self.timer);
      // 画面サイズが確定するまで少し待ってから再起動
      self.timer = setTimeout(function () {
        self.restartMindAR();
      }, 700);
    };

    // orientationchange と screen.orientation の両方を監視
    window.addEventListener("orientationchange", this.onChange);
    if (window.screen && window.screen.orientation) {
      try {
        window.screen.orientation.addEventListener("change", this.onChange);
      } catch (e) {
        /* 一部ブラウザ非対応 */
      }
    }
  },

  restartMindAR: function () {
    var sys = this.el.systems["mindar-image-system"];
    if (!sys) {
      // システムが取れない場合はページ再読込でリセット
      window.location.reload();
      return;
    }
    try {
      sys.stop();
    } catch (e) {
      /* 停止失敗は無視 */
    }
    // 停止処理が落ち着いてから再開
    setTimeout(function () {
      try {
        sys.start();
      } catch (e) {
        console.error("MindAR restart failed, reloading:", e);
        window.location.reload();
      }
    }, 300);
  },

  remove: function () {
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("orientationchange", this.onChange);
    if (window.screen && window.screen.orientation) {
      try {
        window.screen.orientation.removeEventListener("change", this.onChange);
      } catch (e) {
        /* 非対応 */
      }
    }
  },
});
