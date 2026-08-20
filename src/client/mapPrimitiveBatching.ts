import * as THREE from 'three';
import {
  AIPrimitiveBatcher,
  RuntimeIndex
} from '@voxel-studio/render-runtime';
import {
  applyMaterialSurfaceBinding,
  compileModelMaterialTags,
  createEffectRuntime
} from '@voxel-studio/render-runtime/effects';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import type { MapAsset } from '../shared/map';
import { enforceReadableFoliageColors } from '../shared/modelColorPolicy';
import { filterMaterialTags, type MapMaterialTagPolicy } from '../shared/materialTagPolicy';
import { buildModelGroup } from './modelRenderer';
import { MapObjectCulling, type MapObjectCullingStats } from './mapObjectCulling';
import { requiresRuntimeStandaloneMaterialTag } from './mapMaterialTagBatchPolicy';
import { WorldForgeMaterialTagRuntime } from './materialTagRuntimeAdapter';

export interface MapPrimitiveBatchInput {
  objectId: string;
  objectGroup: THREE.Group;
  asset: MapAsset;
  assetTags: string[];
}

export interface MapPrimitiveBatchOptions {
  scene: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  modelsRoot: THREE.Group;
  materialTagPolicy: MapMaterialTagPolicy;
}

export interface MapPrimitiveBatchResult {
  root: THREE.Group;
  runtimeIndex: RuntimeIndex;
  handledObjectIds: Set<string>;
  pickables: THREE.Object3D[];
  syncObjectTransform: (objectId: string) => void;
  updateCulling: (camera: THREE.Camera, maxDistance: number) => MapObjectCullingStats;
  updateMaterialEffects: (elapsedSeconds: number, camera: THREE.Camera) => void;
  restoreMaterialEffects: () => void;
  syncEnvironment: (environmentMap: THREE.Texture | null) => void;
  getBatchMeshes: () => THREE.Object3D[];
  getStats: () => MapPrimitiveBatchStats;
  dispose: () => void;
}

export interface MapPrimitiveBatchStats {
  totalParts: number;
  batchableParts: number;
  instancedParts: number;
  batchedMeshParts: number;
  fallbackMeshParts: number;
  batchCount: number;
  effectBatchCount: number;
  effectBatchParts: number;
  runtimeIndexPartRefs: number;
  orphanPartRefs: number;
  orphanInstanceRefs: number;
  culled: number;
  tested: number;
}

interface ModelNode {
  id: string;
  parent?: string;
  tags?: unknown[];
  transform?: {
    pos?: [number, number, number];
    quat?: [number, number, number, number];
    scale?: [number, number, number];
  };
  mesh?: {
    type: string;
    params?: Record<string, unknown>;
    color?: number;
    material?: Record<string, unknown>;
  };
}

interface BatchPart {
  id: string;
  parent?: string;
  isGroup: boolean;
  tags: unknown[];
  offset: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
  mesh?: {
    type: string;
    geometry: Record<string, unknown>;
    material: Record<string, unknown>;
  };
  materialTagBaseRecipe?: Record<string, unknown>;
  materialTagRequiresRuntimeStandalone?: boolean;
}

interface PreparedTemplate {
  group: THREE.Group;
  parts: BatchPart[];
  parentChains: Map<string, THREE.Matrix4>;
  usedByFallback: boolean;
}

/**
 * Shared, scene-level primitive batching for generated map assets.
 *
 * Unlike the former `mapAssetInstancing` shortcut, this uses the same runtime
 * path as Voxel Studio: primitive families from every asset share batches, the
 * batch key includes the material-tag base recipe, and tag effects that need a
 * per-object runtime deliberately stay as regular meshes.
 */
