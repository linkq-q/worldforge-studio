import {
  applyTerrainBrushInPlace,
  createId,
  DEFAULT_WATER_DEPTH,
  createMapObject,
  createPaintStroke,
  normalizeMap,
  normalizeMapRoom,
  placeRoomOpeningObjectInPlace,
  snapTerrainObjectsInPlace,
  type EditableMap,
  type MapBoxColors,
  type MapObject,
  type MapPaintStroke,
  type MapRoom,
  type MapSurface,
  type MapTerrain,
  type MapWaterBody,
  type WorldScaleProfile,
  type TerrainBrushMode,
  type Transform3D
} from './map';
import { carveWaterBasinInPlace, ensureRiverSurfaceLevels } from './mapWater';
import {
  applyTerrainModifierInPlace,
  applyTerrainSurfaceInPlace,
  generateTerrainInPlace,
  refineTerrainInPlace,
  type TerrainGenerationParams,
  type TerrainModifierParams,
  type TerrainRefinementParams,
  type TerrainSurfaceParams
} from './terrainGeneration';
import type { Vec3 } from './protocol';
import type { MapLintIssue } from './mapLint';
import type { SceneCompositionMetrics, SceneCompositionPlan } from './sceneComposition';
import type { SceneAdviceFinding, SceneReviewResult } from './sceneCompositionAdvice';
import type { SceneOutcomeCheck } from './sceneCompositionOutcome';
import type { MapVisualSemantics } from './visualDirection';
import type { MapLayout } from './mapLayout';
import {
  MAX_GRASS_LAYERS,
  applyGrassBrushInPlace,
  createGrassLayer,
  fillGrassLayerInPlace,
  generateGrassRegionInPlace,
  updateGrassLayer,
  type GrassBrushMode,
  type GrassLayerInput,
  type GrassLayerPatch,
  type GrassRegion
} from './mapGrass';

export type MapTransactionSource = 'basic-ai' | 'agent' | 'manual';

export type MapObjectInput = Omit<Partial<MapObject>, 'transform'> & {
  transform?: Partial<Transform3D>;
};

export type MapObjectPatch = Omit<Partial<MapObject>, 'id' | 'transform'> & {
  transform?: Partial<Transform3D>;
};

export type MapWaterBodyInput = Omit<Partial<MapWaterBody>, 'points'> & {
  type: MapWaterBody['type'];
  points: MapWaterBody['points'];
};

export type MapWaterBodyPatch = Omit<Partial<MapWaterBody>, 'id'>;

export type MapOperation =
  | { type: 'map.update'; name?: string; size?: Vec3; colors?: Partial<MapBoxColors>; playerHeight?: number; playerRadius?: number; worldScaleProfile?: WorldScaleProfile; renderPromptSuggestions?: string[]; visualSemantics?: MapVisualSemantics; layout?: MapLayout }
  | { type: 'room.set'; room: Partial<MapRoom> }
  | { type: 'terrain.set'; terrain: MapTerrain }
  | ({ type: 'terrain.generate' } & Partial<TerrainGenerationParams> & Pick<TerrainGenerationParams, 'preset'>)
  | ({ type: 'terrain.modify' } & Partial<TerrainModifierParams> & Pick<TerrainModifierParams, 'modifier' | 'region'>)
  | ({ type: 'terrain.refine' } & Partial<TerrainRefinementParams>)
  | ({ type: 'terrain.surface' } & Partial<TerrainSurfaceParams> & Pick<TerrainSurfaceParams, 'surface' | 'region'>)
  | { type: 'terrain.brush'; mode: TerrainBrushMode; point: Vec3; size?: number; strength?: number; targetHeight?: number }
  | { type: 'paint.add'; stroke: Partial<MapPaintStroke> & Pick<MapPaintStroke, 'surface' | 'point'> }
  | { type: 'grass.layer.add'; layer: GrassLayerInput }
  | { type: 'grass.layer.update'; layerId: string; patch: GrassLayerPatch }
  | { type: 'grass.layer.remove'; layerId: string }
  | { type: 'grass.fill'; layerId: string; density: number }
  | { type: 'grass.brush'; layerId: string; mode: GrassBrushMode; point: [number, number]; size?: number; strength?: number; targetDensity?: number }
  | { type: 'grass.generate'; layerId: string; region: GrassRegion; density?: number; variation?: number; softness?: number; seed?: number }
  | { type: 'object.add'; object: MapObjectInput }
  | { type: 'object.update'; objectId: string; patch: MapObjectPatch }
  | { type: 'object.remove'; objectId: string }
  | { type: 'water.add'; water: MapWaterBodyInput }
  | { type: 'water.update'; waterId: string; patch: MapWaterBodyPatch }
  | { type: 'water.remove'; waterId: string }
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
  reusedAssets?: Array<{ id: string; name: string; libraryId: string }>;
  diagnostics?: MapLintIssue[];
  /** Preview-only reasoning artifact. Map transactions persist only compiled operations. */
  composition?: {
    plan: SceneCompositionPlan;
    metrics: SceneCompositionMetrics;
    consultations: Array<{ id: string; summary: string; findings: SceneAdviceFinding[] }>;
    review: SceneReviewResult;
    outcome: { checks: SceneOutcomeCheck[]; repairCount: number };
  };
}

