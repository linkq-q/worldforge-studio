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
import { ECOLOGY_CHUNK_SIZE, generateEcologyChunk, selectEcologyChunks, type EcologyChunk, type EcologyInstance } from '../shared/worldEcology';
import { createWorldEcologyDensity, createWorldExclusion, type TownBuilding } from '../shared/worldPlanning';
import { WORLD_BIOMES, sampleWorldTile, selectWorldTiles, type WorldBiome, type WorldTile, type WorldTileData } from '../shared/worldTerrain';
import { worldMapTerrainContext, type WorldAssetBinding } from '../shared/worldMapState';
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
  type RenderedMapDebugStats,
  type TerrainBorderSide
} from './mapRenderer';
import {
  buildMapMeshCollisionWorld,
  createCollisionMeshInstance,
  MeshCollisionWorld,
  type CollisionMeshKind
} from './mapMeshCollision';

const MAX_TERRAIN_TILE_BUDGET = 128;
const UNIFORM_TERRAIN_TILE_BUDGET = 64;
const FINE_TERRAIN_RESOLUTION = 65;
const TARGET_FINE_TERRAIN_SPACING = 1.5;
const CONTENT_DISTANCE_LIMIT = 3_000;
const BIOME_CHANNEL = Object.fromEntries(WORLD_BIOMES.map((biome, index) => [biome, index])) as Record<WorldBiome, number>;
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
interface ContentEntry {
  chunk: EcologyChunk;
  signature: string;
  map: EditableMap;
  rendered: RenderedMap;
  mount: THREE.Group;
  collision: MeshCollisionWorld;
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
  const terrainTileBudget = bundle.plan.recipe.size / 8 / (FINE_TERRAIN_RESOLUTION - 1) <= TARGET_FINE_TERRAIN_SPACING
    ? UNIFORM_TERRAIN_TILE_BUDGET
    : MAX_TERRAIN_TILE_BUDGET;
  const terrainContext = worldMapTerrainContext(world);
  const sample = terrainContext.sample;
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
  const contentEntries = new Map<string, ContentEntry>();
  const objectGroups = new Map<string, THREE.Group>();
  const pickables: THREE.Object3D[] = [];
  const listeners = new Set<() => void>();
  const runtimeIndex = new RuntimeIndex();
  let collisionWorld: MeshCollisionWorld | null = null;
  let disposed = false;
  let pendingTiles = 0;
  let unloadedTiles = 0;
  let lastTerrainBuildMs = 0;
  let maxTerrainBuildMs = 0;
  let lastTerrainSampleMs = 0;
  let lastTerrainRenderMs = 0;
  let lastTerrainCollisionMs = 0;
  let desiredRequest: ReconcileRequest | null = null;
  let appliedRequest: ReconcileRequest | null = null;
  let failedRequest: { key: string; at: number } | null = null;
  let requestRevision = 0;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
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

  const initialRequest = normalizedReconcileRequest(
    options.worldInitialView?.x ?? map.spawnPoints[0]?.[0] ?? 0,
    options.worldInitialView?.z ?? map.spawnPoints[0]?.[2] ?? 0,
    options.worldInitialView?.distance ?? 50
  );
  await reconcile(initialRequest.x, initialRequest.z, initialRequest.distance, requestRevision, { terrain: 16, content: 9 });
  completionTimer = setTimeout(() => {
    completionTimer = null;
    if (!desiredRequest) requestReconcile(initialRequest.x, initialRequest.z, initialRequest.distance);
  }, 0);

