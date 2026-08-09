/**
 * ParticleEngine.js — scene-builder 粒子引擎（任务书 docs/tasks/particle-system-v1.md Phase 0）
 *
 * 精简 Shuriken 路线：SoA 池 + per-emitter 配置 + 三种渲染模式（Points / InstancedMesh / LineSegments streak）。
 * 服务对象：武器特效（ParticleLayer companion）、天气（WeatherController）、模型常驻粒子（Phase 4）。
 * 词汇表对齐 js/animation 的 motion-plan emit 轨道（rate/lifetime/velocity/acceleration/colorStart...），
 * 但两套实现不合并——js/animation/ParticleSystem.js 是已交付的第三方契约（api-reference §7），不动。
 *
 * 硬约束：不在顶层 import three。构造注入 `{ THREE, scene }`；不注入则为纯模拟模式（node 自测用，
 * 见 tests/particle-engine.test.mjs）。
 *
 * 曲线：预制 6 条，语义 value = lerp(start, end, curve(t))，t=0 出生 → 1 死亡。
 * CURVES（JS，mesh 模式 CPU 查表）与 EVAL_CURVE_GLSL（point 模式 shader 查表）必须同序同值，
 * 两者相邻定义、互相引用，改一处必须改另一处。
 */

import { RENDER_ORDER } from '../../render/RenderOrders.js';

// ── 曲线表（单一来源；GLSL 版在下方 EVAL_CURVE_GLSL，id = CURVE_IDS 下标）──
export const CURVES = {
  linear:   (t) => t,
  easeIn:   (t) => t * t,
  easeOut:  (t) => 1 - (1 - t) * (1 - t),
  smooth:   (t) => t * t * (3 - 2 * t),
  bell:     (t) => Math.sin(Math.PI * t),
  quickBell: (t) => (t <= 0.2
    ? smoothstep(0, 0.2, t)
    : 1 - smoothstep(0.2, 1, t)),
  holdFade: (t) => (t <= 0.7 ? 1 : 1 - smoothstep(0.7, 1, t)),
};

export const CURVE_IDS = ['linear', 'easeIn', 'easeOut', 'smooth', 'bell', 'quickBell', 'holdFade'];

/** GLSL 版曲线查表——分支顺序必须与 CURVE_IDS 一致。 */
export const EVAL_CURVE_GLSL = /* glsl */`
float evalCurve(int id, float t) {
  if (id == 1) return t * t;
  if (id == 2) { float u = 1.0 - t; return 1.0 - u * u; }
  if (id == 3) return t * t * (3.0 - 2.0 * t);
  if (id == 4) return sin(3.14159265 * t);
  if (id == 5) return t <= 0.2
    ? smoothstep(0.0, 0.2, t)
    : 1.0 - smoothstep(0.2, 1.0, t);
  if (id == 6) return 1.0 - smoothstep(0.7, 1.0, t);
  return t;
}
`;

