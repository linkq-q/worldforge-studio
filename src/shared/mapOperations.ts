import {
  addPaintStroke,
  applyTerrainBrush,
  createId,
  createMapObject,
  normalizeMap,
  type EditableMap,
  type MapBoxColors,
  type MapObject,
  type MapPaintStroke,
  type MapSurface,
  type MapTerrain,
  type TerrainBrushMode,
  type Transform3D
} from './map';
import type { Vec3 } from './protocol';

export type MapTransactionSource = 'basic-ai' | 'agent';

export type MapObjectInput = Omit<Partial<MapObject>, 'transform'> & {
  transform?: Partial<Transform3D>;
};

export type MapObjectPatch = Omit<Partial<MapObject>, 'id' | 'transform'> & {
  transform?: Partial<Transform3D>;
};

export type MapOperation =
  | { type: 'map.update'; name?: string; size?: Vec3; colors?: Partial<MapBoxColors>; renderPromptSuggestions?: string[] }
  | { type: 'terrain.set'; terrain: MapTerrain }
  | { type: 'terrain.brush'; mode: TerrainBrushMode; point: Vec3; size?: number; strength?: number; targetHeight?: number }
  | { type: 'paint.add'; stroke: Partial<MapPaintStroke> & Pick<MapPaintStroke, 'surface' | 'point'> }
  | { type: 'object.add'; object: MapObjectInput }
  | { type: 'object.update'; objectId: string; patch: MapObjectPatch }
  | { type: 'object.remove'; objectId: string }
  | { type: 'reference.set'; point: Vec3; yaw?: number }
  | { type: 'sun.set'; point: Vec3 };

export interface MapTransactionRequest {
  label?: string;
  source: MapTransactionSource;
  operations: MapOperation[];
}

export interface MapTransactionSummary {
  id: string;
  label: string;
  source: MapTransactionSource;
  operationCount: number;
  createdAt: number;
}

export interface MapAiSuggestion {
  summary: string;
  operations: MapOperation[];
  renderPromptSuggestions: string[];
  generatedAssets: Array<{ id: string; name: string }>;
}

const MAP_SURFACES = new Set<MapSurface>(['floor', 'ceiling', 'north', 'south', 'east', 'west', 'terrain']);
const TERRAIN_MODES = new Set<TerrainBrushMode>(['raise', 'lower', 'flatten']);
const MAX_OPERATIONS = 2_000;

export function applyMapOperations(map: EditableMap, operations: readonly MapOperation[]): EditableMap {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('empty_operations');
  if (operations.length > MAX_OPERATIONS) throw new Error('too_many_operations');

  let next = normalizeMap(map);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || typeof operation.type !== 'string') {
      throw new Error('invalid_operation');
    }

    switch (operation.type) {
      case 'map.update':
        if (operation.name !== undefined && typeof operation.name !== 'string') throw new Error('invalid_map_name');
        if (operation.size !== undefined) requireVec3(operation.size, 'invalid_map_size');
        next = normalizeMap({
          ...next,
          name: operation.name ?? next.name,
          renderPromptSuggestions: operation.renderPromptSuggestions ?? next.renderPromptSuggestions,
          box: {
            size: operation.size ?? next.box.size,
            colors: { ...next.box.colors, ...operation.colors }
          }
        });
        break;
      case 'terrain.set':
        if (!operation.terrain || typeof operation.terrain !== 'object') throw new Error('invalid_terrain');
        next = normalizeMap({ ...next, terrain: operation.terrain });
        break;
      case 'terrain.brush':
        requireVec3(operation.point, 'invalid_terrain_point');
        if (!TERRAIN_MODES.has(operation.mode)) throw new Error('invalid_terrain_mode');
        next = applyTerrainBrush(
          next,
          operation.mode,
          operation.point,
          operation.size ?? 1.5,
          operation.strength ?? 0.3,
          operation.targetHeight
        );
        break;
      case 'paint.add':
        if (!operation.stroke || !MAP_SURFACES.has(operation.stroke.surface)) throw new Error('invalid_paint');
        requireVec3(operation.stroke.point, 'invalid_paint_point');
        next = addPaintStroke(next, operation.stroke);
        break;
      case 'object.add': {
        if (!operation.object || typeof operation.object !== 'object') throw new Error('invalid_object');
        const base = createMapObject(operation.object.name, operation.object.assetId ?? null);
        const object: MapObject = {
          ...base,
          ...operation.object,
          id: operation.object.id || createId('obj'),
          transform: { ...base.transform, ...operation.object.transform }
        };
        if (next.objects.some((item) => item.id === object.id)) throw new Error('duplicate_object_id');
        next = normalizeMap({ ...next, objects: [...next.objects, object] });
        break;
      }
      case 'object.update': {
        if (!operation.objectId || !operation.patch || typeof operation.patch !== 'object') throw new Error('invalid_object_patch');
        const object = next.objects.find((item) => item.id === operation.objectId);
        if (!object) throw new Error('object_not_found');
        Object.assign(object, operation.patch, {
          id: object.id,
          transform: { ...object.transform, ...operation.patch.transform }
        });
        next = normalizeMap(next);
        break;
      }
      case 'object.remove':
        if (!operation.objectId || !next.objects.some((item) => item.id === operation.objectId)) throw new Error('object_not_found');
        next = normalizeMap({
          ...next,
          objects: next.objects
            .filter((item) => item.id !== operation.objectId)
            .map((item) => item.parentId === operation.objectId ? { ...item, parentId: null } : item)
        });
        break;
      case 'reference.set':
        requireVec3(operation.point, 'invalid_reference_point');
        next = normalizeMap({
          ...next,
          spawnPoints: [operation.point],
          spawnYaw: operation.yaw ?? next.spawnYaw
        });
        break;
      case 'sun.set':
        requireVec3(operation.point, 'invalid_sun_point');
        next = normalizeMap({ ...next, lighting: { sunPosition: operation.point } });
        break;
      default:
        throw new Error('unsupported_operation');
    }
  }
  return normalizeMap({ ...next, confirmedAt: null });
}

function requireVec3(value: unknown, error: string): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length < 3 || value.slice(0, 3).some((item) => !Number.isFinite(Number(item)))) {
    throw new Error(error);
  }
}
