/**
 * FoliageLayer.js — 块状冠层材质（叶片印章 + 蓬松法线 + 逆光透叶），无贴图/无 UV。
 *
 * 本层只负责块状树冠/灌木的材质塑形：
 *   1. 叶簇（fragment，discard + baseColor）：从局部 bbox 自动识别当前 box 面，在面内用
 *      Voronoi 单元放置随机旋转的尖叶印章；冠层中心保持厚实，越靠边越露出独立叶片轮廓。
 *      同一 leaf cell 同时驱动镂空、色差、中脉和叶面高光，避免旧版“随机洞 + 独立迷彩色块”。
 *   2. 蓬松光照（normal + fragment）：侧面法线只做轻微统一上弯；片元再按每片叶的主脉构造
 *      低锐度 V 形折面法线，驱动叶面高光与双面透叶，避免再次强调 box 轮廓。
 * 植物摆动已抽到 VegetationSwayLayer；`foliage:leaf` 由词表将两层组合，非块状植物只用摆动层。
 *
 * stage = 'base'。与 Triplanar/MatcapBase 不互斥（本层只乘法调制 baseColor，不覆盖底色），
 * 由 material-tags 编译进 base 合批配方（materialTagBaseRecipe），与 Triplanar 同路进 InstancedMesh/
 * BatchedMesh 批材质。
 *
 * 已知 v1 限制（与 Triplanar 一致，人工验收接受）：
 *   - 阴影/深度 pass 不打本补丁 → 影子不镂空。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 */

import { EffectLayer } from '../EffectLayer.js';
import { Foliage as FOLIAGE_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  cutoutScale: 'uFoliageCutoutScale',
  cutoutThreshold: 'uFoliageCutoutThreshold',
  // 叶片质感（v2 leaf stamps）：全部乘法调制已有光照色，不写绝对颜色、不依赖贴图。
  clusterScale: 'uFoliageClusterScale',       // 兼容旧参数名：现在控制叶片细长程度
  clusterVariance: 'uFoliageClusterVariance', // 逐叶明度/冷暖抖动幅度
  aoStrength: 'uFoliageAoStrength',           // 冠层伪 AO：底暗顶亮梯度强度
  rimStrength: 'uFoliageRimStrength',         // 兼容旧参数名：叶面高光强度
  rimWidth: 'uFoliageRimWidth',               // 兼容旧参数名：叶面高光柔度
  quantSteps: 'uFoliageQuantSteps',           // 色阶数：0=平滑，N≥1=硬色带(卡通)
  puffiness: 'uFoliagePuffiness',              // 侧面法线向冠层顶部弯曲的混合量
  transmission: 'uFoliageTransmission',       // 风格化逆光透叶强度
};

export class FoliageLayer extends EffectLayer {
  constructor(manifest = FOLIAGE_MANIFEST) {
    super(manifest);
  }

  /**
   * GLSL uniform 声明 + 自包含 Voronoi 叶片印章数学（effFoliage 前缀，避免与其他层撞名）。
   * 注入进 fragment 顶部；injector 变体路径会把本声明同时注入 vertex。
   */
  getUniformDeclarations() {
    return [
      'uniform float uFoliageCutoutScale;',
      'uniform float uFoliageCutoutThreshold;',
      'uniform float uFoliageClusterScale;',
      'uniform float uFoliageClusterVariance;',
      'uniform float uFoliageAoStrength;',
      'uniform float uFoliageRimStrength;',
      'uniform float uFoliageRimWidth;',
      'uniform float uFoliageQuantSteps;',
      'uniform float uFoliagePuffiness;',
      'uniform float uFoliageTransmission;',
      'uniform vec3 uEffLayerBoundsMin;',
      'uniform vec3 uEffLayerBoundsSize;',
      'uniform float uEffLayerObjectPhase;',
      // 2D hash + voronoi：每个最近点就是一片叶的中心；cellDelta 是该叶片自己的局部坐标。
      'float effFoliageHash21(vec2 p) {',
      '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
      '  p3 += dot(p3, p3.yzx + 33.33);',
      '  return fract((p3.x + p3.y) * p3.z);',
      '}',
      'void effFoliageVoronoi(vec2 p, float faceSeed, out float f1, out vec2 cellId, out vec2 cellDelta) {',
      '  vec2 ip = floor(p);',
      '  vec2 fp = fract(p);',
      '  f1 = 8.0;',
      '  cellId = ip;',
      '  cellDelta = vec2(0.0);',
      '  for (int y = -1; y <= 1; y++) {',
      '    for (int x = -1; x <= 1; x++) {',
      '      vec2 g = vec2(float(x), float(y));',
      '      vec2 seed = ip + g + vec2(faceSeed * 19.19, faceSeed * 7.73);',
      '      vec2 o = vec2(effFoliageHash21(seed), effFoliageHash21(seed + 17.13));',
      '      vec2 r = g + o - fp;',
      '      float d = dot(r, r);',
      '      if (d < f1) { f1 = d; cellId = ip + g; cellDelta = r; }',
      '    }',
      '  }',
      '  f1 = sqrt(f1);',
      '}',
      // 不依赖 normal：从 bbox 表面上离哪个轴向边界最近，判断片元属于 box 的哪个面。
      // 局部坐标和 faceId 对旋转部件稳定；正反面用不同 seed，避免叶洞前后完全对齐。
      'void effFoliageFaceUv(vec3 p01, out vec2 uv, out float faceId) {',
      '  vec3 boundary = min(p01, 1.0 - p01);',
      '  if (boundary.x <= boundary.y && boundary.x <= boundary.z) {',
      '    uv = p01.zy;',
      '    faceId = p01.x > 0.5 ? 1.0 : 0.0;',
      '  } else if (boundary.y <= boundary.z) {',
      '    uv = p01.xz;',
      '    faceId = p01.y > 0.5 ? 3.0 : 2.0;',
      '  } else {',
      '    uv = p01.xy;',
      '    faceId = p01.z > 0.5 ? 5.0 : 4.0;',
      '  }',
      '}',
    ].join('\n');
  }