  async function reconcile(
    focusX: number,
    focusZ: number,
    distance: number,
    revision: number,
    limits?: { terrain: number; content: number }
  ): Promise<boolean> {
    const tiles = selectWorldTiles(bundle.plan.recipe.size, focusX, focusZ, distance, terrainTileBudget);
    const contentChunks = selectEcologyChunks(
      bundle.plan.recipe.size,
      focusX,
      focusZ,
      distance > CONTENT_DISTANCE_LIMIT ? distance : 0
    );
    const oceanOwner = tiles.find(tile => tileContains(tile, focusX, focusZ));
    const desiredTerrain = new Map(tiles.map(tile => {
      const logicalKey = tileKey(tile);
      const skirtSides = terrainSkirtSides(tile, tiles);
      const signature = `${logicalKey}|o${oceanOwner === tile ? 1 : 0}|s${skirtSides.join('.')}`;
      return [logicalKey, { tile, signature, ocean: oceanOwner === tile, skirtSides }] as const;
    }));
    const desiredContent = new Map(contentChunks.map(chunk => [ecologyKey(chunk), chunk] as const));
    const allMissingTerrain = [...desiredTerrain.entries()]
      .filter(([key, value]) => entries.get(key)?.signature !== value.signature)
      .sort(([, left], [, right]) => tileDistanceSquared(left.tile, focusX, focusZ) - tileDistanceSquared(right.tile, focusX, focusZ));
    const allMissingContent = [...desiredContent.entries()]
      .filter(([key]) => !contentEntries.has(key))
      .sort(([, left], [, right]) => chunkDistanceSquared(left, focusX, focusZ) - chunkDistanceSquared(right, focusX, focusZ));
    const missingTerrain = limits ? allMissingTerrain.slice(0, limits.terrain) : allMissingTerrain;
    const missingContent = limits ? allMissingContent.slice(0, limits.content) : allMissingContent;
    pendingTiles = allMissingTerrain.length + allMissingContent.length;
    const builtTerrain = new Map<string, TileEntry>();
    const builtContent = new Map<string, ContentEntry>();
    const discardBuilt = (): void => {
      builtTerrain.forEach(disposeEntry);
      builtContent.forEach(disposeContentEntry);
    };
    const contentBatchSize = limits ? 3 : 1;
    const terrainBatchSize = limits ? 4 : 1;
    for (let index = 0; index < missingContent.length && !disposed; index += contentBatchSize) {
      const batch = missingContent.slice(index, index + contentBatchSize);
      const results = await Promise.allSettled(batch.map(async ([key, chunk]) => [key, await buildContentEntry(chunk)] as const));
      for (const result of results) if (result.status === 'fulfilled') builtContent.set(result.value[0], result.value[1]);
      pendingTiles -= results.length;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        discardBuilt();
        pendingTiles = 0;
        throw failure.reason;
      }
      await yieldWorldBuild();
      if (revision !== requestRevision) { discardBuilt(); return false; }
    }
    for (let index = 0; index < missingTerrain.length && !disposed; index += terrainBatchSize) {
      const batch = missingTerrain.slice(index, index + terrainBatchSize);
      const results = await Promise.allSettled(batch.map(async ([key, value]) => [key, await buildTerrainEntry(
        value.tile, value.signature, value.ocean, value.skirtSides
      )] as const));
      for (const result of results) if (result.status === 'fulfilled') builtTerrain.set(result.value[0], result.value[1]);
      pendingTiles -= results.length;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        discardBuilt();
        pendingTiles = 0;
        throw failure.reason;
      }
      await yieldWorldBuild();
      if (revision !== requestRevision) { discardBuilt(); return false; }
    }
    if (disposed) {
      discardBuilt();
      return false;
    }
    for (const [key, entry] of entries) {
      const replacement = builtTerrain.get(key);
      if (!desiredTerrain.has(key) || replacement) {
        unmountEntry(entry);
        disposeEntry(entry);
        entries.delete(key);
        unloadedTiles += 1;
      }
    }
    for (const [key, entry] of builtTerrain) {
      if (!desiredTerrain.has(key)) { disposeEntry(entry); continue; }
      entries.set(key, entry);
      mountEntry(entry);
    }
    for (const [key, entry] of contentEntries) {
      if (desiredContent.has(key)) continue;
      unmountContentEntry(entry);
      disposeContentEntry(entry);
      contentEntries.delete(key);
      unloadedTiles += 1;
    }
    for (const [key, entry] of builtContent) {
      if (!desiredContent.has(key)) { disposeContentEntry(entry); continue; }
      contentEntries.set(key, entry);
      mountContentEntry(entry);
    }
    rebuildPublicIndexes();
    rebuildCollision();
    updateLightingBounds(focusX, focusZ);
    listeners.forEach(listener => listener());
    return true;
  }

  async function buildTerrainEntry(
    tile: WorldTile,
    signature: string,
    includeOcean: boolean,
    skirtSides: readonly TerrainBorderSide[]
  ): Promise<TileEntry> {
    const buildStartedAt = performance.now();
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const resolution = tile.size <= 256 ? FINE_TERRAIN_RESOLUTION : tile.size <= 2_048 ? 33 : 17;
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, resolution, sample, false);
    const sampledAt = performance.now();
    const tileMap = makeTerrainTileMap(tile, sampled.heights, includeOcean);
    const textureSize = tile.size <= 256 ? 128 : tile.size <= 2_048 ? 64 : 32;
    const rendered = await buildNormalizedEditableMapGroupCore(tileMap, {
      ...options,
      editorHelpers: false,
      terrainTextureSize: textureSize,
      terrainBorderSides: skirtSides,
      terrainBorderDepth: 4,
      oceanCoast: false,
      terrainOnly: true,
      terrainSurfaceWeight: (x, z, tags) => tileBiomeSurfaceWeight(sampled, tile, centerX + x, centerZ + z, tags)
    });
    applyWorldTerrainEdgeNormals(rendered.group, tile, centerX, centerZ);
    const renderedAt = performance.now();
    applyStyle(rendered, tileMap, tile);
    const terrainMount = new THREE.Group();
    terrainMount.name = `world-tile:${tileKey(tile)}`;
    terrainMount.position.set(centerX, 0, centerZ);
    const collision = tile.size <= 256 ? buildGlobalCollision(tileMap, centerX, centerZ, new Set(['terrain'])) : null;
    const collisionAt = performance.now();
    lastTerrainSampleMs = sampledAt - buildStartedAt;
    lastTerrainRenderMs = renderedAt - sampledAt;
    lastTerrainCollisionMs = collisionAt - renderedAt;
    lastTerrainBuildMs = collisionAt - buildStartedAt;
    maxTerrainBuildMs = Math.max(maxTerrainBuildMs, lastTerrainBuildMs);
    return {
      tile,
      signature,
      map: tileMap,
      rendered,
      terrainMount,
      collision,
      buildings: 0,
      ecology: 0,
      texturePixels: textureSize * textureSize * 4
    };
  }

  async function buildContentEntry(chunk: EcologyChunk): Promise<ContentEntry> {
    const tile: WorldTile = { x: chunk.x * ECOLOGY_CHUNK_SIZE, z: chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, 65, sample, false);
    const contentMap = makeContentMap(tile, sampled.heights, chunk);
    const rendered = await buildNormalizedEditableMapGroupCore(contentMap, {
      ...options,
      editorHelpers: false,
      terrainTextureSize: 32,
      terrainBorderSides: false,
      terrainVisible: false,
      oceanCoast: false
    });
    applyStyle(rendered, contentMap, tile);
    const mount = new THREE.Group();
    mount.name = `world-content:${ecologyKey(chunk)}`;
    mount.position.set(centerX, 0, centerZ);
    return {
      chunk,
      signature: ecologyKey(chunk),
      map: contentMap,
      rendered,
      mount,
      collision: buildGlobalCollision(contentMap, centerX, centerZ, new Set(['scene'])),
      buildings: contentMap.objects.filter(object => object.id.startsWith('world-building:')).length,
      ecology: contentMap.objects.filter(object => object.id.startsWith('world-ecology:')).length,
      texturePixels: 32 * 32 * 4
    };
  }

  function makeTerrainTileMap(
    tile: WorldTile,
    heights: Float32Array,
    includeOcean: boolean
  ): EditableMap {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const boxSize: Vec3 = [tile.size, map.box.size[1], tile.size];
    const waterBodies = tileWaterBodies(tile, includeOcean);
    return {
      ...map,
      id: `${map.id}:world:${tileKey(tile)}`,
      name: `${map.name} ${tileKey(tile)}`,
      seed: map.seed ^ stringSeed(tileKey(tile)),
      world: undefined,
      box: { ...map.box, size: boxSize },
      sceneMode: 'outdoor',
      room: null,
      interiorArtDirection: null,
      terrain: { resolutionX: Math.sqrt(heights.length), resolutionZ: Math.sqrt(heights.length), heights: Array.from(heights) },
      grassLayers: [],
      waterBodies,
      paintStrokes: [],
      objects: [],
      spawnPoints: [[0, sample(centerX, centerZ).height, 0]],
      visualSemantics: {
        version: 1,
        zones: [],
        wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind }
      },
      layout: createDefaultMapLayout(boxSize),
      guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS,
      assets: [],
      collisionBake: undefined
    };
  }

  function applyWorldTerrainEdgeNormals(group: THREE.Object3D, tile: WorldTile, centerX: number, centerZ: number): void {
    const terrain = group.getObjectByName('terrain') as THREE.Mesh | undefined;
    const positions = terrain?.geometry.getAttribute('position');
    const normals = terrain?.geometry.getAttribute('normal');
    if (!terrain || !positions || !normals) return;
    const half = tile.size / 2;
    const epsilon = 4;
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index), z = positions.getZ(index);
      if (Math.abs(Math.abs(x) - half) > 1e-5 && Math.abs(Math.abs(z) - half) > 1e-5) continue;
      const worldX = centerX + x, worldZ = centerZ + z;
      const dx = sample(worldX + epsilon, worldZ).height - sample(worldX - epsilon, worldZ).height;
      const dz = sample(worldX, worldZ + epsilon).height - sample(worldX, worldZ - epsilon).height;
      const length = Math.hypot(dx, epsilon * 2, dz);
      normals.setXYZ(index, -dx / length, epsilon * 2 / length, -dz / length);
    }
    normals.needsUpdate = true;
  }

  function makeContentMap(tile: WorldTile, heights: Float32Array, chunk: EcologyChunk): EditableMap {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const contentKeys = new Set([ecologyKey(chunk)]);
    const tileBuildings = buildings.filter(building => pointEcologyKey(building.x, building.z) === ecologyKey(chunk));
    const ecology = ecologyForChunk(chunk);
    const objects = [
      ...tileBuildings.map(building => buildingObject(building, centerX, centerZ)),
      ...ecology.map(instance => ecologyObject(instance, centerX, centerZ)),
      ...manualObjectsForTile(manualObjectTrees, tile, contentKeys, centerX, centerZ)
    ];
    const usedAssetIds = new Set(objects.flatMap(object => object.assetId ? [object.assetId] : []));
    const boxSize: Vec3 = [tile.size, map.box.size[1], tile.size];
    return {
      ...map,
      id: `${map.id}:content:${ecologyKey(chunk)}`,
      name: `${map.name} content ${ecologyKey(chunk)}`,
      seed: map.seed ^ stringSeed(ecologyKey(chunk)),
      world: undefined,
      box: { ...map.box, size: boxSize },
      sceneMode: 'outdoor',
      room: null,
      interiorArtDirection: null,
      terrain: { resolutionX: 65, resolutionZ: 65, heights: Array.from(heights) },
      grassLayers: [],
      waterBodies: [],
      paintStrokes: [],
      objects,
      spawnPoints: [[0, sample(centerX, centerZ).height, 0]],
      visualSemantics: {
        version: 1,
        zones: roadZones(tile),
        wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind }
      },
      layout: createDefaultMapLayout(boxSize),
      guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS,
      assets: (map.assets ?? []).filter(asset => usedAssetIds.has(asset.id)),
      collisionBake: undefined
    };
  }

  function buildGlobalCollision(
    localMap: EditableMap,
    centerX: number,
    centerZ: number,
    kinds: ReadonlySet<CollisionMeshKind>
  ): MeshCollisionWorld {
    const local = buildMapMeshCollisionWorld(localMap, kinds);
    const transform = new THREE.Matrix4().makeTranslation(centerX, 0, centerZ);
    const instances = local.instances
      .filter(instance => kinds.has(instance.kind))
      .map(instance => createCollisionMeshInstance(`${localMap.id}:${instance.id}`, instance.kind, instance.geometry, transform));
    local.dispose();
    return new MeshCollisionWorld(instances);
  }

  function ecologyForChunk(chunk: EcologyChunk): EcologyInstance[] {
    const key = ecologyKey(chunk);
    const cached = ecologyCache.get(key);
    if (cached) return cached;
    const generated = generateEcologyChunk(bundle.plan.recipe, bundle.plan.ecology, chunk, {
      sample, exclusion, density, freshWaterDistance: terrainContext.freshWaterDistance
    }).instances;
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

  function roadZones(tile: WorldTile): SceneVisualZone[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const result: SceneVisualZone[] = [];
    for (const road of roads) {
      const points = road.closed ? [...road.points, road.points[0]] : road.points;
      const fragments = clipPolylineToRect(points, tile.x, tile.z, tile.x + tile.size, tile.z + tile.size, Boolean(road.closed));
      fragments.forEach((fragment, index) => {
        const local = fragment.points.map(([x, z]) => [x - centerX, z - centerZ] as [number, number]);
        const minX = Math.min(...local.map(point => point[0])), maxX = Math.max(...local.map(point => point[0]));
        const minZ = Math.min(...local.map(point => point[1])), maxZ = Math.max(...local.map(point => point[1]));
        const zoneX = (minX + maxX) / 2, zoneZ = (minZ + maxZ) / 2;
        const settlement = road.id.startsWith('town:') || road.tags.some(tag => /street|settlement|town/i.test(tag));
        result.push({
          id: `world-road:${road.id}:${index}:${tileKey(tile)}`,
          tags: ['paving', 'settlement'],
          center: [zoneX, zoneZ],
          radius: Math.max(...local.map(point => Math.hypot(point[0] - zoneX, point[1] - zoneZ))) + road.width,
          intensity: 1,
          material: settlement ? 'brick-paver' : 'compacted-earth',
          region: { kind: 'path', points: local, width: road.width },
          roadDistanceOffset: fragment.distanceOffset,
          roadContinuesBefore: fragment.continuesBefore,
          roadContinuesAfter: fragment.continuesAfter,
          forceRoadOverlay: true
        } as SceneVisualZone);
      });
    }
    return result;
  }

  function tileWaterBodies(tile: WorldTile, includeOcean: boolean): MapWaterBody[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const bodies = terrainContext.waterBodies.flatMap((prepared): MapWaterBody[] => {
      const water = prepared.source;
      const owner = water.region.kind === 'circle'
        ? water.region.center
        : water.region.points[Math.floor(water.region.points.length / 2)];
      if (!tileContains(tile, owner[0], owner[1])) return [];
      return [{
        ...prepared.mapWater,
        points: prepared.mapWater.points.map(([x, z]) => [x - centerX, z - centerZ]),
        levels: prepared.mapWater.levels ? [...prepared.mapWater.levels] : undefined,
        widths: prepared.mapWater.widths ? [...prepared.mapWater.widths] : undefined
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

  function mountContentEntry(entry: ContentEntry): void {
    const centerX = entry.chunk.x * ECOLOGY_CHUNK_SIZE + ECOLOGY_CHUNK_SIZE / 2;
    const centerZ = entry.chunk.z * ECOLOGY_CHUNK_SIZE + ECOLOGY_CHUNK_SIZE / 2;
    entry.mount.add(entry.rendered.group);
    root.add(entry.mount);
    entry.rendered.modelsRoot.position.set(centerX, 0, centerZ);
    modelsRoot.add(entry.rendered.modelsRoot);
  }

  function unmountContentEntry(entry: ContentEntry): void {
    entry.mount.removeFromParent();
    entry.rendered.modelsRoot.removeFromParent();
    entry.rendered.modelsRoot.position.set(0, 0, 0);
    entry.rendered.group.add(entry.rendered.modelsRoot);
  }

  function disposeContentEntry(entry: ContentEntry): void {
    entry.collision.dispose();
    entry.rendered.dispose();
  }

  function renderedEntries(): Array<TileEntry | ContentEntry> {
    return [...entries.values(), ...contentEntries.values()];
  }

  function rebuildPublicIndexes(): void {
    objectGroups.clear();
    pickables.length = 0;
    for (const entry of renderedEntries()) {
      for (const [id, group] of entry.rendered.objectGroups) objectGroups.set(id, group);
      pickables.push(...entry.rendered.pickables);
    }
  }

  function rebuildCollision(): void {
    const instances = [
      ...[...entries.values()].flatMap(entry => entry.collision?.instances ?? []),
      ...[...contentEntries.values()].flatMap(entry => entry.collision.instances)
    ];
    collisionWorld?.dispose();
    collisionWorld = new MeshCollisionWorld(instances, false);
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
    const next = normalizedReconcileRequest(x, z, distance, desiredRequest ?? appliedRequest);
    const nextKey = reconcileRequestKey(next);
    if (sameReconcileRequest(desiredRequest, next)) {
      if (!failedRequest || failedRequest.key !== nextKey || performance.now() - failedRequest.at < 5_000) return;
    }
    desiredRequest = next;
    requestRevision += 1;
    if (reconciling) return;
    reconciling = true;
    void (async () => {
      try {
        while (desiredRequest && !disposed && !sameReconcileRequest(appliedRequest, desiredRequest)) {
          const current = desiredRequest;
          const revision = requestRevision;
          try {
            const completed = await reconcile(current.x, current.z, current.distance, revision);
            if (completed) appliedRequest = current;
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
    const reports = renderedEntries().map(entry => entry.rendered.getColorPaletteCoverage());
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
    for (const entry of renderedEntries()) {
      const child = entry.rendered.getDebugStats();
      for (const key of sumKeys) {
        base[key] = key === 'maxBuildSliceMs' ? Math.max(base[key], child[key]) : base[key] + child[key];
      }
    }
    base.streaming = {
      terrainTiles: entries.size,
      contentChunks: contentEntries.size,
      buildings: [...contentEntries.values()].reduce((sum, entry) => sum + entry.buildings, 0),
      ecologyInstances: [...contentEntries.values()].reduce((sum, entry) => sum + entry.ecology, 0),
      texturePixels: renderedEntries().reduce((sum, entry) => sum + entry.texturePixels, 0),
      collisionTriangles: collisionWorld?.instances.reduce((sum, instance) => sum + instance.triangleCount, 0) ?? 0,
      collisionMeshes: collisionWorld?.instances.length ?? 0,
      pendingTiles,
      unloadedTiles,
      finestTerrainSpacing: entries.size
        ? Math.min(...[...entries.values()].map(entry => entry.tile.size / Math.max(1, entry.map.terrain.resolutionX - 1)))
        : 0,
      lastTerrainBuildMs,
      maxTerrainBuildMs,
      lastTerrainSampleMs,
      lastTerrainRenderMs,
      lastTerrainCollisionMs
    };
    return base;
  };

  const buildProfile = (): RenderedMap['buildProfile'] => renderedEntries().reduce((total, entry) => ({
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
    syncObjectTransform: id => renderedEntries().forEach(entry => entry.rendered.syncObjectTransform(id)),
    update: (deltaTime, camera, maxDistance) => {
      const focus = worldFocusFromCamera(camera, sample);
      entries.forEach(entry => {
        if (tileDistanceSquared(entry.tile, focus.x, focus.z) <= (3_000 + entry.tile.size) ** 2) {
          entry.rendered.update(deltaTime, camera, maxDistance);
        }
      });
      contentEntries.forEach(entry => entry.rendered.update(deltaTime, camera, maxDistance));
      const height = sample(focus.x, focus.z).height;
      requestReconcile(focus.x, focus.z, Math.abs(camera.position.y - height));
    },
    restoreMaterialEffects: () => renderedEntries().forEach(entry => entry.rendered.restoreMaterialEffects()),
    syncMaterialEnvironment: (environment, waterEnvironment) => {
      style.environment = environment;
      style.waterEnvironment = waterEnvironment;
      renderedEntries().forEach(entry => entry.rendered.syncMaterialEnvironment(environment, waterEnvironment));
    },
    getRuntimeBatchMeshes: () => renderedEntries().flatMap(entry => entry.rendered.getRuntimeBatchMeshes()),
    setGrassStyle: value => {
      if (sameValue(style.grass, value)) return;
      style.grass = value;
      renderedEntries().forEach(entry => entry.rendered.setGrassStyle(value));
    },
    setSceneArt: (plan, palette) => {
      if (sameValue(style.sceneArt, plan) && sameValue(style.sceneArtPalette, palette)) return;
      style.sceneArt = plan;
      style.sceneArtPalette = palette;
      entries.forEach(entry => entry.rendered.setSceneArt(localSceneArt(plan, entry.map, entry.tile), palette));
      contentEntries.forEach(entry => entry.rendered.setSceneArt(localSceneArt(plan, entry.map, contentEntryTile(entry)), palette));
    },
    setTerrainMaterialStyle: value => {
      if (sameValue(style.terrain, value)) return;
      style.terrain = value;
      renderedEntries().forEach(entry => entry.rendered.setTerrainMaterialStyle(value));
    },
    setColorPalette: palette => {
      if (sameValue(style.palette, palette)) return aggregatePaletteReport();
      style.palette = palette;
      renderedEntries().forEach(entry => entry.rendered.setColorPalette(palette));
      return aggregatePaletteReport();
    },
    getColorPaletteCoverage: aggregatePaletteReport,
    setWeatherSurface: (wetness, snowCover) => {
      if (style.wetness === wetness && style.snowCover === snowCover) return;
      style.wetness = wetness;
      style.snowCover = snowCover;
      renderedEntries().forEach(entry => entry.rendered.setWeatherSurface(wetness, snowCover));
    },
    setSandFlowStrength: strength => {
      if (style.sandFlow === strength) return;
      style.sandFlow = strength;
      renderedEntries().forEach(entry => entry.rendered.setSandFlowStrength(strength));
    },
    setRoomWallDisplayMode: (mode, camera) => renderedEntries().forEach(entry => entry.rendered.setRoomWallDisplayMode(mode, camera)),
    setLightingTimeOfDay: value => { style.timeOfDay = value; renderedEntries().forEach(entry => entry.rendered.setLightingTimeOfDay(value)); },
    setLightingQuality: value => { style.lightingQuality = value; renderedEntries().forEach(entry => entry.rendered.setLightingQuality(value)); },
    setLightingSoloObjectId: value => { style.lightingSoloObjectId = value; renderedEntries().forEach(entry => entry.rendered.setLightingSoloObjectId(value)); },
    setLightingHelpersVisible: value => { style.lightingHelpersVisible = value; renderedEntries().forEach(entry => entry.rendered.setLightingHelpersVisible(value)); },
    interactGrass: (position, elapsedSeconds) => {
      for (const entry of entries.values()) if (tileContains(entry.tile, position[0], position[2])) {
        entry.rendered.interactGrass([
          position[0] - entry.tile.x - entry.tile.size / 2,
          position[1],
          position[2] - entry.tile.z - entry.tile.size / 2
        ], elapsedSeconds);
      }
    },
    clearGrassInteraction: () => renderedEntries().forEach(entry => entry.rendered.clearGrassInteraction()),
    getDebugStats: aggregateDebugStats,
    getCollisionWorld: () => collisionWorld,
    subscribeContentChanges: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getActiveLightingBounds: () => ({ center: [...activeCenter], size: [...activeLightingSize] }),
    refreshGrass: () => {},
    refreshTerrain: () => {},
    dispose: () => {
      disposed = true;
      desiredRequest = null;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = null;
      listeners.clear();
      collisionWorld?.dispose();
      collisionWorld = null;
      entries.forEach(entry => { unmountEntry(entry); disposeEntry(entry); });
      entries.clear();
      contentEntries.forEach(entry => { unmountContentEntry(entry); disposeContentEntry(entry); });
      contentEntries.clear();
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

function stringSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function tileKey(tile: WorldTile): string { return `${tile.x}:${tile.z}:${tile.size}`; }
function ecologyKey(chunk: EcologyChunk): string { return `${chunk.x}:${chunk.z}`; }
function contentEntryTile(entry: ContentEntry): WorldTile {
  return { x: entry.chunk.x * ECOLOGY_CHUNK_SIZE, z: entry.chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
}
function pointEcologyKey(x: number, z: number): string { return `${Math.floor(x / 256)}:${Math.floor(z / 256)}`; }
function tileContains(tile: WorldTile, x: number, z: number): boolean {
  return x >= tile.x && x < tile.x + tile.size && z >= tile.z && z < tile.z + tile.size;
}
function terrainSkirtSides(tile: WorldTile, tiles: readonly WorldTile[]): TerrainBorderSide[] {
  const result = new Set<TerrainBorderSide>();
  const epsilon = 1e-6;
  const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > epsilon;
  for (const neighbor of tiles) {
    if (neighbor === tile || neighbor.size <= tile.size) continue;
    if (Math.abs(tile.z - (neighbor.z + neighbor.size)) <= epsilon
      && overlaps(tile.x, tile.x + tile.size, neighbor.x, neighbor.x + neighbor.size)) result.add('north');
    if (Math.abs(tile.z + tile.size - neighbor.z) <= epsilon
      && overlaps(tile.x, tile.x + tile.size, neighbor.x, neighbor.x + neighbor.size)) result.add('south');
    if (Math.abs(tile.x - (neighbor.x + neighbor.size)) <= epsilon
      && overlaps(tile.z, tile.z + tile.size, neighbor.z, neighbor.z + neighbor.size)) result.add('west');
    if (Math.abs(tile.x + tile.size - neighbor.x) <= epsilon
      && overlaps(tile.z, tile.z + tile.size, neighbor.z, neighbor.z + neighbor.size)) result.add('east');
  }
  return (['north', 'south', 'west', 'east'] as const).filter(side => result.has(side));
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
function chunkDistanceSquared(chunk: EcologyChunk, x: number, z: number): number {
  const tile = { x: chunk.x * ECOLOGY_CHUNK_SIZE, z: chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
  return tileDistanceSquared(tile, x, z);
}

function tileBiomeSurfaceWeight(
  data: WorldTileData,
  tile: WorldTile,
  worldX: number,
  worldZ: number,
  tags: readonly VisualZoneTag[]
): number {
  const gridX = THREE.MathUtils.clamp((worldX - tile.x) / tile.size * (data.resolution - 1), 0, data.resolution - 1);
  const gridZ = THREE.MathUtils.clamp((worldZ - tile.z) / tile.size * (data.resolution - 1), 0, data.resolution - 1);
  const x0 = Math.floor(gridX), z0 = Math.floor(gridZ);
  const x1 = Math.min(data.resolution - 1, x0 + 1), z1 = Math.min(data.resolution - 1, z0 + 1);
  const tx = gridX - x0, tz = gridZ - z0;
  let weight = 0;
  for (const tag of tags) {
    if (tag === 'dry' || tag === 'sand') {
      weight = Math.max(weight, interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.desert));
    } else if (tag === 'rocky') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.mountains),
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.snow) * 0.35
      );
    } else if (tag === 'snow') {
      weight = Math.max(weight, interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.snow));
    } else if (tag === 'grass') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.grassland),
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.forest)
      );
    } else if (tag === 'forest') {
      weight = Math.max(weight, interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.forest));
    } else if (tag === 'water') {
      weight = Math.max(weight, interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.ocean));
    } else if (tag === 'lowland') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.ocean),
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.grassland)
      );
    }
  }
  return THREE.MathUtils.clamp(weight, 0, 1);
}

function interpolateTileBiome(
  data: WorldTileData,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  tx: number,
  tz: number,
  channel: number
): number {
  const channels = WORLD_BIOMES.length;
  const topLeft = data.weights[(z0 * data.resolution + x0) * channels + channel];
  const topRight = data.weights[(z0 * data.resolution + x1) * channels + channel];
  const bottomLeft = data.weights[(z1 * data.resolution + x0) * channels + channel];
  const bottomRight = data.weights[(z1 * data.resolution + x1) * channels + channel];
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(topLeft, topRight, tx),
    THREE.MathUtils.lerp(bottomLeft, bottomRight, tx),
    tz
  );
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

interface ClippedRoadFragment {
  points: Array<[number, number]>;
  distanceOffset: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

function clipPolylineToRect(
  points: Array<[number, number]>,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  closed: boolean
): ClippedRoadFragment[] {
  const fragments: ClippedRoadFragment[] = [];
  let current: ClippedRoadFragment | null = null;
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1], end = points[index];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const clipped = clipSegment(start, end, minX, minZ, maxX, maxZ);
    if (clipped) {
      const startsLater = Math.hypot(clipped[0][0] - start[0], clipped[0][1] - start[1]) > 1e-5;
      const endsEarlier = Math.hypot(clipped[1][0] - end[0], clipped[1][1] - end[1]) > 1e-5;
      const joinsCurrent = current && pointsNear(current.points[current.points.length - 1], clipped[0]);
      if (!joinsCurrent) {
        if (current) fragments.push(current);
        current = {
          points: [clipped[0], clipped[1]],
          distanceOffset: distance + Math.hypot(clipped[0][0] - start[0], clipped[0][1] - start[1]),
          continuesBefore: closed || index > 1 || startsLater,
          continuesAfter: closed || index < points.length - 1 || endsEarlier
        };
      } else {
        if (!pointsNear(current!.points[current!.points.length - 1], clipped[1])) current!.points.push(clipped[1]);
        current!.continuesAfter = closed || index < points.length - 1 || endsEarlier;
      }
    } else if (current) {
      fragments.push(current);
      current = null;
    }
    distance += length;
  }
  if (current) fragments.push(current);
  return fragments.filter(fragment => fragment.points.length >= 2);
}

function pointsNear(left: [number, number], right: [number, number]): boolean {
  return Math.hypot(left[0] - right[0], left[1] - right[1]) <= 1e-5;
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
  const ground = sample(camera.position.x, camera.position.z).height;
  const height = Math.max(0, camera.position.y - ground);
  const projectionBlend = THREE.MathUtils.smoothstep(-direction.y, 0.02, 0.22);
  const maxDistance = THREE.MathUtils.clamp(height * 4, 256, 3_000);
  let rayDistance = direction.y < -0.001 ? (ground - camera.position.y) / direction.y : 0;
  for (let iteration = 0; iteration < 3 && direction.y < -0.001; iteration += 1) {
    rayDistance = THREE.MathUtils.clamp(rayDistance, 0, maxDistance);
    const x = camera.position.x + direction.x * rayDistance;
    const z = camera.position.z + direction.z * rayDistance;
    rayDistance = (sample(x, z).height - camera.position.y) / direction.y;
  }
  const distance = THREE.MathUtils.clamp(rayDistance, 0, maxDistance) * projectionBlend;
  return {
    x: camera.position.x + direction.x * distance,
    z: camera.position.z + direction.z * distance
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function normalizedReconcileRequest(
  x: number,
  z: number,
  distance: number,
  previous: ReconcileRequest | null = null
): ReconcileRequest {
  const next = {
    x: Math.round(x / 64) * 64,
    z: Math.round(z / 64) * 64,
    distance: distance > CONTENT_DISTANCE_LIMIT
      ? Math.round(distance / 500) * 500
      : Math.max(50, Math.round(distance / 100) * 100)
  };
  if (previous) {
    if (Math.abs(x - previous.x) < 128) next.x = previous.x;
    if (Math.abs(z - previous.z) < 128) next.z = previous.z;
    if (Math.abs(distance - previous.distance) < 200) next.distance = previous.distance;
  }
  return next;
}

function sameReconcileRequest(left: ReconcileRequest | null, right: ReconcileRequest | null): boolean {
  return Boolean(left && right && left.x === right.x && left.z === right.z && left.distance === right.distance);
}

function reconcileRequestKey(request: ReconcileRequest): string {
  return `${request.x}:${request.z}:${request.distance}`;
}

function yieldWorldBuild(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
