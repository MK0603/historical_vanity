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
uniform vec2 dropPos[16];
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
    // ワールド座標 を UV座標 (0.0 ～ 1.0) にマッピング
    vec2 dropUV = (dropPos[i] + vec2(${CONFIG.WATER.BOUNDS / 2.0})) / ${CONFIG.WATER.BOUNDS.toFixed(1)};
    float dist = distance(uv, dropUV);
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
const BASE_BOB_RADIUS = 0.40; // 質量1.0の時の球の半径

// ─── 共通メタルマテリアル（暗色系） ─────────────────────────
function makeMetal(color, roughness = 0.25, metalness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

// ─── MainScene ───────────────────────────────────────────────
export class MainScene {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer   = renderer;
    this._pendulumArms = []; // 複数の振り子アームを格納する配列
    this._bobStates = [];    // 振り子ごとの水面交差状態管理

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
      5000
    );
    // 振り子を正面やや下から見上げる構図
    this.camera.position.set(0, 5.5, 18);
    this.camera.lookAt(0, 5.5, 0);
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
      0xddeeff,   // 少し青白い光
      400,        // intensity (以前は950)
      35,         // distance
      Math.PI / 8,// half-angle
      0.30,       // penumbra
      1.8         // decay
    );
    // カメラ (0, 5.5, 18) に近い位置から照らすことで、反射光が美しくカメラへ返る
    this._spotlight.position.set(0, 10, 16); 
    this._spotlight.target.position.set(0, 2.5, 0); 
    this._spotlight.castShadow = true;
    this._spotlight.shadow.mapSize.set(2048, 2048);
    this._spotlight.shadow.camera.near = 1;
    this._spotlight.shadow.camera.far  = 30;
    this.scene.add(this._spotlight);
    this.scene.add(this._spotlight.target);
  }

  // ------------------------------------------------------------------
  _buildEnv() {
    // 0. 環境マップの生成 (水面全体に柔らかな「空間の反射」を作って水面を浮かび上がらせる)
    const pmremGenerator = new THREE.PMREMGenerator( this.renderer );
    const roomEnv = new RoomEnvironment();
    // scene.background は漆黒のまま、反射用の環境(environment)だけセット
    this.scene.environment = pmremGenerator.fromScene( roomEnv ).texture;
    
    // 1. GPGPU Compute Renderer のセットアップ
    this.gpuCompute = new GPUComputationRenderer( CONFIG.WATER.GPU_WIDTH, CONFIG.WATER.GPU_WIDTH, this.renderer );
    const heightmap0 = this.gpuCompute.createTexture();
    this.heightmapVariable = this.gpuCompute.addVariable( "heightmap", heightmapFragmentShader, heightmap0 );
    
    this.gpuCompute.setVariableDependencies( this.heightmapVariable, [ this.heightmapVariable ] );
    
    // カスタムUniform変数の登録
    this.heightmapVariable.material.uniforms[ "dropPos" ] = { value: Array(16).fill(null).map(() => new THREE.Vector2()) };
    this.heightmapVariable.material.uniforms[ "dropStrength" ] = { value: Array(16).fill(0) };
    this.heightmapVariable.material.uniforms[ "dropRadius" ] = { value: Array(16).fill(0.015) };
    this.heightmapVariable.material.uniforms[ "numDrops" ] = { value: 0 };
    
    this.gpuCompute.init();

    // 2. 超高解像度のガラス平面
    const glassGeo = new THREE.PlaneGeometry(
      CONFIG.WATER.BOUNDS, CONFIG.WATER.BOUNDS, 
      CONFIG.WATER.GPU_WIDTH - 1, CONFIG.WATER.GPU_WIDTH - 1
    );
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x020a15,      // かなり暗いネイビーをベースに
      roughness: 0.35,      // 【ツヤを抑える】反射をすりガラスや柔らかい水面のように拡散させる
      metalness: 0.95,      // 【環境反射を強める】環境マップの光を最大限に拾う
      envMapIntensity: 0.6, // 環境マップの効き目合い
      transparent: true,
      opacity: 0.95
    });

    // GPUからのハイトマップテクスチャを頂点にディスプレイスさせる処理
    glassMat.onBeforeCompile = ( shader ) => {
      shader.uniforms.heightmap = { value: null };
      
      shader.vertexShader = `
        uniform sampler2D heightmap;
      ` + shader.vertexShader;
      
      // 法線（Normal）の再計算：隣り合う頂点の高さから傾きを出し、PBRライティングを正確に当てる
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `
        vec2 texel = vec2( 1.0 / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)}, 1.0 / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)} );
        float visualScale = ${CONFIG.WATER.VISUAL_SCALE.toFixed(1)}; // 波の見た目の高さを強調(ライティング用)
        float h    = texture2D( heightmap, uv ).r * visualScale;
        float hx   = texture2D( heightmap, uv + vec2( texel.x, 0.0 ) ).r * visualScale;
        float hy   = texture2D( heightmap, uv + vec2( 0.0, texel.y ) ).r * visualScale;
        
        float stepX = ${CONFIG.WATER.BOUNDS.toFixed(1)} / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)};
        float stepY = ${CONFIG.WATER.BOUNDS.toFixed(1)} / ${CONFIG.WATER.GPU_WIDTH.toFixed(1)};
        
        vec3 p0 = vec3( 0.0, 0.0, h );
        vec3 px = vec3( stepX, 0.0, hx );
        vec3 py = vec3( 0.0, stepY, hy );
        
        vec3 vx = px - p0;
        vec3 vy = py - p0;
        
        vec3 objectNormal = normalize( cross( vx, vy ) );
        `
      );
      
      // Z座標（ワールドでは手前奥）への高さ適用
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        float actualScale = ${CONFIG.WATER.VISUAL_SCALE.toFixed(1)}; // 物理的な頂点移動のスケール
        vec3 transformed = vec3( position.x, position.y, texture2D( heightmap, uv ).r * actualScale );
        `
      );
      
      this.waterShader = shader; // 毎フレーム更新できるように確保
    };

    this._glass = new THREE.Mesh(glassGeo, glassMat);
    // スポットライトの照射範囲だけで暗闇に溶け込むよう設定しているため、背景処理は不要
    this._glass.position.set(0, 0, 0);
    this._glass.receiveShadow = true; 
    this.scene.add(this._glass);
  }

  /**
   * 複数の振り子を初期構築する
   * @param {Array<{L: number, xOffset: number}>} configs 
   */
  initPendulums(configs) {
    // 既存のものがあれば削除
    this._pendulumArms.forEach(arm => this.scene.remove(arm));
    this._pendulumArms = [];
    this._bobStates = [];

    configs.forEach(conf => {
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
        CONFIG.VISUALS.ROD_RADIUS, CONFIG.VISUALS.ROD_RADIUS, rodLength, 16
      );
      const rodMat = makeMetal(0xb2bcc6, 0.12, 0.97);
      rodMat.transparent = true;
      
      // シェーダーを拡張して上端に向かってフェードアウトさせる
      rodMat.onBeforeCompile = shader => {
        shader.uniforms.rodHalfLength = { value: rodLength / 2.0 };
        
        shader.vertexShader = `
          varying float vRodY;
        ` + shader.vertexShader;
        
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          vRodY = position.y; // ローカル座標で -L/2 から +L/2
          `
        );
        
        shader.fragmentShader = `
          varying float vRodY;
          uniform float rodHalfLength;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `
          #include <output_fragment>
          // 上端(rodHalfLength)では透明度0、そこから1.5m下の地点で透明度1になるようにフェード
          float fade = 1.0 - smoothstep(rodHalfLength - 1.5, rodHalfLength, vRodY);
          gl_FragColor.a *= fade;
          `
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
          color:     0xcdd4dc,
          metalness: 1.0,
          roughness: 0.07,
        })
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
    const dropPosArr = [];
    const dropStrengthArr = [];
    const dropRadiusArr = [];
    
    const bobWorldPos = new THREE.Vector3();

    for (let i = 0; i < this._pendulumArms.length; i++) {
        const pivotArm = this._pendulumArms[i];
        if (!pivotArm.userData.bob) continue;
        const bob = pivotArm.userData.bob;
        const state = this._bobStates[i];
        
        const bobRadius = pivotArm.userData.bobRadius || CONFIG.VISUALS.BASE_BOB_RADIUS;
        const massMultiplier = Math.max(0.1, pivotArm.userData.mass || 1.0);
        
        bob.getWorldPosition(bobWorldPos);
        const zDist = Math.abs(bobWorldPos.z);
        
        // Z=0 のガラス面との交差判定
        const isIntersecting = (zDist < bobRadius);
        
        if (isIntersecting) {
           // 球が水面を通過する断面積の半径 (r = √(R^2 - z^2))
           const crossRadius = Math.sqrt(bobRadius * bobRadius - zDist * zDist);
           
           // UV座標系(1.0 = 40m) における半径スケール
           const uvRadius = Math.max(crossRadius / CONFIG.WATER.BOUNDS, 0.002);
           
           // 速度依存の強度計算 (質量が大きいほど威力が上がる)
           const speedFactor = Math.abs(state.velocity || 0.0) * 0.3 * massMultiplier;
           
           if (!state.wasIntersecting) {
               // 【1】衝撃の瞬間：最も強いインパクト
               dropPosArr.push(new THREE.Vector2(bobWorldPos.x, bobWorldPos.y));
               dropStrengthArr.push(-0.06 * massMultiplier - speedFactor * 0.1); 
               dropRadiusArr.push(uvRadius * 1.8); 
           }
           
           // 【2】通過中：断面積の変化と速度に応じた連続的な「かき乱し」
           const vz = (state.velocity || 0) * Math.cos(pivotArm.rotation.x);
           const volumeShift = -vz * (crossRadius / bobRadius) * 0.02 * massMultiplier;
           
           if (Math.abs(volumeShift) > 0.0005) {
              dropPosArr.push(new THREE.Vector2(bobWorldPos.x, bobWorldPos.y));
              dropStrengthArr.push(volumeShift);
              dropRadiusArr.push(uvRadius);
           }
        }
        
        if (state) state.wasIntersecting = isIntersecting;
    }

    // Compute Shader の Uniforms に発火したてのドロップ情報を詰める
    const uniforms = this.heightmapVariable.material.uniforms;
    const count = Math.min(dropPosArr.length, 16);
    uniforms.numDrops.value = count;
    
    for(let i=0; i<count; i++) {
        uniforms.dropPos.value[i].copy(dropPosArr[i]);
        uniforms.dropStrength.value[i] = dropStrengthArr[i];
        uniforms.dropRadius.value[i] = dropRadiusArr[i];
    }
    
    // GPGPU 演算を1ステップ進める
    this.gpuCompute.compute();
    
    // 計算後はリセット
    uniforms.numDrops.value = 0;
    
    // 計算済のハイトマップを PBR ガラスシェーダーに渡す
    if (this.waterShader) {
       this.waterShader.uniforms.heightmap.value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture;
    }
  }

  // ------------------------------------------------------------------
  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update() {
    // 振り子以外のシーン側の毎フレーム更新処理（アニメーション等）があればここに記載
    // カメラの制御は main.js 側の OrbitControls が担うように変更したため削除
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.clear();
  }
}
