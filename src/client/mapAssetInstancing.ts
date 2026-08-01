import * as THREE from 'three';
import type { MapAsset } from '../shared/map';
import { buildModelGroup } from './modelRenderer';

const MIN_INSTANCE_COUNT = 4;

export interface MapAssetInstanceInput {
  objectId: string;
  objectGroup: THREE.Group;
  asset: MapAsset;
  assetTags: string[];
}

export interface MapAssetInstanceResult {
  root: THREE.Group;
  handledObjectIds: Set<string>;
  pickables: THREE.InstancedMesh[];
  syncObjectTransform: (objectId: string) => void;
}

interface InstanceBinding {
  objectGroup: THREE.Group;
  entries: Array<{
    mesh: THREE.InstancedMesh;
    instanceId: number;
    templateMatrix: THREE.Matrix4;
  }>;
}

interface ModelNodeSource {
  tags?: unknown[];
  mesh?: {
    material?: {
      transparent?: boolean;
      opacity?: number;
    };
  };
}

/**
 * Host-level batching for repeated map assets. Assets carrying material tags or
 * transparent materials deliberately remain on the regular mesh path so their
 * Voxel Studio material/effect ownership stays isolated.
 */
export async function buildMapAssetInstances(inputs: MapAssetInstanceInput[]): Promise<MapAssetInstanceResult> {
  const root = new THREE.Group();
  root.name = 'mapAssetInstances';
  const handledObjectIds = new Set<string>();
  const pickables: THREE.InstancedMesh[] = [];
  const bindings = new Map<string, InstanceBinding>();

  for (const [assetId, assetInputs] of eligibleGroups(inputs)) {
    const template = await buildModelGroup(assetInputs[0].asset.modelJson);
    template.updateMatrixWorld(true);
    const templateMeshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) templateMeshes.push(object as THREE.Mesh);
    });
    if (templateMeshes.length === 0) continue;

    const assetRoot = new THREE.Group();
    assetRoot.name = `instances:${assetId}`;
    assetRoot.userData.assetTags = [...assetInputs[0].assetTags];
    root.add(assetRoot);
    const batches = templateMeshes.map((source) => {
      const mesh = new THREE.InstancedMesh(source.geometry, cloneMaterial(source.material), assetInputs.length);
      mesh.name = `instances:${assetId}:${source.name || source.uuid}`;
      mesh.castShadow = source.castShadow;
      mesh.receiveShadow = source.receiveShadow;
      mesh.userData = {
        ...source.userData,
        isMapAssetBatch: true,
        assetId,
        instanceObjectIds: assetInputs.map((input) => input.objectId)
      };
      assetRoot.add(mesh);
      pickables.push(mesh);
      return { mesh, templateMatrix: source.matrixWorld.clone() };
    });

    const selectionBounds = new THREE.Box3().setFromObject(template);
    const proxyGeometry = selectionBounds.isEmpty() ? null : selectionProxyGeometry(selectionBounds);
    const proxyMaterial = new THREE.MeshBasicMaterial();
    for (let instanceId = 0; instanceId < assetInputs.length; instanceId += 1) {
      const input = assetInputs[instanceId];
      input.objectGroup.updateWorldMatrix(true, false);
      const binding: InstanceBinding = { objectGroup: input.objectGroup, entries: [] };
      for (const batch of batches) {
        batch.mesh.setMatrixAt(
          instanceId,
          input.objectGroup.matrixWorld.clone().multiply(batch.templateMatrix)
        );
        binding.entries.push({ ...batch, instanceId });
      }
      if (proxyGeometry) {
        const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
        proxy.name = 'selectionBounds';
        proxy.visible = false;
        proxy.userData.editorHelper = true;
        proxy.userData.skipShaderApply = true;
        input.objectGroup.add(proxy);
      }
      bindings.set(input.objectId, binding);
      handledObjectIds.add(input.objectId);
    }
    for (const batch of batches) updateBatchBounds(batch.mesh);
    disposeTemplateMaterials(template);
  }

  return {
    root,
    handledObjectIds,
    pickables,
    syncObjectTransform: (objectId) => syncObjectTree(bindings, objectId)
  };
}

function eligibleGroups(inputs: MapAssetInstanceInput[]): Map<string, MapAssetInstanceInput[]> {
  const grouped = new Map<string, MapAssetInstanceInput[]>();
  for (const input of inputs) {
    if (!isSafeToInstance(input.asset)) continue;
    const list = grouped.get(input.asset.id) ?? [];
    list.push(input);
    grouped.set(input.asset.id, list);
  }
  for (const [assetId, list] of grouped) {
    if (list.length < MIN_INSTANCE_COUNT) grouped.delete(assetId);
  }
  return grouped;
}

function isSafeToInstance(asset: MapAsset): boolean {
  const rawNodes = (asset.modelJson as { nodes?: unknown[] })?.nodes;
  const nodes = Array.isArray(rawNodes) ? rawNodes as ModelNodeSource[] : [];
  if (nodes.length === 0) return false;
  return nodes.every((node) => {
    if (Array.isArray(node.tags) && node.tags.length > 0) return false;
    if (!node.mesh) return true;
    const material = node.mesh.material ?? {};
    return material.transparent !== true && Number(material.opacity ?? 1) >= 0.999;
  });
}

function cloneMaterial(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  return Array.isArray(material) ? material.map((entry) => entry.clone()) : material.clone();
}

function selectionProxyGeometry(bounds: THREE.Box3): THREE.BoxGeometry {
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const geometry = new THREE.BoxGeometry(
    Math.max(0.001, size.x),
    Math.max(0.001, size.y),
    Math.max(0.001, size.z)
  );
  geometry.translate(center.x, center.y, center.z);
  return geometry;
}

function syncObjectTree(bindings: Map<string, InstanceBinding>, objectId: string): void {
  const rootBinding = bindings.get(objectId);
  if (!rootBinding) return;
  rootBinding.objectGroup.updateWorldMatrix(true, true);
  const dirtyMeshes = new Set<THREE.InstancedMesh>();
  for (const binding of bindings.values()) {
    if (binding.objectGroup !== rootBinding.objectGroup && !isDescendantOf(binding.objectGroup, rootBinding.objectGroup)) continue;
    for (const entry of binding.entries) {
      entry.mesh.setMatrixAt(
        entry.instanceId,
        binding.objectGroup.matrixWorld.clone().multiply(entry.templateMatrix)
      );
      dirtyMeshes.add(entry.mesh);
    }
  }
  for (const mesh of dirtyMeshes) updateBatchBounds(mesh);
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function updateBatchBounds(mesh: THREE.InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
}

function disposeTemplateMaterials(template: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  template.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    source.forEach((material) => materials.add(material));
  });
  materials.forEach((material) => material.dispose());
}
