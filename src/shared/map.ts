import {
  MAP_ASSET_COLLIDER_PROFILE,
  buildModelColliderPlan,
  normalizeModelColliderPlan,
  type Aabb,
  type ModelColliderPlan
} from './modelBounds';
import { rayAabbIntersection, stepVerticalMotion, wrapAngle, type VerticalMotionState } from './math';
import type { Vec3 } from './protocol';
import { seedFromString } from './mapSeed';
import {
  assetFootprintRadius,
  assetSizeClass,
  normalizeAssetTags,
  type MapAssetSizeClass
} from './mapAssetMetadata';
import { normalizeModelGenerationMode, type ModelGenerationMode } from './modelGenerationMode';
import { normalizeGrassLayers, type MapGrassLayer } from './mapGrass';
import {
  normalizeMaterialTagPolicy,
  type MapMaterialTagPolicy
} from './materialTagPolicy';
import { normalizeMapVisualSemantics, type MapVisualSemantics } from './visualDirection';
import type { AssetLibraryMetadata } from './assetLibrary';
import {
  isPointInsidePlayableArea,
  normalizeMapLayout,
  pointInMapRegion,
  type MapGenerationOwner,
  type MapLayout
} from './mapLayout';

export type MapSurface = 'floor' | 'ceiling' | 'north' | 'south' | 'east' | 'west' | 'terrain';
export type TerrainBrushMode = 'raise' | 'lower' | 'flatten';

export interface Transform3D {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  size: Vec3;
}

export interface MapBoxColors {
  floor: string;
  ceiling: string;
  north: string;
  south: string;
  east: string;
  west: string;
}

export interface MapBox {
  size: Vec3;
  colors: MapBoxColors;
}

export interface MapTerrain {
  resolutionX: number;
  resolutionZ: number;
  heights: number[];
}

export interface TerrainCliffSegment {
  start: Vec3;
  end: Vec3;
  lowStart: number;
  lowEnd: number;
}

export type MapWaterBodyType = 'lake' | 'river' | 'ocean';

export interface MapWaterBody {
  id: string;
  name: string;
  type: MapWaterBodyType;
  level: number;
  /** Basin or channel depth below the local water surface. */
  depth: number;
  width: number;
  points: Array<[number, number]>;
  /** Optional river surface elevation at each control point, ordered upstream to downstream. */
  levels?: number[];
  /** 0 keeps control-point corners; 1 produces rounded arc segments. */
  shorelineSmoothness?: number;
  /** Deterministic shoreline displacement relative to the local radius. */
  shorelineIrregularity?: number;
  seed?: number;
  generation?: MapGenerationOwner;
}

export interface MapLighting {
  sunPosition: Vec3;
}

export interface MapPaintStroke {
  id: string;
  surface: MapSurface;
  point: Vec3;
  uv: [number, number];
  color: string;
  size: number;
  softness: number;
  opacity: number;
  createdAt: number;
}

export interface MapAsset {
  id: string;
  name: string;
  prompt: string;
  tags?: string[];
  modelJson: unknown;
  colliderPlan: ModelColliderPlan;
  footprintRadius?: number;
  sizeClass?: MapAssetSizeClass;
  mode: string;
  provider?: string;
  libraryId?: string;
  libraryMetadata?: AssetLibraryMetadata;
  createdAt: number;
  updatedAt: number;
}

export type MapBehaviorKind = 'static' | 'solitary' | 'pair' | 'flock' | 'herd' | 'school' | 'territorial';
export type MapLocomotion = 'static' | 'ground' | 'air' | 'water' | 'mixed';

export interface MapObjectBehavior {
  kind: MapBehaviorKind;
  locomotion: MapLocomotion;
  groupRole?: 'core' | 'outlier';
  groupIndex?: number;
  /** Semantic state only. A runtime adapter decides how this maps to an animation system. */
  animation?: {
    state: string;
    speed: number;
    phase: number;
  };
}

export interface MapObject {
  id: string;
  name: string;
  parentId: string | null;
  assetId: string | null;
  transform: Transform3D;
  /** Terrain-following objects are re-grounded after generated terrain changes. */
  heightMode?: 'terrain' | 'fixed';
  visible: boolean;
  locked: boolean;
  behavior?: MapObjectBehavior;
  generation?: MapGenerationOwner;
}

export interface EditableMap {
  id: string;
  name: string;
  seed: number;
  assetGenerationMode: ModelGenerationMode;
  version: number;
  createdAt: number;
  updatedAt: number;
  box: MapBox;
  lighting: MapLighting;
  terrain: MapTerrain;
  grassLayers: MapGrassLayer[];
  waterBodies: MapWaterBody[];
  paintStrokes: MapPaintStroke[];
  objects: MapObject[];
  spawnPoints: Vec3[];
  spawnYaw: number;
  confirmedAt: number | null;
  renderSchemeId: string | null;
  renderPromptSuggestions: string[];
  materialTagPolicy: MapMaterialTagPolicy;
  visualSemantics: MapVisualSemantics;
  layout: MapLayout;
  assets?: MapAsset[];
  collisionBake?: MapCollisionBake;
}

export interface MapSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  width: number;
  height: number;
  depth: number;
  objectCount: number;
  assetGenerationMode: ModelGenerationMode;
  confirmedAt: number | null;
  renderSchemeId: string | null;
}

export interface MapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface WorldTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface MapObjectAabb extends Aabb {
  objectId: string;
}

export interface MapCollisionBake {
  version: 1;
  sourceHash: string;
  sourceBoxCount: number;
  boxes: MapObjectAabb[];
  cellSize: number;
  cells: Record<string, number[]>;
}

export interface CompositeMapCollisionObstacles {
  base: MapCollisionBake;
  dynamic: MapObjectAabb[];
}

export type MapCollisionObstacles = MapObjectAabb[] | MapCollisionBake | CompositeMapCollisionObstacles;

export interface PlayerVerticalMotionSweep {
  velocity: number;
  duration: number;
  jumpRequested: boolean;
}

export const PLAYER_RADIUS = 0.45;
export const PLAYER_MAX_WALKABLE_SLOPE = 30;
// The editor spawn marker, play capsule, camera and collision all share this
// world-space height. Keep it as the single source of truth.
export const PLAYER_HEIGHT = 2.7;
export const PLAYER_SPAWN_OBJECT_ID = '__player_spawn__';
export const SUN_OBJECT_ID = '__sun__';
export const DEFAULT_SUN_POSITION: Vec3 = [-18, 24, 14];
export const DEFAULT_TERRAIN_RESOLUTION = 33;
const MAX_TERRAIN_RESOLUTION = 513;
/**
 * Terrain height 0 is sea level, not the floor. Lake basins are carved below it,
 * so the height field has to be allowed to go negative.
 */
export const TERRAIN_MIN_HEIGHT = -16;
export const MAX_WATER_DEPTH = 12;
export const DEFAULT_WATER_DEPTH = 1.5;

const DEFAULT_BOX_COLORS: MapBoxColors = {
  floor: '#3b4741',
  ceiling: '#273235',
  north: '#303b3d',
  south: '#303b3d',
  east: '#344144',
  west: '#344144'
};

export const MAP_SIZE_PRESETS = [
  { key: 'small', label: '小', size: [48, 12, 48] as Vec3, terrain: 33 },
  { key: 'medium', label: '中', size: [96, 16, 96] as Vec3, terrain: 65 },
  { key: 'large', label: '大', size: [192, 24, 192] as Vec3, terrain: 129 },
  { key: 'super', label: '超大', size: [768, 32, 768] as Vec3, terrain: 513 }
] as const;

export const SUPER_MAP_MEDIUM_COUNT_MIN = 2;
export const SUPER_MAP_MEDIUM_COUNT_MAX = 64;

