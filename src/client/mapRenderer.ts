import * as THREE from 'three';
import {
  getMapPlayerMetrics,
  PLAYER_SPAWN_OBJECT_ID,
  ROOM_SURFACES,
  SUN_OBJECT_ID,
  buildRoomShellSegments,
  getMapBounds,
  getPlayerSpawnYaw,
  getSpawnPoints,
  getSunPosition,
  normalizeMap,
  sampleTerrainHeight,
  terrainIndex,
  terrainPointAt,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type MapPaintStroke,
  type MapSurface,
  type MapWaterBody,
  type RoomShellSegment,
  type RoomSurface,
  type RoomWallDisplayMode
} from '../shared/map';
import { buildModelGroup } from './modelRenderer';
import { buildMapPrimitiveBatches } from './mapPrimitiveBatching';
import { terrainSemanticSurfaceWeight, terrainVertexColor } from './terrainAppearance';
import { buildMapGrassField, deriveContactAwareGrassMap } from './mapGrassRenderer';
import { combinedGrassDensity } from '../shared/mapGrass';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  type RuntimeGrassStyle,
} from '../shared/renderPlan';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import type { MapPrimitiveBatchStats } from './mapPrimitiveBatching';
import type { Vec3 } from '../shared/protocol';
import { buildMapLocalLights } from './mapLocalLights';
import { isPointInsidePlayableArea } from '../shared/mapLayout';
import { isPointInsideWaterBody, riverPathSamples, waterBoundaryPoints } from '../shared/mapWater';
import type { VisualTimeOfDay } from '../shared/visualDirection';
import type { ProceduralRug, SurfaceFinishRecipe } from '../shared/interiorArtDirection';

export interface RenderedMapDebugStats extends MapPrimitiveBatchStats {
  grassLayers: number;
  grassBlades: number;
  grassFlowers: number;
  grassDrawCalls: number;
}

export interface RenderedMap {
  group: THREE.Group;
  modelsRoot: THREE.Group;
  runtimeIndex: RuntimeIndex;
  objectGroups: Map<string, THREE.Group>;
  pickables: THREE.Object3D[];
  syncObjectTransform: (objectId: string) => void;
  update: (deltaTime: number, camera: THREE.Camera, maxDistance: number) => void;
  restoreMaterialEffects: () => void;
  syncMaterialEnvironment: (environmentMap: THREE.Texture | null) => void;
  getRuntimeBatchMeshes: () => THREE.Object3D[];
  setGrassStyle: (style: RuntimeGrassStyle) => void;
  setSandFlowStrength: (strength: number) => void;
  setRoomWallDisplayMode: (mode: RoomWallDisplayMode, camera: THREE.Camera) => void;
  setLightingTimeOfDay: (timeOfDay: VisualTimeOfDay) => void;
  interactGrass: (position: Vec3, elapsedSeconds: number) => void;
  clearGrassInteraction: () => void;
  getDebugStats: () => RenderedMapDebugStats;
  /**
   * Rebuilds only the grass field and the terrain tint that follows it. Grass
   * edits touch nothing else, so they must not pay for a whole scene rebuild.
   */
  refreshGrass: (map: EditableMap) => void;
  /**
   * Rebuilds only the terrain mesh — geometry, vertex colours and the painted
   * surface texture — plus the grass that rides on it. Paint and terrain
   * strokes touch nothing else, so they must not pay for asset re-batching.
   */
  refreshTerrain: (map: EditableMap) => void;
  dispose: () => void;
}

export interface MapRenderOptions {
  editorHelpers?: boolean;
  scene?: THREE.Scene;
  motionAdapter?: MapMotionAdapter;
}

export interface MapMotionController {
  update(deltaTime: number, elapsedSeconds: number): void;
  dispose(): void;
}

/**
 * Optional bridge for external animation systems, including 3d-generate.
 * WorldForge owns semantic intent; the adapter owns clips, rigs, and playback.
 */
export interface MapMotionAdapter {
  attach(context: {
    object: MapObject;
    asset: MapAsset;
    group: THREE.Group;
  }): MapMotionController | void | Promise<MapMotionController | void>;
}

