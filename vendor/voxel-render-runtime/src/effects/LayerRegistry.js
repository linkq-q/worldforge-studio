/**
 * LayerRegistry.js — Layer 注册表（任务书 #01）
 *
 * 职责：注册 manifest（校验通过才入表）、查询、按大类稳定排序、检测不兼容冲突。
 * 硬约束：纯逻辑，禁止 import three。
 */

import { EffectLayer, sortByStageOrder, validateManifest } from './EffectLayer.js';

export class LayerRegistry {
  constructor() {
    /** @type {Map<string, EffectLayer>} */
    this._layers = new Map();
  }

  /**
   * 注册一份 manifest。校验失败或 id 重复都抛错。
   * @param {object} manifest
   * @returns {EffectLayer}
   */
  register(manifest) {
    const { valid, errors } = validateManifest(manifest);
    if (!valid) {
      throw new Error(`Cannot register invalid manifest for ${manifest?.id}: ${errors.join('; ')}`);
    }
    if (this._layers.has(manifest.id)) {
      throw new Error(`Layer id already registered: ${manifest.id}`);
    }
    const layer = new EffectLayer(manifest);
    this._layers.set(layer.id, layer);
    return layer;
  }

  has(id) {
    return this._layers.has(id);
  }

  /**
   * @param {string} id
   * @returns {EffectLayer}
   */
  get(id) {
    const layer = this._layers.get(id);
    if (!layer) throw new Error(`Layer not registered: ${id}`);
    return layer;
  }

  /**
   * @returns {string[]} 所有已注册 id
   */
  list() {
    return [...this._layers.keys()];
  }

  /**
   * 按 STAGE_ORDER 排序一组 id；同阶段保持传入相对顺序（稳定排序）。
   * @param {string[]} ids
   * @returns {string[]}
   */
  sortByStage(ids) {
    const items = ids.map(id => ({ id, stage: this.get(id).stage }));
    return sortByStageOrder(items).map(item => item.id);
  }

  /**
   * 检测一组 layer 之间的不兼容冲突。
   * 冲突来源：任一对 id 互在对方 incompatibleWith（任一方声明即算冲突）。
   * @param {string[]} ids
   * @returns {{ok:boolean, conflicts:Array<[string,string]>}}
   */
  checkCompatibility(ids) {
    const conflicts = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const aIncompat = this.get(a).manifest.incompatibleWith || [];
        const bIncompat = this.get(b).manifest.incompatibleWith || [];
        if (aIncompat.includes(b) || bIncompat.includes(a)) {
          conflicts.push([a, b]);
        }
      }
    }
    return { ok: conflicts.length === 0, conflicts };
  }
}
