import ts from 'typescript';
import { applyMapOperations, type MapOperation } from '../shared/mapOperations';
import {
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type MapWaterBodyType
} from '../shared/map';
import {
  createMapStreetGrid,
  createParallelMapGuides,
  mapGuidePolyline,
  normalizeMapGuides,
  sampleMapGuide,
  type MapGuide
} from '../shared/mapGuide';
import { expandStructuredMapPlacement } from '../shared/mapPlacement';
import {
  expandMapScatter,
  evaluateMapScatterQuality,
  type MapScatterPlacement,
  type MapScatterPlan
} from '../shared/mapScatter';
import { findSafeSpawnPosition } from '../shared/mapSpawnSafety';
import { planMapObjectAttachment } from '../shared/mapAttachment';
import { GRASS_PRESET_IDS, type GrassPresetId, type GrassRegion } from '../shared/mapGrass';
import {
  TERRAIN_GENERATION_PRESETS,
  TERRAIN_ACCESS_MODES,
  TERRAIN_CLIFF_LAYOUTS,
  TERRAIN_MODIFIERS,
  TERRAIN_SURFACES,
  type TerrainAccessMode,
  type TerrainCliffLayout,
  type TerrainGenerationPreset,
  type TerrainModifier,
  type TerrainRegion,
  type TerrainSurfaceKind
} from '../shared/terrainGeneration';

export interface SceneProgramDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface SceneProgramResult {
  operations: MapOperation[];
  diagnostics: SceneProgramDiagnostic[];
  guideCount: number;
  objectCount: number;
  renderPromptSuggestions: string[];
}

interface SceneProgramBudget {
  maxSteps: number;
  maxLoopIterations: number;
  maxOperations: number;
}

interface SceneProgramContext {
  map: EditableMap;
  assets: readonly MapAsset[];
  workingMap: EditableMap;
  operations: MapOperation[];
  diagnostics: SceneProgramDiagnostic[];
  renderPromptSuggestions: string[];
  steps: number;
  loopIterations: number;
  budget: SceneProgramBudget;
}

type RuntimeValue = unknown;
type Environment = Map<string, RuntimeValue>;
type SceneMethod = (...args: RuntimeValue[]) => RuntimeValue;

const DEFAULT_BUDGET: SceneProgramBudget = {
  maxSteps: 2_000,
  maxLoopIterations: 256,
  maxOperations: 1_200
};
const MAX_LAYOUT_POINTS = 256;