export async function buildEditableMapGroup(input: EditableMap, options: MapRenderOptions = {}): Promise<RenderedMap> {
  const map = normalizeMap(input);
  const root = new THREE.Group();
  root.name = `map:${map.id}`;
  const modelsRoot = new THREE.Group();
  modelsRoot.name = 'modelsRoot';
  modelsRoot.userData.isModelRoot = true;
  root.add(modelsRoot);
  const pickables: THREE.Object3D[] = [];
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const roomShell = buildRoomShell(map);
  if (roomShell) modelsRoot.add(roomShell.group);
  const proceduralRugs = buildProceduralRugs(map);
  if (proceduralRugs) modelsRoot.add(proceduralRugs);

  let grassMap = deriveContactAwareGrassMap(map);
  const terrain = buildTerrain(map);
  terrain.visible = map.sceneMode !== 'indoor';
  const sandFlow = terrain.userData.sandFlow as TerrainSandFlowState;
  applyTerrainGrassTint(terrain, grassMap, DEFAULT_RUNTIME_GRASS_STYLE);
  root.add(terrain);
  pickables.push(terrain);

  // Grass is rebuilt on its own, so it keeps its own map snapshot and style.
  let grassStyle = DEFAULT_RUNTIME_GRASS_STYLE;
  let materialElapsedSeconds = 0;
  const motionControllers: MapMotionController[] = [];
  let grass = map.sceneMode === 'indoor' ? null : buildMapGrassField(grassMap);
  if (grass) root.add(grass.group);

  const rebuildGrass = (next: EditableMap): void => {
    grassMap = deriveContactAwareGrassMap(next);
    grass?.dispose();
    grass = buildMapGrassField(grassMap, grassStyle);
    if (grass) root.add(grass.group);
    applyTerrainGrassTint(terrain, grassMap, grassStyle);
  };

  const waterRoot = buildStructuredWaterGroup(map);
  waterRoot.visible = map.sceneMode !== 'indoor';
  modelsRoot.add(waterRoot);
  const objectGroups = createObjectGroups(map);
  if (roomShell) {
    for (const [surface, group] of roomShell.surfaceGroups) {
      objectGroups.set(`__room__:${surface}`, group);
      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) pickables.push(child);
      });
    }
  }
  if (options.editorHelpers) {
    const playerSpawnGroup = buildPlayerSpawnGroup(map);
    const sunGroup = buildSunGroup(map);
    root.add(playerSpawnGroup, sunGroup);
    objectGroups.set(PLAYER_SPAWN_OBJECT_ID, playerSpawnGroup);
    objectGroups.set(SUN_OBJECT_ID, sunGroup);
  }
  for (const object of map.objects) {
    const group = objectGroups.get(object.id);
    if (!group) continue;
    const parent = object.parentId ? objectGroups.get(object.parentId) : null;
    if (parent && parent !== group) parent.add(group);
    else modelsRoot.add(group);
  }
  modelsRoot.updateMatrixWorld(true);
  const instancing = await buildMapPrimitiveBatches(map.objects.flatMap((object) => {
    const asset = object.visible && object.assetId ? assets.get(object.assetId) : undefined;
    const objectGroup = objectGroups.get(object.id);
    return asset && objectGroup && !object.behavior?.animation
      ? [{ objectId: object.id, objectGroup, asset, assetTags: deriveAssetTags(asset) }]
      : [];
  }), {
    scene: options.scene ?? new THREE.Scene(),
    modelsRoot,
    materialTagPolicy: map.materialTagPolicy
  });
  modelsRoot.add(instancing.root);
  await populateObjectVisuals(map, assets, objectGroups, instancing.handledObjectIds);
  if (options.motionAdapter) {
    for (const object of map.objects) {
      if (!object.visible || !object.behavior?.animation || !object.assetId) continue;
      const asset = assets.get(object.assetId);
      const group = objectGroups.get(object.id);
      if (!asset || !group) continue;
      const controller = await options.motionAdapter.attach({ object, asset, group });
      if (controller) motionControllers.push(controller);
    }
  }
  const localLights = buildMapLocalLights(map, objectGroups);
  root.add(localLights.group);
  for (const group of objectGroups.values()) {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.userData.editorHelper !== true) pickables.push(child);
    });
  }
  pickables.push(...instancing.pickables);

  return {
    group: root,
    modelsRoot,
    runtimeIndex: instancing.runtimeIndex,
    objectGroups,
    pickables,
    syncObjectTransform: instancing.syncObjectTransform,
    update: (deltaTime, camera, maxDistance) => {
      materialElapsedSeconds += deltaTime;
      sandFlow.time += deltaTime;
      syncTerrainSandShader(sandFlow);
      grass?.update(deltaTime);
      motionControllers.forEach((controller) => controller.update(deltaTime, materialElapsedSeconds));
      instancing.updateCulling(camera, maxDistance);
      instancing.updateMaterialEffects(materialElapsedSeconds);
      localLights.update(camera);
    },
    restoreMaterialEffects: instancing.restoreMaterialEffects,
    syncMaterialEnvironment: instancing.syncEnvironment,
    getRuntimeBatchMeshes: instancing.getBatchMeshes,
    setGrassStyle: (style) => {
      grassStyle = style;
      grass?.setStyle(style);
      applyTerrainGrassTint(terrain, grassMap, style);
    },
    setSandFlowStrength: (strength) => {
      sandFlow.strength = THREE.MathUtils.clamp(strength, 0, 1);
      syncTerrainSandShader(sandFlow);
    },
    setRoomWallDisplayMode: (mode, camera) => roomShell?.setDisplayMode(mode, camera),
    setLightingTimeOfDay: localLights.setTimeOfDay,
    interactGrass: (position, elapsedSeconds) => grass?.interact(position, elapsedSeconds),
    clearGrassInteraction: () => grass?.clearInteraction(),
    getDebugStats: () => {
      const grassStats = grass?.getStats() ?? { layerCount: 0, bladeCount: 0, flowerCount: 0, drawCalls: 0 };
      return {
        ...instancing.getStats(),
        grassLayers: grassStats.layerCount,
        grassBlades: grassStats.bladeCount,
        grassFlowers: grassStats.flowerCount,
        grassDrawCalls: grassStats.drawCalls
      };
    },
    refreshGrass: rebuildGrass,
    refreshTerrain: (next) => {
      terrain.geometry.dispose();
      terrain.geometry = buildTerrainGeometry(next);
      // Keep the live material so an applied render scheme survives the swap.
      const material = terrain.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.map = createSurfaceTexture(next, 'terrain');
      material.needsUpdate = true;
      updateTerrainSandZones(sandFlow, next);
      // Blades sample terrain height, so they have to follow the new surface.
      rebuildGrass(next);
    },
    dispose: () => {
      motionControllers.forEach((controller) => controller.dispose());
      grass?.dispose();
      instancing.dispose();
      disposeObject(root);
    }
  };
}

interface RoomShellRender {
  group: THREE.Group;
  surfaceGroups: Map<RoomSurface, THREE.Group>;
  setDisplayMode(mode: RoomWallDisplayMode, camera: THREE.Camera): void;
}

function buildRoomShell(map: EditableMap): RoomShellRender | null {
  if (!map.room) return null;
  const group = new THREE.Group();
  group.name = 'room';
  group.userData.isRoomShell = true;
  const surfaceGroups = new Map<RoomSurface, THREE.Group>();
  const shadowShell = new THREE.Group();
  shadowShell.name = 'roomShadowShell';
  group.add(shadowShell);
  for (const surface of ROOM_SURFACES) {
    const surfaceGroup = new THREE.Group();
    surfaceGroup.name = `room:${surface}`;
    surfaceGroup.userData.surface = surface;
    surfaceGroup.userData.mapObjectId = `__room__:${surface}`;
    surfaceGroups.set(surface, surfaceGroup);
    group.add(surfaceGroup);
  }

  for (const segment of buildRoomShellSegments(map)) {
    const finish = map.interiorArtDirection?.surfaces[segment.surface];
    const glass = finish?.recipe === 'glass.panel';
    const parameters = {
      color: map.box.colors[segment.surface], map: createSurfaceTexture(map, segment.surface, segment),
      roughness: finish?.roughness ?? 0.82, metalness: 0, side: THREE.DoubleSide
    };
    const material = glass
      ? new THREE.MeshPhysicalMaterial({
          ...parameters, transparent: true, opacity: 0.42, transmission: 0.62,
          thickness: Math.max(0.02, Math.min(...segment.size)), depthWrite: false
        })
      : new THREE.MeshStandardMaterial(parameters);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.position.set(...segment.center);
    mesh.scale.set(...segment.size);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.surface = segment.surface;
    mesh.userData.mapObjectId = `__room__:${segment.surface}`;
    mesh.userData.roomFullCenterY = segment.center[1];
    mesh.userData.roomFullHeight = segment.size[1];
    mesh.userData.roomYMin = segment.yMin;
    mesh.userData.roomYMax = segment.yMax;
    surfaceGroups.get(segment.surface)?.add(mesh);
    if (segment.surface !== 'floor' && !glass) {
      const shadowMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      shadowMaterial.colorWrite = false;
      shadowMaterial.depthWrite = false;
      const shadowMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shadowMaterial);
      shadowMesh.position.set(...segment.center);
      shadowMesh.scale.set(...segment.size);
      shadowMesh.castShadow = true;
      shadowMesh.receiveShadow = false;
      shadowShell.add(shadowMesh);
    }
  }

  const setDisplayMode = (mode: RoomWallDisplayMode, camera: THREE.Camera): void => {
    const room = map.room!;
    const cameraX = camera.position.x - room.position[0];
    const cameraZ = camera.position.z - room.position[2];
    const hiddenCutaway = new Set<RoomSurface>();
    if (mode === 'cutaway') {
      if (map.interiorArtDirection?.surfaces.ceiling.recipe !== 'glass.panel') hiddenCutaway.add('ceiling');
      if (Math.abs(cameraX) > 0.05) hiddenCutaway.add(cameraX > 0 ? 'east' : 'west');
      if (Math.abs(cameraZ) > 0.05) hiddenCutaway.add(cameraZ > 0 ? 'south' : 'north');
    }
    for (const [surface, surfaceGroup] of surfaceGroups) {
      const isWall = surface !== 'floor' && surface !== 'ceiling';
      surfaceGroup.visible = surface === 'floor'
        || (mode === 'full')
        || (mode === 'cutaway' && !hiddenCutaway.has(surface))
        || (mode === 'half' && isWall);
      surfaceGroup.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const fullHeight = Number(mesh.userData.roomFullHeight);
        const fullCenterY = Number(mesh.userData.roomFullCenterY);
        mesh.scale.y = fullHeight;
        mesh.position.y = fullCenterY;
        mesh.visible = true;
        if (mode !== 'half' || !isWall) return;
        const yMin = Number(mesh.userData.roomYMin);
        const yMax = Math.min(Number(mesh.userData.roomYMax), room.size[1] / 2);
        const visibleHeight = yMax - yMin;
        if (visibleHeight <= 0.001) {
          mesh.visible = false;
          return;
        }
        mesh.scale.y = visibleHeight;
        mesh.position.y = room.position[1] + (yMin + yMax) / 2;
      });
    }
  };
  setDisplayMode('full', new THREE.PerspectiveCamera());
  return { group, surfaceGroups, setDisplayMode };
}

