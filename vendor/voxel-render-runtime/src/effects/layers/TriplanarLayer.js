/**
 * TriplanarLayer.js — 真实 Effect Layer：程序化手绘感表面纹理（wood/stone base 用）
 *
 * v2 重写（手绘感，非卡渲——禁止色阶量化，一切过渡平滑）：旧版是均匀中频 fbm 铺满全表面，
 * 一眼程序生成。手绘风纹理的公式相反——「大面积平滑宏观色变 + 稀疏结构性特征」，跳过均匀中频：
 *   - macro：极低频 3D fbm 做整面缓慢色偏（无缝，用世界坐标三投影，避免面接缝）。
 *   - wood（pattern=grain）：沿纹方向的噪声扰动正弦木纹（平滑低对比拉丝）+ 板缝暗线 + **每块板
 *     按 index hash 的微色差**（手绘木质感第一来源）。
 *   - stone（pattern=cellular）：voronoi 元胞（胞内基本平坦 + 柔和裂缝线）+ **每块微色差** + macro 斑。
 *   结构性特征用「主轴投影」（按法线最大分量取 2D UV）而非三投影混合——体素模型面轴对齐，主轴投影
 *   天然干净且更省（三投影混合留给会 45° 斜面的 curve 风格也够用，接缝极弱）。colorLo/colorHi 仍是
 *   围绕 1.0 的乘法调制系数（不是绝对颜色），部件原本涂色/光照始终透出，纹理只叠明暗/色偏细节。
 *   wood/stone 复用同一个 layer，靠 `pattern` 枚举 + material-tags-v1.json / 风格预设的 params 区分。
 *
 * stage = 'base'，与 CartoonBase / MatcapBase 互斥（同为 base 层，见 crossSlotIncompatible）。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 */

import { EffectLayer } from '../EffectLayer.js';
import { Triplanar as TRIPLANAR_MANIFEST } from '../coreLayers.manifest.js';

const UNIFORM_NAMES = {
  colorLo: 'uTriplanarColorLo',
  colorHi: 'uTriplanarColorHi',
  scale: 'uTriplanarScale',
  stretch: 'uTriplanarStretch',
  strength: 'uTriplanarStrength',
  // v2 手绘感新增
  pattern: 'uTriplanarPattern',           // 0 = grain(木), 1 = cellular(石)
  grainContrast: 'uTriplanarGrainContrast',// 木纹明暗摆幅
  plankScale: 'uTriplanarPlankScale',     // 木板宽度（世界单位）
  edge: 'uTriplanarEdge',                 // 木板缝暗度 / 石缝裂纹宽度
  cellVariance: 'uTriplanarCellVariance', // 每块板/每胞的微色差幅度
  macroStrength: 'uTriplanarMacroStrength',// 宏观低频色斑强度
  fineNoise: 'uTriplanarFineNoise',       // 细颗粒强度（远低于旧版）
  // v2.2 木纹扩种
  warpAmount: 'uTriplanarWarpAmount',     // grain warp 振幅（原硬编码 1.8）
  warpScale: 'uTriplanarWarpScale',       // grain warp 采样频率系数（原硬编码 0.5，越低越缓）
  knotStrength: 'uTriplanarKnotStrength', // 松木节疤强度，0=无
  stoneNormalStrength: 'uTriplanarStoneNormalStrength',
  barkNormalStrength: 'uTriplanarBarkNormalStrength',
  marbleRoughnessVariation: 'uTriplanarMarbleRoughnessVariation',
  marbleNormalStrength: 'uTriplanarMarbleNormalStrength',
  // v2.3 wool 轮廓打碎（D10：reach/shellWidth/density 拆开独立调，frayAmount 只做总闸+density 倍率）
  frayAmount: 'uTriplanarFrayAmount',     // 0=硬边（默认，其余 pattern 不读）；仅 pattern=6(wool) 用
  frayReach: 'uTriplanarFrayReach',       // discard 渐变可达距离（世界单位，从原始边缘算起）
  frayShellWidth: 'uTriplanarFrayShellWidth', // 顶点外扩物理距离（世界单位）
  frayDensity: 'uTriplanarFrayDensity',   // 贴边处最大丢弃概率
  frayGrainSize: 'uTriplanarFrayGrainSize', // 碎屑颗粒大小（D13：越大越块状，越小越细碎）
};