const MAP_SURFACES = new Set<MapSurface>(['floor', 'ceiling', 'north', 'south', 'east', 'west', 'terrain']);
const TERRAIN_MODES = new Set<TerrainBrushMode>(['raise', 'lower', 'flatten']);
const GRASS_BRUSH_MODES = new Set<GrassBrushMode>(['add', 'erase', 'density', 'smooth']);
const MAX_OPERATIONS = 2_000;

export function applyMapOperations(map: EditableMap, operations: readonly MapOperation[]): EditableMap {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('empty_operations');
  if (operations.length > MAX_OPERATIONS) throw new Error('too_many_operations');

  let next = normalizeMap(map);
  let terrainChanged = false;
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || typeof operation.type !== 'string') {
      throw new Error('invalid_operation');
    }

    switch (operation.type) {
      case 'map.update':
        if (operation.name !== undefined && typeof operation.name !== 'string') throw new Error('invalid_map_name');
        if (operation.size !== undefined) requireVec3(operation.size, 'invalid_map_size');
        if (operation.name !== undefined) next.name = operation.name;
        if (operation.playerHeight !== undefined) {
          next.playerHeight = operation.playerHeight;
          if (operation.playerRadius === undefined) {
            next.playerRadius = Math.min(0.5, Math.max(0.3, operation.playerHeight * 0.2375));
          }
        }
        if (operation.playerRadius !== undefined) next.playerRadius = operation.playerRadius;
        if (operation.worldScaleProfile !== undefined) next.worldScaleProfile = operation.worldScaleProfile;
        if (operation.renderPromptSuggestions !== undefined) {
          next.renderPromptSuggestions = operation.renderPromptSuggestions;
        }
        if (operation.visualSemantics !== undefined) next.visualSemantics = operation.visualSemantics;
        if (operation.layout !== undefined) next.layout = operation.layout;
        if (operation.size !== undefined) next.box.size = operation.size;
        if (operation.colors !== undefined) Object.assign(next.box.colors, operation.colors);
        break;
      case 'room.set':
        if (next.sceneMode === 'outdoor') throw new Error('room_requires_indoor_map');
        if (!operation.room || typeof operation.room !== 'object') throw new Error('invalid_room');
        next.room = normalizeMapRoom(operation.room, next.box.size, next.room ?? undefined);
        next.objects.forEach((object) => placeRoomOpeningObjectInPlace(next, object));
        break;
      case 'terrain.set':
        if (!operation.terrain || typeof operation.terrain !== 'object') throw new Error('invalid_terrain');
        next = normalizeMap({ ...next, terrain: operation.terrain });
        terrainChanged = true;
        break;
      case 'terrain.generate': {
        const params = generateTerrainInPlace(next, operation);
        terrainChanged = true;
        if (params.preset === 'island' || params.preset === 'archipelago') ensureTerrainOcean(next);
        else next.waterBodies = next.waterBodies.filter((water) => water.id !== 'terrain-ocean');
        if (params.preset === 'dune-desert') {
          applyTerrainSurfaceInPlace(next, {
            surface: 'sand',
            zoneId: 'terrain-surface:desert',
            intensity: 1,
            region: mapBoundsPolygon(next)
          });
        }
        break;
      }
      case 'terrain.modify': {
        const params = applyTerrainModifierInPlace(next, operation);
        if (params.modifier === 'island') ensureTerrainOcean(next);
        terrainChanged = true;
        break;
      }
      case 'terrain.refine':
        refineTerrainInPlace(next, operation);
        terrainChanged = true;
        break;
      case 'terrain.surface':
        applyTerrainSurfaceInPlace(next, operation);
        break;
      case 'terrain.brush':
        requireVec3(operation.point, 'invalid_terrain_point');
        if (!TERRAIN_MODES.has(operation.mode)) throw new Error('invalid_terrain_mode');
        applyTerrainBrushInPlace(
          next,
          operation.mode,
          operation.point,
          operation.size ?? 1.5,
          operation.strength ?? 0.3,
          operation.targetHeight
        );
        terrainChanged = true;
        break;
      case 'paint.add':
        if (!operation.stroke || !MAP_SURFACES.has(operation.stroke.surface)) throw new Error('invalid_paint');
        requireVec3(operation.stroke.point, 'invalid_paint_point');
        next.paintStrokes.push(createPaintStroke(operation.stroke));
        break;
      case 'grass.layer.add': {
        if (!operation.layer || typeof operation.layer !== 'object') throw new Error('invalid_grass_layer');
        if (next.grassLayers.length >= MAX_GRASS_LAYERS) throw new Error('too_many_grass_layers');
        const layer = createGrassLayer(
          operation.layer,
          next.terrain.resolutionX,
          next.terrain.resolutionZ,
          next.seed + next.grassLayers.length + 1
        );
        if (next.grassLayers.some((item) => item.id === layer.id)) throw new Error('duplicate_grass_layer_id');
        next.grassLayers.push(layer);
        break;
      }
      case 'grass.layer.update': {
        const index = next.grassLayers.findIndex((item) => item.id === operation.layerId);
        if (index < 0) throw new Error('grass_layer_not_found');
        if (!operation.patch || typeof operation.patch !== 'object') throw new Error('invalid_grass_layer');
        next.grassLayers[index] = updateGrassLayer(next.grassLayers[index], operation.patch);
        break;
      }
      case 'grass.layer.remove':
        if (!next.grassLayers.some((item) => item.id === operation.layerId)) throw new Error('grass_layer_not_found');
        next.grassLayers = next.grassLayers.filter((item) => item.id !== operation.layerId);
        break;
      case 'grass.fill':
        requireFinite(operation.density, 'invalid_grass_density');
        fillGrassLayerInPlace(next, operation.layerId, operation.density);
        break;
      case 'grass.brush':
        requirePoint2(operation.point, 'invalid_grass_point');
        if (!GRASS_BRUSH_MODES.has(operation.mode)) throw new Error('invalid_grass_brush_mode');
        applyGrassBrushInPlace(
          next,
          operation.layerId,
          operation.mode,
          operation.point,
          operation.size,
          operation.strength,
          operation.targetDensity
        );
        break;
      case 'grass.generate':
        requireGrassRegion(operation.region);
        generateGrassRegionInPlace(
          next,
          operation.layerId,
          operation.region,
          operation.density,
          operation.variation,
          operation.softness,
          operation.seed
        );
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
        placeRoomOpeningObjectInPlace(next, object);
        next.objects.push(object);
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
        placeRoomOpeningObjectInPlace(next, object);
        break;
      }
      case 'object.remove':
        if (!operation.objectId || !next.objects.some((item) => item.id === operation.objectId)) throw new Error('object_not_found');
        next.objects = next.objects
          .filter((item) => item.id !== operation.objectId)
          .map((item) => item.parentId === operation.objectId ? { ...item, parentId: null } : item);
        break;
      case 'water.add': {
        requireWaterBody(operation.water);
        let water: MapWaterBody = {
          id: operation.water.id || createId('water'),
          name: operation.water.name ?? (operation.water.type === 'lake' ? '湖泊' : operation.water.type === 'ocean' ? '海面' : '河流'),
          type: operation.water.type,
          level: operation.water.level ?? 0.2,
          depth: operation.water.depth ?? DEFAULT_WATER_DEPTH,
          width: operation.water.width ?? 1.2,
          points: operation.water.points,
          levels: operation.water.levels,
          shorelineSmoothness: operation.water.shorelineSmoothness
            ?? (operation.water.type === 'ocean' ? 0 : 0.82),
          shorelineIrregularity: operation.water.shorelineIrregularity
            ?? (operation.water.type === 'lake' ? 0.16 : 0),
          seed: operation.water.seed ?? next.seed,
          generation: operation.water.generation
        };
        water = ensureRiverSurfaceLevels(next, water);
        if (next.waterBodies.some((item) => item.id === water.id)) throw new Error('duplicate_water_id');
        next.waterBodies.push(water);
        carveWaterBasinInPlace(next, water);
        break;
      }
      case 'water.update': {
        if (!operation.waterId || !operation.patch || typeof operation.patch !== 'object') {
          throw new Error('invalid_water_body');
        }
        const water = next.waterBodies.find((item) => item.id === operation.waterId);
        if (!water) throw new Error('water_not_found');
        let updated: MapWaterBody = { ...water, ...operation.patch, id: water.id };
        if (water.type === 'river' && operation.patch.level !== undefined && operation.patch.levels === undefined
          && water.levels?.length === water.points.length) {
          const offset = updated.level - water.level;
          updated = { ...updated, levels: water.levels.map((level) => level + offset) };
        }
        updated = ensureRiverSurfaceLevels(next, updated);
        requireWaterBody(updated);
        next.waterBodies = next.waterBodies.map((item) => item.id === water.id ? updated : item);
        carveWaterBasinInPlace(next, updated);
        break;
      }
      case 'water.remove':
        if (!operation.waterId || !next.waterBodies.some((item) => item.id === operation.waterId)) {
          throw new Error('water_not_found');
        }
        next.waterBodies = next.waterBodies.filter((item) => item.id !== operation.waterId);
        break;
      case 'reference.set':
        requireVec3(operation.point, 'invalid_reference_point');
        next.spawnPoints = [operation.point];
        next.spawnYaw = operation.yaw ?? next.spawnYaw;
        break;
      case 'sun.set':
        requireVec3(operation.point, 'invalid_sun_point');
        next.lighting.sunPosition = operation.point;
        break;
      default:
        throw new Error('unsupported_operation');
    }
  }
  if (terrainChanged) {
    for (const water of next.waterBodies) carveWaterBasinInPlace(next, water);
    snapTerrainObjectsInPlace(next);
  }
  return normalizeMap({ ...next, confirmedAt: null });
}