export async function buildMapPrimitiveBatches(
  inputs: MapPrimitiveBatchInput[],
  options: MapPrimitiveBatchOptions
): Promise<MapPrimitiveBatchResult> {
  const root = new THREE.Group();
  root.name = 'mapPrimitiveBatches';
  const runtimeIndex = new RuntimeIndex();
  const objectCulling = new MapObjectCulling(runtimeIndex);
  let cullingStats: MapObjectCullingStats = { tested: 0, culled: 0 };
  const surfaceBindings: Array<{ material: THREE.Material; binding: Record<string, unknown> }> = [];
  const effectRuntime = createEffectRuntime().runtime;
  const batcher = new AIPrimitiveBatcher({
    runtimeIndex,
    celBatchable: true,
    batchedMeshable: true,
    onBatchMaterialReady: (material, _source, baseRecipe, mesh) => {
      applyBaseRecipe(material, baseRecipe, mesh, effectRuntime, surfaceBindings);
    }
  });
  batcher.resetScene(root);

  const templates = new Map<string, Promise<PreparedTemplate>>();
  const preparedTemplates = new Set<PreparedTemplate>();
  const handledObjectIds = new Set<string>();
  const objectGroups = new Map<string, THREE.Group>();

  for (const input of inputs) {
    objectGroups.set(input.objectId, input.objectGroup);
    const template = await takeTemplate(input.asset, templates, options.materialTagPolicy);
    preparedTemplates.add(template);
    const batchableNodeIds = new Set<string>();
    batcher.reset();
    for (const part of template.parts) {
      const assessment = batcher.canBatch(part, { modelId: input.objectId });
      if (!assessment.eligible) continue;
      if (batcher.stagePart(part, assessment, input.objectId, template.parentChains.get(part.id))) {
        batchableNodeIds.add(part.id);
      }
    }
    input.objectGroup.updateWorldMatrix(true, false);
    batcher.compile(input.objectId, input.objectGroup);
    template.usedByFallback = addFallbackVisual(input, template.group, batchableNodeIds, runtimeIndex) || template.usedByFallback;
    handledObjectIds.add(input.objectId);
  }

  const materialTagRuntime = new WorldForgeMaterialTagRuntime({
    scene: options.scene,
    renderer: options.renderer,
    runtimeIndex,
    batchParent: root,
    objectGroups,
    materialTagPolicy: options.materialTagPolicy,
    effectBatchMinGroupSize: 8
  });
  materialTagRuntime.apply(options.modelsRoot);
  const getBatchMeshes = (): THREE.Object3D[] => [
    ...batcher.getInstancedMeshes(),
    ...batcher.getBatchedMeshes(),
    ...materialTagRuntime.getBatchMeshes()
  ];
  const pickables = getBatchMeshes();
  const resolveHit = (hit: THREE.Intersection): string | null => {
    const partId = runtimeIndex.getPartIdFromHit(hit);
    if (typeof partId !== 'string') return null;
    const separator = partId.lastIndexOf(':');
    return separator > 0 ? partId.slice(0, separator) : null;
  };
  for (const mesh of pickables) mesh.userData.resolveMapObjectId = resolveHit;

  return {
    root,
    runtimeIndex,
    handledObjectIds,
    pickables,
    syncObjectTransform: (objectId) => {
      const changed = objectGroups.get(objectId);
      if (!changed) return;
      for (const [candidateId, group] of objectGroups) {
        if (group !== changed && !isDescendantOf(group, changed)) continue;
        batcher.updateModelInstanceMatrices(candidateId);
        materialTagRuntime.syncObjectTransform(candidateId);
      }
    },
    updateCulling: (camera, maxDistance) => {
      cullingStats = objectCulling.update(camera, maxDistance);
      return cullingStats;
    },
    updateMaterialEffects: (elapsedSeconds, camera) => {
      effectRuntime.updateRuntimeUniforms(root, {
        uTime: elapsedSeconds,
        uChargeLevel: 1
      });
      materialTagRuntime.updateRuntimeUniforms(elapsedSeconds, camera);
    },
    restoreMaterialEffects: () => {
      restoreBaseMaterialEffects(root, effectRuntime);
      materialTagRuntime.restoreShaderEffects();
    },
    syncEnvironment: (environmentMap) => {
      materialTagRuntime.syncEnvironment(environmentMap);
    },
    getBatchMeshes,
    getStats: () => {
      const audit = batcher.getSceneAudit();
      const materialStats = materialTagRuntime.getStats();
      const runtimeAudit = auditRuntimeIndex(runtimeIndex);
      const instancedParts = audit.instancedParts ?? 0;
      const batchedMeshParts = (audit.batchedMeshParts ?? 0) + materialStats.effectBatchParts;
      // RuntimeIndex is the only count whose unit is consistently a live map
      // part. AIPrimitiveBatcher audit fields are source-template counts while
      // EffectBatchCoordinator reports expanded instances, so subtracting one
      // from the other used to hide hundreds of real standalone draws.
      const totalParts = runtimeAudit.partToRenderCount;
      return {
        totalParts,
        batchableParts: totalParts,
        instancedParts,
        batchedMeshParts,
        fallbackMeshParts: Math.max(0, totalParts - instancedParts - batchedMeshParts),
        batchCount: (audit.batchCount ?? 0) + materialStats.effectBatchCount,
        ...materialStats,
        runtimeIndexPartRefs: runtimeAudit.partToRenderCount,
        orphanPartRefs: runtimeAudit.orphanPartRefs,
        orphanInstanceRefs: runtimeAudit.orphanInstanceRefs,
        ...cullingStats
      };
    },
    dispose: () => {
      objectCulling.dispose();
      surfaceBindings.length = 0;
      materialTagRuntime.dispose();
      batcher.dispose();
      runtimeIndex.clear();
      for (const template of preparedTemplates) disposeUnusedTemplateResources(template);
    }
  };
}

