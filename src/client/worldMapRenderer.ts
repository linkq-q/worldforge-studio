import * as THREE from 'three';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
  type RuntimeGrassStyle,
  type RuntimeTerrainMaterialStyle
} from '../shared/renderPlan';
import { DEFAULT_MAP_DESIGN_SEMANTICS } from '../shared/mapDesign';
import { createDefaultMapLayout } from '../shared/mapLayout';
import { calculateModelVisualFrame } from '../shared/modelBounds';
import { DEFAULT_MAP_VISUAL_SEMANTICS, type SceneVisualZone, type VisualZoneTag } from '../shared/visualDirection';
import { generateEcologyChunk, selectEcologyChunks, type EcologyChunk, type EcologyInstance } from '../shared/worldEcology';
import { createWorldEcologyDensity, createWorldExclusion, type TownBuilding } from '../shared/worldPlanning';
import { dominantBiome, sampleWorldTile, selectWorldTiles, type WorldBiome, type WorldTile } from '../shared/worldTerrain';
import { worldMapSampler, type WorldAssetBinding } from '../shared/worldMapState';
import type { ColorPalette } from '../shared/colorPalette';
import type { SceneArtPlan } from '../shared/sceneArt';
import type { Vec3 } from '../shared/protocol';
import { getObjectWorldTransforms, type EditableMap, type MapAsset, type MapObject, type MapWaterBody } from '../shared/map';
import type { MapGuide } from '../shared/mapGuide';
import type { PaletteCoverageReport } from './paletteMaterialRuntime';
import {
  buildNormalizedEditableMapGroupCore,
  type MapRenderOptions,
  type RenderedMap,
  type RenderedMapDebugStats
} from './mapRenderer';
import {
  buildMapMeshCollisionWorld,
  createCollisionMeshInstance,
  MeshCollisionWorld
} from './mapMeshCollision';

const TERRAIN_TILE_BUDGET = 128;
const CONTENT_DISTANCE_LIMIT = 3_000;
const EMPTY_PALETTE_REPORT: PaletteCoverageReport = {
  strictMaterials: 0,
  approximateMaterials: 0,
  technicalMaterials: 0,
  unmatchedMaterials: 0,
  usedColors: [],
  roleCounts: {}
};

interface GlobalBuilding extends TownBuilding { x: number; z: number; townId: string }
interface ManualObjectTree { rootId: string; x: number; z: number; objects: MapObject[] }
interface ReconcileRequest { x: number; z: number; distance: number }
interface TileEntry {
  tile: WorldTile;
  signature: string;
  map: EditableMap;
  rendered: RenderedMap;
  terrainMount: THREE.Group;
  collision: MeshCollisionWorld | null;
  buildings: number;
  ecology: number;
  texturePixels: number;
}

function groupManualObjectTrees(map: EditableMap): ManualObjectTree[] {
  const byId = new Map(map.objects.map(object => [object.id, object]));
  const worldTransforms = getObjectWorldTransforms(map);
  const rootIds = new Map<string, string>();
  const rootIdFor = (object: MapObject): string => {
    const cached = rootIds.get(object.id);
    if (cached) return cached;
    const path: MapObject[] = [];
    const seen = new Set<string>();
    let current = object;
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = byId.get(current.parentId)!;
    }
    for (const item of path) rootIds.set(item.id, current.id);
    rootIds.set(current.id, current.id);
    return current.id;
  };
  const grouped = new Map<string, MapObject[]>();
  for (const object of map.objects) {
    const rootId = rootIdFor(object);
    const objects = grouped.get(rootId) ?? [];
    objects.push(object);
    grouped.set(rootId, objects);
  }
  return [...grouped].map(([rootId, objects]) => {
    const position = worldTransforms.get(rootId)?.position ?? byId.get(rootId)?.transform.position ?? [0, 0, 0];
    return { rootId, x: position[0], z: position[2], objects };
  });
}

function manualObjectsForTile(
  trees: ManualObjectTree[],
  tile: WorldTile,
  contentKeys: ReadonlySet<string>,
  centerX: number,
  centerZ: number
): MapObject[] {
  return trees
    .filter(tree => contentKeys.has(pointEcologyKey(tree.x, tree.z)) && tileContains(tile, tree.x, tree.z))
    .flatMap(tree => tree.objects.map(object => ({
      ...object,
      transform: {
        ...object.transform,
        position: object.id === tree.rootId
          ? [object.transform.position[0] - centerX, object.transform.position[1], object.transform.position[2] - centerZ]
          : [...object.transform.position],
        rotation: [...object.transform.rotation],
        scale: [...object.transform.scale],
        size: [...object.transform.size]
      }
    })));
}

interface StreamStyleState {
  grass: RuntimeGrassStyle;
  terrain: RuntimeTerrainMaterialStyle;
  palette: ColorPalette | null;
  sceneArt: SceneArtPlan | null;
  sceneArtPalette?: ColorPalette;
  wetness: number;
  snowCover: number;
  sandFlow: number;
  timeOfDay: Parameters<RenderedMap['setLightingTimeOfDay']>[0];
  lightingQuality: number;
  lightingSoloObjectId: string | null;
  lightingHelpersVisible: boolean;
  environment: THREE.Texture | null;
  waterEnvironment: THREE.Texture | null;
}

