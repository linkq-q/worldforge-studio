/**
 * AIPrimitiveBatcher — source-level InstancedMesh compilation from VoxelPart data.
 *
 * Scene-level batching: the batcher owns ONE RenderCache whose batches are shared
 * across every model in the scene. Each batch's InstancedMesh holds instances from
 * any number of models, composed in WORLD space from each model root's matrixWorld.
 * Two identical models at different positions therefore live in a single batch
 * instead of doubling the batch count.
 *
 * Architecture:
 *   VoxelPart[] → assessPart() → group by batchKey → shared RenderCache → InstancedMesh
 *   → RuntimeIndex.registerInstancedBatch() (complete shared slot array per batch)
 *
 * Non-batchable parts continue through VoxelRenderer._buildMeshPart (fallback Mesh).
 *
 * KEY CONVENTION: all RuntimeIndex keys use globalPartId = `${modelId}:${part.id}`.
 * Bare part.id is never used as a RuntimeIndex key. The RuntimeIndex batchId is the
 * bare batchKey (shared); per-slot modelId is derived from the globalPartId prefix.
 */

import * as THREE from 'three';
import { DEFAULT_PBR_METALNESS, DEFAULT_PBR_ROUGHNESS } from '../materials/MaterialDefaults.js';
import { RenderCache } from './RenderCache.js';
import { BatchedPrimitiveGroup } from './BatchedPrimitiveGroup.js';
import {
  assessPart,
  makeBatchKey,
  makeMaterialKey,
  computeInstanceMatrix,
} from './PrimitiveFamily.js';
import { splitGlobalPartId } from './RenderOverrideStore.js';
import { buildTriangleGeometry, buildPatchGeometry } from './PrimitiveGeometryBuilders.js';

export class AIPrimitiveBatcher {
  /**
   * @param {object} options
   * @param {import('../runtime/RuntimeIndex.js').RuntimeIndex} [options.runtimeIndex]
   * @param {Function} [options.getRenderMode] — () => 'pbr' | 'cel' | ... (SCENE mode)
   * @param {import('./RenderOverrideStore.js').RenderOverrideStore} [options.renderOverrideStore]
   *        Stable per-part extraction policy. A part marked extracted is kept OUT
   *        of the shared InstancedMesh batch and built as an independent Mesh so it
   *        can carry a complex material (emissive / glass / shader / matcap / …).
   * @param {Function} [options.rebuildModel] — (modelId) => rebuild audit. Lets
   *        extractPart() trigger a model-scoped render-cache rebuild.
   * @param {number} [options.maxBatchCapacity]
   */
  constructor(options = {}) {
    this.runtimeIndex = options.runtimeIndex || null;
    this.getRenderMode = typeof options.getRenderMode === 'function'
      ? options.getRenderMode
      : () => 'pbr';
    this.renderOverrideStore = options.renderOverrideStore || null;
    this.rebuildModel = typeof options.rebuildModel === 'function'
      ? options.rebuildModel
      : null;
    // Cel batching: opt-in per app. Only enable where a cel-patch applier exists
    // for the batch InstancedMesh materials (scene-builder), else cel scenes would
    // batch into un-patched PBR meshes. Default off keeps js/main runtime unchanged.
    this.celBatchEnabled = options.celBatchable === true;
    // Fired with (batchMaterial, sourceMaterial) right after a NEW batch material
    // is created in compile(). Lets the host patch it (e.g. install the cel shader).
    this.onBatchMaterialReady = typeof options.onBatchMaterialReady === 'function'
      ? options.onBatchMaterialReady
      : null;
    // BatchedMesh path for tri/patch (arbitrary-vertex parts). Opt-in per host;
    // default off keeps tri/patch falling back to independent meshes as before.
    this.batchedMeshEnabled = options.batchedMeshable === true;

    /**
     * The single scene-level RenderCache. All models share its batches.
     * @type {RenderCache|null}
     */
    this._sceneCache = null;

    /**
     * Scene-level BatchedMesh group for tri/patch parts (parallel to _sceneCache).
     * @type {BatchedPrimitiveGroup|null}
     */
    this._batchedGroup = null;

    /**
     * modelId → Set<globalPartId> for parts living in _batchedGroup (so a model's
     * BatchedMesh parts can be removed / re-placed on transform, like _modelToSlots).
     * @type {Map<string, Set<string>>}
     */
    this._modelToBatchedParts = new Map();

    /**
     * The scene-level shared root (a THREE.Group owned by SceneManager) under
     * which every shared InstancedMesh is attached. Identity transform.
     * @type {THREE.Object3D|null}
     */
    this._sharedBatchRoot = null;

    /**
     * modelId → Map<globalPartId, {batchKey, instanceId}>.
     * Tracks which shared slots each model currently occupies so a model can be
     * transformed or removed without touching the others.
     * @type {Map<string, Map<string, {batchKey:string, instanceId:number}>>}
     */
    this._modelToSlots = new Map();

    /**
     * Retained matrix source records, keyed by globalPartId, so a model's
     * instances can be recomputed in world space on transform.
     * @type {Map<string, {globalPartId:string, modelId:string, part:object, family:object, scale:object, batchKey:string, parentChainMatrix:object|null, rootGroup:object|null}>}
     */
    this._partRecords = new Map();

    /**
     * modelId → latest CompileAudit. Replacing a model's audit on rebuild keeps
     * getSceneAudit() from double-counting it.
     * @type {Map<string, CompileAudit>}
     */
    this._modelAudits = new Map();

    this.maxBatchCapacity = options.maxBatchCapacity || 65536;

    /**
     * Staged parts awaiting compilation.
     * Key = globalPartId (`${modelId}:${part.id}`), NOT bare part.id.
     */
    this._pendingParts = new Map();

    /** Latest compile audit (for quick inspection). */
    this.lastCompileAudit = null;

    /**
     * Unsupported-reason tally for the current model build (reset() clears it).
     * @type {Object<string, number>}
     */
    this._unsupportedReasons = {};
  }

