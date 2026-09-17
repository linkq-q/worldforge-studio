import { getObjectWorldTransforms, type EditableMap } from './map';
import { pointInMapRegion } from './mapLayout';
import { applyMapOperations, type MapOperation } from './mapOperations';

export interface MapRefineScope {
  targetVisualZoneId?: string;
  targetRegionId?: string;
}

export function describeMapRefineScope(map: EditableMap, scope: MapRefineScope): string {
  const zone = scope.targetVisualZoneId
    ? map.visualSemantics.zones.find(item => item.id === scope.targetVisualZoneId) : undefined;
  const region = scope.targetRegionId
    ? map.layout.regions.find(item => item.id === scope.targetRegionId) : undefined;
  if (scope.targetVisualZoneId && !zone) throw new Error('unknown_visual_zone');
  if (scope.targetRegionId && !region) throw new Error('unknown_ecology_region');
  if (region?.contentLocked) throw new Error('ecology_region_content_locked');
  return zone || region ? `Local refinement boundary: ${JSON.stringify({ zone, region })}. Preserve the existing scene and add only the requested delta inside the selected area (intersection when both are selected). Do not regenerate terrain, reset global grass, replace the room, or replace global design semantics. Keep parent and child objects inside the area in world coordinates. Existing region content is not automatically removed. Use noChange if nothing needs changing.` : '';
}

/** Enforce the same scope for discovery previews, final execution and replay. */
export function scopeMapRefinement(
  map: EditableMap, operations: readonly MapOperation[], scope: MapRefineScope
): MapOperation[] {
  if (!describeMapRefineScope(map, scope)) return [...operations];
  const zone = map.visualSemantics.zones.find(item => item.id === scope.targetVisualZoneId);
  const region = map.layout.regions.find(item => item.id === scope.targetRegionId);
  const contains = (x: number, z: number) => (!zone || Math.hypot(x - zone.center[0], z - zone.center[1]) <= zone.radius)
    && (!region || pointInMapRegion(region, x, z));
  const pointsInside = (points: readonly (readonly number[])[]) => points.length > 0 && points.every(point => contains(point[0], point[1]));
  const circleInside = (x: number, z: number, radius: number) => contains(x, z)
    && Array.from({ length: 16 }, (_, index) => index * Math.PI / 8)
      .every(angle => contains(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius));
  const shapeInside = (shape: { kind: string; x?: number; z?: number; center?: [number, number]; radius?: number; points?: [number, number][]; width?: number }) => shape.kind === 'circle'
    ? circleInside(shape.center?.[0] ?? shape.x ?? 0, shape.center?.[1] ?? shape.z ?? 0, shape.radius ?? 0)
    : Boolean(shape.points?.length && shape.points.every(point => circleInside(point[0], point[1], (shape.width ?? 0) / 2)));
  let current = map;
  const result: MapOperation[] = [];
  for (const raw of operations) {
    // Visual intent may cross stages; other global map settings remain user-owned.
    const operation: MapOperation = raw.type === 'map.update'
      ? { type: 'map.update', renderPromptSuggestions: raw.renderPromptSuggestions } : raw;
    let accepted = false;
    let next: EditableMap | undefined;
    switch (operation.type) {
      case 'object.add':
      case 'object.update':
      case 'object.remove': {
        const id = operation.type === 'object.add' ? operation.object.id : operation.objectId;
        if (!id) break;
        if (operation.type === 'object.add' && operation.object.parentId
          && !current.objects.some(item => item.id === operation.object.parentId)) break;
        if (operation.type !== 'object.add' && !current.objects.some(item => item.id === id)) break;
        next = applyMapOperations(current, [operation]);
        const before = getObjectWorldTransforms(current);
        const after = getObjectWorldTransforms(next);
        // Moving/removing a parent also changes its descendants; check every affected world transform.
        const ids = new Set([id, ...[...before.keys()].filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))]);
        accepted = [...ids].every(key => [before.get(key), after.get(key)].every(transform => !transform || contains(transform.position[0], transform.position[2])));
        break;
      }
      case 'map.update': accepted = operation.renderPromptSuggestions !== undefined; break;
      case 'terrain.brush': accepted = circleInside(operation.point[0], operation.point[2], operation.size ?? 1); break;
      case 'terrain.modify':
      case 'terrain.surface': accepted = shapeInside(operation.region); break;
      case 'paint.add': accepted = circleInside(operation.stroke.point[0], operation.stroke.point[2], operation.stroke.size ?? 1); break;
      case 'grass.brush': accepted = circleInside(operation.point[0], operation.point[1], operation.size ?? 1); break;
      case 'grass.generate': accepted = shapeInside(operation.region); break;
      case 'water.add': accepted = pointsInside(operation.water.points); break;
      case 'water.update':
      case 'water.remove': {
        const water = current.waterBodies.find(item => item.id === operation.waterId);
        accepted = Boolean(water && pointsInside(water.points)
          && (operation.type !== 'water.update' || !operation.patch.points || pointsInside(operation.patch.points)));
        break;
      }
      default: break;
    }
    if (!accepted) continue;
    result.push(operation);
    // Only object operations need a rolling hierarchy; avoid reapplying terrain for each check.
    if (next) current = next;
  }
  return result;
}
