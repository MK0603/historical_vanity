/**
 * utils.js — Three.js サイト用ユーティリティ
 */

/**
 * ウィンドウサイズを正規化して返す
 * @returns {{ width: number, height: number, pixelRatio: number }}
 */
export function getViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: Math.min(window.devicePixelRatio, 2),
  };
}

/**
 * マウス座標を -1 〜 +1 の正規化デバイス座標へ変換
 * @param {MouseEvent} event
 * @returns {{ x: number, y: number }}
 */
export function normalizeMousePosition(event) {
  return {
    x: (event.clientX / window.innerWidth) * 2 - 1,
    y: -(event.clientY / window.innerHeight) * 2 + 1,
  };
}

/**
 * 線形補間 (lerp)
 * @param {number} a - 開始値
 * @param {number} b - 終了値
 * @param {number} t - 補間係数 (0〜1)
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 値を min 〜 max の範囲にクランプ
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * min 〜 max の範囲でランダムな float を返す
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * ローディングバーを 0%〜100% まで擬似的にアニメーション
 * @param {HTMLElement} fillEl
 * @param {Function} onComplete
 */
export function animateLoadingBar(fillEl, onComplete) {
  let progress = 0;
  const interval = setInterval(() => {
    progress += randomRange(5, 18);
    if (progress >= 100) {
      progress = 100;
      fillEl.style.width = `${progress}%`;
      clearInterval(interval);
      setTimeout(onComplete, 300);
      return;
    }
    fillEl.style.width = `${progress}%`;
  }, 120);
}

/**
 * FPS カウンター
 */
export class FpsCounter {
  constructor() {
    this._frames = 0;
    this._lastTime = performance.now();
    this.fps = 60;
  }

  /** フレームごとに呼び出す */
  tick() {
    this._frames++;
    const now = performance.now();
    if (now - this._lastTime >= 500) {
      this.fps = Math.round((this._frames * 1000) / (now - this._lastTime));
      this._frames = 0;
      this._lastTime = now;
    }
  }
}
