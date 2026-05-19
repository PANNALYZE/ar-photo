/**
 * kirika-behavior — A-Frameカスタムコンポーネント
 *
 * sprite-animと組み合わせて、Codex Pets風のランダム行動を実現する。
 * 一定時間ごとにアクションを切り替え、走るアニメは左右に移動も行う。
 *
 * 撮影ボタンを押した瞬間、wavingポーズで停止する。
 */
AFRAME.registerComponent("kirika-behavior", {
  schema: {
    moveSpeed: { type: "number", default: 0.3 }, // 1秒あたりの移動量(m)
    moveRange: { type: "number", default: 0.6 }, // 左右の移動範囲(±m)
  },

  init: function () {
    this.spriteEl = this.el;
    this.basePosition = this.el.object3D.position.x;
    this.actionTimer = 0;
    this.actionDuration = 0;
    this.currentAction = null;
    this.moveDirection = 0;

    // アクション定義
    this.actions = [
      { name: "idle",         row: 0, frames: 6, fps: 6,  minDur: 1500, maxDur: 3000, move: 0 },
      { name: "waving",       row: 3, frames: 4, fps: 6,  minDur: 1500, maxDur: 2500, move: 0 },
      { name: "jumping",      row: 4, frames: 5, fps: 8,  minDur: 1200, maxDur: 1800, move: 0 },
      { name: "runningRight", row: 1, frames: 8, fps: 10, minDur: 1500, maxDur: 2500, move: 1 },
      { name: "runningLeft",  row: 2, frames: 8, fps: 10, minDur: 1500, maxDur: 2500, move: -1 },
      { name: "waiting",      row: 6, frames: 6, fps: 6,  minDur: 1500, maxDur: 3000, move: 0 },
    ];

    var self = this;
    // 撮影ボタン押下時:そのタイミングのフレーム/位置でフリーズ
    var captureBtn = document.getElementById("capture-btn");
    if (captureBtn) {
      // pointerdown は click より先に発火する → 確実に撮影前にフリーズ
      captureBtn.addEventListener("pointerdown", function () {
        self.freeze();
      });
    }
    // モーダルを閉じたら再開
    var closeBtn = document.getElementById("close-modal-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        self.unfreeze();
      });
    }

    this.pickNextAction();
  },

  pickNextAction: function () {
    var idx = Math.floor(Math.random() * this.actions.length);
    var action = this.actions[idx];
    this.applyAction(action);
    this.actionDuration = action.minDur + Math.random() * (action.maxDur - action.minDur);
    this.actionTimer = 0;
  },

  applyAction: function (action) {
    this.currentAction = action;
    this.moveDirection = action.move;
    this.spriteEl.setAttribute("sprite-anim", {
      row: action.row,
      frames: action.frames,
      fps: action.fps,
    });
  },

  freeze: function () {
    if (this.frozen) return;
    this.frozen = true;
    // sprite-animのtickをno-opに置き換え、現在フレームのまま静止させる
    var spr = this.spriteEl.components["sprite-anim"];
    if (spr && spr.tick) {
      this._originalSpriteTick = spr.tick;
      spr.tick = function () {};
    }
  },

  unfreeze: function () {
    if (!this.frozen) return;
    this.frozen = false;
    var spr = this.spriteEl.components["sprite-anim"];
    if (spr && this._originalSpriteTick) {
      spr.tick = this._originalSpriteTick;
      this._originalSpriteTick = null;
    }
  },

  lockAction: function (name, duration) {
    var action = this.actions.find(function (a) { return a.name === name; });
    if (!action) return;
    this.applyAction(action);
    this.actionDuration = duration;
    this.actionTimer = 0;
    this.moveDirection = 0;
    this.locked = true;
    var self = this;
    setTimeout(function () { self.locked = false; }, duration);
  },

  tick: function (time, delta) {
    if (!this.currentAction) return;
    if (this.frozen) return; // 撮影中は完全停止
    this.actionTimer += delta;

    // 左右移動処理
    if (this.moveDirection !== 0) {
      var dx = this.moveDirection * this.data.moveSpeed * (delta / 1000);
      var newX = this.el.object3D.position.x + dx;
      // 範囲を越えたら反転
      if (newX > this.basePosition + this.data.moveRange) {
        newX = this.basePosition + this.data.moveRange;
        this.moveDirection = -1;
        this.applyAction(this.actions.find(function (a) { return a.name === "runningLeft"; }));
      } else if (newX < this.basePosition - this.data.moveRange) {
        newX = this.basePosition - this.data.moveRange;
        this.moveDirection = 1;
        this.applyAction(this.actions.find(function (a) { return a.name === "runningRight"; }));
      }
      this.el.object3D.position.x = newX;
    }

    // 次のアクションへ
    if (!this.locked && this.actionTimer >= this.actionDuration) {
      this.pickNextAction();
    }
  },
});