function applyTerrainGrassTint(mesh: THREE.Mesh, map: EditableMap, style: RuntimeGrassStyle): void {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
  const grassColor = new THREE.Color(style.groundColor);
  const rootColor = new THREE.Color(style.rootColor);
  grassColor.lerp(rootColor, 0.58);
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const base = terrainVertexColor(map, x, y, z);
    color.setRGB(base[0], base[1], base[2]);
    const isSurface = y >= sampleTerrainHeight(map, x, z) - 0.05;
    if (style.groundTint && isSurface) {
      const nonGrassWeight = terrainSemanticSurfaceWeight(map, x, z, ['sand', 'rocky']);
      const density = combinedGrassDensity(map, x, z) * (1 - nonGrassWeight);
      const transition = density * density * (3 - 2 * density);
      color.lerp(grassColor, transition * style.groundTintStrength);
    }
    colors.setXYZ(index, color.r, color.g, color.b);
  }
  colors.needsUpdate = true;
}

function buildTerrain(map: EditableMap): THREE.Mesh {
  const geometry = buildTerrainGeometry(map);
  const texture = createSurfaceTexture(map, 'terrain');
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    roughness: 0.92,
    vertexColors: true,
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.surface = 'terrain';
  mesh.userData.sandFlow = installTerrainSandShader(material, map);
  return mesh;
}

interface TerrainSandFlowState {
  time: number;
  strength: number;
  zones: THREE.Vector4[];
  shader: THREE.WebGLProgramParametersWithUniforms | null;
}

function installTerrainSandShader(material: THREE.MeshStandardMaterial, map: EditableMap): TerrainSandFlowState {
  const state: TerrainSandFlowState = { time: 0, strength: 0, zones: [], shader: null };
  updateTerrainSandZones(state, map);
  material.onBeforeCompile = (shader) => {
    state.shader = shader;
    shader.uniforms.uTerrainSandTime = { value: state.time };
    shader.uniforms.uTerrainSandStrength = { value: state.strength };
    shader.uniforms.uTerrainSandZoneCount = { value: state.zones.length };
    shader.uniforms.uTerrainSandZones = { value: paddedSandZones(state.zones) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainSandPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainSandPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainSandPosition;
        uniform float uTerrainSandTime;
        uniform float uTerrainSandStrength;
        uniform int uTerrainSandZoneCount;
        uniform vec4 uTerrainSandZones[8];
      `)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float terrainSandMask = 0.0;
        for (int i = 0; i < 8; i++) {
          if (i >= uTerrainSandZoneCount) break;
          vec4 zone = uTerrainSandZones[i];
          float distanceToZone = length(vTerrainSandPosition.xz - zone.xy);
          terrainSandMask = max(terrainSandMask, (1.0 - smoothstep(zone.z * 0.72, zone.z, distanceToZone)) * zone.w);
        }
        float terrainSandRipple = sin(dot(vTerrainSandPosition.xz, vec2(0.72, 0.38)) * 3.2 - uTerrainSandTime * 1.7) * 0.58;
        terrainSandRipple += sin(dot(vTerrainSandPosition.xz, vec2(-0.31, 0.95)) * 5.1 - uTerrainSandTime * 1.15) * 0.42;
        float terrainSandFlow = smoothstep(0.08, 0.82, terrainSandRipple) * terrainSandMask * uTerrainSandStrength;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.78, 0.34), terrainSandFlow * 0.42);
        diffuseColor.rgb *= 1.0 - smoothstep(0.52, 0.92, terrainSandRipple) * terrainSandMask * uTerrainSandStrength * 0.12;
      `);
    syncTerrainSandShader(state);
  };
  material.customProgramCacheKey = () => 'worldforge-terrain-sand-v2';
  return state;
}

function updateTerrainSandZones(state: TerrainSandFlowState, map: EditableMap): void {
  state.zones = map.visualSemantics.zones
    .filter((zone) => zone.tags.includes('sand'))
    .slice(0, 8)
    .map((zone) => new THREE.Vector4(zone.center[0], zone.center[1], zone.radius, zone.intensity));
  syncTerrainSandShader(state);
}

function syncTerrainSandShader(state: TerrainSandFlowState): void {
  const uniforms = state.shader?.uniforms;
  if (!uniforms) return;
  uniforms.uTerrainSandTime.value = state.time;
  uniforms.uTerrainSandStrength.value = state.strength;
  uniforms.uTerrainSandZoneCount.value = state.zones.length;
  uniforms.uTerrainSandZones.value = paddedSandZones(state.zones);
}

function paddedSandZones(zones: readonly THREE.Vector4[]): THREE.Vector4[] {
  return Array.from({ length: 8 }, (_, index) => zones[index]?.clone() ?? new THREE.Vector4());
}

