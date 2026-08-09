/**
 * MaterialOverrideController — DECISION layer of the hybrid render cache.
 *
 * Single source of truth for material-override state (currentMaterialOverrides +
 * RenderOverrideStore). Decides, for "user wants part X to look like Y":
 *   - color-only on a batched part      → InstancedMesh.updateInstanceColor (stays batched)
 *   - complex on a batched part          → extract → rebuild → replay (leaves batch)
 *   - complex on an independent mesh      → ComplexMaterialOverrideRuntime (execution layer)
 *   - removeOverride                      → re-classify the REMAINDER, only re-batch when nothing complex is left
 *
 * Pure decision module: every collaborator + THREE color construction is injected,
 * so it unit-tests in Node. It owns NO DOM, NO window, NO selection. apply/remove
 * return previousMode/finalMode/renderRefChanged so the UI (scene-builder / Task 6)
 * can decide whether to re-select after a rebuild changed the renderRef.
 *
 * Boundaries (confirmed): sole mutator of RenderOverrideStore — AIPrimitiveBatcher
 * only READS the policy via isExtracted()/canBatch().
 */

import { splitGlobalPartId, classifyMaterialOverride } from './RenderOverrideStore.js';

export class MaterialOverrideController {
  /**
   * @param {object} deps
   * @param {object} deps.runtimeIndex            getRenderRef / resolveMaterialTarget
   * @param {object} deps.batcher                 AIPrimitiveBatcher: getCache(), isExtracted()
   * @param {object} deps.renderOverrideStore     extraction policy (OWNED & mutated here)
   * @param {object} deps.complexRuntime          ComplexMaterialOverrideRuntime
   * @param {Function} deps.rebuildModel          (modelId) => audit (model-scoped render-cache rebuild)
   * @param {Function} deps.makeColor             (value) => color-like accepted by
   *        RenderCache.updateInstanceColor (e.g. new THREE.Color(value)). Injected so the
   *        decision layer never imports THREE.
   * @param {object} [deps.initialOverrides]      starting currentMaterialOverrides
   */
  constructor({
    runtimeIndex, batcher, renderOverrideStore, complexRuntime,
    rebuildModel, makeColor, initialOverrides = {},
  } = {}) {
    this.runtimeIndex = runtimeIndex || null;
    this.batcher = batcher || null;
    this.renderOverrideStore = renderOverrideStore || null;
    this.complexRuntime = complexRuntime || null;
    this.rebuildModel = typeof rebuildModel === 'function' ? rebuildModel : () => null;
    this.makeColor = typeof makeColor === 'function' ? makeColor : (v => v);
    /** @type {Object<string, Object<string, object>>} modelId → partId → override */
    this.currentMaterialOverrides = cloneJson(initialOverrides);
  }

