/**
 * pendulum.js — 単振り子 物理演算コントローラー
 *
 * 運動方程式（非線形・連続系）:
 *   θ'' = -(g / L) * sin(θ) - b * θ'
 *
 *   θ  : 鉛直からの角度 [rad]
 *   g  : 重力加速度     9.81 m/s²
 *   L  : 振り子長さ     1.5 m
 *   b  : 空気抵抗係数   0.002 (ごく小さい減衰)
 *
 * 数値積分: 4次ルンゲ・クッタ法 (RK4)
 *
 * 周期（小角近似）: T ≈ 2π√(L/g) ≈ 2.46 s
 * ただし28°の初期角度では非線形補正により約2%長くなる。
 */

import { CONFIG, G } from "./config.js";

// ─── PendulumController クラス ─────────────────────────────
export class PendulumController {
  /**
   * @param {number} period - 目標とする周期 [s]
   * @param {number} xOffset - X軸上の配置位置
   * @param {number} mass - 振り子の質量（デフォルト1.0）
   */
  constructor(period = 20.0, xOffset = 0, mass = 1.0) {
    this.period = period;
    this.xOffset = xOffset;
    this.mass = mass;

    // 共通の重力 G の元で指定の周期になるよう紐の長さを動的計算
    this.L = G * Math.pow(this.period / (2 * Math.PI), 2);
    // 振幅に到達するために必要な最大角度
    this.thetaMax = Math.asin(CONFIG.PHYSICS.TARGET_AMPLITUDE / this.L);

    // リロード時に「画面真ん中の最下点」からスタートさせる
    this._theta = 0;
    // 力学的エネルギー保存則に基づく最高点到達に必要な中心での速度
    this._omega = Math.sqrt(((2 * G) / this.L) * (1 - Math.cos(this.thetaMax)));
    this._lastTime = null; // 前フレームのタイムスタンプ [ms]
    this._crossedCenter = false; // 最下点通過フラグ
  }

  // ─── 状態微分関数 ─────────────────────────────────────────
  _derivatives(theta, omega) {
    const dTheta = omega;
    const dOmega =
      -(G / this.L) * Math.sin(theta) - CONFIG.PHYSICS.DAMPING * omega;
    return [dTheta, dOmega];
  }

  // ─── RK4 積分 ─────────────────────────────────────────────
  _rk4Step(theta, omega, dt) {
    const [k1t, k1o] = this._derivatives(theta, omega);
    const [k2t, k2o] = this._derivatives(
      theta + 0.5 * dt * k1t,
      omega + 0.5 * dt * k1o,
    );
    const [k3t, k3o] = this._derivatives(
      theta + 0.5 * dt * k2t,
      omega + 0.5 * dt * k2o,
    );
    const [k4t, k4o] = this._derivatives(theta + dt * k3t, omega + dt * k3o);

    const newTheta = theta + (dt / 6) * (k1t + 2 * k2t + 2 * k3t + k4t);
    const newOmega = omega + (dt / 6) * (k1o + 2 * k2o + 2 * k3o + k4o);

    return [newTheta, newOmega];
  }

  /**
   * requestAnimationFrame のコールバックから毎フレーム呼ぶ
   * @param {DOMHighResTimeStamp} timestamp - rAF が渡すタイムスタンプ [ms]
   */
  update(timestamp) {
    // typeof ガード: 引数なし直接呼び出し（tick()）で
    // timestamp = undefined になる場合は NaN 伝播を防ぐためスキップ
    if (typeof timestamp !== "number") return;

    // 初回フレームはスキップ（dt が不定のため）
    if (this._lastTime === null) {
      this._lastTime = timestamp;
      return;
    }

    const rawDt = (timestamp - this._lastTime) / 1000; // ms → s
    this._lastTime = timestamp;

    // タブが非アクティブから復帰した場合などに dt が巨大になるのを防ぐ
    const dt = Math.min(rawDt, CONFIG.PHYSICS.DT_CAP);
    const prevTheta = this._theta;

    // RK4 で状態を 1 ステップ更新
    [this._theta, this._omega] = this._rk4Step(this._theta, this._omega, dt);

    // 0のライン（真下）をまたいかを判定
    if (prevTheta !== 0 && Math.sign(prevTheta) !== Math.sign(this._theta)) {
      this._crossedCenter = true;
    }
  }

  /** 最下点通過フラグを取得し、同時にフラグを下ろす */
  popCrossedCenter() {
    const crossed = this._crossedCenter;
    this._crossedCenter = false;
    return crossed;
  }

  /** 現在の物理角度 θ [rad] を返す */
  getAngle() {
    return this._theta;
  }

  /**
   * ボブの線速度 [m/s] を返す
   * Z軸方向（スイング方向）の速度成分を算出。中心（θ=0）で最大になる。
   */
  getVelocity() {
    return this._omega * this.L;
  }

  /**
   * 振り子の質量を返す
   */
  getMass() {
    return this.mass;
  }
}