export function executeSceneProgram(
  source: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  budget: Partial<SceneProgramBudget> = {}
): SceneProgramResult {
  if (typeof source !== 'string' || !source.trim()) throw new Error('empty_scene_program');
  if (source.length > 24_000) throw new Error('scene_program_too_large');
  const file = ts.createSourceFile('scene-program.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) throw new Error(`invalid_scene_program_syntax:${parseDiagnostics[0].messageText}`);
  const context: SceneProgramContext = {
    map,
    assets,
    workingMap: {
      ...map,
      assets: [...new Map([...(map.assets ?? []), ...assets].map((asset) => [asset.id, asset])).values()]
    },
    operations: [],
    diagnostics: [],
    renderPromptSuggestions: [],
    steps: 0,
    loopIterations: 0,
    budget: { ...DEFAULT_BUDGET, ...budget }
  };
  const environment: Environment = new Map();
  environment.set('scene', createSceneApi(context));
  for (const statement of file.statements) executeStatement(statement, environment, context);
  if (context.renderPromptSuggestions.length > 0) {
    emit(context, {
      type: 'map.update',
      renderPromptSuggestions: [...new Set([
        ...context.workingMap.renderPromptSuggestions,
        ...context.renderPromptSuggestions
      ])].slice(-8)
    });
  }
  const guideCount = context.operations.filter((operation) => operation.type === 'guide.upsert').length;
  const objectCount = context.operations.filter((operation) => operation.type === 'object.add').length;
  if (context.operations.length === 0) {
    context.diagnostics.push({ severity: 'warning', code: 'empty-program', message: 'Scene program produced no map operations.' });
  }
  return {
    operations: context.operations,
    diagnostics: context.diagnostics,
    guideCount,
    objectCount,
    renderPromptSuggestions: [...context.renderPromptSuggestions]
  };
}

export const SCENE_PROGRAM_API_REFERENCE = `
Write only a bounded Scene Program in TypeScript-like syntax. No imports, functions, assignment, while loops or global APIs.

Available API:
- scene.terrain(preset, { amplitude?, roughness?, seed?, direction? })
- scene.modifyTerrain(modifier, region, { amplitude?, softness?, direction?, variation?, layers?, layout?, access? })
- scene.refineTerrain({ erosion?, drainage?, iterations?, talus? })
- scene.guide(id, { name?, points: [[x,z],...], curve?: "polyline"|"catmull-rom", closed?: boolean, width?: number, tags?: string[] }) -> Guide
- scene.parallelGuides(idPrefix, polygon, { direction, spacing, inset?, width?, tags? }) -> Guide[]
- scene.streetGrid(idPrefix, polygon, { direction, blockWidth, blockDepth, roadWidth, inset?, tags? }) -> { streets: Guide[], blocks: Block[] }
- scene.gridPoints({ center?, columns, rows, spacing: number|[x,z] }) -> [x,z][]
- scene.noise2D(x, z, scale?, seed?) -> number in [-1,1]
- scene.fbm2D(x, z, { scale?, octaves?, lacunarity?, gain?, seed? }) -> number in [-1,1]
- scene.clamp(value, min, max), scene.lerp(from, to, amount), scene.remap(value, inMin, inMax, outMin, outMax), scene.smoothstep(min, max, value)
- scene.distance2D(left, right), scene.rotate2D(point, degrees, center?)
- scene.placeOn(selector, parentId, { name?, scale?, yaw?, offset?: [localX,localZ], gap? }) -> objectId
- scene.mountOn(selector, parentId, { side: "north"|"south"|"east"|"west", name?, scale?, yaw?, offset?: [horizontal,vertical], inset? }) -> objectId
- scene.surface(guide, "grass"|"sand"|"rock"|"soil"|"paving", intensity?)
- scene.surfaceRegion(id, "grass"|"sand"|"rock"|"soil"|"paving", region, intensity?)
- scene.water(id, { type: "lake"|"river"|"ocean", points: [[x,z],...], name?, width?, level?, depth?, shorelineSmoothness?, shorelineIrregularity? })
- scene.grass(id, region, { name?, preset?, density?, variation?, softness?, height? })
- scene.placeAlong(assetSelector, guide, { spacing, offset?, count?, scale?, facing?: "guide"|"inward"|"outward", groupSize? })
- scene.scatter(assetSelector, { center: [x,z], radius }, { count?, density?, minSpacing?, avoidWater?, maxSlope?, scaleMin?, scaleMax?, clusterStrength?, edgeFalloff? })
- scene.placeAt(assetSelector, [x,z], { yaw?, scale?, name?, searchRadius?, avoidWater?, maxSlope? })
- scene.spawn([x,z], yawDegrees?)
- scene.renderSuggestion(text)
- scene.range(count) or scene.range(start, end, step?) -> number[]
- scene.polar([x,z], radius, degrees) -> [x,z]
- scene.note(message)

region is { kind:"circle", x, z, radius }, { kind:"path", points, width }, or { kind:"polygon", points }.
Block has { id, points, center }; iterate blocks to assign land use and place block-specific content.
assetSelector matches an asset ID, tag, or name. Use const declarations, if, and for (const value of values).
The runtime owns bounds, collision, terrain height, slope and operation budgets.
`.trim();

function createSceneApi(context: SceneProgramContext): Record<string, SceneMethod> {
  return {
    clamp: (value, min, max) => {
      const left = finiteNumber(min, 0);
      const right = finiteNumber(max, 1);
      return clamp(finiteNumber(value, 0), Math.min(left, right), Math.max(left, right));
    },
    lerp: (from, to, amount) => {
      const start = finiteNumber(from, 0);
      return start + (finiteNumber(to, 0) - start) * finiteNumber(amount, 0);
    },
    remap: (value, inMin, inMax, outMin, outMax) => {
      const inputMin = finiteNumber(inMin, 0);
      const inputMax = finiteNumber(inMax, 1);
      const outputMin = finiteNumber(outMin, 0);
      const denominator = inputMax - inputMin;
      if (Math.abs(denominator) < 0.000001) return outputMin;
      const amount = (finiteNumber(value, inputMin) - inputMin) / denominator;
      return outputMin + (finiteNumber(outMax, 1) - outputMin) * amount;
    },
    smoothstep: (min, max, value) => {
      const start = finiteNumber(min, 0);
      const end = finiteNumber(max, 1);
      const denominator = end - start;
      if (Math.abs(denominator) < 0.000001) return finiteNumber(value, start) < start ? 0 : 1;
      const amount = clamp((finiteNumber(value, start) - start) / denominator, 0, 1);
      return amount * amount * (3 - 2 * amount);
    },
    distance2D: (left, right) => {
      const a = point2(left, 'invalid_distance_point');
      const b = point2(right, 'invalid_distance_point');
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    },
    rotate2D: (pointValue, degreesValue, centerValue = [0, 0]) => {
      const point = point2(pointValue, 'invalid_rotate_point');
      const center = point2(centerValue, 'invalid_rotate_center');
      const radians = finiteNumber(degreesValue, 0) * Math.PI / 180;
      const x = point[0] - center[0];
      const z = point[1] - center[1];
      return [
        center[0] + x * Math.cos(radians) - z * Math.sin(radians),
        center[1] + x * Math.sin(radians) + z * Math.cos(radians)
      ];
    },
    gridPoints: (optionsValue) => {
      const options = objectValue(optionsValue, 'invalid_grid_options');
      const columns = boundedInteger(options.columns, 1, MAX_LAYOUT_POINTS, 1);
      const rows = boundedInteger(options.rows, 1, Math.max(1, Math.floor(MAX_LAYOUT_POINTS / columns)), 1);
      const center = point2(options.center ?? [0, 0], 'invalid_grid_center');
      const spacing = Array.isArray(options.spacing)
        ? point2(options.spacing, 'invalid_grid_spacing').map((value) => Math.max(0.01, Math.abs(value))) as [number, number]
        : [
            Math.max(0.01, Math.abs(finiteNumber(options.spacing, 1))),
            Math.max(0.01, Math.abs(finiteNumber(options.spacing, 1)))
          ] as [number, number];
      return Array.from({ length: rows * columns }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return [
          center[0] + (column - (columns - 1) / 2) * spacing[0],
          center[1] + (row - (rows - 1) / 2) * spacing[1]
        ];
      });
    },
    noise2D: (xValue, zValue, scaleValue = 1, seedValue = context.map.seed) => valueNoise2D(
      finiteNumber(xValue, 0) * finiteNumber(scaleValue, 1),
      finiteNumber(zValue, 0) * finiteNumber(scaleValue, 1),
      Math.trunc(finiteNumber(seedValue, context.map.seed))
    ),
    fbm2D: (xValue, zValue, optionsValue = {}) => {
      const options = objectValue(optionsValue, 'invalid_fbm_options');
      const octaves = boundedInteger(options.octaves, 1, 8, 4);
      const seed = Math.trunc(finiteNumber(options.seed, context.map.seed));
      let amplitude = 1;
      let frequency = finiteNumber(options.scale, 1);
      let total = 0;
      let weight = 0;
      for (let octave = 0; octave < octaves; octave += 1) {
        total += valueNoise2D(
          finiteNumber(xValue, 0) * frequency,
          finiteNumber(zValue, 0) * frequency,
          seed + octave * 1013
        ) * amplitude;
        weight += amplitude;
        frequency *= finiteNumber(options.lacunarity, 2);
        amplitude *= finiteNumber(options.gain, 0.5);
      }
      return weight > 0 ? total / weight : 0;
    },
    terrain: (presetValue, optionsValue = {}) => {
      if (context.operations.some((operation) => operation.type === 'terrain.generate')) {
        throw new Error('scene_program_base_terrain_already_generated');
      }
      const preset = stringValue(presetValue, 'invalid_terrain_preset') as TerrainGenerationPreset;
      if (!TERRAIN_GENERATION_PRESETS.includes(preset)) throw new Error('invalid_terrain_preset');
      const options = objectValue(optionsValue, 'invalid_terrain_options');
      emit(context, {
        type: 'terrain.generate',
        preset,
        seed: finiteNumber(options.seed, context.map.seed),
        amplitude: optionalFiniteNumber(options.amplitude),
        roughness: optionalFiniteNumber(options.roughness),
        direction: optionalFiniteNumber(options.direction)
      });
      return preset;
    },
    modifyTerrain: (modifierValue, regionValue, optionsValue = {}) => {
      const modifier = stringValue(modifierValue, 'invalid_terrain_modifier') as TerrainModifier;
      if (!TERRAIN_MODIFIERS.includes(modifier)) throw new Error('invalid_terrain_modifier');
      const options = objectValue(optionsValue, 'invalid_terrain_modifier_options');
      const layout = optionalString(options.layout) as TerrainCliffLayout | undefined;
      const access = optionalString(options.access) as TerrainAccessMode | undefined;
      if (layout && !TERRAIN_CLIFF_LAYOUTS.includes(layout)) throw new Error('invalid_terrain_layout');
      if (access && !TERRAIN_ACCESS_MODES.includes(access)) throw new Error('invalid_terrain_access');
      emit(context, {
        type: 'terrain.modify',
        modifier,
        region: terrainRegion(regionValue),
        seed: finiteNumber(options.seed, context.map.seed + context.operations.length),
        amplitude: optionalFiniteNumber(options.amplitude),
        softness: optionalFiniteNumber(options.softness),
        direction: optionalFiniteNumber(options.direction),
        variation: optionalFiniteNumber(options.variation),
        layers: optionalFiniteNumber(options.layers),
        layout,
        access
      });
      return modifier;
    },
    refineTerrain: (optionsValue = {}) => {
      const options = objectValue(optionsValue, 'invalid_terrain_refinement_options');
      emit(context, {
        type: 'terrain.refine',
        erosion: optionalFiniteNumber(options.erosion),
        drainage: optionalFiniteNumber(options.drainage),
        iterations: optionalFiniteNumber(options.iterations),
        talus: optionalFiniteNumber(options.talus)
      });
      return null;
    },
    guide: (idValue, optionsValue) => {
      const options = objectValue(optionsValue, 'invalid_guide_options');
      const [guide] = normalizeMapGuides([{
        id: stringValue(idValue, 'invalid_guide_id'),
        name: optionalString(options.name),
        points: options.points,
        curve: options.curve,
        closed: options.closed,
        width: options.width,
        tags: options.tags
      }], context.map.box.size);
      if (!guide) throw new Error('invalid_scene_program_guide');
      emit(context, { type: 'guide.upsert', guide });
      return guide;
    },
    parallelGuides: (prefixValue, regionValue, optionsValue) => {
      const options = objectValue(optionsValue, 'invalid_parallel_guide_options');
      const guides = createParallelMapGuides({
        idPrefix: stringValue(prefixValue, 'invalid_guide_prefix'),
        region: pointArray(regionValue, 'invalid_parallel_guide_region'),
        direction: finiteNumber(options.direction, 0),
        spacing: finiteNumber(options.spacing, 3),
        inset: finiteNumber(options.inset, 0),
        width: finiteNumber(options.width, 0.6),
        tags: stringArray(options.tags)
      });
      for (const guide of guides) emit(context, { type: 'guide.upsert', guide });
      return guides;
    },
    streetGrid: (prefixValue, regionValue, optionsValue) => {
      const options = objectValue(optionsValue, 'invalid_street_grid_options');
      const grid = createMapStreetGrid({
        idPrefix: stringValue(prefixValue, 'invalid_street_grid_prefix'),
        region: pointArray(regionValue, 'invalid_street_grid_region'),
        direction: finiteNumber(options.direction, 0),
        blockWidth: finiteNumber(options.blockWidth, 12),
        blockDepth: finiteNumber(options.blockDepth, 12),
        roadWidth: finiteNumber(options.roadWidth, 3),
        inset: finiteNumber(options.inset, 1.5),
        tags: stringArray(options.tags)
      });
      for (const street of grid.streets) emit(context, { type: 'guide.upsert', guide: street });
      if (grid.blocks.length === 0) {
        context.diagnostics.push({
          severity: 'warning',
          code: 'street-grid-no-blocks',
          message: 'Street grid produced no fully bounded buildable blocks; enlarge the region or reduce block spacing.'
        });
      }
      return grid;
    },
    surface: (guideValue, surfaceValue, intensityValue) => {
      const guide = guideValue as MapGuide;
      requireGuide(guide);
      const surface = stringValue(surfaceValue, 'invalid_surface') as TerrainSurfaceKind;
      if (!TERRAIN_SURFACES.includes(surface)) throw new Error('invalid_surface');
      emit(context, {
        type: 'terrain.surface',
        surface,
        intensity: clamp(finiteNumber(intensityValue, 1), 0.05, 1),
        zoneId: `scene-program:${guide.id}`,
        region: { kind: 'path', points: mapGuidePolyline(guide), width: guide.width }
      });
    },
    surfaceRegion: (idValue, surfaceValue, regionValue, intensityValue) => {
      const surface = terrainSurface(surfaceValue);
      emit(context, {
        type: 'terrain.surface',
        surface,
        intensity: clamp(finiteNumber(intensityValue, 1), 0.05, 1),
        zoneId: `scene-program:${cleanId(stringValue(idValue, 'invalid_surface_id'))}`,
        region: terrainRegion(regionValue)
      });
      return null;
    },
    water: (idValue, optionsValue) => {
      const id = cleanId(stringValue(idValue, 'invalid_water_id'));
      const options = objectValue(optionsValue, 'invalid_water_options');
      const type = stringValue(options.type, 'invalid_water_type') as MapWaterBodyType;
      if (type !== 'lake' && type !== 'river' && type !== 'ocean') throw new Error('invalid_water_type');
      emit(context, {
        type: 'water.add',
        water: {
          id,
          name: optionalString(options.name),
          type,
          points: pointArray(options.points, 'invalid_water_points').slice(0, 64),
          width: optionalFiniteNumber(options.width),
          level: optionalFiniteNumber(options.level),
          depth: optionalFiniteNumber(options.depth),
          shorelineSmoothness: optionalFiniteNumber(options.shorelineSmoothness),
          shorelineIrregularity: optionalFiniteNumber(options.shorelineIrregularity),
          seed: finiteNumber(options.seed, context.map.seed + context.operations.length)
        }
      });
      return id;
    },
    grass: (idValue, regionValue, optionsValue = {}) => {
      const id = cleanId(stringValue(idValue, 'invalid_grass_id'));
      const options = objectValue(optionsValue, 'invalid_grass_options');
      const preset = (optionalString(options.preset) ?? 'meadow') as GrassPresetId;
      if (!GRASS_PRESET_IDS.includes(preset)) throw new Error('invalid_grass_preset');
      if (!context.workingMap.grassLayers.some((layer) => layer.id === id)) {
        emit(context, {
          type: 'grass.layer.add',
          layer: {
            id,
            name: optionalString(options.name),
            preset,
            height: optionalFiniteNumber(options.height),
            seed: finiteNumber(options.seed, context.map.seed + context.operations.length)
          }
        });
      }
      emit(context, {
        type: 'grass.generate',
        layerId: id,
        region: grassRegion(regionValue),
        density: finiteNumber(options.density, 0.65),
        variation: finiteNumber(options.variation, 0.25),
        softness: finiteNumber(options.softness, 0.2),
        seed: finiteNumber(options.seed, context.map.seed + context.operations.length)
      });
      return id;
    },
    placeAlong: (selectorValue, guideValue, optionsValue) => {
      const selector = stringValue(selectorValue, 'invalid_asset_selector');
      const guide = guideValue as MapGuide;
      requireGuide(guide);
      const options = objectValue(optionsValue, 'invalid_place_along_options');
      const selectedAssets = selectAssets(context.assets, selector);
      if (selectedAssets.length === 0) {
        context.diagnostics.push({ severity: 'warning', code: 'asset-not-found', message: `No asset matched "${selector}".` });
        return [];
      }
      const spacing = clamp(finiteNumber(options.spacing, 3), 0.3, 80);
      const samples = sampleMapGuide(guide, { spacing });
      const count = Math.max(1, Math.min(Math.round(finiteNumber(options.count, samples.length)), samples.length, 240));
      const points = mapGuidePolyline(guide);
      const centerX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
      const centerZ = points.reduce((sum, point) => sum + point[1], 0) / points.length;
      const radius = Math.max(1, ...points.map((point) => Math.hypot(point[0] - centerX, point[1] - centerZ))) + Math.abs(finiteNumber(options.offset, 0)) + spacing;
      const scale = clamp(finiteNumber(options.scale, 1), 0.1, 8);
      const facing = options.facing === 'inward' || options.facing === 'outward' ? options.facing : 'guide';
      const placements = expandStructuredMapPlacement(context.workingMap, {
        mode: 'linear',
        intent: 'street-edge',
        assetIds: selectedAssets.map((asset) => asset.id),
        region: { kind: 'circle', x: centerX, z: centerZ, r: radius },
        density: count / Math.max(1, Math.PI * radius * radius),
        spacing,
        offset: finiteNumber(options.offset, 0),
        direction: 0,
        facing,
        avoidWater: clamp(finiteNumber(options.avoidWater, 0), 0, 30),
        maxSlope: clamp(finiteNumber(options.maxSlope, 35), 0, 89),
        scaleRange: [scale, scale],
        seed: context.map.seed + hashString(guide.id + selector),
        guidePoints: points,
        maxPerGroup: Math.max(1, Math.round(finiteNumber(options.groupSize, count)))
      }, selectedAssets, count, `program-${guide.id}-${cleanId(selector)}`);
      for (const placement of placements) emitPlacement(context, placement);
      reportPlacementShortfall(context, `placeAlong:${selector}`, count, placements.length);
      return placements;
    },
    scatter: (selectorValue, regionValue, optionsValue = {}) => {
      const selector = stringValue(selectorValue, 'invalid_asset_selector');
      const selectedAssets = selectAssets(context.assets, selector);
      if (selectedAssets.length === 0) {
        context.diagnostics.push({ severity: 'warning', code: 'asset-not-found', message: `No asset matched "${selector}".` });
        return [];
      }
      const region = circleRegion(regionValue, 'invalid_scatter_region');
      const options = objectValue(optionsValue, 'invalid_scatter_options');
      const count = Math.max(1, Math.min(240, Math.round(finiteNumber(options.count, 24))));
      const minSpacing = clamp(finiteNumber(options.minSpacing, 2.2), 0.2, 80);
      const plan: MapScatterPlan = {
        assetIds: selectedAssets.map((asset) => asset.id),
        region: { kind: 'circle', x: region.center[0], z: region.center[1], r: region.radius },
        density: clamp(finiteNumber(options.density, count / Math.max(1, Math.PI * region.radius ** 2)), 0.0001, 1),
        avoidWater: clamp(finiteNumber(options.avoidWater, 0.5), 0, 30),
        maxSlope: clamp(finiteNumber(options.maxSlope, 38), 0, 89),
        minSpacing,
        scaleRange: [
          clamp(finiteNumber(options.scaleMin, 0.9), 0.1, 8),
          clamp(finiteNumber(options.scaleMax, 1.15), 0.1, 8)
        ],
        seed: finiteNumber(options.seed, context.map.seed + hashString(selector)),
        edgeFalloff: clamp(finiteNumber(options.edgeFalloff, 0.15), 0, 1),
        clusterStrength: clamp(finiteNumber(options.clusterStrength, 0.45), 0, 1)
      };
      const placements = expandMapScatter(
        context.workingMap,
        plan,
        selectedAssets,
        count,
        `program-scatter-${cleanId(selector)}-${context.operations.length + 1}`
      );
      for (const placement of placements) emitPlacement(context, placement);
      const quality = evaluateMapScatterQuality(plan, placements, count);
      for (const issue of quality.issues) {
        context.diagnostics.push({ severity: 'warning', code: issue, message: `${selector}: ${issue}` });
      }
      return placements;
    },
    placeAt: (selectorValue, pointValue, optionsValue) => {
      const selector = stringValue(selectorValue, 'invalid_asset_selector');
      const point = point2(pointValue, 'invalid_place_point');
      const options = objectValue(optionsValue, 'invalid_place_options');
      const [asset] = selectAssets(context.assets, selector);
      if (!asset) {
        context.diagnostics.push({ severity: 'warning', code: 'asset-not-found', message: `No asset matched "${selector}".` });
        return null;
      }
      const scale = clamp(finiteNumber(options.scale, 1), 0.1, 8);
      const searchRadius = clamp(finiteNumber(options.searchRadius, Math.max(2, asset.footprintRadius ?? 0.5)), 0.5, 30);
      const [placement] = expandStructuredMapPlacement(context.workingMap, {
        mode: 'layout',
        pattern: 'row',
        intent: 'landmark',
        assetIds: [asset.id],
        region: { kind: 'circle', x: point[0], z: point[1], r: searchRadius },
        density: 1 / Math.max(1, Math.PI * searchRadius ** 2),
        spacing: Math.max(0.5, asset.footprintRadius ?? 0.5),
        offset: 0,
        direction: 90 - finiteNumber(options.yaw, 0),
        facing: 'guide',
        avoidWater: clamp(finiteNumber(options.avoidWater, 0.5), 0, 30),
        maxSlope: clamp(finiteNumber(options.maxSlope, 35), 0, 89),
        scaleRange: [scale, scale],
        seed: context.map.seed + hashString(`${selector}:${point.join(':')}`),
        candidateCount: 25
      }, [asset], 1, `program-${cleanId(selector)}-${context.operations.length + 1}`);
      if (!placement) {
        reportPlacementShortfall(context, `placeAt:${selector}`, 1, 0);
        return null;
      }
      emitPlacement(context, placement, optionalString(options.name));
      return placement.id;
    },
    placeOn: (selectorValue, parentValue, optionsValue = {}) => placeAttached(
      context, selectorValue, parentValue, optionsValue, 'supported'
    ),
    mountOn: (selectorValue, parentValue, optionsValue = {}) => placeAttached(
      context, selectorValue, parentValue, optionsValue, 'mounted'
    ),
    spawn: (pointValue, yawValue) => {
      const requested = point2(pointValue, 'invalid_spawn_point');
      const [x, z] = findSafeSpawnPosition(context.workingMap, requested[0], requested[1]);
      emit(context, {
        type: 'reference.set',
        point: [x, sampleTerrainHeight(context.workingMap, x, z), z],
        yaw: finiteNumber(yawValue, 0) * Math.PI / 180
      });
      return [x, z];
    },
    renderSuggestion: (messageValue) => {
      const message = stringValue(messageValue, 'invalid_render_suggestion').slice(0, 160);
      if (!context.renderPromptSuggestions.includes(message)) context.renderPromptSuggestions.push(message);
      context.renderPromptSuggestions = context.renderPromptSuggestions.slice(-8);
      return null;
    },
    range: (startValue, endValue, stepValue) => boundedRange(startValue, endValue, stepValue),
    polar: (centerValue, radiusValue, degreesValue) => {
      const center = point2(centerValue, 'invalid_polar_center');
      const radians = finiteNumber(degreesValue, 0) * Math.PI / 180;
      const radius = finiteNumber(radiusValue, 0);
      return [center[0] + Math.cos(radians) * radius, center[1] + Math.sin(radians) * radius];
    },
    note: (messageValue) => {
      context.diagnostics.push({ severity: 'info', code: 'program-note', message: stringValue(messageValue, 'invalid_note').slice(0, 240) });
      return null;
    }
  };
}