  /**
   * 顶点 body：只负责块状冠层的蓬松法线。植物摆动由 VegetationSwayLayer 统一负责。
   */
  getVertexBody() {
    return [
      '// Bent canopy normal: tilt only side faces upward; do not turn every box into its own sphere.',
      'float foliageSideWeight = 1.0 - abs(objectNormal.y);',
      'vec3 foliageBentTarget = normalize(vec3(objectNormal.x * 0.85, 0.55, objectNormal.z * 0.85));',
      'float foliageBendAmount = uFoliagePuffiness * foliageSideWeight * 0.45;',
      'vec3 foliagePuffNormal = normalize(mix(objectNormal, foliageBentTarget, foliageBendAmount));',
      'vEffLayerWorldNormal = normalize(mat3(modelMatrix) * foliagePuffNormal);',
    ].join('\n');
  }

  /** Three 在 normal map 后、光照前执行；flatShading 与 DoubleSide 都能吃到蓬松法线。 */
  getNormalBody() {
    return [
      'normal = normalize(mat3(viewMatrix) * vEffLayerWorldNormal);',
      '#ifdef DOUBLE_SIDED',
      'normal *= faceDirection;',
      '#endif',
    ].join('\n');
  }

  /**
   * 片元 body：结构化叶片印章。冠层中心保持厚实，边缘由尖叶 SDF 打碎；同一 leaf cell
   * 同时驱动镂空、逐叶色差、中脉/V 形折面和叶面高光。opaque discard（不开 transparent，深度正确）。
   */
  getFragmentBody() {
    return [
      '// ── 1) 局部面投影：从 bbox 表面判断当前 box 面，旋转部件也不依赖世界轴投影 ──',
      'vec3 foliage01 = (vEffLayerLocalPos - uEffLayerBoundsMin) / max(uEffLayerBoundsSize, vec3(0.0001));',
      'vec2 foliageFaceUv; float foliageFaceId;',
      'effFoliageFaceUv(clamp(foliage01, 0.0, 1.0), foliageFaceUv, foliageFaceId);',
      '// ── 2) 一格一叶：Voronoi 最近点给出叶片中心和叶内坐标，再随机旋转成尖椭圆叶形 ──',
      'float foliageF1; vec2 foliageCellId; vec2 foliageCellDelta;',
      'effFoliageVoronoi(foliageFaceUv * uFoliageCutoutScale, foliageFaceId, foliageF1, foliageCellId, foliageCellDelta);',
      'float foliageFaceEdge = min(min(foliageFaceUv.x, 1.0 - foliageFaceUv.x), min(foliageFaceUv.y, 1.0 - foliageFaceUv.y));',
      'float foliageRandomAngle = effFoliageHash21(foliageCellId + vec2(foliageFaceId * 3.17, 11.9)) * 6.2831853;',
      'float foliageLeafAngle = foliageRandomAngle;',
      'float foliageLeafSin = sin(foliageLeafAngle);',
      'float foliageLeafCos = cos(foliageLeafAngle);',
      'vec2 foliageLeafLocal = mat2(foliageLeafCos, -foliageLeafSin, foliageLeafSin, foliageLeafCos) * foliageCellDelta;',
      'float foliageLeafAspect = clamp(0.9 + uFoliageClusterScale * 0.18, 1.0, 3.5);',
      'foliageLeafLocal.x *= foliageLeafAspect;',
      'float foliageLeafAbsY = abs(foliageLeafLocal.y);',
      'float foliageLeafHalfWidth = 0.48 * pow(max(1.0 - foliageLeafAbsY / 0.72, 0.0), 0.58);',
      'float foliageLeafSdf = max(abs(foliageLeafLocal.x) - foliageLeafHalfWidth, foliageLeafAbsY - 0.72);',
      'float foliageLeafMask = 1.0 - smoothstep(-0.025, 0.045, foliageLeafSdf);',
      '',
      '// 中心厚、边缘露叶：内部强制形成连续冠层质量，边缘才由独立叶形决定 silhouette。',
      'float foliageCenterMass = smoothstep(0.035, 0.18, foliageFaceEdge);',
      'float foliageCoverage = max(foliageLeafMask, foliageCenterMass);',
      'if (foliageCoverage < uFoliageCutoutThreshold) discard;',
      '',
      '// ── 3) 同一片叶的颜色语言：leaf id 决定色差，leaf local 决定中脉与轻微左右折面 ──',
      'float foliageLeafJit = (effFoliageHash21(foliageCellId + vec2(foliageFaceId * 5.71, 5.3)) - 0.5) * 2.0 * uFoliageClusterVariance;',
      'float foliageMidrib = (1.0 - smoothstep(0.015, 0.075, abs(foliageLeafLocal.x)))',
      '  * (1.0 - smoothstep(0.42, 0.70, foliageLeafAbsY));',
      'float foliageFold = sign(foliageLeafLocal.x) * 0.035 * (1.0 - smoothstep(0.35, 0.70, foliageLeafAbsY));',
      '',
      '// 冠层伪 AO：局部 bbox 底部/内部压暗、顶部提亮（每片叶卡各自成一个小冠层的明暗梯度）。',
      'float foliageAo = mix(1.0 - uFoliageAoStrength, 1.0 + uFoliageAoStrength * 0.4, clamp(foliage01.y, 0.0, 1.0));',
      '',
      '// 色阶量化（卡通）：quantSteps>=1 时把调制量硬分档；=0 保持平滑。',
      'float foliageFacetedShade = (1.0 + foliageLeafJit + foliageMidrib * 0.045 + foliageFold) * foliageAo;',
      'if (uFoliageQuantSteps >= 1.0) {',
      '  foliageFacetedShade = floor(foliageFacetedShade * uFoliageQuantSteps + 0.5) / uFoliageQuantSteps;',
      '}',
      '',
      '// 逐叶冷暖偏移 + 顶暖底冷，全部围绕 1.0 乘法调制，保留模型原始叶色。',
      'vec3 foliageLeafTint = vec3(1.0 + foliageLeafJit * 0.16, 1.0 + foliageLeafJit * 0.05, 1.0 - foliageLeafJit * 0.14);',
      'vec3 foliageHeightTint = mix(vec3(0.94, 0.985, 1.055), vec3(1.055, 1.025, 0.91), clamp(foliage01.y, 0.0, 1.0));',
      'foliageHeightTint = mix(vec3(1.0), foliageHeightTint, uFoliageAoStrength * 0.55);',
      'gl_FragColor.rgb *= foliageFacetedShade * foliageLeafTint * foliageHeightTint;',
      '',
      '// 叶片 V 形折面：主脉两侧各是一块低频平面，打散 box 面统一法线。',
      'vec3 foliageBaseViewNormal = normalize(mat3(viewMatrix) * vEffLayerWorldNormal);',
      '#ifdef DOUBLE_SIDED',
      'foliageBaseViewNormal *= faceDirection;',
      '#endif',
      'vec3 foliageViewUp = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));',
      'vec3 foliageViewRight = normalize(mat3(viewMatrix) * vec3(1.0, 0.0, 0.0));',
      'vec3 foliageBasisReference = abs(dot(foliageBaseViewNormal, foliageViewUp)) < 0.9',
      '  ? foliageViewUp : foliageViewRight;',
      'vec3 foliageLeafTangentView = normalize(cross(foliageBasisReference, foliageBaseViewNormal));',
      'vec3 foliageLeafBitangentView = normalize(cross(foliageBaseViewNormal, foliageLeafTangentView));',
      'float foliageFoldSide = smoothstep(-0.09, 0.09, foliageLeafLocal.x) * 2.0 - 1.0;',
      'vec2 foliageFoldSlopeLeaf = vec2(foliageFoldSide * 0.42, foliageLeafLocal.y * 0.12);',
      'vec2 foliageFoldSlopeFace = mat2(',
      '  foliageLeafCos, foliageLeafSin, -foliageLeafSin, foliageLeafCos',
      ') * foliageFoldSlopeLeaf;',
      'vec3 foliageLeafDetailViewNormal = normalize(',
      '  foliageBaseViewNormal',
      '  - foliageLeafTangentView * foliageFoldSlopeFace.x * uFoliagePuffiness',
      '  - foliageLeafBitangentView * foliageFoldSlopeFace.y * uFoliagePuffiness',
      ');',
      '',
      '// 主光与视线：复用 renderer 已有方向光，无方向光时回退到 Y-up。',
      'vec3 foliageLightDirection = normalize(mat3(viewMatrix) * vec3(-0.32, 0.91, 0.26));',
      '#if NUM_DIR_LIGHTS > 0',
      'foliageLightDirection = normalize(directionalLights[0].direction);',
      '#endif',
      'vec3 foliageViewDirection = normalize(vViewPosition);',
      '',
      '// 叶面高光：低锐度、按 V 形折面变化，只出现在叶片内部，不再描 coverage/box 轮廓。',
      'vec3 foliageHalfVector = normalize(foliageLightDirection + foliageViewDirection + vec3(0.0001));',
      'float foliageHighlightSoftness = clamp((uFoliageRimWidth - 0.01) / 0.29, 0.0, 1.0);',
      'float foliageSpecularPower = mix(56.0, 6.0, foliageHighlightSoftness);',
      'float foliageSpecularLobe = pow(max(dot(foliageLeafDetailViewNormal, foliageHalfVector), 0.0), foliageSpecularPower);',
      'float foliageLeafInterior = smoothstep(0.18, 0.72, foliageLeafMask);',
      'float foliageSpecularBreakup = 0.72 + effFoliageHash21(foliageCellId + 31.7) * 0.28;',
      'float foliageLeafSpecular = foliageSpecularLobe * foliageLeafInterior',
      '  * foliageSpecularBreakup * uFoliageRimStrength;',
      'vec3 foliageSpecularTint = mix(gl_FragColor.rgb, vec3(0.72, 1.0, 0.34), 0.35);',
      'float foliageHighlight = foliageLeafSpecular * 0.48;',
      'gl_FragColor.rgb += foliageSpecularTint * foliageHighlight;',
      '',
      '// 双面薄叶透光：背向 wrap + 视线背光，叶片内部更透；不加入无条件常亮项。',
      'float foliageLightFacing = dot(foliageLeafDetailViewNormal, foliageLightDirection);',
      'float foliageBackDiffuse = clamp(-foliageLightFacing * 0.55 + 0.45, 0.0, 1.0);',
      'float foliageBacklight = pow(max(dot(foliageViewDirection, -foliageLightDirection), 0.0), 4.0);',
      'float foliageTransmissionWrap = mix(foliageBackDiffuse, foliageBacklight, 0.55);',
      'float foliageBackfaceWeight = gl_FrontFacing ? 0.55 : 1.0;',
      'float foliageLeafTransmissionMask = mix(0.42, 1.0, foliageLeafInterior);',
      'float foliageTransmissionMask = foliageLeafTransmissionMask;',
      'float foliageTransmissionGlow = foliageTransmissionWrap * foliageBackfaceWeight',
      '  * foliageTransmissionMask * uFoliageTransmission;',
      'gl_FragColor.rgb += max(gl_FragColor.rgb, vec3(0.05))',
      '  * vec3(0.30, 0.72, 0.08) * foliageTransmissionGlow * 0.72;',
    ].join('\n');
  }

  /**
   * Runtime helper：默认值 → three uniform 对象（单层路径复用；material-tags 走变体路径不经此）。
   * @param {object} THREE
   * @param {object} [overrides]
   */
  getThreeUniforms(THREE, overrides = {}) {
    const defaults = this.getDefaultUniforms();
    const out = {};
    for (const [param, glsl] of Object.entries(UNIFORM_NAMES)) {
      out[glsl] = { value: overrides[param] ?? defaults[param] };
    }
    return out;
  }

  /** param→GLSL uniform 名映射，供 builder 生成 uniformDefaults 及 runtime 调参复用。 */
  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }

  static get UNIFORM_NAMES() {
    return { ...UNIFORM_NAMES };
  }
}