async function takeTemplate(
  asset: MapAsset,
  templates: Map<string, Promise<PreparedTemplate>>,
  materialTagPolicy: MapMaterialTagPolicy
): Promise<PreparedTemplate> {
  let template = templates.get(asset.id);
  if (!template) {
    template = prepareTemplate(asset, materialTagPolicy);
    templates.set(asset.id, template);
  }
  return template;
}

async function prepareTemplate(asset: MapAsset, materialTagPolicy: MapMaterialTagPolicy): Promise<PreparedTemplate> {
  const modelJson = enforceReadableFoliageColors(asset.modelJson);
  const group = await buildModelGroup(modelJson);
  const nodes = readNodes(modelJson);
  const parts = nodes.map((node) => toBatchPart(node, materialTagPolicy));
  const compilerModel = { name: asset.name, parts };
  const compiled = compileModelMaterialTags(compilerModel, materialTagVocabulary);
  for (const entry of compiled.byPartId.values()) {
    const part = entry.part as BatchPart | undefined;
    if (!part) continue;
    if (entry.baseRecipe) part.materialTagBaseRecipe = entry.baseRecipe as Record<string, unknown>;
    if (requiresRuntimeStandaloneMaterialTag(entry)) part.materialTagRequiresRuntimeStandalone = true;
    else delete part.materialTagRequiresRuntimeStandalone;
  }

  const rootOffset = new THREE.Matrix4().makeTranslation(group.position.x, group.position.y, group.position.z);
  const byId = new Map(parts.map((part) => [part.id, part]));
  const parentChains = new Map<string, THREE.Matrix4>();
  const chainFor = (part: BatchPart, visited = new Set<string>()): THREE.Matrix4 => {
    const cached = parentChains.get(part.id);
    if (cached) return cached;
    const chain = rootOffset.clone();
    const parent = part.parent ? byId.get(part.parent) : undefined;
    if (parent && !visited.has(parent.id)) {
      const parentChain = chainFor(parent, new Set([...visited, part.id]));
      chain.copy(parentChain).multiply(matrixForPart(parent));
    }
    parentChains.set(part.id, chain);
    return chain;
  };
  for (const part of parts) chainFor(part);
  return { group, parts, parentChains, usedByFallback: false };
}

function readNodes(modelJson: unknown): ModelNode[] {
  const nodes = (modelJson as { nodes?: unknown[] })?.nodes;
  return Array.isArray(nodes) ? nodes.filter((node): node is ModelNode => Boolean(node && typeof node === 'object' && typeof (node as ModelNode).id === 'string')) : [];
}

function toBatchPart(node: ModelNode, materialTagPolicy: MapMaterialTagPolicy): BatchPart {
  const position = node.transform?.pos ?? [0, 0, 0];
  const quaternion = node.transform?.quat ?? [0, 0, 0, 1];
  const scale = node.transform?.scale ?? [1, 1, 1];
  const material = { ...(node.mesh?.material ?? {}) };
  if (material.color === undefined && node.mesh?.color !== undefined) material.color = node.mesh.color;
  return {
    id: node.id,
    ...(node.parent ? { parent: node.parent } : {}),
    isGroup: !node.mesh,
    tags: filterMaterialTags(node.tags, materialTagPolicy),
    offset: { x: position[0], y: position[1], z: position[2] },
    position: { x: position[0], y: position[1], z: position[2] },
    quaternion: { x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    ...(node.mesh ? { mesh: { type: node.mesh.type, geometry: node.mesh.params ?? {}, material } } : {})
  };
}

function matrixForPart(part: BatchPart): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(part.offset.x, part.offset.y, part.offset.z),
    new THREE.Quaternion(part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w),
    new THREE.Vector3(part.scale.x, part.scale.y, part.scale.z)
  );
}

