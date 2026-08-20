import * as THREE from 'three';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import {
  EffectSlotManager,
  applyMaterialSurfaceBinding,
  compileModelMaterialTags,
  createEffectRuntime,
  createParticleEffect,
  removeParticleEffect,
  tickParticleEffects
} from '@voxel-studio/render-runtime/effects';
import {
  ModelWaterInstances,
  selectMergedPoolReference
} from '@voxel-studio/render-runtime/environment';
import {
  filterMaterialTags,
  type MapMaterialTagPolicy
} from '../shared/materialTagPolicy';
import {
  createMaterialTagFireConfigs,
  type MaterialTagFireEntry,
  type MaterialTagFireVocabulary
} from './materialTagFireRuntime';

interface TaggedNode {
  id: string;
  parent?: string;
  name?: string;
  tags?: unknown[];
  mesh?: {
    type?: string;
    params?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface TaggedModelSource {
  name?: string;
  style?: string;
  nodes?: TaggedNode[];
}

interface EffectBatchResult {
  batchMesh?: THREE.InstancedMesh;
  partIds?: string[];
}

interface EffectBatchCoordinatorLike {
  batches: Map<string, EffectBatchResult>;
}

interface EffectSlotManagerWithBatches extends EffectSlotManager {
  effectBatchCoordinator?: EffectBatchCoordinatorLike | null;
}

export interface MaterialTagApplyResult {
  taggedParts: number;
  appliedParts: number;
  skippedMatcaps: number;
  effectBatchCount: number;
  effectBatchParts: number;
  diagnostics: unknown[];
}

export interface WorldForgeMaterialTagRuntimeOptions {
  scene: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  runtimeIndex: RuntimeIndex;
  batchParent: THREE.Group;
  objectGroups: Map<string, THREE.Group>;
  materialTagPolicy: MapMaterialTagPolicy;
  effectBatchMinGroupSize?: number;
}

/**
 * Map-owned material-tag runtime.
 *
 * Tags are compiled once while a rendered map is built. Parts that need a
 * runtime material stay out of the primitive batch, receive their effect, and
 * are then regrouped by EffectBatchCoordinator when their resolved geometry,
 * material and effect signatures match. Render-scheme changes only restore the
 * compiled shader state; they never re-run tag compilation or rebuild batches.
 */
export class WorldForgeMaterialTagRuntime {
  private readonly effectRuntime = createEffectRuntime().runtime;
  private readonly slotManager: EffectSlotManagerWithBatches;
  private readonly effectTargets = new Set<THREE.Object3D>();
  private readonly surfaceBindings: Array<{
    object: THREE.Object3D;
    binding: Record<string, unknown>;
  }> = [];
  private readonly objectWorldMatrices = new Map<string, THREE.Matrix4>();
  private readonly particleEffects = new Set<NonNullable<ReturnType<typeof createParticleEffect>>>();
  private readonly hiddenEffectMeshes = new Set<THREE.Object3D>();
  private readonly waterInstances: InstanceType<typeof ModelWaterInstances> | null;
  private lastElapsedSeconds: number | null = null;
  private lastResult: MaterialTagApplyResult = emptyResult();

  constructor(private readonly options: WorldForgeMaterialTagRuntimeOptions) {
    this.slotManager = new EffectSlotManager({
      scene: options.scene,
      runtimeIndex: options.runtimeIndex,
      standaloneParent: options.batchParent,
      batchParent: options.batchParent,
      effectBatchMinGroupSize: options.effectBatchMinGroupSize ?? 8
    }) as EffectSlotManagerWithBatches;
    this.waterInstances = options.renderer
      ? new ModelWaterInstances(options.scene, options.renderer)
      : null;
  }

  apply(modelsRoot: THREE.Object3D): MaterialTagApplyResult {
    this.clearRoutedEffects();
    this.effectTargets.clear();
    this.surfaceBindings.length = 0;
    const result = emptyResult();
    const modelRoots: THREE.Object3D[] = [];
    modelsRoot.traverse((object) => {
      if (object.userData.materialTagSource) modelRoots.push(object);
    });

    for (const modelRoot of modelRoots) {
      const source = modelRoot.userData.materialTagSource as TaggedModelSource;
      const modelId = String(modelRoot.userData.mapObjectId ?? '');
      const model = toCompilerModel(source, this.options.materialTagPolicy);
      if (model.parts.length === 0) continue;
      const objects = new Map<string, THREE.Object3D>();
      modelRoot.traverse((object) => {
        const nodeId = typeof object.userData.nodeId === 'string' ? object.userData.nodeId : '';
        if (nodeId) objects.set(nodeId, object);
      });
      const compiled = compileModelMaterialTags(model, materialTagVocabulary);
      result.diagnostics.push(...compiled.diagnostics);
      this.applyRoutedEffects(modelRoot, modelId, model, objects, compiled.byPartId);
      for (const [rawPartId, entry] of compiled.byPartId) {
        if (entry.effectiveTags.length === 0) continue;
        result.taggedParts += 1;
        const object = objects.get(rawPartId);
        if (!object) continue;
        const globalPartId = modelId ? `${modelId}:${rawPartId}` : rawPartId;
        object.userData.rawNodeId = rawPartId;
        object.userData.nodeId = globalPartId;
        object.userData.partId = rawPartId;
        let applied = false;
        if (entry.effectPackage?.materialLayers?.length) {
          const appliedEffect = this.slotManager.applyPackage(
            { object, partId: globalPartId, nodeId: globalPartId },
            entry.effectPackage as Record<string, unknown>,
            {
              runtime: this.effectRuntime,
              geometryFamily: geometryFamily(entry.part),
              source: 'material-tags'
            }
          ) as { target?: THREE.Object3D; effectBatch?: EffectBatchResult };
          if (appliedEffect.target) this.effectTargets.add(appliedEffect.target);
          if (appliedEffect.effectBatch?.batchMesh) this.effectTargets.add(appliedEffect.effectBatch.batchMesh);
          applied = true;
        }
        if (entry.materialBindings?.surface) {
          const binding = entry.materialBindings.surface;
          this.surfaceBindings.push({ object, binding });
          applied = applySurfaceBinding(object, binding, this.options.scene.environment) > 0 || applied;
          markSurfaceBinding(object, binding);
        }
        if (entry.materialBindings?.matcap) result.skippedMatcaps += 1;
        if (applied) result.appliedParts += 1;
      }
    }

    for (const batch of this.getBatchMeshes()) this.effectTargets.add(batch);
    this.captureObjectTransforms();
    result.effectBatchCount = this.getBatchMeshes().length;
    result.effectBatchParts = this.getBatchResults().reduce(
      (sum, entry) => sum + (entry.partIds?.length ?? 0),
      0
    );
    this.lastResult = result;
    return { ...result, diagnostics: [...result.diagnostics] };
  }

  getStats(): Pick<MaterialTagApplyResult, 'effectBatchCount' | 'effectBatchParts'> {
    return {
      effectBatchCount: this.lastResult.effectBatchCount,
      effectBatchParts: this.lastResult.effectBatchParts
    };
  }

  getBatchMeshes(): THREE.InstancedMesh[] {
    return this.getBatchResults()
      .map((entry) => entry.batchMesh)
      .filter((mesh): mesh is THREE.InstancedMesh => Boolean(mesh));
  }

  /** Restore tag-owned shader patches after a temporary render-scheme effect was removed. */
  restoreShaderEffects(): number {
    let restored = 0;
    for (const target of this.activeEffectTargets()) {
      const layers = Array.isArray(target.userData.effectSlots)
        ? target.userData.effectSlots.filter((layer: { route?: string }) => layer?.route === 'shaderPatch')
        : [];
      if (!layers.length) continue;
      this.effectRuntime.applyToObject3D(target, {
        schemaVersion: '1.0',
        materialLayers: layers.map((layer: { type?: string }) => layer.type).filter(Boolean),
        layerParams: Object.fromEntries(layers.map((layer: { type?: string; params?: Record<string, unknown> }) => [
          layer.type,
          layer.params ?? {}
        ]))
      });
      restored += 1;
    }
    return restored;
  }

  updateRuntimeUniforms(elapsedSeconds: number, camera?: THREE.Camera): number {
    let updated = 0;
    for (const target of this.activeEffectTargets()) {
      updated += this.effectRuntime.updateRuntimeUniforms(target, {
        uTime: elapsedSeconds,
        uChargeLevel: 1
      });
    }
    const deltaTime = this.lastElapsedSeconds === null
      ? 0
      : Math.min(0.1, Math.max(0, elapsedSeconds - this.lastElapsedSeconds));
    this.lastElapsedSeconds = elapsedSeconds;
    tickParticleEffects(deltaTime, camera ?? null, null, this.options.renderer?.domElement.height ?? null);
    if (camera) this.waterInstances?.update(deltaTime, camera);
    return updated;
  }

  syncEnvironment(environmentMap: THREE.Texture | null): number {
    let updated = 0;
    for (const entry of this.surfaceBindings) {
      if (!entry.object.parent) continue;
      updated += applySurfaceBinding(entry.object, entry.binding, environmentMap);
    }
    for (const batch of this.getBatchMeshes()) {
      const materials = Array.isArray(batch.material) ? batch.material : [batch.material];
      for (const material of materials) {
        const binding = material.userData.worldforgeMaterialSurfaceBinding;
        if (binding && typeof binding === 'object') {
          updated += applyMaterialSurfaceBinding(material, binding as Record<string, unknown>, environmentMap);
        }
      }
    }
    return updated;
  }

  /** Keep regrouped effect instances aligned while their editable object group moves. */
  syncObjectTransform(objectId: string): void {
    const group = this.options.objectGroups.get(objectId);
    const previousWorld = this.objectWorldMatrices.get(objectId);
    if (!group || !previousWorld) return;
    group.updateWorldMatrix(true, true);
    const nextWorld = group.matrixWorld.clone();
    if (matricesEqual(previousWorld, nextWorld)) return;
    const deltaWorld = nextWorld.clone().multiply(previousWorld.clone().invert());
    const prefix = `${objectId}:`;
    for (const entry of this.getBatchResults()) {
      const batch = entry.batchMesh;
      if (!batch?.parent || !entry.partIds?.length) continue;
      batch.parent.updateWorldMatrix(true, false);
      const parentWorld = batch.parent.matrixWorld;
      const parentInverse = parentWorld.clone().invert();
      let changed = false;
      for (let instanceId = 0; instanceId < entry.partIds.length; instanceId += 1) {
        if (!entry.partIds[instanceId]?.startsWith(prefix)) continue;
        const local = new THREE.Matrix4();
        batch.getMatrixAt(instanceId, local);
        const world = parentWorld.clone().multiply(local);
        const nextLocal = parentInverse.clone().multiply(deltaWorld).multiply(world);
        batch.setMatrixAt(instanceId, nextLocal);
        changed = true;
      }
      if (!changed) continue;
      batch.instanceMatrix.needsUpdate = true;
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
    }
    this.objectWorldMatrices.set(objectId, nextWorld);
  }

  dispose(): void {
    this.clearRoutedEffects();
    this.effectTargets.clear();
    this.surfaceBindings.length = 0;
    this.objectWorldMatrices.clear();
  }

  private applyRoutedEffects(
    modelRoot: THREE.Object3D,
    modelId: string,
    model: ReturnType<typeof toCompilerModel>,
    objects: Map<string, THREE.Object3D>,
    compiledByPartId: Map<string, {
      effectiveTags: unknown[];
      runtimeEffectPackage?: { companionEffects?: Array<{ type?: string; params?: Record<string, unknown> }> };
    }>
  ): void {
    const partsByParent = new Map<string, typeof model.parts>();
    for (const part of model.parts) {
      if (!part.parent) continue;
      const siblings = partsByParent.get(part.parent) ?? [];
      siblings.push(part);
      partsByParent.set(part.parent, siblings);
    }

    for (const part of model.parts) {
      const explicitFire = readTag(part.tags, 'fire') as MaterialTagFireEntry | null;
      if (canCreateParticleTextures() && explicitFire && Number(explicitFire.value) > 0) {
        const anchor = objects.get(part.id);
        if (anchor) {
          const placeholders = part.isGroup
            ? collectDirectMeshObjects(part.id, partsByParent, objects)
            : [anchor];
          const configs = createMaterialTagFireConfigs(
            anchor,
            explicitFire,
            (materialTagVocabulary as { tags: { fire: MaterialTagFireVocabulary } }).tags.fire
          );
          const created = configs.flatMap((config) => {
            const effect = createParticleEffect(
              { attachTo: anchor, scene: this.options.scene },
              { config }
            );
            return effect ? [effect] : [];
          });
          if (created.length > 0) {
            created.forEach((effect) => this.particleEffects.add(effect));
            placeholders.forEach((placeholder) => {
              placeholder.visible = false;
              this.hiddenEffectMeshes.add(placeholder);
            });
          }
        }
      }

      const explicitSmoke = readTag(part.tags, 'smoke');
      if (canCreateParticleTextures() && explicitSmoke && Number(explicitSmoke.value) >= 0.25) {
        const anchor = objects.get(part.id);
        const compiled = compiledByPartId.get(part.id);
        const smoke = compiled?.runtimeEffectPackage?.companionEffects?.find(
          (effect) => effect.type === 'Particles:smoke'
        );
        if (anchor && smoke) {
          const effect = createParticleEffect(
            { attachTo: anchor, scene: this.options.scene },
            { preset: 'smoke', overrides: smoke.params ?? {} }
          );
          if (effect) this.particleEffects.add(effect);
        }
      }
    }

    if (!this.waterInstances) return;
    const poolEntries: Array<{ partId: string; group: THREE.Object3D; source: THREE.Mesh }> = [];
    const fallEntries: Array<{ partId: string; source: THREE.Mesh }> = [];
    for (const part of model.parts) {
      if (part.isGroup) continue;
      const entry = compiledByPartId.get(part.id);
      const water = entry?.effectiveTags.find((tag) => (
        tag !== null
        && typeof tag === 'object'
        && (tag as { tag?: unknown }).tag === 'water'
      )) as { value?: unknown } | undefined;
      const source = objects.get(part.id) as THREE.Mesh | undefined;
      if (!source?.isMesh || (water?.value !== 'pool' && water?.value !== 'fall')) continue;
      if (water.value === 'pool') poolEntries.push({ partId: part.id, group: modelRoot, source });
      else fallEntries.push({ partId: part.id, source });
    }

    for (const group of groupAdjacentPools(poolEntries)) {
      const surfaceReference = selectMergedPoolReference(group);
      const water = this.waterInstances.createMergedPool({
        modelId,
        entries: group,
        surfaceReference,
        containerBottom: findPoolContainerBottom(surfaceReference?.entry?.source)
      });
      if (!water) continue;
      applyUniformParams(water.material?.uniforms, waterTagRuntime().poolTuning);
      for (const entry of group) {
        entry.source.visible = false;
        this.hiddenEffectMeshes.add(entry.source);
      }
    }

    for (const entry of fallEntries) {
      const waterfall = this.waterInstances.create({
        modelId,
        globalPartId: `${modelId}:${entry.partId}`,
        ref: { object: entry.source },
        rootGroup: modelRoot,
        kind: 'fall'
      });
      if (!waterfall) continue;
      applyUniformParams(waterfall.material?.uniforms, waterTagRuntime().fallTuning);
      entry.source.visible = false;
      this.hiddenEffectMeshes.add(entry.source);
    }
  }

  private clearRoutedEffects(): void {
    for (const effect of this.particleEffects) removeParticleEffect(effect);
    this.particleEffects.clear();
    this.waterInstances?.disposeAll();
    for (const mesh of this.hiddenEffectMeshes) mesh.visible = true;
    this.hiddenEffectMeshes.clear();
    this.lastElapsedSeconds = null;
  }

  private getBatchResults(): EffectBatchResult[] {
    return [...(this.slotManager.effectBatchCoordinator?.batches.values() ?? [])];
  }

  private activeEffectTargets(): THREE.Object3D[] {
    return [...this.effectTargets].filter((target) => Boolean(target.parent));
  }

  private captureObjectTransforms(): void {
    this.objectWorldMatrices.clear();
    for (const [objectId, group] of this.options.objectGroups) {
      group.updateWorldMatrix(true, false);
      this.objectWorldMatrices.set(objectId, group.matrixWorld.clone());
    }
  }
}

function applySurfaceBinding(
  object: THREE.Object3D,
  binding: Record<string, unknown>,
  environmentMap: THREE.Texture | null
): number {
  let updated = applyMaterialSurfaceBinding(object, binding, environmentMap);
  if (binding.environment !== true || environmentMap) return updated;
  object.traverse((target) => {
    const mesh = target as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || !('envMap' in material) || material.envMap === null) continue;
      material.envMap = null;
      material.needsUpdate = true;
      updated += 1;
    }
  });
  return updated;
}

