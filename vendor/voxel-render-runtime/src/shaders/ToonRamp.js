// ToonRamp.js — 卡渲风格 shader 层：分层 feature 链（Diffuse Band / Terminator Line / Light Band）
//
// 架构（review 锁定的 4 层）：
//   L1 MeshStandardMaterial 保留 shadow/AO/envMap/roughness/metalness/normalMap。
//   L2 onBeforeCompile 注入 cel patch：只量化漫反射，再独立叠加镜面高光。
//   L3 独立 feature（各自 uniform 组 + gated 块 + UI 段）：
//        · Diffuse Band —— 色阶量化。Band Source 可选（Final Luma / Shadowed NdotL / NdotL）
//          以避开 view-dependent 高光/环境反射污染 diffuse 判定（旋转时过渡带漂移问题）。
//        · Terminator Line —— 明暗交界线。Source：NdotL Isoline / Band Boundary（跟色阶边界绑定）。
//        · Specular Highlight —— 观察方向相关、受实时阴影遮蔽的卡通镜面高光。
//        · Light Band —— 整片亮面/反光色带（原“面状 terminator”改名独立）。
//   L4 Outline owner 独立（不在本文件）。
//
// 一个 anchor（<tonemapping_fragment>）只挂这一个 patch，feature 在内部按块叠加（只改 celOut）。
// PBR 模式绝不挂此补丁（RenderStyleManager.applyPBR 的 removeCelPatch 清扫）。
//
// 参见 docs/tasks/render-style-unification.md。

import { addMaterialShaderPatch, removeMaterialShaderPatch } from '../utils/MaterialShaderPatchChain.js';