function terrainSurface(value: unknown): TerrainSurfaceKind {
  const surface = stringValue(value, 'invalid_surface') as TerrainSurfaceKind;
  if (!TERRAIN_SURFACES.includes(surface)) throw new Error('invalid_surface');
  return surface;
}

function terrainRegion(value: unknown): TerrainRegion {
  const region = objectValue(value, 'invalid_terrain_region');
  if (region.kind === 'circle') {
    return {
      kind: 'circle',
      x: finiteNumber(region.x, 0),
      z: finiteNumber(region.z, 0),
      radius: finiteNumber(region.radius ?? region.r, 8)
    };
  }
  if (region.kind === 'path') {
    return {
      kind: 'path',
      points: pointArray(region.points, 'invalid_terrain_region').slice(0, 64),
      width: finiteNumber(region.width, 4)
    };
  }
  if (region.kind === 'polygon') {
    return { kind: 'polygon', points: pointArray(region.points, 'invalid_terrain_region').slice(0, 64) };
  }
  throw new Error('invalid_terrain_region');
}

function grassRegion(value: unknown): GrassRegion {
  const region = objectValue(value, 'invalid_grass_region');
  if (region.kind === 'polygon') {
    return { kind: 'polygon', points: pointArray(region.points, 'invalid_grass_region').slice(0, 64) };
  }
  const circle = circleRegion(value, 'invalid_grass_region');
  return { kind: 'circle', center: circle.center, radius: circle.radius };
}