  /**
   * Reset per-model staging state. Call before processing each model.
   */
  reset() {
    this._pendingParts.clear();
    this._unsupportedReasons = {};
  }

  /**
   * Record a part that was assessed as NOT batchable (for audit reporting).
   * @param {string} reason — e.g. 'unsupported-family:wedge', 'transparent'
   */
  recordUnsupported(reason) {
    const key = reason || 'unknown';
    this._unsupportedReasons[key] = (this._unsupportedReasons[key] || 0) + 1;
  }

  /**
   * Reset scene-level state and (re)create the single shared cache.
   * @param {THREE.Object3D} [sharedBatchRoot] — defaults to the current root.
   */
  resetScene(sharedBatchRoot = null) {
    const nextRoot = sharedBatchRoot || this._sharedBatchRoot;
    this.dispose();
    this._sharedBatchRoot = nextRoot;
    this._sceneCache = new RenderCache();
    this._batchedGroup = new BatchedPrimitiveGroup({
      sharedRoot: nextRoot,
      onMaterialReady: this.onBatchMaterialReady,
    });
    if (nextRoot) this._sceneCache.attachToSharedRoot(nextRoot);
  }

  /** @returns {RenderCache|null} the shared scene cache. */
  getSceneCache() { return this._sceneCache; }

  /** @returns {RenderCache|null} alias for getSceneCache (debug compatibility). */
  getCache() { return this._sceneCache; }

  /**
   * Check if a VoxelPart can be batched by AIPrimitiveBatcher.
   * A part with an active extraction policy is force-excluded so it falls through
   * to VoxelRenderer's independent-Mesh path.
   * @param {object} part — VoxelPart
   * @param {object} [opts] { modelId, celAllowed }
   * @returns {{ eligible: boolean, reason?: string, extracted?: boolean }}
   */
  canBatch(part, opts = {}) {
    const globalPartId = opts.modelId && part?.id ? `${opts.modelId}:${part.id}` : null;
    if (globalPartId && this.isExtracted(globalPartId)) {
      const reason = this.renderOverrideStore?.get(globalPartId)?.reason || 'material';
      return { eligible: false, reason: `force-extracted:${reason}`, extracted: true };
    }
    return assessPart(part, {
      renderMode: this.getRenderMode(),
      celAllowed: opts.celAllowed !== undefined ? opts.celAllowed : this.celBatchEnabled,
      batchedMeshAllowed: opts.batchedMeshAllowed !== undefined ? opts.batchedMeshAllowed : this.batchedMeshEnabled,
    });
  }

  // ── Extraction policy API (Phase 2 hybrid render cache) ──