export const CEL_PATCH_KEY = 'renderStyle:cel';
const RAMP_WIDTH = 256;

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smoothstep01(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// 枚举 → shader 数值。UI/preset 用字符串，shader uniform 用 float。
export const BAND_SOURCE = { luma: 0, shadowedNdotL: 1, ndl: 2 };
export const TERM_SOURCE = { ndlIsoline: 0, bandBoundary: 1 };
export const LIGHT_BAND_SOURCE = { luma: 0, shadowedNdotL: 1, ndl: 2 };
export const BLEND_MODE = { mix: 0, add: 1, multiply: 2 };
const enumVal = (map, v, dflt) => (typeof v === 'number' ? v : (map[v] ?? map[dflt]));

/** Diffuse Band 默认参数。 */
export const DEFAULT_CEL_BANDING = {
  bands: 4,
  shadowFloor: 0.35,
  highlightFactor: 1.1,
  rampStrength: 1.0,
  transitionSoftness: 0.0,
  bandSource: 'ndl',           // 'luma' | 'shadowedNdotL' | 'ndl'
  bandContrast: 1.0,           // src 上的 gamma：>1 收紧亮部，<1 收紧暗部
  lightColorInfluence: 1.0,    // 0=albedo×band（纯净），1=吃 pbr 光色/阴影（保留 shadow）
  shadowPreserve: 0.0,         // 额外按实时 shadow map 压暗（band source 非 luma 时尤其有用）
  shadowTint: '#ffffff',
  midTint: '#ffffff',
  lightTint: '#ffffff',
};

/** Terminator Line 默认参数。 */
export const DEFAULT_TERMINATOR_LINE = {
  enabled: false,
  source: 'bandBoundary',      // 'ndlIsoline' | 'bandBoundary'
  threshold: 0.3,
  width: 0.08,
  intensity: 0.8,
  color: '#1a1320',
};

/** View-dependent 卡通镜面高光。与漫反射分档分离，避免高光改变色阶。 */
export const DEFAULT_SPECULAR_HIGHLIGHT = {
  enabled: true,
  color: '#fff4d6',
  size: 0.18,
  intensity: 0.1,
  softness: 0.02,
};

/** Light Band（整片亮面/反光色带）默认参数。 */
export const DEFAULT_LIGHT_BAND = {
  enabled: false,
  source: 'ndl',               // 'luma' | 'shadowedNdotL' | 'ndl'
  color: '#fff2cc',
  threshold: 0.7,
  width: 0.25,
  intensity: 0.5,
  softness: 0.1,
  blendMode: 'mix',            // 'mix' | 'add' | 'multiply'
};

/** Rim Light（轮廓光/剪影）默认参数 —— 替代旧 ShaderLibrary uSilhouette。 */
export const DEFAULT_RIM_LIGHT = {
  enabled: false,
  color: '#1a1a2e',
  intensity: 0.0,
  power: 2.0,
};

/**
 * 用 Diffuse Band 参数构建（或原地刷新）1D ramp 贴图（只编码亮度 R，量程 0..2 存为 /2）。
 * transitionSoftness 控制台阶过渡软硬。复用 existing 的 data 数组，零分配。
 */
export function buildToonRampTexture(THREE, params = {}, existing = null) {
  const bands = Math.max(2, Math.round(params.bands ?? DEFAULT_CEL_BANDING.bands));
  const floor = clamp01(params.shadowFloor ?? DEFAULT_CEL_BANDING.shadowFloor);
  const hi = params.highlightFactor ?? DEFAULT_CEL_BANDING.highlightFactor;
  const softness = clamp01(params.transitionSoftness ?? DEFAULT_CEL_BANDING.transitionSoftness);

  let texture = existing;
  let data;
  if (texture?.image?.data?.length === RAMP_WIDTH * 4) {
    data = texture.image.data;
  } else {
    data = new Uint8Array(RAMP_WIDTH * 4);
    texture = null;
  }

  const brightnessForBand = b => floor + (hi - floor) * (b / Math.max(bands - 1, 1));
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const rl = i / (RAMP_WIDTH - 1);
    const fb = rl * bands;
    let bandIndex = Math.min(Math.floor(fb), bands - 1);
    const nextIndex = Math.min(bandIndex + 1, bands - 1);
    const frac = clamp01(fb - bandIndex);
    const t = softness <= 0 ? 0 : smoothstep01(1 - softness, 1, frac);
    let li = brightnessForBand(bandIndex) * (1 - t) + brightnessForBand(nextIndex) * t;
    if (li < 0) li = 0; if (li > 2) li = 2;
    const o = i * 4;
    data[o] = Math.round((li / 2) * 255);
    data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255;
  }

  if (!texture) {
    texture = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
  }
  texture.needsUpdate = true;
  return texture;
}