  /**
   * Apply a material override to a part.
   * @param {string} globalPartId `${modelId}:${partId}`
   * @param {object} override
   * @param {object} [opts] { persist=true, allowExtraction=true }
   * @returns {Promise<ApplyResult>}
   */
  async apply(globalPartId, override, opts = {}) {
    const { persist = true, allowExtraction = true } = opts;
    if (!override || !globalPartId) return fail('no-override-or-id', globalPartId);
    const id = splitGlobalPartId(globalPartId);
    if (!id) return fail('invalid-globalPartId', globalPartId);

    const previousMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? null;
    let target = this.runtimeIndex?.resolveMaterialTarget(globalPartId);
    if (!target) return { ...fail('target-not-found', globalPartId), previousMode, finalMode: previousMode, renderRefChanged: false };

    if (persist) this._persistMerge(id, override);
    const reason = classifyMaterialOverride(override);

    // ── Batched part ──────────────────────────────────────────────────────
    if (target.type === 'instance') {
      // color-only → per-instance color, stays in the batch
      if (!reason) {
        const colorVal = colorOf(override);
        if (colorVal == null) {
          return ok(globalPartId, { mode: 'instanced', previousMode, finalMode: 'instanced', renderRefChanged: false, applied: [] });
        }
        const cache = this.batcher?.getCache?.(id.modelId);
        const applied = cache?.updateInstanceColor?.(globalPartId, this.makeColor(colorVal)) === true;
        cache?.flush?.();
        return applied
          ? ok(globalPartId, { mode: 'instanced', previousMode, finalMode: 'instanced', renderRefChanged: false, applied: ['instanceColor'] })
          : { ...fail('batch-miss', globalPartId), previousMode, finalMode: previousMode, renderRefChanged: false };
      }

      // complex → must leave the batch
      if (!allowExtraction) {
        // Reached during replayModel: a complex override resolved to an instance,
        // meaning the extraction policy was not restored before the model build
        // (importState/loadModelsForScene ordering bug). Surface it; never loop.
        return { ...fail('replay-needs-extraction', globalPartId), previousMode, finalMode: previousMode, renderRefChanged: false };
      }
      this.renderOverrideStore?.extract(globalPartId, reason);
      this.rebuildModel(id.modelId);
      await this.replayModel(id.modelId); // re-applies every persisted override (incl. this one) to fresh meshes
      const finalMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? null;
      if (!finalMode || finalMode === 'instanced') {
        return { ...fail('extraction-failed', globalPartId), previousMode, finalMode, renderRefChanged: finalMode !== previousMode };
      }
      return ok(globalPartId, {
        mode: finalMode, previousMode, finalMode,
        renderRefChanged: finalMode !== previousMode,
        applied: ['extracted'], extractionReason: reason, rebuilt: true,
      });
    }

    // ── Independent mesh (extracted / fallback / plain) ───────────────────
    // Route by the OVERRIDE, not the part: only a genuinely complex override
    // (glass/emissive-color/shader/matcap/effectLayer/texture/...) needs an
    // isolated material via ComplexMaterialOverrideRuntime (which clones). Plain
    // scalar/color/uniform overrides apply IN PLACE — never clone (regression fix:
    // cloning fallback materials at load dropped shaders/textures and broke render).
    if (target.type === 'batched') {
      if (!reason) {
        const applied = this.batcher?.updateBatchedPartMaterial?.(globalPartId, override) === true;
        const finalMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? previousMode;
        return applied
          ? ok(globalPartId, { mode: finalMode, previousMode, finalMode, renderRefChanged: finalMode !== previousMode, applied: ['batchedMaterialBucket'] })
          : { ...fail('batched-bucket-miss', globalPartId), previousMode, finalMode: previousMode, renderRefChanged: false };
      }

      if (!allowExtraction) {
        return { ...fail('replay-needs-extraction', globalPartId), previousMode, finalMode: previousMode, renderRefChanged: false };
      }
      this.renderOverrideStore?.extract(globalPartId, reason);
      this.rebuildModel(id.modelId);
      await this.replayModel(id.modelId);
      const finalMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? null;
      if (!finalMode || finalMode === 'batched') {
        return { ...fail('extraction-failed', globalPartId), previousMode, finalMode, renderRefChanged: finalMode !== previousMode };
      }
      return ok(globalPartId, {
        mode: finalMode, previousMode, finalMode,
        renderRefChanged: finalMode !== previousMode,
        applied: ['extracted'], extractionReason: reason, rebuilt: true,
      });
    }

    const result = reason
      ? await this.complexRuntime.apply(target.object, override)
      : this._applyInPlace(target.object, override);
    const finalMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? previousMode;
    return {
      ...result, globalPartId, previousMode, finalMode,
      renderRefChanged: finalMode !== previousMode, mode: finalMode,
    };
  }