export async function buildStreamedWorldMapGroup(map: EditableMap, options: MapRenderOptions = {}): Promise<RenderedMap> {
  if (!map.world) throw new Error('world_renderer_requires_world');
  const world = map.world;
  const bundle = world.bundle;
  const sample = worldMapSampler(world);
  const root = new THREE.Group();
  root.name = `world-map:${map.id}`;
  const modelsRoot = new THREE.Group();
  modelsRoot.name = 'modelsRoot';
  modelsRoot.userData.isModelRoot = true;
  root.add(modelsRoot);

  const assetsById = new Map((map.assets ?? []).map(asset => [asset.id, asset]));
  const bindingsByKey = new Map(world.assets.map(binding => [binding.key, binding]));
  const bindingsByRole = groupBindingsByRole(world.assets);
  validateWorldAssets(map, bindingsByKey, bindingsByRole, assetsById);
  const buildings = globalBuildings(bundle);
  const roads = globalRoads(bundle);
  const manualObjectTrees = groupManualObjectTrees(map);
  const ecologyCache = new Map<string, EcologyInstance[]>();
  const exclusion = createWorldExclusion(bundle.plan, bundle.patches);
  const density = createWorldEcologyDensity(bundle.plan, bundle.patches);
  const entries = new Map<string, TileEntry>();
  const objectGroups = new Map<string, THREE.Group>();
  const pickables: THREE.Object3D[] = [];
  const listeners = new Set<() => void>();
  const runtimeIndex = new RuntimeIndex();
  let collisionWorld: MeshCollisionWorld | null = null;
  let disposed = false;
  let pendingTiles = 0;
  let unloadedTiles = 0;
  let desiredRequest: ReconcileRequest | null = null;
  let appliedRequest: ReconcileRequest | null = null;
  let failedRequest: { key: string; at: number } | null = null;
  let reconciling = false;
  let activeCenter: Vec3 = [map.spawnPoints[0]?.[0] ?? 0, 0, map.spawnPoints[0]?.[2] ?? 0];
  let activeLightingSize: Vec3 = [1280, 256, 1280];
  const style: StreamStyleState = {
    grass: DEFAULT_RUNTIME_GRASS_STYLE,
    terrain: DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
    palette: null,
    sceneArt: null,
    wetness: 0,
    snowCover: 0,
    sandFlow: 0,
    timeOfDay: 'noon',
    lightingQuality: 1,
    lightingSoloObjectId: null,
    lightingHelpersVisible: false,
    environment: null,
    waterEnvironment: null
  };

  const initialX = map.spawnPoints[0]?.[0] ?? 0;
  const initialZ = map.spawnPoints[0]?.[2] ?? 0;
  await reconcile(initialX, initialZ, 50);
  appliedRequest = desiredRequest = normalizedReconcileRequest(initialX, initialZ, 50);

  async function reconcile(focusX: number, focusZ: number, distance: number): Promise<void> {
    const tiles = selectWorldTiles(bundle.plan.recipe.size, focusX, focusZ, distance, TERRAIN_TILE_BUDGET);
    const contentChunks = selectEcologyChunks(
      bundle.plan.recipe.size,
      focusX,
      focusZ,
      distance > CONTENT_DISTANCE_LIMIT ? distance : 0
    );
    const contentKeys = new Set(contentChunks.map(ecologyKey));
    const oceanOwner = tiles.find(tile => tileContains(tile, focusX, focusZ));
    const desired = new Map(tiles.map(tile => {
      const logicalKey = tileKey(tile);
      const localContent = contentChunks.filter(chunk => chunkIntersectsTile(chunk, tile));
      const signature = `${logicalKey}|${localContent.map(ecologyKey).join(',')}|o${oceanOwner === tile ? 1 : 0}`;
      return [logicalKey, { tile, signature, localContent, ocean: oceanOwner === tile }] as const;
    }));
    const missing = [...desired.entries()]
      .filter(([key, value]) => entries.get(key)?.signature !== value.signature)
      .sort(([, left], [, right]) => tileDistanceSquared(left.tile, focusX, focusZ) - tileDistanceSquared(right.tile, focusX, focusZ));
    pendingTiles = missing.length;
    const built = new Map<string, TileEntry>();
    for (let index = 0; index < missing.length && !disposed; index += 4) {
      const batch = missing.slice(index, index + 4);
      const results = await Promise.allSettled(batch.map(async ([key, value]) => [key, await buildEntry(value.tile, value.signature, value.localContent, value.ocean)] as const));
      for (const result of results) if (result.status === 'fulfilled') built.set(result.value[0], result.value[1]);
      pendingTiles -= results.length;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        built.forEach(disposeEntry);
        pendingTiles = 0;
        throw failure.reason;
      }
    }
    if (disposed) {
      built.forEach(disposeEntry);
      return;
    }
    for (const [key, entry] of entries) {
      const replacement = built.get(key);
      if (!desired.has(key) || replacement) {
        unmountEntry(entry);
        disposeEntry(entry);
        entries.delete(key);
        unloadedTiles += 1;
      }
    }
    for (const [key, entry] of built) {
      if (!desired.has(key)) { disposeEntry(entry); continue; }
      entries.set(key, entry);
      mountEntry(entry);
    }
    rebuildPublicIndexes();
    rebuildCollision();
    updateLightingBounds(focusX, focusZ);
    listeners.forEach(listener => listener());
  }

  async function buildEntry(
    tile: WorldTile,
    signature: string,
    contentChunks: EcologyChunk[],
    includeOcean: boolean
  ): Promise<TileEntry> {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const resolution = tile.size <= 256 ? 65 : tile.size <= 2_048 ? 33 : 17;
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, resolution, sample);
    const tileMap = makeTileMap(tile, sampled.heights, contentChunks, includeOcean);
    const textureSize = tile.size <= 256 ? 256 : tile.size <= 2_048 ? 128 : 64;
    const rendered = await buildNormalizedEditableMapGroupCore(tileMap, {
      ...options,
      editorHelpers: false,
      terrainTextureSize: textureSize,
      terrainBorderSides: false
    });
    applyStyle(rendered, tileMap, tile);
    const terrainMount = new THREE.Group();
    terrainMount.name = `world-tile:${tileKey(tile)}`;
    terrainMount.position.set(centerX, 0, centerZ);
    const collision = tile.size <= 256 ? buildMapMeshCollisionWorld(tileMap) : null;
    return {
      tile,
      signature,
      map: tileMap,
      rendered,
      terrainMount,
      collision,
      buildings: tileMap.objects.filter(object => object.id.startsWith('world-building:')).length,
      ecology: tileMap.objects.filter(object => object.id.startsWith('world-ecology:')).length,
      texturePixels: textureSize * textureSize * 4
    };
  }

  function makeTileMap(
    tile: WorldTile,
    heights: Float32Array,
    contentChunks: EcologyChunk[],
    includeOcean: boolean
  ): EditableMap {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const contentKeys = new Set(contentChunks.map(ecologyKey));
    const tileBuildings = buildings.filter(building => contentKeys.has(pointEcologyKey(building.x, building.z))
      && tileContains(tile, building.x, building.z));
    const ecology = contentChunks.flatMap(chunk => ecologyForChunk(chunk))
      .filter(instance => tileContains(tile, instance.x, instance.z));
    const objects = [
      ...tileBuildings.map(building => buildingObject(building, centerX, centerZ)),
      ...ecology.map(instance => ecologyObject(instance, centerX, centerZ)),
      ...manualObjectsForTile(manualObjectTrees, tile, contentKeys, centerX, centerZ)
    ];
    const usedAssetIds = new Set(objects.flatMap(object => object.assetId ? [object.assetId] : []));
    const boxSize: Vec3 = [tile.size, map.box.size[1], tile.size];
    const waterBodies = tileWaterBodies(tile, includeOcean);
    return {
      ...map,
      id: `${map.id}:world:${tileKey(tile)}`,
      name: `${map.name} ${tileKey(tile)}`,
      world: undefined,
      box: { ...map.box, size: boxSize },
      sceneMode: 'outdoor',
      room: null,
      interiorArtDirection: null,
      terrain: { resolutionX: Math.sqrt(heights.length), resolutionZ: Math.sqrt(heights.length), heights: Array.from(heights) },
      grassLayers: [],
      waterBodies,
      paintStrokes: [],
      objects,
      spawnPoints: [[0, sample(centerX, centerZ).height, 0]],
      visualSemantics: {
        version: 1,
        zones: [...biomeZones(tile), ...roadZones(tile)],
        wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind }
      },
      layout: createDefaultMapLayout(boxSize),
      guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS,
      assets: (map.assets ?? []).filter(asset => usedAssetIds.has(asset.id)),
      collisionBake: undefined
    };
  }

  function ecologyForChunk(chunk: EcologyChunk): EcologyInstance[] {
    const key = ecologyKey(chunk);
    const cached = ecologyCache.get(key);
    if (cached) return cached;
    const generated = generateEcologyChunk(bundle.plan.recipe, bundle.plan.ecology, chunk, { sample, exclusion, density }).instances;
    ecologyCache.set(key, generated);
    return generated;
  }

  function buildingObject(building: GlobalBuilding, centerX: number, centerZ: number): MapObject {
    const asset = resolveBuildingAsset(building);
    const scale = asset ? fitAssetScale(asset, building.width, building.depth) : 1;
    return {
      id: `world-building:${building.id}`,
      name: building.use || building.id,
      parentId: null,
      assetId: asset?.id ?? null,
      transform: {
        position: [building.x - centerX, sample(building.x, building.z).height, building.z - centerZ],
        rotation: [0, building.rotation ?? 0, 0],
        scale: [1, 1, 1],
        size: asset ? [scale, scale, scale] : [building.width, building.height, building.depth]
      },
      heightMode: 'fixed',
      visible: true,
      locked: true,
      behavior: { kind: 'static', locomotion: 'static' }
    };
  }

  function ecologyObject(instance: EcologyInstance, centerX: number, centerZ: number): MapObject {
    const asset = resolveEcologyAsset(instance);
    const targetWidth = instance.kind === 'shrub' ? 2.2 : instance.kind === 'rock' ? 1.8 : 9;
    const scale = asset ? fitAssetScale(asset, targetWidth * instance.scale, targetWidth * instance.scale) : 1;
    const fallbackSize: Vec3 = instance.kind === 'rock'
      ? [1.8 * instance.scale, 1.2 * instance.scale, 1.6 * instance.scale]
      : instance.kind === 'shrub'
        ? [2.2 * instance.scale, 1.6 * instance.scale, 2.2 * instance.scale]
        : [2.4 * instance.scale, 8 * instance.scale, 2.4 * instance.scale];
    return {
      id: `world-ecology:${instance.id}`,
      name: instance.kind,
      parentId: null,
      assetId: asset?.id ?? null,
      transform: {
        position: [instance.x - centerX, instance.y, instance.z - centerZ],
        rotation: [0, instance.rotation, 0],
        scale: [1, 1, 1],
        size: asset ? [scale, scale, scale] : fallbackSize
      },
      heightMode: 'fixed',
      visible: true,
      locked: true,
      behavior: { kind: 'static', locomotion: 'static' }
    };
  }

  function resolveBuildingAsset(building: GlobalBuilding): MapAsset | null {
    if (world.assets.length === 0) return null;
    let binding: WorldAssetBinding | undefined;
    if (building.assetKey) binding = bindingsByKey.get(building.assetKey);
    else {
      const role = buildingRole(building);
      const candidates = bindingsByRole.get(role) ?? [];
      binding = candidates[stableIndex(building.id, candidates.length)];
    }
    if (!binding) throw new Error(`world_missing_asset_binding:${building.assetKey ?? buildingRole(building)}`);
    const asset = assetsById.get(binding.assetId);
    if (!asset) throw new Error(`world_missing_asset:${binding.assetId}`);
    return asset;
  }

  function resolveEcologyAsset(instance: EcologyInstance): MapAsset | null {
    if (world.assets.length === 0) return null;
    const candidates = bindingsByRole.get('tree') ?? [];
    const binding = candidates[stableIndex(instance.id, candidates.length)];
    if (!binding) throw new Error('world_missing_asset_binding:tree');
    const asset = assetsById.get(binding.assetId);
    if (!asset) throw new Error(`world_missing_asset:${binding.assetId}`);
    return asset;
  }

  function biomeZones(tile: WorldTile): SceneVisualZone[] {
    const zones: SceneVisualZone[] = [];
    const cells = tile.size <= 2_048 ? 4 : 2;
    for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
      const worldX = tile.x + (x + 0.5) * tile.size / cells;
      const worldZ = tile.z + (z + 0.5) * tile.size / cells;
      const localX = worldX - tile.x - tile.size / 2;
      const localZ = worldZ - tile.z - tile.size / 2;
      const radius = tile.size / cells * 0.78;
      const tags = biomeTags(dominantBiome(sample(worldX, worldZ)));
      zones.push({
        id: `world-biome:${tileKey(tile)}:${x}:${z}`,
        tags,
        center: [localX, localZ],
        radius,
        intensity: 0.92,
        region: { kind: 'circle', x: localX, z: localZ, radius }
      });
    }
    return zones;
  }

  function roadZones(tile: WorldTile): SceneVisualZone[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const result: SceneVisualZone[] = [];
    for (const road of roads) {
      const points = road.closed ? [...road.points, road.points[0]] : road.points;
      for (let index = 1; index < points.length; index++) {
        const clipped = clipSegment(points[index - 1], points[index], tile.x, tile.z, tile.x + tile.size, tile.z + tile.size);
        if (!clipped) continue;
        const local = clipped.map(([x, z]) => [x - centerX, z - centerZ] as [number, number]);
        const settlement = road.id.startsWith('town:') || road.tags.some(tag => /street|settlement|town/i.test(tag));
        result.push({
          id: `world-road:${road.id}:${index}:${tileKey(tile)}`,
          tags: ['paving', 'settlement'],
          center: [(local[0][0] + local[1][0]) / 2, (local[0][1] + local[1][1]) / 2],
          radius: Math.hypot(local[1][0] - local[0][0], local[1][1] - local[0][1]) / 2 + road.width,
          intensity: 1,
          material: settlement ? 'brick-paver' : 'compacted-earth',
          region: { kind: 'path', points: local, width: road.width }
        });
      }
    }
    return result;
  }

  function tileWaterBodies(tile: WorldTile, includeOcean: boolean): MapWaterBody[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const bodies = (bundle.plan.recipe.waterBodies ?? []).flatMap((water): MapWaterBody[] => {
      const owner = water.region.kind === 'circle'
        ? water.region.center
        : water.region.points[Math.floor(water.region.points.length / 2)];
      if (!tileContains(tile, owner[0], owner[1])) return [];
      if (water.region.kind === 'circle') {
        const region = water.region;
        const points = Array.from({ length: 32 }, (_, index): [number, number] => {
          const angle = index / 32 * Math.PI * 2;
          return [region.center[0] + Math.cos(angle) * region.radius - centerX,
            region.center[1] + Math.sin(angle) * region.radius - centerZ];
        });
        return [{
          id: water.id,
          name: water.id,
          type: 'lake',
          level: water.levels[0] ?? 0,
          depth: water.depth,
          width: region.radius * 2,
          points
        }];
      }
      return [{
        id: water.id,
        name: water.id,
        type: 'river',
        level: water.levels.reduce((sum, level) => sum + level, 0) / water.levels.length,
        levels: [...water.levels],
        depth: water.depth,
        width: water.region.width,
        points: water.region.points.map(([x, z]) => [x - centerX, z - centerZ])
      }];
    });
    if (includeOcean) bodies.push({
      id: 'world-ocean',
      name: '海面',
      type: 'ocean',
      level: 0,
      depth: 12,
      width: tile.size,
      points: [[-tile.size / 2, -tile.size / 2], [tile.size / 2, -tile.size / 2], [tile.size / 2, tile.size / 2], [-tile.size / 2, tile.size / 2]]
    });
    return bodies;
  }

  function applyStyle(rendered: RenderedMap, tileMap: EditableMap, tile: WorldTile): void {
    if (!sameValue(style.grass, DEFAULT_RUNTIME_GRASS_STYLE)) rendered.setGrassStyle(style.grass);
    if (!sameValue(style.terrain, DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE)) rendered.setTerrainMaterialStyle(style.terrain);
    if (style.palette) rendered.setColorPalette(style.palette);
    if (style.sceneArt) rendered.setSceneArt(localSceneArt(style.sceneArt, tileMap, tile), style.sceneArtPalette);
    if (style.wetness || style.snowCover) rendered.setWeatherSurface(style.wetness, style.snowCover);
    if (style.sandFlow) rendered.setSandFlowStrength(style.sandFlow);
    if (style.timeOfDay !== 'noon') rendered.setLightingTimeOfDay(style.timeOfDay);
    if (style.lightingQuality !== 1) rendered.setLightingQuality(style.lightingQuality);
    if (style.lightingSoloObjectId) rendered.setLightingSoloObjectId(style.lightingSoloObjectId);
    if (style.lightingHelpersVisible) rendered.setLightingHelpersVisible(true);
    if (style.environment || style.waterEnvironment) rendered.syncMaterialEnvironment(style.environment, style.waterEnvironment);
  }

  function mountEntry(entry: TileEntry): void {
    const centerX = entry.tile.x + entry.tile.size / 2;
    const centerZ = entry.tile.z + entry.tile.size / 2;
    entry.terrainMount.add(entry.rendered.group);
    root.add(entry.terrainMount);
    entry.rendered.modelsRoot.position.set(centerX, 0, centerZ);
    modelsRoot.add(entry.rendered.modelsRoot);
    offsetWorldWaterBindings(entry.rendered.modelsRoot, centerX, centerZ);
  }

  function unmountEntry(entry: TileEntry): void {
    entry.terrainMount.removeFromParent();
    entry.rendered.modelsRoot.removeFromParent();
    entry.rendered.modelsRoot.position.set(0, 0, 0);
    entry.rendered.group.add(entry.rendered.modelsRoot);
  }

  function disposeEntry(entry: TileEntry): void {
    entry.collision?.dispose();
    entry.rendered.dispose();
  }

  function rebuildPublicIndexes(): void {
    objectGroups.clear();
    pickables.length = 0;
    for (const entry of entries.values()) {
      for (const [id, group] of entry.rendered.objectGroups) objectGroups.set(id, group);
      pickables.push(...entry.rendered.pickables);
    }
  }

  function rebuildCollision(): void {
    const instances = [...entries.values()].flatMap(entry => {
      if (!entry.collision) return [];
      const transform = new THREE.Matrix4().makeTranslation(
        entry.tile.x + entry.tile.size / 2,
        0,
        entry.tile.z + entry.tile.size / 2
      );
      return entry.collision.instances
        .filter(instance => instance.kind !== 'boundary')
        .map(instance => createCollisionMeshInstance(`${tileKey(entry.tile)}:${instance.id}`, instance.kind, instance.geometry, transform));
    });
    collisionWorld?.dispose();
    collisionWorld = new MeshCollisionWorld(instances);
  }

  function updateLightingBounds(focusX: number, focusZ: number): void {
    const nearby = [...entries.values()].filter(entry => entry.tile.size <= 256
      && tileDistanceSquared(entry.tile, focusX, focusZ) <= 900 * 900);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of nearby) for (const height of entry.map.terrain.heights) {
      if (height < min) min = height;
      if (height > max) max = height;
    }
    if (!Number.isFinite(min)) min = sample(focusX, focusZ).height;
    if (!Number.isFinite(max)) max = min + 80;
    activeCenter = [focusX, min, focusZ];
    activeLightingSize = [1_280, Math.max(128, max - min + 80), 1_280];
  }

  function requestReconcile(x: number, z: number, distance: number): void {
    const next = normalizedReconcileRequest(x, z, distance);
    const nextKey = reconcileRequestKey(next);
    if (sameReconcileRequest(desiredRequest, next)) {
      if (!failedRequest || failedRequest.key !== nextKey || performance.now() - failedRequest.at < 5_000) return;
    }
    desiredRequest = next;
    if (reconciling) return;
    reconciling = true;
    void (async () => {
      try {
        while (desiredRequest && !disposed && !sameReconcileRequest(appliedRequest, desiredRequest)) {
          const current = desiredRequest;
          try {
            await reconcile(current.x, current.z, current.distance);
            appliedRequest = current;
            failedRequest = null;
          } catch (error) {
            const key = reconcileRequestKey(current);
            if (failedRequest?.key !== key) console.error('[WorldStreaming] chunk reconcile failed', error);
            failedRequest = { key, at: performance.now() };
            break;
          }
        }
      } finally {
        reconciling = false;
      }
    })();
  }

  const aggregatePaletteReport = (): PaletteCoverageReport => {
    const reports = [...entries.values()].map(entry => entry.rendered.getColorPaletteCoverage());
    const usedColors = new Set<string>();
    const roleCounts: Record<string, number> = {};
    const report = { ...EMPTY_PALETTE_REPORT, usedColors: [] as string[], roleCounts };
    for (const item of reports) {
      report.strictMaterials += item.strictMaterials;
      report.approximateMaterials += item.approximateMaterials;
      report.technicalMaterials += item.technicalMaterials;
      report.unmatchedMaterials += item.unmatchedMaterials;
      item.usedColors.forEach(color => usedColors.add(color));
      for (const [role, count] of Object.entries(item.roleCounts)) roleCounts[role] = (roleCounts[role] ?? 0) + count;
    }
    report.usedColors = [...usedColors];
    return report;
  };

  const aggregateDebugStats = (): RenderedMapDebugStats => {
    const base: RenderedMapDebugStats = {
      totalParts: 0, batchableParts: 0, instancedParts: 0, batchedMeshParts: 0,
      fallbackMeshParts: 0, fallbackVisualClones: 0, buildYieldCount: 0, maxBuildSliceMs: 0,
      batchCount: 0, effectBatchCount: 0, effectBatchParts: 0, runtimeIndexPartRefs: 0,
      orphanPartRefs: 0, orphanInstanceRefs: 0, culled: 0, tested: 0,
      grassLayers: 0, grassBlades: 0, grassFlowers: 0, grassDrawCalls: 0
    };
    const sumKeys = Object.keys(base) as Array<Exclude<keyof RenderedMapDebugStats, 'streaming'>>;
    for (const entry of entries.values()) {
      const child = entry.rendered.getDebugStats();
      for (const key of sumKeys) {
        base[key] = key === 'maxBuildSliceMs' ? Math.max(base[key], child[key]) : base[key] + child[key];
      }
    }
    base.streaming = {
      terrainTiles: entries.size,
      contentChunks: new Set([...entries.values()].flatMap(entry => entry.signature.split('|')[1]?.split(',').filter(Boolean) ?? [])).size,
      buildings: [...entries.values()].reduce((sum, entry) => sum + entry.buildings, 0),
      ecologyInstances: [...entries.values()].reduce((sum, entry) => sum + entry.ecology, 0),
      texturePixels: [...entries.values()].reduce((sum, entry) => sum + entry.texturePixels, 0),
      collisionTriangles: collisionWorld?.instances.reduce((sum, instance) => sum + instance.triangleCount, 0) ?? 0,
      collisionMeshes: collisionWorld?.instances.length ?? 0,
      pendingTiles,
      unloadedTiles,
      finestTerrainSpacing: entries.size
        ? Math.min(...[...entries.values()].map(entry => entry.tile.size / Math.max(1, entry.map.terrain.resolutionX - 1)))
        : 0
    };
    return base;
  };

  const buildProfile = (): RenderedMap['buildProfile'] => [...entries.values()].reduce((total, entry) => ({
    setupMs: total.setupMs + entry.rendered.buildProfile.setupMs,
    primitiveBatchMs: total.primitiveBatchMs + entry.rendered.buildProfile.primitiveBatchMs,
    objectVisualMs: total.objectVisualMs + entry.rendered.buildProfile.objectVisualMs,
    finalizeMs: total.finalizeMs + entry.rendered.buildProfile.finalizeMs,
    totalMs: total.totalMs + entry.rendered.buildProfile.totalMs
  }), { setupMs: 0, primitiveBatchMs: 0, objectVisualMs: 0, finalizeMs: 0, totalMs: 0 });

  return {
    group: root,
    modelsRoot,
    runtimeIndex,
    objectGroups,
    pickables,
    buildProfile: buildProfile(),
    syncObjectTransform: id => entries.forEach(entry => entry.rendered.syncObjectTransform(id)),
    update: (deltaTime, camera, maxDistance) => {
      entries.forEach(entry => entry.rendered.update(deltaTime, camera, maxDistance));
      const focus = worldFocusFromCamera(camera, sample);
      const height = sample(focus.x, focus.z).height;
      requestReconcile(focus.x, focus.z, Math.abs(camera.position.y - height));
    },
    restoreMaterialEffects: () => entries.forEach(entry => entry.rendered.restoreMaterialEffects()),
    syncMaterialEnvironment: (environment, waterEnvironment) => {
      style.environment = environment;
      style.waterEnvironment = waterEnvironment;
      entries.forEach(entry => entry.rendered.syncMaterialEnvironment(environment, waterEnvironment));
    },
    getRuntimeBatchMeshes: () => [...entries.values()].flatMap(entry => entry.rendered.getRuntimeBatchMeshes()),
    setGrassStyle: value => {
      if (sameValue(style.grass, value)) return;
      style.grass = value;
      entries.forEach(entry => entry.rendered.setGrassStyle(value));
    },
    setSceneArt: (plan, palette) => {
      if (sameValue(style.sceneArt, plan) && sameValue(style.sceneArtPalette, palette)) return;
      style.sceneArt = plan;
      style.sceneArtPalette = palette;
      entries.forEach(entry => entry.rendered.setSceneArt(localSceneArt(plan, entry.map, entry.tile), palette));
    },
    setTerrainMaterialStyle: value => {
      if (sameValue(style.terrain, value)) return;
      style.terrain = value;
      entries.forEach(entry => entry.rendered.setTerrainMaterialStyle(value));
    },
    setColorPalette: palette => {
      if (sameValue(style.palette, palette)) return aggregatePaletteReport();
      style.palette = palette;
      entries.forEach(entry => entry.rendered.setColorPalette(palette));
      return aggregatePaletteReport();
    },
    getColorPaletteCoverage: aggregatePaletteReport,
    setWeatherSurface: (wetness, snowCover) => {
      if (style.wetness === wetness && style.snowCover === snowCover) return;
      style.wetness = wetness;
      style.snowCover = snowCover;
      entries.forEach(entry => entry.rendered.setWeatherSurface(wetness, snowCover));
    },
    setSandFlowStrength: strength => {
      if (style.sandFlow === strength) return;
      style.sandFlow = strength;
      entries.forEach(entry => entry.rendered.setSandFlowStrength(strength));
    },
    setRoomWallDisplayMode: (mode, camera) => entries.forEach(entry => entry.rendered.setRoomWallDisplayMode(mode, camera)),
    setLightingTimeOfDay: value => { style.timeOfDay = value; entries.forEach(entry => entry.rendered.setLightingTimeOfDay(value)); },
    setLightingQuality: value => { style.lightingQuality = value; entries.forEach(entry => entry.rendered.setLightingQuality(value)); },
    setLightingSoloObjectId: value => { style.lightingSoloObjectId = value; entries.forEach(entry => entry.rendered.setLightingSoloObjectId(value)); },
    setLightingHelpersVisible: value => { style.lightingHelpersVisible = value; entries.forEach(entry => entry.rendered.setLightingHelpersVisible(value)); },
    interactGrass: (position, elapsedSeconds) => {
      for (const entry of entries.values()) if (tileContains(entry.tile, position[0], position[2])) {
        entry.rendered.interactGrass([
          position[0] - entry.tile.x - entry.tile.size / 2,
          position[1],
          position[2] - entry.tile.z - entry.tile.size / 2
        ], elapsedSeconds);
      }
    },
    clearGrassInteraction: () => entries.forEach(entry => entry.rendered.clearGrassInteraction()),
    getDebugStats: aggregateDebugStats,
    getCollisionWorld: () => collisionWorld,
    subscribeContentChanges: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getActiveLightingBounds: () => ({ center: [...activeCenter], size: [...activeLightingSize] }),
    refreshGrass: () => {},
    refreshTerrain: () => {},
    dispose: () => {
      disposed = true;
      desiredRequest = null;
      listeners.clear();
      collisionWorld?.dispose();
      collisionWorld = null;
      entries.forEach(entry => { unmountEntry(entry); disposeEntry(entry); });
      entries.clear();
      root.clear();
    }
  };
}

