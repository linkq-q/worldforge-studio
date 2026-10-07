import type * as THREE from 'three';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import { resolveModelMaterialTags } from '@voxel-studio/render-runtime/effects';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import type { EditableMap, MapAsset } from '../shared/map';
import type { RuntimeMaterialTheme } from '../shared/renderPlan';
import type { MaterialThemeSelection } from './renderRuntimeAdapter';

export function createMaterialThemeSelector(
  index: RuntimeIndex,
  map: EditableMap,
  assets: Map<string, MapAsset>,
  assetTags: (asset: MapAsset) => string[],
  objectGroups: Map<string, THREE.Group> = new Map()
): (scope: RuntimeMaterialTheme['scope']) => MaterialThemeSelection {
  const contexts = new Map(map.objects.flatMap(object => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    return asset ? [[object.id, asset] as const] : [];
  }));
  const tagsByAsset = new Map<string, Map<string, string[]>>();
  for (const asset of new Set(contexts.values())) {
    const nodes = (asset.modelJson as { nodes?: unknown[] } | null)?.nodes ?? [];
    const parts = nodes.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object'));
    const resolved = resolveModelMaterialTags({ parts }, materialTagVocabulary);
    tagsByAsset.set(asset.id, new Map([...resolved.byPartId].map(([id, tags]) => [id, tags.flatMap(tag => [
      tag.tag, String(tag.value), `${tag.tag}:${tag.value}`, ...(tag.variant ? [`variant:${tag.variant}`] : [])
    ])])));
  }
  return scope => {
    const selected: MaterialThemeSelection = new Map();
    const matches = (objectId: string, partId: string): boolean => {
      if (scope.target === 'scene') return true;
      const asset = contexts.get(objectId);
      if (!asset) return false;
      if (scope.target === 'asset-tag') return assetTags(asset).includes(scope.tag ?? '');
      const requested = scope.tag ?? (scope.target === 'water' ? 'water' : '');
      return tagsByAsset.get(asset.id)?.get(partId)?.includes(requested) ?? false;
    };
    // RuntimeIndex is live: newly compiled or moved parts keep their actual slot ids.
    for (const [id, ref] of index.partToRender) {
      const mesh = ref.object as THREE.Mesh;
      if (!mesh?.isMesh) continue;
      const partRef = ref as typeof ref & { modelId?: string; rawPartId?: string };
      const objectId = partRef.modelId ?? id.slice(0, id.lastIndexOf(':'));
      const partId = partRef.rawPartId ?? id.slice(objectId.length + 1);
      const slot = ref.mode === 'batched' ? (ref as { geometryId?: number }).geometryId : ref.instanceId;
      if (!selected.has(mesh)) selected.set(mesh, new Set());
      if (!matches(objectId, partId)) continue;
      if (slot === undefined) selected.set(mesh, null);
      else selected.get(mesh)?.add(slot);
    }
    // Animated/fallback visuals can exist outside RuntimeIndex; use their raw node id.
    for (const [objectId, group] of objectGroups) group.traverse(object => {
      const mesh = object as THREE.Mesh;
      const partId = String(mesh.userData.nodeId ?? mesh.userData.partId ?? '');
      if (!mesh.isMesh || !partId || selected.has(mesh) || !contexts.has(objectId)) return;
      selected.set(mesh, matches(objectId, partId) ? null : new Set());
    });
    return selected;
  };
}