function circleRegion(value: unknown, code: string): { center: [number, number]; radius: number } {
  const region = objectValue(value, code);
  const center = Array.isArray(region.center)
    ? point2(region.center, code)
    : [finiteNumber(region.x, 0), finiteNumber(region.z, 0)] as [number, number];
  const radius = finiteNumber(region.radius ?? region.r, 8);
  if (radius <= 0) throw new Error(code);
  return { center, radius };
}

function placeAttached(
  context: SceneProgramContext,
  selectorValue: unknown,
  parentValue: unknown,
  optionsValue: unknown,
  kind: 'supported' | 'mounted'
): string | null {
  const selector = stringValue(selectorValue, 'invalid_asset_selector');
  const parentId = stringValue(parentValue, 'invalid_attachment_parent');
  const options = objectValue(optionsValue, 'invalid_attachment_options');
  const [asset] = selectAssets(context.assets, selector);
  if (!asset) {
    context.diagnostics.push({ severity: 'warning', code: 'asset-not-found', message: `No asset matched "${selector}".` });
    return null;
  }
  const offset = options.offset === undefined
    ? [0, 0] as [number, number]
    : point2(options.offset, 'invalid_attachment_offset');
  const object = planMapObjectAttachment(context.workingMap, {
    id: `program-${kind}-${cleanId(selector)}-${context.operations.length + 1}`.slice(0, 80),
    name: optionalString(options.name) ?? asset.name,
    parentId,
    asset,
    kind,
    side: optionalString(options.side) as 'north' | 'south' | 'east' | 'west' | undefined,
    scale: clamp(finiteNumber(options.scale, 1), 0.1, 8),
    yaw: finiteNumber(options.yaw, 0) * Math.PI / 180,
    offset,
    contact: kind === 'supported'
      ? clamp(finiteNumber(options.gap, 0.02), 0, 2)
      : clamp(finiteNumber(options.inset, 0.02), 0, 2)
  });
  emit(context, { type: 'object.add', object });
  return object.id;
}