function requireWaterBody(value: unknown): asserts value is MapWaterBodyInput {
  if (!value || typeof value !== 'object') throw new Error('invalid_water_body');
  const water = value as Partial<MapWaterBody>;
  if (water.type !== 'lake' && water.type !== 'river' && water.type !== 'ocean') throw new Error('invalid_water_body');
  if (!Array.isArray(water.points) || water.points.length < (water.type === 'river' ? 2 : 3)) {
    throw new Error('invalid_water_body');
  }
  if (water.points.length > 64 || water.points.some((point) => (
    !Array.isArray(point)
    || point.length < 2
    || !Number.isFinite(Number(point[0]))
    || !Number.isFinite(Number(point[1]))
  ))) {
    throw new Error('invalid_water_body');
  }
  if (water.id !== undefined && (typeof water.id !== 'string' || !water.id.trim())) {
    throw new Error('invalid_water_body');
  }
  if (water.name !== undefined && typeof water.name !== 'string') throw new Error('invalid_water_body');
  if (water.level !== undefined && !Number.isFinite(Number(water.level))) throw new Error('invalid_water_body');
  if (water.depth !== undefined && !Number.isFinite(Number(water.depth))) throw new Error('invalid_water_body');
  if (water.width !== undefined && !Number.isFinite(Number(water.width))) throw new Error('invalid_water_body');
  if (water.levels !== undefined && (
    water.type !== 'river'
    || !Array.isArray(water.levels)
    || water.levels.length !== water.points.length
    || water.levels.some((level) => !Number.isFinite(Number(level)))
  )) throw new Error('invalid_water_body');
  if (water.shorelineSmoothness !== undefined && !Number.isFinite(Number(water.shorelineSmoothness))) {
    throw new Error('invalid_water_body');
  }
  if (water.shorelineIrregularity !== undefined && !Number.isFinite(Number(water.shorelineIrregularity))) {
    throw new Error('invalid_water_body');
  }
  if (water.seed !== undefined && !Number.isFinite(Number(water.seed))) throw new Error('invalid_water_body');
}