export function superMapSizeFromMediumCount(value: number): Vec3 {
  const count = clamp(Math.round(value), SUPER_MAP_MEDIUM_COUNT_MIN, SUPER_MAP_MEDIUM_COUNT_MAX);
  const extent = Math.round(MAP_SIZE_PRESETS[1].size[0] * Math.sqrt(count));
  return [extent, MAP_SIZE_PRESETS[3].size[1], extent];
}

export type MapSizePresetKey = typeof MAP_SIZE_PRESETS[number]['key'];

const DEFAULT_MAP_SIZE: Vec3 = [...MAP_SIZE_PRESETS[0].size];
const DEFAULT_TRANSFORM: Transform3D = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  size: [1, 1, 1]
};

const FALLBACK_OBJECT_BOUNDS: Aabb = {
  min: [-0.5, 0, -0.5],
  max: [0.5, 1, 0.5]
};
const MAP_COLLISION_BAKE_VERSION = 1 as const;
const MAP_COLLISION_CELL_SIZE = 4;
const MAP_COLLISION_EPSILON = 0.00001;
const BAKED_MAP_OBJECT_ID = '__baked_map__';

export function createEmptyMap(
  name = '未命名地图',
  id = createId('map'),
  size: Vec3 = DEFAULT_MAP_SIZE,
  assetGenerationMode: ModelGenerationMode = 'voxel'
): EditableMap {
  const now = Date.now();
  const safeSize = positiveVec3(size, DEFAULT_MAP_SIZE);
  const terrainResolution = terrainResolutionForSize(safeSize);
  const terrain = createFlatTerrain(terrainResolution, terrainResolution);
  return normalizeMap({
    id,
    name,
    assetGenerationMode,
    version: 1,
    createdAt: now,
    updatedAt: now,
    box: {
      size: safeSize,
      colors: { ...DEFAULT_BOX_COLORS }
    },
    lighting: {
      sunPosition: [...DEFAULT_SUN_POSITION]
    },
    terrain,
    paintStrokes: [],
    objects: [],
    spawnPoints: defaultSpawnPoints(DEFAULT_MAP_SIZE)
  });
}

export function createMapObject(name = '新物体', assetId: string | null = null): MapObject {
  return {
    id: createId('obj'),
    name,
    parentId: null,
    assetId,
    transform: cloneTransform(DEFAULT_TRANSFORM),
    heightMode: assetId ? 'terrain' : 'fixed',
    visible: true,
    locked: false
  };
}

export function createPaintStroke(input: Partial<MapPaintStroke> & Pick<MapPaintStroke, 'surface' | 'point'>): MapPaintStroke {
  const uv = input.uv ?? [0.5, 0.5];
  return {
    id: input.id ?? createId('paint'),
    surface: input.surface,
    point: validVec3(input.point, [0, 0, 0]),
    uv: [finiteNumber(uv[0], 0.5), finiteNumber(uv[1], 0.5)],
    color: normalizeColor(input.color, '#d8ef75'),
    size: clamp(finiteNumber(input.size, 1.2), 0.1, 20),
    softness: clamp(finiteNumber(input.softness, 0.35), 0, 1),
    opacity: clamp(finiteNumber(input.opacity, 0.95), 0.05, 1),
    createdAt: finiteNumber(input.createdAt, Date.now())
  };
}

export function normalizeMap(input: Partial<EditableMap>): EditableMap {
  const id = typeof input.id === 'string' && input.id ? input.id : createId('map');
  const boxSize = positiveVec3(input.box?.size, DEFAULT_MAP_SIZE);
  const terrainFallback = terrainResolutionForSize(boxSize);
  const terrain = normalizeTerrain(input.terrain, terrainFallback, terrainFallback);
  const map: EditableMap = {
    id,
    seed: Number.isFinite(Number(input.seed)) ? Math.trunc(Number(input.seed)) >>> 0 : seedFromString(id),
    name: cleanName(input.name, '未命名地图'),
    assetGenerationMode: normalizeModelGenerationMode(input.assetGenerationMode),
    version: Math.max(1, Math.round(finiteNumber(input.version, 1))),
    createdAt: finiteNumber(input.createdAt, Date.now()),
    updatedAt: finiteNumber(input.updatedAt, Date.now()),
    box: {
      size: boxSize,
      colors: {
        floor: normalizeColor(input.box?.colors?.floor, DEFAULT_BOX_COLORS.floor),
        ceiling: normalizeColor(input.box?.colors?.ceiling, DEFAULT_BOX_COLORS.ceiling),
        north: normalizeColor(input.box?.colors?.north, DEFAULT_BOX_COLORS.north),
        south: normalizeColor(input.box?.colors?.south, DEFAULT_BOX_COLORS.south),
        east: normalizeColor(input.box?.colors?.east, DEFAULT_BOX_COLORS.east),
        west: normalizeColor(input.box?.colors?.west, DEFAULT_BOX_COLORS.west)
      }
    },
    lighting: normalizeLighting(input.lighting),
    terrain,
    grassLayers: normalizeGrassLayers(input.grassLayers, terrain.resolutionX, terrain.resolutionZ),
    waterBodies: normalizeWaterBodies(input.waterBodies, boxSize),
    paintStrokes: Array.isArray(input.paintStrokes)
      ? input.paintStrokes.map((stroke) => createPaintStroke(stroke)).slice(-1200)
      : [],
    objects: Array.isArray(input.objects) ? input.objects.map(normalizeObject) : [],
    spawnPoints: normalizeSpawnPoints(input.spawnPoints, boxSize),
    spawnYaw: wrapAngle(finiteNumber(input.spawnYaw, 0)),
    confirmedAt: typeof input.confirmedAt === 'number' && Number.isFinite(input.confirmedAt) && input.confirmedAt > 0
      ? input.confirmedAt
      : null,
    renderSchemeId: typeof input.renderSchemeId === 'string' && input.renderSchemeId.trim()
      ? input.renderSchemeId.trim().slice(0, 80)
      : null,
    renderPromptSuggestions: normalizeTextList(input.renderPromptSuggestions, 8, 80),
    materialTagPolicy: normalizeMaterialTagPolicy(input.materialTagPolicy),
    visualSemantics: normalizeMapVisualSemantics(input.visualSemantics),
    layout: normalizeMapLayout(input.layout, boxSize),
    assets: Array.isArray(input.assets) ? input.assets.map(normalizeAsset) : undefined,
    collisionBake: normalizeMapCollisionBake(input.collisionBake)
  };
  return map;
}

function normalizeWaterBodies(value: unknown, boxSize: Vec3): MapWaterBody[] {
  if (!Array.isArray(value)) return [];
  const halfWidth = boxSize[0] / 2;
  const halfDepth = boxSize[2] / 2;
  const maxLevel = Math.max(0.05, boxSize[1] - 0.05);
  const maxRiverWidth = Math.max(0.3, Math.min(boxSize[0], boxSize[2]) / 2);
  const seen = new Set<string>();
  const result: MapWaterBody[] = [];
  for (const raw of value.slice(0, 64)) {
    if (!raw || typeof raw !== 'object') continue;
    const input = raw as Partial<MapWaterBody>;
    const type = input.type === 'river' ? 'river' : input.type === 'lake' ? 'lake' : input.type === 'ocean' ? 'ocean' : null;
    if (!type || !Array.isArray(input.points)) continue;
    const points = input.points.slice(0, 64)
      .filter((point): point is [number, number] => (
        Array.isArray(point)
        && point.length >= 2
        && Number.isFinite(Number(point[0]))
        && Number.isFinite(Number(point[1]))
      ))
      .map((point): [number, number] => [
        clamp(Number(point[0]), -halfWidth, halfWidth),
        clamp(Number(point[1]), -halfDepth, halfDepth)
      ]);
    if (points.length < (type === 'river' ? 2 : 3)) continue;
    const levels = type === 'river' && Array.isArray(input.levels) && input.levels.length === points.length
      ? input.levels.map((level) => clamp(finiteNumber(level, input.level ?? 0.2), 0.02, maxLevel))
      : undefined;
    const id = typeof input.id === 'string' && input.id.trim()
      ? input.id.trim().slice(0, 80)
      : createId('water');
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: cleanName(input.name, type === 'lake' ? '湖泊' : type === 'ocean' ? '海面' : '河流'),
      type,
      level: clamp(finiteNumber(input.level, type === 'ocean' ? 0 : 0.2), type === 'ocean' ? 0 : 0.02, maxLevel),
      depth: clamp(finiteNumber(input.depth, DEFAULT_WATER_DEPTH), 0.1, MAX_WATER_DEPTH),
      width: clamp(finiteNumber(input.width, 1.2), 0.3, maxRiverWidth),
      points,
      ...(levels ? { levels } : {}),
      ...(input.shorelineSmoothness === undefined ? {} : {
        shorelineSmoothness: clamp(finiteNumber(input.shorelineSmoothness, 0), 0, 1)
      }),
      ...(input.shorelineIrregularity === undefined ? {} : {
        shorelineIrregularity: clamp(finiteNumber(input.shorelineIrregularity, 0), 0, 0.4)
      }),
      ...(input.seed === undefined ? {} : { seed: Math.trunc(finiteNumber(input.seed, 0)) }),
      generation: normalizeGenerationOwner(input.generation)
    });
  }
  return result;
}

