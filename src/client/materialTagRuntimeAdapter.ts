import * as THREE from 'three';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import {
  EffectSlotManager,
  applyMaterialSurfaceBinding,
  compileModelMaterialTags,
  createEffectRuntime
} from '@voxel-studio/render-runtime/effects';
import {
  filterMaterialTags,
  type MapMaterialTagPolicy
} from '../shared/materialTagPolicy';

interface TaggedNode {
  id: string;
  parent?: string;
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
  private lastResult: MaterialTagApplyResult = emptyResult();

  constructor(private readonly options: WorldForgeMaterialTagRuntimeOptions) {
    this.slotManager = new EffectSlotManager({
      scene: options.scene,
      runtimeIndex: options.runtimeIndex,
      standaloneParent: options.batchParent,
      batchParent: options.batchParent,
      effectBatchMinGroupSize: options.effectBatchMinGroupSize ?? 8
    }) as EffectSlotManagerWithBatches;
  }

  apply(modelsRoot: THREE.Object3D): MaterialTagApplyResult {
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

  updateRuntimeUniforms(elapsedSeconds: number): number {
    let updated = 0;
    for (const target of this.activeEffectTargets()) {
      updated += this.effectRuntime.updateRuntimeUniforms(target, {
        uTime: elapsedSeconds,
        uChargeLevel: 1
      });
    }
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
    this.effectTargets.clear();
    this.surfaceBindings.length = 0;
    this.objectWorldMatrices.clear();
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