function validateWorldAssets(
  map: EditableMap,
  bindingsByKey: Map<string, WorldAssetBinding>,
  bindingsByRole: Map<WorldAssetBinding['role'], WorldAssetBinding[]>,
  assetsById: Map<string, MapAsset>
): void {
  const world = map.world!;
  if (world.assets.length === 0) return;
  for (const binding of world.assets) if (!assetsById.has(binding.assetId)) throw new Error(`world_missing_asset:${binding.assetId}`);
  for (const patch of world.bundle.patches) for (const building of patch.buildings) {
    if (building.assetKey && !bindingsByKey.has(building.assetKey)) throw new Error(`world_missing_asset_binding:${building.assetKey}`);
    if (!building.assetKey && !(bindingsByRole.get(buildingRole(building))?.length)) throw new Error(`world_missing_asset_binding:${buildingRole(building)}`);
  }
  if (world.bundle.plan.ecology.length && !(bindingsByRole.get('tree')?.length)) throw new Error('world_missing_asset_binding:tree');
}

function groupBindingsByRole(bindings: WorldAssetBinding[]): Map<WorldAssetBinding['role'], WorldAssetBinding[]> {
  const result = new Map<WorldAssetBinding['role'], WorldAssetBinding[]>();
  for (const binding of bindings) {
    const values = result.get(binding.role) ?? [];
    values.push(binding);
    result.set(binding.role, values);
  }
  return result;
}