export function buildStructuredWaterGroup(map: EditableMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'waterBodies';
  group.userData.isStructuredWaterRoot = true;
  const visibleWaters = map.waterBodies.filter((water) => {
    if (water.points.length === 0) return false;
    const center = water.points.reduce(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
      [0, 0] as [number, number]
    );
    return map.layout.edgeMask.kind === 'none' || isPointInsidePlayableArea(
      map.layout,
      map.box.size,
      center[0] / water.points.length,
      center[1] / water.points.length
    );
  });
  for (const waters of groupConnectedWaterBodies(visibleWaters)) {
    const water = waters[0];
    const shore = createCompositeWaterShoreBinding(map, waters);
    const isComposite = waters.length > 1;
    const geometry = isComposite
      ? buildCompositeWaterGeometry(shore.size)
      : water.type !== 'river'
        ? buildLakeGeometry(waterBoundaryPoints(water))
        : buildRiverGeometry(water);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4f96a8,
      transparent: true,
      opacity: 0.82,
      roughness: 0.28,
      metalness: 0.04,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `water:${water.id}`;
    mesh.position.set(
      isComposite ? shore.center[0] : 0,
      waters.reduce((sum, candidate) => sum + candidate.level, 0) / waters.length,
      isComposite ? shore.center[1] : 0
    );
    mesh.renderOrder = 8;
    mesh.userData.waterBodyId = water.id;
    mesh.userData.waterBodyIds = waters.map((candidate) => candidate.id);
    mesh.userData.waterBodyType = waters.every((candidate) => candidate.type === water.type)
      ? water.type
      : 'mixed';
    mesh.userData.isWater = true;
    mesh.userData.skipShaderApply = true;
    mesh.userData.excludeFromPlanarReflection = true;
    mesh.userData.materialTags = [
      'water',
      ...new Set(waters.flatMap((candidate) => [candidate.type, candidate.id]))
    ];
    mesh.userData.assetTags = ['water', ...new Set(waters.map((candidate) => candidate.type))];
    mesh.userData.waterShore = { ...shore, worldSpace: !isComposite };
    group.add(mesh);
  }
  return group;
}

interface WaterShoreBinding {
  texture: THREE.DataTexture;
  center: [number, number];
  size: number;
  worldSpace?: boolean;
}

function groupConnectedWaterBodies(waters: readonly MapWaterBody[]): MapWaterBody[][] {
  const boundaries = waters.map(waterBoundaryPoints);
  const parents = waters.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  for (let left = 0; left < waters.length; left += 1) {
    for (let right = left + 1; right < waters.length; right += 1) {
      if (waters[left].type === 'ocean' || waters[right].type === 'ocean') continue;
      if (hasSlopedRiver(waters[left]) || hasSlopedRiver(waters[right])) continue;
      if (Math.abs(waters[left].level - waters[right].level) > 0.05) continue;
      if (!waterBoundariesTouch(boundaries[left], boundaries[right])) continue;
      parents[find(right)] = find(left);
    }
  }
  const groups = new Map<number, MapWaterBody[]>();
  for (let index = 0; index < waters.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(waters[index]);
    groups.set(root, group);
  }
  return [...groups.values()];
}