function makeUniforms(THREE, ctx) {
  const term = ctx.terminator || {};
  const spec = ctx.specular || {};
  const lb = ctx.lightBand || {};
  const rim = ctx.rimLight || {};
  return {
    // ── FEATURE: Diffuse Band ──
    uRampTex: { value: ctx.rampTexture || null },
    uToonColor: { value: ctx.toonColor.clone() },
    uRampStrength: { value: ctx.rampStrength ?? DEFAULT_CEL_BANDING.rampStrength },
    uBands: { value: ctx.bands ?? DEFAULT_CEL_BANDING.bands },
    uBandSource: { value: enumVal(BAND_SOURCE, ctx.bandSource, 'ndl') },
    uBandContrast: { value: ctx.bandContrast ?? DEFAULT_CEL_BANDING.bandContrast },
    uLightColorInfluence: { value: ctx.lightColorInfluence ?? DEFAULT_CEL_BANDING.lightColorInfluence },
    uShadowPreserve: { value: ctx.shadowPreserve ?? DEFAULT_CEL_BANDING.shadowPreserve },
    uShadowTint: { value: new THREE.Color(ctx.shadowTint ?? DEFAULT_CEL_BANDING.shadowTint) },
    uMidTint: { value: new THREE.Color(ctx.midTint ?? DEFAULT_CEL_BANDING.midTint) },
    uLightTint: { value: new THREE.Color(ctx.lightTint ?? DEFAULT_CEL_BANDING.lightTint) },
    uCelLightDir: { value: (ctx.lightDir ? ctx.lightDir.clone() : new THREE.Vector3(0.5, 1, 0.5)).normalize() },
    // ── FEATURE: Terminator Line ──
    uTermEnabled: { value: term.enabled ? 1 : 0 },
    uTermSource: { value: enumVal(TERM_SOURCE, term.source, 'bandBoundary') },
    uTermThreshold: { value: term.threshold ?? DEFAULT_TERMINATOR_LINE.threshold },
    uTermWidth: { value: term.width ?? DEFAULT_TERMINATOR_LINE.width },
    uTermIntensity: { value: term.intensity ?? DEFAULT_TERMINATOR_LINE.intensity },
    uTermColor: { value: new THREE.Color(term.color ?? DEFAULT_TERMINATOR_LINE.color) },
    // ── FEATURE: Specular Highlight ──
    uSpecEnabled: { value: spec.enabled ? 1 : 0 },
    uSpecColor: { value: new THREE.Color(spec.color ?? DEFAULT_SPECULAR_HIGHLIGHT.color) },
    uSpecSize: { value: spec.size ?? DEFAULT_SPECULAR_HIGHLIGHT.size },
    uSpecIntensity: { value: spec.intensity ?? DEFAULT_SPECULAR_HIGHLIGHT.intensity },
    uSpecSoftness: { value: spec.softness ?? DEFAULT_SPECULAR_HIGHLIGHT.softness },
    // ── FEATURE: Light Band ──
    uLBEnabled: { value: lb.enabled ? 1 : 0 },
    uLBSource: { value: enumVal(LIGHT_BAND_SOURCE, lb.source, 'ndl') },
    uLBColor: { value: new THREE.Color(lb.color ?? DEFAULT_LIGHT_BAND.color) },
    uLBThreshold: { value: lb.threshold ?? DEFAULT_LIGHT_BAND.threshold },
    uLBWidth: { value: lb.width ?? DEFAULT_LIGHT_BAND.width },
    uLBIntensity: { value: lb.intensity ?? DEFAULT_LIGHT_BAND.intensity },
    uLBSoftness: { value: lb.softness ?? DEFAULT_LIGHT_BAND.softness },
    uLBBlendMode: { value: enumVal(BLEND_MODE, lb.blendMode, 'mix') },
    // ── FEATURE: Rim Light ──
    uRimEnabled: { value: rim.enabled ? 1 : 0 },
    uRimColor: { value: new THREE.Color(rim.color ?? DEFAULT_RIM_LIGHT.color) },
    uRimIntensity: { value: rim.intensity ?? DEFAULT_RIM_LIGHT.intensity },
    uRimPower: { value: rim.power ?? DEFAULT_RIM_LIGHT.power },
  };
}

const FRAG_UNIFORM_DECL = `#include <common>
// FEATURE: Diffuse Band
uniform sampler2D uRampTex;
uniform vec3 uToonColor;
uniform float uRampStrength;
uniform float uBands;
uniform float uBandSource;
uniform float uBandContrast;
uniform float uLightColorInfluence;
uniform float uShadowPreserve;
uniform vec3 uShadowTint;
uniform vec3 uMidTint;
uniform vec3 uLightTint;
uniform vec3 uCelLightDir;
// FEATURE: Terminator Line
uniform float uTermEnabled;
uniform float uTermSource;
uniform float uTermThreshold;
uniform float uTermWidth;
uniform float uTermIntensity;
uniform vec3 uTermColor;
// FEATURE: Specular Highlight
uniform float uSpecEnabled;
uniform vec3 uSpecColor;
uniform float uSpecSize;
uniform float uSpecIntensity;
uniform float uSpecSoftness;
// FEATURE: Light Band
uniform float uLBEnabled;
uniform float uLBSource;
uniform vec3 uLBColor;
uniform float uLBThreshold;
uniform float uLBWidth;
uniform float uLBIntensity;
uniform float uLBSoftness;
uniform float uLBBlendMode;
// FEATURE: Rim Light
uniform float uRimEnabled;
uniform vec3 uRimColor;
uniform float uRimIntensity;
uniform float uRimPower;
varying vec3 vCelWorldNormal;
varying vec3 vCelWorldPosition;

float celPickSource(float sel, float lumaRatio, float ndl, float shadowMask) {
  if (sel < 0.5) return lumaRatio;
  if (sel < 1.5) return ndl * shadowMask;
  return ndl;
}`;

