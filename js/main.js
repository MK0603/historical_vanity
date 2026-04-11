/**
 * main.js — エントリーポイント (Spotlight Scene)
 *
 * 担当：
 *  1. Three.js WebGLRenderer セットアップ
 *  2. MainScene の初期化
 *  3. アニメーションループ
 *  4. リサイズ / マウスイベント
 *  5. ローディング演出
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MainScene } from "./scene.js?v=2";
import { PendulumController } from "./pendulum.js?v=2";
import {
  getViewport,
  normalizeMousePosition,
  animateLoadingBar,
  FpsCounter,
} from "./utils.js";
import { CONFIG } from "./config.js";

// ============================================================
// DOM 参照
// ============================================================
const canvasEl = /** @type {HTMLCanvasElement} */ (
  document.getElementById("webgl-canvas")
);
const loadingScreen = document.getElementById("loading-screen");
const loadingBarFill = document.getElementById("loading-bar-fill");
const siteTitle = document.getElementById("site-title");
const creditEl = document.getElementById("credit");

// ============================================================
// Renderer
// ============================================================
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});

function applyRendererSize() {
  const vp = getViewport();
  renderer.setSize(vp.width, vp.height);
  renderer.setPixelRatio(vp.pixelRatio);
}

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
applyRendererSize();

// ============================================================
// シーン初期化
// ============================================================
const mainScene = new MainScene(renderer);

// ============================================================
// 振り子 物理コントローラー（config.jsから動的生成）
// ============================================================
const pendulums = CONFIG.PENDULUMS.map(
  (p) => new PendulumController(p.period, p.xOffset, p.mass),
);

// scene 側に長さと位置、質量を渡して3Dモデルを構築させる
mainScene.initPendulums(
  pendulums.map((p) => ({ L: p.L, xOffset: p.xOffset, mass: p.getMass() })),
);
// ============================================================
// OrbitControls (カメラぐりぐり操作)
// ============================================================
const controls = new OrbitControls(mainScene.camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 2.5, 0); // 振り子の最下点を中心に回転する

// ============================================================
// FPS カウンター
// ============================================================
const fpsCounter = new FpsCounter();

// ============================================================
// アニメーションループ
// ============================================================
let lastTime = null;

/** @param {DOMHighResTimeStamp} timestamp */
function tick(timestamp) {
  requestAnimationFrame(tick);

  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // 最大dtを制限
  lastTime = timestamp;

  const angles = [];
  const velocities = [];
  for (let i = 0; i < pendulums.length; i++) {
    const p = pendulums[i];
    p.update(timestamp); // RK4 物理演算
    angles.push(p.getAngle());
    velocities.push(p.getVelocity());
  }

  mainScene.setPendulumStates(angles, velocities); // 角度と速度をシーンに反映
  mainScene.updateRipples(dt); // 波紋のアニメーション物理更新

  controls.update(); // Damping 適用のため毎フレーム更新
  fpsCounter.tick();
  mainScene.update(dt);
  mainScene.render();
}

// ============================================================
// リサイズ
// ============================================================
function handleResize() {
  applyRendererSize();
  const vp = getViewport();
  mainScene.resize(vp.width, vp.height);
}

window.addEventListener("resize", handleResize);

// ============================================================
// ローディング演出 → メイン表示
// ============================================================
function handleLoadingComplete() {
  loadingScreen.classList.add("hidden");

  // UI フェードイン
  requestAnimationFrame(() => {
    siteTitle?.classList.add("visible");
    creditEl?.classList.add("visible");
  });
}

animateLoadingBar(loadingBarFill, handleLoadingComplete);

// ============================================================
// ループ開始
// ============================================================
requestAnimationFrame(tick);
