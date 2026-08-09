import * as THREE from 'three';
import { DEPTH_UTILS_GLSL, NOISE_UTILS_GLSL } from './chunks.js';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

const WATERFALL_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec4 vScreenPos;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform float uBulge;
  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uColumnCount;
  uniform float uSheetDrift;
  uniform float uSheetTurbulence;

  float strandHash(float value) {
    return fract(sin(value * 127.1 + 311.7) * 43758.5453);
  }

  void main() {
    vUv = uv;
    // Phase A.1 截面鼓起：沿顶点法线外推 sin(uv.x·π)·uBulge —— 中间鼓、两侧收，
    // 侧影从直线变圆弧（uBulge=0 退化回平面）。沿法线位移使顶部翻唇行也正确外鼓。
    vec3 pos = position + normal * (sin(uv.x * 3.14159265) * uBulge);
    // D.1: the sheet itself moves. Keep both anchors stable, but let the middle
    // drift as a coherent curtain plus independently phased vertical strands.
    float fall01 = 1.0 - uv.y;
    float anchorMask = sin(uv.y * 3.14159265);
    float strandId = floor(uv.x * max(uColumnCount, 1.0));
    float strandSeed = strandHash(strandId + 1.0);
    float sheetDrift = sin(uv.y * 7.0 + uTime * uFlowSpeed * 0.9)
      * uSheetDrift * anchorMask;
    float strandDrift = sin(uv.y * mix(11.0, 19.0, strandSeed)
      - uTime * uFlowSpeed * mix(1.1, 2.0, strandSeed))
      * uSheetTurbulence * anchorMask * mix(0.35, 1.0, fall01);
    pos.x += sheetDrift + strandDrift;
    pos.z += cos(uv.y * 9.0 + strandSeed * 6.2831853 - uTime * uFlowSpeed * 1.25)
      * uSheetTurbulence * 0.55 * anchorMask;
    // 鼓起的解析法线倾斜（沿条带 x 方向）：喂给 fresnel 边缘透明，风格化近似即可。
    float bulgeSlope = cos(uv.x * 3.14159265) * 3.14159265 * uBulge;
    vec3 bentNormal = normalize(normal + vec3(-bulgeSlope * 0.35, 0.0, 0.0));
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPosition = worldPos.xyz;
    vViewNormal = normalize(normalMatrix * bentNormal);
    vViewPos = (modelViewMatrix * vec4(pos, 1.0)).xyz;
    vScreenPos = projectionMatrix * viewMatrix * worldPos;
    gl_Position = vScreenPos;
  }