function emitPlacement(context: SceneProgramContext, placement: MapScatterPlacement, name?: string): void {
  emit(context, {
    type: 'object.add',
    object: {
      id: placement.id,
      name: name ?? placement.name,
      assetId: placement.assetId,
      heightMode: 'terrain',
      transform: {
        position: [placement.x, placement.y, placement.z],
        rotation: [0, placement.rotationY, 0],
        scale: [placement.scale, placement.scale, placement.scale],
        size: [1, 1, 1]
      }
    }
  });
}

function reportPlacementShortfall(context: SceneProgramContext, label: string, requested: number, placed: number): void {
  if (placed >= requested) return;
  context.diagnostics.push({
    severity: 'warning',
    code: 'placement-underfilled',
    message: `${label} placed ${placed}/${requested}; collision, bounds, slope or water constraints rejected the rest.`
  });
}

function boundedRange(startValue: unknown, endValue: unknown, stepValue: unknown): number[] {
  const oneArgument = endValue === undefined;
  const start = oneArgument ? 0 : finiteNumber(startValue, 0);
  const end = oneArgument ? finiteNumber(startValue, 0) : finiteNumber(endValue, 0);
  const defaultStep = end >= start ? 1 : -1;
  const step = finiteNumber(stepValue, defaultStep);
  if (Math.abs(step) < 0.000001 || Math.sign(end - start) !== Math.sign(step)) return [];
  const values: number[] = [];
  for (let value = start; step > 0 ? value < end : value > end; value += step) {
    if (values.length >= 256) throw new Error('scene_program_range_budget_exceeded');
    values.push(value);
  }
  return values;
}

