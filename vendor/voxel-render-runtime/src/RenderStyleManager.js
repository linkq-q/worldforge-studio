// RenderStyleManager.js — 卡渲/PBR 渲染风格的「唯一所有者 + 唯一作用域」
//
// 背景（docs/tasks/render-style-unification.md）：卡渲原本两套并行实现都抢 mesh.material。
// 本类把卡渲收敛成一条血缘：基底永远 MeshStandardMaterial，renderMode = 开关 cel 补丁。
//
// 语义边界（review 锁定）：
//   · Cel Banding：bands/shadowFloor/highlightFactor/rampStrength —— 1D ramp 色阶量化。
//   · Terminator Line：enable/threshold/width/intensity/color —— 真·明暗交界线（N·L 窄带）。
//   · PBR：完全不挂 cel 补丁，不受任何色阶影响（applyPBR/applyInk 会清扫残留补丁）。
//
// 作用域红线：只作用于 meshRegistry 里的用户模型 mesh（isUnderModelsRoot + shouldSkipShaderApply）。

import { shouldSkipShaderApply } from './utils/ShaderApplyGuard.js';
import { removeMaterialShaderPatch, hasMaterialShaderPatch } from './utils/MaterialShaderPatchChain.js';
import {
  DEFAULT_CEL_BANDING,
  DEFAULT_TERMINATOR_LINE,
  DEFAULT_SPECULAR_HIGHLIGHT,
  DEFAULT_LIGHT_BAND,
  buildToonRampTexture,
  installCelPatch,
  removeCelPatch,
  updateCelPatchUniforms,
  CEL_PATCH_KEY,
} from './shaders/ToonRamp.js';

/**
 * 作用域红线：对象是否在用户模型根下。与 architecture-constraints.md §1/§4/§9 一致。
 */
export function isUnderModelsRoot(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData?.isModelRoot === true) return true;
    cur = cur.parent;
  }
  return false;
}

export function canApplyCelPatch(material) {
  return Boolean(material?.isMeshStandardMaterial && !material.isShaderMaterial && !material.isRawShaderMaterial);
}