function globalBuildings(bundle: EditableMap['world'] extends infer _ ? NonNullable<EditableMap['world']>['bundle'] : never): GlobalBuilding[] {
  return bundle.patches.flatMap(patch => {
    const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId);
    if (!town) throw new Error(`world_missing_town:${patch.townId}`);
    return patch.buildings.map(building => ({
      ...building,
      x: building.x + town.center[0],
      z: building.z + town.center[1],
      townId: town.id
    }));
  });
}

function globalRoads(bundle: NonNullable<EditableMap['world']>['bundle']): MapGuide[] {
  return [
    ...bundle.plan.roads,
    ...bundle.patches.flatMap(patch => {
      const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId);
      if (!town) throw new Error(`world_missing_town:${patch.townId}`);
      return patch.streets.map(street => ({
        ...street,
        id: `town:${town.id}:${street.id}`,
        points: street.points.map(([x, z]): [number, number] => [x + town.center[0], z + town.center[1]])
      }));
    })
  ];
}

function buildingRole(building: TownBuilding): WorldAssetBinding['role'] {
  if (/landmark|castle|cathedral|palace|hall|驿|堡|宫|教堂|地标/i.test(building.use)) return 'landmark';
  if (/工|仓|农具|workshop|factory/i.test(building.use)) return 'workshop';
  if (/商|店|客|shop|market|inn/i.test(building.use)) return 'shop';
  return 'house';
}