function executeStatement(statement: ts.Statement, environment: Environment, context: SceneProgramContext): void {
  tick(context);
  if (ts.isVariableStatement(statement)) {
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) throw unsupported(statement, 'Only const declarations are allowed');
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw unsupported(declaration, 'Invalid const declaration');
      if (environment.has(declaration.name.text)) throw new Error(`duplicate_scene_program_identifier:${declaration.name.text}`);
      environment.set(declaration.name.text, evaluateExpression(declaration.initializer, environment, context));
    }
    return;
  }
  if (ts.isExpressionStatement(statement)) {
    evaluateExpression(statement.expression, environment, context);
    return;
  }
  if (ts.isForOfStatement(statement)) {
    if (!ts.isVariableDeclarationList(statement.initializer)
      || (statement.initializer.flags & ts.NodeFlags.Const) === 0
      || statement.initializer.declarations.length !== 1
      || !ts.isIdentifier(statement.initializer.declarations[0].name)) {
      throw unsupported(statement, 'for...of must declare one const identifier');
    }
    const iterable = evaluateExpression(statement.expression, environment, context);
    if (!Array.isArray(iterable)) throw new Error('scene_program_for_of_requires_array');
    const name = statement.initializer.declarations[0].name.text;
    for (const item of iterable) {
      context.loopIterations += 1;
      if (context.loopIterations > context.budget.maxLoopIterations) throw new Error('scene_program_loop_budget_exceeded');
      const child = new Map(environment);
      child.set(name, item);
      executeEmbeddedStatement(statement.statement, child, context);
    }
    return;
  }
  if (ts.isIfStatement(statement)) {
    const condition = Boolean(evaluateExpression(statement.expression, environment, context));
    if (condition) executeEmbeddedStatement(statement.thenStatement, new Map(environment), context);
    else if (statement.elseStatement) executeEmbeddedStatement(statement.elseStatement, new Map(environment), context);
    return;
  }
  if (ts.isEmptyStatement(statement)) return;
  throw unsupported(statement, 'Unsupported statement');
}