export function mapToSummary(map: EditableMap): MapSummary {
  return {
    id: map.id,
    name: map.name,
    version: map.version,
    updatedAt: map.updatedAt,
    width: map.box.size[0],
    height: map.box.size[1],
    depth: map.box.size[2],
    objectCount: map.objects.length,
    assetGenerationMode: map.assetGenerationMode,
    confirmedAt: map.confirmedAt,
    renderSchemeId: map.renderSchemeId
  };
}

export function getMapBounds(map: EditableMap): MapBounds {
  const [width, height, depth] = map.box.size;
  return {
    minX: -width / 2,
    maxX: width / 2,
    minY: 0,
    maxY: height,
    minZ: -depth / 2,
    maxZ: depth / 2
  };
}

export function getSpawnPoints(map: EditableMap): Vec3[] {
  const point = map.spawnPoints[0] ?? defaultSpawnPoints(map.box.size)[0];
  const terrainY = sampleTerrainHeight(map, point[0], point[2]);
  return [[point[0], Math.max(point[1], terrainY), point[2]]];
}

export function getPlayerSpawnYaw(map: EditableMap): number {
  return wrapAngle(map.spawnYaw);
}

export function getSunPosition(map: EditableMap): Vec3 {
  return validVec3(map.lighting?.sunPosition, DEFAULT_SUN_POSITION);
}

export function sampleTerrainHeight(map: EditableMap, x: number, z: number): number {
  // EditableMap is normalized when loaded/saved. Re-normalizing here used to
  // allocate and copy the complete height field for every collision candidate
  // during every movement tick.
  const terrain = map.terrain;
  const [width, , depth] = map.box.size;
  const u = clamp((x + width / 2) / width, 0, 1);
  const v = clamp((z + depth / 2) / depth, 0, 1);
  const gx = u * (terrain.resolutionX - 1);
  const gz = v * (terrain.resolutionZ - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(terrain.resolutionX - 1, x0 + 1);
  const z1 = Math.min(terrain.resolutionZ - 1, z0 + 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const h00 = terrain.heights[terrainIndex(terrain, x0, z0)] ?? 0;
  const h10 = terrain.heights[terrainIndex(terrain, x1, z0)] ?? 0;
  const h01 = terrain.heights[terrainIndex(terrain, x0, z1)] ?? 0;
  const h11 = terrain.heights[terrainIndex(terrain, x1, z1)] ?? 0;
  return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
}

export function reassignRegionGenerationOwnersInPlace(map: EditableMap): void {
  const ownerAt = (x: number, z: number) => map.layout.regions.find((region) => pointInMapRegion(region, x, z));
  for (const object of map.objects) {
    if (object.generation?.kind !== 'region') continue;
    const owner = ownerAt(object.transform.position[0], object.transform.position[2]);
    object.generation = owner ? { ...object.generation, id: owner.id } : undefined;
  }
  for (const water of map.waterBodies) {
    if (water.generation?.kind !== 'region' || water.points.length === 0) continue;
    const x = water.points.reduce((sum, point) => sum + point[0], 0) / water.points.length;
    const z = water.points.reduce((sum, point) => sum + point[1], 0) / water.points.length;
    const owner = ownerAt(x, z);
    water.generation = owner ? { ...water.generation, id: owner.id } : undefined;
  }
}

export function snapTerrainObjectsInPlace(map: EditableMap): void {
  for (const object of map.objects) {
    const heightMode = object.heightMode ?? (object.assetId ? 'terrain' : 'fixed');
    if (heightMode !== 'terrain' || object.parentId) continue;
    object.transform.position[1] = sampleTerrainHeight(
      map,
      object.transform.position[0],
      object.transform.position[2]
    );
  }
}

export function applyTerrainBrush(
  map: EditableMap,
  mode: TerrainBrushMode,
  point: Vec3,
  radius: number,
  strength: number,
  targetHeight?: number
): EditableMap {
  const next: EditableMap = {
    ...map,
    terrain: {
      ...map.terrain,
      heights: [...map.terrain.heights]
    }
  };
  applyTerrainBrushInPlace(next, mode, point, radius, strength, targetHeight);
  snapTerrainObjectsInPlace(next);
  return next;
}

export function applyTerrainBrushInPlace(
  map: EditableMap,
  mode: TerrainBrushMode,
  point: Vec3,
  radius: number,
  strength: number,
  targetHeight?: number
): void {
  const next = map;
  const terrain = next.terrain;
  const [width, height, depth] = next.box.size;
  const brushRadius = clamp(Math.abs(radius), 0.15, Math.max(width, depth));
  const amount = clamp(Math.abs(strength), 0.01, height);
  const target = clamp(finiteNumber(targetHeight, point[1]), TERRAIN_MIN_HEIGHT, height - 0.1);
  const minX = clamp(Math.floor(worldToTerrainIndex(point[0] - brushRadius, width, terrain.resolutionX)), 0, terrain.resolutionX - 1);
  const maxX = clamp(Math.ceil(worldToTerrainIndex(point[0] + brushRadius, width, terrain.resolutionX)), 0, terrain.resolutionX - 1);
  const minZ = clamp(Math.floor(worldToTerrainIndex(point[2] - brushRadius, depth, terrain.resolutionZ)), 0, terrain.resolutionZ - 1);
  const maxZ = clamp(Math.ceil(worldToTerrainIndex(point[2] + brushRadius, depth, terrain.resolutionZ)), 0, terrain.resolutionZ - 1);

  for (let zIndex = minZ; zIndex <= maxZ; zIndex += 1) {
    for (let xIndex = minX; xIndex <= maxX; xIndex += 1) {
      const world = terrainPointAt(next, xIndex, zIndex);
      const dist = Math.hypot(world[0] - point[0], world[2] - point[2]);
      if (dist > brushRadius) continue;
      const weight = terrainBrushFalloff(dist / brushRadius);
      const index = terrainIndex(terrain, xIndex, zIndex);
      const current = terrain.heights[index] ?? 0;
      if (mode === 'raise') terrain.heights[index] = clamp(current + amount * weight, TERRAIN_MIN_HEIGHT, height - 0.1);
      else if (mode === 'lower') terrain.heights[index] = clamp(current - amount * weight, TERRAIN_MIN_HEIGHT, height - 0.1);
      else terrain.heights[index] = lerp(current, target, clamp(weight * amount, 0, 1));
    }
  }

  next.updatedAt = Date.now();
  next.version += 1;
}

function worldToTerrainIndex(value: number, extent: number, resolution: number): number {
  return ((value + extent / 2) / extent) * (resolution - 1);
}

export function terrainResolutionForSize(size: Vec3): number {
  const extent = Math.max(size[0], size[2]);
  return clamp(Math.round(extent / 1.5) + 1, DEFAULT_TERRAIN_RESOLUTION, MAX_TERRAIN_RESOLUTION);
}

export function addPaintStroke(map: EditableMap, stroke: Partial<MapPaintStroke> & Pick<MapPaintStroke, 'surface' | 'point'>): EditableMap {
  const next = normalizeMap(map);
  next.paintStrokes.push(createPaintStroke(stroke));
  next.paintStrokes = next.paintStrokes.slice(-1200);
  next.updatedAt = Date.now();
  next.version += 1;
  return next;
}

export function surfaceUvFromPoint(map: EditableMap, surface: MapSurface, point: Vec3): [number, number] {
  const bounds = getMapBounds(map);
  const xU = (point[0] - bounds.minX) / (bounds.maxX - bounds.minX);
  const yU = (point[1] - bounds.minY) / (bounds.maxY - bounds.minY);
  const zU = (point[2] - bounds.minZ) / (bounds.maxZ - bounds.minZ);
  switch (surface) {
    case 'ceiling':
    case 'floor':
    case 'terrain':
      return [clamp(xU, 0, 1), clamp(zU, 0, 1)];
    case 'north':
      return [clamp(xU, 0, 1), clamp(yU, 0, 1)];
    case 'south':
      return [clamp(1 - xU, 0, 1), clamp(yU, 0, 1)];
    case 'east':
      return [clamp(zU, 0, 1), clamp(yU, 0, 1)];
    case 'west':
      return [clamp(1 - zU, 0, 1), clamp(yU, 0, 1)];
  }
}

export function resolvePlayerPositionForMap(
  position: Vec3,
  map: EditableMap,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map)
): Vec3 {
  const bounds = getMapBounds(map);
  let x = clamp(position[0], bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS);
  let z = clamp(position[2], bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS);
  const playerBottom = Math.max(position[1], sampleTerrainHeight(map, x, z));
  const candidates = queryMapCollisionObstacles(
    obstacles,
    x - PLAYER_RADIUS * 2,
    x + PLAYER_RADIUS * 2,
    z - PLAYER_RADIUS * 2,
    z + PLAYER_RADIUS * 2
  );

  for (const obstacle of candidates) {
    if (!overlapsPlayerVertically(obstacle, playerBottom)) continue;
    const minX = obstacle.min[0] - PLAYER_RADIUS;
    const maxX = obstacle.max[0] + PLAYER_RADIUS;
    const minZ = obstacle.min[2] - PLAYER_RADIUS;
    const maxZ = obstacle.max[2] + PLAYER_RADIUS;
    if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) continue;

    const pushLeft = Math.abs(x - minX);
    const pushRight = Math.abs(maxX - x);
    const pushDown = Math.abs(z - minZ);
    const pushUp = Math.abs(maxZ - z);
    const smallest = Math.min(pushLeft, pushRight, pushDown, pushUp);
    if (smallest === pushLeft) x = minX;
    else if (smallest === pushRight) x = maxX;
    else if (smallest === pushDown) z = minZ;
    else z = maxZ;
  }

  return [x, getPlayerSupportHeightForMap([x, position[1], z], map, obstacles), z];
}

