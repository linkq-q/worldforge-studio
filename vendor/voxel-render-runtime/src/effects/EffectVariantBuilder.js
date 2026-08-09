/**
 * EffectVariantBuilder.js — 把多个 Effect Layer 组合成稳定 shader variant（任务书 #03）
 *
 * 核心：区分「结构」与「参数」——
 *   - 结构（layer 集合 + 排序 + target）决定 variantKey 与 shader 源码 → 变了才重编译。
 *   - 参数（color/power/intensity…）只进 uniform 默认值 → 变了只改 uniform，key 不变。
 *
 * 硬约束：**纯逻辑，禁止 import three**。只处理字符串与普通值，可脱离浏览器 node 自测。
 *
 * 依赖：
 *   - registry: #01 的 LayerRegistry（提供 sortByStage / checkCompatibility / has；按 manifest 的 stage 排序）。
 *   - resolveLayer(id): 返回**真实** Layer 实例（有 getUniformDeclarations/getVertexBody/getFragmentBody/
 *     getDefaultUniforms/getParamUniformMap）。注意 registry.get() 给的是协议基类，不能发射 GLSL，故需独立 resolver。
 */

const VARIANT_SCHEMA_VERSION = 'v1';

function dedupeLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const key = line.trim();
    const isSharedDeclaration = /^(uniform|varying)\b/.test(key);
    if (isSharedDeclaration && seen.has(key)) continue;
    if (isSharedDeclaration) seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

export class EffectVariantBuilder {
  /**
   * @param {object} registry - LayerRegistry（has/sortByStage/checkCompatibility）
   * @param {(id:string)=>object} resolveLayer - id → 真实 Layer 实例
   */
  constructor(registry, resolveLayer) {
    if (!registry) throw new Error('EffectVariantBuilder requires a registry');
    if (typeof resolveLayer !== 'function') throw new Error('EffectVariantBuilder requires a resolveLayer(id) function');
    this.registry = registry;
    this.resolveLayer = resolveLayer;
  }

  /**
   * 解析结构：校验 id → 按 stage 排序 → 兼容性检查 → variantKey。
   * 不解析真实 layer / 不合并 GLSL，故很轻量，供 computeVariantKey 与 buildVariant 共用。
   * @returns {{sortedLayerIds:string[], shadingModel:string, variantKey:string}}
   */
  _resolveStructure(input = {}) {
    const layerIds = input.layerIds || [];
    const shadingModel = input.target?.shadingModel || 'pbr';

    if (!Array.isArray(layerIds) || layerIds.length === 0) {
      throw new Error('buildVariant: layerIds must be a non-empty array');
    }
    for (const id of layerIds) {
      if (!this.registry.has(id)) throw new Error(`buildVariant: unknown layer id "${id}" (not registered)`);
    }
    const sortedLayerIds = this.registry.sortByStage(layerIds);
    const compat = this.registry.checkCompatibility(sortedLayerIds);
    if (!compat.ok) {
      const pairs = compat.conflicts.map(([a, b]) => `${a}×${b}`).join(', ');
      throw new Error(`buildVariant: incompatible layers: ${pairs}`);
    }
    const variantKey = `effectVariant:${VARIANT_SCHEMA_VERSION}|layers:${sortedLayerIds.join(',')}|target:${shadingModel}`;
    return { sortedLayerIds, shadingModel, variantKey };
  }

  /**
   * 仅计算 variantKey（结构敏感、参数无关），供缓存 getOrBuild 在不全量 build 时先查表。
   * @returns {string}
   */
  computeVariantKey(input = {}) {
    return this._resolveStructure(input).variantKey;
  }

  /**
   * @param {object} input
   * @param {string[]} input.layerIds
   * @param {Object<string,object>} [input.layerParams]
   * @param {{shadingModel?:string}} [input.target]
   * @returns {object} EffectVariantDescriptor
   */
  buildVariant(input = {}) {
    const layerParams = input.layerParams || {};
    const { sortedLayerIds, shadingModel, variantKey } = this._resolveStructure(input);

    // 解析真实 layer + 合并 GLSL
    const declParts = [];
    const vertexParts = [];
    const normalParts = [];
    const fragmentParts = [];
    const uniformDefaults = {};
    const paramUniformMaps = {};
    const runtimeUniformsSet = new Set(); // 系统/运行时 uniform（uTime…），由 runtime tick，不进 variantKey、不是 param
    const stages = [];
    const channelsSet = new Set();
    const costAcc = { instructions: 'low', textureReads: 0, drawCalls: 0 };
    const instrRank = { low: 0, med: 1, high: 2 };
    const rankInstr = ['low', 'med', 'high'];

    for (const id of sortedLayerIds) {
      const layer = this.resolveLayer(id);
      if (!layer) throw new Error(`buildVariant: resolveLayer("${id}") returned nothing`);

      const decl = layer.getUniformDeclarations?.() || '';
      const vert = layer.getVertexBody?.() || '';
      const normal = layer.getNormalBody?.() || '';
      const frag = layer.getFragmentBody?.() || '';
      if (decl) declParts.push(decl);
      if (vert) vertexParts.push(`// layer: ${id}\n${vert}`);
      if (normal) normalParts.push(`// layer: ${id}\n${normal}`);
      if (frag) fragmentParts.push(`// layer: ${id}\n${frag}`);

      // uniform 默认值（param→glsl 名），叠加 layerParams 覆盖
      const map = layer.getParamUniformMap?.() || {};
      paramUniformMaps[id] = { ...map };
      const defaults = layer.getDefaultUniforms?.() || {};
      const overrides = layerParams[id] || {};
      for (const [paramName, glslName] of Object.entries(map)) {
        const v = overrides[paramName] !== undefined ? overrides[paramName] : defaults[paramName];
        uniformDefaults[glslName] = Array.isArray(v) ? [...v] : v;
      }

      // 运行时 uniform（manifest.requires.uniforms，如 uTime）——由 runtime 每帧 tick，不进 key、不算 param
      const reqUniforms = layer.manifest?.requires?.uniforms || [];
      for (const u of reqUniforms) runtimeUniformsSet.add(u);

      // metadata
      stages.push(layer.stage);
      const ch = layer.manifest?.channels || [];
      for (const c of ch) channelsSet.add(c);
      const cost = layer.manifest?.cost;
      if (cost) {
        if (instrRank[cost.instructions] > instrRank[costAcc.instructions]) costAcc.instructions = cost.instructions;
        costAcc.textureReads += cost.textureReads || 0;
        costAcc.drawCalls += cost.drawCalls || 0;
      }
    }

    void rankInstr; // (保留排名表，未来按 stage 加权时复用)

    return {
      variantKey,
      schemaVersion: VARIANT_SCHEMA_VERSION,
      sortedLayerIds,
      target: { shadingModel },
      uniformDeclarations: dedupeLines(declParts.join('\n')),
      vertexBody: vertexParts.join('\n'),
      normalBody: normalParts.join('\n'),
      fragmentBody: fragmentParts.join('\n'),
      uniformDefaults,
      paramUniformMaps,
      runtimeUniforms: [...runtimeUniformsSet],
      metadata: {
        stages,
        channels: [...channelsSet],
        costs: costAcc,
      },
    };
  }
}