function markSurfaceBinding(object: THREE.Object3D, binding: Record<string, unknown>): void {
  object.traverse((target) => {
    const mesh = target as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.userData.worldforgeMaterialSurfaceBinding = binding;
  });
}

function geometryFamily(part: Record<string, unknown> | undefined): string | null {
  const mesh = part?.mesh as { type?: string; params?: Record<string, unknown> } | undefined;
  if (!mesh?.type) return null;
  return `${mesh.type}|${stableStringify(mesh.params ?? {})}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function matricesEqual(left: THREE.Matrix4, right: THREE.Matrix4): boolean {
  return left.elements.every((value, index) => Math.abs(value - right.elements[index]) < 1e-8);
}

function emptyResult(): MaterialTagApplyResult {
  return {
    taggedParts: 0,
    appliedParts: 0,
    skippedMatcaps: 0,
    effectBatchCount: 0,
    effectBatchParts: 0,
    diagnostics: []
  };
}

function readTag(tags: unknown[], name: string): { tag: string; value?: unknown; variant?: string } | null {
  const tag = tags.find((entry) => (
    entry !== null
    && typeof entry === 'object'
    && (entry as { tag?: unknown }).tag === name
  ));
  return tag as { tag: string; value?: unknown; variant?: string } | null;
}

function canCreateParticleTextures(): boolean {
  return typeof document !== 'undefined' && typeof document.createElementNS === 'function';
}

function collectDirectMeshObjects(
  parentId: string,
  partsByParent: Map<string, ReturnType<typeof toCompilerModel>['parts']>,
  objects: Map<string, THREE.Object3D>
): THREE.Object3D[] {
  return (partsByParent.get(parentId) ?? [])
    .filter((part) => !part.isGroup)
    .map((part) => objects.get(part.id))
    .filter((object): object is THREE.Object3D => Boolean(object));
}

function groupAdjacentPools<T extends { source: THREE.Mesh }>(entries: T[]): T[][] {
  if (entries.length <= 1) return entries.length ? [entries] : [];
  const bounds = entries.map((entry) => {
    entry.source.updateWorldMatrix(true, false);
    return new THREE.Box3().setFromObject(entry.source);
  });
  const parent = entries.map((_, index) => index);
  const find = (start: number): number => {
    let index = start;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => { parent[find(left)] = find(right); };
  for (let left = 0; left < bounds.length; left += 1) {
    for (let right = left + 1; right < bounds.length; right += 1) {
      const diagonal = Math.max(
        bounds[left].getSize(new THREE.Vector3()).length(),
        bounds[right].getSize(new THREE.Vector3()).length()
      );
      const gapX = Math.max(0, bounds[left].min.x - bounds[right].max.x, bounds[right].min.x - bounds[left].max.x);
      const gapY = Math.max(0, bounds[left].min.y - bounds[right].max.y, bounds[right].min.y - bounds[left].max.y);
      const gapZ = Math.max(0, bounds[left].min.z - bounds[right].max.z, bounds[right].min.z - bounds[left].max.z);
      if (Math.hypot(gapX, gapY, gapZ) <= diagonal * 1e-4 + 1e-6) union(left, right);
    }
  }
  const groups = new Map<number, T[]>();
  entries.forEach((entry, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function findPoolContainerBottom(source?: THREE.Mesh): number | null {
  if (!source) return null;
  source.updateWorldMatrix(true, false);
  const waterBounds = new THREE.Box3().setFromObject(source);
  const waterSize = waterBounds.getSize(new THREE.Vector3());
  const maxWidth = Math.max(waterSize.x * 1.35, waterSize.x + 0.35);
  const maxDepth = Math.max(waterSize.z * 1.35, waterSize.z + 0.35);
  let ancestor = source.parent;
  while (ancestor) {
    ancestor.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3().setFromObject(ancestor);
    const size = bounds.getSize(new THREE.Vector3());
    const enclosesFootprint = size.x >= waterSize.x * 0.9
      && size.z >= waterSize.z * 0.9
      && size.x <= maxWidth
      && size.z <= maxDepth;
    if (enclosesFootprint && bounds.min.y < waterBounds.min.y - 0.05) return bounds.min.y;
    ancestor = ancestor.parent;
  }
  return null;
}

function applyUniformParams(
  uniforms: Record<string, { value: unknown }> | undefined,
  params: Record<string, unknown>
): void {
  if (!uniforms) return;
  const vectors = new Map<string, [number, number]>();
  for (const [name, value] of Object.entries(params)) {
    const vector = name.match(/^(.+)_([xy])$/);
    if (vector && typeof value === 'number') {
      const uniform = uniforms[vector[1]]?.value as { x?: number; y?: number; set?: (x: number, y: number) => void } | undefined;
      if (uniform?.set) {
        const pending = vectors.get(vector[1]) ?? [Number(uniform.x) || 0, Number(uniform.y) || 0];
        pending[vector[2] === 'x' ? 0 : 1] = value;
        vectors.set(vector[1], pending);
      }
      continue;
    }
    if (uniforms[name]) uniforms[name].value = value;
  }
  for (const [name, value] of vectors) {
    const vector = uniforms[name].value as { set: (x: number, y: number) => void };
    vector.set(value[0], value[1]);
  }
}

function waterTagRuntime(): { poolTuning: Record<string, unknown>; fallTuning: Record<string, unknown> } {
  return (materialTagVocabulary as {
    tags: { water: { runtime: { poolTuning: Record<string, unknown>; fallTuning: Record<string, unknown> } } };
  }).tags.water.runtime;
}

function toCompilerModel(source: TaggedModelSource, materialTagPolicy: MapMaterialTagPolicy): {
  name: string;
  style?: string;
  parts: Array<{
    id: string;
    parent?: string;
    isGroup: boolean;
    tags: unknown[];
    mesh?: TaggedNode['mesh'];
  }>;
} {
  return {
    name: source.name ?? 'worldforge-asset',
    ...(source.style ? { style: source.style } : {}),
    parts: (source.nodes ?? []).map((node) => ({
      id: node.id,
      ...(node.parent ? { parent: node.parent } : {}),
      isGroup: !node.mesh,
      tags: filterMaterialTags(node.tags, materialTagPolicy),
      ...(node.mesh ? { mesh: node.mesh } : {})
    }))
  };
}
