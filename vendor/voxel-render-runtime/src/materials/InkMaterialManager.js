/**
 * InkMaterialManager.js — 全局水墨表面材质管理器
 *
 * 职责：
 *   - apply(scene)：遍历所有 Mesh，缓存原材质，替换为 InkSurfaceMaterial
 *   - restore()：恢复所有原始材质，dispose 替代材质
 *   - updateSettings(settings)：运行时更新所有已替换材质的参数
 *   - setNoiseTexture(texture) / setBrushTexture(texture)：全局更新贴图槽
 *
 * 使用方式：
 *   import { InkMaterialManager } from './materials/InkMaterialManager.js';
 *   const manager = new InkMaterialManager();
 *   manager.apply(scene);
 */

import * as THREE from 'three';
import { createInkSurfaceMaterial } from './InkSurfaceMaterial.js';

const SKIP_KEYWORDS = [
  'TransformControls',
  'Grid',
  'Helper',
  'Gizmo',
  'Sky',
  'Skybox',
  'skydome',
];

const SKIP_NAMES_LOWER = [
  'water',
  'watersurface',
  'ocean',
  'sea',
  'river',
];

export class InkMaterialManager {
  constructor() {
    this.enabled = false;
    /** @type {Map<string, { mesh: THREE.Mesh, originalMaterial: THREE.Material, inkMaterial: THREE.ShaderMaterial }>} */
    this.records = new Map();
    /** @type {object} */
    this.settings = {};
    /** @type {THREE.Texture|null} */
    this.noiseTex = null;
    /** @type {THREE.Texture|null} */
    this.brushTex = null;
  }

  // ── 判断是否应跳过某个 Mesh ──

  shouldSkip(obj) {
    if (!obj.isMesh) return true;
    if (obj.userData?.excludeInkSurface) return true;
    if (obj.userData?.isWater) return true;

    const name = obj.name || '';
    const nameLower = name.toLowerCase();
    for (const kw of SKIP_KEYWORDS) {
      if (name.includes(kw)) return true;
    }
    for (const w of SKIP_NAMES_LOWER) {
      if (nameLower.includes(w)) return true;
    }

    // 跳过透明物体（水面/玻璃/半透明叶片第一版不处理）
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat?.transparent) return true;

    // 跳过已经是 InkSurfaceMaterial 的（幂等）
    if (mat?.name === 'InkSurfaceMaterial') return true;

    // 跳过 Sprite / Points
    if (obj.isSprite || obj.isPoints) return true;

