/**
 * RuntimeIndex — partId(nodeId) ↔ render object / instanceId 映射层
 *
 * 长期约定：VoxelPart 是权威数据，InstancedMesh 只是 RenderCache。
 * 二者之间通过 RuntimeIndex 维持可靠映射，使点击 / 材质覆盖 / 保存加载 /
 * 后续 SelectionProxy 都能基于稳定语义 ID 工作。
 *
 * 术语：本模块 API 形参沿用任务书的 `partId` 命名，但在 scene-builder 中
 * 传入的实际是 **nodeId（`${modelId}:${partId}`）**——这是本代码库里跨模型唯一的
 * 语义 ID（见 buildMeshRegistry / materialOverrides）。renderRef 里同时保存
 * modelId 与原始 partId 字段以便后续使用。
 *
 * V1 范围：只做映射层 + 审计。不实现拖拽、不做动态重分组、不改保存格式。
 */

export class RuntimeIndex {
  constructor() {
    /** @type {Map<string, RuntimeRenderRef>} partId → renderRef */
    this.partToRender = new Map();
    /** @type {Map<string, Set<string>>} batchId → Set<partId> */
    this.batchToParts = new Map();
    /** @type {WeakMap<object, Array<string|null>>} InstancedMesh → [partId by instanceId] */
    this.instanceToPart = new WeakMap();
    /** BatchedMesh object -> Map<internal batchId, partId>. */
    this.batchedMeshToPart = new WeakMap();
    /** @type {WeakMap<object, string>} Object3D → partId */
    this.objectToPart = new WeakMap();
    /** @type {Map<string, RuntimeBatchEntry>} batchId → batch entry */
    this.batchRegistry = new Map();
    /** Changes whenever render-object membership changes. */
    this.renderRevision = 0;

    // ── Group hierarchy (authoritative VoxelPart tree mirror) ──
    // These mirror VoxelModel.parts (parent / isGroup), NOT the render objects.
    // InstancedMesh never replaces this structure — it is only a render cache.
    /** @type {Map<string, string|null>} globalPartId → immediate parent globalGroupId */
    this.partToGroup = new Map();
    /** @type {Map<string, string[]>} globalPartId → ancestor groups [immediate…root] */
    this.partToAncestors = new Map();
    /** @type {Map<string, Set<string>>} globalGroupId → direct child globalIds (parts + subgroups) */
    this.groupToChildren = new Map();
    /** @type {Map<string, Set<string>>} globalGroupId → flattened descendant leaf-mesh globalPartIds */
    this.groupToParts = new Map();
    /** @type {Map<string, {modelId:string, rawGroupId:string, name?:string}>} globalGroupId → metadata */
    this.groupRefs = new Map();
    /** @type {Map<string, number>} modelId → count of parts whose parent ref is missing/non-group */
    this._missingParentGroupsByModel = new Map();
  }

  /** 场景重载 / batch rebuild 前清空索引。重建 WeakMap 引用避免脏数据。 */
  clear() {
    this.partToRender.clear();
    this.batchToParts.clear();
    this.batchRegistry.clear();
    // WeakMap 无法迭代清空，直接重建引用。
    this.instanceToPart = new WeakMap();
    this.batchedMeshToPart = new WeakMap();
    this.objectToPart = new WeakMap();
    // Group hierarchy
    this.partToGroup.clear();
    this.partToAncestors.clear();
    this.groupToChildren.clear();
    this.groupToParts.clear();
    this.groupRefs.clear();
    this._missingParentGroupsByModel.clear();
    this.renderRevision++;
  }

  /**
   * 注册普通 Mesh / fallback Mesh。
   * @param {string} partId  语义 ID（nodeId）
   * @param {object} object  THREE.Object3D
   * @param {object} [options] { modelId, rawPartId, source, mode }
   */
  registerMesh(partId, object, options = {}) {
    if (!partId || !object) return null;
    const mode = options.mode === 'fallback' ? 'fallback' : (options.mode || 'mesh');
    const ref = {
      mode,
      partId,
      modelId: options.modelId ?? object.userData?.sceneModelId ?? null,
      rawPartId: options.rawPartId ?? object.userData?.partId ?? null,
      object,
      batchId: undefined,
      instanceId: undefined,
      batchKey: undefined,
      geometryKey: options.geometryKey,
      materialKey: options.materialKey,
      source: options.source || 'manual-mesh',
    };
    // 若该 partId 之前属于某个 batch，先把它从 batch 映射里摘掉（被降级回普通 Mesh）。
    this._detachPartFromBatch(partId);
    this.partToRender.set(partId, ref);
    this.objectToPart.set(object, partId);
    // 补 userData.partId/nodeId，但不把 userData 当唯一来源。
    if (object.userData) {
      if (!object.userData.partId && ref.rawPartId) object.userData.partId = ref.rawPartId;
      if (!object.userData.nodeId) object.userData.nodeId = partId;
    }
    this.renderRevision++;
    return ref;
  }