function executeEmbeddedStatement(statement: ts.Statement, environment: Environment, context: SceneProgramContext): void {
  if (ts.isBlock(statement)) {
    for (const child of statement.statements) executeStatement(child, environment, context);
  } else {
    executeStatement(statement, environment, context);
  }
}

function evaluateExpression(expression: ts.Expression, environment: Environment, context: SceneProgramContext): RuntimeValue {
  tick(context);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expression)) {
    if (!environment.has(expression.text)) throw new Error(`unknown_scene_program_identifier:${expression.text}`);
    return environment.get(expression.text);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => {
      if (ts.isSpreadElement(element)) throw unsupported(element, 'Spread is not allowed');
      return evaluateExpression(element, environment, context);
    });
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, RuntimeValue> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) throw unsupported(property, 'Only object properties are allowed');
      const name = propertyName(property.name);
      value[name] = evaluateExpression(property.initializer, environment, context);
    }
    return value;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const target = evaluateExpression(expression.expression, environment, context);
    if (Array.isArray(target) && expression.name.text === 'length') return target.length;
    if (target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, expression.name.text)) {
      const value = (target as Record<string, RuntimeValue>)[expression.name.text];
      if (value !== undefined) return value;
    }
    throw new Error(`invalid_scene_program_property:${expression.name.text}`);
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const target = evaluateExpression(expression.expression, environment, context);
    const key = evaluateExpression(expression.argumentExpression, environment, context);
    if (Array.isArray(target) && Number.isInteger(Number(key))) return target[Number(key)];
    throw new Error('invalid_scene_program_element_access');
  }
  if (ts.isCallExpression(expression)) {
    const callable = evaluateExpression(expression.expression, environment, context);
    if (typeof callable !== 'function') throw new Error('scene_program_value_not_callable');
    return (callable as SceneMethod)(...expression.arguments.map((argument) => evaluateExpression(argument, environment, context)));
  }
  if (ts.isParenthesizedExpression(expression)) return evaluateExpression(expression.expression, environment, context);
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = evaluateExpression(expression.operand, environment, context);
    if (expression.operator === ts.SyntaxKind.ExclamationToken) return !value;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -finiteNumber(value, 0);
    throw unsupported(expression, 'Unsupported unary operator');
  }
  if (ts.isBinaryExpression(expression)) {
    const left = evaluateExpression(expression.left, environment, context);
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && evaluateExpression(expression.right, environment, context);
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || evaluateExpression(expression.right, environment, context);
    const right = evaluateExpression(expression.right, environment, context);
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
      case ts.SyntaxKind.GreaterThanToken: return Number(left) > Number(right);
      case ts.SyntaxKind.GreaterThanEqualsToken: return Number(left) >= Number(right);
      case ts.SyntaxKind.LessThanToken: return Number(left) < Number(right);
      case ts.SyntaxKind.LessThanEqualsToken: return Number(left) <= Number(right);
      case ts.SyntaxKind.PlusToken: return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right);
      case ts.SyntaxKind.MinusToken: return Number(left) - Number(right);
      case ts.SyntaxKind.AsteriskToken: return Number(left) * Number(right);
      case ts.SyntaxKind.SlashToken: return Number(left) / Number(right);
      case ts.SyntaxKind.PercentToken: return Number(left) % Number(right);
      default: throw unsupported(expression, 'Unsupported binary operator');
    }
  }
  if (ts.isConditionalExpression(expression)) {
    return Boolean(evaluateExpression(expression.condition, environment, context))
      ? evaluateExpression(expression.whenTrue, environment, context)
      : evaluateExpression(expression.whenFalse, environment, context);
  }
  throw unsupported(expression, 'Unsupported expression');
}