function createCompositeWaterShoreBinding(map: EditableMap, waters: readonly MapWaterBody[]): WaterShoreBinding {
  const boundaries = waters.map(waterBoundaryPoints);
  const points = boundaries.flat();
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const center: [number, number] = [(minX + maxX) / 2, (minZ + maxZ) / 2];
  const size = Math.max(1, maxX - minX, maxZ - minZ) * 1.12;
  const resolution = THREE.MathUtils.clamp(THREE.MathUtils.ceilPowerOfTwo(size * 4), 128, 512);
  const inside = new Uint8Array(resolution * resolution);
  const data = new Uint8Array(resolution * resolution);
  for (let row = 0; row < resolution; row += 1) {
    const v = (row + 0.5) / resolution;
    const z = center[1] + (0.5 - v) * size;
    for (let column = 0; column < resolution; column += 1) {
      const u = (column + 0.5) / resolution;
      const x = center[0] + (u - 0.5) * size;
      // Outside the ocean plane is still water, so only raised terrain becomes a shoreline.
      if (waters.some((water, index) => water.type === 'ocean'
        ? !pointInPolygon(x, z, boundaries[index]) || isPointInsideWaterBody(water, x, z, map)
        : pointInPolygon(x, z, boundaries[index]))) {
        inside[row * resolution + column] = 1;
      }
    }
  }
  const distances = distanceFromOutside(inside, resolution);
  let maxDistance = 0;
  for (let index = 0; index < distances.length; index += 1) {
    if (inside[index]) maxDistance = Math.max(maxDistance, distances[index]);
  }
  const distanceScale = maxDistance > 0 ? 255 / maxDistance : 0;
  for (let index = 0; index < data.length; index += 1) {
    if (inside[index]) data[index] = Math.round(Math.min(255, distances[index] * distanceScale));
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.UnsignedByteType);
  texture.name = `water-shore:${waters[0]?.id ?? 'empty'}+${waters.length}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, center, size };
}

function buildCompositeWaterGeometry(size: number): THREE.BufferGeometry {
  const segments = THREE.MathUtils.clamp(Math.ceil(size / 4), 8, 32);
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function waterBoundariesTouch(
  left: readonly [number, number][],
  right: readonly [number, number][]
): boolean {
  const leftX = left.map((point) => point[0]);
  const leftZ = left.map((point) => point[1]);
  const rightX = right.map((point) => point[0]);
  const rightZ = right.map((point) => point[1]);
  if (Math.max(...leftX) < Math.min(...rightX) || Math.max(...rightX) < Math.min(...leftX)
    || Math.max(...leftZ) < Math.min(...rightZ) || Math.max(...rightZ) < Math.min(...leftZ)) {
    return false;
  }
  if (left.some(([x, z]) => pointInPolygon(x, z, right))
    || right.some(([x, z]) => pointInPolygon(x, z, left))) {
    return true;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const a = left[leftIndex];
    const b = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const c = right[rightIndex];
      const d = right[(rightIndex + 1) % right.length];
      if (segmentsTouch(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsTouch(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number]
): boolean {
  const cross = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  );
  const onSegment = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (
    Math.abs(cross(p, q, r)) <= 1e-6
    && r[0] >= Math.min(p[0], q[0]) - 1e-6 && r[0] <= Math.max(p[0], q[0]) + 1e-6
    && r[1] >= Math.min(p[1], q[1]) - 1e-6 && r[1] <= Math.max(p[1], q[1]) + 1e-6
  );
  const ac = cross(a, b, c);
  const ad = cross(a, b, d);
  const ca = cross(c, d, a);
  const cb = cross(c, d, b);
  return ((ac > 0 && ad < 0) || (ac < 0 && ad > 0))
    && ((ca > 0 && cb < 0) || (ca < 0 && cb > 0))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function distanceFromOutside(inside: Uint8Array, resolution: number): Float32Array {
  const distances = new Float32Array(inside.length);
  const diagonal = Math.SQRT2;
  for (let index = 0; index < inside.length; index += 1) {
    distances[index] = inside[index] ? Number.POSITIVE_INFINITY : 0;
  }
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const index = row * resolution + column;
      if (!inside[index]) continue;
      if (column > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      if (row > 0) distances[index] = Math.min(distances[index], distances[index - resolution] + 1);
      if (column > 0 && row > 0) distances[index] = Math.min(distances[index], distances[index - resolution - 1] + diagonal);
      if (column + 1 < resolution && row > 0) distances[index] = Math.min(distances[index], distances[index - resolution + 1] + diagonal);
    }
  }
  for (let row = resolution - 1; row >= 0; row -= 1) {
    for (let column = resolution - 1; column >= 0; column -= 1) {
      const index = row * resolution + column;
      if (!inside[index]) continue;
      if (column + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      if (row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution] + 1);
      if (column + 1 < resolution && row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution + 1] + diagonal);
      if (column > 0 && row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution - 1] + diagonal);
    }
  }
  return distances;
}

function buildLakeGeometry(input: MapWaterBody['points']): THREE.BufferGeometry {
  const points = cleanWaterPoints(input);
  const vertices = points.flatMap(([x, z]) => [x, 0, z]);
  const contour = points.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const indices: number[] = [];
  for (const [a, b, c] of faces) pushUpwardTriangle(indices, vertices, a, b, c);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRiverGeometry(water: MapWaterBody): THREE.BufferGeometry {
  const edges = riverEdgePairs(water);
  const vertices: number[] = [];
  for (const edge of edges) {
    const y = edge.level - water.level;
    vertices.push(edge.left[0], y, edge.left[1], edge.right[0], y, edge.right[1]);
  }
  const indices: number[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const left = index * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    pushUpwardTriangle(indices, vertices, left, nextLeft, right);
    pushUpwardTriangle(indices, vertices, right, nextLeft, nextRight);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function riverEdgePairs(water: MapWaterBody): Array<{
  left: [number, number];
  right: [number, number];
  level: number;
}> {
  const samples = riverPathSamples(water);
  const halfWidth = water.width / 2;
  return samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].point;
    const next = samples[Math.min(samples.length - 1, index + 1)].point;
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = -dz / length * halfWidth;
    const offsetZ = dx / length * halfWidth;
    return {
      left: [sample.point[0] + offsetX, sample.point[1] + offsetZ],
      right: [sample.point[0] - offsetX, sample.point[1] - offsetZ],
      level: sample.level
    };
  });
}

function hasSlopedRiver(water: MapWaterBody): boolean {
  return water.type === 'river' && Boolean(water.levels?.some((level) => Math.abs(level - water.level) > 0.05));
}

function pointInPolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const a = points[current];
    const b = points[previous];
    if ((a[1] > z) !== (b[1] > z)
      && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || Number.EPSILON) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function cleanWaterPoints(points: MapWaterBody['points']): MapWaterBody['points'] {
  return points.filter((point, index) => (
    index === 0
    || point[0] !== points[index - 1][0]
    || point[1] !== points[index - 1][1]
  ));
}

function pushUpwardTriangle(
  indices: number[],
  vertices: number[],
  a: number,
  b: number,
  c: number
): void {
  const ax = vertices[b * 3] - vertices[a * 3];
  const az = vertices[b * 3 + 2] - vertices[a * 3 + 2];
  const bx = vertices[c * 3] - vertices[a * 3];
  const bz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
  if (az * bx - ax * bz >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
}

function buildTerrainGeometry(map: EditableMap): THREE.BufferGeometry {
  const terrain = map.terrain;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let z = 0; z < terrain.resolutionZ; z += 1) {
    for (let x = 0; x < terrain.resolutionX; x += 1) {
      const point = terrainPointAt(map, x, z);
      vertices.push(point[0], point[1], point[2]);
      uvs.push(x / (terrain.resolutionX - 1), z / (terrain.resolutionZ - 1));
    }
  }

  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
      const a = terrainIndex(terrain, x, z);
      const b = terrainIndex(terrain, x + 1, z);
      const c = terrainIndex(terrain, x, z + 1);
      const d = terrainIndex(terrain, x + 1, z + 1);
      const centerX = (vertices[a * 3] + vertices[d * 3]) / 2;
      const centerZ = (vertices[a * 3 + 2] + vertices[d * 3 + 2]) / 2;
      if (!isPointInsidePlayableArea(map.layout, map.box.size, centerX, centerZ)) continue;
      if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }

  if (map.layout.edgeMask.kind === 'none') addBorderSides(vertices, uvs, indices, map);
  else addMaskBorderSides(vertices, uvs, indices, map);
  const colors: number[] = [];
  for (let index = 0; index < vertices.length; index += 3) {
    colors.push(...terrainVertexColor(map, vertices[index], vertices[index + 1], vertices[index + 2]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addBorderSides(vertices: number[], uvs: number[], indices: number[], map: EditableMap): void {
  const terrain = map.terrain;
  // Carved lake basins push heights below zero, so the skirt has to reach the
  // lowest point on the map instead of always stopping at y=0.
  const base = terrain.heights.reduce((lowest, height) => Math.min(lowest, height), 0);
  for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, x, 0), terrainPointAt(map, x + 1, 0));
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, x, terrain.resolutionZ - 1), terrainPointAt(map, x + 1, terrain.resolutionZ - 1));
  }
  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, 0, z), terrainPointAt(map, 0, z + 1));
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, terrain.resolutionX - 1, z), terrainPointAt(map, terrain.resolutionX - 1, z + 1));
  }
}

function addSideToBase(vertices: number[], uvs: number[], indices: number[], map: EditableMap, base: number, a: number[], b: number[]): void {
  if (a[1] - base < 0.08 && b[1] - base < 0.08) return;
  addQuad(
    vertices,
    uvs,
    indices,
    map,
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
    [a[0], base, a[2]],
    [b[0], base, b[2]]
  );
}

function addQuad(
  vertices: number[],
  uvs: number[],
  indices: number[],
  map: EditableMap,
  p0: number[],
  p1: number[],
  p2: number[],
  p3: number[]
): void {
  const index = vertices.length / 3;
  vertices.push(...p0, ...p1, ...p2, ...p3);
  for (const point of [p0, p1, p2, p3]) {
    const [u, v] = terrainUv(map, point[0], point[2]);
    uvs.push(u, v);
  }
  indices.push(index, index + 2, index + 1, index + 1, index + 2, index + 3);
}

function terrainUv(map: EditableMap, x: number, z: number): [number, number] {
  const bounds = getMapBounds(map);
  return [
    (x - bounds.minX) / (bounds.maxX - bounds.minX),
    (z - bounds.minZ) / (bounds.maxZ - bounds.minZ)
  ];
}

function createObjectGroups(map: EditableMap): Map<string, THREE.Group> {
  const groups = new Map<string, THREE.Group>();
  for (const object of map.objects) {
    if (map.layout.edgeMask.kind !== 'none'
      && !isPointInsidePlayableArea(map.layout, map.box.size, object.transform.position[0], object.transform.position[2])) continue;
    const group = new THREE.Group();
    group.name = object.name;
    group.userData.mapObjectId = object.id;
    applyObjectTransform(group, object);
    groups.set(object.id, group);
  }
  return groups;
}

async function populateObjectVisuals(
  map: EditableMap,
  assets: Map<string, MapAsset>,
  groups: Map<string, THREE.Group>,
  handledObjectIds: Set<string>
): Promise<void> {
  const templates = new Map<string, { group: THREE.Group; used: boolean }>();
  for (const object of map.objects) {
    if (!object.visible || handledObjectIds.has(object.id)) continue;
    const group = groups.get(object.id);
    if (!group) continue;
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (asset) group.userData.assetTags = deriveAssetTags(asset);
    const visual = asset?.modelJson
      ? await takeAssetVisual(asset, templates)
      : buildFallbackObject();
    visual.traverse((child) => {
      child.userData.mapObjectId = object.id;
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    group.add(visual);
  }
}

async function takeAssetVisual(
  asset: MapAsset,
  templates: Map<string, { group: THREE.Group; used: boolean }>
): Promise<THREE.Group> {
  let entry = templates.get(asset.id);
  if (!entry) {
    entry = { group: await buildModelGroup(asset.modelJson), used: false };
    templates.set(asset.id, entry);
  }
  if (!entry.used) {
    entry.used = true;
    return entry.group;
  }
  return cloneAssetVisual(entry.group);
}

function cloneAssetVisual(template: THREE.Group): THREE.Group {
  const clone = template.clone(true);
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => material.clone())
      : mesh.material.clone();
  });
  return clone;
}

function deriveAssetTags(asset: MapAsset): string[] {
  const source = `${asset.name} ${asset.prompt}`.toLowerCase();
  const tags = new Set<string>([asset.id, ...(asset.tags ?? [])]);
  for (const token of source.split(/[^a-z0-9_-]+/).filter((item) => item.length > 2)) tags.add(token.slice(0, 48));
  const semantic: Array<[RegExp, string[]]> = [
    [/(树|tree|forest)/i, ['tree', 'vegetation']],
    [/(石|岩|rock|stone)/i, ['rock', 'stone']],
    [/(草|花|植被|grass|flower|plant)/i, ['vegetation']],
    [/(建筑|房|屋|building|house)/i, ['building']],
    [/(金属|metal)/i, ['metal']],
    [/(水|湖|河|water|lake|river)/i, ['water']]
  ];
  for (const [pattern, values] of semantic) {
    if (pattern.test(source)) values.forEach((value) => tags.add(value));
  }
  return [...tags].slice(0, 24);
}

function applyObjectTransform(group: THREE.Group, object: MapObject): void {
  const { position, rotation, scale, size } = object.transform;
  group.position.set(position[0], position[1], position[2]);
  group.rotation.set(rotation[0], rotation[1], rotation[2]);
  group.scale.set(scale[0] * size[0], scale[1] * size[1], scale[2] * size[2]);
}

function buildFallbackObject(): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x7f8a85, roughness: 0.78, flatShading: true })
  );
  mesh.position.y = 0.5;
  group.add(mesh);
  return group;
}

function buildPlayerSpawnGroup(map: EditableMap): THREE.Group {
  const spawn = getSpawnPoints(map)[0];
  const { height, radius } = getMapPlayerMetrics(map);
  const group = new THREE.Group();
  group.name = '场景参考点';
  group.userData.skipShaderApply = true;
  group.userData.skipNormalDepthPrePass = true;
  group.userData.isEditorObject = true;
  group.position.set(spawn[0], spawn[1], spawn[2]);
  group.rotation.y = getPlayerSpawnYaw(map);
  group.userData.mapObjectId = PLAYER_SPAWN_OBJECT_ID;

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(0.01, height - radius * 2), 8, 16),
    new THREE.MeshStandardMaterial({
      color: 0x7bc8ff,
      emissive: 0x1d5f78,
      emissiveIntensity: 0.35,
      roughness: 0.45,
      transparent: true,
      opacity: 0.72
    })
  );
  body.position.y = height / 2;

  const footprint = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.08, radius * 1.38, 40),
    new THREE.MeshBasicMaterial({
      color: 0xd8ef75,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false
    })
  );
  footprint.rotation.x = -Math.PI / 2;
  footprint.position.y = 0.025;

  const forward = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.28, radius * 0.55, 20),
    new THREE.MeshBasicMaterial({ color: 0xd8ef75, transparent: true, opacity: 0.9 })
  );
  forward.rotation.x = Math.PI / 2;
  forward.position.set(0, height * 0.78, -radius * 1.25);

  group.add(body, footprint, forward);
  group.traverse((child) => {
    child.userData.mapObjectId = PLAYER_SPAWN_OBJECT_ID;
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}

function buildSunGroup(map: EditableMap): THREE.Group {
  const position = getSunPosition(map);
  const group = new THREE.Group();
  group.name = '太阳';
  group.userData.skipShaderApply = true;
  group.userData.skipNormalDepthPrePass = true;
  group.userData.isEditorObject = true;
  group.position.set(position[0], position[1], position[2]);
  group.userData.mapObjectId = SUN_OBJECT_ID;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.65, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd66b })
  );
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.05, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0xfff0b8,
      transparent: true,
      opacity: 0.24,
      depthWrite: false
    })
  );
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1.25, 1.38, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffe28a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    })
  );
  halo.rotation.x = Math.PI / 2;

  group.add(glow, sphere, halo);
  group.traverse((child) => {
    child.userData.mapObjectId = SUN_OBJECT_ID;
  });
  return group;
}

function createSurfaceTexture(
  map: EditableMap,
  surface: MapSurface,
  segment?: RoomShellSegment
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 768;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Vertex colors own the terrain palette; a neutral base keeps paint strokes
    // and the editor grid from multiplying the surface darker.
    ctx.fillStyle = surface === 'terrain' ? '#ffffff' : map.box.colors[surface as keyof typeof map.box.colors];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (surface === 'terrain') drawSemanticTerrainSurface(ctx, map, canvas.width, canvas.height);
    const finish = surface !== 'terrain' ? map.interiorArtDirection?.surfaces[surface as RoomSurface] : undefined;
    if (finish) drawSurfaceFinish(ctx, finish, surfaceDimensions(map, surface as RoomSurface), canvas.width, canvas.height);
    drawSubtleGrid(ctx, canvas.width, canvas.height);
    for (const stroke of map.paintStrokes) {
      if (stroke.surface !== surface && !(surface === 'terrain' && stroke.surface === 'floor')) continue;
      drawStroke(ctx, stroke, canvas.width, canvas.height);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  if (segment && segment.surface !== 'floor' && segment.surface !== 'ceiling' && map.room) {
    const span = segment.surface === 'north' || segment.surface === 'south'
      ? map.room.size[0]
      : map.room.size[2];
    texture.repeat.set((segment.uMax - segment.uMin) / span, (segment.yMax - segment.yMin) / map.room.size[1]);
    texture.offset.set(segment.uMin / span + 0.5, segment.yMin / map.room.size[1]);
  }
  texture.needsUpdate = true;
  return texture;
}

function surfaceDimensions(map: EditableMap, surface: RoomSurface): [number, number] {
  const room = map.room;
  if (!room) return [map.box.size[0], map.box.size[2]];
  if (surface === 'floor' || surface === 'ceiling') return [room.size[0], room.size[2]];
  return [surface === 'north' || surface === 'south' ? room.size[0] : room.size[2], room.size[1]];
}

function drawSurfaceFinish(
  ctx: CanvasRenderingContext2D,
  finish: SurfaceFinishRecipe,
  dimensions: [number, number],
  width: number,
  height: number
): void {
  const [primary, secondary, accent = secondary] = finish.palette;
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, width, height);
  const unitX = Math.max(8, width * finish.scale / Math.max(0.1, dimensions[0]));
  const unitY = Math.max(8, height * finish.scale / Math.max(0.1, dimensions[1]));
  const joint = Math.max(1, Math.min(unitX, unitY) * finish.jointWidth / Math.max(0.04, finish.scale));
  const random = seededRandom(finish.seed);

  if (finish.recipe === 'paint.solid' || finish.recipe === 'plaster.soft') {
    const marks = finish.recipe === 'plaster.soft' ? 900 : 320;
    for (let index = 0; index < marks; index += 1) {
      ctx.globalAlpha = finish.variation * (0.08 + random() * 0.16);
      ctx.fillStyle = random() > 0.5 ? secondary : accent;
      const size = 0.5 + random() * (finish.recipe === 'plaster.soft' ? 2.2 : 1.1);
      ctx.fillRect(random() * width, random() * height, size, size);
    }
  } else if (finish.recipe === 'wallpaper.stripe') {
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = secondary;
    for (let x = 0; x < width; x += unitX) ctx.fillRect(x, 0, Math.max(2, unitX * 0.28), height);
  } else if (finish.recipe === 'wallpaper.geometric') {
    ctx.strokeStyle = secondary;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = Math.max(1, joint);
    for (let y = -unitY; y < height + unitY; y += unitY) {
      for (let x = -unitX; x < width + unitX; x += unitX) {
        ctx.beginPath();
        ctx.moveTo(x, y + unitY / 2);
        ctx.lineTo(x + unitX / 2, y);
        ctx.lineTo(x + unitX, y + unitY / 2);
        ctx.lineTo(x + unitX / 2, y + unitY);
        ctx.closePath();
        ctx.stroke();
      }
    }
  } else if (finish.recipe === 'wood.plank') {
    const rowHeight = Math.max(10, unitY * 0.45);
    for (let row = 0, y = 0; y < height; row += 1, y += rowHeight) {
      const offset = row % 2 ? -unitX * 0.5 : 0;
      for (let x = offset; x < width; x += unitX * 2.6) {
        ctx.globalAlpha = 0.14 + random() * finish.variation;
        ctx.fillStyle = random() > 0.5 ? secondary : accent;
        ctx.fillRect(x + joint, y + joint, unitX * 2.6 - joint * 2, rowHeight - joint * 2);
      }
    }
  } else if (finish.recipe === 'wood.herringbone') {
    ctx.strokeStyle = secondary;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(2, joint);
    for (let y = -unitY; y < height + unitY; y += unitY) {
      for (let x = -unitX; x < width + unitX; x += unitX) {
        ctx.beginPath();
        ctx.moveTo(x, y + unitY);
        ctx.lineTo(x + unitX, y);
        ctx.moveTo(x + unitX, y);
        ctx.lineTo(x + unitX * 2, y + unitY);
        ctx.stroke();
      }
    }
  } else if (finish.recipe === 'tile.ceramic' || finish.recipe === 'tile.stone' || finish.recipe === 'ceiling.panel' || finish.recipe === 'glass.panel') {
    ctx.strokeStyle = secondary;
    ctx.lineWidth = Math.max(1, joint);
    ctx.globalAlpha = 0.5;
    for (let x = 0; x <= width; x += unitX) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y <= height; y += unitY) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (finish.recipe === 'tile.stone') {
      for (let index = 0; index < 420; index += 1) {
        ctx.globalAlpha = finish.variation * 0.18;
        ctx.fillStyle = accent;
        ctx.fillRect(random() * width, random() * height, 1 + random() * 3, 1 + random() * 3);
      }
    }
  } else if (finish.recipe === 'carpet.loop') {
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        ctx.globalAlpha = 0.08 + random() * finish.variation;
        ctx.fillStyle = random() > 0.5 ? secondary : accent;
        ctx.fillRect(x, y, 2, 2);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function buildProceduralRugs(map: EditableMap): THREE.Group | null {
  const room = map.room;
  const rugs = map.interiorArtDirection?.rugs ?? [];
  if (!room || rugs.length === 0) return null;
  const group = new THREE.Group();
  group.name = 'proceduralRugs';
  for (const rug of rugs) {
    const availableWidth = Math.max(0.4, room.size[0] - room.wallThickness * 4);
    const availableDepth = Math.max(0.4, room.size[2] - room.wallThickness * 4);
    const width = Math.min(availableWidth * 0.94, room.size[0] * rug.size[0] * 1.4);
    const depth = Math.min(availableDepth * 0.94, room.size[2] * rug.size[1] * 1.4);
    const geometry = rug.shape === 'round'
      ? new THREE.CircleGeometry(Math.min(width, depth) / 2, 40)
      : new THREE.PlaneGeometry(width, depth);
    const material = new THREE.MeshStandardMaterial({
      map: createRugTexture(rug), roughness: 0.96, metalness: 0, side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `proceduralRug:${rug.id}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = THREE.MathUtils.degToRad(rug.rotation);
    mesh.position.set(
      room.position[0] + rug.center[0] * room.size[0] * 0.5,
      room.position[1] + 0.012,
      room.position[2] + rug.center[1] * room.size[2] * 0.5
    );
    mesh.receiveShadow = true;
    mesh.userData.proceduralRug = true;
    group.add(mesh);
  }
  return group;
}