  /** @returns {boolean} whether the part is force-extracted from batching. */
  isExtracted(globalPartId) {
    return this.renderOverrideStore?.isExtracted(globalPartId) === true;
  }

  /** @returns {string|null} the extraction reason ('water', 'glass', 'material', …) or null. */
  getExtractionReason(globalPartId) {
    return this.renderOverrideStore?.get(globalPartId)?.reason || null;
  }

  /**
   * Mark a part extracted (kept out of batching) and optionally rebuild its model
   * so the change takes effect immediately.
   * @param {string} globalPartId `${modelId}:${partId}`
   * @param {string} [reason] extraction reason from classifyMaterialOverride()
   * @param {object} [options] { rebuild=true }
   * @returns {{ok:boolean, globalPartId?:string, modelId?:string, reason?:string, rebuildAudit?:any}}
   */
  extractPart(globalPartId, reason = 'material', options = {}) {
    const id = splitGlobalPartId(globalPartId);
    if (!id || !this.renderOverrideStore) {
      return { ok: false, reason: 'invalid-globalPartId', globalPartId };
    }
    this.renderOverrideStore.extract(globalPartId, reason);
    const rebuildAudit = options.rebuild === false
      ? null
      : (this.rebuildModel?.(id.modelId) ?? null);
    return {
      ok: true, globalPartId, modelId: id.modelId, mode: 'extracted',
      extractionReason: reason, rebuildAudit,
    };
  }

  /** Clear a part's extraction policy (it may re-batch on next rebuild). */
  clearExtraction(globalPartId) {
    return this.renderOverrideStore?.clear(globalPartId) || false;
  }

  /** @returns {string|null} the part's current RuntimeIndex render mode. */
  getPartRenderMode(globalPartId) {
    return this.runtimeIndex?.getRenderRef(globalPartId)?.mode || null;
  }

  /**
   * Stage a batchable part for compilation.
   * @param {object} part — VoxelPart
   * @param {object} assessment — result from canBatch()
   * @param {string} modelId — for globalPartId key generation
   * @param {THREE.Matrix4} [parentChainMatrix]
   */
  stagePart(part, assessment, modelId, parentChainMatrix) {
    if (!assessment.eligible) return false;
    const globalPartId = `${modelId}:${part.id}`;
    const batchKey = makeBatchKey(part, assessment.family);
    this._pendingParts.set(globalPartId, {
      globalPartId,
      part,
      family: assessment.family,
      scale: assessment.scale,
      batchKey,
      baseRecipe: part.materialTagBaseRecipe || null,
      parentChainMatrix: parentChainMatrix || null,
    });
    return true;
  }