  /**
   * 注册一个 InstancedMesh batch。partIds[index] 对应 instanceId=index。
   * @param {string} batchId
   * @param {object} instancedMesh  THREE.InstancedMesh
   * @param {Array<string|null>} partIds
   * @param {object} [options] { source, batchKey, modelId }
   */
  registerInstancedBatch(batchId, instancedMesh, partIds, options = {}) {
    if (!batchId || !instancedMesh || !Array.isArray(partIds)) return null;
    // 若同一 batchId 之前注册过（rebuild），先清掉旧的。
    this._unregisterBatchEntry(batchId);

    const source = options.source || 'static-batcher';
    const batchKey = options.batchKey ?? batchId;
    const slots = new Array(partIds.length).fill(null);
    const partSet = new Set();

    for (let index = 0; index < partIds.length; index++) {
      const partId = partIds[index];
      if (!partId) continue; // 无法映射的实例：保持 null，不报错。
      slots[index] = partId;
      partSet.add(partId);
      // Shared scene-level batches hold parts from multiple models in one mesh,
      // so modelId is derived per-slot from the `${modelId}:${partId}` nodeId
      // prefix. An explicit options.modelId (legacy single-model batch) wins.
      const modelId = options.modelId ?? this._extractModelId(partId);
      this.partToRender.set(partId, {
        mode: 'instanced',
        partId,
        modelId,
        rawPartId: this._extractRawPartId(partId, modelId),
        object: instancedMesh,
        batchId,
        instanceId: index,
        batchKey,
        geometryKey: instancedMesh.userData?.geometryBatchKey,
        materialKey: instancedMesh.userData?.materialBatchKey,
        source,
      });
    }

    this.instanceToPart.set(instancedMesh, slots);
    this.batchToParts.set(batchId, partSet);
    this.batchRegistry.set(batchId, {
      batchId,
      object: instancedMesh,
      partIds: slots.slice(),
      source,
      batchKey,
      // modelId enables model-scoped batch removal (unregisterModelBatches) for
      // in-place model rebuild. Shared scene-level batches pass no modelId → null.
      modelId: options.modelId ?? null,
    });

    // 标记 instancedMesh，便于 rebuildFromScene 兜底扫描。
    if (instancedMesh.userData) {
      instancedMesh.userData.isPrimitiveBatch = true;
      instancedMesh.userData.batchId = batchId;
      instancedMesh.userData.runtimeIndexSource = source;
    }
    this.renderRevision++;
    return this.batchRegistry.get(batchId);
  }

  /**
   * Register one THREE.BatchedMesh material bucket. `idToPart` maps
   * intersection.batchId values from BatchedMesh.raycast() to global part ids.
   */
  registerBatchedMesh(batchId, batchedMesh, idToPart, options = {}) {
    if (!batchId || !batchedMesh || !idToPart) return null;
    this._unregisterBatchEntry(batchId);

    const source = options.source || 'ai-primitive-batched-mesh';
    const batchKey = options.batchKey ?? batchId;
    const map = idToPart instanceof Map
      ? new Map(idToPart)
      : new Map(Array.isArray(idToPart) ? idToPart : Object.entries(idToPart).map(([k, v]) => [Number(k), v]));
    const slots = [];
    const partSet = new Set();

    for (const [geometryId, partId] of map) {
      if (!partId || !Number.isInteger(geometryId) || geometryId < 0) continue;
      slots[geometryId] = partId;
      partSet.add(partId);
      const modelId = options.modelId ?? this._extractModelId(partId);
      this.partToRender.set(partId, {
        mode: 'batched',
        partId,
        modelId,
        rawPartId: this._extractRawPartId(partId, modelId),
        object: batchedMesh,
        batchId,
        geometryId,
        batchKey,
        geometryKey: batchedMesh.userData?.geometryBatchKey,
        materialKey: batchKey,
        source,
      });
    }

    this.batchedMeshToPart.set(batchedMesh, map);
    this.batchToParts.set(batchId, partSet);
    this.batchRegistry.set(batchId, {
      batchId,
      object: batchedMesh,
      partIds: slots.slice(),
      source,
      batchKey,
      modelId: options.modelId ?? null,
      mode: 'batched',
    });

    if (batchedMesh.userData) {
      batchedMesh.userData.isPrimitiveBatch = true;
      batchedMesh.userData.isBatchedPrimitiveGroup = true;
      batchedMesh.userData.batchId = batchId;
      batchedMesh.userData.runtimeIndexSource = source;
    }
    this.renderRevision++;
    return this.batchRegistry.get(batchId);
  }