function createRugTexture(rug: ProceduralRug): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const [primary, secondary, accent = secondary] = rug.palette;
    ctx.fillStyle = primary;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = secondary;
    ctx.fillStyle = secondary;
    ctx.lineWidth = 10;
    if (rug.pattern === 'border') ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
    if (rug.pattern === 'stripe') {
      for (let x = 0; x < canvas.width; x += 48) ctx.fillRect(x, 0, 20, canvas.height);
    }
    if (rug.pattern === 'geometric') {
      for (let y = 24; y < canvas.height; y += 48) {
        for (let x = 24; x < canvas.width; x += 48) {
          ctx.beginPath(); ctx.moveTo(x, y - 14); ctx.lineTo(x + 14, y); ctx.lineTo(x, y + 14); ctx.lineTo(x - 14, y); ctx.closePath(); ctx.fill();
        }
      }
    }
    if (rug.pattern === 'woven') {
      const random = seededRandom(rug.seed);
      for (let y = 0; y < canvas.height; y += 4) {
        ctx.globalAlpha = 0.12 + random() * 0.18;
        ctx.fillStyle = random() > 0.5 ? secondary : accent;
        ctx.fillRect(0, y, canvas.width, 2);
      }
      ctx.globalAlpha = 1;
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function seededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    return ((state ^ state >>> 14) >>> 0) / 4294967296;
  };
}