  /**
   * Compile all staged parts for `modelId` into the shared scene batches.
   * Removes the model's previous instances first (rebuild-safe), then inserts the
   * pending parts in world space relative to `rootGroup`. Compiling with nothing
   * staged simply removes the model's stale shared instances.
   *
   * @param {string} modelId
   * @param {THREE.Object3D} rootGroup — the model root (provides matrixWorld)
   * @returns {CompileAudit}
   */
  compile(modelId, rootGroup) {
    if (!this._sceneCache || !this._sharedBatchRoot) {
      throw new Error('AIPrimitiveBatcher.compile requires resetScene() first');
    }

    // Remove this model's prior instances (rebuild / undo / redo).
    const { affected } = this._removeModel(modelId);

    if (rootGroup && typeof rootGroup.updateMatrixWorld === 'function') {
      rootGroup.updateMatrixWorld(true);
    }
    const rootWorld = rootGroup?.matrixWorld || null;

    const audit = {
      modelId,
      totalParts: this._pendingParts.size,
      batchableParts: 0,
      instancedParts: 0,
      batchedMeshParts: 0,
      fallbackParts: 0,
      batchCount: 0,
      unsupportedReasons: { ...this._unsupportedReasons },
      families: {},
      batches: [],
    };

    // Group staged parts by shared batchKey. tri/patch (batched-mesh mode) take a
    // separate path: per-part geometry in a BatchedMesh, not a unit-geometry batch.
    /** @type {Map<string, object[]>} */
    const groups = new Map();
    /** @type {object[]} */
    const batchedEntries = [];
    for (const [, entry] of this._pendingParts) {
      if (entry.family.shapeMappingMode === 'batched-mesh') { batchedEntries.push(entry); continue; }
      if (!groups.has(entry.batchKey)) groups.set(entry.batchKey, []);
      groups.get(entry.batchKey).push(entry);
    }

    const slotMap = new Map();
    for (const [batchKey, entries] of groups) {
      const first = entries[0];
      // Reuse an existing shared batch; only build geometry/material on creation.
      let batch = this._sceneCache.getBatch(batchKey);
      if (!batch) {
        const sourceMaterial = first.part.mesh?.material || {};
        const batchMaterial = this._createBatchMaterial(sourceMaterial);
        batch = this._sceneCache.getOrCreateBatch(batchKey, {
          unitGeometry: first.family.getUnitGeometry(),
          batchMaterial,
          initialCapacity: entries.length,
          maxCapacity: this.maxBatchCapacity,
        });
        // batch.instancedMesh must exist before this fires: callers use it as the
        // mesh-level matcap-override anchor (see MatcapSystem._effectiveState), which
        // material-only mutation can't provide.
        this.onBatchMaterialReady?.(batchMaterial, sourceMaterial, first.baseRecipe, batch.instancedMesh);
      }

      for (const entry of entries) {
        const matrix = computeInstanceMatrix(
          entry.part,
          entry.scale,
          null,
          entry.parentChainMatrix,
          rootWorld,
        );
        const color = new THREE.Color(entry.part.mesh?.material?.color ?? 0xcccccc);
        const instanceId = this._sceneCache.addInstance(batch, entry.globalPartId, matrix, color);
        if (instanceId >= 0) {
          affected.add(batchKey);
          slotMap.set(entry.globalPartId, { batchKey, instanceId });
          this._partRecords.set(entry.globalPartId, {
            globalPartId: entry.globalPartId,
            modelId,
            part: entry.part,
            family: entry.family,
            scale: entry.scale,
            batchKey,
            parentChainMatrix: entry.parentChainMatrix,
            rootGroup,
          });
          audit.instancedParts++;
          const fam = audit.families[entry.family.name]
            || (audit.families[entry.family.name] = { parts: 0, batches: 0, instances: 0 });
          fam.instances++;
        } else {
          audit.fallbackParts++;
        }
      }

      // Shared mesh: mark batch, but never pin a single-model id on it.
      batch.instancedMesh.userData.isAIPrimitiveBatch = true;
      batch.instancedMesh.userData.batchKey = batchKey;
      batch.instancedMesh.userData.batchId = batchKey;

      audit.batchCount++;
      audit.batchableParts += entries.length;
      audit.batches.push({
        batchKey,
        family: first.family.name,
        count: entries.length,
        instanced: entries.filter(e => slotMap.has(e.globalPartId)).length,
        firstGlobalPartIds: entries.map(e => e.globalPartId).slice(0, 3),
      });
      const fam = audit.families[first.family.name]
        || (audit.families[first.family.name] = { parts: 0, batches: 0, instances: 0 });
      fam.parts += entries.length;
      fam.batches += 1;
    }

    // Only track models that actually occupy shared slots. A rebuild with no
    // batchable parts leaves the model absent (its prior entry was removed above).
    if (slotMap.size > 0) this._modelToSlots.set(modelId, slotMap);

    // ── BatchedMesh path: tri/patch parts (per-part geometry, material buckets) ──
    if (batchedEntries.length > 0 && this._batchedGroup) {
      const batchedIds = new Set();
      for (const entry of batchedEntries) {
        const geometry = this._buildBatchedGeometry(entry.part);
        if (!geometry) { audit.fallbackParts++; this.recordUnsupported('batched-geometry-build-failed'); continue; }
        const matrix = computeInstanceMatrix(
          entry.part, entry.scale, null, entry.parentChainMatrix, rootWorld,
        );
        const matParams = entry.part.mesh?.material || {};
        const materialKey = `${makeMaterialKey(matParams)}:base=${entry.baseRecipe?.key || 'default'}`;
        this._batchedGroup.setPart(
          entry.globalPartId,
          modelId,
          geometry,
          matrix,
          materialKey,
          matParams,
          entry.baseRecipe,
        );
        batchedIds.add(entry.globalPartId);
        this._partRecords.set(entry.globalPartId, {
          globalPartId: entry.globalPartId, modelId, part: entry.part, family: entry.family,
          scale: entry.scale, batchKey: entry.batchKey, parentChainMatrix: entry.parentChainMatrix,
          rootGroup, batched: true, materialKey,
        });
        audit.batchedMeshParts++;
        audit.batchableParts++;
        const fam = audit.families[entry.family.name]
          || (audit.families[entry.family.name] = { parts: 0, batches: 0, instances: 0 });
        fam.parts++; fam.instances++;
      }
      if (batchedIds.size > 0) this._modelToBatchedParts.set(modelId, batchedIds);
    }

    this._batchedGroup?.flush();

    // Newly created batches must join the shared root (idempotent for existing).
    if (this._sharedBatchRoot) {
      this._sceneCache.attachToSharedRoot(this._sharedBatchRoot);
      this._batchedGroup?.attachToSharedRoot(this._sharedBatchRoot);
    }
    this._sceneCache.flush();

    // Re-register every affected shared batch with its COMPLETE live slot array,
    // so models sharing the batch (added or removed) stay consistent.
    this._reregisterBatches(affected);
    this._reregisterBatchedMeshes();

    this._modelAudits.set(modelId, audit);
    this.lastCompileAudit = audit;
    return audit;
  }