function fitAssetScale(asset: MapAsset, width: number, depth: number): number {
  const bounds = calculateModelVisualFrame(asset.modelJson).bounds;
  const modelWidth = Math.max(0.01, bounds.max[0] - bounds.min[0]);
  const modelDepth = Math.max(0.01, bounds.max[2] - bounds.min[2]);
  return Math.min(width / modelWidth, depth / modelDepth);
}

function stableIndex(id: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return count ? (hash >>> 0) % count : 0;
}

function tileKey(tile: WorldTile): string { return `${tile.x}:${tile.z}:${tile.size}`; }
function ecologyKey(chunk: EcologyChunk): string { return `${chunk.x}:${chunk.z}`; }
function pointEcologyKey(x: number, z: number): string { return `${Math.floor(x / 256)}:${Math.floor(z / 256)}`; }
function tileContains(tile: WorldTile, x: number, z: number): boolean {
  return x >= tile.x && x < tile.x + tile.size && z >= tile.z && z < tile.z + tile.size;
}
function chunkIntersectsTile(chunk: EcologyChunk, tile: WorldTile): boolean {
  const x = chunk.x * 256, z = chunk.z * 256;
  return x < tile.x + tile.size && x + 256 > tile.x && z < tile.z + tile.size && z + 256 > tile.z;
}
function tileDistanceSquared(tile: WorldTile, x: number, z: number): number {
  const dx = Math.max(0, tile.x - x, x - tile.x - tile.size);
  const dz = Math.max(0, tile.z - z, z - tile.z - tile.size);
  return dx * dx + dz * dz;
}