function addMaskBorderSides(vertices: number[], uvs: number[], indices: number[], map: EditableMap): void {
  const base = map.terrain.heights.reduce((lowest, height) => Math.min(lowest, height), 0);
  const polygons = map.layout.edgeMask.kind === 'composite'
    ? map.layout.edgeMask.polygons ?? [map.layout.edgeMask.points]
    : [map.layout.edgeMask.points];
  for (const points of polygons) {
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      if (map.layout.edgeMask.kind === 'composite' && !isCompositeOuterEdge(map, a, b)) continue;
      addSideToBase(
        vertices,
        uvs,
        indices,
        map,
        base,
        [a[0], sampleTerrainHeight(map, a[0], a[1]), a[1]],
        [b[0], sampleTerrainHeight(map, b[0], b[1]), b[1]]
      );
    }
  }
}

function isCompositeOuterEdge(
  map: EditableMap,
  a: [number, number],
  b: [number, number]
): boolean {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return false;
  const epsilon = Math.max(
    map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1),
    map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1)
  ) * 0.2;
  const middleX = (a[0] + b[0]) / 2;
  const middleZ = (a[1] + b[1]) / 2;
  const normalX = -dz / length * epsilon;
  const normalZ = dx / length * epsilon;
  const firstSide = isPointInsidePlayableArea(map.layout, map.box.size, middleX + normalX, middleZ + normalZ);
  const secondSide = isPointInsidePlayableArea(map.layout, map.box.size, middleX - normalX, middleZ - normalZ);
  return firstSide !== secondSide;
}

