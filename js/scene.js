/**
 * scene.js — Pendulum Scene
 *
 * 構成:
 *  - 完全な暗黒空間（床なし・背景なし）
 *  - 真上からの白い SpotLight 1つ
 *  - Three.js 3D 振り子（PBR 金属マテリアル）
 *    - 天井マウントバー + ピボットノブ
 *    - 細いロッド（CylinderGeometry）
 *    - 銀色メタリック球（MeshStandardMaterial: metalness=1, roughness=0.07）
 *  - SetPendulumAngle(θ) で毎フレーム外部から角度を受け取る
 */

import * as THREE from "three";
import { GPUComputationRenderer } from "three/addons/misc/GPUComputationRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CONFIG } from "./config.js";
import { lerp } from "./utils.js";

// 計算用フラグメントシェーダー（波の伝播とドロップの入力を行う）
const heightmapFragmentShader = `
uniform vec2 dropCoords[16];
uniform float dropStrength[16];
uniform float dropRadius[16];
uniform int numDrops;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 info = texture2D( heightmap, uv );

  // 隣接ピクセル情報のフェッチ
  vec2 dx = vec2( 1.0 / resolution.x, 0.0 );
  vec2 dy = vec2( 0.0, 1.0 / resolution.y );
  
  float average = (
    texture2D( heightmap, uv - dx ).r +
    texture2D( heightmap, uv + dx ).r +
    texture2D( heightmap, uv - dy ).r +
    texture2D( heightmap, uv + dy ).r
  ) * 0.25;
  
  // 波動方程式: 速度(info.g) と 高さ(info.r) の更新
  info.g += ( average - info.r ) * ${CONFIG.WATER.WAVE_SPEED.toFixed(1)}; 
  info.g *= ${CONFIG.WATER.WAVE_DAMPING.toFixed(3)}; // Damping: 波紋を美しく長く残す
  info.r += info.g;
  
  // マウス・振り子による衝撃処理
  for(int i = 0; i < 16; i++) {
    if(i >= numDrops) break;
    vec2 dropUV = dropCoords[i];
    
    vec2 d = abs(uv - dropUV);
    if(d.x > 0.5) d.x = 1.0 - d.x;
    
    // U方向はV方向の2倍の物理的広さを持つため、見た目の円形(アスペクト)を補正する
    // ただし、極に近づくと横幅が狭まりますが、主戦場である赤道付近（Z=0前方）に合わせます
    d.x *= 2.0; 
    float dist = length(d);
    
    // 断面積に応じた動的な半径
    if(dist < dropRadius[i] && dropRadius[i] > 0.0) { 
        // 中心が高い（または深い）滑らかなバンプを加算
        float bump = cos(dist / dropRadius[i] * 1.5707) * dropStrength[i];
        info.r += bump;
    }
  }
  
  gl_FragColor = info;
}
`;

// ─── 振り子形状定数 ────────────────────────────────────────
const ROD_RADIUS = 0.022; // ロッド半径
const BASE_BOB_RADIUS = 0.4; // 質量1.0の時の球の半径

