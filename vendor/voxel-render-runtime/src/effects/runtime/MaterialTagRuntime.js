import { getMaterialTagVocabulary } from '../../materials/MaterialTagCatalog.js';
import { compileModelMaterialTags, prepareModelMaterialTags } from './MaterialTagCompiler.js';

const SURFACE_PROPERTIES = ['roughness', 'metalness', 'envMapIntensity'];

export function applyMaterialSurfaceBinding(target, binding, environmentMap = null) {
  if (!target || !binding) return 0;
  const source = target.material ?? target;
  const materials = Array.isArray(source) ? source : [source];
  let updated = 0;
  for (const material of materials) {
    if (!material) continue;
    let touched = false;
    for (const name of SURFACE_PROPERTIES) {
      const value = binding[name];
      if (!Number.isFinite(value) || !(name in material)) continue;
      material[name] = value;
      touched = true;
    }
    if (binding.environment === true && environmentMap && 'envMap' in material) {
      if (material.envMap !== environmentMap) {
        material.envMap = environmentMap;
        material.needsUpdate = true;
      }
      touched = true;
    }
    if (touched) updated++;
  }
  return updated;
}

export class MaterialTagRuntime {
  constructor(options = {}) {
    this.vocabulary = options.vocabulary || null;
    this.runtimeIndex = options.runtimeIndex || null;
    this.effectSlotManager = options.effectSlotManager || null;
    this.effectRuntime = options.effectRuntime || null;
    this.envMapProvider = options.envMapProvider || null;
    this.applyMatcap = options.applyMatcap || null;
    this.createCompanion = options.createCompanion || null;
    this.logger = options.logger || null;
  }

  async getVocabulary() {
    if (!this.vocabulary) this.vocabulary = await getMaterialTagVocabulary();
    return this.vocabulary;
  }

  async prepareModel(model) {
    return prepareModelMaterialTags(model, await this.getVocabulary());
  }

  async applyModel(modelId, model) {
    const vocabulary = await this.getVocabulary();
    const compiled = compileModelMaterialTags(model, vocabulary);
    const result = {
      modelId,
      taggedParts: 0,
      appliedParts: 0,
      appliedLayers: 0,
      appliedMatcaps: 0,
      createdCompanions: 0,
      precompiledBaseParts: 0,
      skipped: [],
      diagnostics: [...compiled.diagnostics],
    };

    for (const [partId, entry] of compiled.byPartId) {
      if (entry.effectiveTags.length === 0) continue;
      result.taggedParts++;
      const globalPartId = `${modelId}:${partId}`;
      const ref = this.runtimeIndex?.getRenderRef?.(globalPartId) || null;
      if (!ref?.object) {
        result.skipped.push({ partId, globalPartId, reason: 'missing-render-ref' });
        continue;
      }
      const baseHandledByBatch = Boolean(entry.part?.materialTagBaseRecipe)
        && (ref.mode === 'instanced' || ref.mode === 'batched');
      const effectPackage = baseHandledByBatch ? entry.runtimeEffectPackage : entry.effectPackage;
      const matcapBinding = baseHandledByBatch ? null : (entry.materialBindings?.matcap || null);
      const surfaceBinding = baseHandledByBatch ? null : (entry.materialBindings?.surface || null);
      if (!effectPackage && !matcapBinding && !surfaceBinding) {
        if (baseHandledByBatch) {
          result.precompiledBaseParts++;
          result.appliedParts++;
        } else {
          result.skipped.push({ partId, reason: 'no-implemented-effects', unsupportedTags: entry.unsupportedTags });
        }
        continue;
      }
      if (ref.mode === 'batched') {
        result.skipped.push({
          partId,
          globalPartId,
          reason: entry.part?.materialTagBaseRecipe
            ? 'batched-mesh-runtime-effects-not-isolatable'
            : 'batched-mesh-not-isolatable',
        });
        continue;
      }

      const target = { object: ref.object, partId: globalPartId, nodeId: globalPartId };
      const materialLayerCount = effectPackage?.materialLayers?.length || 0;
      const runtimeContext = {
        runtime: this.effectRuntime,
        geometryFamily: ref.object?.userData?.geometryFamily || entry.part?.mesh?.type || null,
        source: 'material-tags',
      };
      let applied = null;
      let activeTarget = ref.object;
      let partApplied = false;
      if (materialLayerCount > 0 && this.effectSlotManager?.applyPackage) {
        applied = this.effectSlotManager.applyPackage(target, effectPackage, runtimeContext);
        if (applied?.ok !== false) {
          result.appliedLayers += materialLayerCount;
          activeTarget = applied?.target || activeTarget;
          partApplied = true;
        }
      }

      if (matcapBinding || surfaceBinding) {
        if (ref.mode === 'instanced' && activeTarget === ref.object) {
          const isolation = this.effectSlotManager?.isolationService?.ensureStandalone?.(target, runtimeContext);
          if (isolation?.mesh) activeTarget = isolation.mesh;
        }
        if (ref.mode === 'instanced' && activeTarget === ref.object) {
          result.skipped.push({
            partId,
            globalPartId,
            reason: matcapBinding ? 'instanced-matcap-not-isolated' : 'instanced-surface-not-isolated',
          });
        } else {
          const environmentMap = this.envMapProvider?.getCurrentEnvMap?.() || null;
          if (surfaceBinding && applyMaterialSurfaceBinding(activeTarget, surfaceBinding, environmentMap) > 0) {
            partApplied = true;
          }
          if (matcapBinding) {
            if (typeof this.applyMatcap !== 'function') {
              result.skipped.push({ partId, globalPartId, reason: 'matcap-runtime-unavailable' });
            } else {
              const matcapResult = this.applyMatcap(activeTarget, matcapBinding);
              const matcapApplied = matcapResult === true || (matcapResult?.materials || 0) > 0;
              if (matcapApplied) {
                result.appliedMatcaps++;
                partApplied = true;
              } else {
                result.skipped.push({ partId, globalPartId, reason: 'matcap-not-applied' });
              }
            }
          }
        }
      }

      const companionTarget = activeTarget;
      for (const companion of effectPackage?.companionEffects || []) {
        const created = this.createCompanion?.(companion.type, companionTarget, companion.params || {}) === true;
        if (created) {
          result.createdCompanions++;
          partApplied = true;
        } else {
          result.skipped.push({ partId, globalPartId, reason: 'unsupported-companion', type: companion.type });
        }
      }
      if (partApplied) result.appliedParts++;
    }

    this._log(result);
    return result;
  }

  _log(result) {
    if (typeof this.logger === 'function') this.logger(result);
    else if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(result);
  }
}

export default MaterialTagRuntime;