const SEMANTIC_SURFACE_COLORS = {
  grass: '#dceab7',
  forest: '#b5cda0',
  water: '#a8c8bd',
  lowland: '#bdcfb8',
  dry: '#dfc692',
  sand: '#e6c77d',
  settlement: '#d7c5a6',
  rocky: '#c3c0b2'
} as const;

function drawSemanticTerrainSurface(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  width: number,
  height: number
): void {
  for (const zone of map.visualSemantics.zones) {
    const tag = [...zone.tags].reverse().find((item) => item in SEMANTIC_SURFACE_COLORS);
    if (!tag) continue;
    const center = surfaceCanvasPoint(map, zone.center, width, height);
    const radiusX = zone.radius / map.box.size[0] * width;
    const radiusY = zone.radius / map.box.size[2] * height;
    const opacity = Math.min(0.24, 0.08 + zone.intensity * 0.12);
    ctx.save();
    ctx.translate(center[0], center[1]);
    ctx.scale(Math.max(0.001, radiusX), Math.max(0.001, radiusY));
    const gradient = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 1);
    gradient.addColorStop(0, withOpacity(SEMANTIC_SURFACE_COLORS[tag], opacity));
    gradient.addColorStop(0.72, withOpacity(SEMANTIC_SURFACE_COLORS[tag], opacity * 0.78));
    gradient.addColorStop(1, withOpacity(SEMANTIC_SURFACE_COLORS[tag], 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const water of map.waterBodies) drawWetShore(ctx, map, water, width, height);
}

function drawWetShore(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  water: MapWaterBody,
  width: number,
  height: number
): void {
  const points = water.points.map((point) => surfaceCanvasPoint(map, point, width, height));
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
  if (water.type !== 'river') ctx.closePath();
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  ctx.strokeStyle = 'rgba(88, 91, 70, 0.16)';
  ctx.lineWidth = Math.max(3, (water.type === 'river' ? water.width + 1.8 : 2.4) * pixelsPerMetre);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(164, 151, 109, 0.14)';
  ctx.lineWidth = Math.max(2, (water.type === 'river' ? water.width + 0.7 : 1.1) * pixelsPerMetre);
  ctx.stroke();
  ctx.restore();
}

function surfaceCanvasPoint(
  map: EditableMap,
  point: readonly [number, number],
  width: number,
  height: number
): [number, number] {
  return [
    (point[0] / map.box.size[0] + 0.5) * width,
    (0.5 - point[1] / map.box.size[2]) * height
  ];
}

function drawSubtleGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: MapPaintStroke, width: number, height: number): void {
  const x = stroke.uv[0] * width;
  const y = (1 - stroke.uv[1]) * height;
  const radius = Math.max(4, stroke.size * 18);
  const inner = radius * (1 - stroke.softness);
  const gradient = ctx.createRadialGradient(x, y, inner, x, y, radius);
  gradient.addColorStop(0, withOpacity(stroke.color, stroke.opacity));
  gradient.addColorStop(1, withOpacity(stroke.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function withOpacity(color: string, opacity: number): string {
  const hex = color.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function disposeObject(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      const maybe = material as THREE.MeshStandardMaterial;
      if (maybe.map) textures.add(maybe.map);
    }
    const shore = mesh.userData.waterShore as { texture?: THREE.Texture } | undefined;
    if (shore?.texture?.isTexture) textures.add(shore.texture);
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