  /**
   * Apply plain scalar/color/uniform overrides to a mesh's EXISTING material(s)
   * in place — no clone, no isolation. Mirrors the pre-controller behaviour so
   * fallback/shared/shader materials are not corrupted. Never touches textures or
   * shader categories (those are complex → ComplexMaterialOverrideRuntime).
   * @returns {{ok:true, applied:string[]}}
   */
  _applyInPlace(mesh, override) {
    const applied = [];
    const mats = Array.isArray(mesh?.material) ? mesh.material : [mesh?.material];
    for (const material of mats) {
      if (!material) continue;
      if (override.uniforms && typeof override.uniforms === 'object') {
        for (const [key, value] of Object.entries(override.uniforms)) {
          if (key === 'uTime') continue;
          const u = material.userData?.shaderLibraryUniforms?.[key]
            || material.userData?.shader?.uniforms?.[key]
            || material.userData?.pbrAnimationUniforms?.[key]
            || material.uniforms?.[key];
          if (!u) continue;
          if (u.value?.isColor && typeof value === 'string') u.value.set(value);
          else if (u.value?.isVector2 && value && typeof value === 'object') u.value.set(Number(value.x) || 0, Number(value.y) || 0);
          else if (u.value?.isVector3 && value && typeof value === 'object') u.value.set(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
          else u.value = value;
        }
        applied.push('uniforms');
      }
      if (override.color !== undefined && typeof material.color?.set === 'function') { material.color.set(override.color); applied.push('color'); }
      if (override.roughness !== undefined && 'roughness' in material) { material.roughness = Number(override.roughness); applied.push('roughness'); }
      if (override.metalness !== undefined && 'metalness' in material) { material.metalness = Number(override.metalness); applied.push('metalness'); }
      if (override.emissiveIntensity !== undefined && 'emissiveIntensity' in material) { material.emissiveIntensity = Number(override.emissiveIntensity); applied.push('emissiveIntensity'); }
      if (override.rimLightStrength !== undefined) { (material.userData ||= {}).rimLightStrength = Number(override.rimLightStrength); applied.push('rimLightStrength'); }
      material.needsUpdate = true;
    }
    return { ok: true, applied };
  }

  /**
   * Remove an override (or some of its keys) and decide whether the part may
   * return to its batch. NEVER blind-clears: re-classifies the REMAINING override
   * set and only clears extraction when nothing complex is left.
   * @param {string} globalPartId
   * @param {object} [opts] { keys?: string[] } — absent ⇒ remove the whole override
   * @returns {Promise<RemoveResult>}
   */
  async removeOverride(globalPartId, opts = {}) {
    const id = splitGlobalPartId(globalPartId);
    if (!id) return fail('invalid-globalPartId', globalPartId);
    const previousMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? null;

    const current = this.currentMaterialOverrides[id.modelId]?.[id.partId] || {};
    let remaining;
    if (!opts.keys) remaining = {};
    else { remaining = { ...current }; for (const k of opts.keys) delete remaining[k]; }
    const remainingReason = classifyMaterialOverride(remaining);

    this._persistReplace(id, remaining);
    // Only let it re-batch when the remainder carries nothing complex.
    if (remainingReason == null && this.renderOverrideStore?.isExtracted(globalPartId)) {
      this.renderOverrideStore.clear(globalPartId);
    }
    // Always rebuild + replay from fresh base meshes so a removed field truly
    // disappears (the cloned material still holds it otherwise).
    this.rebuildModel(id.modelId);
    const replay = await this.replayModel(id.modelId);
    const finalMode = this.runtimeIndex?.getRenderRef(globalPartId)?.mode ?? null;
    const partResult = replay.results.find(r => r.globalPartId === globalPartId);

    return {
      ok: true, globalPartId, previousMode, finalMode,
      renderRefChanged: finalMode !== previousMode,
      rebatched: previousMode !== 'instanced' && finalMode === 'instanced',
      remainingReason,
      applied: partResult?.applied || [],
    };
  }

  /**
   * Re-apply every persisted override for a model to its (freshly rebuilt) meshes.
   * ALWAYS persist:false + allowExtraction:false — extraction policy must already
   * be in place; a complex override that still resolves to an instance here is an
   * ordering error, returned as a per-part failure rather than triggering a rebuild.
   * @param {string} modelId
   * @param {Object<string, object>} [overrides] — specific overrides to replay;
   *        when omitted, replays from the controller's own persisted state.
   * @returns {Promise<{ok:boolean, modelId:string, results:ApplyResult[]}>}
   */
  async replayModel(modelId, overrides) {
    const results = [];
    const source = overrides || this.currentMaterialOverrides[modelId] || {};
    for (const [partId, override] of Object.entries(source)) {
      results.push(await this.apply(`${modelId}:${partId}`, override, { persist: false, allowExtraction: false }));
    }
    return { ok: results.every(r => r.ok), modelId, results };
  }

  /** @returns {{materialOverrides:object, renderOverrides:object}} */
  exportState() {
    return {
      materialOverrides: cloneJson(this.currentMaterialOverrides),
      renderOverrides: this.renderOverrideStore?.exportState() || {},
    };
  }

  /**
   * Restore both maps. MUST be called BEFORE loadModelsForScene() so the batcher's
   * canBatch() sees the extraction policy and builds extracted parts as independent
   * meshes from the first frame.
   * @param {{materialOverrides?:object, renderOverrides?:object}} state
   */
  importState(state = {}) {
    this.currentMaterialOverrides = cloneJson(state.materialOverrides || {});
    this.renderOverrideStore?.importState(state.renderOverrides || {});
  }

  // ── internal persistence ──
  _persistMerge(id, override) {
    // Sanitize on the way in so STATE never holds a live Texture/Material/Object3D
    // (the complexRuntime still receives the original override with live refs).
    const clean = jsonSafeDeepClone(override) || {};
    const bucket = (this.currentMaterialOverrides[id.modelId] ||= {});
    bucket[id.partId] = { ...(bucket[id.partId] || {}), ...clean };
  }

  _persistReplace(id, remaining) {
    const bucket = this.currentMaterialOverrides[id.modelId];
    if (!remaining || Object.keys(remaining).length === 0) {
      if (bucket) {
        delete bucket[id.partId];
        if (Object.keys(bucket).length === 0) delete this.currentMaterialOverrides[id.modelId];
      }
      return;
    }
    (this.currentMaterialOverrides[id.modelId] ||= {})[id.partId] = { ...remaining };
  }
}

function colorOf(override) {
  if (override?.color != null) return override.color;
  if (override?.uniforms?.uColor != null) return override.uniforms.uColor;
  return null;
}

// Deep clone that GUARANTEES pure-JSON output: drops live THREE objects
// (Texture/Material/Object3D/Geometry) anywhere in the tree, converts a stray
// THREE.Color to its hex string, and breaks cycles. Used for all override-state
// (de)serialization so save/sessionStorage never receives an unserializable
// Texture (which would throw "Unable to serialize Texture" and corrupt the scene).
function jsonSafeDeepClone(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (value.isTexture || value.isMaterial || value.isObject3D || value.isBufferGeometry) return undefined;
  if (value.isColor && typeof value.getHexString === 'function') return `#${value.getHexString()}`;
  if (Array.isArray(value)) return value.map(v => jsonSafeDeepClone(v, seen)).filter(v => v !== undefined);
  if (seen.has(value)) return undefined;
  seen.add(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const c = jsonSafeDeepClone(v, seen);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function cloneJson(value) {
  return value ? jsonSafeDeepClone(value) : {};
}

function ok(globalPartId, extra) {
  return { ok: true, globalPartId, applied: [], rebuilt: false, ...extra };
}

function fail(reason, globalPartId) {
  return { ok: false, reason, globalPartId };
}

export default MaterialOverrideController;