  /**
   * Recompute and write a model's instance matrices in world space after its
   * root transform changed. Flushes once.
   * @param {string} modelId
   * @returns {{modelId:string, requested:number, updated:number, missing:number}}
   */
  updateModelInstanceMatrices(modelId) {
    const result = { modelId, requested: 0, updated: 0, missing: 0 };
    if (!this._sceneCache) return result;
    const slotMap = this._modelToSlots.get(modelId);
    const batchedIds = this._modelToBatchedParts.get(modelId);
    if (!slotMap && !batchedIds) return result;

    const worldMatrixFor = (record) => {
      if (record.rootGroup && typeof record.rootGroup.updateMatrixWorld === 'function') {
        record.rootGroup.updateMatrixWorld(true);
      }
      return computeInstanceMatrix(
        record.part, record.scale, null, record.parentChainMatrix,
        record.rootGroup?.matrixWorld || null,
      );
    };

    if (slotMap) {
      for (const [globalPartId, { batchKey, instanceId }] of slotMap) {
        result.requested++;
        const record = this._partRecords.get(globalPartId);
        if (!record) { result.missing++; continue; }
        if (this._sceneCache.updateInstanceMatrix(batchKey, instanceId, worldMatrixFor(record))) result.updated++;
        else result.missing++;
      }
    }

    // BatchedMesh parts: re-place in world space (no rebuild — setMatrixAt).
    if (batchedIds && this._batchedGroup) {
      for (const globalPartId of batchedIds) {
        result.requested++;
        const record = this._partRecords.get(globalPartId);
        if (!record) { result.missing++; continue; }
        if (this._batchedGroup.updateMatrix(globalPartId, worldMatrixFor(record))) result.updated++;
        else result.missing++;
      }
    }

    this._sceneCache.flush();
    return result;
  }

  /**
   * Remove a model's instances from the shared cache and RuntimeIndex, then
   * re-register the affected shared batches with their remaining live slots.
   * @param {string} modelId
   * @returns {{modelId:string, removed:number, missing:number, affectedBatchCount:number}}
   */
  removeModelInstances(modelId) {
    const { affected, removed, missing } = this._removeModel(modelId);
    if (this._sceneCache) this._sceneCache.flush();
    this._batchedGroup?.flush();
    this._reregisterBatches(affected);
    this._reregisterBatchedMeshes();
    return { modelId, removed, missing, affectedBatchCount: affected.size };
  }

  /**
   * Internal: drop a model's instances from the shared cache, RuntimeIndex, and
   * retained maps. Does NOT flush or re-register — callers do that.
   * @returns {{affected:Set<string>, removed:number, missing:number}}
   */
  _removeModel(modelId) {
    const affected = new Set();
    let removed = 0;
    let missing = 0;
    const slotMap = this._modelToSlots.get(modelId);
    if (slotMap) {
      for (const [globalPartId, { batchKey }] of slotMap) {
        const ok = this._sceneCache ? this._sceneCache.removeInstance(globalPartId) : false;
        if (ok) { removed++; affected.add(batchKey); }
        else missing++;
        this.runtimeIndex?.unregisterPart(globalPartId);
        this._partRecords.delete(globalPartId);
      }
    }
    // BatchedMesh parts for this model (parallel to the InstancedMesh slots above).
    const batchedIds = this._modelToBatchedParts.get(modelId);
    if (batchedIds) {
      for (const globalPartId of batchedIds) {
        const ok = this._batchedGroup?.removePart(globalPartId) === true;
        if (ok) removed++;
        else missing++;
        this.runtimeIndex?.unregisterPart(globalPartId);
        this._partRecords.delete(globalPartId);
      }
      this._modelToBatchedParts.delete(modelId);
    }
    this._modelToSlots.delete(modelId);
    this._modelAudits.delete(modelId);
    return { affected, removed, missing };
  }