`;

const WATERFALL_FRAGMENT_SHADER = /* glsl */ `
  ${DEPTH_UTILS_GLSL}
  ${NOISE_UTILS_GLSL}

  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec4 vScreenPos;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform sampler2D tDepth;
  uniform sampler2D tFlowNoise;
  uniform sampler2D tFoamNoise;
  uniform bool uHasDepthTexture;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec2 uResolution;
  uniform float uTime;

  uniform vec3 uTopColor;
  uniform vec3 uBottomColor;
  uniform vec3 uFoamColor;
  uniform float uOpacity;
  uniform float uEdgeAlpha;
  uniform float uColumnCount;
  uniform float uColumnStyle;
  uniform float uEdgeWobble;
  uniform float uEdgeWobbleScale;
  uniform float uFlowSpeed;
  uniform float uFlowScale;
  uniform float uFlowNoiseStrength;
  uniform float uFallAcceleration;
  uniform float uFlowWarp;
  uniform float uStrandBreakup;
  uniform float uBandSteps;
  uniform float uTopFoamWidth;
  uniform float uBottomFoamHeight;
  uniform float uBottomDepthFoamRange;
  uniform float uBottomFoamIntensity;

  void main() {
    // Phase A.5 侧边缘 wobble 裁剪：sine + 噪声扰动左右直边，step discard 打碎轮廓
    // （Cyanilux 技法）。uEdgeWobble=0 时不裁剪，退化回矩形边。
    float edgeDist = abs(vUv.x - 0.5) * 2.0;
    if (uEdgeWobble > 0.0001) {
      float wob = sin(vUv.y * uEdgeWobbleScale * 6.2831853 + uTime * 1.6)
                + (noise2D(vec2(vUv.y * uEdgeWobbleScale * 2.7, uTime * 0.35)) - 0.5) * 2.0;
      if (edgeDist > 1.0 - uEdgeWobble * (0.5 + 0.35 * wob)) discard;
    }

    vec2 screenUv = vScreenPos.xy / max(vScreenPos.w, 0.0001) * 0.5 + 0.5;
    float sceneLinearDepth = readLinearDepth(tDepth, screenUv, uCameraNear, uCameraFar);
    float fragLinearDepth = linearizeDepth(gl_FragCoord.z, uCameraNear, uCameraFar);
    float depthDiff = max(sceneLinearDepth - fragLinearDepth, 0.0);
    float depthContact = uHasDepthTexture
      ? smoothstep(0.0, max(uBottomDepthFoamRange, 0.0001), depthDiff)
      : 0.0;

    // Phase A.4 竖直水柱：uv.x 按 uColumnCount 分缕，每缕独立亮度 + 流动相位偏移；
    // uColumnStyle 0 = cos 圆缕（动森），1 = 每缕平色块（MC）。uColumnCount=0 关闭。
    float colBright = 1.0;
    float colPhase = 0.0;
    if (uColumnCount > 0.5) {
      float colF = vUv.x * uColumnCount;
      float colId = floor(colF);
      float colFrac = fract(colF);
      colPhase = hash2D(vec2(colId, 7.31)) * 0.6;
      colBright = (uColumnStyle < 0.5)
        ? mix(0.82, 1.06, sin(colFrac * 3.14159265))
        : mix(0.86, 1.05, step(0.5, hash2D(vec2(colId, 3.7))));
    }

    float fall01 = 1.0 - vUv.y;
    float fallRate = mix(1.0, 1.0 + uFallAcceleration, fall01 * fall01);
    float flowClock = uTime * uFlowSpeed * fallRate;
    float lateralWarp = (noise2D(vec2(vUv.y * 3.1, uTime * 0.31)) - 0.5)
      * 2.0 * uFlowWarp * mix(0.2, 1.0, fall01);
    vec2 flowUvA = vec2(vUv.x * uFlowScale + lateralWarp, vUv.y * uFlowScale - flowClock - colPhase);
    vec2 flowUvB = vec2(vUv.x * uFlowScale * 1.7 + 9.3 - lateralWarp * 0.65, vUv.y * uFlowScale * 1.25 - flowClock * 1.45 - colPhase);
    float texFlowA = texture2D(tFlowNoise, flowUvA).r;
    float texFlowB = texture2D(tFlowNoise, flowUvB).r;
    float procFlow = noise2D(flowUvA * 2.0) * noise2D(flowUvB * 1.5);
    float flow = mix(procFlow, texFlowA * texFlowB, 0.35);
    flow = clamp(flow + (texFlowA - 0.5) * uFlowNoiseStrength, 0.0, 1.0);

    float bands = max(uBandSteps, 1.0);
    float bandedFlow = floor(flow * bands) / bands;
    vec3 waterColor = mix(uBottomColor, uTopColor, clamp(vUv.y + bandedFlow * 0.15, 0.0, 1.0));
    waterColor *= colBright;

    float sideBreakup = step(0.3, fbmNoise(vec2(vUv.x * 8.0, vUv.y * 1.5), uTime * 0.2));
    float topFoam = smoothstep(1.0 - uTopFoamWidth, 1.0, vUv.y);
    float bottomMask = 1.0 - smoothstep(0.0, uBottomFoamHeight, vUv.y);
    float bottomFoamNoise = texture2D(tFoamNoise, flowUvA * 0.75 + vec2(0.0, uTime * 0.15)).r;
    float bottomFoam = bottomMask * max(depthContact, 0.35) * step(0.42, max(bottomFoamNoise, flow));
    float edgeFoam = max(topFoam, bottomFoam * uBottomFoamIntensity) * sideBreakup;

    waterColor = mix(waterColor, uFoamColor, clamp(edgeFoam, 0.0, 1.0));

    // Phase A.3 不透明主体 + fresnel 边缘：正视实色（水体不是薄膜），掠射角渐透。
    // uEdgeAlpha == uOpacity 时 alpha 退化为均匀 uOpacity（旧观感回退路径）。泡沫保持实色。
    float fres = pow(1.0 - clamp(abs(dot(normalize(vViewNormal), normalize(-vViewPos))), 0.0, 1.0), 2.2);
    float alpha = mix(clamp(uOpacity, 0.0, 1.0), clamp(uEdgeAlpha, 0.0, 1.0), fres);
    float breakupNoise = fbmNoise(vec2(vUv.x * max(uColumnCount, 2.0) * 0.7,
      vUv.y * 4.5 - flowClock * 0.32), uTime * 0.18);
    float breakupMask = smoothstep(0.28, 0.72, max(flow, breakupNoise));
    alpha *= mix(1.0, breakupMask, clamp(uStrandBreakup, 0.0, 1.0) * smoothstep(0.08, 0.72, fall01));
    alpha = max(alpha, clamp(edgeFoam, 0.0, 1.0) * clamp(uOpacity, 0.0, 1.0));
    gl_FragColor = vec4(waterColor, alpha);
  }
