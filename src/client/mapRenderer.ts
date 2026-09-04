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
import { terrainSemanticSurfaceWeight, terrainVertexColor, type TerrainPaletteColors } from './terrainAppearance';
import { buildMapGrassField, deriveContactAwareGrassMap, grassSurfaceCoverage } from './mapGrassRenderer';
import { combinedGrassDensity } from '../shared/mapGrass';
import { foundationBoundary, foundationStepRange, foundationTopHeight, type MapFoundation } from '../shared/mapFoundation';
import {
  DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
  DEFAULT_RUNTIME_GRASS_STYLE,
  type RuntimeTerrainMaterialStyle,
  type RuntimeGrassStyle,
} from '../shared/renderPlan';
import {
  addMaterialShaderPatch,
  hasMaterialShaderPatch
} from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import type { MapPrimitiveBatchStats } from './mapPrimitiveBatching';
import type { Vec3 } from '../shared/protocol';
import { buildMapLocalLights } from './mapLocalLights';
import { isPointInsidePlayableArea } from '../shared/mapLayout';
import { isPointInsideWaterBody, riverPathSamples, waterBoundaryPoints } from '../shared/mapWater';
import { mapGuidePolyline } from '../shared/mapGuide';
import type {
  SceneVisualZone,
  TerrainSurfaceRecipe,
  VisualTimeOfDay,
  VisualZoneRegion
} from '../shared/visualDirection';
import {
  activeInteriorRugs,
  activeInteriorSurfaceFinish,
  type ProceduralRug,
  type SurfaceFinishRecipe
} from '../shared/interiorArtDirection';
import { inferPaletteRole, type ColorPalette } from '../shared/colorPalette';
import { paletteTerrainColors } from './colorPaletteRuntime';
import { PaletteMaterialRuntime, type PaletteCoverageReport } from './paletteMaterialRuntime';
import { resolveMapModelZFighting } from './modelZFighting';

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
  syncMaterialEnvironment: (
    environmentMap: THREE.Texture | null,
    waterEnvironmentMap: THREE.Texture | null
  ) => void;
  getRuntimeBatchMeshes: () => THREE.Object3D[];
  setGrassStyle: (style: RuntimeGrassStyle) => void;
  setTerrainMaterialStyle: (style: RuntimeTerrainMaterialStyle) => void;
  setColorPalette: (palette: ColorPalette | null) => PaletteCoverageReport;
  getColorPaletteCoverage: () => PaletteCoverageReport;
  setWeatherSurface: (wetness: number, snowCover: number) => void;
  setSandFlowStrength: (strength: number) => void;
  setRoomWallDisplayMode: (mode: RoomWallDisplayMode, camera: THREE.Camera) => void;
  setLightingTimeOfDay: (timeOfDay: VisualTimeOfDay) => void;
  setLightingQuality: (quality: number) => void;
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
  renderer?: THREE.WebGLRenderer;
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
  const normalizedMap = normalizeMap(input);
  // Keep the persisted map/collider data untouched; only the render snapshot gets micro-offsets.
  const zFighting = resolveMapModelZFighting(normalizedMap);
  const map = zFighting.map;
  let currentMap = map;
  const root = new THREE.Group();
  root.name = `map:${map.id}`;
  const modelsRoot = new THREE.Group();
  modelsRoot.name = 'modelsRoot';
  modelsRoot.userData.isModelRoot = true;
  modelsRoot.userData.zFightingStats = zFighting.stats;
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
  let terrainMaterialStyle = DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE;
  let colorPalette: ColorPalette | null = null;
  let terrainPalette: TerrainPaletteColors | undefined;
  const modelSnowUniforms = new Set<{ value: number }>();
  let materialElapsedSeconds = 0;
  const motionControllers: MapMotionController[] = [];
  let grass = map.sceneMode === 'indoor' ? null : buildMapGrassField(grassMap);
  if (grass) root.add(grass.group);

  const rebuildGrass = (next: EditableMap): void => {
    grassMap = deriveContactAwareGrassMap(next);
    grass?.dispose();
    grass = buildMapGrassField(grassMap, grassStyle);
    if (grass) root.add(grass.group);
    applyTerrainGrassTint(terrain, grassMap, grassStyle, terrainPalette);
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
    const roadGuides = buildRoadGuideHelpers(map);
    root.add(playerSpawnGroup, sunGroup, roadGuides.group);
    pickables.push(...roadGuides.pickables);
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
    renderer: options.renderer,
    modelsRoot,
    materialTagPolicy: map.materialTagPolicy
  });
  const paletteMaterials = new PaletteMaterialRuntime(
    instancing.runtimeIndex,
    createPalettePartResolver(map, assets)
  );
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
      instancing.updateMaterialEffects(materialElapsedSeconds, camera);
      localLights.update(camera);
    },
    restoreMaterialEffects: instancing.restoreMaterialEffects,
    syncMaterialEnvironment: instancing.syncEnvironment,
    getRuntimeBatchMeshes: instancing.getBatchMeshes,
    setGrassStyle: (style) => {
      grassStyle = style;
      grass?.setStyle(style);
      applyTerrainGrassTint(terrain, grassMap, style, terrainPalette);
    },
    setTerrainMaterialStyle: (style) => {
      terrainMaterialStyle = style;
      sandFlow.detailStrength = style.detailStrength;
      sandFlow.soilMoist = style.soilRecipe === 'moist' ? 1 : 0;
      sandFlow.sandBeach = style.sandRecipe === 'beach' ? 1 : 0;
      const material = terrain.material as THREE.MeshStandardMaterial;
      replaceTerrainTextures(material, currentMap, style, colorPalette ?? undefined);
      terrain.userData.terrainMaterialStyle = { ...style };
      syncTerrainSandShader(sandFlow);
    },
    setColorPalette: (palette) => {
      colorPalette = palette;
      terrainPalette = paletteTerrainColors(palette ?? undefined);
      const report = palette ? paletteMaterials.apply(palette) : (paletteMaterials.clear(), paletteMaterials.report());
      const material = terrain.material as THREE.MeshStandardMaterial;
      replaceTerrainTextures(material, currentMap, terrainMaterialStyle, palette ?? undefined);
      applyTerrainGrassTint(terrain, grassMap, grassStyle, terrainPalette);
      return report;
    },
    getColorPaletteCoverage: () => paletteMaterials.report(),
    setWeatherSurface: (wetness, snowCover) => {
      sandFlow.wetness = THREE.MathUtils.clamp(wetness, 0, 1);
      sandFlow.snowCover = THREE.MathUtils.clamp(snowCover, 0, 1);
      terrain.userData.weatherSurface = { wetness: sandFlow.wetness, snowCover: sandFlow.snowCover };
      syncTerrainSandShader(sandFlow);
      applyModelSnow(modelsRoot, sandFlow.snowCover, modelSnowUniforms);
    },
    setSandFlowStrength: (strength) => {
      sandFlow.strength = THREE.MathUtils.clamp(strength, 0, 1);
      syncTerrainSandShader(sandFlow);
    },
    setRoomWallDisplayMode: (mode, camera) => roomShell?.setDisplayMode(mode, camera),
    setLightingTimeOfDay: localLights.setTimeOfDay,
    setLightingQuality: localLights.setQuality,
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
      currentMap = next;
      terrain.geometry.dispose();
      terrain.geometry = buildTerrainGeometry(next);
      // Keep the live material so an applied render scheme survives the swap.
      const material = terrain.material as THREE.MeshStandardMaterial;
      replaceTerrainTextures(material, next, terrainMaterialStyle, colorPalette ?? undefined);
      updateTerrainSandZones(sandFlow, next);
      // Blades sample terrain height, so they have to follow the new surface.
      rebuildGrass(next);
    },
    dispose: () => {
      motionControllers.forEach((controller) => controller.dispose());
      paletteMaterials.clear();
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
    const finish = activeInteriorSurfaceFinish(map.interiorArtDirection, segment.surface);
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
      if (activeInteriorSurfaceFinish(map.interiorArtDirection, 'ceiling')?.recipe !== 'glass.panel') hiddenCutaway.add('ceiling');
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

function applyTerrainGrassTint(
  mesh: THREE.Mesh,
  map: EditableMap,
  style: RuntimeGrassStyle,
  palette?: TerrainPaletteColors
): void {
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
    const base = terrainVertexColor(map, x, y, z, palette);
    color.setRGB(base[0], base[1], base[2]);
    const isSurface = y >= sampleTerrainHeight(map, x, z) - 0.05;
    if (style.groundTint && isSurface) {
      const density = combinedGrassDensity(map, x, z) * grassSurfaceCoverage(map, x, z);
      const transition = density * density * (3 - 2 * density);
      color.lerp(grassColor, transition * style.groundTintStrength);
    }
    colors.setXYZ(index, color.r, color.g, color.b);
  }
  colors.needsUpdate = true;
}

