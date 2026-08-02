import * as THREE from 'three';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import {
  EffectSlotManager,
  applyMaterialSurfaceBinding,
  compileModelMaterialTags
} from '@voxel-studio/render-runtime/effects';

interface TaggedNode {
  id: string;
  parent?: string;
  tags?: unknown[];
  mesh?: {
    type?: string;
    [key: string]: unknown;
  };
}

interface TaggedModelSource {
  name?: string;
  style?: string;
  nodes?: TaggedNode[];
}

export interface MaterialTagApplyResult {
  taggedParts: number;
  appliedParts: number;
  skippedMatcaps: number;
  diagnostics: unknown[];
}

export class WorldForgeMaterialTagRuntime {
  private readonly slotManager: EffectSlotManager;
  private readonly surfaceBindings: Array<{
    object: THREE.Object3D;
    binding: Record<string, unknown>;
  }> = [];

  constructor(
    scene: THREE.Scene,
    private readonly effectRuntime: {
      applyToObject3D(root: THREE.Object3D, effectPackage: Record<string, unknown>): unknown;
    },
    private readonly getEnvironmentMap: () => THREE.Texture | null = () => scene.environment
  ) {
    this.slotManager = new EffectSlotManager({
      scene,
      effectBatchCoordinator: null
    });
  }

  apply(modelsRoot: THREE.Object3D): MaterialTagApplyResult {
    this.surfaceBindings.length = 0;
    const result: MaterialTagApplyResult = {
      taggedParts: 0,
      appliedParts: 0,
      skippedMatcaps: 0,
      diagnostics: []
    };
    const modelRoots: THREE.Object3D[] = [];
    modelsRoot.traverse((object) => {
      if (object.userData.materialTagSource) modelRoots.push(object);
    });

    for (const modelRoot of modelRoots) {
      const source = modelRoot.userData.materialTagSource as TaggedModelSource;
      const model = toCompilerModel(source);
      if (model.parts.length === 0) continue;
      const objects = new Map<string, THREE.Object3D>();
      modelRoot.traverse((object) => {
        const nodeId = typeof object.userData.nodeId === 'string' ? object.userData.nodeId : '';
        if (nodeId) objects.set(nodeId, object);
      });
      const compiled = compileModelMaterialTags(model, materialTagVocabulary);
      result.diagnostics.push(...compiled.diagnostics);
      for (const [partId, entry] of compiled.byPartId) {
        if (entry.effectiveTags.length === 0) continue;
        result.taggedParts += 1;
        const object = objects.get(partId);
        if (!object) continue;
        let applied = false;
        if (entry.effectPackage?.materialLayers?.length) {
          this.slotManager.applyPackage(
            { object, partId, nodeId: partId },
            entry.effectPackage,
            {
              runtime: this.effectRuntime,
              geometryFamily: object.userData.geometryFamily
                ?? (entry.part as { mesh?: { type?: string } } | undefined)?.mesh?.type
                ?? null,
              source: 'material-tags'
            }
          );
          applied = true;
        }
        if (entry.materialBindings?.surface) {
          this.surfaceBindings.push({ object, binding: entry.materialBindings.surface });
          applied = applySurfaceBinding(
            object,
            entry.materialBindings.surface,
            this.getEnvironmentMap()
          ) > 0 || applied;
        }
        if (entry.materialBindings?.matcap) result.skippedMatcaps += 1;
        if (applied) result.appliedParts += 1;
      }
    }
    return result;
  }

  clear(modelsRoot: THREE.Object3D): void {
    this.surfaceBindings.length = 0;
    this.slotManager.clearEffects(modelsRoot);
  }

  syncEnvironment(environmentMap: THREE.Texture | null): number {
    let updated = 0;
    for (const entry of this.surfaceBindings) {
      updated += applySurfaceBinding(entry.object, entry.binding, environmentMap);
    }
    return updated;
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

function toCompilerModel(source: TaggedModelSource): {
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
      tags: Array.isArray(node.tags) ? node.tags : [],
      ...(node.mesh ? { mesh: node.mesh } : {})
    }))
  };
}