  // ────────────────────────── Group hierarchy ──────────────────────────

  /**
   * Mirror a VoxelModel's part tree (parent / isGroup) into the group maps.
   * Source of truth is VoxelModel.parts — independent of batching. Call after
   * every buildModel / rebuildModelRenderCache for the model.
   *
   * Re-registration purges this model's prior entries first so removed parts /
   * regroupings never leave stale refs. Keys are globalIds (`${modelId}:${id}`).
   *
   * @param {string} modelId
   * @param {{parts: Array<{id:string, parent?:string|null, isGroup?:boolean, mesh?:object, name?:string}>}} model
   * @returns {{groupCount:number, groupedPartCount:number, missingParentGroups:number}|null}
   */
  registerHierarchy(modelId, model) {
    if (!modelId || !model || !Array.isArray(model.parts)) return null;
    this._purgeModelHierarchy(modelId);

    const gid = (id) => `${modelId}:${id}`;
    const parts = model.parts;
    const byId = new Map();
    for (const p of parts) byId.set(p.id, p);

    // 1) Register group refs (and seed their child/leaf sets).
    for (const p of parts) {
      if (!p.isGroup) continue;
      const g = gid(p.id);
      this.groupRefs.set(g, { modelId, rawGroupId: p.id, name: p.name || p.id });
      if (!this.groupToChildren.has(g)) this.groupToChildren.set(g, new Set());
      if (!this.groupToParts.has(g)) this.groupToParts.set(g, new Set());
    }

    // 2) Immediate parent group + direct children.
    let missingParentGroups = 0;
    for (const p of parts) {
      const selfG = gid(p.id);
      if (!p.parent) { this.partToGroup.set(selfG, null); continue; }
      const parentPart = byId.get(p.parent);
      if (parentPart && parentPart.isGroup) {
        const pg = gid(p.parent);
        this.partToGroup.set(selfG, pg);
        let kids = this.groupToChildren.get(pg);
        if (!kids) { kids = new Set(); this.groupToChildren.set(pg, kids); }
        kids.add(selfG);
      } else {
        // parent references a non-group part, or an id with no matching part.
        if (!parentPart) missingParentGroups++;
        this.partToGroup.set(selfG, null);
      }
    }

    // 3) Ancestor chain (immediate→root) + flatten leaf-mesh parts into ancestors.
    for (const p of parts) {
      const selfG = gid(p.id);
      const chain = [];
      const visited = new Set();
      let cur = p.parent;
      while (cur) {
        if (visited.has(cur)) break; // cycle guard
        visited.add(cur);
        const cp = byId.get(cur);
        if (!cp) break;
        if (cp.isGroup) chain.push(gid(cur));
        cur = cp.parent;
      }
      this.partToAncestors.set(selfG, chain);
      if (!p.isGroup && p.mesh) {
        for (const ancG of chain) {
          let set = this.groupToParts.get(ancG);
          if (!set) { set = new Set(); this.groupToParts.set(ancG, set); }
          set.add(selfG);
        }
      }
    }

    this._missingParentGroupsByModel.set(modelId, missingParentGroups);
    return {
      groupCount: [...this.groupRefs.keys()].filter(k => k.startsWith(`${modelId}:`)).length,
      groupedPartCount: this.partToGroup.size,
      missingParentGroups,
    };
  }

