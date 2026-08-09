/**
 * EffectVariantCache.js — variantKey → EffectVariantDescriptor 缓存（任务书 #03）
 *
 * 只缓存「怎么 patch」（descriptor），不缓存 THREE.ShaderMaterial（mesh 可能共享 material，
 * base shader 各异，缓存完整 material 风险大）。统计 hits/misses/builds 供 debug 观察。
 *
 * 硬约束：纯逻辑，禁止 import three。不持有 mesh / material 引用，避免泄漏。
 */

export class EffectVariantCache {
  constructor() {
    this._cache = new Map();
    this._stats = { hits: 0, misses: 0, builds: 0 };
  }

  has(key) {
    return this._cache.has(key);
  }

  get(key) {
    if (this._cache.has(key)) {
      this._stats.hits += 1;
      return this._cache.get(key);
    }
    this._stats.misses += 1;
    return undefined;
  }

  set(key, descriptor) {
    this._cache.set(key, descriptor);
    return descriptor;
  }

  /**
   * 命中则返回缓存（hits++）；未命中则 buildFn() 构建、入缓存（misses++ builds++）。
   * @param {string} key
   * @param {()=>object} buildFn
   * @returns {object} descriptor
   */
  getOrBuild(key, buildFn) {
    if (this._cache.has(key)) {
      this._stats.hits += 1;
      return this._cache.get(key);
    }
    this._stats.misses += 1;
    this._stats.builds += 1;
    const descriptor = buildFn();
    this._cache.set(key, descriptor);
    return descriptor;
  }

  clear() {
    this._cache.clear();
    // 统计累计值不清零（反映会话总命中情况）；如需重置另调 resetStats()
  }

  resetStats() {
    this._stats = { hits: 0, misses: 0, builds: 0 };
  }

  stats() {
    return {
      cacheSize: this._cache.size,
      hits: this._stats.hits,
      misses: this._stats.misses,
      builds: this._stats.builds,
      keys: [...this._cache.keys()],
    };
  }
}
