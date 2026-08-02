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
import { buildModelGroup } from './modelRenderer';
import { MapObjectCulling, type MapObjectCullingStats } from './mapObjectCulling';

export interface MapPrimitiveBatchInput {
  objectId: string;
  objectGroup: THREE.Group;
  asset: MapAsset;
  assetTags: string[];
}

export interface MapPrimitiveBatchResult {
  root: THREE.Group;
  runtimeIndex: RuntimeIndex;
  handledObjectIds: Set<string>;
  pickables: THREE.Object3D[];
  syncObjectTransform: (objectId: string) => void;
  updateCulling: (camera: THREE.Camera, maxDistance: number) => MapObjectCullingStats;
  dispose: () => void;
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
export async function buildMapPrimitiveBatches(inputs: MapPrimitiveBatchInput[]): Promise<MapPrimitiveBatchResult> {
  const root = new THREE.Group();
  root.name = 'mapPrimitiveBatches';
  const runtimeIndex = new RuntimeIndex();
  const objectCulling = new MapObjectCulling(runtimeIndex);
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
    const template = await takeTemplate(input.asset, templates);
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

  const pickables = [...batcher.getInstancedMeshes(), ...batcher.getBatchedMeshes()];
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
        if (group === changed || isDescendantOf(group, changed)) batcher.updateModelInstanceMatrices(candidateId);
      }
    },
    updateCulling: (camera, maxDistance) => objectCulling.update(camera, maxDistance),
    dispose: () => {
      objectCulling.dispose();
      surfaceBindings.length = 0;
      batcher.dispose();
      runtimeIndex.clear();
      for (const template of preparedTemplates) disposeUnusedTemplateResources(template);
    }
  };
}

async function takeTemplate(
  asset: MapAsset,
  templates: Map<string, Promise<PreparedTemplate>>
): Promise<PreparedTemplate> {
  let template = templates.get(asset.id);
  if (!template) {
    template = prepareTemplate(asset);
    templates.set(asset.id, template);
  }
  return template;
}

async function prepareTemplate(asset: MapAsset): Promise<PreparedTemplate> {
  const group = await buildModelGroup(asset.modelJson);
  const nodes = readNodes(asset.modelJson);
  const parts = nodes.map(toBatchPart);
  const compilerModel = { name: asset.name, parts };
  const compiled = compileModelMaterialTags(compilerModel, materialTagVocabulary);
  for (const entry of compiled.byPartId.values()) {
    const part = entry.part as BatchPart | undefined;
    if (!part) continue;
    if (entry.baseRecipe) part.materialTagBaseRecipe = entry.baseRecipe as Record<string, unknown>;
    if (entry.effectPackage) part.materialTagRequiresRuntimeStandalone = true;
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

function toBatchPart(node: ModelNode): BatchPart {
  const position = node.transform?.pos ?? [0, 0, 0];
  const quaternion = node.transform?.quat ?? [0, 0, 0, 1];
  const scale = node.transform?.scale ?? [1, 1, 1];
  const material = { ...(node.mesh?.material ?? {}) };
  if (material.color === undefined && node.mesh?.color !== undefined) material.color = node.mesh.color;
  return {
    id: node.id,
    ...(node.parent ? { parent: node.parent } : {}),
    isGroup: !node.mesh,
    tags: Array.isArray(node.tags) ? node.tags : [],
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
  mesh: THREE.Object3D,
  effectRuntime: ReturnType<typeof createEffectRuntime>['runtime'],
  surfaceBindings: Array<{ material: THREE.Material; binding: Record<string, unknown> }>
): void {
  if (!recipe) return;
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
    mesh.userData.materialTags = material.userData.materialTags ?? [];
    surfaceBindings.push({ material, binding: bindings.surface });
  }
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