function smoothstep(a, b, t) {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

function curveId(name) {
  const i = CURVE_IDS.indexOf(name);
  return i >= 0 ? i : 0;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

const MAX_CAPACITY = 4096;

// ── 贴图缓存：同一路径的贴图跨 emitter 共享一份 THREE.Texture，避免重复加载 ──
const textureCache = new Map();

/** Perspective-correct conversion from world-space diameter to pixels at unit depth. */
export function projectionPointScale(camera, viewportHeight) {
  const projectionY = Number(camera?.projectionMatrix?.elements?.[5]);
  const height = Number(viewportHeight);
  if (!Number.isFinite(projectionY) || projectionY <= 0
    || !Number.isFinite(height) || height <= 0) return 300;
  return 0.5 * height * projectionY;
}
function loadParticleTexture(THREE, path) {
  if (!path) return null;
  let tex = textureCache.get(path);
  if (tex) return tex;
  tex = new THREE.TextureLoader().load(path);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = true; // 明确与 shader 的 gl_PointCoord.y 翻转约定保持一致
  tex.colorSpace = THREE.SRGBColorSpace; // 同 MatcapSystem.js 约定：美术贴图走 sRGB
  textureCache.set(path, tex);
  return tex;
}

// ── point 模式 shader ──────────────────────────────────────────────
// attributes: position（世界坐标）、aT（归一化寿命 0→1）、aAge（绝对秒）、aSeed（0→1 随机）
// wobble 的 freq 语义 = 每个寿命周期的摆动次数（用 aT 而非绝对秒，省一条 attribute）
const POINT_VERTEX = /* glsl */`
attribute float aT;
attribute float aAge;
attribute float aSeed;
uniform float uSizeStart;
uniform float uSizeEnd;
uniform float uProjectionScale;
uniform int uSizeCurve;
uniform vec2 uWobble;
varying float vT;
varying float vAge;
varying float vSeed;
${EVAL_CURVE_GLSL}
void main() {
  vT = aT;
  vAge = aAge;
  vSeed = aSeed;
  vec3 p = position;
  float wobblePhase = aSeed * 6.2832;
  p.x += sin(aT * uWobble.y * 6.2832 + wobblePhase) * uWobble.x;
  p.z += cos(aT * uWobble.y * 6.2832 + wobblePhase * 1.7) * uWobble.x;
  float size = mix(uSizeStart, uSizeEnd, evalCurve(uSizeCurve, aT));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = size * uProjectionScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const POINT_FRAGMENT = /* glsl */`
uniform vec3 uColorStart;
uniform vec3 uColorEnd;
uniform float uAlphaStart;
uniform float uAlphaEnd;
uniform int uColorCurve;
uniform int uAlphaCurve;
uniform float uFlicker;
uniform sampler2D uMap;
uniform bool uHasMap;
uniform vec2 uMapFrames;
uniform float uMapFps;
uniform float uMapFrame;
uniform vec2 uMapSize;
uniform vec2 uMapCell;
uniform vec2 uMapOrigin;
uniform bool uMapFlipY;
uniform bool uMapRowInvert;
uniform sampler2D uSceneDepth;
uniform bool uHasSceneDepth;
uniform vec2 uDepthResolution;
uniform vec2 uCameraNearFar;
varying float vT;
varying float vAge;
varying float vSeed;
${EVAL_CURVE_GLSL}
// 线性化 NDC 深度（透视投影）。抄 WaterSurface.js 深度对比那段的公式，已验证可用。
float linearizeDepth(float ndcDepth, float near, float far) {
  float z = ndcDepth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float shapeFalloff = 1.0 - smoothstep(0.15, 0.25, dot(d, d));
  float texAlpha = 1.0;
  vec3 texCol = vec3(1.0);
  if (uHasMap) {
    float frameCount = uMapFrames.x * uMapFrames.y;
    float frame = uMapFrame >= 0.0
      ? min(floor(uMapFrame), frameCount - 1.0)
      : (uMapFps > 0.0
        ? mod(floor(vAge * uMapFps), frameCount)
        : min(floor(vT * frameCount), frameCount - 1.0));
    float frameX = mod(frame, uMapFrames.x);
    float frameY = floor(frame / uMapFrames.x);
    // 序列帧排布：多数 sprite sheet 是左上→右下，但部分资产（如 bottom-up 导出）需要反转行序。
    if (uMapRowInvert) frameY = uMapFrames.y - 1.0 - frameY;
    vec2 frameXY = vec2(frameX, frameY);
    // WebGL point sprite 的 gl_PointCoord.y 默认从下到上；Three.js 贴图 flipY=true 后 UV 从上到下。
    // 标准情况下需要翻转 Y 以匹配贴图方向；个别资产/加载路径可能已自带翻转，可关闭。
    vec2 pc = gl_PointCoord;
    if (uMapFlipY) pc.y = 1.0 - pc.y;
    // 用真实像素 cell 尺寸/原点采样：支持非正方形 cell 与带边距/偏移的 sprite sheet。
    // uMapCell=0 时引擎按 uMapSize/uMapFrames 自动填充（= 旧行为：网格铺满整张贴图）。
    vec2 cellUV = uMapCell / uMapSize;
    vec2 originUV = uMapOrigin / uMapSize;
    vec2 uv = originUV + (pc + frameXY) * cellUV;
    vec4 tex = texture2D(uMap, uv);
    texCol = tex.rgb;
    texAlpha = tex.a;
  }
  float falloff = uHasMap ? texAlpha : shapeFalloff;
  if (falloff <= 0.001) discard;
  vec3 tint = mix(uColorStart, uColorEnd, evalCurve(uColorCurve, vT));
  vec3 col = uHasMap ? texCol * tint : tint;
  float a = mix(uAlphaStart, uAlphaEnd, evalCurve(uAlphaCurve, vT));
  a *= 1.0 + uFlicker * sin(vT * 40.0 + vSeed * 6.2832) * 0.5;
  a *= falloff;
  // soft particle：贴近场景表面时按深度差淡出，无深度图时直接跳过（现状硬边）
  if (uHasSceneDepth) {
    vec2 screenUV = gl_FragCoord.xy / uDepthResolution;
    float sceneDepthRaw = texture2D(uSceneDepth, screenUV).r;
    float sceneLinear = linearizeDepth(sceneDepthRaw, uCameraNearFar.x, uCameraNearFar.y);
    float fragLinear = linearizeDepth(gl_FragCoord.z, uCameraNearFar.x, uCameraNearFar.y);
    float depthDiff = sceneLinear - fragLinear;
    a *= smoothstep(0.0, 0.5, depthDiff);
  }
  gl_FragColor = vec4(col, a);
}
`;

// ── streak 模式 shader（LineSegments：每粒子 2 顶点，头在 position，尾沿 -velocity 拉伸）──
// 用于雨丝一类需要方向感的降水/拖尾效果；gl_PointSize 是各向同性的，圆点怎么调都拉不出线，
// 这是唯一能画出"线"的路径。CPU 每帧算头尾世界坐标（同 mesh 模式的 per-instance 更新套路）。
const STREAK_VERTEX = /* glsl */`
attribute float aT;
varying float vT;
void main() {
  vT = aT;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STREAK_FRAGMENT = /* glsl */`
uniform vec3 uColorStart;
uniform vec3 uColorEnd;
uniform float uAlphaStart;
uniform float uAlphaEnd;
uniform int uColorCurve;
uniform int uAlphaCurve;
varying float vT;
${EVAL_CURVE_GLSL}
void main() {
  vec3 tint = mix(uColorStart, uColorEnd, evalCurve(uColorCurve, vT));
  float a = mix(uAlphaStart, uAlphaEnd, evalCurve(uAlphaCurve, vT));
  if (a <= 0.003) discard;
  gl_FragColor = vec4(tint, a);
}
`;

// ── Emitter ────────────────────────────────────────────────────────

export class ParticleEmitter {
  /**
   * @param {object} config - 见任务书词汇表；全字段可省
   * @param {object|null} ctx - { THREE, scene }；null = 纯模拟（node 测试）
   * @param {object} [anchor] - { attachTo?: Object3D, worldPos?: [x,y,z] }
   */
  constructor(config = {}, ctx = null, anchor = {}) {
    this.config = config;
    this.ctx = ctx;
    this.attachTo = anchor.attachTo || null;
    this.worldPos = anchor.worldPos || [0, 0, 0];

    this.rate = config.rate ?? (config.burst ? 0 : 15);
    this.burst = config.burst ?? 0;
    this.duration = config.duration ?? (this.rate > 0 ? Infinity : 0);
    this.lifetime = config.lifetime || [0.5, 1.0];

    const maxLife = this.lifetime[1] || 1;
    this.capacity = Math.min(
      MAX_CAPACITY,
      config.maxCount ?? (Math.ceil(this.rate * maxLife) + this.burst + 8)
    );

    // SoA 池：前 alive 个有效，死亡与末尾交换
    this.pos = new Float32Array(this.capacity * 3);
    this.vel = new Float32Array(this.capacity * 3);
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
    this.alive = 0;

    this.elapsed = 0;
    this.accumulator = 0;
    this.burstDone = false;
    this.stopped = false;

    this._origin = [this.worldPos[0], this.worldPos[1], this.worldPos[2]];
    this._sizeCurve = CURVES[config.sizeCurve] || CURVES.linear;
    this._alphaCurve = CURVES[config.alphaCurve] || CURVES.linear;
    this._colorCurve = CURVES[config.colorCurve] || CURVES.linear;

    this.object = null; // Points / InstancedMesh（模拟模式下为 null）
    if (ctx?.THREE) this._initRender(ctx);
  }

  _initRender({ THREE, scene }) {
    const cfg = this.config;
    const mode = cfg.renderMode || 'point';
    if (mode === 'mesh') {
      const geometry = cfg.mesh === 'ico'
        ? new THREE.IcosahedronGeometry(0.5, 0)
        : new THREE.BoxGeometry(1, 1, 1);
      // ponytail: mesh 模式无 per-instance alpha（Standard 材质限制）；淡出靠 scale 归零，够用
      const material = new THREE.MeshStandardMaterial({
        flatShading: true,
        transparent: true,
        opacity: cfg.alphaStart ?? 0.95,
        ...(cfg.additive ? { blending: THREE.AdditiveBlending, depthWrite: false } : {}),
      });
      this.object = new THREE.InstancedMesh(geometry, material, this.capacity);
      this.object.count = 0;
      this._dummy = new THREE.Object3D();
      this._color = new THREE.Color();
    } else if (mode === 'streak') {
      const geometry = new THREE.BufferGeometry();
      this._wideStreak = Number(cfg.streakWidth) > 0;
      const verticesPerParticle = this._wideStreak ? 4 : 2;
      this._streakPos = new Float32Array(this.capacity * verticesPerParticle * 3);
      geometry.setAttribute('position', new THREE.BufferAttribute(this._streakPos, 3).setUsage(THREE.DynamicDrawUsage));
      this._streakT = new Float32Array(this.capacity * verticesPerParticle);
      geometry.setAttribute('aT', new THREE.BufferAttribute(this._streakT, 1).setUsage(THREE.DynamicDrawUsage));
      if (this._wideStreak) {
        const indices = new Uint16Array(this.capacity * 6);
        for (let i = 0; i < this.capacity; i++) {
          const vertex = i * 4;
          const index = i * 6;
          indices.set([vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1], index);
        }
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }
      geometry.setDrawRange(0, 0);
      const cs = cfg.colorStart || [1, 1, 1];
      const ce = cfg.colorEnd || cs;
      const material = new THREE.ShaderMaterial({
        vertexShader: STREAK_VERTEX,
        fragmentShader: STREAK_FRAGMENT,
        uniforms: {
          uColorStart: { value: new THREE.Vector3(cs[0], cs[1], cs[2]) },
          uColorEnd: { value: new THREE.Vector3(ce[0], ce[1], ce[2]) },
          uColorCurve: { value: curveId(cfg.colorCurve) },
          uAlphaStart: { value: cfg.alphaStart ?? 1 },
          uAlphaEnd: { value: cfg.alphaEnd ?? 1 },
          uAlphaCurve: { value: curveId(cfg.alphaCurve) },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.object = this._wideStreak
        ? new THREE.Mesh(geometry, material)
        : new THREE.LineSegments(geometry, material);
      this.object.userData.isParticleStreak = true;
    } else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this._aT = new Float32Array(this.capacity);
      geometry.setAttribute('aT', new THREE.BufferAttribute(this._aT, 1).setUsage(THREE.DynamicDrawUsage));
      this._aAge = new Float32Array(this.capacity);
      geometry.setAttribute('aAge', new THREE.BufferAttribute(this._aAge, 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setDrawRange(0, 0);
      const cs = cfg.colorStart || [1, 0.8, 0.2];
      const ce = cfg.colorEnd || cs;
      const map = loadParticleTexture(THREE, cfg.map);
      const material = new THREE.ShaderMaterial({
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        uniforms: {
          uSizeStart: { value: (cfg.scaleStart ?? 1) * (cfg.meshSize ?? 0.15) },
          uSizeEnd: { value: (cfg.scaleEnd ?? 0) * (cfg.meshSize ?? 0.15) },
          uProjectionScale: { value: 300 },
          uSizeCurve: { value: curveId(cfg.sizeCurve) },
          uColorStart: { value: new THREE.Vector3(cs[0], cs[1], cs[2]) },
          uColorEnd: { value: new THREE.Vector3(ce[0], ce[1], ce[2]) },
          uColorCurve: { value: curveId(cfg.colorCurve) },
          uAlphaStart: { value: cfg.alphaStart ?? 1 },
          uAlphaEnd: { value: cfg.alphaEnd ?? 0 },
          uAlphaCurve: { value: curveId(cfg.alphaCurve) },
          uWobble: { value: new THREE.Vector2(cfg.wobble?.[0] ?? 0, cfg.wobble?.[1] ?? 0) },
          uFlicker: { value: cfg.flicker ?? 0 },
          // Phase A/B：贴图 + flipbook（无 map 时 uHasMap=false，走现状程序化软圆）
          uMap: { value: map },
          uHasMap: { value: !!map },
          uMapFrames: { value: new THREE.Vector2(cfg.mapFrames?.[0] || 1, cfg.mapFrames?.[1] || 1) },
          uMapFps: { value: cfg.mapFps ?? 0 },
          uMapFrame: { value: Number.isFinite(cfg.mapFrame) && cfg.mapFrame >= 0 ? Math.floor(cfg.mapFrame) : -1 },
          uMapSize: { value: new THREE.Vector2(0, 0) },
          uMapCell: { value: new THREE.Vector2(cfg.mapCell?.[0] || 0, cfg.mapCell?.[1] || 0) },
          uMapOrigin: { value: new THREE.Vector2(cfg.mapOrigin?.[0] || 0, cfg.mapOrigin?.[1] || 0) },
          uMapFlipY: { value: cfg.mapFlipY ?? true },
          uMapRowInvert: { value: cfg.mapRowInvert ?? false },
          // Phase C：soft particle，每帧由 _syncRender 按当前 depthTexture 更新
          uSceneDepth: { value: null },
          uHasSceneDepth: { value: false },
          uDepthResolution: { value: new THREE.Vector2(1, 1) },
          uCameraNearFar: { value: new THREE.Vector2(0.1, 1000) },
        },
        transparent: true,
        depthWrite: false,
        blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.object = new THREE.Points(geometry, material);
    }
    this.object.frustumCulled = false;
    this.object.castShadow = false;
    this.object.receiveShadow = false;
    this.object.renderOrder = RENDER_ORDER.EFFECTS;
    // FlameAura companion 约定：不进合批、不可选中、不吃全局 shader 替换
    this.object.userData.skipBatching = true;
    this.object.userData.skipSelection = true;
    this.object.userData.skipShaderApply = true;
    this.object.userData.isParticleEffect = true;
    scene?.add(this.object);
  }

  /** 停止发射；存量粒子自然消亡后 isFinished() 变 true。 */
  stop() {
    this.stopped = true;
  }

  isFinished() {
    const emitting = !this.stopped && this.elapsed < this.duration;
    const burstPending = this.burst > 0 && !this.burstDone && !this.stopped;
    return !emitting && !burstPending && this.alive === 0;
  }

  /**
   * @param {number} dt
   * @param {object|null} [sceneDepth] - { camera, depthTexture } soft particle 用；缺省=硬边（Phase C）
   */
  update(dt, sceneDepth = null) {
    this._updateOrigin();

    // 发射
    if (!this.stopped) {
      if (this.burst > 0 && !this.burstDone) {
        for (let i = 0; i < this.burst; i++) this._spawn();
        this.burstDone = true;
      }
      if (this.elapsed < this.duration && this.rate > 0) {
        this.accumulator += this.rate * dt;
        while (this.accumulator >= 1) {
          this.accumulator -= 1;
          this._spawn();
        }
      }
      this.elapsed += dt;
    }

    // 模拟 + 回收（死亡与末尾交换，倒序遍历保证交换来的粒子本帧也被模拟过）
    const accel = this.config.acceleration || [0, 0, 0];
    const groundKill = !!this.config.groundKill;
    const drag = this.config.drag ?? 0; // 0-1, Niagara fountain default ~0.4
    for (let i = this.alive - 1; i >= 0; i--) {
      const i3 = i * 3;
      this.age[i] += dt;
      this.vel[i3] += accel[0] * dt;
      this.vel[i3 + 1] += accel[1] * dt;
      this.vel[i3 + 2] += accel[2] * dt;
      // Drag: exponential velocity damping per second → pow(1-drag, dt)
      if (drag > 0) {
        const damp = Math.pow(1 - drag, Math.min(dt, 0.1));
        this.vel[i3] *= damp; this.vel[i3 + 1] *= damp; this.vel[i3 + 2] *= damp;
      }
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.age[i] >= this.life[i] || (groundKill && this.pos[i3 + 1] < 0)) {
        this._kill(i);
      }
    }

    if (this.object) this._syncRender(sceneDepth);
  }

  _updateOrigin() {
    this._anchorRotationActive = false;
    if (this.attachTo && this.ctx?.THREE) {
      if (!this._tmpVec) this._tmpVec = new this.ctx.THREE.Vector3();
      this.attachTo.getWorldPosition(this._tmpVec);
      this._origin[0] = this._tmpVec.x;
      this._origin[1] = this._tmpVec.y;
      this._origin[2] = this._tmpVec.z;
      if (this.config.spawnInAnchorSpace === true) {
        if (!this._anchorQuaternion) this._anchorQuaternion = new this.ctx.THREE.Quaternion();
        if (!this._anchorLocalVec) this._anchorLocalVec = new this.ctx.THREE.Vector3();
        this.attachTo.getWorldQuaternion(this._anchorQuaternion);
        this._anchorRotationActive = true;
      }
    } else {
      this._origin[0] = this.worldPos[0];
      this._origin[1] = this.worldPos[1];
      this._origin[2] = this.worldPos[2];
    }
    const off = this.config.offset;
    if (off) {
      let x = off[0], y = off[1], z = off[2];
      if (this._anchorRotationActive) {
        this._anchorLocalVec.set(x, y, z).applyQuaternion(this._anchorQuaternion);
        x = this._anchorLocalVec.x;
        y = this._anchorLocalVec.y;
        z = this._anchorLocalVec.z;
      }
      this._origin[0] += x;
      this._origin[1] += y;
      this._origin[2] += z;
    }
  }

  _spawn() {
    if (this.alive >= this.capacity) return;
    const i = this.alive++;
    const i3 = i * 3;
    const cfg = this.config;
    const [ox, oy, oz] = this._origin;

    // 出生位置：emitShape point / ring / box
    let dx = 0, dy = 0, dz = 0;
    const shape = cfg.emitShape || 'point';
    if (shape === 'ring') {
      const r = cfg.shapeSize?.[0] ?? 0.5;
      const theta = Math.random() * Math.PI * 2;
      dx = Math.cos(theta) * r;
      dz = Math.sin(theta) * r;
    } else if (shape === 'box') {
      const hx = cfg.shapeSize?.[0] ?? 0.5;
      const hy = cfg.shapeSize?.[1] ?? 0.5;
      const hz = cfg.shapeSize?.[2] ?? 0.5;
      dx = rand(-hx, hx);
      dy = rand(-hy, hy);
      dz = rand(-hz, hz);
    }
    if (this._anchorRotationActive) {
      this._anchorLocalVec.set(dx, dy, dz).applyQuaternion(this._anchorQuaternion);
      dx = this._anchorLocalVec.x;
      dy = this._anchorLocalVec.y;
      dz = this._anchorLocalVec.z;
    }
    const sx = ox + dx, sy = oy + dy, sz = oz + dz;
    this.pos[i3] = sx;
    this.pos[i3 + 1] = sy;
    this.pos[i3 + 2] = sz;

    // 初速度：cone（默认）/ radial（speed 可负 = 向内汇聚）
    const vcfg = cfg.velocity || {};
    const speedRange = vcfg.speed || [1, 2];
    const speed = rand(speedRange[0], speedRange[1]);
    let vx, vy, vz;
    if (vcfg.mode === 'radial') {
      vx = sx - ox; vy = sy - oy; vz = sz - oz;
      const len = Math.hypot(vx, vy, vz);
      if (len < 1e-6) { // point 形状退化：随机方向
        vx = Math.random() - 0.5; vy = Math.random() - 0.5; vz = Math.random() - 0.5;
      }
    } else {
      const dir = vcfg.dir || [0, 1, 0];
      const spread = vcfg.spread ?? 0.3;
      vx = dir[0] + (Math.random() - 0.5) * spread * 2;
      vy = dir[1] + (Math.random() - 0.5) * spread * 2;
      vz = dir[2] + (Math.random() - 0.5) * spread * 2;
      if (this._anchorRotationActive) {
        this._anchorLocalVec.set(vx, vy, vz).applyQuaternion(this._anchorQuaternion);
        vx = this._anchorLocalVec.x;
        vy = this._anchorLocalVec.y;
        vz = this._anchorLocalVec.z;
      }
    }
    const len = Math.hypot(vx, vy, vz) || 1;
    this.vel[i3] = (vx / len) * speed;
    this.vel[i3 + 1] = (vy / len) * speed;
    this.vel[i3 + 2] = (vz / len) * speed;

    this.age[i] = 0;
    this.life[i] = rand(this.lifetime[0], this.lifetime[1]);
    this.seed[i] = Math.random();
  }

  _kill(i) {
    const last = --this.alive;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    this.pos[i3] = this.pos[l3]; this.pos[i3 + 1] = this.pos[l3 + 1]; this.pos[i3 + 2] = this.pos[l3 + 2];
    this.vel[i3] = this.vel[l3]; this.vel[i3 + 1] = this.vel[l3 + 1]; this.vel[i3 + 2] = this.vel[l3 + 2];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.seed[i] = this.seed[last];
  }

  _syncRender(sceneDepth = null) {
    const cfg = this.config;
    if (this.object.isPoints) {
      const geo = this.object.geometry;
      for (let i = 0; i < this.alive; i++) {
        this._aT[i] = this.age[i] / this.life[i];
        this._aAge[i] = this.age[i];
      }
      geo.setDrawRange(0, this.alive);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aT.needsUpdate = true;
      geo.attributes.aAge.needsUpdate = true;
      geo.attributes.aSeed.needsUpdate = true;
      // Phase C：soft particle uniforms，depthTexture 缺省时 uHasSceneDepth=false 走硬边（零回归）
      const u = this.object.material.uniforms;
      // 贴图异步加载完成后回填像素尺寸；uMapCell=0 时按 贴图尺寸/帧数 自动推导 cell
      const tex = u.uMap.value;
      if (tex && tex.image && u.uMapSize.value.x === 0) {
        const tw = tex.image.width || 0, th = tex.image.height || 0;
        if (tw && th) {
          u.uMapSize.value.set(tw, th);
          if (!u.uMapCell.value.x) u.uMapCell.value.set(tw / u.uMapFrames.value.x, th / u.uMapFrames.value.y);
        }
      }
      const depthTexture = sceneDepth?.depthTexture || null;
      const camera = sceneDepth?.camera || null;
      u.uProjectionScale.value = projectionPointScale(camera, sceneDepth?.viewportHeight);
      u.uHasSceneDepth.value = !!(depthTexture && camera);
      if (depthTexture && camera) {
        u.uSceneDepth.value = depthTexture;
        u.uDepthResolution.value.set(depthTexture.image?.width || 1, depthTexture.image?.height || 1);
        u.uCameraNearFar.value.set(camera.near, camera.far);
      }
      return;
    }
    if (this.object.userData.isParticleStreak) {
      const streakLength = cfg.streakLength ?? 0.3;
      const cameraElements = sceneDepth?.camera?.matrixWorld?.elements;
      const cameraX = cameraElements?.[12] ?? 0;
      const cameraY = cameraElements?.[13] ?? 0;
      const cameraZ = cameraElements?.[14] ?? 1;
      for (let i = 0; i < this.alive; i++) {
        const i3 = i * 3;
        const vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
        const vlen = Math.hypot(vx, vy, vz) || 1;
        const px = this.pos[i3], py = this.pos[i3 + 1], pz = this.pos[i3 + 2];
        // 头：粒子当前位置；尾：沿速度反方向拉出去 streakLength——雨丝拖在下落方向后面
        const t = this.age[i] / this.life[i];
        const dx = vx / vlen, dy = vy / vlen, dz = vz / vlen;
        const tx = px - dx * streakLength;
        const ty = py - dy * streakLength;
        const tz = pz - dz * streakLength;
        if (this._wideStreak) {
          const mx = (px + tx) * 0.5, my = (py + ty) * 0.5, mz = (pz + tz) * 0.5;
          const viewX = cameraX - mx, viewY = cameraY - my, viewZ = cameraZ - mz;
          let sideX = dy * viewZ - dz * viewY;
          let sideY = dz * viewX - dx * viewZ;
          let sideZ = dx * viewY - dy * viewX;
          let sideLength = Math.hypot(sideX, sideY, sideZ);
          if (sideLength < 1e-5) {
            sideX = -dz; sideY = 0; sideZ = dx;
            sideLength = Math.hypot(sideX, sideZ) || 1;
          }
          const halfWidth = Number(cfg.streakWidth) * 0.5 / sideLength;
          sideX *= halfWidth; sideY *= halfWidth; sideZ *= halfWidth;
          this._streakPos.set([
            px + sideX, py + sideY, pz + sideZ,
            px - sideX, py - sideY, pz - sideZ,
            tx + sideX, ty + sideY, tz + sideZ,
            tx - sideX, ty - sideY, tz - sideZ,
          ], i * 12);
          this._streakT.fill(t, i * 4, i * 4 + 4);
        } else {
          this._streakPos.set([px, py, pz, tx, ty, tz], i * 6);
          this._streakT[i * 2] = t;
          this._streakT[i * 2 + 1] = t;
        }
      }
      const geo = this.object.geometry;
      geo.setDrawRange(0, this.alive * (this._wideStreak ? 6 : 2));
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aT.needsUpdate = true;
      return;
    }
    // mesh 模式：CPU 查曲线表
    const meshSize = cfg.meshSize ?? 0.4;
    const s0 = cfg.scaleStart ?? 1, s1 = cfg.scaleEnd ?? 0;
    const cs = cfg.colorStart || [1, 0.8, 0.2];
    const ce = cfg.colorEnd || cs;
    const wobble = cfg.wobble;
    const velStretch = cfg.velocityStretch ? (cfg.stretchFactor ?? 2.0) : 0;
    this.object.count = this.alive;
    for (let i = 0; i < this.alive; i++) {
      const i3 = i * 3;
      const t = this.age[i] / this.life[i];
      const vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
      const speed = Math.hypot(vx, vy, vz);
      let x = this.pos[i3];
      let z = this.pos[i3 + 2];
      if (wobble) {
        const phase = this.seed[i] * 6.2832;
        x += Math.sin(t * wobble[1] * 6.2832 + phase) * wobble[0];
        z += Math.cos(t * wobble[1] * 6.2832 + phase * 1.7) * wobble[0];
      }
      this._dummy.position.set(x, this.pos[i3 + 1], z);
      const s = Math.max(0.001, meshSize * (s0 + (s1 - s0) * this._sizeCurve(t)));
      // Velocity stretch: elongate along velocity direction, pinched on perpendicular axes.
      if (velStretch > 0 && speed > 0.02) {
        const stretch = 1 + speed * velStretch;
        this._dummy.scale.set(s * 0.5, s * stretch, s * 0.5);
        // Align Y-axis to velocity direction for stretch
        const ny = new this.ctx.THREE.Vector3(vx / speed, vy / speed, vz / speed);
        this._dummy.quaternion.setFromUnitVectors(new this.ctx.THREE.Vector3(0, 1, 0), ny);
      } else {
        this._dummy.scale.set(s, s, s);
        const spin = this.seed[i] * 6.2832 + this.age[i] * (1 + this.seed[i] * 3);
        this._dummy.rotation.set(spin, spin * 1.3, spin * 0.7);
      }
      this._dummy.updateMatrix();
      this.object.setMatrixAt(i, this._dummy.matrix);
      const ct = this._colorCurve(t);
      this._color.setRGB(cs[0] + (ce[0] - cs[0]) * ct, cs[1] + (ce[1] - cs[1]) * ct, cs[2] + (ce[2] - cs[2]) * ct);
      this.object.setColorAt(i, this._color);
    }
    this.object.instanceMatrix.needsUpdate = true;
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (!this.object) return;
    this.object.parent?.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object = null;
  }
}

// ── Engine ─────────────────────────────────────────────────────────

export class ParticleEngine {
  /** @param {object} [ctx] - { THREE, scene }；省略 = 纯模拟模式 */
  constructor(ctx = null) {
    this.ctx = ctx;
    this.emitters = new Set();
  }

  /**
   * @param {object} config - emitter 配置（预设或手写）
   * @param {object} [anchor] - { attachTo?: Object3D, worldPos?: [x,y,z] }
   * @returns {ParticleEmitter} handle
   */
  spawn(config, anchor = {}) {
    const emitter = new ParticleEmitter(config, this.ctx, anchor);
    this.emitters.add(emitter);
    return emitter;
  }

  /**
   * Spawn multiple emitters as a group (e.g. fountain column core + surface + mist).
   * @param {Array<{config:object, anchor?:object}>} layers
   * @returns {ParticleEmitter[]} handles — stop/remove all together
   */
  multiSpawn(layers = []) {
    return layers.map(({ config, anchor }) => this.spawn(config, anchor));
  }

  /** Stop and remove a group of emitters. */
  removeGroup(emitters = []) {
    for (const e of emitters) this.remove(e);
  }

  /** 停止发射，存量自然消亡后自动回收。 */
  stop(emitter) {
    emitter?.stop();
  }

  /** 立即移除（含渲染对象）。 */
  remove(emitter) {
    if (!emitter || !this.emitters.has(emitter)) return;
    emitter.dispose();
    this.emitters.delete(emitter);
  }

  /**
   * 每帧调用。
   * @param {number} dt
   * @param {THREE.Camera|null} [camera] - 预留给天气跟随盒；soft particle 用其 near/far
   * @param {THREE.DepthTexture|null} [depthTexture] - PostProcessPanel 的 SSAO 副产物；
   *   缺省或 camera 缺省 = 无 soft particle，走现状硬边（particle-texture-v1 Phase C）
   * @param {number|null} [viewportHeight] - renderer drawing-buffer height，用于世界尺寸到像素尺寸的真实透视换算
   */
  update(dt, camera = null, depthTexture = null, viewportHeight = null) {
    const sceneDepth = camera ? { camera, depthTexture, viewportHeight } : null;
    for (const emitter of this.emitters) {
      emitter.update(dt, sceneDepth);
      if (emitter.isFinished()) this.remove(emitter);
    }
  }

  dispose() {
    for (const emitter of this.emitters) emitter.dispose();
    this.emitters.clear();
  }
}