export class TriplanarLayer extends EffectLayer {
  constructor(manifest = TRIPLANAR_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明 + 噪声/voronoi/投影辅助函数（全局作用域，随声明注入到 fragment 顶部）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uTriplanarColorLo;',
      'uniform vec3 uTriplanarColorHi;',
      'uniform float uTriplanarScale;',
      'uniform float uTriplanarStretch;',
      'uniform float uTriplanarStrength;',
      'uniform float uTriplanarPattern;',
      'uniform float uTriplanarGrainContrast;',
      'uniform float uTriplanarPlankScale;',
      'uniform float uTriplanarEdge;',
      'uniform float uTriplanarCellVariance;',
      'uniform float uTriplanarMacroStrength;',
      'uniform float uTriplanarFineNoise;',
      'uniform float uTriplanarWarpAmount;',
      'uniform float uTriplanarWarpScale;',
      'uniform float uTriplanarKnotStrength;',
      'uniform float uTriplanarStoneNormalStrength;',
      'uniform float uTriplanarBarkNormalStrength;',
      'uniform float uTriplanarMarbleRoughnessVariation;',
      'uniform float uTriplanarMarbleNormalStrength;',
      'uniform float uTriplanarFrayAmount;',
      'uniform float uTriplanarFrayReach;',
      'uniform float uTriplanarFrayShellWidth;',
      'uniform float uTriplanarFrayDensity;',
      'uniform float uTriplanarFrayGrainSize;',
      // 局部包围盒（wool 轮廓打碎用；injector 对每个 mesh 无条件填值，本层只需自己声明 GLSL 变量）。
      'uniform vec3 uEffLayerBoundsMin;',
      'uniform vec3 uEffLayerBoundsSize;',
      '',
      'float triplanarHash(vec2 p) {',
      '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
      '  p3 += dot(p3, p3.yzx + 33.33);',
      '  return fract((p3.x + p3.y) * p3.z);',
      '}',
      'float triplanarValueNoise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  float a = triplanarHash(i);',
      '  float b = triplanarHash(i + vec2(1.0, 0.0));',
      '  float c = triplanarHash(i + vec2(0.0, 1.0));',
      '  float d = triplanarHash(i + vec2(1.0, 1.0));',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
      '}',
      'float triplanarFbm(vec2 p) {',
      '  float sum = 0.0;',
      '  float amp = 0.5;',
      '  for (int i = 0; i < 3; i++) {',
      '    sum += triplanarValueNoise(p) * amp;',
      '    p *= 2.02;',
      '    amp *= 0.5;',
      '  }',
      '  return sum;',
      '}',
      '// 极低频宏观色变：世界空间三投影混合（无缝），返回环绕 0.5 的值。',
      'float triplanarMacro(vec3 worldPos, vec3 worldNormal, float scale) {',
      '  vec3 n = abs(normalize(worldNormal));',
      '  n = pow(n, vec3(4.0));',
      '  n /= (n.x + n.y + n.z + 1e-5);',
      '  float xP = triplanarFbm(worldPos.zy * scale);',
      '  float yP = triplanarFbm(worldPos.xz * scale);',
      '  float zP = triplanarFbm(worldPos.xy * scale);',
      '  return xP * n.x + yP * n.y + zP * n.z;',
      '}',
      '// 主轴投影：按法线最大分量取一张 2D UV（体素面轴对齐→天然无接缝、比三投影省）。',
      'vec2 triplanarDominantUv(vec3 worldPos, vec3 worldNormal) {',
      '  vec3 an = abs(normalize(worldNormal));',
      '  if (an.x >= an.y && an.x >= an.z) return worldPos.zy;',
      '  if (an.y >= an.z) return worldPos.xz;',
      '  return worldPos.xy;',
      '}',
      'vec3 triplanarMarbleData(vec3 worldPos, vec3 worldNormal, float scale, float edge) {',
      '  vec2 uv = triplanarDominantUv(worldPos, worldNormal);',
      '  vec2 uv1 = uv * vec2(scale * 0.35, scale * 1.8);',
      '  float warp1 = triplanarFbm(uv1 * 0.4) * 2.0 - 1.0;',
      '  float field1 = triplanarFbm(vec2(uv1.x + warp1 * 2.2, uv1.y));',
      '  vec2 uv2 = uv * vec2(scale * 1.8, scale * 0.35);',
      '  float warp2 = triplanarFbm(uv2 * 0.37) * 2.0 - 1.0;',
      '  float field2 = triplanarFbm(vec2(uv2.x, uv2.y + warp2 * 2.2));',
      '  float lineW = 0.04 + edge * 0.12;',
      '  float line1 = 1.0 - smoothstep(0.0, lineW, abs(field1 - 0.5));',
      '  float line2 = 1.0 - smoothstep(0.0, lineW * 0.85, abs(field2 - 0.55));',
      '  return vec3(field1, field2, clamp(line1 + line2 * 0.7, 0.0, 1.0));',
      '}',
      '// Voronoi F1 + 命中胞 id（石纹用）。',
      'void triplanarVoronoi(vec2 p, out float f1, out vec2 cellId) {',
      '  vec2 ip = floor(p);',
      '  vec2 fp = fract(p);',
      '  f1 = 8.0;',
      '  cellId = ip;',
      '  for (int y = -1; y <= 1; y++) {',
      '    for (int x = -1; x <= 1; x++) {',
      '      vec2 g = vec2(float(x), float(y));',
      '      vec2 o = vec2(triplanarHash(ip + g), triplanarHash(ip + g + 17.13));',
      '      vec2 r = g + o - fp;',
      '      float d = dot(r, r);',
      '      if (d < f1) { f1 = d; cellId = ip + g; }',
      '    }',
      '  }',
      '  f1 = sqrt(f1);',
      '}',
      '// 石材微法线用的 Voronoi 表面数据：F1 控制胞心圆拱，F2-F1 近似真实胞边距离。',
      'void triplanarVoronoiSurface(vec2 p, out float nearestDistance, out float edgeDistance, out vec2 cellId) {',
      '  vec2 ip = floor(p);',
      '  vec2 fp = fract(p);',
      '  float nearestSq = 64.0;',
      '  float secondSq = 64.0;',
      '  cellId = ip;',
      '  for (int y = -1; y <= 1; y++) {',
      '    for (int x = -1; x <= 1; x++) {',
      '      vec2 g = vec2(float(x), float(y));',
      '      vec2 o = vec2(triplanarHash(ip + g), triplanarHash(ip + g + 17.13));',
      '      float d = dot(g + o - fp, g + o - fp);',
      '      if (d < nearestSq) {',
      '        secondSq = nearestSq;',
      '        nearestSq = d;',
      '        cellId = ip + g;',
      '      } else if (d < secondSq) {',
      '        secondSq = d;',
      '      }',
      '    }',
      '  }',
      '  nearestDistance = sqrt(nearestSq);',
      '  float secondDistance = sqrt(secondSq);',
      '  edgeDistance = max((secondDistance - nearestDistance) * 0.5, 0.0);',
      '}',
    ].join('\n');
  }

  /**
   * 顶点 body：wool 轮廓外扩（frayAmount>0.001 才位移，显式 if gate——直接用 frayShellWidth 数值，
   * 0 就是真 0，wood/stone 等 frayAmount 默认 0 的 pattern 天然零位移，不依赖任何公式巧合）。
   *
   * 为什么"往外长一圈"能同时解决"腿这类细部件被吃穿"和"两个部件拼接处露缝"（人工视觉验收发现
   * 的真实 bug，frayAmount 的边缘检测本身已经改成世界单位——见 getFragmentBody 头注——但那只是让
   * 缝变窄，没有根治，因为本层看不到邻居部件）：往外扩之后，两个互相贴合的部件会各自朝对方的地盘
   * "长"进去一点，谁的 fray 随机丢了像素，背后垫着的是邻居扩出来的实体表面，缝隙被物理堵住，不需要
   * 知道邻居在哪。副作用是顺带解决了最初"能不能做圆润长毛"的诉求——外扩本身就是最低成本的一层"体积"，
   * 也是以后如果要做多层 shell fur 的第一层壳，路径是延续的，不是弃件。
   *
   * 关键实现细节（查过资料，行业标准做法）：外扩方向必须用"顶点位置相对局部包围盒中心的方向"
   * （position-based），不能用"顶点法线"（normal-based）。原因：THREE.BoxGeometry 每个面有自己独立
   * 的顶点（24 个顶点、法线不共享，即使位置重合），沿法线外扩会让共享同一物理位置、但属于不同面的
   * 顶点各自被推向不同方向，硬边棱角处直接被撕开一条缝——这是 inverted-hull 描边技术的经典已知坑
   * （行业标准修法是用平滑法线，但本层素材是体素 box/sphere 一类凸几何，直接用"相对中心的位置方向"
   * 更简单也天然无缝：同一物理位置的顶点，不管属于哪个面，位置都相同，位移量也相同，缝一定对齐）。
   *
   * D10 真机验收发现：frayShellWidth（壳厚度）曾经和 getFragmentBody 的丢弃渐变距离共用同一个数值
   * ——壳刚长出来的根部（局部坐标离原始边缘只有 shellWidth 那么远）永远达不到渐变的"安全距离"，
   * 于是整条壳从尖到根全程都在高丢弃概率区，视觉上壳看起来永远是镂空的、从不实心。现在两者彻底
   * 拆开成独立参数（frayReach vs frayShellWidth），且默认 frayReach 明显大于 frayShellWidth，壳的
   * 根部才能落进渐变过半、趋向实心的区间，从尖端的碎发过渡到根部的实体。
   *
   * fray 检测（getFragmentBody）读的 vEffLayerLocalPos/vEffLayerWorldPos 由 injector 在本 body 执行
   * 前捕获（Foliage 的风摆同理），本层的外扩位移不会改变这两个 varying 的取值，所以花纹/毛边判定
   * 完全不受外扩影响——只是渲染出来的物理形状变大了，毛边的渐变宽度也随之等比例变宽（同一套局部坐标
   * 摊在更大的三角形上）。
   */
  getVertexBody() {
    return [
      'if (uTriplanarFrayAmount > 0.001) {',
      '  vec3 furShellCenter = uEffLayerBoundsMin + uEffLayerBoundsSize * 0.5;',
      '  vec3 furShellOutSign = sign(transformed - furShellCenter);',
      '  // D11：壳厚度同样按部件最小半宽钳制（≤ 半宽的一半），否则 0.05 的默认壳厚会把 0.15 宽的腿',
      '  // 撑胖 2/3，小部件比例失真。',
      '  float furShellMinHalf = min(min(uEffLayerBoundsSize.x, uEffLayerBoundsSize.y), uEffLayerBoundsSize.z) * 0.5;',
      '  float furShellW = min(uTriplanarFrayShellWidth, furShellMinHalf * 0.5);',
      '  transformed += furShellOutSign * furShellW;',
      '}',
    ].join('\n');
  }

  /**
   * 片元 body：按 pattern 分木/石/砖/大理石/鹅卵石，用主轴投影做结构性特征（拉丝/板缝/元胞/
   * 网格/脉络），叠 macro 低频色斑与微色差，全部**平滑过渡**（无色阶量化）。结果按乘法调制
   * 已有光照色，strength 控制整体强度。
   *
   * 立体感（v2.1 追加）：wood/stone 在压暗缝线/裂缝的基础上，紧贴缝线内侧再叠一条更窄的亮带
   * （复用同一个 plankFrac/f1 值，宽度由已有的 edge 派生），做出"斜切倒角"的漫画式凸起错觉。
   * 零新增 uniform、不碰法线/光照，成本是每 fragment 多几条 smoothstep，与场景内物体数量无关。
   */
  getNormalBody() {
    return [
      'vec3 triMarbleData = vec3(0.0);',
      'vec3 stoneWorldNormal = normalize(vEffLayerWorldNormal);',
      '#ifdef DOUBLE_SIDED',
      'stoneWorldNormal *= faceDirection;',
      '#endif',
      'vec2 stoneUv = triplanarDominantUv(vEffLayerWorldPos, stoneWorldNormal);',
      'float stoneRelief = 0.0;',
      'float stoneNormalStrength = 0.0;',
      'if (uTriplanarPattern > 0.5 && uTriplanarPattern < 1.5) {',
      '  float rubbleF1; float rubbleEdgeDistance; vec2 rubbleCellId;',
      '  triplanarVoronoiSurface(stoneUv * uTriplanarScale, rubbleF1, rubbleEdgeDistance, rubbleCellId);',
      '  float rubbleCrack = smoothstep(0.0, max(uTriplanarEdge * 0.45, 0.015), rubbleEdgeDistance);',
      '  float rubbleFaceNoise = triplanarFbm(stoneUv * uTriplanarScale * 2.4 + rubbleCellId * 0.13);',
      '  stoneRelief = rubbleCrack * (0.82 + rubbleFaceNoise * 0.18);',
      '  stoneNormalStrength = uTriplanarStoneNormalStrength;',
      '} else if (uTriplanarPattern > 1.5 && uTriplanarPattern < 2.5) {',
      '  float brickH = max(uTriplanarPlankScale, 0.01);',
      '  float brickRowF = stoneUv.y / brickH;',
      '  float brickRowId = floor(brickRowF);',
      '  float brickRowFrac = fract(brickRowF);',
      '  float brickColF = stoneUv.x / (brickH * 2.0) + mod(brickRowId, 2.0) * 0.5;',
      '  float brickColFrac = fract(brickColF);',
      '  float brickMortarH = smoothstep(0.0, uTriplanarEdge, brickRowFrac) * smoothstep(0.0, uTriplanarEdge, 1.0 - brickRowFrac);',
      '  float brickMortarV = smoothstep(0.0, uTriplanarEdge, brickColFrac) * smoothstep(0.0, uTriplanarEdge, 1.0 - brickColFrac);',
      '  float brickMortar = brickMortarH * brickMortarV;',
      '  float brickFaceNoise = triplanarFbm(stoneUv * uTriplanarScale * 1.6);',
      '  stoneRelief = brickMortar * (0.9 + brickFaceNoise * 0.1);',
      '  stoneNormalStrength = uTriplanarStoneNormalStrength;',
      '} else if (uTriplanarPattern > 2.5 && uTriplanarPattern < 3.5) {',
      '  triMarbleData = triplanarMarbleData(vEffLayerWorldPos, stoneWorldNormal, uTriplanarScale, uTriplanarEdge);',
      '  float marbleMicro = triplanarFbm(stoneUv * uTriplanarScale * 3.2 + triMarbleData.xy * 2.0);',
      '  stoneRelief = marbleMicro * 0.65 + triMarbleData.z * 0.35;',
      '  roughnessFactor = clamp(roughnessFactor + ((marbleMicro - 0.44) + triMarbleData.z * 0.43) * uTriplanarMarbleRoughnessVariation, 0.20, 0.58);',
      '  stoneNormalStrength = uTriplanarMarbleNormalStrength;',
      '} else if (uTriplanarPattern > 3.5 && uTriplanarPattern < 4.5) {',
      '  float cobbleF1; float cobbleEdgeDistance; vec2 cobbleCellId;',
      '  triplanarVoronoiSurface(stoneUv * uTriplanarScale * 0.45, cobbleF1, cobbleEdgeDistance, cobbleCellId);',
      '  float cobbleJoint = smoothstep(0.0, max(uTriplanarEdge * 0.55, 0.02), cobbleEdgeDistance);',
      '  float cobbleDome = pow(clamp(1.0 - cobbleF1 * 1.6, 0.0, 1.0), 0.75);',
      '  stoneRelief = cobbleDome * cobbleJoint;',
      '  stoneNormalStrength = uTriplanarStoneNormalStrength;',
      '} else if (uTriplanarPattern > 4.5 && uTriplanarPattern < 5.5) {',
      '  float barkWarp = triplanarFbm(vec2(stoneUv.y * uTriplanarWarpScale, 0.0)) * 2.0 - 1.0;',
      '  float barkX = stoneUv.x * uTriplanarScale + barkWarp * uTriplanarWarpAmount;',
      '  float barkCell = floor(barkX);',
      '  float barkLocal = fract(barkX);',
      '  float barkNearest = 8.0;',
      '  for (int i = -1; i <= 1; i++) {',
      '    float barkOffset = triplanarHash(vec2(barkCell + float(i), 5.9));',
      '    barkNearest = min(barkNearest, abs(float(i) + barkOffset - barkLocal));',
      '  }',
      '  float barkGroove = smoothstep(0.0, max(uTriplanarEdge, 0.02), barkNearest);',
      '  float barkFiber = triplanarFbm(vec2(barkX * 0.35, stoneUv.y * uTriplanarScale * 0.32));',
      '  stoneRelief = barkGroove * (0.88 + barkFiber * 0.12);',
      '  stoneNormalStrength = uTriplanarBarkNormalStrength;',
      '}',
      'if (stoneNormalStrength > 0.0001) {',
      '  vec3 stoneDpdx = dFdx(vEffLayerWorldPos);',
      '  vec3 stoneDpdy = dFdy(vEffLayerWorldPos);',
      '  float stoneDhdx = dFdx(stoneRelief);',
      '  float stoneDhdy = dFdy(stoneRelief);',
      '  vec3 stoneR1 = cross(stoneDpdy, stoneWorldNormal);',
      '  vec3 stoneR2 = cross(stoneWorldNormal, stoneDpdx);',
      '  float stoneDet = dot(stoneDpdx, stoneR1);',
      '  vec3 stoneGradient = sign(stoneDet) * (stoneDhdx * stoneR1 + stoneDhdy * stoneR2);',
      '  vec3 stoneBumpedNormal = normalize(abs(stoneDet) * stoneWorldNormal - stoneGradient * stoneNormalStrength);',
      '  normal = normalize(mat3(viewMatrix) * stoneBumpedNormal);',
      '}',
    ].join('\n');
  }

  getFragmentBody() {
    return [
      'vec3 triWp = vEffLayerWorldPos;',
      'vec3 triWn = normalize(vEffLayerWorldNormal);',
      'vec2 triUv = triplanarDominantUv(triWp, triWn);',
      '',
      '// 宏观低频色斑（材质共用）：整面缓慢明暗起伏，打破重复。',
      'float triMacro = triplanarMacro(triWp, triWn, uTriplanarScale * 0.11);',
      'float triMacroShade = mix(1.0 - uTriplanarMacroStrength, 1.0 + uTriplanarMacroStrength, triMacro);',
      '',
      '// 细颗粒（低强度，避免均匀中频感——旧版病灶）。',
      'float triFine = triplanarValueNoise(triUv * uTriplanarScale * 6.0);',
      'float triFineShade = mix(1.0 - uTriplanarFineNoise, 1.0 + uTriplanarFineNoise, triFine);',
      '',
      'vec3 triTint;',
      'if (uTriplanarPattern < 0.5) {',
      '  // ===== WOOD：噪声扰动正弦木纹 + 板缝 + 每板微色差/频率抖动 =====',
      '  vec2 gUv = triUv * vec2(uTriplanarScale * uTriplanarStretch, uTriplanarScale);',
      '  // 板缝：沿纹方向的长条木板，按 triUv.y 切分；接缝处平滑压暗。先算 plankId 供频率抖动用。',
      '  float plankF = triUv.y / max(uTriplanarPlankScale, 0.01);',
      '  float plankId = floor(plankF);',
      '  float plankFrac = fract(plankF);',
      '  // 每块板独立的木纹节奏：频率/振幅按 plankId hash 轻微扰动，相邻板不再是同一节奏的复制。',
      '  float grainFreqJit = mix(0.8, 1.2, triplanarHash(vec2(plankId, 11.3)));',
      '  // warpScale 越低，扭曲场采样越低频→纹路缓慢蜿蜒/合并；warpAmount 越大，偏移振幅越大。',
      '  // default/birch 用 manifest 默认值（1.8/0.5）= 旧硬编码值，观感不变；扩种 variant 用 warpScale',
      '  // 降 + warpAmount 升的组合，避免陷入“只加振幅→高频抖动”的假扭曲。',
      '  float warp = triplanarFbm(gUv * uTriplanarWarpScale * grainFreqJit) * 2.0 - 1.0;',
      '  float grainPhase = gUv.x * 3.14159 * grainFreqJit + warp * uTriplanarWarpAmount;',
      '  // 松木节疤（knotStrength=0 时不采样，零成本）：未拉伸的 triUv 空间做 voronoi，避免被 stretch',
      '  // 拉成椭圆；稀疏门控（~22% 的 cell 才有疤）；疤附近把 grain 相位换成径向 f1，做出年轮绕疤的错觉。',
      '  float knotMask = 0.0;',
      '  float knotDarken = 0.0;',
      '  if (uTriplanarKnotStrength > 0.001) {',
      '    vec2 knotUv = triUv * uTriplanarScale * 0.4;',
      '    float f1k; vec2 cellIdK;',
      '    triplanarVoronoi(knotUv, f1k, cellIdK);',
      '    float hasKnot = step(0.78, triplanarHash(cellIdK + 41.7));',
      '    knotMask = smoothstep(0.5, 0.0, f1k) * hasKnot;',
      '    float knotPhase = f1k * 18.0;',
      '    grainPhase = mix(grainPhase, knotPhase, knotMask * uTriplanarKnotStrength);',
      '    knotDarken = knotMask * uTriplanarKnotStrength * 0.35;',
      '  }',
      '  float grain = sin(grainPhase) * 0.5 + 0.5;   // 0..1 平滑',
      '  float grainShade = mix(1.0 - uTriplanarGrainContrast, 1.0 + uTriplanarGrainContrast, grain);',
      '  float seam = smoothstep(0.0, uTriplanarEdge, plankFrac) * smoothstep(0.0, uTriplanarEdge, 1.0 - plankFrac);',
      '  // 立体感：缝线内侧一条窄亮带（复用 plankFrac，宽度由 edge 派生）。',
      '  float bevelW = uTriplanarEdge * 0.5;',
      '  float bevelLo = smoothstep(uTriplanarEdge, uTriplanarEdge + bevelW, plankFrac) - smoothstep(uTriplanarEdge + bevelW, uTriplanarEdge + bevelW * 2.0, plankFrac);',
      '  float bevelHi = smoothstep(uTriplanarEdge, uTriplanarEdge + bevelW, 1.0 - plankFrac) - smoothstep(uTriplanarEdge + bevelW, uTriplanarEdge + bevelW * 2.0, 1.0 - plankFrac);',
      '  float bevel = clamp(bevelLo + bevelHi, 0.0, 1.0);',
      '  // 每块板微色差：按 plankId hash 出 ±cellVariance 的明度/色偏。',
      '  float plankJit = (triplanarHash(vec2(plankId, 3.7)) - 0.5) * 2.0 * uTriplanarCellVariance;',
      '  triTint = mix(uTriplanarColorLo, uTriplanarColorHi, grain);',
      '  triTint *= (1.0 + plankJit);',
      '  triTint *= mix(1.0 - uTriplanarEdge, 1.0, seam);   // 缝线压暗',
      '  triTint *= (1.0 + bevel * uTriplanarEdge * 0.4);   // 缝线旁亮边',
      '  triTint *= grainShade;',
      '  triTint *= (1.0 - knotDarken);   // 节疤中心压暗',
      '} else if (uTriplanarPattern < 1.5) {',
      '  // ===== STONE：voronoi 元胞（碎石）+ 每胞微色差 + 柔和裂缝 =====',
      '  vec2 sUv = triUv * uTriplanarScale;',
      '  float f1; vec2 cellId;',
      '  triplanarVoronoi(sUv, f1, cellId);',
      '  float edgeW = max(uTriplanarEdge, 0.02);',
      '  float crack = smoothstep(0.0, edgeW, f1);   // 胞边→0 压暗，胞内→1',
      '  // 立体感：裂缝外侧一条窄亮带（复用 f1，宽度由 edge 派生）。',
      '  float bevelW2 = edgeW * 0.6;',
      '  float bevel2 = clamp(smoothstep(edgeW, edgeW + bevelW2, f1) - smoothstep(edgeW + bevelW2, edgeW + bevelW2 * 2.0, f1), 0.0, 1.0);',
      '  float cellJit = (triplanarHash(cellId + 5.3) - 0.5) * 2.0 * uTriplanarCellVariance;',
      '  float cellTone = triplanarHash(cellId + 9.1);',
      '  triTint = mix(uTriplanarColorLo, uTriplanarColorHi, mix(0.35, 0.75, cellTone));',
      '  triTint *= (1.0 + cellJit);',
      '  triTint *= mix(1.0 - uTriplanarEdge, 1.0, crack);   // 裂缝压暗',
      '  triTint *= (1.0 + bevel2 * uTriplanarEdge * 0.4);   // 裂缝旁亮边',
      '} else if (uTriplanarPattern < 2.5) {',
      '  // ===== BRICK：规则网格 + 隔行错缝 + 逐砖微色差 =====',
      '  float brickH = max(uTriplanarPlankScale, 0.01);',
      '  float brickW = brickH * 2.0;   // 砖宽 = 2x 砖高，常见砌砖比例',
      '  float rowF = triUv.y / brickH;',
      '  float rowId = floor(rowF);',
      '  float rowFrac = fract(rowF);',
      '  float rowOffset = mod(rowId, 2.0) * 0.5;   // 隔行错缝半砖',
      '  float colF = triUv.x / brickW + rowOffset;',
      '  float colId = floor(colF);',
      '  float colFrac = fract(colF);',
      '  float mortarH = smoothstep(0.0, uTriplanarEdge, rowFrac) * smoothstep(0.0, uTriplanarEdge, 1.0 - rowFrac);',
      '  float mortarV = smoothstep(0.0, uTriplanarEdge, colFrac) * smoothstep(0.0, uTriplanarEdge, 1.0 - colFrac);',
      '  float mortar = mortarH * mortarV;',
      '  vec2 brickId = vec2(colId, rowId);',
      '  float brickJit = (triplanarHash(brickId + 3.7) - 0.5) * 2.0 * uTriplanarCellVariance;',
      '  float brickTone = triplanarHash(brickId + 9.1);',
      '  triTint = mix(uTriplanarColorLo, uTriplanarColorHi, mix(0.35, 0.75, brickTone));',
      '  triTint *= (1.0 + brickJit);',
      '  triTint *= mix(1.0 - uTriplanarEdge, 1.0, mortar);   // 灰缝压暗',
      '} else if (uTriplanarPattern < 3.5) {',
      '  // ===== MARBLE：均匀浅色底 + 两组交叉细脉络线（不是整面色块渐变） =====',
      '  triTint = mix(uTriplanarColorHi, uTriplanarColorLo, triMarbleData.z);   // 颜色与微表面共用同一脉络',
      '} else if (uTriplanarPattern < 4.5) {',
      '  // ===== COBBLESTONE：放大版 voronoi + 更圆润的裂缝 + 更强 macro 色差 =====',
      '  vec2 cUv = triUv * uTriplanarScale * 0.45;   // cell 比碎石更大',
      '  float f1c; vec2 cellIdC;',
      '  triplanarVoronoi(cUv, f1c, cellIdC);',
      '  float crackC = smoothstep(0.0, max(uTriplanarEdge * 1.6, 0.03), f1c);   // 更宽裂缝→更圆润',
      '  float cellJitC = (triplanarHash(cellIdC + 5.3) - 0.5) * 2.0 * uTriplanarCellVariance * 1.4;',
      '  float cellToneC = triplanarHash(cellIdC + 9.1);',
      '  triTint = mix(uTriplanarColorLo, uTriplanarColorHi, mix(0.3, 0.85, cellToneC));',
      '  triTint *= (1.0 + cellJitC);',
      '  triTint *= mix(1.0 - uTriplanarEdge, 1.0, crackC);   // 裂缝压暗',
      '} else if (uTriplanarPattern < 5.5) {',
      '  // ===== BARK：一维 voronoi 纵向沟壑（天然不等距，比二维 voronoi 便宜）+ 低频蜿蜒 =====',
      '  // ponytail: triplanarDominantUv 顶面（法线朝 Y）返回 worldPos.xz，没有世界 Y——树桩截面',
      '  // 本该是年轮，这里会显示成平行沟纹。顶面通常很小，先接受；要修得给顶面单独走三投影混合。',
      '  float barkWarp = triplanarFbm(vec2(triUv.y * uTriplanarWarpScale, 0.0)) * 2.0 - 1.0;',
      '  float bx = triUv.x * uTriplanarScale + barkWarp * uTriplanarWarpAmount;',
      '  float bCell = floor(bx);',
      '  float bLocal = fract(bx);',
      '  float bF1 = 8.0;',
      '  float bGrooveId = bCell;',
      '  for (int i = -1; i <= 1; i++) {',
      '    float g = float(i);',
      '    float o = triplanarHash(vec2(bCell + g, 5.9));',
      '    float d = abs(g + o - bLocal);',
      '    if (d < bF1) { bF1 = d; bGrooveId = bCell + g; }',
      '  }',
      '  float edgeWB = max(uTriplanarEdge, 0.02);',
      '  float groove = smoothstep(0.0, edgeWB, bF1);   // 沟底→0 压暗，脊背→1',
      '  float bevelWB = edgeWB * 0.6;',
      '  float bevelB = clamp(smoothstep(edgeWB, edgeWB + bevelWB, bF1) - smoothstep(edgeWB + bevelWB, edgeWB + bevelWB * 2.0, bF1), 0.0, 1.0);',
      '  float grooveJit = (triplanarHash(vec2(bGrooveId, 7.1)) - 0.5) * 2.0 * uTriplanarCellVariance;',
      '  float grooveTone = triplanarHash(vec2(bGrooveId, 2.3));',
      '  triTint = mix(uTriplanarColorLo, uTriplanarColorHi, mix(0.3, 0.7, grooveTone));',
      '  triTint *= (1.0 + grooveJit);',
      '  triTint *= mix(1.0 - uTriplanarEdge, 1.0, groove);   // 沟底压暗',
      '  triTint *= (1.0 + bevelB * uTriplanarEdge * 0.4);   // 脊背旁亮边',
      '} else {',
      '  // ===== WOOL：warp 场等高线抠"卷曲纱线"（v2 重写，voronoi 版是密集胞状凸起——像石头/密集',
      '  // 恐惧，已废弃）。MC 羊毛的软来自两点：拓扑上没有胞/边界，只有连续卷曲的纱线迷宫；数值上',
      '  // 明暗摆幅很窄。做法与 MARBLE 同源（从平滑噪声场里抠等值线）——区别是 MARBLE 抠单一阈值',
      '  // 出一条脉络，这里对 warp 后的场取 fract 重复抠值，天然产出多条彼此平行卷绕的纱线，且靠',
      '  // domain warp 而非 voronoi 打破直线感，不会出现 stone/plush-v1 那种离散胞的硬边界。',
      '  //',
      '  // 轮廓打碎（frayAmount>0 才生效，默认 0——wood/stone 等其它 pattern 从不读这段，零成本零',
      '  // 行为变化）：纯色彩花纹永远读不出"体积毛"，因为方块面是平的，同一面法线处处相同，视觉',
      '  // 上第一眼还是"刷了层色的硬边方块"。真正让人读出"毛"的线索是轮廓不整齐——用局部包围盒',
      '  // 归一化坐标找出"贴着物理边"的片元（排除与法线对齐的那根轴，那根轴恒为 0，不算边），越',
      '  // 靠边越大概率被噪声丢弃，方块棱边因此长出参差的毛边而不是一条直线。',
      '  // 已知限制：假设局部坐标轴与世界坐标轴对齐（无额外旋转的体素部件成立；旋转部件退化为近似，',
      '  // 与本层其它世界空间投影同一容忍度）；阴影/深度 pass 不打本补丁，影子仍是硬边方块（与',
      '  // FoliageLayer 镂空同一已知限制，人工验收已接受）。',
      '  //',
      '  // 毛边宽度必须按世界空间物理长度算，不能按"部件自身尺寸的百分比"算（v1 的真 bug，人工',
      '  // 视觉验收发现）：按百分比算时，小部件（腿/耳朵这类细长部位）自身很窄，20% 内缩的毛边带',
      '  // 几乎吃掉整个面，导致小部件大片消失；两个相邻部件在拼接面上各按自己的百分比打碎，物理',
      '  // 宽度完全不一样，缝隙对不齐，直接透光穿帮。改成绝对世界单位后，不同大小的部件毛边宽度',
      '  // 一致，缝隙处两侧的打碎图案更容易对上（frayNoise 采样点 triUv 本身就是世界坐标，天然跨',
      '  // 部件连续）；顶点 body（getVertexBody）额外把壳往外扩，两个贴合部件互相长进对方地盘，',
      '  // 缝隙被物理堵住。仍是已知限制而非根治：两个部件严丝合缝贴合的整张接触面（而非仅边缘）',
      '  // 无法与"真正暴露在外的轮廓"完全区分，因为本层只有单个部件自身的局部坐标，看不到邻居部件。',
      '  //',
      '  // D10 真机验收发现的第二个 bug：frayReach（渐变可达距离）曾经和 getVertexBody 的壳厚度共用',
      '  // 同一个数值——壳的根部（局部坐标离原始边缘只有壳厚度那么远）因此永远达不到"安全距离"，壳',
      '  // 从尖到根全程都在高丢弃概率区，视觉上壳看起来永远是镂空的。现在 frayReach 与壳厚度',
      '  // （frayShellWidth，见 getVertexBody）彻底独立成两个参数，且默认 frayReach 明显大于',
      '  // frayShellWidth，保证壳根部能落进渐变过半、趋向实心的区间。',
      '  //',
      '  // D11（真机猫模型验收发现的第三个 bug）：frayReach 是绝对世界长度，但真实生成模型的部件很多',
      '  // 只有 0.1~0.3 世界单位——对它们来说整张面都落在"离边缘 frayReach 以内"，面中心也带着丢弃',
      '  // 概率，整脸散斑（此前用 1.2 大小的方块验证恰好在"中心安全"的尺寸区间，掩盖了问题）。任何',
      '  // 固定的绝对长度都不可能同时适配所有部件尺寸，必须按部件自身半宽逐轴钳制：每根轴的有效渐变',
      '  // 距离 = min(frayReach, 该轴半宽 × 0.5)，保证毛边带最多吃到每侧 1/4 宽度，面中央一半必然实心。',
      '  // 钳制用的 uEffLayerBoundsSize 与距离测量同一坐标空间（standalone=真实尺寸、合批=单位几何），',
      '  // 两种路径下比例都自洽。逐轴（而非取全局最小半宽）是为了细长部件：腿的横轴很窄、纵轴很长，',
      '  // 全局钳制会把纵向毛边也压没，逐轴钳制横向收紧、纵向保持。',
      '  //',
      '  // D12（真机熊模型验收发现——之前三个 bug 修完后仍有"糖霜"）：discard 打的洞是直通背景的窗，',
      '  // 而且单面渲染（FrontSide）时背面完全不挡光，洞后面直接是天空/地面，看起来像白色霜点而不是',
      '  // 毛发。真实毛发边缘的空隙背后是更深处、更暗的毛，不是虚空——这是"像毛"和"像蛀洞"的分水岭。',
      '  // 两处根治：(a) discard 概率按视角与法线夹角加权——正对相机的面（俯视时的顶面）几乎不丢，',
      '  // 因为那里打洞只有破坏没有轮廓收益；真正构成轮廓的掠射面才丢，露背景在那里本来就是对的。',
      '  // (b) 材质本身另外开启 DoubleSide（见 EffectLayerInjector 对 pattern=6+frayAmount>0 的特判）',
      '  // 配合本层片尾的 gl_FrontFacing 压暗，洞里露出的是压暗的背面几何（邻面内壁），读作"毛发深处"',
      '  // 而不是"捅穿的窟窿"。',
      '  if (uTriplanarFrayAmount > 0.001) {',
      '    vec3 furLocal01 = (vEffLayerLocalPos - uEffLayerBoundsMin) / max(uEffLayerBoundsSize, vec3(0.0001));',
      '    vec3 furAxisW = abs(triWn); furAxisW = pow(furAxisW, vec3(4.0)); furAxisW /= (furAxisW.x + furAxisW.y + furAxisW.z + 1e-5);',
      '    vec3 furBorderDist01 = min(furLocal01, vec3(1.0) - furLocal01);',
      '    vec3 furBorderDistWorld = furBorderDist01 * uEffLayerBoundsSize;   // 折算成世界单位，与部件大小无关',
      '    vec3 furMaskedBorder = mix(furBorderDistWorld, vec3(1000.0), furAxisW);   // 掩掉与法线对齐的轴',
      '    // 每轴毛边带 ≤ 该轴全宽的 12%（两侧合计 24%，中央 76% 必然实心）。曾用 25%——两侧合计',
      '    // 吃掉半张面，加上低频噪声整块崩缺，视觉是"被啃"而不是"绒毛"。',
      '    vec3 furReachAxis = clamp(vec3(uTriplanarFrayReach), vec3(0.001), uEffLayerBoundsSize * 0.12);',
      '    vec3 furZone3 = vec3(1.0) - smoothstep(vec3(0.0), furReachAxis, furMaskedBorder);',
      '    float furEdgeZone = max(max(furZone3.x, furZone3.y), furZone3.z);   // 1=贴边 0=面中心',
      '    // 视角门控：面法线越接近正对相机（掠射角越小）越不该打洞——那是"正视被打穿"的病灶',
      '    // （截图里熊头顶那圈糖霜正是俯视时顶面被打穿）。轮廓处（掠射角大）不受影响，该丢照丢。',
      '    vec3 furViewDir = normalize(cameraPosition - triWp);',
      '    float furGrazing = 1.0 - abs(dot(triWn, furViewDir));   // 0=正对相机 1=掠射（轮廓）',
      '    // discard 只发生在独立毛壳，下面有永远实心的 core；旧单层路径需要低门控防穿洞，现在可保留 0.8 下限，',
      '    // 让正对相机的方块轮廓也有足够稀疏度形成可读毛丝，而不会伤到实体本体。',
      '    float furViewGate = mix(0.8, 1.0, pow(clamp(furGrazing, 0.0, 1.0), 2.0));',
      '    float furFaceSeed = dot(sign(triWn), vec3(13.1, 7.7, 19.3));',
      '    // 每条窄带沿边缘方向得到一个稳定的随机长度，形成细梳齿/毛丝；旧 2D value noise 会形成',
      '    // 与整条毛边同宽的团块，阈值后就是连续崩口，看起来像撕碎。',
      '    float furGrainFreq = 16.0 / max(uTriplanarFrayGrainSize, 0.05);',
      '    float furFiberAlong = furZone3.x >= max(furZone3.y, furZone3.z)',
      '      ? vEffLayerLocalPos.y + vEffLayerLocalPos.z * 0.37',
      '      : (furZone3.y >= furZone3.z',
      '        ? vEffLayerLocalPos.x + vEffLayerLocalPos.z * 0.37',
      '        : vEffLayerLocalPos.x + vEffLayerLocalPos.y * 0.37);',
      '    float furFiberCell = floor(furFiberAlong * uTriplanarScale * furGrainFreq);',
      '    float furFiberLength = triplanarHash(vec2(furFiberCell + furFaceSeed, furFaceSeed + 17.3));',
      '    // 少量二维微扰只负责打散梳齿规律，不再决定整块缺口。',
      '    float furFiberJitter = triplanarValueNoise(triUv * uTriplanarScale * furGrainFreq * 0.25 + 31.7 + furFaceSeed);',
      '    float furFrayNoise = mix(furFiberLength, furFiberJitter, 0.18);',
      '    // zone² 让缺口只集中在毛壳尖端；实心 core 永不执行本段。',
      '    float furDiscardChance = furEdgeZone * furEdgeZone * uTriplanarFrayDensity * uTriplanarFrayAmount * furViewGate;',
      '    if (furEdgeZone > 0.001 && furFrayNoise < furDiscardChance) discard;',
      '  }',
      '',
      '  vec2 wUv = triUv * uTriplanarScale * 0.6;',
      '  float wWarp = triplanarFbm(wUv * uTriplanarWarpScale) * 2.0 - 1.0;',
      '  vec2 wWarped = wUv + wWarp * uTriplanarWarpAmount * 0.3;',
      '  float wField = triplanarFbm(wWarped);',
      '  float wContour = fract(wField * 5.0);   // 重复抠值→多条卷线，而非单条脉络',
      '  float wLineW = 0.10 + uTriplanarEdge * 0.15;   // edge：线宽=蓬松扩散范围（不是缝深阈值）',
      '  float wCurl = 1.0 - smoothstep(0.0, wLineW, abs(wContour - 0.5));',
      '  float wFiberJit = (triplanarHash(floor(wWarped * 8.0) + 6.1) - 0.5) * 2.0 * uTriplanarCellVariance;',
      '  // 底色=colorHi，卷线只轻压暗（* 0.5 权重收窄摆幅，禁止石头级对比度）。',
      '  triTint = mix(uTriplanarColorHi, uTriplanarColorLo, wCurl * 0.5);',
      '  triTint *= (1.0 + wFiberJit * 0.5);',
      '  // 廉价"伪 SSS"：对比压缩把暗部往 1.0 拉，近似光影包羊毛靠 subsurface scattering 透光',
      '  // 填暗部的手感（不是真次表面散射，只是一次 pow，成本可忽略）。',
      '  triTint = pow(max(triTint, 0.0001), vec3(0.85));',
      '  // 背面压暗（配合材质 DoubleSide，见 EffectLayerInjector）：discard 打的洞背后露出的是邻面/',
      '  // 对面内壁而不是背景，压暗后读作"毛发深处的暗绒"而不是"捅穿见天光"。gl_FrontFacing 是内建',
      '  // 变量，不受本层顶点外扩影响（外扩只挪位置不改绕序）。',
      '  if (!gl_FrontFacing) { triTint *= 0.45; }',
      '}',
      '',
      'triTint *= triMacroShade * triFineShade;',
      'vec3 triResult = gl_FragColor.rgb * triTint;',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, triResult, clamp(uTriplanarStrength, 0.0, 1.0));',
    ].join('\n');
  }

  /**
   * Runtime helper：用注入的 THREE 把 manifest 默认值转成 three uniform 对象。
   * @param {object} THREE - three 命名空间
   * @param {object} [overrides] - 可选覆盖（param 名同 manifest）
   * @returns {Object<string,{value:*}>}
   */
  getThreeUniforms(THREE, overrides = {}) {
    const d = this.getDefaultUniforms();
    const colorLo = overrides.colorLo ?? d.colorLo;
    const colorHi = overrides.colorHi ?? d.colorHi;
    const f = (name) => ({ value: overrides[name] ?? d[name] });
    return {
      [UNIFORM_NAMES.colorLo]: { value: new THREE.Color(colorLo[0], colorLo[1], colorLo[2]) },
      [UNIFORM_NAMES.colorHi]: { value: new THREE.Color(colorHi[0], colorHi[1], colorHi[2]) },
      [UNIFORM_NAMES.scale]: f('scale'),
      [UNIFORM_NAMES.stretch]: f('stretch'),
      [UNIFORM_NAMES.strength]: f('strength'),
      [UNIFORM_NAMES.pattern]: f('pattern'),
      [UNIFORM_NAMES.grainContrast]: f('grainContrast'),
      [UNIFORM_NAMES.plankScale]: f('plankScale'),
      [UNIFORM_NAMES.edge]: f('edge'),
      [UNIFORM_NAMES.cellVariance]: f('cellVariance'),
      [UNIFORM_NAMES.macroStrength]: f('macroStrength'),
      [UNIFORM_NAMES.fineNoise]: f('fineNoise'),
      [UNIFORM_NAMES.warpAmount]: f('warpAmount'),
      [UNIFORM_NAMES.warpScale]: f('warpScale'),
      [UNIFORM_NAMES.knotStrength]: f('knotStrength'),
      [UNIFORM_NAMES.stoneNormalStrength]: f('stoneNormalStrength'),
      [UNIFORM_NAMES.barkNormalStrength]: f('barkNormalStrength'),
      [UNIFORM_NAMES.marbleRoughnessVariation]: f('marbleRoughnessVariation'),
      [UNIFORM_NAMES.marbleNormalStrength]: f('marbleNormalStrength'),
      [UNIFORM_NAMES.frayAmount]: f('frayAmount'),
      [UNIFORM_NAMES.frayReach]: f('frayReach'),
      [UNIFORM_NAMES.frayShellWidth]: f('frayShellWidth'),
      [UNIFORM_NAMES.frayDensity]: f('frayDensity'),
      [UNIFORM_NAMES.frayGrainSize]: f('frayGrainSize'),
    };
  }

  /** param→GLSL uniform 名映射，供 builder 生成 uniformDefaults 及 runtime 调参复用。 */
  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }

  static get UNIFORM_NAMES() {
    return { ...UNIFORM_NAMES };
  }
}