/**
 * Returns the highest walkable surface below the player's feet. Object tops
 * only become support after the feet have reached them from above, so walking
 * into the side of a low object never teleports the player onto it.
 */
export function getPlayerSupportHeightForMap(
  position: Vec3,
  map: EditableMap,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map)
): number {
  let supportY = sampleTerrainHeight(map, position[0], position[2]);
  const maxSupportY = position[1] + 0.05;
  const candidates = queryMapCollisionObstacles(
    obstacles,
    position[0] - PLAYER_RADIUS,
    position[0] + PLAYER_RADIUS,
    position[2] - PLAYER_RADIUS,
    position[2] + PLAYER_RADIUS
  );
  for (const obstacle of candidates) {
    const top = obstacle.max[1];
    if (top <= supportY || top > maxSupportY) continue;
    if (!playerFootprintOverlapsObstacle(position[0], position[2], obstacle)) continue;
    supportY = top;
  }
  return supportY;
}

export function stepPlayerVerticalMotionForMap(
  position: Vec3,
  velocity: number,
  dt: number,
  jumpRequested: boolean,
  map: EditableMap,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map)
): VerticalMotionState {
  const groundY = getPlayerSupportHeightForMap(position, map, obstacles);
  const vertical = stepVerticalMotion(position[1], groundY, velocity, dt, jumpRequested);
  if (vertical.y <= position[1] + MAP_COLLISION_EPSILON) return vertical;

  const headStart = Math.max(position[1], groundY) + PLAYER_HEIGHT;
  const headEnd = vertical.y + PLAYER_HEIGHT;
  const candidates = queryMapCollisionObstacles(
    obstacles,
    position[0] - PLAYER_RADIUS,
    position[0] + PLAYER_RADIUS,
    position[2] - PLAYER_RADIUS,
    position[2] + PLAYER_RADIUS
  );
  let ceilingY = Number.POSITIVE_INFINITY;
  for (const obstacle of candidates) {
    if (!playerFootprintOverlapsObstacle(position[0], position[2], obstacle)) continue;
    const underside = obstacle.min[1];
    if (underside < headStart - MAP_COLLISION_EPSILON || underside > headEnd + MAP_COLLISION_EPSILON) continue;
    ceilingY = Math.min(ceilingY, underside);
  }
  if (!Number.isFinite(ceilingY)) return vertical;

  return {
    y: Math.max(groundY, ceilingY - PLAYER_HEIGHT - MAP_COLLISION_EPSILON),
    velocity: 0,
    grounded: false
  };
}

/**
 * Moves a player along the requested horizontal delta using conservative,
 * axis-separated sweeps. Unlike endpoint-only penetration resolution, this is
 * stable across different client/server frame sizes and cannot tunnel through
 * a thin collider during a long frame. When vertical motion is supplied, the
 * player's height is sampled at the exact horizontal contact time.
 */
export function movePlayerPositionForMap(
  position: Vec3,
  delta: Vec3,
  map: EditableMap,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map),
  verticalMotion?: PlayerVerticalMotionSweep
): Vec3 {
  const start = resolvePlayerPositionForMap(position, map, obstacles);
  let x = start[0];
  let z = start[2];
  const distance = Math.hypot(delta[0], delta[2]);
  const steps = Math.max(1, Math.ceil(distance / (PLAYER_RADIUS * 0.5)));
  const stepX = delta[0] / steps;
  const stepZ = delta[2] / steps;
  const playerY = Math.max(position[1], start[1]);
  const initialSupportY = verticalMotion
    ? getPlayerSupportHeightForMap([x, position[1], z], map, obstacles)
    : start[1];
  const duration = verticalMotion && Number.isFinite(verticalMotion.duration)
    ? Math.max(0, verticalMotion.duration)
    : 0;
  const stepDuration = duration / steps;

  for (let step = 0; step < steps; step += 1) {
    const stepStartsAt = step * stepDuration;
    x = sweepPlayerAxis(
      x, z, playerY, stepX, 'x', map, obstacles,
      verticalMotion, initialSupportY, stepStartsAt, stepDuration
    );
    z = sweepPlayerAxis(
      z, x, playerY, stepZ, 'z', map, obstacles,
      verticalMotion, initialSupportY, stepStartsAt, stepDuration
    );
  }

  return [x, getPlayerSupportHeightForMap([x, playerY, z], map, obstacles), z];
}

