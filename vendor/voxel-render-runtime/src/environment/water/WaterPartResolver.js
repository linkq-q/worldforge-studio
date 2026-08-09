/**
 * WaterPartResolver.js — 水体部件标记解析层（Water v4 Phase 0）
 *
 * 单一解析入口，合并三个水体标记来源，输出去重后的 { id, kind }。下游只认它的输出。
 *   来源 A：Material Tags v1 的 { tag: 'water', value: 'pool'|'fall' }（组标签继承）
 *   来源 B：旧 mesh.water === true（兼容为 pool）
 *   来源 C：场景 JSON sidecar（"modelId:partId" 或 "modelId:partId:fall"）
 *
 * globalPartId 天然带 modelId 命名空间，避免跨模型 partId 碰撞。传入 modelId 时按其过滤，
 * 只返回该模型的裸 partId；不传 modelId 时返回全部（globalPartId 去掉前缀）。
 */

/**
 * @param {object|null} modelJson - 模型 JSON（含 nodes[]），可空
 * @param {string[]} [sidecarWaterPartIds] - 场景 sidecar 手动标记（globalPartId 或裸 partId）
 * @param {string|null} [modelId] - 只保留该模型的标记（null = 不过滤）
 * @returns {{ id: string, kind: 'pool'|'fall' }[]} 去重后的裸 partId + kind
 */
export function resolveWaterParts(modelJson, sidecarWaterPartIds = [], modelId = null) {
  const byId = new Map();
  const add = (id, kind = 'pool') => {
    if (!id) return;
    // Explicit fall wins over the backwards-compatible pool aliases.
    if (!byId.has(id) || kind === 'fall') byId.set(id, kind === 'fall' ? 'fall' : 'pool');
  };

  const parts = Array.isArray(modelJson?.parts)
    ? modelJson.parts
    : Array.isArray(modelJson?.nodes) ? modelJson.nodes : [];
  const partsById = new Map(parts.map(part => [part?.id, part]));
  const effectiveWaterKind = (part, visiting = new Set()) => {
    if (!part?.id || visiting.has(part.id)) return null;
    visiting.add(part.id);
    let kind = part.parent ? effectiveWaterKind(partsById.get(part.parent), visiting) : null;
    for (const entry of part.tags || []) {
      if (entry?.tag === 'water' && (entry.value === 'pool' || entry.value === 'fall')) kind = entry.value;
    }
    visiting.delete(part.id);
    return kind;
  };

  // 来源 A/B：Material Tags v1 first, legacy mesh.water second.
  for (const part of parts) {
    const kind = effectiveWaterKind(part);
    if (kind && part?.mesh) add(part.id, kind);
    else if (part?.mesh?.water === true) add(part.id, 'pool');
  }

  // 来源 B：手动标记 sidecar
  for (const gid of sidecarWaterPartIds || []) {
    if (typeof gid !== 'string' || !gid) continue;
    const sep = gid.indexOf(':');
    if (sep >= 0) {
      const mid = gid.slice(0, sep);
      const rest = gid.slice(sep + 1);
      const kindSuffix = rest.lastIndexOf(':');
      const pid = kindSuffix >= 0 ? rest.slice(0, kindSuffix) : rest;
      const kind = kindSuffix >= 0 && rest.slice(kindSuffix + 1) === 'fall' ? 'fall' : 'pool';
      if (modelId == null || mid === modelId) add(pid, kind);
    } else {
      // 裸 partId（无 model 前缀）：无从判断归属，直接收下
      add(gid);
    }
  }

  return [...byId].map(([id, kind]) => ({ id, kind }));
}