  /**
   * Re-register a set of shared batches in RuntimeIndex with their complete
   * current slot arrays. partIds[index] aligns with the InstancedMesh instanceId.
   * @param {Iterable<string>} batchKeys
   */
  _reregisterBatches(batchKeys) {
    if (!this.runtimeIndex || !this._sceneCache) return;
    for (const batchKey of batchKeys) {
      const batch = this._sceneCache.getBatch(batchKey);
      if (!batch) continue;
      this.runtimeIndex.registerInstancedBatch(
        batchKey,
        batch.instancedMesh,
        batch.partIds,
        { source: 'ai-primitive-batcher', batchKey },
      );
    }
  }

  /** Re-register every live BatchedMesh material bucket in RuntimeIndex. */
  _reregisterBatchedMeshes() {
    if (!this.runtimeIndex || !this._batchedGroup) return;
    this.runtimeIndex.unregisterBatchesBySource?.('ai-primitive-batched-mesh');
    for (const registration of this._batchedGroup.getRegistrations()) {
      this.runtimeIndex.registerBatchedMesh?.(
        registration.batchId,
        registration.mesh,
        registration.idToPart,
        {
          source: 'ai-primitive-batched-mesh',
          batchKey: registration.batchKey,
        },
      );
    }
  }

  /**
   * Merged scene-level audit across all models currently in the scene.
   * @returns {SceneCompileAudit}
   */
  getSceneAudit() {
    const merged = {
      totalParts: 0,
      batchableParts: 0,
      instancedParts: 0,
      batchedMeshParts: 0,
      fallbackMeshParts: 0,
      batchCount: (this._sceneCache ? this._sceneCache.batches.size : 0)
        + (this._batchedGroup?.getAudit?.().buckets || 0),
      batchedMeshBatchCount: this._batchedGroup?.getAudit?.().buckets || 0,
      unsupportedReasons: {},
      families: {},
      batches: [],
      modelIds: [],
    };
    for (const [modelId, a] of this._modelAudits) {
      merged.totalParts += a.totalParts || 0;
      merged.batchableParts += a.batchableParts || 0;
      merged.instancedParts += a.instancedParts || 0;
      merged.batchedMeshParts += a.batchedMeshParts || 0;
      merged.fallbackMeshParts += a.fallbackParts || 0;
      merged.modelIds.push(modelId);
      for (const [k, v] of Object.entries(a.unsupportedReasons || {})) {
        merged.unsupportedReasons[k] = (merged.unsupportedReasons[k] || 0) + v;
      }
      for (const [fam, s] of Object.entries(a.families || {})) {
        const m = merged.families[fam] || (merged.families[fam] = { parts: 0, batches: 0, instances: 0 });
        m.parts += s.parts || 0;
        m.instances += s.instances || 0;
      }
      if (Array.isArray(a.batches)) for (const b of a.batches) merged.batches.push(b);
    }
    // Family batch counts come from the shared cache (one batch per batchKey).
    return merged;
  }

  /**
   * Get all shared InstancedMesh objects.
   * @returns {THREE.InstancedMesh[]}
   */
  getInstancedMeshes() {
    if (!this._sceneCache) return [];
    const all = [];
    for (const batch of this._sceneCache.batches.values()) all.push(batch.instancedMesh);
    return all;
  }

  /** Get all shared BatchedMesh objects for tri/patch parts. */
  getBatchedMeshes() {
    return this._batchedGroup?.getMeshes?.() || [];
  }