function buildTerrain(map: EditableMap): THREE.Mesh {
  const geometry = buildTerrainGeometry(map);
  const textures = createTerrainTextureSet(map, DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE);
  const material = new THREE.MeshStandardMaterial({
    map: textures.map,
    roughnessMap: textures.roughnessMap,
    bumpMap: textures.bumpMap,
    bumpScale: terrainBumpScale(DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE),
    normalMap: textures.normalMap,
    normalMapType: THREE.TangentSpaceNormalMap,
    normalScale: terrainNormalScale(DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE),
    color: 0xffffff,
    roughness: 1,
    vertexColors: true,
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.surface = 'terrain';
  mesh.userData.terrainTextureChannels = ['color', 'roughness', 'bump', 'normal'];
  mesh.userData.sandFlow = installTerrainSandShader(material, map);
  return mesh;
}

interface TerrainSandFlowState {
  time: number;
  strength: number;
  zones: THREE.Vector4[];
  detailStrength: number;
  soilMoist: number;
  sandBeach: number;
  wetness: number;
  snowCover: number;
  shader: THREE.WebGLProgramParametersWithUniforms | null;
}

function installTerrainSandShader(material: THREE.MeshStandardMaterial, map: EditableMap): TerrainSandFlowState {
  const state: TerrainSandFlowState = {
    time: 0,
    strength: 0,
    zones: [],
    detailStrength: DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE.detailStrength,
    soilMoist: 0,
    sandBeach: 0,
    wetness: 0,
    snowCover: 0,
    shader: null
  };
  updateTerrainSandZones(state, map);
  material.onBeforeCompile = (shader) => {
    state.shader = shader;
    shader.uniforms.uTerrainSandTime = { value: state.time };
    shader.uniforms.uTerrainSandStrength = { value: state.strength };
    shader.uniforms.uTerrainSandZoneCount = { value: state.zones.length };
    shader.uniforms.uTerrainSandZones = { value: paddedSandZones(state.zones) };
    shader.uniforms.uTerrainDetailStrength = { value: state.detailStrength };
    shader.uniforms.uTerrainSoilMoist = { value: state.soilMoist };
    shader.uniforms.uTerrainSandBeach = { value: state.sandBeach };
    shader.uniforms.uTerrainWetness = { value: state.wetness };
    shader.uniforms.uTerrainSnowCover = { value: state.snowCover };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainSandPosition;\nvarying vec3 vTerrainWorldNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainSandPosition = position;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvTerrainWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainSandPosition;
        uniform float uTerrainSandTime;
        uniform float uTerrainSandStrength;
        uniform int uTerrainSandZoneCount;
        uniform vec4 uTerrainSandZones[8];
        uniform float uTerrainDetailStrength;
        uniform float uTerrainSoilMoist;
        uniform float uTerrainSandBeach;
        uniform float uTerrainWetness;
        uniform float uTerrainSnowCover;
        varying vec3 vTerrainWorldNormal;
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
        float terrainDetail = sin(vTerrainSandPosition.x * 9.1) * sin(vTerrainSandPosition.z * 7.7);
        diffuseColor.rgb *= 1.0 + terrainDetail * uTerrainDetailStrength * 0.018;
        float terrainWetMask = uTerrainWetness * (0.45 + terrainSandMask * 0.35);
        diffuseColor.rgb *= 1.0 - terrainWetMask * 0.24;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.88, 0.91, 0.94), uTerrainSoilMoist * uTerrainWetness * 0.12);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.86, 0.68), terrainSandMask * uTerrainSandBeach * 0.08);
        float terrainSnowSlope = smoothstep(0.42, 0.78, normalize(vTerrainWorldNormal).y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.91, 0.95, 0.98), terrainSnowSlope * uTerrainSnowCover);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.34, uTerrainWetness * 0.65);
        roughnessFactor = mix(roughnessFactor, 0.94, uTerrainSnowCover);
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
  uniforms.uTerrainDetailStrength.value = state.detailStrength;
  uniforms.uTerrainSoilMoist.value = state.soilMoist;
  uniforms.uTerrainSandBeach.value = state.sandBeach;
  uniforms.uTerrainWetness.value = state.wetness;
  uniforms.uTerrainSnowCover.value = state.snowCover;
}

const MODEL_SNOW_PATCH = 'worldforge-weather-snow';

function applyModelSnow(
  modelsRoot: THREE.Object3D,
  snowCover: number,
  uniforms: Set<{ value: number }>
): void {
  if (uniforms.size > 0) {
    uniforms.forEach((uniform) => { uniform.value = snowCover; });
    return;
  }
  if (snowCover <= 0) return;
  modelsRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      const uniform = material.userData.worldforgeSnowUniform as { value: number } | undefined
        ?? { value: snowCover };
      material.userData.worldforgeSnowUniform = uniform;
      uniform.value = snowCover;
      uniforms.add(uniform);
      if (hasMaterialShaderPatch(material, MODEL_SNOW_PATCH)) continue;
      addMaterialShaderPatch(material, MODEL_SNOW_PATCH, (shader) => {
        shader.uniforms.uWorldforgeSnowCover = uniform;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWorldforgeSnowNormal;')
          .replace(
            '#include <defaultnormal_vertex>',
            '#include <defaultnormal_vertex>\nvWorldforgeSnowNormal = inverseTransformDirection(transformedNormal, viewMatrix);'
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uWorldforgeSnowCover;\nvarying vec3 vWorldforgeSnowNormal;'
          )
          .replace(
            '#include <map_fragment>',
            '#include <map_fragment>\nfloat worldforgeSnowMask = smoothstep(0.38, 0.76, normalize(vWorldforgeSnowNormal).y) * uWorldforgeSnowCover;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 1.0), worldforgeSnowMask);'
          )
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.93, worldforgeSnowMask);'
          );
      }, { order: 80, cacheKey: () => MODEL_SNOW_PATCH });
    }
  });
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
    const visual = object.foundation
      ? buildFoundationObject(map, object)
      : asset?.modelJson
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