function sweepPlayerAxis(
  primary: number,
  secondary: number,
  playerY: number,
  delta: number,
  axis: 'x' | 'z',
  map: EditableMap,
  obstacles: MapCollisionObstacles,
  verticalMotion: PlayerVerticalMotionSweep | undefined,
  initialSupportY: number,
  stepStartsAt: number,
  stepDuration: number
): number {
  const bounds = getMapBounds(map);
  const worldMin = axis === 'x' ? bounds.minX : bounds.minZ;
  const worldMax = axis === 'x' ? bounds.maxX : bounds.maxZ;
  const requestedTarget = clamp(primary + delta, worldMin + PLAYER_RADIUS, worldMax - PLAYER_RADIUS);
  const candidateX = axis === 'x' ? requestedTarget : secondary;
  const candidateZ = axis === 'z' ? requestedTarget : secondary;
  if (!isPointInsidePlayableArea(map.layout, map.box.size, candidateX, candidateZ)) return primary;
  if (Math.abs(requestedTarget - primary) <= 0.000001) return requestedTarget;
  const currentX = axis === 'x' ? primary : secondary;
  const currentZ = axis === 'z' ? primary : secondary;
  const currentTerrainY = sampleTerrainHeight(map, currentX, currentZ);
  const targetTerrainY = sampleTerrainHeight(map, candidateX, candidateZ);
  const uphillSlope = Math.atan2(
    Math.max(0, targetTerrainY - currentTerrainY),
    Math.abs(requestedTarget - primary)
  ) * 180 / Math.PI;
  if (uphillSlope > PLAYER_MAX_WALKABLE_SLOPE) {
    const targetTime = stepStartsAt + stepDuration;
    const sweptPlayerY = verticalMotion
      ? stepVerticalMotion(
          playerY,
          initialSupportY,
          verticalMotion.velocity,
          targetTime,
          verticalMotion.jumpRequested
        ).y
      : playerY;
    if (targetTerrainY > sweptPlayerY + MAP_COLLISION_EPSILON) return primary;
  }
  let target = requestedTarget;
  const minPrimary = Math.min(primary, requestedTarget) - PLAYER_RADIUS;
  const maxPrimary = Math.max(primary, requestedTarget) + PLAYER_RADIUS;
  const candidates = axis === 'x'
    ? queryMapCollisionObstacles(obstacles, minPrimary, maxPrimary, secondary - PLAYER_RADIUS, secondary + PLAYER_RADIUS)
    : queryMapCollisionObstacles(obstacles, secondary - PLAYER_RADIUS, secondary + PLAYER_RADIUS, minPrimary, maxPrimary);
  for (const obstacle of candidates) {
    const obstacleMin = (axis === 'x' ? obstacle.min[0] : obstacle.min[2]) - PLAYER_RADIUS;
    const obstacleMax = (axis === 'x' ? obstacle.max[0] : obstacle.max[2]) + PLAYER_RADIUS;
    const secondaryMin = (axis === 'x' ? obstacle.min[2] : obstacle.min[0]) - PLAYER_RADIUS;
    const secondaryMax = (axis === 'x' ? obstacle.max[2] : obstacle.max[0]) + PLAYER_RADIUS;
    if (secondary <= secondaryMin || secondary >= secondaryMax) continue;

    let contactPrimary: number;
    if (requestedTarget > primary && primary <= obstacleMin && requestedTarget > obstacleMin) {
      contactPrimary = obstacleMin;
    } else if (requestedTarget < primary && primary >= obstacleMax && requestedTarget < obstacleMax) {
      contactPrimary = obstacleMax;
    } else {
      continue;
    }

    const contactFraction = clamp(
      (contactPrimary - primary) / (requestedTarget - primary),
      0,
      1
    );
    const contactX = axis === 'x' ? contactPrimary : secondary;
    const contactZ = axis === 'z' ? contactPrimary : secondary;
    const contactTime = stepStartsAt + stepDuration * contactFraction;
    const sweptPlayerY = verticalMotion
      ? stepVerticalMotion(
        playerY,
        initialSupportY,
        verticalMotion.velocity,
        contactTime,
        verticalMotion.jumpRequested
      ).y
      : playerY;
    const playerBottom = Math.max(sweptPlayerY, sampleTerrainHeight(map, contactX, contactZ));
    if (!overlapsPlayerVertically(obstacle, playerBottom)) continue;

    if (requestedTarget > primary) {
      target = Math.min(target, obstacleMin);
    } else {
      target = Math.max(target, obstacleMax);
    }
  }

  return target;
}

function overlapsPlayerVertically(obstacle: MapObjectAabb, playerBottom: number): boolean {
  const epsilon = 0.05;
  return obstacle.max[1] > playerBottom + epsilon
    && obstacle.min[1] < playerBottom + PLAYER_HEIGHT - epsilon;
}

function playerFootprintOverlapsObstacle(x: number, z: number, obstacle: MapObjectAabb): boolean {
  const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
  const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < (PLAYER_RADIUS - MAP_COLLISION_EPSILON) ** 2;
}

export function spectatorPositionForMap(position: Vec3, map: EditableMap): Vec3 {
  const bounds = getMapBounds(map);
  return [
    clamp(position[0], bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS),
    clamp(position[1] + PLAYER_HEIGHT * 0.85, 0.8, bounds.maxY - 0.2),
    clamp(position[2], bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS)
  ];
}

export function getMapObjectAabbs(map: EditableMap): MapObjectAabb[] {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const transforms = getObjectWorldTransforms(map);
  const boxes: MapObjectAabb[] = [];
  for (const object of map.objects) {
    if (!object.visible) continue;
    const world = transforms.get(object.id);
    if (!world) continue;
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const localBoxes = asset
      ? (asset.colliderPlan?.boxes.length > 0
        ? asset.colliderPlan.boxes
        : buildModelColliderPlan(asset.modelJson, MAP_ASSET_COLLIDER_PROFILE).boxes)
      : [FALLBACK_OBJECT_BOUNDS];
    for (const local of localBoxes) {
      const transformed = transformBounds(local, world);
      boxes.push({ objectId: object.id, min: transformed.min, max: transformed.max });
    }
  }
  return boxes;
}

export function getTerrainCliffAabbs(map: EditableMap): MapObjectAabb[] {
  const thickness = Math.max(
    0.08,
    Math.min(
      map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1),
      map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1)
    ) * 0.18
  );
  return deriveTerrainCliffSegments(map).map((segment, index) => ({
    objectId: `__terrain_cliff__:${index}`,
    min: [
      Math.min(segment.start[0], segment.end[0]) - thickness,
      Math.min(segment.lowStart, segment.lowEnd),
      Math.min(segment.start[2], segment.end[2]) - thickness
    ],
    max: [
      Math.max(segment.start[0], segment.end[0]) + thickness,
      Math.max(segment.start[1], segment.end[1]),
      Math.max(segment.start[2], segment.end[2]) + thickness
    ]
  }));
}

/**
 * Bakes every visible map object's local collider into one immutable world-space
 * collision set. Aligned/overlapping boxes are merged without filling doorways
 * or gaps, then indexed into a broad-phase grid for cheap runtime queries.
 */
export function bakeMapCollisions(map: EditableMap): MapCollisionBake {
  const sourceBoxes = [...getMapObjectAabbs(map), ...getTerrainCliffAabbs(map)];
  return bakeCollisionBoxes(sourceBoxes, mapCollisionSourceHash(map));
}

export function bakeCollisionBoxes(sourceBoxes: MapObjectAabb[], sourceHash = 'dynamic'): MapCollisionBake {
  const boxes = mergeAlignedCollisionBoxes(sourceBoxes);
  return {
    version: MAP_COLLISION_BAKE_VERSION,
    sourceHash,
    sourceBoxCount: sourceBoxes.length,
    boxes,
    cellSize: MAP_COLLISION_CELL_SIZE,
    cells: buildCollisionCells(boxes, MAP_COLLISION_CELL_SIZE)
  };
}