  /**
   * Apply a plain PBR/color override to one tri/patch BatchedMesh part by moving
   * it to the material bucket matching the merged material params.
   * @param {string} globalPartId
   * @param {object} override
   * @returns {boolean}
   */
  updateBatchedPartMaterial(globalPartId, override = {}) {
    const record = this._partRecords.get(globalPartId);
    if (!record?.batched || !this._batchedGroup) return false;

    const partMaterial = record.part.mesh.material || {};
    const nextMaterial = { ...partMaterial, ...override };
    if (override?.uniforms?.uColor != null && nextMaterial.color == null) {
      nextMaterial.color = override.uniforms.uColor;
    }
    record.part.mesh.material = nextMaterial;

    const geometry = this._buildBatchedGeometry(record.part);
    if (!geometry) return false;
    if (record.rootGroup && typeof record.rootGroup.updateMatrixWorld === 'function') {
      record.rootGroup.updateMatrixWorld(true);
    }
    const matrix = computeInstanceMatrix(
      record.part,
      record.scale,
      null,
      record.parentChainMatrix,
      record.rootGroup?.matrixWorld || null,
    );
    const materialKey = makeMaterialKey(nextMaterial);
    this._batchedGroup.setPart(globalPartId, record.modelId, geometry, matrix, materialKey, nextMaterial);
    record.materialKey = materialKey;
    this._batchedGroup.flush();
    if (this._sharedBatchRoot) this._batchedGroup.attachToSharedRoot(this._sharedBatchRoot);
    this._reregisterBatchedMeshes();
    return true;
  }

  /**
   * Get partId → instanceId mapping for a shared batch.
   * @param {string} batchKey
   * @returns {Array<{partId: string, instanceId: number}>}
   */
  getBatchMappings(batchKey) {
    const batch = this._sceneCache?.batches.get(batchKey);
    if (!batch) return [];
    const mappings = [];
    for (let i = 0; i < batch.partIds.length; i++) {
      if (batch.partIds[i] !== null) mappings.push({ partId: batch.partIds[i], instanceId: i });
    }
    return mappings;
  }

  /**
   * Dispose all batch resources. Keeps the shared root object alive (owned by
   * SceneManager) so it is not detached from ModelRoot.
   */
  dispose() {
    if (this._sceneCache) this._sceneCache.dispose();
    this._sceneCache = null;
    if (this._batchedGroup) this._batchedGroup.dispose();
    this._batchedGroup = null;
    this._pendingParts.clear();
    this._modelToSlots.clear();
    this._modelToBatchedParts.clear();
    this._partRecords.clear();
    this._modelAudits.clear();
    this.lastCompileAudit = null;
    this._unsupportedReasons = {};
  }

  // ── Internal ──

  /**
   * Create a MeshStandardMaterial for a batch from part material params.
   */
  _createBatchMaterial(matParams) {
    const material = new THREE.MeshStandardMaterial({
      // Every primitive-batch instance receives its authored colour through
      // instanceColor. Keeping it on the shared material as well squares the
      // colour in Three's vertex pipeline (materialColor * instanceColor).
      color: 0xffffff,
      roughness: matParams.roughness ?? DEFAULT_PBR_ROUGHNESS,
      metalness: matParams.metalness ?? DEFAULT_PBR_METALNESS,
      flatShading: matParams.flatShading !== false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });
    material.userData.isAIPrimitiveBatchMaterial = true;
    return material;
  }

  /** Build the real per-part geometry for BatchedMesh-only primitive families. */
  _buildBatchedGeometry(part) {
    const type = String(part?.mesh?.type || '').toLowerCase();
    const geometry = part?.mesh?.geometry || {};
    try {
      if (type === 'tri') return buildTriangleGeometry(THREE, geometry);
      if (type === 'patch') return buildPatchGeometry(THREE, geometry);
    } catch (_error) {
      return null;
    }
    return null;
  }
}

/**
 * @typedef {Object} CompileAudit
 * @property {string} modelId
 * @property {number} totalParts
 * @property {number} batchableParts
 * @property {number} instancedParts
 * @property {number} batchedMeshParts
 * @property {number} fallbackParts
 * @property {number} batchCount
 * @property {Object<string,number>} unsupportedReasons
 * @property {Array<{batchKey:string, count:number, instanced:number, firstGlobalPartIds?:string[]}>} batches
 */

/**
 * @typedef {Object} SceneCompileAudit
 * @property {number} totalParts
 * @property {number} batchableParts
 * @property {number} instancedParts
 * @property {number} batchedMeshParts
 * @property {number} fallbackMeshParts
 * @property {number} batchCount
 * @property {number} batchedMeshBatchCount
 * @property {Object<string,number>} unsupportedReasons
 * @property {Array} batches
 * @property {string[]} modelIds
 */