const CEL_SHADOW_MASK_GLSL = `
float celGetShadowMask() {
  float shadow = 1.0;

  #ifdef USE_SHADOWMAP

    #if NUM_DIR_LIGHT_SHADOWS > 0

      #if defined( USE_CSM ) && defined( CSM_CASCADES )
        float csmShadow = 1.0;
        float linearDepth = vViewPosition.z / (shadowFar - cameraNear);
        DirectionalLightShadow directionalShadow;

        #if defined( CSM_FADE )
          vec2 cascade;
          float cascadeCenter;
          float closestEdge;
          float margin;
          float csmx;
          float csmy;

          #pragma unroll_loop_start
          for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
            cascade = CSM_cascades[ i ];
            cascadeCenter = ( cascade.x + cascade.y ) * 0.5;
            closestEdge = linearDepth < cascadeCenter ? cascade.x : cascade.y;
            margin = 0.25 * pow( closestEdge, 2.0 );
            csmx = cascade.x - margin * 0.5;
            csmy = cascade.y + margin * 0.5;

            if ( linearDepth >= csmx && ( linearDepth < csmy || UNROLLED_LOOP_INDEX == CSM_CASCADES - 1 ) ) {
              float dist = min( linearDepth - csmx, csmy - linearDepth );
              float ratio = clamp( dist / max( margin, 1e-5 ), 0.0, 1.0 );
              directionalShadow = directionalLightShadows[ i ];
              float cascadeShadow = receiveShadow
                ? getShadow(
                    directionalShadowMap[ i ],
                    directionalShadow.shadowMapSize,
                    directionalShadow.shadowBias,
                    directionalShadow.shadowRadius,
                    vDirectionalShadowCoord[ i ]
                  )
                : 1.0;

              bool fadeLast = UNROLLED_LOOP_INDEX == CSM_CASCADES - 1 && linearDepth > cascadeCenter;
              cascadeShadow = mix(1.0, cascadeShadow, fadeLast ? ratio : 1.0);
              bool blendCascade = UNROLLED_LOOP_INDEX != CSM_CASCADES - 1
                || linearDepth < cascadeCenter;
              csmShadow = mix(csmShadow, cascadeShadow, blendCascade ? ratio : 1.0);
            }
          }
          #pragma unroll_loop_end
        #else
          #pragma unroll_loop_start
          for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
            if ( linearDepth >= CSM_cascades[ i ].x && linearDepth < CSM_cascades[ i ].y ) {
              directionalShadow = directionalLightShadows[ i ];
              csmShadow = receiveShadow
                ? getShadow(
                    directionalShadowMap[ i ],
                    directionalShadow.shadowMapSize,
                    directionalShadow.shadowBias,
                    directionalShadow.shadowRadius,
                    vDirectionalShadowCoord[ i ]
                  )
                : 1.0;
            }
          }
          #pragma unroll_loop_end
        #endif

        shadow *= csmShadow;
      #else
        DirectionalLightShadow directionalShadow;
        #pragma unroll_loop_start
        for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
          directionalShadow = directionalLightShadows[ i ];
          shadow *= receiveShadow
            ? getShadow(
                directionalShadowMap[ i ],
                directionalShadow.shadowMapSize,
                directionalShadow.shadowBias,
                directionalShadow.shadowRadius,
                vDirectionalShadowCoord[ i ]
              )
            : 1.0;
        }
        #pragma unroll_loop_end
      #endif

    #endif

    #if NUM_SPOT_LIGHT_SHADOWS > 0
      SpotLightShadow spotShadow;
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
        spotShadow = spotLightShadows[ i ];
        shadow *= receiveShadow
          ? getShadow(
              spotShadowMap[ i ],
              spotShadow.shadowMapSize,
              spotShadow.shadowBias,
              spotShadow.shadowRadius,
              vSpotLightCoord[ i ]
            )
          : 1.0;
      }
      #pragma unroll_loop_end
    #endif

    #if NUM_POINT_LIGHT_SHADOWS > 0
      PointLightShadow pointShadow;
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
        pointShadow = pointLightShadows[ i ];
        shadow *= receiveShadow
          ? getPointShadow(
              pointShadowMap[ i ],
              pointShadow.shadowMapSize,
              pointShadow.shadowBias,
              pointShadow.shadowRadius,
              vPointShadowCoord[ i ],
              pointShadow.shadowCameraNear,
              pointShadow.shadowCameraFar
            )
          : 1.0;
      }
      #pragma unroll_loop_end
    #endif

  #endif

  return shadow;
}`;