export function getMapCollisionBake(map: EditableMap): MapCollisionBake {
  const existing = map.collisionBake;
  if (existing?.version === MAP_COLLISION_BAKE_VERSION
    && existing.sourceHash === mapCollisionSourceHash(map)) {
    return existing;
  }
  return bakeMapCollisions(map);
}

function queryMapCollisionObstacles(
  obstacles: MapCollisionObstacles,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number
): MapObjectAabb[] {
  if (Array.isArray(obstacles)) return obstacles;
  if ('base' in obstacles) {
    return [
      ...queryMapCollisionObstacles(obstacles.base, minX, maxX, minZ, maxZ),
      ...obstacles.dynamic.filter((obstacle) => obstacle.max[0] >= minX
        && obstacle.min[0] <= maxX
        && obstacle.max[2] >= minZ
        && obstacle.min[2] <= maxZ)
    ];
  }
  const cellSize = obstacles.cellSize;
  const startX = Math.floor((minX - MAP_COLLISION_EPSILON) / cellSize);
  const endX = Math.floor((maxX + MAP_COLLISION_EPSILON) / cellSize);
  const startZ = Math.floor((minZ - MAP_COLLISION_EPSILON) / cellSize);
  const endZ = Math.floor((maxZ + MAP_COLLISION_EPSILON) / cellSize);
  const cellCount = (endX - startX + 1) * (endZ - startZ + 1);
  if (!Number.isFinite(cellCount) || cellCount > 4096) return obstacles.boxes;

  const indices = new Set<number>(obstacles.cells['*'] ?? []);
  for (let z = startZ; z <= endZ; z += 1) {
    for (let x = startX; x <= endX; x += 1) {
      for (const index of obstacles.cells[collisionCellKey(x, z)] ?? []) indices.add(index);
    }
  }
  return [...indices]
    .map((index) => obstacles.boxes[index])
    .filter((box): box is MapObjectAabb => Boolean(box)
      && box.max[0] >= minX - MAP_COLLISION_EPSILON
      && box.min[0] <= maxX + MAP_COLLISION_EPSILON
      && box.max[2] >= minZ - MAP_COLLISION_EPSILON
      && box.min[2] <= maxZ + MAP_COLLISION_EPSILON);
}

function buildCollisionCells(boxes: MapObjectAabb[], cellSize: number): Record<string, number[]> {
  const cells: Record<string, number[]> = {};
  boxes.forEach((box, index) => {
    const startX = Math.floor(box.min[0] / cellSize);
    const endX = Math.floor(box.max[0] / cellSize);
    const startZ = Math.floor(box.min[2] / cellSize);
    const endZ = Math.floor(box.max[2] / cellSize);
    const cellCount = (endX - startX + 1) * (endZ - startZ + 1);
    if (!Number.isFinite(cellCount) || cellCount > 1024) {
      (cells['*'] ??= []).push(index);
      return;
    }
    for (let z = startZ; z <= endZ; z += 1) {
      for (let x = startX; x <= endX; x += 1) {
        (cells[collisionCellKey(x, z)] ??= []).push(index);
      }
    }
  });
  return cells;
}

function collisionCellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function mergeAlignedCollisionBoxes(input: MapObjectAabb[]): MapObjectAabb[] {
  const unique = new Map<string, MapObjectAabb>();
  for (const box of input) {
    if (!validCollisionBox(box)) continue;
    const key = [...box.min, ...box.max].map(collisionCoordinateKey).join('|');
    if (!unique.has(key)) unique.set(key, cloneCollisionBox(box));
  }

  let boxes = [...unique.values()];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = boxes.length;
    boxes = mergeCollisionBoxesAlongAxis(boxes, 0);
    boxes = mergeCollisionBoxesAlongAxis(boxes, 1);
    boxes = mergeCollisionBoxesAlongAxis(boxes, 2);
    if (boxes.length === before) break;
  }
  return boxes;
}

function mergeCollisionBoxesAlongAxis(boxes: MapObjectAabb[], axis: 0 | 1 | 2): MapObjectAabb[] {
  const otherAxes = ([0, 1, 2] as const).filter((candidate) => candidate !== axis);
  const groups = new Map<string, MapObjectAabb[]>();
  for (const box of boxes) {
    const key = otherAxes
      .flatMap((other) => [box.min[other], box.max[other]])
      .map(collisionCoordinateKey)
      .join('|');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(box);
  }

  const merged: MapObjectAabb[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.min[axis] - b.min[axis] || a.max[axis] - b.max[axis]);
    let current = cloneCollisionBox(group[0]);
    for (let index = 1; index < group.length; index += 1) {
      const next = group[index];
      if (next.min[axis] <= current.max[axis] + MAP_COLLISION_EPSILON) {
        current.max[axis] = Math.max(current.max[axis], next.max[axis]);
        if (current.objectId !== next.objectId) current.objectId = BAKED_MAP_OBJECT_ID;
      } else {
        merged.push(current);
        current = cloneCollisionBox(next);
      }
    }
    merged.push(current);
  }
  return merged;
}

function collisionCoordinateKey(value: number): string {
  return (Math.round(value / MAP_COLLISION_EPSILON) * MAP_COLLISION_EPSILON).toFixed(5);
}

function cloneCollisionBox(box: MapObjectAabb): MapObjectAabb {
  return { objectId: box.objectId, min: [...box.min], max: [...box.max] };
}

function validCollisionBox(box: MapObjectAabb): boolean {
  return [...box.min, ...box.max].every(Number.isFinite)
    && box.max[0] - box.min[0] > MAP_COLLISION_EPSILON
    && box.max[1] - box.min[1] > MAP_COLLISION_EPSILON
    && box.max[2] - box.min[2] > MAP_COLLISION_EPSILON;
}