    return false;
  }

  // ── 核心：一键套用 ──

  /**
   * @param {THREE.Scene} scene
   * @param {object} [settings] 初始材质参数
   */
  apply(scene, settings = {}) {
    if (this.enabled) return;
    this.enabled = true;
    this.settings = { ...settings };

    scene.traverse((obj) => {
      if (this.shouldSkip(obj)) return;
      if (this.records.has(obj.uuid)) return;

      const originalMaterial = obj.material;
      const oldMat = Array.isArray(originalMaterial) ? originalMaterial[0] : originalMaterial;

      const inkMat = createInkSurfaceMaterial({
        ...this.settings,
        noiseTex: this.noiseTex,
        brushTex: this.brushTex,
        baseMap: oldMat?.map ?? null,
        baseColor: oldMat?.color ?? new THREE.Color(1, 1, 1),
      });

      // 复制原材质的关键渲染状态
      inkMat.side = oldMat?.side ?? THREE.FrontSide;
      inkMat.transparent = oldMat?.transparent ?? false;
      inkMat.depthWrite = oldMat?.depthWrite ?? true;
      inkMat.depthTest = oldMat?.depthTest ?? true;

      obj.material = inkMat;

      this.records.set(obj.uuid, {
        mesh: obj,
        originalMaterial,
        inkMaterial: inkMat,
      });
    });
  }

  // ── 恢复原始材质 ──

  restore() {
    for (const record of this.records.values()) {
      record.inkMaterial.dispose();
      record.mesh.material = record.originalMaterial;
    }
    this.records.clear();
    this.enabled = false;
  }

  // ── 全局参数更新 ──

  /**
   * @param {object} settings 覆盖部分 settings
   */
  updateSettings(settings = {}) {
    Object.assign(this.settings, settings);

    const {
      paperColor, inkColor, lightDir,
      toneContrast, toneLow, toneHigh,
      noiseScale, noiseStrength,
      brushScale, brushStrength,
      useOriginalAlbedo, albedoInfluence,
      useWorldSpaceNoise,
      // 密度场
      densityEnabled, densityDir,
      densityScale, densityOffset, densityContrast,
      noiseScaleSparse, noiseScaleDense,
      noiseStrengthLow, noiseStrengthHigh,
      macroNoiseScale, macroNoiseInfluence,
      depthDensityEnabled, depthNear, depthFar,
      depthDensityStrength, depthToneStrength,
      densityToneInfluence,
    } = this.settings;

    for (const record of this.records.values()) {
      const u = record.inkMaterial.uniforms;
      if (paperColor !== undefined) u.uPaperColor.value.set(paperColor);
      if (inkColor !== undefined) u.uInkColor.value.set(inkColor);
      if (lightDir !== undefined) {
        u.uLightDir.value.copy(
          typeof lightDir === 'string'
            ? new THREE.Vector3().fromArray(lightDir.split(',').map(Number))
            : lightDir instanceof THREE.Vector3 ? lightDir : new THREE.Vector3(0.4, 0.8, 0.3)
        ).normalize();
      }
      if (toneContrast !== undefined) u.uToneContrast.value = toneContrast;
      if (toneLow !== undefined) u.uToneLow.value = toneLow;
      if (toneHigh !== undefined) u.uToneHigh.value = toneHigh;
      if (noiseScale !== undefined) u.uNoiseScale.value = noiseScale;
      if (noiseStrength !== undefined) u.uNoiseStrength.value = noiseStrength;
      if (brushScale !== undefined) u.uBrushScale.value = brushScale;
      if (brushStrength !== undefined) u.uBrushStrength.value = brushStrength;
      if (useOriginalAlbedo !== undefined) u.uUseOriginalAlbedo.value = useOriginalAlbedo;
      if (albedoInfluence !== undefined) u.uAlbedoInfluence.value = albedoInfluence;
      if (useWorldSpaceNoise !== undefined) u.uUseWorldSpaceNoise.value = useWorldSpaceNoise;
      // 密度场
      if (densityEnabled !== undefined) u.uDensityEnabled.value = densityEnabled;
      if (densityDir !== undefined) {
        const d = densityDir instanceof THREE.Vector3 ? densityDir : new THREE.Vector3(1, 0, 1);
        d.normalize();
        u.uDensityDir.value.copy(d);
      }
      if (densityScale !== undefined) u.uDensityScale.value = densityScale;
      if (densityOffset !== undefined) u.uDensityOffset.value = densityOffset;
      if (densityContrast !== undefined) u.uDensityContrast.value = densityContrast;
      if (noiseScaleSparse !== undefined) u.uNoiseScaleSparse.value = noiseScaleSparse;
      if (noiseScaleDense !== undefined) u.uNoiseScaleDense.value = noiseScaleDense;
      if (noiseStrengthLow !== undefined) u.uNoiseStrengthLow.value = noiseStrengthLow;
      if (noiseStrengthHigh !== undefined) u.uNoiseStrengthHigh.value = noiseStrengthHigh;
      if (macroNoiseScale !== undefined) u.uMacroNoiseScale.value = macroNoiseScale;
      if (macroNoiseInfluence !== undefined) u.uMacroNoiseInfluence.value = macroNoiseInfluence;
      if (depthDensityEnabled !== undefined) u.uDepthDensityEnabled.value = depthDensityEnabled;
      if (depthNear !== undefined) u.uDepthNear.value = depthNear;
      if (depthFar !== undefined) u.uDepthFar.value = depthFar;
      if (depthDensityStrength !== undefined) u.uDepthDensityStrength.value = depthDensityStrength;
      if (depthToneStrength !== undefined) u.uDepthToneStrength.value = depthToneStrength;
      if (densityToneInfluence !== undefined) u.uDensityToneInfluence.value = densityToneInfluence;
    }
  }

  // ── 贴图槽更新 ──

  setNoiseTexture(texture) {
    this.noiseTex = texture;
    for (const record of this.records.values()) {
      record.inkMaterial.uniforms.uNoiseTex.value = texture;
      record.inkMaterial.uniforms.uHasNoiseTex.value = !!texture;
    }
  }

  setBrushTexture(texture) {
    this.brushTex = texture;
    for (const record of this.records.values()) {
      record.inkMaterial.uniforms.uBrushTex.value = texture;
      record.inkMaterial.uniforms.uHasBrushTex.value = !!texture;
    }
  }
}