const FRAG_BODY = `
{
  // L2：cel patch。各 feature 独立 gated 块，只改 celOut，互不重写。
  vec3 pbrLit = gl_FragColor.rgb;
  vec3 celOut = pbrLit;

  vec3 celLuma = vec3(0.299, 0.587, 0.114);
  vec3 directLit = reflectedLight.directDiffuse;
  vec3 indirectLit = reflectedLight.indirectDiffuse + totalEmissiveRadiance;
  float ndl = clamp(dot(normalize(vCelWorldNormal), normalize(uCelLightDir)), 0.0, 1.0);
  float celPbrNdl = clamp(dot(normalize(inverseTransformDirection(normal, viewMatrix)), normalize(uCelLightDir)), 0.0, 1.0);
  float celNormalCompensation = celPbrNdl > 1e-4
    ? clamp(ndl / max(celPbrNdl, 0.05), 0.0, 4.0)
    : 1.0;
  vec3 smoothDirectLit = directLit * celNormalCompensation;
  vec3 diffuseLit = smoothDirectLit + indirectLit;
  float pbrLum = dot(diffuseLit, celLuma);
  float baseLum = max(dot(uToonColor.rgb, celLuma), 0.05);
  float lumaRatio = pbrLum / baseLum;
  float shadowMask = celGetShadowMask();   // CSM 只采当前级联；无 shadow map 时恒 1

  // ── FEATURE: Diffuse Band ──────────────────────────────────────────────
  // 用可选 Band Source 决定档位（避开 view-dependent 高光/环境污染 diffuse 判定）。
  float bandSrc = celPickSource(uBandSource, lumaRatio, ndl, shadowMask);
  bandSrc = pow(clamp(bandSrc, 0.0, 1.0), max(uBandContrast, 0.01));
  float band = texture2D(uRampTex, vec2(clamp(bandSrc, 0.0, 1.0), 0.5)).r * 2.0;
  float bp = clamp(band, 0.0, 1.0);
  vec3 tint = bp < 0.5 ? mix(uShadowTint, uMidTint, bp * 2.0)
                       : mix(uMidTint, uLightTint, (bp - 0.5) * 2.0);
  vec3 albedoCel = uToonColor.rgb * band;                                  // 纯净：albedo×档位
  vec3 pbrCel = smoothDirectLit * clamp(band / max(ndl, 0.05), 0.0, 8.0);  // 保留光色/阴影，不重新引入逐面 N·L
  float neutralDirectScale = clamp(
    dot(smoothDirectLit, celLuma) / max(baseLum * max(ndl, 0.05), 0.01),
    0.0,
    8.0
  );
  vec3 neutralCel = albedoCel * neutralDirectScale;
  vec3 celDirect = mix(neutralCel, pbrCel, clamp(uLightColorInfluence, 0.0, 1.0)) * tint;
  celDirect *= mix(1.0, shadowMask, clamp(uShadowPreserve, 0.0, 1.0));
  vec3 celDiffuse = celDirect + indirectLit;                                // 半球光独立控制暗部
  celOut = mix(pbrLit, celDiffuse, clamp(uRampStrength, 0.0, 1.0));

  // ── FEATURE: Terminator Line ───────────────────────────────────────────
  if (uTermEnabled > 0.5) {
    float line;
    if (uTermSource < 0.5) {
      // NdotL Isoline：|N·L - threshold| 窄带（几何等照度线）
      float d = abs(ndl - uTermThreshold);
      line = 1.0 - smoothstep(uTermWidth * 0.5, uTermWidth, d);
    } else {
      // Band Boundary：跟 Diffuse Band 色阶边界绑定 —— 档位跳变处画线，宽度按屏幕自适应。
      float fb = bandSrc * uBands;
      float fr = fract(fb);
      float edge = min(fr, 1.0 - fr);           // 0 = 正好在档位边界
      float aa = max(fwidth(fb), 1e-4);
      line = 1.0 - smoothstep(0.0, uTermWidth + aa, edge / aa);
    }
    celOut = mix(celOut, uTermColor, clamp(line, 0.0, 1.0) * uTermIntensity);
  }

  // ── FEATURE: Specular Highlight ────────────────────────────────────────
  // 独立于漫反射色阶的卡通高光：观察方向决定形状，实时阴影决定可见性。
  if (uSpecEnabled > 0.5) {
    vec3 N = normalize(vCelWorldNormal);
    vec3 L = normalize(uCelLightDir);
    vec3 V = normalize(cameraPosition - vCelWorldPosition);
    vec3 H = normalize(L + V);
    float materialSize = clamp(1.0 - roughnessFactor, 0.0, 1.0);
    float tunedSize = mix(materialSize, clamp(uSpecSize, 0.0, 1.0), 0.75);
    float exponent = mix(160.0, 8.0, tunedSize);
    float specSignal = pow(max(dot(N, H), 0.0), exponent);
    float aa = max(fwidth(specSignal), 1e-4);
    float edge = aa + clamp(uSpecSoftness, 0.0, 1.0) * 0.25;
    float specMask = smoothstep(0.5 - edge, 0.5 + edge, specSignal);
    specMask *= shadowMask;
    specMask *= step(1e-4, ndl);
    celOut = mix(celOut, uSpecColor, clamp(specMask * uSpecIntensity, 0.0, 1.0));
  }

  // ── FEATURE: Light Band（整片亮面/反光色带）─────────────────────────────
  if (uLBEnabled > 0.5) {
    float lsrc = celPickSource(uLBSource, lumaRatio, ndl, shadowMask);
    float halfW = uLBWidth * 0.5;
    float soft = max(uLBSoftness, 1e-4);
    float lband = smoothstep(uLBThreshold - halfW - soft, uLBThreshold - halfW, lsrc)
                * (1.0 - smoothstep(uLBThreshold + halfW, uLBThreshold + halfW + soft, lsrc));
    float a = clamp(lband * uLBIntensity, 0.0, 1.0);
    vec3 blended;
    if (uLBBlendMode < 0.5)      blended = mix(celOut, uLBColor, a);          // mix
    else if (uLBBlendMode < 1.5) blended = celOut + uLBColor * a;             // add
    else                         blended = mix(celOut, celOut * uLBColor, a); // multiply
    celOut = blended;
  }

  // ── FEATURE: Rim Light（轮廓光/剪影，替代旧 uSilhouette）────────────────────
  if (uRimEnabled > 0.5) {
    vec3 N = normalize(vCelWorldNormal);
    vec3 V = normalize(cameraPosition - vCelWorldPosition);
    float rim = 1.0 - abs(dot(N, V));
    rim = pow(rim, uRimPower);
    celOut = mix(celOut, uRimColor, clamp(rim * uRimIntensity, 0.0, 1.0));
  }

  gl_FragColor = vec4(celOut, gl_FragColor.a);
}
#include <tonemapping_fragment>`;

