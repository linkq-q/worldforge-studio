import { createId, type EditableMap, type MapObject } from '../shared/map';

export interface MapObjectClipboard {
  rootId: string;
  rootParentId: string | null;
  objects: MapObject[];
}

export function copyMapObjectSubtree(map: EditableMap, rootId: string): MapObjectClipboard | null {
  const root = map.objects.find((object) => object.id === rootId);
  if (!root) return null;
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of map.objects) {
      if (object.parentId && included.has(object.parentId) && !included.has(object.id)) {
        included.add(object.id);
        changed = true;
      }
    }
  }
  return {
    rootId,
    rootParentId: root.parentId,
    objects: structuredClone(map.objects.filter((object) => included.has(object.id)))
  };
}

export function pasteMapObjectSubtree(
  map: EditableMap,
  clipboard: MapObjectClipboard,
  offset: [number, number, number] = [0.5, 0, 0.5]
): { objects: MapObject[]; rootId: string } {
  const ids = new Map(clipboard.objects.map((object) => [object.id, createId('obj')]));
  const targetHasRootParent = clipboard.rootParentId
    ? map.objects.some((object) => object.id === clipboard.rootParentId)
    : false;
  const objects = clipboard.objects.map((source) => {
    const object = structuredClone(source);
    object.id = ids.get(source.id)!;
    object.parentId = source.id === clipboard.rootId
      ? targetHasRootParent ? clipboard.rootParentId : null
      : source.parentId ? ids.get(source.parentId) ?? null : null;
    object.roomOpeningId = undefined;
    if (source.id === clipboard.rootId) {
      object.name = `${source.name} 副本`;
      object.transform.position = [
        source.transform.position[0] + offset[0],
        source.transform.position[1] + offset[1],
        source.transform.position[2] + offset[2]
      ];
    }
    return object;
  });
  return { objects, rootId: ids.get(clipboard.rootId)! };
}