function emit(context: SceneProgramContext, operation: MapOperation): void {
  if (context.operations.length >= context.budget.maxOperations) throw new Error('scene_program_operation_budget_exceeded');
  context.workingMap = applyMapOperations(context.workingMap, [operation]);
  context.operations.push(operation);
}

function tick(context: SceneProgramContext): void {
  context.steps += 1;
  if (context.steps > context.budget.maxSteps) throw new Error('scene_program_step_budget_exceeded');
}

function selectAssets(assets: readonly MapAsset[], selector: string): MapAsset[] {
  const normalized = selector.trim().toLowerCase();
  const exact = assets.filter((asset) => asset.id.toLowerCase() === normalized);
  if (exact.length > 0) return exact;
  const tagged = assets.filter((asset) => asset.tags?.some((tag) => tag.toLowerCase() === normalized));
  if (tagged.length > 0) return tagged;
  return assets.filter((asset) => asset.name.toLowerCase().includes(normalized)).slice(0, 8);
}

function requireGuide(value: unknown): asserts value is MapGuide {
  if (!value || typeof value !== 'object' || !Array.isArray((value as MapGuide).points)) throw new Error('invalid_scene_program_guide');
}

function objectValue(value: unknown, code: string): Record<string, RuntimeValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, RuntimeValue>;
}

function pointArray(value: unknown, code: string): Array<[number, number]> {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((point) => point2(point, code));
}

function point2(value: unknown, code: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(Number(value[0])) || !Number.isFinite(Number(value[1]))) {
    throw new Error(code);
  }
  return [Number(value[0]), Number(value[1])];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return value !== undefined && Number.isFinite(number) ? number : undefined;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clamp(finiteNumber(value, fallback), min, max));
}

function valueNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothFraction(x - x0);
  const tz = smoothFraction(z - z0);
  return lerpNumber(
    lerpNumber(hashNoise(x0, z0, seed), hashNoise(x0 + 1, z0, seed), tx),
    lerpNumber(hashNoise(x0, z0 + 1, seed), hashNoise(x0 + 1, z0 + 1, seed), tx),
    tz
  ) * 2 - 1;
}

function hashNoise(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}

function smoothFraction(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerpNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    if (name.text === '__proto__' || name.text === 'prototype' || name.text === 'constructor') {
      throw unsupported(name, 'Unsafe object property is not allowed');
    }
    return name.text;
  }
  throw unsupported(name, 'Computed object properties are not allowed');
}

function unsupported(node: ts.Node, message: string): Error {
  return new Error(`unsupported_scene_program:${message}:${ts.SyntaxKind[node.kind]}`);
}

function cleanId(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return cleaned || `item-${hashString(value).toString(36)}`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