/**
 * 给 MeshStandardMaterial 装 cel 补丁（Diffuse Band + Terminator + Specular + Light Band）。
 *
 * cacheKey 必须绑安装代数（同 CSMShadowSetup 的教训）：three 按 material 缓存
 * program（materialProperties.programs），key 不变即命中——命中时 onBeforeCompile
 * 不重跑，且 materialProperties.uniforms 停留在上一个变体（PBR）编译时的 map，
 * cel uniforms 不在上传清单里。后果：pbr↔cel 第二次切进 cel 起，渲染冻结在
 * 第一代参数值、setCartoonParams/滑条全部失效（2026-07-17 浏览器 readPixels +
 * renderer.properties 实锤，render-runtime-package-v1 A1 根因）。安装代数由
 * MaterialShaderPatchChain 统一追加，强制缓存 miss → onBeforeCompile 必然重跑 →
 * uniforms map 重新绑定。GLSL 源不变，重编译走驱动层 program cache，代价可接受。
 */
export function installCelPatch(material, ctx) {
  if (!material) return;
  const uniforms = makeUniforms(ctx.THREE, ctx);
  material.userData.celPatchUniforms = uniforms;
  material.defines = material.defines || {};
  material.defines.USE_NPR_TOON = 1;

  addMaterialShaderPatch(material, CEL_PATCH_KEY, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // Vertex：导出平滑世界法线（专供 N·L 类判定）。flatShading 下 fragment 的 normal 是逐面常量，
    // 会让 isoline 退化成整面；平滑法线随表面连续变化才出线。兼顾 InstancedMesh。
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vCelWorldNormal;
varying vec3 vCelWorldPosition;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <defaultnormal_vertex>',
      `#include <defaultnormal_vertex>
vCelWorldNormal = inverseTransformDirection(normalize(transformedNormal), viewMatrix);`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
{
  vec4 celWorldPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    celWorldPosition = instanceMatrix * celWorldPosition;
  #endif
  vCelWorldPosition = (modelMatrix * celWorldPosition).xyz;
}`
    );

    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', FRAG_UNIFORM_DECL);
    // getShadowMask() 定义在 shadowmask_pars_fragment；MeshStandard 默认不含，需显式引入。
    // 必须放在 shadowmap_pars_fragment（声明 shadow uniform 数组）之后、main 之前，否则引用未声明符号。
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <shadowmap_pars_fragment>',
      `#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${CEL_SHADOW_MASK_GLSL}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      FRAG_BODY
    );
  }, { order: 100, cacheKey: () => 'cel-patch-v7' });

  material.needsUpdate = true;
}

