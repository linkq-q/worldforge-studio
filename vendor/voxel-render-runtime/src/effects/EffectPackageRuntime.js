/**
 * EffectPackageRuntime.js — Effect Package 应用入口（任务书 #03）
 *
 * 把一个 effectPackage（schemaVersion + materialLayers + layerParams）应用到 Object3D / Material：
 *   package → 校验 layer → sortByStage → checkCompatibility → builder.buildVariant
 *           → cache.getOrBuild → injector.applyEffectVariantToMaterial → 写入 uniform 默认值。
 *
 * 关键：参数变化只调 updateParams（改 uniform，不 rebuild、不重 patch、不改 variantKey）。
 *
 * 本文件 import 注入层（间接 import three）→ 仅浏览器/运行时使用，不在纯 node 协议测试中加载。
 */

import { LayerRegistry } from './LayerRegistry.js';
import { registerCoreLayers } from './coreLayers.manifest.js';
import { EffectVariantBuilder } from './EffectVariantBuilder.js';
import { EffectVariantCache } from './EffectVariantCache.js';
import { FresnelRimLayer } from './layers/FresnelRimLayer.js';
import { EmissivePulseLayer } from './layers/EmissivePulseLayer.js';
import { FlameLayer } from './layers/FlameLayer.js';
import { HitFlashLayer } from './layers/HitFlashLayer.js';
import { MatcapBaseLayer } from './layers/MatcapBaseLayer.js';
import { ChargeAuraLayer } from './layers/ChargeAuraLayer.js';
import { TriplanarLayer } from './layers/TriplanarLayer.js';
import { FoliageLayer } from './layers/FoliageLayer.js';
import { VegetationSwayLayer } from './layers/VegetationSwayLayer.js';
import {
  applyEffectVariantToMaterial,
  applyEffectVariantToObject3D,
  updateVariantParams,
  updateVariantRuntimeUniforms,
  removeEffectVariantFromObject3D,
  describeMaterialVariant,
} from './EffectLayerInjector.js';

/** id → 真实 Layer 实例工厂（GLSL 发射层）。协议 registry 给的是基类，故需独立解析。 */
const CORE_LAYER_FACTORY = {
  MatcapBase: () => new MatcapBaseLayer(),
  Triplanar: () => new TriplanarLayer(),
  Flame: () => new FlameLayer(),
  EmissivePulse: () => new EmissivePulseLayer(),
  HitFlash: () => new HitFlashLayer(),
  ChargeAura: () => new ChargeAuraLayer(),
  FresnelRim: () => new FresnelRimLayer(),
  Foliage: () => new FoliageLayer(),
  VegetationSway: () => new VegetationSwayLayer(),
};

export class EffectPackageRuntime {
  /**
   * @param {object} deps
   * @param {LayerRegistry} deps.registry
   * @param {EffectVariantBuilder} deps.builder
   * @param {EffectVariantCache} deps.cache
   */
  constructor({ registry, builder, cache }) {
    this.registry = registry;
    this.builder = builder;
    this.cache = cache;
    this.activeVariantKey = null;
    this._usesRuntimeUniforms = false; // 任一已应用 variant 含 runtime uniform（uTime）→ 动画循环才需每帧 tick
  }

