/**
 * ParticleCompanion.js — 粒子 companion 运行时（任务书 particle-system-v1 Phase 1）
 *
 * 对齐 FlameAura 的 companion 契约：模块级工厂函数 + 外部 tick + 幂等 create。
 * 引擎是模块级单例（scene-builder 单场景），emitter 对象加在场景根（世界空间），
 * 发射原点每帧跟随 target 的 world position。
 *
 * create 幂等语义：同一 (target, preset) 重复调用 = 替换旧 emitter（更新参数），不叠加。
 */
import * as THREE from 'three';
import { ParticleEngine } from './ParticleEngine.js';
import { PARTICLE_PRESETS } from './ParticlePresets.js';

let engine = null;
/** target(Object3D) → Map(presetName → emitter handle) */
const active = new Map();

/**
 * 运行时预设覆盖表(particle-editor-panel-v1 修订 4):
 * 编辑器面板保存/预览时写入,查找优先于 PARTICLE_PRESETS——同 session 内
 * 魔杖/scene 触发立即用新参数,不必刷新页面;刷新后回归文件真源。
 */
const runtimePresets = new Map();

/** name 为 '__preview__' 时供面板实时预览;其余为保存后的同 session 覆盖。 */
export function setRuntimePreset(name, config) {
  runtimePresets.set(name, { config });
}

function resolvePreset(name) {
  return runtimePresets.get(name) || PARTICLE_PRESETS[name] || null;
}

function resolveScene(object) {
  if (!object) return null;
  let node = object;
  while (node.parent) node = node.parent;
  return node.isScene ? node : null;
}

function ensureEngine(target, sceneOverride = null) {
  if (engine) return engine;
  const scene = sceneOverride || resolveScene(target);
  if (!scene) return null;
  // ponytail: 模块级单例假设单场景（scene-builder 现状）；多场景时改为 per-scene map
  engine = new ParticleEngine({ THREE, scene });
  return engine;
}

/**
 * Spawn one particle emitter from a preset or a direct config.
 * Object anchors are tracked when `key` is provided, so root cleanup keeps working.
 * World anchors must provide the scene once: { worldPos: [x,y,z], scene }.
 * @returns {import('./ParticleEngine.js').ParticleEmitter|null}
 */
export function createParticleEffect(anchor = {}, options = {}) {
  const object = anchor.attachTo || anchor.object || null;
  const worldPos = anchor.worldPos;
  if (!object?.isObject3D && !Array.isArray(worldPos)) return null;

  const preset = options.preset ? resolvePreset(options.preset) : null;
  const sourceConfig = options.config || preset?.config;
  if (!sourceConfig) return null;

  const eng = ensureEngine(object, anchor.scene);
  if (!eng) return null;

  const key = options.key || null;
  let slots = null;
  if (object && key) {
    slots = active.get(object);
    if (!slots) {
      slots = new Map();
      active.set(object, slots);
    }
    const existing = slots.get(key);
    if (existing) eng.remove(existing);
  }

  const config = { ...sourceConfig, ...(options.overrides || {}) };
  const emitter = eng.spawn(config, object ? { attachTo: object } : { worldPos });
  if (slots) slots.set(key, emitter);
  return emitter;
}

/** Immediately remove a direct emitter handle. */
export function removeParticleEffect(emitter) {
  if (!engine?.emitters.has(emitter)) return false;
  engine.remove(emitter);
  for (const [object, slots] of active) {
    for (const [name, activeEmitter] of slots) {
      if (activeEmitter === emitter) slots.delete(name);
    }
    if (slots.size === 0) active.delete(object);
  }
  return true;
}

/** Whether a direct emitter handle is still owned by the shared engine. */
export function isParticleEffectActive(emitter) {
  return !!engine?.emitters.has(emitter);
}

/**
 * 给对象挂一个预设粒子效果。幂等：同名预设重复挂 = 替换。
 * @param {object} target - Object3D（须已在场景内）
 * @param {object} [options] - { preset: 'flame', overrides: {...engine config 覆盖} }
 * @returns {boolean} 成功与否
 */
export function createParticleEffectForObject(target, options = {}) {
  const object = target?.object || target;
  if (!object?.isObject3D) return false;
  const presetName = options.preset || 'flame';
  return !!createParticleEffect(
    { attachTo: object },
    { preset: presetName, overrides: options.overrides, key: presetName },
  );
}

/** 移除对象上的粒子效果。presetName 省略 = 全部。返回移除数量。 */
export function clearParticleEffectsFromObject(target, presetName = null) {
  const object = target?.object || target;
  const slots = active.get(object);
  if (!slots) return 0;
  let removed = 0;
  for (const [name, emitter] of slots) {
    if (presetName && name !== presetName) continue;
    engine?.remove(emitter);
    slots.delete(name);
    removed++;
  }
  if (slots.size === 0) active.delete(object);
  return removed;
}

/** 移除 root 子树下所有对象的粒子效果（对齐 clearFlameAuraFromRoot）。 */
export function clearParticleEffectsFromRoot(root) {
  const rootObj = root?.object || root;
  if (!rootObj?.isObject3D) return 0;
  let removed = 0;
  for (const object of [...active.keys()]) {
    let node = object;
    let inside = false;
    while (node) {
      if (node === rootObj) { inside = true; break; }
      node = node.parent;
    }
    if (inside) removed += clearParticleEffectsFromObject(object);
  }
  return removed;
}

/**
 * 每帧推进。放渲染循环里，与 tickFlameAura 同处；无 emitter 时近零成本。
 * burst 类效果（hit_spark/hit_debris）消亡后引擎自动回收，这里同步清掉 slot 记录。
 */
export function tickParticleEffects(dt, camera = null, depthTexture = null, viewportHeight = null) {
  if (!engine || engine.emitters.size === 0) {
    if (engine) pruneFinished();
    return;
  }
  engine.update(dt, camera, depthTexture, viewportHeight);
  pruneFinished();
}

function pruneFinished() {
  for (const [object, slots] of active) {
    for (const [name, emitter] of slots) {
      if (!engine.emitters.has(emitter)) slots.delete(name);
    }
    if (slots.size === 0) active.delete(object);
  }
}

/** 调试/测试用。 */
export function getParticleEffectStats() {
  return {
    targets: active.size,
    emitters: engine ? engine.emitters.size : 0,
  };
}