function addFallbackVisual(
  input: MapPrimitiveBatchInput,
  template: THREE.Group,
  batchableNodeIds: Set<string>,
  runtimeIndex: RuntimeIndex
): boolean {
  const visual = cloneAssetVisual(template);
  const batchedMeshes: THREE.Object3D[] = [];
  visual.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && batchableNodeIds.has(String(child.userData.nodeId ?? ''))) {
      batchedMeshes.push(child);
    }
  });
  for (const mesh of batchedMeshes) mesh.removeFromParent();
  if (!hasVisibleMesh(visual)) {
    addSelectionProxy(input.objectGroup, template);
    return false;
  }
  visual.traverse((child) => {
    child.userData.mapObjectId = input.objectId;
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      const rawPartId = String(child.userData.nodeId ?? '');
      if (rawPartId) {
        runtimeIndex.registerMesh(`${input.objectId}:${rawPartId}`, child, {
          modelId: input.objectId,
          rawPartId,
          source: 'worldforge-map-fallback',
          mode: 'fallback'
        });
      }
    }
  });
  input.objectGroup.add(visual);
  return true;
}

function applyBaseRecipe(
  material: THREE.Material,
  recipe: Record<string, unknown> | null,
  mesh: THREE.Object3D | null,
  effectRuntime: ReturnType<typeof createEffectRuntime>['runtime'],
  surfaceBindings?: Array<{ material: THREE.Material; binding: Record<string, unknown> }>
): void {
  if (!recipe) return;
  material.userData.worldforgeBaseMaterialTagRecipe = recipe;
  const effectPackage = recipe.effectPackage as { materialLayers?: Array<{ type: string; params?: Record<string, unknown> }> } | undefined;
  const layers = effectPackage?.materialLayers ?? [];
  if (layers.length) {
    effectRuntime.applyToMaterial(material, {
      schemaVersion: '1.0',
      materialLayers: layers.map((layer) => layer.type),
      layerParams: Object.fromEntries(layers.map((layer) => [layer.type, layer.params ?? {}]))
    });
  }
  const bindings = recipe.materialBindings as { surface?: Record<string, unknown> } | undefined;
  if (bindings?.surface) {
    applyMaterialSurfaceBinding(material, bindings.surface, null);
    material.userData.worldforgeMaterialSurfaceBinding = bindings.surface;
    if (mesh) mesh.userData.materialTags = mesh.userData.materialTags ?? [];
    surfaceBindings?.push({ material, binding: bindings.surface });
  }
}

/** Reinstall base tag patches after a render-scheme reset removes shared material patches. */
function restoreBaseMaterialEffects(
  root: THREE.Object3D,
  effectRuntime: ReturnType<typeof createEffectRuntime>['runtime']
): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const recipe = material.userData?.worldforgeBaseMaterialTagRecipe;
      if (!recipe || typeof recipe !== 'object') continue;
      applyBaseRecipe(material, recipe as Record<string, unknown>, mesh, effectRuntime);
    }
  });
}

function cloneAssetVisual(template: THREE.Group): THREE.Group {
  const clone = template.clone(true);
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((entry) => entry.clone()) : mesh.material.clone();
  });
  return clone;
}

function hasVisibleMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((child) => { if ((child as THREE.Mesh).isMesh) found = true; });
  return found;
}

function addSelectionProxy(objectGroup: THREE.Group, template: THREE.Object3D): void {
  const bounds = new THREE.Box3().setFromObject(template);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const geometry = new THREE.BoxGeometry(Math.max(0.001, size.x), Math.max(0.001, size.y), Math.max(0.001, size.z));
  geometry.translate(center.x, center.y, center.z);
  const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  proxy.name = 'selectionBounds';
  proxy.visible = false;
  proxy.userData.editorHelper = true;
  proxy.userData.skipShaderApply = true;
  objectGroup.add(proxy);
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function disposeUnusedTemplateResources(template: PreparedTemplate): void {
  template.group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!template.usedByFallback) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material.dispose());
  });
}

function auditRuntimeIndex(runtimeIndex: RuntimeIndex): {
  partToRenderCount: number;
  orphanPartRefs: number;
  orphanInstanceRefs: number;
} {
  let orphanPartRefs = 0;
  let orphanInstanceRefs = 0;
  for (const [batchId, partIds] of runtimeIndex.batchToParts) {
    for (const partId of partIds) {
      const ref = runtimeIndex.partToRender.get(partId);
      if (!ref || ref.batchId !== batchId) orphanPartRefs += 1;
    }
  }
  for (const [partId, ref] of runtimeIndex.partToRender) {
    if (ref.mode !== 'instanced') continue;
    if (!ref.batchId || !runtimeIndex.batchToParts.get(ref.batchId)?.has(partId)) orphanPartRefs += 1;
    if (!ref.object?.isInstancedMesh || typeof ref.instanceId !== 'number' || !Number.isInteger(ref.instanceId) || ref.instanceId < 0) {
      orphanInstanceRefs += 1;
    }
  }
  return {
    partToRenderCount: runtimeIndex.partToRender.size,
    orphanPartRefs,
    orphanInstanceRefs
  };
}