  /** package → builder 输入。materialLayers 里既可能是纯 id 字符串（旧格式/测试 mock），
   *  也可能是 { id, type, route, params } 富对象（MagicWandEffectPresets 等现用格式）——
   *  取字符串本身或 .type。route==='materialOverride' 的层（Glass/InkSurface/WhiteStroke）
   *  不在这套 shaderPatch registry 里，过滤掉，交给别的 override 通道处理。 */
  _toBuilderInput(effectPackage) {
    const shaderLayers = (effectPackage.materialLayers || [])
      .filter((l) => (typeof l === 'string' ? true : l?.route !== 'materialOverride'));
    const layerIds = shaderLayers
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean);
    const layerParams = { ...(effectPackage.layerParams || {}) };
    for (const layer of shaderLayers) {
      if (typeof layer === 'string' || !layer?.type || !layer.params) continue;
      layerParams[layer.type] = { ...(layerParams[layer.type] || {}), ...layer.params };
    }
    return {
      layerIds,
      layerParams,
      target: { shadingModel: effectPackage.target?.shadingModel || 'pbr' },
    };
  }

  _withResolvedUniformDefaults(descriptor, layerParams) {
    const uniformDefaults = { ...descriptor.uniformDefaults };
    for (const [layerId, params] of Object.entries(layerParams || {})) {
      const uniformMap = descriptor.paramUniformMaps?.[layerId];
      if (!uniformMap || !params) continue;
      for (const [paramName, uniformName] of Object.entries(uniformMap)) {
        if (params[paramName] === undefined) continue;
        const value = params[paramName];
        uniformDefaults[uniformName] = Array.isArray(value) ? [...value] : value;
      }
    }
    return { ...descriptor, uniformDefaults };
  }

  /** 经缓存拿 descriptor（命中则不 rebuild）。纯 materialOverride 包过滤后无 shaderPatch 层 → 返回 null（无需 variant）。 */
  _resolveDescriptor(effectPackage) {
    const input = this._toBuilderInput(effectPackage);
    if (input.layerIds.length === 0) return null;
    const key = this.builder.computeVariantKey(input);
    const descriptor = this.cache.getOrBuild(key, () => this.builder.buildVariant(input));
    this.activeVariantKey = key;
    if (descriptor.runtimeUniforms && descriptor.runtimeUniforms.length) this._usesRuntimeUniforms = true;
    // The cached descriptor owns shader structure only. Uniform values are per package:
    // returning the cached defaults here makes the first Triplanar material (usually wood)
    // overwrite stone and every later style with its pattern and axis parameters.
    return this._withResolvedUniformDefaults(descriptor, input.layerParams);
  }

  applyToMaterial(material, effectPackage) {
    const descriptor = this._resolveDescriptor(effectPackage);
    return descriptor ? applyEffectVariantToMaterial(material, descriptor) : null;
  }

  applyToObject3D(root, effectPackage) {
    const descriptor = this._resolveDescriptor(effectPackage);
    return descriptor ? applyEffectVariantToObject3D(root, descriptor) : null;
  }

  /**
   * 只改参数：不 rebuild、不重 patch、variantKey 不变。
   * @param {THREE.Object3D|THREE.Material} root
   * @param {Object<string,object>} paramsPatch - { layerId: { paramName: value } }
   */
  updateParams(root, paramsPatch) {
    let count = 0;
    if (root?.isMaterial) {
      if (updateVariantParams(root, paramsPatch)) count = 1;
    } else if (root?.traverse) {
      root.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of mats) if (updateVariantParams(m, paramsPatch)) count++;
      });
    }
    return count;
  }

  /**
   * 每帧 tick：把系统/运行时 uniform（uTime…）写进所有已注入 variant 的材质。
   * 仅在有 variant 使用 runtime uniform 时遍历，且只遍历传入 root（用户模型），不碰全场景。
   * @param {THREE.Object3D|THREE.Material} root
   * @param {Object<string,number>} runtimeValues - { uTime: seconds, ... }
   * @returns {number} 命中的材质数
   */
  updateRuntimeUniforms(root, runtimeValues = {}) {
    if (!this._usesRuntimeUniforms || !root) return 0;
    let count = 0;
    if (root.isMaterial) {
      if (updateVariantRuntimeUniforms(root, runtimeValues)) count = 1;
    } else if (root.traverse) {
      root.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of mats) if (updateVariantRuntimeUniforms(m, runtimeValues)) count++;
      });
    }
    return count;
  }

  removeFromObject3D(root) {
    removeEffectVariantFromObject3D(root);
  }

  describeMaterial(material) {
    return describeMaterialVariant(material);
  }

  stats() {
    return { ...this.cache.stats(), activeVariantKey: this.activeVariantKey };
  }
}

/**
 * 便捷工厂：装配 registry（核心 manifest 已注册）+ builder（核心真实 layer 解析器）+ cache + runtime。
 * @param {object} [opts]
 * @param {Object<string,()=>object>} [opts.layerFactory] - 追加/覆盖 id→实例工厂（如注入 mock 层）
 * @returns {{ registry, builder, cache, runtime }}
 */
export function createEffectRuntime(opts = {}) {
  const registry = new LayerRegistry();
  registerCoreLayers(registry);

  const factory = { ...CORE_LAYER_FACTORY, ...(opts.layerFactory || {}) };
  const instances = new Map();
  const resolveLayer = (id) => {
    if (!instances.has(id)) {
      const make = factory[id];
      if (!make) throw new Error(`createEffectRuntime: no real-layer factory for "${id}"`);
      instances.set(id, make());
    }
    return instances.get(id);
  };

  const builder = new EffectVariantBuilder(registry, resolveLayer);
  const cache = new EffectVariantCache();
  const runtime = new EffectPackageRuntime({ registry, builder, cache });
  return { registry, builder, cache, runtime };
}