`;

const DEFAULT_OPTIONS = {
  width: 4,
  height: 5,
  segmentsX: 16,
  segmentsY: 64,
  position: new THREE.Vector3(0, 2.5, -4),
  topColor: new THREE.Color(0x91e7ff),
  bottomColor: new THREE.Color(0x1698c7),
  foamColor: new THREE.Color(0xffffff),
};

const SPLASH_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPLASH_FRAGMENT_SHADER = /* glsl */ `
  ${NOISE_UTILS_GLSL}

  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSeed;

  void main() {
    vec2 centered = vUv * 2.0 - 1.0;
    float radial = 1.0 - smoothstep(0.35, 1.0, length(centered * vec2(0.8, 1.5)));
    float spray = fbmNoise(vUv * vec2(5.0, 2.2) + vec2(uSeed, uTime * 0.45), uTime * 0.35);
    float streaks = step(0.52, spray) * smoothstep(-0.35, 0.85, centered.y);
    float alpha = radial * streaks * uOpacity;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

function createDefaultNoiseTexture() {
  const data = new Uint8Array([
    36, 36, 36, 255, 210, 210, 210, 255, 92, 92, 92, 255, 180, 180, 180, 255,
    235, 235, 235, 255, 68, 68, 68, 255, 150, 150, 150, 255, 116, 116, 116, 255,
    128, 128, 128, 255, 244, 244, 244, 255, 48, 48, 48, 255, 196, 196, 196, 255,
    220, 220, 220, 255, 104, 104, 104, 255, 172, 172, 172, 255, 84, 84, 84, 255,
  ]);
  const texture = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class WaterfallSurface {
  constructor(scene, renderer, environmentRoot = null, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.scene = scene;
    this.renderer = renderer;
    this.environmentRoot = environmentRoot || scene;
    this._visible = true;

    const geometry = new THREE.PlaneGeometry(opts.width, opts.height, opts.segmentsX, opts.segmentsY);
    // Phase A.2 顶部翻唇：把顶部 lipRows 排顶点向后(-z)+向上弯出「水翻过崖顶」的圆唇。
    // CPU 端改顶点即可（不进 shader）；lipDepth=0 关闭。弯完重算法线，鼓起/fresnel 都吃它。
    const lipRows = opts.lipRows ?? 6;
    const lipDepth = opts.lipDepth ?? opts.height * 0.1;
    if (lipRows > 0 && lipDepth > 0) {
      const posAttr = geometry.attributes.position;
      const uvAttr = geometry.attributes.uv;
      const lipStart = 1 - Math.min(lipRows, opts.segmentsY) / opts.segmentsY;
      for (let i = 0; i < posAttr.count; i++) {
        const v = uvAttr.getY(i);
        if (v <= lipStart) continue;
        const t = (v - lipStart) / Math.max(1 - lipStart, 1e-4);
        posAttr.setZ(i, posAttr.getZ(i) - lipDepth * t * t);
        posAttr.setY(i, posAttr.getY(i) + lipDepth * 0.45 * t * t);
      }
      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    this._defaultFlowNoiseTex = createDefaultNoiseTexture();
    this._defaultFoamNoiseTex = createDefaultNoiseTexture();
    this._defaultDepthTex = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultDepthTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: WATERFALL_VERTEX_SHADER,
      fragmentShader: WATERFALL_FRAGMENT_SHADER,
      uniforms: {
        tDepth: { value: this._defaultDepthTex },
        tFlowNoise: { value: this._defaultFlowNoiseTex },
        tFoamNoise: { value: this._defaultFoamNoiseTex },
        uHasDepthTexture: { value: false },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 1000 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uTopColor: { value: opts.topColor.clone() },
        uBottomColor: { value: opts.bottomColor.clone() },
        uFoamColor: { value: opts.foamColor.clone() },
        // Phase A：主体默认近实色（水体不是薄膜），边缘透明交给 uEdgeAlpha 的 fresnel。
        uOpacity: { value: opts.opacity ?? 0.96 },
        uEdgeAlpha: { value: opts.edgeAlpha ?? 0.3 },
        uBulge: { value: opts.bulge ?? opts.width * 0.22 },
        uColumnCount: { value: opts.columnCount ?? 7 },
        uColumnStyle: { value: opts.columnStyle ?? 0 },
        uEdgeWobble: { value: opts.edgeWobble ?? 0.1 },
        uEdgeWobbleScale: { value: opts.edgeWobbleScale ?? 2.2 },
        uFlowSpeed: { value: opts.flowSpeed ?? 0.85 },
        uFlowScale: { value: opts.flowScale ?? 4.0 },
        uFlowNoiseStrength: { value: opts.flowNoiseStrength ?? 0.35 },
        uFallAcceleration: { value: opts.fallAcceleration ?? 0.9 },
        uSheetDrift: { value: opts.sheetDrift ?? opts.width * 0.035 },
        uSheetTurbulence: { value: opts.sheetTurbulence ?? opts.width * 0.025 },
        uFlowWarp: { value: opts.flowWarp ?? 0.18 },
        uStrandBreakup: { value: opts.strandBreakup ?? 0.28 },
        uBandSteps: { value: opts.bandSteps ?? 5.0 },
        uTopFoamWidth: { value: opts.topFoamWidth ?? 0.08 },
        uBottomFoamHeight: { value: opts.bottomFoamHeight ?? 0.22 },
        uBottomDepthFoamRange: { value: opts.bottomDepthFoamRange ?? 2.5 },
        uBottomFoamIntensity: { value: opts.bottomFoamIntensity ?? 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = opts.name || 'WaterfallSurface';
    this.mesh.position.copy(opts.position);
    if (opts.quaternion) this.mesh.quaternion.copy(opts.quaternion);
    this.mesh.renderOrder = opts.renderOrder ?? RENDER_ORDER.EFFECTS;
    this.mesh.userData.skipShaderApply = true;
    this.mesh.userData.isEnvironmentObject = true;
    this.mesh.userData.isWater = true;
    this.mesh.userData.isWaterfall = true;
    this.environmentRoot.add(this.mesh);

    this._bottomLocalAnchor = new THREE.Vector3(0, -opts.height * 0.5, 0.04);
    this.splashGroup = this._createSplashGroup(opts);
    if (this.splashGroup) this.environmentRoot.add(this.splashGroup);

    // Phase A.6 底部涟漪环：if a receiving water surface is given, pin the bottom
    // contact point into its ripple-decal slots (A.6 slot-ownership protocol, see
    // WaterSurface.pinRippleDecalPoint) — updated each frame in update(), released
    // in dispose(). ponytail: caller picks the receiving surface (global water /
    // model water instance); no scene raycast here.
    this._receivingWater = opts.receivingWater || null;
    this._ripplePinId = null;
    if (this._receivingWater) {
      const p = this._worldBottomAnchor(new THREE.Vector3());
      this._ripplePinId = this._receivingWater.pinRippleDecalPoint(p.x, p.z);
    }

    // Phase E：底部撞击飞溅粒子（可选依赖，同 receivingWater 模式）。caller 传入共享的
    // ParticleEngine 实例；不传则不生成粒子（回退到 6b 的 billboard 水花，零回归）。
    this._particleEngine = opts.particleEngine || null;
    this._splashEmitter = null;
    if (this._particleEngine && opts.splashEnabled !== false) {
      const p = this._worldBottomAnchor(new THREE.Vector3());
      this._splashEmitter = this._particleEngine.spawn({
        emitShape: 'box',
        shapeSize: [Math.max(0.15, opts.width * 0.42), 0.04, 0.12],
        rate: 16,
        lifetime: [0.35, 0.7],
        velocity: { dir: [0, 1, 0], spread: 0.7, speed: [0.5, 1.4] },
        acceleration: [0, -2.4, 0],
        sizeCurve: 'easeOut',
        alphaCurve: 'holdFade',
        scaleStart: 0.5,
        scaleEnd: 1.1,
        meshSize: 0.12,
        colorStart: [0.85, 0.95, 1.0],
        colorEnd: [0.85, 0.95, 1.0],
        alphaStart: 0.8,
        alphaEnd: 0,
      }, { worldPos: [p.x, p.y, p.z] });
    }
  }

  _worldBottomAnchor(target) {
    this.mesh.updateWorldMatrix(true, false);
    return target.copy(this._bottomLocalAnchor).applyMatrix4(this.mesh.matrixWorld);
  }

  _createSplashGroup(opts) {
    if (opts.splashEnabled === false) return null;
    const group = new THREE.Group();
    group.name = 'WaterfallBottomSplash';
    // Phase A.7: splash must sit above the waterfall body — reference EFFECTS_TOP
    // directly (the tier that exists specifically for this), not a hardcoded +1 offset.
    group.renderOrder = opts.renderOrder !== undefined ? opts.renderOrder + 1 : RENDER_ORDER.EFFECTS_TOP;
    group.userData.skipShaderApply = true;
    group.userData.isEnvironmentObject = true;
    group.userData.isWater = true;
    group.userData.isWaterfallSplash = true;

    const geometry = new THREE.PlaneGeometry(opts.width * 0.95, Math.max(0.35, opts.width * 0.32), 8, 2);
    const baseUniforms = {
      uTime: { value: 0 },
      uColor: { value: opts.foamColor.clone() },
      uOpacity: { value: opts.splashOpacity ?? 0.58 },
      uSeed: { value: 0 },
    };
    this.splashMaterial = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERTEX_SHADER,
      fragmentShader: SPLASH_FRAGMENT_SHADER,
      uniforms: baseUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    for (let i = 0; i < 2; i++) {
      const material = i === 0 ? this.splashMaterial : this.splashMaterial.clone();
      material.uniforms.uSeed.value = i * 11.7;
      const plane = new THREE.Mesh(geometry.clone(), material);
      plane.name = `WaterfallSplashPlane${i + 1}`;
      plane.position.y = i * 0.06;
      plane.scale.setScalar(1 + i * 0.22);
      plane.userData.skipShaderApply = true;
      plane.userData.isEnvironmentObject = true;
      plane.userData.isWater = true;
      plane.userData.isWaterfallSplash = true;
      group.add(plane);
    }
    return group;
  }

  get visible() {
    return this._visible;
  }

  setVisible(visible) {
    this._visible = Boolean(visible);
    if (this.mesh) this.mesh.visible = this._visible;
    if (this.splashGroup) this.splashGroup.visible = this._visible;
  }

  getUniforms() {
    return this.material?.uniforms || null;
  }

  update(deltaTime, camera, depthTexture = null) {
    if (!this._visible || !this.material) return;
    const u = this.material.uniforms;
    u.uTime.value += deltaTime;
    u.uCameraNear.value = camera.near;
    u.uCameraFar.value = camera.far;
    const canvas = this.renderer.domElement;
    u.uResolution.value.set(canvas.clientWidth || 1, canvas.clientHeight || 1);
    if (depthTexture) {
      u.tDepth.value = depthTexture;
      u.uHasDepthTexture.value = true;
    } else {
      u.tDepth.value = this._defaultDepthTex;
      u.uHasDepthTexture.value = false;
    }

    if (this.splashGroup || this._ripplePinId != null || this._splashEmitter) {
      const bottomWorld = this._worldBottomAnchor(this._tmpBottomWorld || (this._tmpBottomWorld = new THREE.Vector3()));
      if (this.splashGroup) {
        this.splashGroup.position.copy(bottomWorld);
        this.splashGroup.quaternion.copy(camera.quaternion);
        for (const plane of this.splashGroup.children) {
          if (plane.material?.uniforms?.uTime) plane.material.uniforms.uTime.value = u.uTime.value;
          const pulse = 1.0 + Math.sin(u.uTime.value * 3.0 + plane.material?.uniforms?.uSeed?.value) * 0.08;
          plane.scale.setScalar((plane.name.endsWith('2') ? 1.22 : 1.0) * pulse);
        }
      }
      if (this._ripplePinId != null) {
        this._receivingWater.updatePinnedRipplePoint(this._ripplePinId, bottomWorld.x, bottomWorld.z);
      }
      if (this._splashEmitter) {
        this._splashEmitter.worldPos[0] = bottomWorld.x;
        this._splashEmitter.worldPos[1] = bottomWorld.y;
        this._splashEmitter.worldPos[2] = bottomWorld.z;
      }
    }
  }

  setFlowTexture(texture) {
    this.material.uniforms.tFlowNoise.value = texture || this._defaultFlowNoiseTex;
  }

  setFoamTexture(texture) {
    this.material.uniforms.tFoamNoise.value = texture || this._defaultFoamNoiseTex;
  }

  dispose() {
    if (this._ripplePinId != null) {
      this._receivingWater?.unpinRippleDecalPoint?.(this._ripplePinId);
      this._ripplePinId = null;
    }
    if (this._splashEmitter) {
      this._particleEngine?.remove(this._splashEmitter);
      this._splashEmitter = null;
    }
    if (this.mesh?.parent) this.mesh.parent.remove(this.mesh);
    if (this.splashGroup?.parent) this.splashGroup.parent.remove(this.splashGroup);
    for (const plane of this.splashGroup?.children || []) {
      plane.geometry?.dispose?.();
      plane.material?.dispose?.();
    }
    this.mesh?.geometry?.dispose?.();
    this.material?.dispose?.();
    this._defaultFlowNoiseTex?.dispose?.();
    this._defaultFoamNoiseTex?.dispose?.();
    this._defaultDepthTex?.dispose?.();
    this.mesh = null;
    this.material = null;
    this.splashGroup = null;
    this.splashMaterial = null;
  }
}

export {
  WATERFALL_VERTEX_SHADER,
  WATERFALL_FRAGMENT_SHADER,
  SPLASH_VERTEX_SHADER,
  SPLASH_FRAGMENT_SHADER,
};