  /** Remove all hierarchy entries belonging to a model (by globalId prefix). */
  _purgeModelHierarchy(modelId) {
    const prefix = `${modelId}:`;
    const purge = (map) => { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); };
    purge(this.partToGroup);
    purge(this.partToAncestors);
    purge(this.groupToChildren);
    purge(this.groupToParts);
    purge(this.groupRefs);
    this._missingParentGroupsByModel.delete(modelId);
  }

  /** @returns {string|null} immediate parent group globalId for a part. */
  getGroupIdForPart(globalPartId) {
    return this.partToGroup.get(globalPartId) ?? null;
  }

  /** @returns {string[]} ancestor group globalIds [immediate…root]. */
  getAncestorGroups(globalPartId) {
    return this.partToAncestors.get(globalPartId) ?? [];
  }

  /** @returns {string[]} direct child globalIds (parts + subgroups) of a group. */
  getGroupChildren(globalGroupId) {
    const set = this.groupToChildren.get(globalGroupId);
    return set ? [...set] : [];
  }

  /** @returns {string[]} flattened descendant leaf-mesh globalPartIds of a group. */
  getGroupLeafParts(globalGroupId) {
    const set = this.groupToParts.get(globalGroupId);
    return set ? [...set] : [];
  }

  /** @returns {{modelId:string, rawGroupId:string, name?:string}|null} */
  getGroupRef(globalGroupId) {
    return this.groupRefs.get(globalGroupId) ?? null;
  }

  /** 移除某个 part 的映射。 */
  unregisterPart(partId) {
    if (!partId) return;
    const ref = this.partToRender.get(partId);
    this.partToRender.delete(partId);
    this._detachPartFromBatch(partId);
    if (!ref) return;
    if (ref.mode === 'instanced' && ref.object) {
      const slots = this.instanceToPart.get(ref.object);
      if (slots && Number.isInteger(ref.instanceId) && slots[ref.instanceId] === partId) {
        slots[ref.instanceId] = null;
      }
    } else if (ref.mode === 'batched' && ref.object) {
      const slots = this.batchedMeshToPart.get(ref.object);
      if (slots && Number.isInteger(ref.geometryId) && slots.get(ref.geometryId) === partId) {
        slots.delete(ref.geometryId);
      }
    } else if (ref.object && ref.object.userData) {
      // WeakMap 无法直接 delete 旧 object 的反查；清 userData 标记，audit 时忽略。
      if (ref.object.userData.nodeId === partId) delete ref.object.userData.nodeId;
    }
    this.renderRevision++;
  }

  /**
   * 清理已失效的 batch（其 InstancedMesh 已从场景移除 / 被 dispose）。
   * 用于 in-place rebuild 后，消除消失分组留下的 orphan batch 引用。
   * @returns {number} 清理的 batch 数
   */
  pruneDisposedBatches() {
    let pruned = 0;
    for (const [batchId, entry] of [...this.batchRegistry]) {
      const obj = entry.object;
      if (obj && obj.parent != null) continue; // 仍在场景树中
      this._unregisterBatchEntry(batchId);
      pruned++;
    }
    return pruned;
  }

  /** @returns {RuntimeRenderRef|null} */
  getRenderRef(partId) {
    if (!partId) return null;
    const ref = this.partToRender.get(partId);
    if (!ref) return null;
    const rawPartId = ref.rawPartId ?? this._extractRawPartId(partId, ref.modelId);
    return {
      mode: ref.mode,
      object: ref.object,
      batchId: ref.batchId,
      instanceId: ref.instanceId,
      geometryId: ref.geometryId,
      batchKey: ref.batchKey,
      modelId: ref.modelId,
      rawPartId,
      source: ref.source,
      // ── Phase 2 hybrid render cache additions ──
      globalPartId: partId,
      partId: rawPartId,
      material: ref.object?.material ?? null,
      // instanceColor path only exists for shared InstancedMesh batches; any
      // non-instanced render mode (mesh/extracted/fallback/special) is an
      // independent Mesh that can take an arbitrary complex material.
      canUseInstanceColor: ref.mode === 'instanced',
      canUseComplexMaterial: ref.mode !== 'instanced' && ref.mode !== 'batched',
    };
  }

  /**
   * Remove all InstancedMesh batches belonging to a model (optionally filtered
   * by source), demoting their parts out of the partToRender map. Used by
   * model-scoped in-place rebuild so a forced-extracted part's old batch is gone.
   * @param {string} modelId
   * @param {string|null} [source] only remove batches from this source when set
   * @returns {number} count of batches removed
   */
  unregisterModelBatches(modelId, source = null) {
    let removed = 0;
    for (const [batchId, entry] of [...this.batchRegistry]) {
      if (entry.modelId !== modelId) continue;
      if (source && entry.source !== source) continue;
      this._unregisterBatchEntry(batchId);
      removed += 1;
    }
    return removed;
  }

  /** Remove every batch registered by a given source. */
  unregisterBatchesBySource(source) {
    if (!source) return 0;
    let removed = 0;
    for (const [batchId, entry] of [...this.batchRegistry]) {
      if (entry.source !== source) continue;
      this._unregisterBatchEntry(batchId);
      removed += 1;
    }
    return removed;
  }

  /**
   * 本任务最关键 API：raycast hit → partId。
   * 不抛异常；映射不到统一返回 null。
   */
  getPartIdFromHit(hit) {
    const object = hit?.object;
    if (!object) return null;

    if (object.isInstancedMesh) {
      const instanceId = hit.instanceId;
      if (!Number.isInteger(instanceId) || instanceId < 0) return null;
      const slots = this.instanceToPart.get(object);
      if (!slots) return null;
      if (instanceId >= slots.length) return null;
      return slots[instanceId] ?? null;
    }

    if (object.isBatchedMesh || object.userData?.isBatchedPrimitiveGroup) {
      const batchId = hit.batchId;
      if (!Number.isInteger(batchId) || batchId < 0) return null;
      const slots = this.batchedMeshToPart.get(object);
      if (!slots) return null;
      return slots.get(batchId) ?? null;
    }

    // 普通 Mesh：先查 objectToPart，再沿对象/父链兜底。
    const direct = this.objectToPart.get(object);
    if (direct) return direct;
    return this._findPartIdFromObjectChain(object);
  }

  /** 兜底：扫描 scene 中已有 userData 标记的对象，重建索引（不应作为主路径）。 */
  rebuildFromScene(scene) {
    this.clear();
    if (!scene || typeof scene.traverse !== 'function') return this;
    scene.traverse(object => {
      if (object.isInstancedMesh && object.userData?.isPrimitiveBatch) {
        const slots = this.instanceToPart.get(object);
        if (slots) return; // 已在内存中
        // 无法从场景恢复 partIds（未持久化），仅标记 batchRegistry 占位。
        const batchId = object.userData.batchId || object.uuid;
        this.batchRegistry.set(batchId, {
          batchId,
          object,
          partIds: [],
          source: object.userData.runtimeIndexSource || 'rebuild-from-scene',
          batchKey: object.userData.batchKey,
        });
        this.batchToParts.set(batchId, new Set());
        return;
      }
      if (object.isMesh && !object.isInstancedMesh) {
        const partId = object.userData?.nodeId || object.userData?.partId;
        if (!partId) return;
        this.registerMesh(partId, object, {
          modelId: object.userData?.sceneModelId,
          rawPartId: object.userData?.partId,
          source: 'rebuild-from-scene',
          mode: 'mesh',
        });
      }
    });
    return this;
  }

  /**
   * 为材质覆盖提供当前渲染目标（为 V4 动态重分组留接口）。
   * @returns {{type:'instance'|'mesh', object, instanceId?, partId}|null}
   */
  resolveMaterialTarget(partId) {
    const ref = this.getRenderRef(partId);
    if (!ref) return null;
    if (ref.mode === 'instanced') {
      return { type: 'instance', object: ref.object, instanceId: ref.instanceId, partId };
    }
    if (ref.mode === 'batched') {
      return { type: 'batched', object: ref.object, geometryId: ref.geometryId, partId };
    }
    return { type: 'mesh', object: ref.object, partId };
  }

  // ────────────────────────── 审计 ──────────────────────────

  /** 全量审计；返回统计对象。 */
  audit({ table = false } = {}) {
    let instancedPartCount = 0;
    let batchedPartCount = 0;
    let meshPartCount = 0;
    let fallbackPartCount = 0;
    let specialPartCount = 0;
    let extractedPartCount = 0;
    let extractedObjectRefs = 0;
    let orphanRenderRefs = 0;
    let disposedObjectRefs = 0;
    let invalidInstanceIds = 0;
    let staleInstancedRefs = 0;

    for (const [partId, ref] of this.partToRender) {
      switch (ref.mode) {
        case 'instanced': instancedPartCount++; break;
        case 'batched': batchedPartCount++; break;
        case 'fallback': fallbackPartCount++; break;
        case 'special': specialPartCount++; break;
        case 'extracted': extractedPartCount++; break;
        default: meshPartCount++; break;
      }
      if (ref.mode === 'extracted' && ref.object) extractedObjectRefs++;
      if (!ref.object) { orphanRenderRefs++; continue; }
      if (this._looksDisposed(ref.object, ref.mode)) disposedObjectRefs++;
      if (ref.mode === 'instanced') {
        const slots = this.instanceToPart.get(ref.object);
        if (!slots
          || !Number.isInteger(ref.instanceId)
          || ref.instanceId < 0
          || ref.instanceId >= slots.length
          || slots[ref.instanceId] !== partId) {
          invalidInstanceIds++;
          staleInstancedRefs++;
        }
      } else if (ref.mode === 'batched') {
        const slots = this.batchedMeshToPart.get(ref.object);
        if (!slots
          || !Number.isInteger(ref.geometryId)
          || slots.get(ref.geometryId) !== partId) {
          invalidInstanceIds++;
        }
      }
      void partId;
    }

    // batch 维度统计
    let nullInstanceRefs = 0;
    let missingPartRefs = 0;
    let orphanBatchParts = 0;
    const partSeenInBatch = new Map();
    let duplicatePartRefs = 0;

    for (const [batchId, entry] of this.batchRegistry) {
      const slots = this.instanceToPart.get(entry.object) || entry.partIds || [];
      for (const partId of slots) {
        if (partId == null) { nullInstanceRefs++; continue; }
        const seen = partSeenInBatch.get(partId);
        if (seen !== undefined && seen !== batchId) duplicatePartRefs++;
        else partSeenInBatch.set(partId, batchId);

        const ref = this.partToRender.get(partId);
        if (!ref) { missingPartRefs++; continue; }
        if ((ref.mode === 'instanced' || ref.mode === 'batched') && ref.batchId !== batchId) orphanBatchParts++;
      }
    }

    // batchToParts ↔ partToRender 一致性
    for (const [batchId, set] of this.batchToParts) {
      for (const partId of set) {
        const ref = this.partToRender.get(partId);
        if (!ref || ((ref.mode === 'instanced' || ref.mode === 'batched') && ref.batchId !== batchId)) orphanBatchParts++;
      }
    }

    const hier = this._computeHierarchyStats();

    const result = {
      partToRenderCount: this.partToRender.size,
      batchCount: this.batchRegistry.size,
      batchToPartsCount: this.batchToParts.size,
      instancedPartCount,
      batchedPartCount,
      meshPartCount,
      fallbackPartCount,
      specialPartCount,
      extractedPartCount,
      extractedObjectRefs,
      missingPartRefs,
      duplicatePartRefs,
      invalidInstanceIds,
      staleInstancedRefs,
      nullInstanceRefs,
      orphanBatchParts,
      orphanRenderRefs,
      disposedObjectRefs,
      // ── Group hierarchy ──
      groupCount: hier.groupCount,
      groupedPartCount: hier.groupedPartCount,
      orphanGroupRefs: hier.orphanGroupRefs,
      missingParentGroups: hier.missingParentGroups,
    };

    const lines = ['[RuntimeIndexAudit]'];
    for (const [k, v] of Object.entries(result)) lines.push(`${k}=${v}`);
    console.log(lines.join('\n'));
    if (table && typeof console.table === 'function') console.table(result);
    return result;
  }

  /** 某个 batch 内部映射审计。 */
  auditBatch(batchId) {
    const entry = this.batchRegistry.get(batchId);
    if (!entry) {
      console.warn(`[BatchPartAudit] batchId=${batchId} NOT FOUND`);
      return null;
    }
    const slots = this.instanceToPart.get(entry.object) || entry.partIds || [];
    const seen = new Set();
    let nullSlots = 0;
    let duplicatePartIds = 0;
    let invalidPartToRenderRefs = 0;
    for (let i = 0; i < slots.length; i++) {
      const partId = slots[i];
      if (partId == null) { nullSlots++; continue; }
      if (seen.has(partId)) duplicatePartIds++; else seen.add(partId);
      const ref = this.partToRender.get(partId);
      if (!ref || (ref.mode !== 'instanced' && ref.mode !== 'batched') || ref.batchId !== batchId
        || (ref.mode === 'instanced' && ref.instanceId !== i)
        || (ref.mode === 'batched' && ref.geometryId !== i)) {
        invalidPartToRenderRefs++;
      }
    }
    const result = {
      batchId,
      objectName: entry.object?.name || '',
      count: entry.object?.count ?? slots.length,
      partIdsLength: slots.length,
      first10PartIds: slots.slice(0, 10),
      nullSlots,
      duplicatePartIds,
      invalidPartToRenderRefs,
    };
    console.log(
      `[BatchPartAudit]\nbatchId=${result.batchId}\nobjectName=${result.objectName}` +
      `\ncount=${result.count}\npartIds.length=${result.partIdsLength}` +
      `\nfirst10PartIds=${JSON.stringify(result.first10PartIds)}` +
      `\nnullSlots=${result.nullSlots}\nduplicatePartIds=${result.duplicatePartIds}` +
      `\ninvalidPartToRenderRefs=${result.invalidPartToRenderRefs}`
    );
    return result;
  }

  /** 单次 hit 审计。 */
  auditHit(hit) {
    const object = hit?.object || null;
    const resolvedPartId = this.getPartIdFromHit(hit);
    const ref = resolvedPartId ? this.getRenderRef(resolvedPartId) : null;
    const result = {
      hitObjectName: object?.name || '',
      isInstancedMesh: !!object?.isInstancedMesh,
      instanceId: Number.isInteger(hit?.instanceId) ? hit.instanceId : null,
      resolvedPartId: resolvedPartId ?? null,
      renderRefMode: ref?.mode ?? null,
      batchId: ref?.batchId ?? null,
      objectMatches: !!ref && ref.object === object,
    };
    console.log(
      `[HitPartAudit]\nhitObjectName=${result.hitObjectName}` +
      `\nisInstancedMesh=${result.isInstancedMesh}\ninstanceId=${result.instanceId}` +
      `\nresolvedPartId=${result.resolvedPartId}\nrenderRefMode=${result.renderRefMode}` +
      `\nbatchId=${result.batchId}\nobjectMatches=${result.objectMatches}`
    );
    return result;
  }

  /**
   * Group-hierarchy audit (point 12 surface + per-model breakdown).
   * @param {{table?: boolean}} [opts]
   */
  auditHierarchy({ table = false } = {}) {
    const stats = this._computeHierarchyStats();
    const perModel = {};
    for (const [g, ref] of this.groupRefs) {
      const m = ref.modelId || g.split(':')[0];
      const e = perModel[m] || (perModel[m] = { groups: 0, leafParts: 0 });
      e.groups++;
      e.leafParts += (this.groupToParts.get(g)?.size || 0);
    }
    const result = {
      groupCount: stats.groupCount,
      groupedPartCount: stats.groupedPartCount,
      orphanGroupRefs: stats.orphanGroupRefs,
      missingParentGroups: stats.missingParentGroups,
      partToGroupCount: this.partToGroup.size,
      partToAncestorsCount: this.partToAncestors.size,
      groupToChildrenCount: this.groupToChildren.size,
      groupToPartsCount: this.groupToParts.size,
      perModel,
      sampleGroups: [...this.groupRefs.keys()].slice(0, 10),
    };
    const lines = ['[GroupHierarchyAudit]'];
    for (const [k, v] of Object.entries(result)) {
      lines.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    console.log(lines.join('\n'));
    if (table && typeof console.table === 'function') console.table(perModel);
    return result;
  }

  /**
   * Compute group-hierarchy stats from the maps alone (no model reference).
   * @returns {{groupCount:number, groupedPartCount:number, orphanGroupRefs:number, missingParentGroups:number}}
   */
  _computeHierarchyStats() {
    const groupCount = this.groupRefs.size;

    // groupedPartCount = distinct leaf-mesh parts that belong to ≥1 group.
    const groupedLeaves = new Set();
    for (const set of this.groupToParts.values()) {
      for (const pid of set) groupedLeaves.add(pid);
    }

    // orphanGroupRefs = group ids referenced by part/child maps but missing from groupRefs.
    let orphanGroupRefs = 0;
    const seenOrphan = new Set();
    const checkOrphan = (g) => {
      if (g == null || this.groupRefs.has(g) || seenOrphan.has(g)) return;
      seenOrphan.add(g);
      orphanGroupRefs++;
    };
    for (const g of this.partToGroup.values()) checkOrphan(g);
    for (const chain of this.partToAncestors.values()) for (const g of chain) checkOrphan(g);
    for (const g of this.groupToChildren.keys()) checkOrphan(g);
    for (const g of this.groupToParts.keys()) checkOrphan(g);

    let missingParentGroups = 0;
    for (const n of this._missingParentGroupsByModel.values()) missingParentGroups += (n || 0);

    return { groupCount, groupedPartCount: groupedLeaves.size, orphanGroupRefs, missingParentGroups };
  }

  // ────────────────────────── 内部 ──────────────────────────

  _detachPartFromBatch(partId) {
    for (const [batchId, set] of this.batchToParts) {
      if (set.has(partId)) {
        set.delete(partId);
        const entry = this.batchRegistry.get(batchId);
        if (entry?.object) {
          const slots = this.instanceToPart.get(entry.object);
          if (slots) {
            const idx = slots.indexOf(partId);
            if (idx !== -1) slots[idx] = null;
          }
          const batchedSlots = this.batchedMeshToPart.get(entry.object);
          if (batchedSlots) {
            for (const [id, mappedPartId] of batchedSlots) {
              if (mappedPartId === partId) batchedSlots.delete(id);
            }
          }
        }
      }
    }
  }

  _unregisterBatchEntry(batchId) {
    const entry = this.batchRegistry.get(batchId);
    if (!entry) return;
    const set = this.batchToParts.get(batchId);
    if (set) {
      for (const partId of set) {
        const ref = this.partToRender.get(partId);
        if (ref && (ref.mode === 'instanced' || ref.mode === 'batched') && ref.batchId === batchId) {
          this.partToRender.delete(partId);
        }
      }
    }
    if (entry.object) this.instanceToPart.delete(entry.object);
    if (entry.object) this.batchedMeshToPart.delete(entry.object);
    this.batchToParts.delete(batchId);
    this.batchRegistry.delete(batchId);
    this.renderRevision++;
  }

  _findPartIdFromObjectChain(object) {
    let current = object;
    while (current) {
      const known = this.objectToPart.get(current);
      if (known) return known;
      const fromUserData = current.userData?.nodeId || current.userData?.partId;
      if (fromUserData && this.partToRender.has(fromUserData)) return fromUserData;
      current = current.parent;
    }
    return null;
  }

  /** @returns {string|null} modelId prefix of a `${modelId}:${partId}` nodeId. */
  _extractModelId(nodeId) {
    const idx = nodeId?.indexOf(':') ?? -1;
    return idx > 0 ? nodeId.slice(0, idx) : null;
  }

  _extractRawPartId(nodeId, modelId) {
    if (!nodeId) return null;
    if (modelId && nodeId.startsWith(`${modelId}:`)) return nodeId.slice(modelId.length + 1);
    const idx = nodeId.indexOf(':');
    return idx === -1 ? nodeId : nodeId.slice(idx + 1);
  }

  _looksDisposed(object, mode) {
    if (!object) return true;
    if (mode === 'instanced') return false; // batchMesh 在 batchRoot 下，正常
    // 普通 mesh：从场景里被移除（clearAll dispose）后 parent 为 null。
    return object.parent == null && object.isScene !== true;
  }
}

/**
 * @typedef {Object} RuntimeRenderRef
 * @property {'mesh'|'instanced'|'batched'|'special'|'fallback'|'extracted'} mode
 * @property {string} partId
 * @property {string|null} [modelId]
 * @property {string|null} [rawPartId]
 * @property {object} object
 * @property {string} [batchId]
 * @property {number} [instanceId]
 * @property {number} [geometryId]
 * @property {string} [batchKey]
 * @property {string} [geometryKey]
 * @property {string} [materialKey]
 * @property {string} [source]
 */

/**
 * @typedef {Object} RuntimeBatchEntry
 * @property {string} batchId
 * @property {object} object
 * @property {Array<string|null>} partIds
 * @property {string} source
 * @property {string} [batchKey]
 */

export default RuntimeIndex;