export class RenderStyleManager {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} deps.renderer
   * @param {object} deps.scene
   * @param {Map} deps.meshRegistry - 用户模型 mesh 权威集合
   * @param {object} deps.renderPresets - RenderPresets（渲染模式与 toneMapping 编排器）
   * @param {object} [deps.shaderLib] - ShaderLibrary（glass 唯一所有者；此处仅用于 glass 作用域排除）
   * @param {Function} [deps.getBatchMeshes] - () => InstancedMesh[]，AIPrimitiveBatcher 合批主体
   */
  constructor(deps = {}) {
    this.THREE = deps.THREE;
    this.renderer = deps.renderer;
    this.scene = deps.scene;
    this.meshRegistry = deps.meshRegistry;
    this.renderPresets = deps.renderPresets;
    // 合批主体（AIPrimitiveBatcher InstancedMesh）不在 meshRegistry 里。它们是 PBR-only
    // render cache；切到 CEL 时由 scene-builder 先重建为普通 mesh，再应用卡渲材质。
    this.getBatchMeshes = deps.getBatchMeshes || null;

    this.mode = this.renderPresets?.mode || 'pbr';

    /** 卡渲参数真相（与 CartoonStylePanel 同步）：漫反射分档、交界线、镜面高光和亮面色带。 */
    this.cartoonParams = {
      ...DEFAULT_CEL_BANDING,
      // Terminator Line
      terminatorEnabled: DEFAULT_TERMINATOR_LINE.enabled,
      terminatorSource: DEFAULT_TERMINATOR_LINE.source,
      terminatorThreshold: DEFAULT_TERMINATOR_LINE.threshold,
      terminatorWidth: DEFAULT_TERMINATOR_LINE.width,
      terminatorIntensity: DEFAULT_TERMINATOR_LINE.intensity,
      terminatorColor: DEFAULT_TERMINATOR_LINE.color,
      // Specular Highlight
      specularEnabled: DEFAULT_SPECULAR_HIGHLIGHT.enabled,
      specularColor: DEFAULT_SPECULAR_HIGHLIGHT.color,
      specularSize: DEFAULT_SPECULAR_HIGHLIGHT.size,
      specularIntensity: DEFAULT_SPECULAR_HIGHLIGHT.intensity,
      specularSoftness: DEFAULT_SPECULAR_HIGHLIGHT.softness,
      // Light Band
      lightBandEnabled: DEFAULT_LIGHT_BAND.enabled,
      lightBandSource: DEFAULT_LIGHT_BAND.source,
      lightBandColor: DEFAULT_LIGHT_BAND.color,
      lightBandThreshold: DEFAULT_LIGHT_BAND.threshold,
      lightBandWidth: DEFAULT_LIGHT_BAND.width,
      lightBandIntensity: DEFAULT_LIGHT_BAND.intensity,
      lightBandSoftness: DEFAULT_LIGHT_BAND.softness,
      lightBandBlendMode: DEFAULT_LIGHT_BAND.blendMode,
      // Rim Light (Silhouette)
      rimEnabled: false,
      rimColor: '#1a1a2e',
      rimIntensity: 0.0,
      rimPower: 2.0,
      celLightingMode: 'pbrQuantized', // 留口，本期只 pbrQuantized
    };

    /** 共享 1D ramp 贴图（仅 Cel Banding 亮度）——所有 cel 材质引用同一张。 */
    this.rampTexture = null;

  }

  /** 单一作用域判定：用户模型 mesh 且未被 skip。 */
  styleAppliesTo(obj) {
    if (!isUnderModelsRoot(obj)) return false;
    if (shouldSkipShaderApply(obj)) return false;
    return true;
  }

  /**
   * 唯一入口：按 preset 的 renderMode + cartoon 段应用风格。
   * @param {object} preset - { renderMode, cartoon }
   */
  applyStyle(preset = {}) {
    if (preset.cartoon) this._mergeCartoonParams(preset.cartoon);
    const mode = preset.renderMode || this.mode;
    if (mode === 'cel') return this.applyCel();
    if (mode === 'ink') return this.applyInk();
    return this.applyPBR();
  }

  applyPBR() {
    this.mode = 'pbr';
    this._sweepCelPatch();        // PBR 绝不残留 cel 补丁（含合批主体）
    this.renderPresets?.applyPBR();   // 仅环境编排：背景/toneMapping/HDRI
  }

  applyInk() {
    this.mode = 'ink';
    this._sweepCelPatch();        // ink 走 PBR 基底，同样不挂 cel 补丁
    this.renderPresets?.applyInk();
  }

  /**
   * 应用卡渲：烘 ramp → 本类直接产出 MeshStandard + cel 补丁（T1 起唯一产地，
   * 不再经 RenderPresets legacy 材质 + claimCelMeshes 事后接管的双趟）。
   */
  applyCel(cartoonParams) {
    if (cartoonParams) this._mergeCartoonParams(cartoonParams);
    this.mode = 'cel';
    this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, this.rampTexture);
    this._applyCelToRegisteredMeshes();
    this._applyCelToBatches();
    this.renderPresets?.applyCel();
  }

  /**
   * 卡渲参数变更（滑杆 / 导入）：原地刷新 ramp + 各材质 uniform，零重编译。
   * @param {object} params - CartoonStylePanel.values 子集
   */
  // Material overrides can replace the materials that received the first Cel install.
  // Reinstall only after that restore is complete so Three gets a fresh program/uniform map.
  reinstallCelPatches() {
    if (this.mode !== 'cel') return false;
    this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, this.rampTexture);
    this._sweepCelPatch();
    this._applyCelToRegisteredMeshes();
    this._applyCelToBatches();
    return true;
  }

  setCartoonParams(params = {}) {
    this._mergeCartoonParams(params);
    if (this.mode !== 'cel') return;

    // Cel Banding 的 ramp 是共享对象，原地重写 data → 全体即时生效。
    this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, this.rampTexture);

    const patch = this._fullPatch();
    for (const mesh of this.meshRegistry.values()) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) updateCelPatchUniforms(mat, patch);
    }
    // 合批主体同步刷新（uToonColor 不动，保留各 batch 自身颜色）。
    for (const mesh of this._batchMeshes()) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) updateCelPatchUniforms(mat, patch);
    }
  }

  /**
   * 给合批主体（AIPrimitiveBatcher InstancedMesh）就地挂 cel 补丁。
   * 切到 cel 时 + 每次合批重建后调用，保证新批次材质也带 cel。幂等。
   */
  applyCelToBatches(cartoonParams) {
    if (cartoonParams) this._mergeCartoonParams(cartoonParams);
    this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, this.rampTexture);
    this._applyCelToBatches();
  }

  applyCelToMaterial(material, cartoonParams) {
    if (cartoonParams) this._mergeCartoonParams(cartoonParams);
    if (!this.rampTexture) {
      this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, null);
    }
    this._applyCelToMaterial(material);
  }

  /** 从合批主体卸下 cel 补丁（切回 PBR/Ink 时调用）。 */
  sweepCelFromBatches() {
    for (const mesh of this._batchMeshes()) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) removeCelPatch(mat);
    }
  }

  // ── 内部 ──

  _mergeCartoonParams(params) {
    for (const key of Object.keys(this.cartoonParams)) {
      if (params[key] !== undefined) this.cartoonParams[key] = params[key];
    }
  }

  _terminatorCtx() {
    const p = this.cartoonParams;
    return {
      enabled: p.terminatorEnabled,
      source: p.terminatorSource,
      threshold: p.terminatorThreshold,
      width: p.terminatorWidth,
      intensity: p.terminatorIntensity,
      color: p.terminatorColor,
    };
  }

  _lightBandCtx() {
    const p = this.cartoonParams;
    return {
      enabled: p.lightBandEnabled,
      source: p.lightBandSource,
      color: p.lightBandColor,
      threshold: p.lightBandThreshold,
      width: p.lightBandWidth,
      intensity: p.lightBandIntensity,
      softness: p.lightBandSoftness,
      blendMode: p.lightBandBlendMode,
    };
  }

  _specularCtx() {
    const p = this.cartoonParams;
    return {
      enabled: p.specularEnabled,
      color: p.specularColor,
      size: p.specularSize,
      intensity: p.specularIntensity,
      softness: p.specularSoftness,
    };
  }

  _rimCtx() {
    const p = this.cartoonParams;
    return {
      enabled: p.rimEnabled,
      color: p.rimColor,
      intensity: p.rimIntensity,
      power: p.rimPower,
    };
  }

  /** Diffuse Band 标量/颜色参数（不含 toonColor，那是每材质自身 albedo）。 */
  _diffuseCtx() {
    const p = this.cartoonParams;
    return {
      rampStrength: p.rampStrength,
      bands: p.bands,
      bandSource: p.bandSource,
      bandContrast: p.bandContrast,
      lightColorInfluence: p.lightColorInfluence,
      shadowPreserve: p.shadowPreserve,
      shadowTint: p.shadowTint,
      midTint: p.midTint,
      lightTint: p.lightTint,
    };
  }

  /** 完整 uniform 刷新 patch（共享给 meshRegistry + 合批主体）。 */
  _fullPatch() {
    return {
      ...this._diffuseCtx(),
      rampTexture: this.rampTexture,
      lightDir: this._getLightDir(),
      terminator: this._terminatorCtx(),
      specular: this._specularCtx(),
      lightBand: this._lightBandCtx(),
      rimLight: this._rimCtx(),
    };
  }

  /** 主平行光世界方向（与 RenderPresets.getLightDirection 同源）。 */
  _getLightDir() {
    const THREE = this.THREE;
    const dir = new THREE.Vector3(0.5, 1, 0.5);
    const light = this.scene?.userData?.directionalLight;
    if (light?.getWorldPosition) {
      light.getWorldPosition(dir);
      if (light.target?.getWorldPosition) {
        const target = new THREE.Vector3();
        light.target.getWorldPosition(target);
        dir.sub(target);
      }
    }
    return dir.normalize();
  }

  /** 清扫 meshRegistry + 合批主体内任何残留的 cel 补丁（切回 PBR/Ink 前调用）。 */
  _sweepCelPatch() {
    if (this.meshRegistry) {
      for (const mesh of this.meshRegistry.values()) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) removeCelPatch(mat);
      }
    }
    for (const mesh of this._batchMeshes()) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) removeCelPatch(mat);
    }
  }

  /** AIPrimitiveBatcher 合批主体 InstancedMesh 列表（无则空）。 */
  _batchMeshes() {
    if (!this.getBatchMeshes) return [];
    try { return this.getBatchMeshes() || []; }
    catch { return []; }
  }

  _applyCelToRegisteredMeshes() {
    if (!this.meshRegistry) return;
    for (const mesh of this.meshRegistry.values()) {
      if (!this.styleAppliesTo(mesh)) continue;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) this._applyCelToMaterial(material);
    }
  }

  _applyCelToMaterial(material) {
    // 幂等守卫必须查真实 patch 链（hasMaterialShaderPatch），不能只看 userData.celPatchUniforms
    // 是否 truthy——Material.clone() 走 JSON 深拷 userData（celPatchUniforms 里的 Texture/Vector3
    // 被拷成死对象残骸，patchFn 函数值被 JSON.stringify 丢弃），克隆材质会看起来"已装"却从未真正
    // 挂上 onBeforeCompile，永久停留在裸 PBR（2026-07-18 matcap-cel-unify-v1 附带核查确认）。
    if (!canApplyCelPatch(material) || hasMaterialShaderPatch(material, CEL_PATCH_KEY)) return;
    removeMaterialShaderPatch(material, 'shaderLibrary:pbrOverlay');
    installCelPatch(material, {
      THREE: this.THREE,
      toonColor: material.color || new this.THREE.Color(0xcccccc),
      ...this._diffuseCtx(),
      rampTexture: this.rampTexture,
      lightDir: this._getLightDir(),
      terminator: this._terminatorCtx(),
      specular: this._specularCtx(),
      lightBand: this._lightBandCtx(),
      rimLight: this._rimCtx(),
    });
  }

  /**
   * 给合批主体（InstancedMesh，MeshStandard 材质）就地挂 cel 补丁。
   * 不替换材质（保留 batcher 所有权 + instancing）；uToonColor 取各 batch 自身颜色。
   * applyToScene 会跳过合批主体（非 isUserContent），故此处是它们唯一的 cel 入口，无双补丁冲突。
   */
  _applyCelToBatches() {
    const meshes = this._batchMeshes();
    if (!meshes.length) return;
    if (!this.rampTexture) {
      this.rampTexture = buildToonRampTexture(this.THREE, this.cartoonParams, null);
    }
    for (const mesh of meshes) {
      const mat = mesh.material;
      if (!mat || Array.isArray(mat) || !mat.isMeshStandardMaterial) continue;
      if (hasMaterialShaderPatch(mat, CEL_PATCH_KEY)) continue; // 幂等（真链检查，见 _applyCelToMaterial 注释）
      // ShaderLibrary 的 cartoon overlay 与本 cel 补丁都声明 uBands → 同材质共存会
      // 'uBands' redefinition 编译失败（合批主体不绘制＝看起来透明）。cel 由本类独占，
      // 先卸掉 ShaderLibrary overlay 再挂 cel；切回 PBR 时 applyToScene('default') 会重建。
      removeMaterialShaderPatch(mat, 'shaderLibrary:pbrOverlay');
      installCelPatch(mat, {
        THREE: this.THREE,
        toonColor: mat.color || new this.THREE.Color(0xcccccc),
        ...this._diffuseCtx(),
        rampTexture: this.rampTexture,
        lightDir: this._getLightDir(),
        terminator: this._terminatorCtx(),
        specular: this._specularCtx(),
        lightBand: this._lightBandCtx(),
        rimLight: this._rimCtx(),
      });
    }
  }

  /** 与旧 RenderPresets.getMeshColor 同语义：材质色 > uniform 色 > 存档色 > 灰。 */
  /** ShaderLibrary 共享材质（glass 派生缓存）不 dispose，其余照常释放。 */
  /** PBR/Ink 基底材质（从 RenderPresets.createPBRMaterial 收编，语义不变 + highlight 钩子）。 */
  /**
   * 卡渲材质 = MeshStandardMaterial + cel 补丁（Cel Banding + Terminator Line）。
   * envMap 不显式持有：MeshStandard 在 envMap=null 时自动用 scene.environment，
   * EnvironmentReflectionManager bake 后重指 scene.environment 即全体生效
   * （旧 claim 路径显式持有 envMap，bake 更新推不进去，是潜在 stale bug）。
   */
}