/** 彻底卸下 cel 补丁（切回 PBR/Ink）：移除 patch/define/userData，置 needsUpdate。 */
export function removeCelPatch(material) {
  if (!material) return;
  removeMaterialShaderPatch(material, CEL_PATCH_KEY);
  if (material.defines && material.defines.USE_NPR_TOON) delete material.defines.USE_NPR_TOON;
  delete material.userData.celPatchUniforms;
  material.needsUpdate = true;
}

/** 刷新已挂补丁材质的 uniform（不重编译）。patch 字段见各 feature 注释。 */
export function updateCelPatchUniforms(material, patch = {}) {
  const u = material?.userData?.celPatchUniforms;
  if (!u) return;
  // FEATURE: Diffuse Band
  if (patch.rampTexture !== undefined) u.uRampTex.value = patch.rampTexture;
  if (patch.rampStrength !== undefined) u.uRampStrength.value = clamp01(patch.rampStrength);
  if (patch.bands !== undefined) u.uBands.value = patch.bands;
  if (patch.bandSource !== undefined) u.uBandSource.value = enumVal(BAND_SOURCE, patch.bandSource, 'ndl');
  if (patch.bandContrast !== undefined) u.uBandContrast.value = Number(patch.bandContrast);
  if (patch.lightColorInfluence !== undefined) u.uLightColorInfluence.value = clamp01(patch.lightColorInfluence);
  if (patch.shadowPreserve !== undefined) u.uShadowPreserve.value = clamp01(patch.shadowPreserve);
  if (patch.shadowTint !== undefined) u.uShadowTint.value.set(patch.shadowTint);
  if (patch.midTint !== undefined) u.uMidTint.value.set(patch.midTint);
  if (patch.lightTint !== undefined) u.uLightTint.value.set(patch.lightTint);
  if (patch.lightDir) u.uCelLightDir.value.copy(patch.lightDir).normalize();
  // FEATURE: Terminator Line
  const t = patch.terminator;
  if (t) {
    if (t.enabled !== undefined) u.uTermEnabled.value = t.enabled ? 1 : 0;
    if (t.source !== undefined) u.uTermSource.value = enumVal(TERM_SOURCE, t.source, 'bandBoundary');
    if (t.threshold !== undefined) u.uTermThreshold.value = Number(t.threshold);
    if (t.width !== undefined) u.uTermWidth.value = Number(t.width);
    if (t.intensity !== undefined) u.uTermIntensity.value = Number(t.intensity);
    if (t.color !== undefined) u.uTermColor.value.set(t.color);
  }
  // FEATURE: Specular Highlight
  const spec = patch.specular;
  if (spec) {
    if (spec.enabled !== undefined) u.uSpecEnabled.value = spec.enabled ? 1 : 0;
    if (spec.color !== undefined) u.uSpecColor.value.set(spec.color);
    if (spec.size !== undefined) u.uSpecSize.value = clamp01(spec.size);
    if (spec.intensity !== undefined) u.uSpecIntensity.value = clamp01(spec.intensity);
    if (spec.softness !== undefined) u.uSpecSoftness.value = clamp01(spec.softness);
  }
  // FEATURE: Light Band
  const lb = patch.lightBand;
  if (lb) {
    if (lb.enabled !== undefined) u.uLBEnabled.value = lb.enabled ? 1 : 0;
    if (lb.source !== undefined) u.uLBSource.value = enumVal(LIGHT_BAND_SOURCE, lb.source, 'ndl');
    if (lb.color !== undefined) u.uLBColor.value.set(lb.color);
    if (lb.threshold !== undefined) u.uLBThreshold.value = Number(lb.threshold);
    if (lb.width !== undefined) u.uLBWidth.value = Number(lb.width);
    if (lb.intensity !== undefined) u.uLBIntensity.value = Number(lb.intensity);
    if (lb.softness !== undefined) u.uLBSoftness.value = Number(lb.softness);
    if (lb.blendMode !== undefined) u.uLBBlendMode.value = enumVal(BLEND_MODE, lb.blendMode, 'mix');
  }
  // FEATURE: Rim Light
  const rim = patch.rimLight;
  if (rim) {
    if (rim.enabled !== undefined) u.uRimEnabled.value = rim.enabled ? 1 : 0;
    if (rim.color !== undefined) u.uRimColor.value.set(rim.color);
    if (rim.intensity !== undefined) u.uRimIntensity.value = Number(rim.intensity);
    if (rim.power !== undefined) u.uRimPower.value = Number(rim.power);
  }
}