function ensureTerrainOcean(map: EditableMap): void {
  const existing = map.waterBodies.find((water) => water.type === 'ocean');
  const points = mapBoundsPolygon(map).points;
  const ocean: MapWaterBody = {
    id: existing?.id ?? 'terrain-ocean',
    name: existing?.name ?? '海面',
    type: 'ocean',
    level: 0,
    depth: 0.1,
    width: 1,
    points
  };
  if (existing) map.waterBodies = map.waterBodies.map((water) => water.id === existing.id ? ocean : water);
  else map.waterBodies.push(ocean);
}

function mapBoundsPolygon(map: EditableMap): { kind: 'polygon'; points: Array<[number, number]> } {
  const halfWidth = map.box.size[0] / 2;
  const halfDepth = map.box.size[2] / 2;
  return {
    kind: 'polygon',
    points: [
      [-halfWidth, -halfDepth],
      [halfWidth, -halfDepth],
      [halfWidth, halfDepth],
      [-halfWidth, halfDepth]
    ]
  };
}

function requireGrassRegion(value: unknown): asserts value is GrassRegion {
  if (!value || typeof value !== 'object') throw new Error('invalid_grass_region');
  const region = value as Partial<GrassRegion>;
  if (region.kind === 'circle') {
    requirePoint2(region.center, 'invalid_grass_region');
    requireFinite(region.radius, 'invalid_grass_region');
    if (Number(region.radius) <= 0) throw new Error('invalid_grass_region');
    return;
  }
  if (region.kind === 'polygon' && Array.isArray(region.points) && region.points.length >= 3) {
    for (const point of region.points) requirePoint2(point, 'invalid_grass_region');
    return;
  }
  throw new Error('invalid_grass_region');
}

function requirePoint2(value: unknown, message: string): asserts value is [number, number] {
  if (!Array.isArray(value) || value.length < 2 || !value.slice(0, 2).every((item) => Number.isFinite(Number(item)))) {
    throw new Error(message);
  }
}

function requireFinite(value: unknown, message: string): void {
  if (!Number.isFinite(Number(value))) throw new Error(message);
}

function requireVec3(value: unknown, error: string): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length < 3 || value.slice(0, 3).some((item) => !Number.isFinite(Number(item)))) {
    throw new Error(error);
  }
}