function mapCollisionSourceHash(map: EditableMap): string {
  const referencedAssetIds = new Set(map.objects.map((object) => object.assetId).filter((id): id is string => Boolean(id)));
  const assets = (map.assets ?? [])
    .filter((asset) => referencedAssetIds.has(asset.id))
    .map((asset) => [asset.id, asset.colliderPlan.version, asset.colliderPlan.boxes]);
  const source = JSON.stringify({
    objects: map.objects.map((object) => [
      object.id,
      object.parentId,
      object.assetId,
      object.visible,
      object.transform.position,
      object.transform.rotation,
      object.transform.scale,
      object.transform.size
    ]),
    assets,
    terrainCliffs: deriveTerrainCliffSegments(map).map((segment) => [
      segment.start,
      segment.end,
      segment.lowStart,
      segment.lowEnd
    ])
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function firstMapRayHitDistance(
  origin: Vec3,
  direction: Vec3,
  map: EditableMap,
  maxDistance: number,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map)
): number | null {
  let closest: number | null = null;
  const targetX = origin[0] + direction[0] * maxDistance;
  const targetZ = origin[2] + direction[2] * maxDistance;
  const candidates = queryMapCollisionObstacles(
    obstacles,
    Math.min(origin[0], targetX),
    Math.max(origin[0], targetX),
    Math.min(origin[2], targetZ),
    Math.max(origin[2], targetZ)
  );
  for (const obstacle of candidates) {
    const t = rayAabbIntersection(origin, direction, obstacle.min, obstacle.max);
    if (t === null || t <= 0.05 || t > maxDistance) continue;
    if (closest === null || t < closest) closest = t;
  }
  return closest;
}

export function isLineBlockedByMap(
  origin: Vec3,
  target: Vec3,
  map: EditableMap,
  obstacles: MapCollisionObstacles = getMapCollisionBake(map)
): boolean {
  const delta: Vec3 = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const maxDistance = Math.hypot(delta[0], delta[1], delta[2]);
  if (maxDistance <= 0.00001) return false;
  const dir: Vec3 = [delta[0] / maxDistance, delta[1] / maxDistance, delta[2] / maxDistance];
  const candidates = queryMapCollisionObstacles(
    obstacles,
    Math.min(origin[0], target[0]),
    Math.max(origin[0], target[0]),
    Math.min(origin[2], target[2]),
    Math.max(origin[2], target[2])
  );
  for (const obstacle of candidates) {
    const hit = rayAabbIntersection(origin, dir, obstacle.min, obstacle.max);
    if (hit !== null && hit > 0.05 && hit < maxDistance - 0.1) return true;
  }
  return false;
}

export function getObjectWorldTransforms(map: EditableMap): Map<string, WorldTransform> {
  const byId = new Map(map.objects.map((object) => [object.id, object]));
  const cache = new Map<string, WorldTransform>();
  const visiting = new Set<string>();

  const resolve = (object: MapObject): WorldTransform => {
    const cached = cache.get(object.id);
    if (cached) return cloneWorldTransform(cached);
    if (visiting.has(object.id)) return localWorldTransform(object);
    visiting.add(object.id);
    const parent = object.parentId ? byId.get(object.parentId) : undefined;
    const world = parent ? composeWorldTransform(resolve(parent), object) : localWorldTransform(object);
    visiting.delete(object.id);
    cache.set(object.id, cloneWorldTransform(world));
    return world;
  };

  for (const object of map.objects) resolve(object);
  return cache;
}

export function terrainIndex(terrain: Pick<MapTerrain, 'resolutionX'>, x: number, z: number): number {
  return z * terrain.resolutionX + x;
}

export function terrainPointAt(map: EditableMap, xIndex: number, zIndex: number): Vec3 {
  const terrain = map.terrain;
  const [width, , depth] = map.box.size;
  const x = -width / 2 + (xIndex / Math.max(1, terrain.resolutionX - 1)) * width;
  const z = -depth / 2 + (zIndex / Math.max(1, terrain.resolutionZ - 1)) * depth;
  const y = terrain.heights[terrainIndex(terrain, xIndex, zIndex)] ?? 0;
  return [x, y, z];
}

/** Derives vertical faces from height-field steps; no duplicate cliff state is persisted. */
export function deriveTerrainCliffSegments(map: EditableMap): TerrainCliffSegment[] {
  const terrain = map.terrain;
  const stepX = map.box.size[0] / Math.max(1, terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, terrain.resolutionZ - 1);
  const segments: TerrainCliffSegment[] = [];
  const thresholdX = stepX * 1.15;
  const thresholdZ = stepZ * 1.15;

  for (let xIndex = 0; xIndex < terrain.resolutionX - 1; xIndex += 1) {
    for (let zIndex = 0; zIndex < terrain.resolutionZ - 1; zIndex += 1) {
      const leftA = terrainPointAt(map, xIndex, zIndex);
      const leftB = terrainPointAt(map, xIndex, zIndex + 1);
      const rightA = terrainPointAt(map, xIndex + 1, zIndex);
      const rightB = terrainPointAt(map, xIndex + 1, zIndex + 1);
      if (Math.abs((leftA[1] + leftB[1]) - (rightA[1] + rightB[1])) * 0.5 >= thresholdX) {
        const leftHigh = leftA[1] + leftB[1] >= rightA[1] + rightB[1];
        segments.push({
          start: [(leftA[0] + rightA[0]) * 0.5, leftHigh ? leftA[1] : rightA[1], leftA[2]],
          end: [(leftB[0] + rightB[0]) * 0.5, leftHigh ? leftB[1] : rightB[1], leftB[2]],
          lowStart: leftHigh ? rightA[1] : leftA[1],
          lowEnd: leftHigh ? rightB[1] : leftB[1]
        });
      }
      if (Math.abs((leftA[1] + rightA[1]) - (leftB[1] + rightB[1])) * 0.5 >= thresholdZ) {
        const nearHigh = leftA[1] + rightA[1] >= leftB[1] + rightB[1];
        segments.push({
          start: [leftA[0], nearHigh ? leftA[1] : leftB[1], (leftA[2] + leftB[2]) * 0.5],
          end: [rightA[0], nearHigh ? rightA[1] : rightB[1], (rightA[2] + rightB[2]) * 0.5],
          lowStart: nearHigh ? leftB[1] : leftA[1],
          lowEnd: nearHigh ? rightB[1] : rightA[1]
        });
      }
    }
  }
  return segments;
}

function terrainBrushFalloff(normalizedDistance: number): number {
  const t = clamp(normalizedDistance, 0, 1);
  return (1 - t * t) ** 2;
}

export function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.slice(0, 18)}`;
}

function normalizeObject(input: Partial<MapObject>): MapObject {
  return {
    id: typeof input.id === 'string' && input.id ? input.id : createId('obj'),
    name: cleanName(input.name, '未命名物体'),
    parentId: typeof input.parentId === 'string' && input.parentId ? input.parentId : null,
    assetId: typeof input.assetId === 'string' && input.assetId ? input.assetId : null,
    transform: normalizeTransform(input.transform),
    heightMode: input.heightMode === 'terrain' || input.heightMode === 'fixed'
      ? input.heightMode
      : input.assetId ? 'terrain' : 'fixed',
    visible: input.visible !== false,
    locked: input.locked === true,
    behavior: normalizeObjectBehavior(input.behavior),
    generation: normalizeGenerationOwner(input.generation)
  };
}

function normalizeObjectBehavior(value: unknown): MapObjectBehavior | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<MapObjectBehavior>;
  const kinds: MapBehaviorKind[] = ['static', 'solitary', 'pair', 'flock', 'herd', 'school', 'territorial'];
  const locomotions: MapLocomotion[] = ['static', 'ground', 'air', 'water', 'mixed'];
  if (!kinds.includes(input.kind as MapBehaviorKind) || !locomotions.includes(input.locomotion as MapLocomotion)) return undefined;
  const animationInput = input.animation;
  const state = typeof animationInput?.state === 'string' ? animationInput.state.trim().slice(0, 48) : '';
  return {
    kind: input.kind as MapBehaviorKind,
    locomotion: input.locomotion as MapLocomotion,
    groupRole: input.groupRole === 'core' || input.groupRole === 'outlier' ? input.groupRole : undefined,
    groupIndex: Number.isInteger(input.groupIndex) ? Math.max(0, Number(input.groupIndex)) : undefined,
    animation: state ? {
      state,
      speed: clamp(finiteNumber(animationInput?.speed, 1), 0, 4),
      phase: clamp(finiteNumber(animationInput?.phase, 0), 0, 1)
    } : undefined
  };
}

function normalizeGenerationOwner(value: unknown): MapGenerationOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<MapGenerationOwner>;
  if ((input.kind !== 'region' && input.kind !== 'seam')
    || typeof input.id !== 'string' || !input.id.trim()
    || typeof input.generationId !== 'string' || !input.generationId.trim()) return undefined;
  return {
    kind: input.kind,
    id: input.id.trim().slice(0, 80),
    generationId: input.generationId.trim().slice(0, 80)
  };
}

function normalizeAsset(input: Partial<MapAsset>): MapAsset {
  const now = Date.now();
  const colliderPlan = normalizeModelColliderPlan(input.colliderPlan, input.modelJson, MAP_ASSET_COLLIDER_PROFILE);
  const footprintRadius = Number.isFinite(Number(input.footprintRadius))
    ? Math.max(0.1, Number(input.footprintRadius))
    : assetFootprintRadius(colliderPlan);
  return {
    id: typeof input.id === 'string' && input.id ? input.id : createId('asset'),
    name: cleanName(input.name, '未命名资产'),
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    tags: normalizeAssetTags(input.tags),
    modelJson: input.modelJson ?? null,
    colliderPlan,
    footprintRadius,
    sizeClass: input.sizeClass === 'small' || input.sizeClass === 'medium' || input.sizeClass === 'large'
      ? input.sizeClass
      : assetSizeClass(footprintRadius),
    mode: typeof input.mode === 'string' && input.mode ? input.mode : 'voxel',
    provider: typeof input.provider === 'string' && input.provider ? input.provider : undefined,
    libraryId: typeof input.libraryId === 'string' && input.libraryId ? input.libraryId : undefined,
    libraryMetadata: input.libraryMetadata,
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}

function normalizeTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function normalizeMapCollisionBake(input: Partial<MapCollisionBake> | undefined): MapCollisionBake | undefined {
  if (input?.version !== MAP_COLLISION_BAKE_VERSION
    || typeof input.sourceHash !== 'string'
    || !Array.isArray(input.boxes)) return undefined;
  const boxes = input.boxes
    .map((box) => ({
      objectId: typeof box?.objectId === 'string' ? box.objectId : BAKED_MAP_OBJECT_ID,
      min: validVec3(box?.min, [0, 0, 0]),
      max: validVec3(box?.max, [0, 0, 0])
    }))
    .filter(validCollisionBox);
  const cellSize = clamp(finiteNumber(input.cellSize, MAP_COLLISION_CELL_SIZE), 1, 32);
  return {
    version: MAP_COLLISION_BAKE_VERSION,
    sourceHash: input.sourceHash,
    sourceBoxCount: Math.max(boxes.length, Math.round(finiteNumber(input.sourceBoxCount, boxes.length))),
    boxes,
    cellSize,
    cells: buildCollisionCells(boxes, cellSize)
  };
}

function normalizeTransform(transform?: Partial<Transform3D>): Transform3D {
  return {
    position: validVec3(transform?.position, DEFAULT_TRANSFORM.position),
    rotation: validVec3(transform?.rotation, DEFAULT_TRANSFORM.rotation),
    scale: positiveVec3(transform?.scale, DEFAULT_TRANSFORM.scale),
    size: positiveVec3(transform?.size, DEFAULT_TRANSFORM.size)
  };
}

function createFlatTerrain(resolutionX: number, resolutionZ: number): MapTerrain {
  return {
    resolutionX,
    resolutionZ,
    heights: Array.from({ length: resolutionX * resolutionZ }, () => 0)
  };
}

function normalizeLighting(input: Partial<MapLighting> | undefined): MapLighting {
  return {
    sunPosition: validVec3(input?.sunPosition, DEFAULT_SUN_POSITION)
  };
}

function normalizeTerrain(input: Partial<MapTerrain> | undefined, fallbackX: number, fallbackZ: number): MapTerrain {
  const sourceX = clamp(Math.round(finiteNumber(input?.resolutionX, fallbackX)), 2, MAX_TERRAIN_RESOLUTION);
  const sourceZ = clamp(Math.round(finiteNumber(input?.resolutionZ, fallbackZ)), 2, MAX_TERRAIN_RESOLUTION);
  const resolutionX = clamp(Math.max(sourceX, fallbackX), 2, MAX_TERRAIN_RESOLUTION);
  const resolutionZ = clamp(Math.max(sourceZ, fallbackZ), 2, MAX_TERRAIN_RESOLUTION);
  const sourceLength = sourceX * sourceZ;
  const sourceHeights = Array.isArray(input?.heights)
    ? input.heights.slice(0, sourceLength).map((value) => clamp(finiteNumber(value, 0), TERRAIN_MIN_HEIGHT, 64))
    : [];
  while (sourceHeights.length < sourceLength) sourceHeights.push(0);
  const heights = sourceX === resolutionX && sourceZ === resolutionZ
    ? sourceHeights
    : resampleTerrainHeights(sourceHeights, sourceX, sourceZ, resolutionX, resolutionZ);
  return { resolutionX, resolutionZ, heights };
}

function resampleTerrainHeights(source: number[], sourceX: number, sourceZ: number, targetX: number, targetZ: number): number[] {
  const heights: number[] = [];
  for (let z = 0; z < targetZ; z += 1) {
    const gz = (z / Math.max(1, targetZ - 1)) * (sourceZ - 1);
    const z0 = Math.floor(gz);
    const z1 = Math.min(sourceZ - 1, z0 + 1);
    const tz = gz - z0;
    for (let x = 0; x < targetX; x += 1) {
      const gx = (x / Math.max(1, targetX - 1)) * (sourceX - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(sourceX - 1, x0 + 1);
      const tx = gx - x0;
      const h00 = source[z0 * sourceX + x0] ?? 0;
      const h10 = source[z0 * sourceX + x1] ?? 0;
      const h01 = source[z1 * sourceX + x0] ?? 0;
      const h11 = source[z1 * sourceX + x1] ?? 0;
      heights.push(lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz));
    }
  }
  return heights;
}

function normalizeSpawnPoints(points: unknown, size: Vec3): Vec3[] {
  const [width, height, depth] = size;
  const source = Array.isArray(points) && points.length > 0 ? points[0] : defaultSpawnPoints(size)[0];
  const point = validVec3(source, [0, 0, 0]);
  return [[
    clamp(point[0], -width / 2 + PLAYER_RADIUS, width / 2 - PLAYER_RADIUS),
    clamp(point[1], 0, Math.max(0, height - PLAYER_HEIGHT)),
    clamp(point[2], -depth / 2 + PLAYER_RADIUS, depth / 2 - PLAYER_RADIUS)
  ]];
}

function defaultSpawnPoints(size: Vec3): Vec3[] {
  return [[0, 0, 0]];
}

function composeWorldTransform(parent: WorldTransform, object: MapObject): WorldTransform {
  const local = object.transform;
  const localScale = mulVec3(local.scale, local.size);
  return {
    position: addVec3(parent.position, rotateEuler(mulVec3(parent.scale, local.position), parent.rotation)),
    rotation: addVec3(parent.rotation, local.rotation),
    scale: mulVec3(parent.scale, localScale)
  };
}

function localWorldTransform(object: MapObject): WorldTransform {
  return {
    position: [...object.transform.position],
    rotation: [...object.transform.rotation],
    scale: mulVec3(object.transform.scale, object.transform.size)
  };
}

function transformBounds(bounds: Aabb, transform: WorldTransform): Aabb {
  let result: Aabb | null = null;
  for (const corner of boundsCorners(bounds)) {
    result = includePoint(result, addVec3(transform.position, rotateEuler(mulVec3(transform.scale, corner), transform.rotation)));
  }
  return result ?? { min: [0, 0, 0], max: [0, 0, 0] };
}

function boundsCorners(bounds: Aabb): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function includePoint(bounds: Aabb | null, point: Vec3): Aabb {
  if (!bounds) return { min: [...point], max: [...point] };
  return {
    min: [
      Math.min(bounds.min[0], point[0]),
      Math.min(bounds.min[1], point[1]),
      Math.min(bounds.min[2], point[2])
    ],
    max: [
      Math.max(bounds.max[0], point[0]),
      Math.max(bounds.max[1], point[1]),
      Math.max(bounds.max[2], point[2])
    ]
  };
}

function rotateEuler(vector: Vec3, rotation: Vec3): Vec3 {
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  let x = vector[0];
  let y = vector[1];
  let z = vector[2];

  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  y = y1;
  z = z1;

  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2;
  z = z2;

  const x3 = x * cz - y * sz;
  const y3 = x * sz + y * cz;
  return [x3, y3, z];
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^0x[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.slice(2).toLowerCase()}`;
  return fallback;
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().slice(0, 48);
  return cleaned || fallback;
}

function cloneTransform(transform: Transform3D): Transform3D {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
    size: [...transform.size]
  };
}

function cloneWorldTransform(transform: WorldTransform): WorldTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale]
  };
}

function validVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2])
  ];
}

function positiveVec3(value: unknown, fallback: Vec3): Vec3 {
  const vector = validVec3(value, fallback);
  return [
    vector[0] > 0 ? vector[0] : fallback[0],
    vector[1] > 0 ? vector[1] : fallback[1],
    vector[2] > 0 ? vector[2] : fallback[2]
  ];
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mulVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