// ─── 共通メタルマテリアル（暗色系） ─────────────────────────
function makeMetal(color, roughness = 0.25, metalness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

// ─── MainScene ───────────────────────────────────────────────
export class MainScene {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this._pendulumArms = []; // 複数の振り子アームを格納する配列
    this._bobStates = []; // 振り子ごとの水面交差状態管理

    this._buildScene();
    this._buildCamera();
    this._buildLights();
    this._buildEnv();
  }

  // ------------------------------------------------------------------
  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
  }

  // ------------------------------------------------------------------
  _buildCamera() {
    this.camera = new THREE.PerspectiveCamera(
      36,
      window.innerWidth / window.innerHeight,
      0.1,
      5000,
    );
    // 振り子(Y=2.5)を中心に地球儀全体を見渡せる位置へ大きく下げる
    this.camera.position.set(0, 8.0, 55.0);
    this.camera.lookAt(0, 2.5, 0);
  }

  _buildLights() {
    // 環境光：環境マップ(環境反射)が入るため、HemisphereLightは少し弱める
    this.scene.add(new THREE.HemisphereLight(0x223344, 0x000000, 1.0));

    // 無限の広がりを表現するためのフォグ
    this.scene.fog = new THREE.Fog(0x000000, 80, 1500);

    /*
     * メインスポットライト — 波紋のエッジや全体のハイライト用
     * 以前のような「白飛び」を防ぐため強さを半分以下に
     */
    this._spotlight = new THREE.SpotLight(
      0xddeeff, // 少し青白い光
      400, // intensity (以前は950)
      35, // distance
      Math.PI / 8, // half-angle
      0.3, // penumbra
      1.8, // decay
    );
    // カメラ (0, 5.5, 18) に近い位置から照らすことで、反射光が美しくカメラへ返る
    this._spotlight.position.set(0, 10, 16);
    this._spotlight.target.position.set(0, 2.5, 0);
    this._spotlight.castShadow = true;
    this._spotlight.shadow.mapSize.set(2048, 2048);
    this._spotlight.shadow.camera.near = 1;
    this._spotlight.shadow.camera.far = 30;
    this.scene.add(this._spotlight);
    this.scene.add(this._spotlight.target);
  }

  // ------------------------------------------------------------------
  _buildEnv() {
    // 0. 環境マップの生成 (水面全体に柔らかな「空間の反射」を作って水面を浮かび上がらせる)
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    // scene.background は漆黒のまま、反射用の環境(environment)だけセット
    this.scene.environment = pmremGenerator.fromScene(roomEnv).texture;

    // 1. GPGPU Compute Renderer のセットアップ
    this.gpuCompute = new GPUComputationRenderer(
      CONFIG.WATER.GPU_WIDTH,
      CONFIG.WATER.GPU_WIDTH,
      this.renderer,
    );
    const heightmap0 = this.gpuCompute.createTexture();
    this.heightmapVariable = this.gpuCompute.addVariable(
      "heightmap",
      heightmapFragmentShader,
      heightmap0,
    );

    this.gpuCompute.setVariableDependencies(this.heightmapVariable, [
      this.heightmapVariable,
    ]);

    // カスタムUniform変数の登録（JSからU/V座標を直接渡す）
    this.heightmapVariable.material.uniforms["dropCoords"] = {
      value: Array(16)
        .fill(null)
        .map(() => new THREE.Vector2()),
    };
    this.heightmapVariable.material.uniforms["dropStrength"] = {
      value: Array(16).fill(0),
    };
    this.heightmapVariable.material.uniforms["dropRadius"] = {
      value: Array(16).fill(0.015),
    };
    this.heightmapVariable.material.uniforms["numDrops"] = { value: 0 };

    this.gpuCompute.init();

    // 2. 超高解像度のガラス球体（惑星）
    const glassGeo = new THREE.SphereGeometry(
      CONFIG.WATER.SPHERE_RADIUS,
      CONFIG.WATER.GPU_WIDTH,
      CONFIG.WATER.GPU_WIDTH, // 高解像度のメッシュ分割
    );

    // 地球儀テクスチャ（Specular map: 大陸が白、海が黒）を読み込み
    const textureLoader = new THREE.TextureLoader();
    const earthTex = textureLoader.load(
      "https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg",
    );

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x020a15, // かなり暗いネイビーをベースに
      roughness: 0.35, // 【ツヤを抑える】反射をすりガラスや柔らかい水面のように拡散させる
      metalness: 0.95, // 【環境反射を強める】環境マップの光を最大限に拾う
      envMapIntensity: 0.6, // 環境マップの効き目合い
      transparent: true,
      opacity: 0.95,
    });

    // GPUからのハイトマップテクスチャを頂点にディスプレイスさせる処理
    glassMat.onBeforeCompile = (shader) => {
      shader.uniforms.heightmap = { value: null };
      shader.uniforms.earthTex = { value: earthTex };

      shader.vertexShader =
        `
        uniform sampler2D heightmap;
        varying vec2 vMyUv;
      ` + shader.vertexShader;

      // 法線（Normal）の再計算：隣り合う頂点の高さから傾きを出し、PBRライティングを正確に当てる
      // 球体表面上の隣接要素の擬似計算に書き換え
      shader.vertexShader = shader.vertexShader.replace(
        "#include <beginnormal_vertex>",
        `
        vec2 texel = vec2( 1.0 / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)}, 1.0 / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)} );
        float visualScale = ${CONFIG.WATER.VISUAL_SCALE.toFixed(1)};
        float h    = texture2D( heightmap, uv ).r * visualScale;
        float hx   = texture2D( heightmap, uv + vec2( texel.x, 0.0 ) ).r * visualScale;
        float hy   = texture2D( heightmap, uv + vec2( 0.0, texel.y ) ).r * visualScale;
        
        vec3 baseNormal = normalize(position);
        
        // 擬似的な接線（U, V 進行方向のベクトルを近似）
        vec3 tangent = normalize(cross(vec3(0.0, 1.0, 0.0), baseNormal));
        if (length(tangent) < 0.001) tangent = vec3(1.0, 0.0, 0.0);
        vec3 bitangent = normalize(cross(baseNormal, tangent));
        
        // SphereのUV特性における各方向の全体の長さ
        float arcLengthU = ${CONFIG.WATER.SPHERE_RADIUS.toFixed(1)} * 3.14159 * 2.0; 
        float arcLengthV = ${CONFIG.WATER.SPHERE_RADIUS.toFixed(1)} * 3.14159; 
        
        vec3 p0 = position + baseNormal * h;
        // UVの進み方向に応じた空間距離だけ接線を延ばして隣接頂点位置を近似
        vec3 pX = position + tangent * (arcLengthU * texel.x) + baseNormal * hx;
        vec3 pY = position - bitangent * (arcLengthV * texel.y) + baseNormal * hy;
        
        vec3 vx = pX - p0;
        vec3 vy = pY - p0;
        
        vec3 objectNormal = normalize( cross( vx, vy ) );
        if (dot(objectNormal, baseNormal) < 0.0) objectNormal = -objectNormal;
        `,
      );

      // Z座標（ワールドでは手前奥）への高さ適用
      // → 位置(position) を法線方向(baseNormal)に押し出すように修正
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `
        float actualScale = ${CONFIG.WATER.VISUAL_SCALE.toFixed(1)}; // 物理的な頂点移動のスケール
        vec3 transformed = position + normalize(position) * texture2D( heightmap, uv ).r * actualScale;
        vMyUv = uv; // フラグメントシェーダーへ送る
        `,
      );

      shader.fragmentShader =
        `
        uniform sampler2D earthTex;
        varying vec2 vMyUv;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `
        #include <dithering_fragment>
        
        // 陸地(白)と海(黒)の色情報 (左右が逆転しないようにマッピングを調整して正面を世界地図にするならvMyUvをそのまま)
        float continent = texture2D(earthTex, vMyUv).r;
        
        // 大陸部分は、うっすらと発光感のあるシアンブルー・ホワイトを載せる
        vec3 globeColor = vec3(0.08, 0.45, 0.70); // 美しい青みがかったガラス色
        gl_FragColor.rgb += globeColor * continent * 0.35;
        
        // 透明度。海(0.0)は元の opacity、陸地(1.0)は少しだけ不透明(1.0に近づく)
        gl_FragColor.a = clamp(gl_FragColor.a + continent * 0.05, 0.0, 1.0);
        `,
      );

      this.waterShader = shader; // 毎フレーム更新できるように確保
    };

    this._glass = new THREE.Mesh(glassGeo, glassMat);
    // Z座標を -SPHERE_RADIUS ずらすことで、手前の表面が Z=0 の平面と同じ位置になります
    this._glass.position.set(0, 0, -CONFIG.WATER.SPHERE_RADIUS);
    this._glass.receiveShadow = true;
    this.scene.add(this._glass);
  }

  /**
   * 複数の振り子を初期構築する
   * @param {Array<{L: number, xOffset: number}>} configs
   */
  initPendulums(configs) {
    // 既存のものがあれば削除
    this._pendulumArms.forEach((arm) => this.scene.remove(arm));
    this._pendulumArms = [];
    this._bobStates = [];

    configs.forEach((conf) => {
      const rodLength = conf.L;
      const xOffset = conf.xOffset;
      const mass = conf.mass || 1.0;
      // 質量(体積)に比例させるため、立方根でスケールする
      const bobRadius = CONFIG.VISUALS.BASE_BOB_RADIUS * Math.cbrt(mass);
      const pivotY = 2.5 + rodLength; // 最下点 Y=2.5 を絶対維持

      this._bobStates.push({ wasIntersecting: false });

      // 振り子アーム（ピボット原点の Object3D）
      const pivotArm = new THREE.Object3D();
      pivotArm.position.set(xOffset, pivotY, 0);
      this.scene.add(pivotArm);
      this._pendulumArms.push(pivotArm);

      // ロッド（糸）
      const rodGeo = new THREE.CylinderGeometry(
        CONFIG.VISUALS.ROD_RADIUS,
        CONFIG.VISUALS.ROD_RADIUS,
        rodLength,
        16,
      );
      const rodMat = makeMetal(0xb2bcc6, 0.12, 0.97);
      rodMat.transparent = true;

      // シェーダーを拡張して上端に向かってフェードアウトさせる
      rodMat.onBeforeCompile = (shader) => {
        shader.uniforms.rodHalfLength = { value: rodLength / 2.0 };

        shader.vertexShader =
          `
          varying float vRodY;
        ` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `
          #include <begin_vertex>
          vRodY = position.y; // ローカル座標で -L/2 から +L/2
          `,
        );

        shader.fragmentShader =
          `
          varying float vRodY;
          uniform float rodHalfLength;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <output_fragment>",
          `
          #include <output_fragment>
          // 上端(rodHalfLength)では透明度0、そこから1.5m下の地点で透明度1になるようにフェード
          float fade = 1.0 - smoothstep(rodHalfLength - 1.5, rodHalfLength, vRodY);
          gl_FragColor.a *= fade;
          `,
        );
      };

      const rod = new THREE.Mesh(rodGeo, rodMat);
      rod.position.set(0, -rodLength / 2, 0);
      rod.castShadow = true;
      pivotArm.add(rod);

      // ボブ
      const bobGeo = new THREE.SphereGeometry(bobRadius, 128, 64);
      const bob = new THREE.Mesh(
        bobGeo,
        new THREE.MeshStandardMaterial({
          color: 0xcdd4dc,
          metalness: 1.0,
          roughness: 0.07,
        }),
      );
      bob.position.set(0, -rodLength, 0);
      bob.castShadow = true;
      pivotArm.add(bob);
      pivotArm.userData.bob = bob; // 衝突判定用に参照を保存
      pivotArm.userData.bobRadius = bobRadius;
      pivotArm.userData.mass = mass;
    });
  }

  // ------------------------------------------------------------------
  /**
   * 複数の角度と速度を反映する
   * @param {number[]} angles
   * @param {number[]} velocities
   */
  setPendulumStates(angles, velocities) {
    for (let i = 0; i < angles.length; i++) {
      if (this._pendulumArms[i]) {
        this._pendulumArms[i].rotation.x = angles[i];
        // ワールドマトリクスを即時更新して最新の座標を取得可能にする
        this._pendulumArms[i].updateMatrixWorld(true);
        // 速度情報をステートに保存
        if (this._bobStates[i]) {
          this._bobStates[i].velocity = velocities[i];
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 波紋エフェクト (物理的な交差面積と速度に基づく連続生成)
  updateRipples(dt) {
    const dropCoordsArr = [];
    const dropStrengthArr = [];
    const dropRadiusArr = [];

    const bobWorldPos = new THREE.Vector3();
    const sphereCenter = new THREE.Vector3(0, 0, -CONFIG.WATER.SPHERE_RADIUS);

    for (let i = 0; i < this._pendulumArms.length; i++) {
      const pivotArm = this._pendulumArms[i];
      if (!pivotArm.userData.bob) continue;
      const bob = pivotArm.userData.bob;
      const state = this._bobStates[i];

      const bobRadius =
        pivotArm.userData.bobRadius || CONFIG.VISUALS.BASE_BOB_RADIUS;
      const massMultiplier = Math.max(0.1, pivotArm.userData.mass || 1.0);

      bob.getWorldPosition(bobWorldPos);

      // 状態の初期化
      if (!state.prevWorldPos) {
        state.prevWorldPos = bobWorldPos.clone();
        state.waterState = "AIR";
      }

      // 前フレームとの差分から三次元ベクトル速度を算出（数学的に無欠）
      const dtSafe = dt > 0 ? dt : 0.016;
      const velocityVec = new THREE.Vector3()
        .subVectors(bobWorldPos, state.prevWorldPos)
        .divideScalar(dtSafe);
      state.prevWorldPos.copy(bobWorldPos);

      // 球体中心からの距離と表面からの深さ
      const distFromCenter = bobWorldPos.distanceTo(sphereCenter);
      const depth = CONFIG.WATER.SPHERE_RADIUS - distFromCenter;

      // 状態マシンの判定
      let currentState = "AIR";
      if (depth > bobRadius) {
        currentState = "SUBMERGED"; // 完全に沈んでいる
      } else if (depth > -bobRadius) {
        currentState = "CROSSING"; // 水面通過中
      }

      // 地球儀のローカルUV座標と法線（向き）の算出
      const localPos = this._glass.worldToLocal(bobWorldPos.clone());
      const normalDir = localPos.clone().normalize();

      // 水面に対して垂直に動く速度（＋なら外へ抜ける、−なら内へ潜る）
      const v_surf = normalDir.dot(velocityVec);

      // 交差面の半径
      const zDist = Math.abs(depth);
      let crossRadius = 0;
      if (currentState === "CROSSING") {
        crossRadius = Math.sqrt(
          Math.max(0, bobRadius * bobRadius - zDist * zDist),
        );
      }

      const uvRadius = Math.max(
        crossRadius / (CONFIG.WATER.SPHERE_RADIUS * 1.5),
        0.005,
      );

      // Three.js の SphereGeometry におけるUV生成式に合わせて完全一致させる
      let u = Math.atan2(normalDir.z, -normalDir.x) / (2.0 * Math.PI);
      if (u < 0) u += 1.0; // 0.0 ~ 1.0に正規化

      // V座標の反転: Three.jsのSphereGeometryではV=1が北極、V=0が南極であるため反転が必要
      const v =
        1.0 - Math.acos(Math.max(-1.0, Math.min(1.0, normalDir.y))) / Math.PI;

      // ========= タイミング分岐による波紋発生 =========
      if (currentState === "CROSSING") {
        if (state.waterState === "AIR") {
          // 【1】ENTRY (激突) : 水面が押し込まれる
          dropCoordsArr.push(new THREE.Vector2(u, v));
          dropStrengthArr.push(-0.25 * massMultiplier - Math.abs(v_surf) * 0.1);
          dropRadiusArr.push(uvRadius * 3.5);
        } else if (state.waterState === "SUBMERGED") {
          // 【2】EMERGE (脱出開始) : 水中から押し上げられる
          dropCoordsArr.push(new THREE.Vector2(u, v));
          dropStrengthArr.push(0.2 * massMultiplier + Math.abs(v_surf) * 0.05);
          dropRadiusArr.push(uvRadius * 3.5);
        } else {
          // 【3】CROSSING中 : 断面積と速度に応じたかき乱し
          const volumeShift =
            v_surf * (crossRadius / bobRadius) * 0.08 * massMultiplier;
          if (Math.abs(volumeShift) > 0.0005) {
            dropCoordsArr.push(new THREE.Vector2(u, v));
            dropStrengthArr.push(volumeShift);
            dropRadiusArr.push(uvRadius);
          }
        }
      } else if (currentState === "AIR" && state.waterState === "CROSSING") {
        // 【4】EXIT (完全脱出) : 水から完全に飛び出した後の弾け
        dropCoordsArr.push(new THREE.Vector2(u, v));
        dropStrengthArr.push(-0.15 * massMultiplier);
        dropRadiusArr.push(
          (bobRadius / (CONFIG.WATER.SPHERE_RADIUS * 1.5)) * 1.5,
        );
      } else if (
        currentState === "SUBMERGED" &&
        state.waterState === "CROSSING"
      ) {
        // 【5】SINK (完全沈没) : 表面が閉じる時の跳ね返り
        dropCoordsArr.push(new THREE.Vector2(u, v));
        dropStrengthArr.push(0.15 * massMultiplier);
        dropRadiusArr.push(
          (bobRadius / (CONFIG.WATER.SPHERE_RADIUS * 1.5)) * 1.5,
        );
      }

      // 状態を記憶
      state.waterState = currentState;
    }

    // Compute Shader の Uniforms に発火したてのドロップ情報を詰める
    const uniforms = this.heightmapVariable.material.uniforms;
    const count = Math.min(dropCoordsArr.length, 16);
    uniforms.numDrops.value = count;

    for (let i = 0; i < count; i++) {
      uniforms.dropCoords.value[i].copy(dropCoordsArr[i]);
      uniforms.dropStrength.value[i] = dropStrengthArr[i];
      uniforms.dropRadius.value[i] = dropRadiusArr[i];
    }

    // GPGPU 演算を1ステップ進める
    this.gpuCompute.compute();

    // 計算後はリセット
    uniforms.numDrops.value = 0;

    // 計算済のハイトマップを PBR ガラスシェーダーに渡す
    if (this.waterShader) {
      this.waterShader.uniforms.heightmap.value =
        this.gpuCompute.getCurrentRenderTarget(this.heightmapVariable).texture;
    }
  }

  // ------------------------------------------------------------------
  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    if (this._glass) {
      // 基準時刻（2024-01-01）からの経過秒数を取得
      const absoluteTime = (Date.now() - (CONFIG.PHYSICS.EPOCH_MS || 0)) / 1000;
      // 読み込みのたびにリセットされないよう、絶対時間に基づいた角度を直接セットする
      this._glass.rotation.y = absoluteTime * (CONFIG.WATER.SPHERE_ROTATION_SPEED || 0);
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.clear();
  }
}