function buildFoundationObject(map: EditableMap, object: MapObject): THREE.Group {
  const foundation = object.foundation!;
  const group = new THREE.Group();
  group.name = `foundation:${object.id}`;
  group.userData.assetTags = ['foundation', foundation.material, foundation.shape];
  if (foundation.shape === 'path') {
    const geometry = buildPathFoundationGeometry(map, object, foundation);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, foundationMaterial(foundation));
      mesh.name = `foundation-mesh:${object.id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
  const boundary = foundationBoundary(foundation);
  if (boundary.length < 3) return group;
  const scaleX = object.transform.scale[0] * object.transform.size[0];
  const scaleY = object.transform.scale[1] * object.transform.size[1];
  const scaleZ = object.transform.scale[2] * object.transform.size[2];
  const yaw = object.transform.rotation[1];
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const top = boundary.map(([x, z]): [number, number, number] => [x, foundationTopHeight(foundation, x, z), z]);
  const bottomAt = (x: number, y: number, z: number): [number, number, number] => {
    const scaledX = x * scaleX;
    const scaledZ = z * scaleZ;
    const worldX = object.transform.position[0] + scaledX * cos + scaledZ * sin;
    const worldZ = object.transform.position[2] - scaledX * sin + scaledZ * cos;
    const terrainY = sampleTerrainHeight(map, worldX, worldZ);
    const localTerrainY = (terrainY - object.transform.position[1]) / Math.max(0.001, scaleY);
    return [x, Math.max(y - foundation.maxThickness, Math.min(y - foundation.thickness, localTerrainY)), z];
  };
  const bottom = top.map(([x, y, z]) => bottomAt(x, y, z));
  const vertices: number[] = [...top, ...bottom].flat();
  const indices: number[] = [];
  const triangles = THREE.ShapeUtils.triangulateShape(
    boundary.map(([x, z]) => new THREE.Vector2(x, z)),
    []
  );
  for (const [a, b, c] of triangles) {
    if (foundation.top !== 'steps') indices.push(a, c, b);
    indices.push(boundary.length + a, boundary.length + b, boundary.length + c);
  }
  if (foundation.top === 'steps') {
    appendSteppedFoundationTop(vertices, indices, boundary, triangles, foundation);
    appendSteppedFoundationWalls(vertices, indices, boundary, foundation, bottomAt);
  } else {
    for (let index = 0; index < boundary.length; index += 1) {
      const next = (index + 1) % boundary.length;
      indices.push(index, next, boundary.length + index, next, boundary.length + next, boundary.length + index);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = foundationMaterial(foundation);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `foundation-mesh:${object.id}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function buildPathFoundationGeometry(
  map: EditableMap,
  object: MapObject,
  foundation: MapFoundation
): THREE.BufferGeometry | null {
  const boundary = foundationBoundary(foundation);
  const count = Math.floor(boundary.length / 2);
  if (count < 2) return null;
  const left = boundary.slice(0, count);
  const right = boundary.slice(count).reverse();
  const scaleX = object.transform.scale[0] * object.transform.size[0];
  const scaleY = object.transform.scale[1] * object.transform.size[1];
  const scaleZ = object.transform.scale[2] * object.transform.size[2];
  const yaw = object.transform.rotation[1];
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const vertices: number[] = [];
  const indices: number[] = [];
  const bottomAt = (point: [number, number], y: number): [number, number, number] => {
    const scaledX = point[0] * scaleX;
    const scaledZ = point[1] * scaleZ;
    const worldX = object.transform.position[0] + scaledX * cos + scaledZ * sin;
    const worldZ = object.transform.position[2] - scaledX * sin + scaledZ * cos;
    const terrainY = sampleTerrainHeight(map, worldX, worldZ);
    const localTerrainY = (terrainY - object.transform.position[1]) / Math.max(0.001, scaleY);
    return [point[0], Math.max(y - foundation.maxThickness, Math.min(y - foundation.thickness, localTerrainY)), point[1]];
  };
  const segmentCount = foundation.closed ? count : count - 1;
  const [stepMin, stepMax] = foundationStepRange(foundation);
  const stepSpan = (stepMax - stepMin) / Math.max(1, foundation.stepCount);
  for (let index = 0; index < segmentCount; index += 1) {
    const next = (index + 1) % count;
    const startLeft = left[index];
    const startRight = right[index];
    const endLeft = left[next];
    const endRight = right[next];
    const cuts = [0, 1];
    if (foundation.top === 'steps' && stepSpan > 0.001) {
      const startCenter: [number, number] = [(startLeft[0] + startRight[0]) / 2, (startLeft[1] + startRight[1]) / 2];
      const endCenter: [number, number] = [(endLeft[0] + endRight[0]) / 2, (endLeft[1] + endRight[1]) / 2];
      const startProjection = startCenter[0] * Math.sin(foundation.slopeDirection) + startCenter[1] * Math.cos(foundation.slopeDirection);
      const endProjection = endCenter[0] * Math.sin(foundation.slopeDirection) + endCenter[1] * Math.cos(foundation.slopeDirection);
      for (let step = 1; step < foundation.stepCount; step += 1) {
        const threshold = stepMin + stepSpan * step;
        const t = (threshold - startProjection) / (endProjection - startProjection);
        if (t > 0.001 && t < 0.999) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    for (let part = 0; part < cuts.length - 1; part += 1) {
      const from = cuts[part];
      const to = cuts[part + 1];
      const la = lerpFoundationPoint(startLeft, endLeft, from);
      const ra = lerpFoundationPoint(startRight, endRight, from);
      const lb = lerpFoundationPoint(startLeft, endLeft, to);
      const rb = lerpFoundationPoint(startRight, endRight, to);
      const center: [number, number] = [(la[0] + ra[0] + lb[0] + rb[0]) / 4, (la[1] + ra[1] + lb[1] + rb[1]) / 4];
      const stepY = foundation.top === 'steps' ? foundationTopHeight(foundation, center[0], center[1]) : null;
      const topLa = [la[0], stepY ?? foundationTopHeight(foundation, la[0], la[1]), la[1]] as [number, number, number];
      const topRa = [ra[0], stepY ?? foundationTopHeight(foundation, ra[0], ra[1]), ra[1]] as [number, number, number];
      const topLb = [lb[0], stepY ?? foundationTopHeight(foundation, lb[0], lb[1]), lb[1]] as [number, number, number];
      const topRb = [rb[0], stepY ?? foundationTopHeight(foundation, rb[0], rb[1]), rb[1]] as [number, number, number];
      const bottomLa = bottomAt(la, topLa[1]);
      const bottomRa = bottomAt(ra, topRa[1]);
      const bottomLb = bottomAt(lb, topLb[1]);
      const bottomRb = bottomAt(rb, topRb[1]);
      appendFoundationFace(vertices, indices, [topLa, topRa, topRb, topLb], true);
      appendFoundationFace(vertices, indices, [bottomLa, bottomLb, bottomRb, bottomRa], false);
      appendFoundationFace(vertices, indices, [topLa, topLb, bottomLb, bottomLa], false);
      appendFoundationFace(vertices, indices, [topRa, bottomRa, bottomRb, topRb], false);
      const isOpenStart = !foundation.closed && index === 0 && part === 0;
      const isOpenEnd = !foundation.closed && index === segmentCount - 1 && part === cuts.length - 2;
      if (foundation.top === 'steps' || isOpenStart || isOpenEnd) {
        appendFoundationFace(vertices, indices, [topLa, bottomLa, bottomRa, topRa], false);
        appendFoundationFace(vertices, indices, [topLb, topRb, bottomRb, bottomLb], false);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function appendFoundationFace(
  vertices: number[],
  indices: number[],
  points: Array<[number, number, number]>,
  upward: boolean
): void {
  const offset = vertices.length / 3;
  vertices.push(...points.flat());
  const a = new THREE.Vector3(...points[0]);
  const b = new THREE.Vector3(...points[1]);
  const c = new THREE.Vector3(...points[2]);
  const normalY = b.clone().sub(a).cross(c.clone().sub(a)).y;
  const forward = normalY >= 0;
  const reverse = upward ? !forward : forward;
  indices.push(...(reverse
    ? [offset, offset + 2, offset + 1, offset, offset + 3, offset + 2]
    : [offset, offset + 1, offset + 2, offset, offset + 2, offset + 3]));
}

function lerpFoundationPoint(
  start: [number, number],
  end: [number, number],
  t: number
): [number, number] {
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function appendSteppedFoundationTop(
  vertices: number[],
  indices: number[],
  boundary: Array<[number, number]>,
  triangles: number[][],
  foundation: MapFoundation
): void {
  const [min, max] = foundationStepRange(foundation);
  const sin = Math.sin(foundation.slopeDirection);
  const cos = Math.cos(foundation.slopeDirection);
  const bandSize = (max - min) / foundation.stepCount;
  for (let step = 0; step < foundation.stepCount; step += 1) {
    const bandMin = min + bandSize * step;
    const bandMax = step === foundation.stepCount - 1 ? max + 1e-6 : bandMin + bandSize;
    const height = step * foundation.stepHeight;
    for (const triangle of triangles) {
      let polygon = triangle.map((index) => boundary[index]);
      polygon = clipFoundationPolygon(polygon, sin, cos, bandMin, true);
      polygon = clipFoundationPolygon(polygon, sin, cos, bandMax, false);
      if (polygon.length < 3) continue;
      const area = polygon.reduce((sum, point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0);
      if (Math.abs(area) < 1e-8) continue;
      const start = vertices.length / 3;
      for (const [x, z] of polygon) vertices.push(x, height, z);
      for (let index = 1; index < polygon.length - 1; index += 1) {
        if (area > 0) indices.push(start, start + index + 1, start + index);
        else indices.push(start, start + index, start + index + 1);
      }
    }
  }
}

function appendSteppedFoundationWalls(
  vertices: number[],
  indices: number[],
  boundary: Array<[number, number]>,
  foundation: MapFoundation,
  bottomAt: (x: number, y: number, z: number) => [number, number, number]
): void {
  const [min, max] = foundationStepRange(foundation);
  const sin = Math.sin(foundation.slopeDirection);
  const cos = Math.cos(foundation.slopeDirection);
  const bandSize = (max - min) / foundation.stepCount;
  for (let edge = 0; edge < boundary.length; edge += 1) {
    const start = boundary[edge];
    const end = boundary[(edge + 1) % boundary.length];
    for (let step = 0; step < foundation.stepCount; step += 1) {
      const clipped = clipFoundationSegment(
        start, end, sin, cos,
        min + bandSize * step,
        step === foundation.stepCount - 1 ? max + 1e-6 : min + bandSize * (step + 1)
      );
      if (!clipped) continue;
      const height = step * foundation.stepHeight;
      const bottomStart = bottomAt(clipped[0][0], height, clipped[0][1]);
      const bottomEnd = bottomAt(clipped[1][0], height, clipped[1][1]);
      const offset = vertices.length / 3;
      vertices.push(
        clipped[0][0], height, clipped[0][1],
        clipped[1][0], height, clipped[1][1],
        ...bottomStart, ...bottomEnd
      );
      indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
    }
  }
  for (let step = 1; step < foundation.stepCount; step += 1) {
    const threshold = min + bandSize * step;
    const crossings: Array<{ point: [number, number]; tangent: number }> = [];
    for (let edge = 0; edge < boundary.length; edge += 1) {
      const start = boundary[edge];
      const end = boundary[(edge + 1) % boundary.length];
      const startProjection = start[0] * sin + start[1] * cos;
      const endProjection = end[0] * sin + end[1] * cos;
      if (!((startProjection < threshold && endProjection >= threshold)
        || (endProjection < threshold && startProjection >= threshold))) continue;
      const t = (threshold - startProjection) / (endProjection - startProjection);
      const point: [number, number] = [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t
      ];
      crossings.push({ point, tangent: point[0] * cos - point[1] * sin });
    }
    crossings.sort((a, b) => a.tangent - b.tangent);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const low = (step - 1) * foundation.stepHeight;
      const high = step * foundation.stepHeight;
      const a = crossings[index].point;
      const b = crossings[index + 1].point;
      const offset = vertices.length / 3;
      vertices.push(a[0], low, a[1], a[0], high, a[1], b[0], high, b[1], b[0], low, b[1]);
      indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    }
  }
}

function clipFoundationPolygon(
  polygon: Array<[number, number]>,
  sin: number,
  cos: number,
  threshold: number,
  keepAbove: boolean
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const startDistance = start[0] * sin + start[1] * cos - threshold;
    const endDistance = end[0] * sin + end[1] * cos - threshold;
    const startInside = keepAbove ? startDistance >= -1e-8 : startDistance <= 1e-8;
    const endInside = keepAbove ? endDistance >= -1e-8 : endDistance <= 1e-8;
    if (startInside) result.push(start);
    if (startInside === endInside) continue;
    const t = startDistance / (startDistance - endDistance);
    result.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
  }
  return result;
}

function clipFoundationSegment(
  start: [number, number],
  end: [number, number],
  sin: number,
  cos: number,
  min: number,
  max: number
): [[number, number], [number, number]] | null {
  const startProjection = start[0] * sin + start[1] * cos;
  const endProjection = end[0] * sin + end[1] * cos;
  const delta = endProjection - startProjection;
  if (Math.abs(delta) < 1e-8) return startProjection >= min && startProjection <= max ? [start, end] : null;
  const first = (min - startProjection) / delta;
  const second = (max - startProjection) / delta;
  const from = Math.max(0, Math.min(first, second));
  const to = Math.min(1, Math.max(first, second));
  if (to - from < 1e-8) return null;
  return [
    [start[0] + (end[0] - start[0]) * from, start[1] + (end[1] - start[1]) * from],
    [start[0] + (end[0] - start[0]) * to, start[1] + (end[1] - start[1]) * to]
  ];
}

function foundationMaterial(foundation: MapFoundation): THREE.MeshStandardMaterial {
  const key = foundation.material.toLowerCase();
  const color = /stone|rock|石/.test(key) ? 0x7f8179
    : /brick|砖/.test(key) ? 0x9b6048
      : /earth|soil|土/.test(key) ? 0x796247
        : /wood|timber|木/.test(key) ? 0x8a6844
          : 0x8c9390;
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.02, flatShading: false });
}

function createPalettePartResolver(
  map: EditableMap,
  assets: Map<string, MapAsset>
): (partId: string) => {
  role: ReturnType<typeof inferPaletteRole>;
  variantKey: string;
  assetId?: string;
  assetTags?: string[];
  technical?: boolean;
} | null {
  const objectContexts = new Map<string, {
    asset: MapAsset;
    assetTags: string[];
    building: boolean;
    variantKey: string;
    nodeText: Map<string, { text: string; sourceColor?: string }>;
  }>();
  const byAsset = new Map<string, MapObject[]>();
  for (const object of map.objects) {
    if (!object.assetId) continue;
    const siblings = byAsset.get(object.assetId) ?? [];
    siblings.push(object);
    byAsset.set(object.assetId, siblings);
  }
  for (const [assetId, objects] of byAsset) {
    const asset = assets.get(assetId);
    if (!asset) continue;
    const assetTags = deriveAssetTags(asset);
    const building = assetTags.includes('building');
    const nodeText = paletteNodeText(asset.modelJson);
    const variantCount = Math.min(4, Math.max(2, objects.length));
    objects.forEach((object, index) => objectContexts.set(object.id, {
      asset,
      assetTags,
      building,
      variantKey: `${asset.id}:v${index % variantCount}`,
      nodeText
    }));
  }
  const objectIds = [...objectContexts.keys()].sort((a, b) => b.length - a.length);
  return (partId) => {
    const objectId = objectIds.find((id) => partId.startsWith(`${id}:`));
    if (!objectId) return null;
    const context = objectContexts.get(objectId)!;
    const nodeId = partId.slice(objectId.length + 1);
    const node = context.nodeText.get(nodeId);
    const text = [
      nodeId,
      node?.text,
      context.asset.name,
      context.asset.prompt,
      context.assetTags.join(' ')
    ].filter(Boolean).join(' ');
    return {
      role: inferPaletteRole(text, context.building),
      variantKey: context.variantKey,
      sourceColor: node?.sourceColor,
      assetId: context.asset.id,
      assetTags: context.assetTags
    };
  };
}

function paletteNodeText(modelJson: unknown): Map<string, { text: string; sourceColor?: string }> {
  if (!modelJson || typeof modelJson !== 'object') return new Map();
  const nodes = (modelJson as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return new Map();
  return new Map(nodes.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const node = entry as { id?: unknown; tags?: unknown; color?: unknown; mesh?: { color?: unknown; material?: { color?: unknown } } };
    if (typeof node.id !== 'string') return [];
    const tags = Array.isArray(node.tags) ? node.tags.map((tag) => {
      if (typeof tag === 'string') return tag;
      if (!tag || typeof tag !== 'object') return '';
      const item = tag as { tag?: unknown; value?: unknown };
      return `${String(item.tag ?? '')} ${String(item.value ?? '')}`;
    }).join(' ') : '';
    return [[node.id, {
      text: `${node.id} ${tags}`,
      sourceColor: paletteTagColor(node.tags)
        ?? paletteSourceHex(node.mesh?.material?.color)
        ?? paletteSourceHex(node.mesh?.color)
        ?? paletteSourceHex(node.color)
    }] as [string, { text: string; sourceColor?: string }]];
  }));
}

function paletteSourceHex(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${Math.max(0, Math.min(0xffffff, Math.round(value))).toString(16).padStart(6, '0')}`.toUpperCase();
  }
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;
}

function paletteTagColor(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const tag = tags.find((entry) => entry && typeof entry === 'object' && (entry as { tag?: unknown }).tag === 'palette-color');
  return paletteSourceHex(tag && typeof tag === 'object' ? (tag as { value?: unknown }).value : undefined);
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

function buildRoadGuideHelpers(map: EditableMap): { group: THREE.Group; pickables: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.name = 'road-guide-helpers';
  const pickables: THREE.Object3D[] = [];
  for (const guide of map.guides.filter((item) => item.tags.includes('route') || item.tags.includes('street'))) {
    const path = mapGuidePolyline(guide).map(([x, z]) => new THREE.Vector3(
      x, sampleTerrainHeight(map, x, z) + 0.08, z
    ));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(path),
      new THREE.LineBasicMaterial({ color: 0xd9f47a, transparent: true, opacity: 0.72, depthTest: false })
    );
    line.name = `road-guide:${guide.id}`;
    line.renderOrder = 42;
    line.userData.editorHelper = true;
    group.add(line);
    guide.points.forEach(([x, z], index) => {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.14, Math.min(0.32, guide.width * 0.08)), 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xf5ffb8, depthTest: false })
      );
      node.position.set(x, sampleTerrainHeight(map, x, z) + 0.12, z);
      node.renderOrder = 43;
      node.userData.editorHelper = true;
      node.userData.mapGuideId = guide.id;
      node.userData.mapGuidePointIndex = index;
      group.add(node);
      pickables.push(node);
    });
  }
  return { group, pickables };
}

interface TerrainTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

const TERRAIN_TEXTURE_SIZE = 1536;
const SURFACE_TEXTURE_SIZE = 768;
type TerrainTextureChannel = 'roughness' | 'bump';
type TerrainRecipeDetailChannel = 'color' | TerrainTextureChannel;
type TerrainDetailSurface = 'grass' | 'soil' | 'sand' | 'rocky' | 'paving';

function createTerrainTextureSet(
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  palette?: ColorPalette
): TerrainTextureSet {
  const bumpMap = createTerrainPropertyTexture(map, style, 'bump');
  return {
    map: createSurfaceTexture(map, 'terrain', undefined, style, palette),
    roughnessMap: createTerrainPropertyTexture(map, style, 'roughness'),
    bumpMap,
    normalMap: createTerrainNormalTexture(bumpMap, style)
  };
}

function replaceTerrainTextures(
  material: THREE.MeshStandardMaterial,
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  palette?: ColorPalette
): void {
  const previous = [material.map, material.roughnessMap, material.bumpMap, material.normalMap];
  const textures = createTerrainTextureSet(map, style, palette);
  material.map = textures.map;
  material.roughnessMap = textures.roughnessMap;
  material.bumpMap = textures.bumpMap;
  material.normalMap = textures.normalMap;
  material.normalMapType = THREE.TangentSpaceNormalMap;
  material.normalScale.copy(terrainNormalScale(style));
  material.roughness = 1;
  material.bumpScale = terrainBumpScale(style);
  material.needsUpdate = true;
  previous.forEach((texture) => texture?.dispose());
}

function terrainBumpScale(style: RuntimeTerrainMaterialStyle): number {
  return 0.065 + style.detailStrength * 0.095;
}

function terrainNormalScale(style: RuntimeTerrainMaterialStyle): THREE.Vector2 {
  const strength = 1.1 + style.detailStrength * 1.4;
  return new THREE.Vector2(strength, strength);
}

export function terrainNormalPixelsFromHeight(
  heightPixels: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(width * height * 4);
  const sample = (x: number, y: number): number => {
    const safeX = Math.max(0, Math.min(width - 1, x));
    const safeY = Math.max(0, Math.min(height - 1, y));
    return heightPixels[(safeY * width + safeX) * 4] / 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (sample(x - 1, y) - sample(x + 1, y)) * strength;
      const dy = (sample(x, y - 1) - sample(x, y + 1)) * strength;
      const inverseLength = 1 / Math.hypot(dx, dy, 1);
      const offset = (y * width + x) * 4;
      output[offset] = Math.round((dx * inverseLength * 0.5 + 0.5) * 255);
      output[offset + 1] = Math.round((dy * inverseLength * 0.5 + 0.5) * 255);
      output[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      output[offset + 3] = 255;
    }
  }
  return output;
}

function createTerrainNormalTexture(
  bumpMap: THREE.CanvasTexture,
  style: RuntimeTerrainMaterialStyle
): THREE.CanvasTexture {
  const source = bumpMap.image as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = 'rgb(128, 128, 255)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const sourceImage = sourceContext?.getImageData(0, 0, canvas.width, canvas.height);
    const normalImage = context.createImageData?.(canvas.width, canvas.height);
    if (sourceImage?.data && normalImage?.data) {
      normalImage.data.set(terrainNormalPixelsFromHeight(
        sourceImage.data,
        canvas.width,
        canvas.height,
        4 + style.detailStrength * 4
      ));
      context.putImageData(normalImage, 0, 0);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function createTerrainPropertyTexture(
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  channel: TerrainTextureChannel
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TERRAIN_TEXTURE_SIZE;
  canvas.height = TERRAIN_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = channel === 'roughness' ? '#eeeeee' : '#808080';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawTerrainMaterialZones(ctx, map, style, channel, canvas.width, canvas.height);
    drawProceduralTerrainPropertyDetail(ctx, map, style, channel, canvas.width, canvas.height);
    drawTerrainRecipeDetails(ctx, map, canvas.width, canvas.height, channel);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function createSurfaceTexture(
  map: EditableMap,
  surface: MapSurface,
  segment?: RoomShellSegment,
  terrainStyle: RuntimeTerrainMaterialStyle = DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
  palette?: ColorPalette
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const textureSize = surface === 'terrain' ? TERRAIN_TEXTURE_SIZE : SURFACE_TEXTURE_SIZE;
  canvas.width = textureSize;
  canvas.height = textureSize;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Vertex colors own the terrain palette; a neutral base keeps paint strokes
    // and the editor grid from multiplying the surface darker.
    ctx.fillStyle = surface === 'terrain' ? '#ffffff' : map.box.colors[surface as keyof typeof map.box.colors];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (surface === 'terrain') {
      drawSemanticTerrainSurface(ctx, map, canvas.width, canvas.height);
      drawProceduralTerrainDetail(ctx, map, terrainStyle, canvas.width, canvas.height);
      drawTerrainRecipeDetails(ctx, map, canvas.width, canvas.height, 'color');
    }
    const finish = surface !== 'terrain'
      ? activeInteriorSurfaceFinish(map.interiorArtDirection, surface as RoomSurface)
      : undefined;
    if (finish) drawSurfaceFinish(ctx, finish, surfaceDimensions(map, surface as RoomSurface), canvas.width, canvas.height);
    drawSubtleGrid(ctx, canvas.width, canvas.height);
    for (const stroke of map.paintStrokes) {
      if (stroke.surface !== surface && !(surface === 'terrain' && stroke.surface === 'floor')) continue;
      drawStroke(ctx, stroke, canvas.width, canvas.height);
    }
    if (palette) quantizeCanvasToPalette(ctx, canvas.width, canvas.height, palette);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  if (surface === 'terrain') texture.anisotropy = 8;
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

function quantizeCanvasToPalette(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ColorPalette
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const colors = palette.colors.map((entry) => {
    const value = Number.parseInt(entry.hex.slice(1), 16);
    return [value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff] as const;
  });
  const cache = new Map<number, readonly [number, number, number]>();
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] === 0) continue;
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    const key = (red >> 3) << 10 | (green >> 3) << 5 | blue >> 3;
    let nearest = cache.get(key);
    if (!nearest) {
      nearest = colors.reduce((best, candidate) => (
        colorDistanceSq(red, green, blue, candidate) < colorDistanceSq(red, green, blue, best)
          ? candidate
          : best
      ), colors[0]);
      cache.set(key, nearest);
    }
    image.data[index] = nearest[0];
    image.data[index + 1] = nearest[1];
    image.data[index + 2] = nearest[2];
    image.data[index + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function colorDistanceSq(
  red: number,
  green: number,
  blue: number,
  candidate: readonly [number, number, number]
): number {
  return (red - candidate[0]) ** 2 * 0.3
    + (green - candidate[1]) ** 2 * 0.59
    + (blue - candidate[2]) ** 2 * 0.11;
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
  const rugs = activeInteriorRugs(map.interiorArtDirection);
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
  soil: '#9d7955',
  paving: '#b8b2a6',
  settlement: '#d7c5a6',
  rocky: '#c3c0b2'
} as const;

const TERRAIN_RECIPE_COLORS = {
  'compacted-earth': '#916a43',
  'garden-stone': '#aaa69a',
  asphalt: '#555b5e',
  concrete: '#9d9a91',
  'brick-paver': '#b45738',
  cobblestone: '#85847f',
  gravel: '#847867',
  mud: '#654832'
} as const satisfies Record<Exclude<TerrainSurfaceRecipe, 'default'>, string>;

const TERRAIN_RECIPE_CHANNEL_COLORS = {
  'compacted-earth': { roughness: '#d8d8d8', bump: '#858585' },
  'garden-stone': { roughness: '#d2d2d2', bump: '#888888' },
  asphalt: { roughness: '#9a9a9a', bump: '#7b7b7b' },
  concrete: { roughness: '#d0d0d0', bump: '#8d8d8d' },
  'brick-paver': { roughness: '#d0d0d0', bump: '#909090' },
  cobblestone: { roughness: '#dedede', bump: '#9c9c9c' },
  gravel: { roughness: '#e5e5e5', bump: '#a4a4a4' },
  mud: { roughness: '#a8a8a8', bump: '#8d8d8d' }
} as const satisfies Record<Exclude<TerrainSurfaceRecipe, 'default'>, { roughness: string; bump: string }>;

const TERRAIN_ROUGHNESS_COLORS: Record<TerrainDetailSurface, string> = {
  grass: '#f0f0f0',
  soil: '#dddddd',
  sand: '#f5f5f5',
  rocky: '#cecece',
  paving: '#bdbdbd'
};

const TERRAIN_BUMP_COLORS: Record<TerrainDetailSurface, string> = {
  grass: '#858585',
  soil: '#8d8d8d',
  sand: '#878787',
  rocky: '#969696',
  paving: '#838383'
};

function drawSemanticTerrainSurface(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  width: number,
  height: number
): void {
  for (const zone of map.visualSemantics.zones) {
    const tag = [...zone.tags].reverse().find((item): item is keyof typeof SEMANTIC_SURFACE_COLORS => (
      item in SEMANTIC_SURFACE_COLORS
    ));
    if (!tag) continue;
    const recipeColor = zone.material && zone.material !== 'default'
      ? TERRAIN_RECIPE_COLORS[zone.material]
      : undefined;
    const opacity = recipeColor
      ? Math.min(0.88, 0.62 + zone.intensity * 0.22)
      : Math.min(0.24, 0.08 + zone.intensity * 0.12);
    drawSemanticZoneShape(ctx, map, zone, recipeColor ?? SEMANTIC_SURFACE_COLORS[tag], opacity, width, height);
  }
  for (const water of map.waterBodies) drawWetShore(ctx, map, water, width, height);
}

function drawTerrainMaterialZones(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  channel: TerrainTextureChannel,
  width: number,
  height: number
): void {
  for (const zone of map.visualSemantics.zones) {
    const tag = [...zone.tags].reverse().find((item): item is TerrainDetailSurface => (
      ['grass', 'soil', 'sand', 'rocky', 'paving'].includes(item)
    ));
    if (!tag) continue;
    const colors = channel === 'roughness' ? TERRAIN_ROUGHNESS_COLORS : TERRAIN_BUMP_COLORS;
    const recipe = zone.material && zone.material !== 'default'
      ? TERRAIN_RECIPE_CHANNEL_COLORS[zone.material]
      : undefined;
    const recipeColor = recipe?.[channel === 'roughness' ? 'roughness' : 'bump'];
    const color = recipeColor ?? (tag === 'soil' && channel === 'roughness' && style.soilRecipe === 'moist'
      ? '#aaaaaa'
      : colors[tag]);
    drawSemanticZoneShape(
      ctx,
      map,
      zone,
      color,
      Math.min(0.92, 0.56 + zone.intensity * 0.34),
      width,
      height
    );
  }
}

function drawTerrainRecipeDetails(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  width: number,
  height: number,
  channel: TerrainRecipeDetailChannel
): void {
  for (const zone of map.visualSemantics.zones) {
    if (!zone.material || zone.material === 'default' || zone.region?.kind !== 'path') continue;
    const region = zone.region;
    const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
    const random = seededRandom(map.seed ^ stringSeed(zone.id));
    if (zone.material === 'garden-stone') {
      forEachPathSample(region.points, Math.max(0.75, region.width * 0.62), (sample) => {
        const center = surfaceCanvasPoint(map, [sample.x, sample.z], width, height);
        const halfWidth = region.width * pixelsPerMetre * (0.32 + random() * 0.08);
        const halfLength = Math.max(3, region.width * pixelsPerMetre * (0.2 + random() * 0.08));
        const tangent = [sample.tangentX, -sample.tangentZ] as const;
        const normal = [-tangent[1], tangent[0]] as const;
        const corners = [
          [center[0] - tangent[0] * halfLength - normal[0] * halfWidth, center[1] - tangent[1] * halfLength - normal[1] * halfWidth],
          [center[0] + tangent[0] * halfLength - normal[0] * halfWidth, center[1] + tangent[1] * halfLength - normal[1] * halfWidth],
          [center[0] + tangent[0] * halfLength + normal[0] * halfWidth, center[1] + tangent[1] * halfLength + normal[1] * halfWidth],
          [center[0] - tangent[0] * halfLength + normal[0] * halfWidth, center[1] - tangent[1] * halfLength + normal[1] * halfWidth]
        ];
        ctx.beginPath();
        ctx.moveTo(corners[0][0], corners[0][1]);
        corners.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
        ctx.closePath();
        ctx.fillStyle = random() > 0.5
          ? terrainRecipeDetailInk(channel, 'rgba(224, 218, 199, 0.58)', '#dedede', '#c4c4c4')
          : terrainRecipeDetailInk(channel, 'rgba(103, 101, 95, 0.34)', '#b3b3b3', '#9a9a9a');
        ctx.fill();
        ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(62, 61, 58, 0.48)', '#969696', '#555555');
        ctx.lineWidth = Math.max(1, pixelsPerMetre * 0.065);
        ctx.stroke();
      });
      continue;
    }
    if (zone.material === 'concrete') {
      drawCutStoneSidewalkDetails(ctx, map, region, width, height, channel, random);
      continue;
    }
    if (zone.material === 'brick-paver') {
      drawBrickPaverDetails(ctx, map, region, width, height, channel, random);
      continue;
    }
    if (zone.material === 'cobblestone' || zone.material === 'gravel') {
      const cobbled = zone.material === 'cobblestone';
      const spacing = cobbled ? Math.max(0.32, region.width * 0.14) : Math.max(0.2, region.width * 0.09);
      forEachPathSample(region.points, spacing, (sample) => {
        const lanes = Math.max(2, Math.floor(region.width / (cobbled ? 0.42 : 0.28)));
        for (let lane = 0; lane < lanes; lane += 1) {
          const across = ((lane + random()) / lanes - 0.5) * region.width * 0.88;
          const point = surfaceCanvasPoint(map, [
            sample.x - sample.tangentZ * across,
            sample.z + sample.tangentX * across
          ], width, height);
          const radius = pixelsPerMetre * (cobbled ? 0.14 + random() * 0.07 : 0.035 + random() * 0.06);
          ctx.beginPath();
          ctx.ellipse(point[0], point[1], radius * 1.2, radius, random() * Math.PI, 0, Math.PI * 2);
          ctx.fillStyle = cobbled
            ? terrainRecipeDetailInk(channel, 'rgba(48, 52, 53, 0.4)', '#d7d7d7', '#c9c9c9')
            : terrainRecipeDetailInk(channel, 'rgba(55, 43, 32, 0.38)', '#dddddd', '#bababa');
          ctx.fill();
          if (cobbled) {
            ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(31, 33, 34, 0.28)', '#a7a7a7', '#5a5a5a');
            ctx.lineWidth = Math.max(0.55, pixelsPerMetre * 0.035);
            ctx.stroke();
          }
        }
      });
      continue;
    }
    if (zone.material === 'mud') {
      ctx.save();
      for (const offset of [-0.23, 0.23]) {
        const track = region.points.map((point, index) => {
          const previous = region.points[Math.max(0, index - 1)];
          const next = region.points[Math.min(region.points.length - 1, index + 1)];
          const dx = next[0] - previous[0];
          const dz = next[1] - previous[1];
          const length = Math.max(0.0001, Math.hypot(dx, dz));
          return [point[0] - dz / length * region.width * offset, point[1] + dx / length * region.width * offset] as [number, number];
        });
        drawCanvasPath(ctx, map, track, width, height);
        ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(42, 25, 16, 0.48)', '#858585', '#505050');
        ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.13);
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }
    ctx.save();
    drawCanvasPath(ctx, map, region.points, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (zone.material === 'asphalt') {
      ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(104, 108, 108, 0.16)', '#ababab', '#898989');
      ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.82);
      ctx.stroke();
      drawCanvasPath(ctx, map, region.points, width, height);
      ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(31, 34, 35, 0.34)', '#919191', '#737373');
      ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.72);
      ctx.stroke();
      drawAsphaltRoadDetails(ctx, map, region, width, height, channel, random);
    } else {
      ctx.setLineDash([Math.max(2, pixelsPerMetre * 0.35), Math.max(3, pixelsPerMetre * 0.7)]);
      ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(71, 46, 27, 0.36)', '#b0b0b0', '#656565');
      ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.28);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawBrickPaverDetails(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  region: { points: readonly [number, number][]; width: number },
  width: number,
  height: number,
  channel: TerrainRecipeDetailChannel,
  random: () => number
): void {
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  const brickLength = 0.9;
  const lanes = Math.max(2, Math.round(region.width / 0.42));
  const rowWidth = region.width / lanes;

  ctx.save();
  drawCanvasPath(ctx, map, region.points, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(182, 175, 159, 0.72)', '#d7d7d7', '#8d8d8d');
  ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.98);
  ctx.stroke();
  drawCanvasPath(ctx, map, region.points, width, height);
  ctx.strokeStyle = terrainRecipeDetailInk(channel, '#b45738', '#d0d0d0', '#909090');
  ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre * 0.86);
  ctx.stroke();
  ctx.restore();

  forEachPathSample(region.points, brickLength, (sample) => {
    const center = surfaceCanvasPoint(map, [sample.x, sample.z], width, height);
    const angle = Math.atan2(-sample.tangentZ, sample.tangentX);
    for (let lane = 0; lane < lanes; lane += 1) {
      const across = (lane + 0.5) / lanes - 0.5;
      const stagger = lane % 2 === 0 ? 0 : brickLength * 0.5;
      const brickWidth = brickLength * pixelsPerMetre * (0.9 + random() * 0.04);
      const brickHeight = Math.min(rowWidth * 0.78, brickLength * 0.45) * pixelsPerMetre;
      ctx.save();
      ctx.translate(
        center[0] + sample.tangentX * stagger * pixelsPerMetre
          - sample.tangentZ * across * region.width * pixelsPerMetre,
        center[1] - sample.tangentZ * stagger * pixelsPerMetre
          - sample.tangentX * across * region.width * pixelsPerMetre
      );
      ctx.rotate(angle);
      ctx.fillStyle = random() > 0.5
        ? terrainRecipeDetailInk(channel, '#aa472f', '#cccccc', '#969696')
        : terrainRecipeDetailInk(channel, '#c96948', '#d5d5d5', '#999999');
      ctx.fillRect(-brickWidth / 2, -brickHeight / 2, brickWidth, brickHeight);
      ctx.strokeStyle = terrainRecipeDetailInk(channel, '#773323', '#c0c0c0', '#858585');
      ctx.lineWidth = Math.max(0.55, pixelsPerMetre * 0.025);
      ctx.strokeRect(-brickWidth / 2, -brickHeight / 2, brickWidth, brickHeight);
      ctx.restore();
    }
  });
}

function drawCutStoneSidewalkDetails(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  region: { points: readonly [number, number][]; width: number },
  width: number,
  height: number,
  channel: TerrainRecipeDetailChannel,
  random: () => number
): void {
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  const lanes = Math.max(2, Math.round(region.width / 0.65));
  const slabLength = pixelsPerMetre * 0.9;
  const slabWidth = region.width * pixelsPerMetre / lanes;
  forEachPathSample(region.points, 0.9, (sample) => {
    const center = surfaceCanvasPoint(map, [sample.x, sample.z], width, height);
    const angle = Math.atan2(-sample.tangentZ, sample.tangentX);
    for (let lane = 0; lane < lanes; lane += 1) {
      const across = (lane + 0.5) / lanes - 0.5;
      ctx.save();
      ctx.translate(
        center[0] - sample.tangentZ * across * region.width * pixelsPerMetre,
        center[1] - sample.tangentX * across * region.width * pixelsPerMetre
      );
      ctx.rotate(angle);
      ctx.fillStyle = random() > 0.5
        ? terrainRecipeDetailInk(channel, 'rgba(203, 200, 188, 0.24)', '#d7d7d7', '#a6a6a6')
        : terrainRecipeDetailInk(channel, 'rgba(119, 118, 112, 0.12)', '#c1c1c1', '#969696');
      ctx.fillRect(-slabLength * 0.47, -slabWidth * 0.46, slabLength * 0.94, slabWidth * 0.92);
      ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(77, 76, 72, 0.42)', '#999999', '#555555');
      ctx.lineWidth = Math.max(0.8, pixelsPerMetre * 0.045);
      ctx.strokeRect(-slabLength * 0.47, -slabWidth * 0.46, slabLength * 0.94, slabWidth * 0.92);
      if (random() > 0.74) {
        ctx.beginPath();
        ctx.moveTo(-slabLength * 0.28, slabWidth * (random() - 0.5) * 0.35);
        ctx.lineTo(slabLength * 0.24, slabWidth * (random() - 0.5) * 0.35);
        ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(91, 89, 84, 0.16)', '#b0b0b0', '#7f7f7f');
        ctx.lineWidth = Math.max(0.5, pixelsPerMetre * 0.025);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}

function drawAsphaltRoadDetails(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  region: { points: readonly [number, number][]; width: number },
  width: number,
  height: number,
  channel: TerrainRecipeDetailChannel,
  random: () => number
): void {
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  const lanes = Math.max(4, Math.floor(region.width / 0.55));
  forEachPathSample(region.points, 0.38, (sample) => {
    for (let lane = 0; lane < lanes; lane += 1) {
      const across = ((lane + random()) / lanes - 0.5) * region.width * 0.82;
      const point = surfaceCanvasPoint(map, [
        sample.x - sample.tangentZ * across,
        sample.z + sample.tangentX * across
      ], width, height);
      const grain = Math.max(0.45, pixelsPerMetre * (0.018 + random() * 0.035));
      ctx.fillStyle = random() > 0.48
        ? terrainRecipeDetailInk(channel, 'rgba(205, 208, 206, 0.1)', '#b3b3b3', '#999999')
        : terrainRecipeDetailInk(channel, 'rgba(20, 22, 23, 0.12)', '#858585', '#696969');
      ctx.fillRect(point[0], point[1], grain, Math.max(0.4, grain * (0.45 + random() * 0.4)));
    }
  });

  forEachPathSample(region.points, Math.max(10, region.width * 1.55), (sample) => {
    const center = surfaceCanvasPoint(map, [sample.x, sample.z], width, height);
    const length = region.width * pixelsPerMetre * (0.08 + random() * 0.16);
    const across = (random() - 0.5) * region.width * pixelsPerMetre * 0.45;
    const nx = -sample.tangentZ;
    const ny = -sample.tangentX;
    ctx.beginPath();
    ctx.moveTo(center[0] + nx * across, center[1] + ny * across);
    ctx.lineTo(
      center[0] + nx * (across + length * 0.45) + sample.tangentX * length * 0.18,
      center[1] + ny * (across + length * 0.45) - sample.tangentZ * length * 0.18
    );
    ctx.lineTo(center[0] + nx * (across + length), center[1] + ny * (across + length));
    ctx.strokeStyle = terrainRecipeDetailInk(channel, 'rgba(15, 17, 18, 0.18)', '#858585', '#555555');
    ctx.lineWidth = Math.max(0.55, pixelsPerMetre * 0.03);
    ctx.stroke();
  });

  if (channel === 'color' && region.width >= 5) {
    drawCanvasPath(ctx, map, region.points, width, height);
    ctx.setLineDash([pixelsPerMetre * 1.6, pixelsPerMetre * 1.1]);
    ctx.strokeStyle = 'rgba(235, 222, 174, 0.68)';
    ctx.lineWidth = Math.max(1.6, pixelsPerMetre * 0.09);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function terrainRecipeDetailInk(
  channel: TerrainRecipeDetailChannel,
  color: string,
  roughness: string,
  bump: string
): string {
  return channel === 'color' ? color : channel === 'roughness' ? roughness : bump;
}

function drawCanvasPath(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  points: readonly [number, number][],
  width: number,
  height: number
): void {
  const canvasPoints = points.map((point) => surfaceCanvasPoint(map, point, width, height));
  ctx.beginPath();
  ctx.moveTo(canvasPoints[0][0], canvasPoints[0][1]);
  canvasPoints.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
}

function forEachPathSample(
  points: readonly [number, number][],
  spacing: number,
  visit: (sample: { x: number; z: number; tangentX: number; tangentZ: number }) => void
): void {
  let carried = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.0001) continue;
    for (let distance = Math.max(0, spacing - carried); distance < length; distance += spacing) {
      visit({
        x: start[0] + dx * distance / length,
        z: start[1] + dz * distance / length,
        tangentX: dx / length,
        tangentZ: dz / length
      });
    }
    carried = (carried + length) % spacing;
  }
}

function stringSeed(value: string): number {
  let seed = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    seed = Math.imul(seed ^ value.charCodeAt(index), 0x01000193);
  }
  return seed >>> 0;
}

function drawSemanticZoneShape(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  zone: SceneVisualZone,
  color: string,
  opacity: number,
  width: number,
  height: number
): void {
  if (zone.region?.kind === 'path') {
    drawSemanticPath(ctx, map, zone.region, color, opacity, width, height);
    return;
  }
  if (zone.region?.kind === 'polygon') {
    drawSemanticPolygon(ctx, map, zone.region, color, opacity, width, height);
    return;
  }
  const circle = zone.region?.kind === 'circle'
    ? { center: [zone.region.x, zone.region.z] as [number, number], radius: zone.region.radius }
    : { center: zone.center, radius: zone.radius };
  const center = surfaceCanvasPoint(map, circle.center, width, height);
  const radiusX = circle.radius / map.box.size[0] * width;
  const radiusY = circle.radius / map.box.size[2] * height;
  ctx.save();
  ctx.translate(center[0], center[1]);
  ctx.scale(Math.max(0.001, radiusX), Math.max(0.001, radiusY));
  const gradient = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 1);
  gradient.addColorStop(0, withOpacity(color, opacity));
  gradient.addColorStop(0.72, withOpacity(color, opacity * 0.78));
  gradient.addColorStop(1, withOpacity(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawProceduralTerrainDetail(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  width: number,
  height: number
): void {
  if (style.detailStrength <= 0) return;
  const random = seededRandom(map.seed ^ 0x74a91d3);
  const palettes = {
    grass: ['#4e7046', '#7f9a5e'],
    soil: style.soilRecipe === 'moist' ? ['#493b30', '#725841'] : ['#806246', '#b08a62'],
    sand: style.sandRecipe === 'beach' ? ['#c9ae72', '#f0d79b'] : ['#b79858', '#dec174'],
    rocky: ['#777873', '#b1ada3'],
    paving: ['#777b79', '#b8b6af']
  } as const;
  const count = Math.round(700 + style.detailStrength * 1600);
  ctx.save();
  ctx.lineCap = 'round';
  for (let index = 0; index < count; index += 1) {
    const x = (random() - 0.5) * map.box.size[0];
    const z = (random() - 0.5) * map.box.size[2];
    const { surface: selected, weight: selectedWeight } = terrainDetailSurfaceAt(map, x, z);
    if (selected === 'grass' && selectedWeight <= 0.001) continue;
    const point = surfaceCanvasPoint(map, [x, z], width, height);
    const palette = palettes[selected];
    ctx.strokeStyle = palette[random() > 0.5 ? 0 : 1];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = style.detailStrength * (0.1 + Math.max(0.25, selectedWeight) * 0.24);
    if (selected === 'soil' || selected === 'rocky') {
      const radius = selected === 'rocky' ? 1.1 + random() * 2.2 : 0.6 + random() * 1.4;
      ctx.fillRect(point[0], point[1], radius, radius * (0.5 + random()));
    } else {
      const length = selected === 'sand' ? 3 + random() * 6 : selected === 'paving' ? 2 + random() * 4 : 1 + random() * 3;
      const angle = selected === 'sand'
        ? (style.sandRecipe === 'beach' ? 0.12 : -0.42)
        : random() * Math.PI;
      ctx.lineWidth = selected === 'paving' ? 1.2 : 0.7;
      ctx.beginPath();
      ctx.moveTo(point[0] - Math.cos(angle) * length * 0.5, point[1] - Math.sin(angle) * length * 0.5);
      ctx.lineTo(point[0] + Math.cos(angle) * length * 0.5, point[1] + Math.sin(angle) * length * 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawProceduralTerrainPropertyDetail(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  style: RuntimeTerrainMaterialStyle,
  channel: TerrainTextureChannel,
  width: number,
  height: number
): void {
  if (style.detailStrength <= 0) return;
  const random = seededRandom(map.seed ^ (channel === 'roughness' ? 0x34b72a1 : 0x58d194f));
  const roughness = {
    grass: ['#d8d8d8', '#ffffff'],
    soil: style.soilRecipe === 'moist' ? ['#858585', '#c2c2c2'] : ['#b8b8b8', '#f4f4f4'],
    sand: ['#dddddd', '#ffffff'],
    rocky: ['#a0a0a0', '#e8e8e8'],
    paving: ['#929292', '#dddddd']
  } as const;
  const bump = {
    grass: ['#6c6c6c', '#a2a2a2'],
    soil: ['#606060', '#b0b0b0'],
    sand: ['#6a6a6a', '#a8a8a8'],
    rocky: ['#464646', '#c4c4c4'],
    paving: ['#505050', '#aaaaaa']
  } as const;
  const palettes = channel === 'roughness' ? roughness : bump;
  const count = Math.round(900 + style.detailStrength * 2100);
  ctx.save();
  ctx.lineCap = 'round';
  for (let index = 0; index < count; index += 1) {
    const x = (random() - 0.5) * map.box.size[0];
    const z = (random() - 0.5) * map.box.size[2];
    const { surface, weight } = terrainDetailSurfaceAt(map, x, z);
    if (surface === 'grass' && weight <= 0.001) continue;
    const point = surfaceCanvasPoint(map, [x, z], width, height);
    const palette = palettes[surface];
    ctx.strokeStyle = palette[random() > 0.5 ? 0 : 1];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = style.detailStrength * (0.24 + Math.max(0.2, weight) * 0.4);
    if (surface === 'soil' || surface === 'rocky') {
      const radius = surface === 'rocky' ? 1.4 + random() * 3.4 : 0.8 + random() * 2.2;
      ctx.fillRect(point[0], point[1], radius, radius * (0.45 + random() * 0.8));
      continue;
    }
    const length = surface === 'sand' ? 3 + random() * 7 : surface === 'paving' ? 2.5 + random() * 5 : 1 + random() * 3;
    const angle = surface === 'sand'
      ? (style.sandRecipe === 'beach' ? 0.12 : -0.42)
      : random() * Math.PI;
    ctx.lineWidth = surface === 'paving' ? 1.3 : 0.8;
    ctx.beginPath();
    ctx.moveTo(point[0] - Math.cos(angle) * length * 0.5, point[1] - Math.sin(angle) * length * 0.5);
    ctx.lineTo(point[0] + Math.cos(angle) * length * 0.5, point[1] + Math.sin(angle) * length * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function terrainDetailSurfaceAt(
  map: EditableMap,
  x: number,
  z: number
): { surface: TerrainDetailSurface; weight: number } {
  const tags: readonly TerrainDetailSurface[] = ['grass', 'soil', 'sand', 'rocky', 'paving'];
  let surface: TerrainDetailSurface = 'grass';
  let weight = combinedGrassDensity(map, x, z) * grassSurfaceCoverage(map, x, z);
  for (const tag of tags) {
    const candidate = terrainSemanticSurfaceWeight(map, x, z, [tag]);
    if (candidate > weight) {
      surface = tag;
      weight = candidate;
    }
  }
  return { surface, weight };
}

function drawSemanticPath(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  region: Extract<VisualZoneRegion, { kind: 'path' }>,
  color: string,
  opacity: number,
  width: number,
  height: number
): void {
  const points = region.points.map((point) => surfaceCanvasPoint(map, point, width, height));
  if (points.length < 2) return;
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
  ctx.strokeStyle = withOpacity(color, opacity * 0.3);
  ctx.lineWidth = Math.max(1, region.width * pixelsPerMetre);
  ctx.stroke();
  ctx.strokeStyle = withOpacity(color, opacity);
  ctx.lineWidth *= 0.72;
  ctx.stroke();
  ctx.restore();
}

function drawSemanticPolygon(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  region: Extract<VisualZoneRegion, { kind: 'polygon' }>,
  color: string,
  opacity: number,
  width: number,
  height: number
): void {
  const points = region.points.map((point) => surfaceCanvasPoint(map, point, width, height));
  if (points.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
  ctx.closePath();
  ctx.fillStyle = withOpacity(color, opacity * 0.82);
  ctx.fill();
  ctx.strokeStyle = withOpacity(color, opacity * 0.3);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
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
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Line)) return;
    const mesh = child as THREE.Mesh | THREE.Line;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      const maybe = material as THREE.MeshStandardMaterial;
      for (const texture of [maybe.map, maybe.roughnessMap, maybe.bumpMap, maybe.normalMap]) {
        if (texture) textures.add(texture);
      }
    }
    const shore = mesh.userData.waterShore as { texture?: THREE.Texture } | undefined;
    if (shore?.texture?.isTexture) textures.add(shore.texture);
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