function biomeTags(biome: WorldBiome): VisualZoneTag[] {
  if (biome === 'ocean') return ['water', 'lowland'];
  if (biome === 'forest') return ['grass', 'forest'];
  if (biome === 'desert') return ['dry', 'sand'];
  if (biome === 'mountains') return ['rocky'];
  if (biome === 'snow') return ['snow', 'rocky'];
  return ['grass'];
}

function clipSegment(
  start: [number, number], end: [number, number], minX: number, minZ: number, maxX: number, maxZ: number
): [[number, number], [number, number]] | null {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  let low = 0, high = 1;
  for (const [p, q] of [[-dx, start[0] - minX], [dx, maxX - start[0]], [-dz, start[1] - minZ], [dz, maxZ - start[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [[start[0] + dx * low, start[1] + dz * low], [start[0] + dx * high, start[1] + dz * high]];
}

function localSceneArt(plan: SceneArtPlan | null, map: EditableMap, tile: WorldTile): SceneArtPlan | null {
  if (!plan) return null;
  const zoneIds = new Set(map.visualSemantics.zones.map(zone => zone.id));
  const objectIds = new Set(map.objects.map(object => object.id));
  const centerX = tile.x + tile.size / 2;
  const centerZ = tile.z + tile.size / 2;
  return {
    colors: plan.colors.filter(field => !field.zoneId || zoneIds.has(field.zoneId)).map(field => ({
      ...field,
      center: [field.center[0] - centerX, field.center[1] - centerZ]
    })),
    lights: plan.lights.filter(light => objectIds.has(light.objectId) && (!light.targetId || objectIds.has(light.targetId))),
    surfaces: plan.surfaces.filter(surface => objectIds.has(surface.objectId)),
    wet: plan.wet.filter(wet => zoneIds.has(wet.zoneId))
  };
}

function offsetWorldWaterBindings(root: THREE.Object3D, x: number, z: number): void {
  root.traverse(object => {
    const shore = object.userData.waterShore as { center?: [number, number]; worldSpace?: boolean } | undefined;
    if (shore?.worldSpace !== false && shore?.center) shore.center = [shore.center[0] + x, shore.center[1] + z];
    const ocean = object.userData.waterOceanTerrain as { center?: [number, number]; splashPoints?: Array<[number, number]> } | undefined;
    if (ocean?.center) ocean.center = [ocean.center[0] + x, ocean.center[1] + z];
    if (ocean?.splashPoints) ocean.splashPoints = ocean.splashPoints.map(point => [point[0] + x, point[1] + z]);
  });
}

function worldFocusFromCamera(camera: THREE.Camera, sample: (x: number, z: number) => { height: number }): { x: number; z: number } {
  const direction = camera.getWorldDirection(new THREE.Vector3());
  if (direction.y >= -0.08) return { x: camera.position.x, z: camera.position.z };
  const ground = sample(camera.position.x, camera.position.z).height;
  const distance = THREE.MathUtils.clamp((ground - camera.position.y) / direction.y, 0, 20_000);
  return {
    x: camera.position.x + direction.x * distance,
    z: camera.position.z + direction.z * distance
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function normalizedReconcileRequest(x: number, z: number, distance: number): ReconcileRequest {
  return {
    x: Math.round(x / 64) * 64,
    z: Math.round(z / 64) * 64,
    distance: distance > CONTENT_DISTANCE_LIMIT ? Math.round(distance / 500) * 500 : 50
  };
}

function sameReconcileRequest(left: ReconcileRequest | null, right: ReconcileRequest | null): boolean {
  return Boolean(left && right && left.x === right.x && left.z === right.z && left.distance === right.distance);
}

function reconcileRequestKey(request: ReconcileRequest): string {
  return `${request.x}:${request.z}:${request.distance}`;
}
