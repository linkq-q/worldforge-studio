import vm from 'node:vm';
import {
  createId,
  getMapBounds,
  getMapObjectVisualAabbs,
  getMapPlayerMetrics,
  normalizeMapRoom,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type MapRoom,
  type MapRoomOpening,
  type MapWaterBody,
  type MapWaterBodyType,
  type RoomWall
} from '../shared/map';
import { foundationBoundary, foundationTopHeight, normalizeMapFoundation, type MapFoundation } from '../shared/mapFoundation';
import { assetFootprintRadius, normalizeAssetTags } from '../shared/mapAssetMetadata';
import { planMapObjectAttachment } from '../shared/mapAttachment';
import { indoorAssetTargetCount } from '../shared/indoorScenePlanning';
import { normalizeMapAiMaxNewAssets, normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import { calculateModelVisualBounds, type Aabb } from '../shared/modelBounds';
import { normalizeMapDesignSemantics, type MapCompositionLayer, type MapDesignSemantics } from '../shared/mapDesign';
import {
  compileMapDesignDensityFill,
  compileMapNaturalClearance,
  compileMapDesignPruning,
  compileMapDesignRelations,
  resolveMapDesignFocusObjects
} from '../shared/mapDesignRelations';
import type { AgentProgressEvent, ChatProvider } from '../shared/protocol';
import {
  applyMapOperations,
  isCodePlanPlaceholderAssetId,
  type CodePlanAssetReadyPayload,
  type CodePlanPlacementPreview,
  type CodePlanPreviewPayload,
  type CodePlanRequirementPreview,
  type MapAiSuggestion,
  type MapOperation
} from '../shared/mapOperations';
import {
  GRASS_PRESET_DEFINITIONS,
  GRASS_PRESET_IDS,
  inferGrassPreset,
  normalizeGrassMix,
  type GrassPresetId,
  type GrassRegion
} from '../shared/mapGrass';
import { findSafeSpawnPosition } from '../shared/mapSpawnSafety';
import { distanceToWater, isPointInsideWaterBody, waterBoundaryPoints, waterSurfaceLevelAt } from '../shared/mapWater';
import { createMapStreetGrid, mapGuidePolyline, sampleMapGuide, type MapPlannedBlock } from '../shared/mapGuide';
import { worldCapabilitySummary } from '../shared/worldCapabilities';
import { evaluateSettlementQuality } from '../shared/settlementQuality';
import {
  TERRAIN_ACCESS_MODES,
  TERRAIN_CLIFF_LAYOUTS,
  TERRAIN_GENERATION_PRESETS,
  TERRAIN_MODIFIERS,
  TERRAIN_SURFACES,
  TERRAIN_SURFACE_RECIPES,
  normalizeTerrainGenerationParams,
  normalizeTerrainModifierParams,
  normalizeTerrainRefinementParams,
  normalizeTerrainSurfaceParams,
  terrainSurfaceForRecipe,
  type TerrainAccessMode,
  type TerrainCliffLayout,
  type TerrainGenerationPreset,
  type TerrainModifier,
  type TerrainRegion,
  type TerrainSurfaceRecipe,
  type TerrainSurfaceKind
} from '../shared/terrainGeneration';
import { runAssetGenerationPool, type AssetTaskReporter } from './assetGenerationPool';
import type { AssetGenerationRequest } from './mapAi';
import { validateMapSuggestion } from './mapSuggestionValidation';
import { llmChat } from './modelApi';

const MAX_CODE_LENGTH = 40_000;
const MAX_PLACEMENTS = 2_000;
const MAX_SCENE_OPERATIONS = 256;
const MAX_POINT_RESULTS = 512;
const DISCOVERY_EXECUTION_TIMEOUT_MS = 250;
const FINAL_EXECUTION_TIMEOUT_MS = 1_000;
const REPLAY_EXECUTION_TIMEOUT_MS = 3_000;
const MAP_CODE_ENVIRONMENT_FORM_CONTRACT = `Use these structured environment forms:
api.terrain({preset:'plain'|'hills'|'valley'|'island'|'archipelago'|'canyon'|'cliff-plateau'|'dune-desert',amplitude?,roughness?,seed?,direction?:degrees|[x,z]});
api.modifyTerrain({modifier:'mountain'|'ridge'|'valley'|'basin'|'cliff'|'terrace'|'dune'|'island',region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width}|{kind:'polygon',points:[[x,z],...]},amplitude?:positiveNumber,softness?:number,direction?:degrees|[x,z],variation?:number,layers?:number|stepArray,layout?:'plateau'|'coast'|'canyon'|'wall'|'terraces',access?:'walkable'|'scenic',seed?});
api.surface({id:'short-id',surface:'grass'|'sand'|'rock'|'soil'|'paving',material?:'default'|'compacted-earth'|'garden-stone'|'asphalt',region:{kind:'circle'|'path'|'polygon',...},intensity?,clearNatural?}); Use clearNatural:true for arena floors, plazas, courtyards and other functional clearings where loose trees and rocks must be excluded. Route surfaces are clear automatically.
api.grass({id:'short-id',name?,preset:'meadow'|'sand'|'wetland'|'farm'|'magic'|'alpine-moss',region:{kind:'circle',center:[x,z],radius}|{kind:'polygon',points:[[x,z],...]},density?,variation?,softness?,height?,mix?:{short?,tall?,flowers?},seed?});
api.foundation({name?,shape:'capsule'|'rounded-rectangle'|'polygon'|'path',under?:[objectReferenceOrExistingId,...],position?:[x,z]|[x,y,z],width?,depth?,margin?,cornerRadius?,points?:[[localX,localZ],...],curve?:'polyline'|'catmull-rom',closed?,top?:'level'|'slope'|'steps',thickness?,maxThickness?,slope?,slopeDirection?:radians,stepHeight?,stepCount?,material?}); The top is walkable, the bottom follows terrain, and terrain is never flattened.
Enum fields are closed choices, not descriptions. Put descriptive meaning in id/name or comments; never write phrases such as "gentle central basin" in modifier or "packed earth" in surface.`;
const CODE_ASSET_ORIENTATION_PROMPT = 'Coordinate contract: local Y+ is up, local Z+ is the front, entrance, or forward direction, and local X+ is right. Put doors, facades, openings, windshields, noses, seats, and other recognizable front details toward local Z+. For a modular repeated element, explicitly choose the long axis: side-by-side modules span local X with depth/front on local Z; traversal modules span local Z. Keep the model centered at its origin.';
const ENVIRONMENT_ASSET = /\b(?:tree|forest|plant|vegetation|grass|shrub|bush|flower|fern|moss|rock|stone|boulder|crystal|mushroom|cactus|reed|coral|animal|creature|wildlife|bird|fish|deer|horse|insect|nature|flora|fauna)s?\b|树|森林|植物|植被|草|灌木|花|蕨|苔藓|岩石|石头|巨石|水晶|蘑菇|仙人掌|芦苇|珊瑚|动物|生物|野生|鸟|鱼|鹿|马|昆虫|自然|生态/i;
const ENTRANCE_ASSET = /\b(?:gate|entrance|door|portal|archway|moon gate)\b|入口|拱门|月洞门|传送门|门楼|城门|大门|主门|侧门|院门|园门|馆门|竞技场门/i;
const CONTINUOUS_STRUCTURE_ASSET = /\b(?:wall|arcade|corridor|railing|fence|grandstand|bleacher|stands?)\b|城墙|围墙|墙体|外墙|内墙|拱券|长廊|回廊|走廊|栏杆|围栏|看台/i;
const ARENA_SEATING_ASSET = /\b(?:grandstand|bleacher|spectator stand|arena seating)\b|环形看台|竞技场看台|观众席/i;
const DRY_LAND_ASSET = /\b(?:wall|gate|building|house|hall|tower|arcade|corridor|railing|fence|grandstand|bleacher|tree|pine|bamboo|lamp|lantern|bench|chair|table)\b|城墙|围墙|墙体|门楼|月洞门|建筑|楼阁|厅堂|塔|长廊|回廊|走廊|栏杆|围栏|看台|树|松|竹|灯笼|石灯|座椅|长凳|桌椅/i;
const WATER_COMPATIBLE_ASSET = /\b(?:bridge|pier|dock|boat|ship|lotus|reed|water lily|aquatic|fish|fountain)\b|桥|桥台|码头|栈桥|船|舟|荷花|莲花|芦苇|水生|鱼|喷泉|湖心亭|水榭/i;
const FLOATING_WATER_ASSET = /\b(?:boat|ship)\b|船|舟/i;
const INDOOR_FORBIDDEN_CONTENT = /\b(?:whole|complete|entire)\s+(?:room|interior)\b|\broom\s+shell\b|\bfloor(?:ing)?\s+(?:finish|surface|plane|slab)\b|\bceiling\s+(?:finish|surface|plane|slab)\b|\bwall(?:paper|\s+(?:finish|surface|shell))\b|\b(?:carpet|rug)(?:\s+(?:finish|surface))?\b|\b(?:terrain|outdoor ground|building exterior)\b|整间房|整体房间|房间外壳|地板饰面|墙面饰面|天花饰面|墙纸|地毯|室外地形|建筑外立面/i;

type Point2 = [number, number];
type Point3 = [number, number, number];
type MapCodeScope = 'general' | 'scene';
type MapCodeRequestMode = 'generate' | 'refine';
type CodeAssetRole = 'structure' | 'environment' | 'functional' | 'decor';
type CodeSceneIntent = 'natural' | 'authored';

export interface MapCodePlannerOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
  minNewAssets?: number;
  maxNewAssets?: number;
  /** Choose full-scene ownership or the standalone general-purpose planner. */
  scope?: MapCodeScope;
  /** Generate a complete scene or emit a delta over the supplied map. */
  mode?: MapCodeRequestMode;
  /** Return the validated Code and declared asset list without generating assets. */
  discoveryOnly?: boolean;
  /** Reuse a user-approved Code candidate without asking the model to redesign it. */
  approvedCode?: string;
  /** Optional user-authored preference for focal assets; the model still owns the composition. */
  focusPrompt?: string;
  /** Optional bounded override used by local diagnostics; HTTP callers do not control it. */
  finalExecutionTimeoutMs?: number;
  /** Locked objects created by the current unapplied AI preview that refine may still adjust. */
  refinableObjectIds?: readonly string[];
  /** Editor multi-selection supplied as grounding context for natural-language refinement. */
  selectedObjectIds?: readonly string[];
  onProgress?: (event: AgentProgressEvent) => void;
  /** Streams the placement layout right after sandbox discovery, before asset generation starts. */
  onPlanPreview?: (plan: CodePlanPreviewPayload) => void;
  /** Streams each asset the moment it is generated and saved, keyed back to its plan placeholder. */
  onAssetReady?: (event: CodePlanAssetReadyPayload) => void;
  createAsset?: (request: AssetGenerationRequest, report: AssetTaskReporter) => Promise<MapAsset>;
}

export interface MapCodePlanMetadata {
  code: string;
  placementCount: number;
  functions: string[];
  sceneIntent?: CodeSceneIntent;
  sceneIntentReason?: string;
}

interface PlacementInput {
  assetId?: string | null;
  name?: string;
  position?: Point2 | Point3 | { x: number; y?: number; z: number } | { point: Point2 | Point3 };
  rotationY?: number;
  facing?: Point2 | {
    direction?: Point2;
    tangent?: Point2;
    normal?: Point2;
    target?: Point2;
    offsetY?: number;
  };
  scale?: number | Point3;
  size?: Point3;
  dimensions?: Point3;
  terrain?: boolean;
  role?: CodeAssetRole;
  roomOpeningId?: string;
  groupId?: string;
  layer?: MapCompositionLayer;
  sourceGuideId?: string;
  foundation?: MapFoundation;
}

interface FoundationInput extends Partial<MapFoundation> {
  name?: string;
  position?: Point2 | Point3 | { x: number; y?: number; z: number };
  rotationY?: number;
  under?: string[];
  margin?: number;
}

interface PlaceBetweenInput {
  assetId?: string | null;
  name?: string;
  start: Point2 | Point3 | { x: number; y?: number; z: number };
  end: Point2 | Point3 | { x: number; y?: number; z: number };
  dimensions?: Point3;
  size?: Point3;
  spanAxis?: 'x' | 'z';
  gapRatio?: number;
  facing?: PlacementInput['facing'];
  frontTarget?: Point2;
  scale?: number | Point3;
  terrain?: boolean;
  role?: CodeAssetRole;
  groupId?: string;
  layer?: MapCompositionLayer;
}

interface BridgeInput {
  waterId: string;
  assetId?: string | null;
  name?: string;
  crossingCenter: Point2 | { x: number; z: number };
  direction: Point2 | { x: number; z: number };
  dimensions?: Point3;
  size?: Point3;
  bankInset?: number;
  deckClearance?: number;
  scale?: number | Point3;
  role?: CodeAssetRole;
  replaceObjectId?: string;
  kind?: 'straight' | 'curved';
  curveOffset?: number;
  segmentCount?: number;
  abutments?: boolean;
  groupId?: string;
  layer?: MapCompositionLayer;
}

interface RouteInput {
  id: string;
  name?: string;
  points: Point2[];
  curve?: 'polyline' | 'catmull-rom';
  closed?: boolean;
  width?: number;
  surface?: TerrainSurfaceKind | 'none';
  material?: TerrainSurfaceRecipe;
  intensity?: number;
  tags?: string[];
}

interface RouteNetworkInput {
  id: string;
  nodes: Array<{ id: string; point: Point2; role?: string }>;
  edges: Array<Omit<RouteInput, 'points'> & { from: string; to: string; via?: Point2[] }>;
}

interface StreetGridInput {
  id: string;
  region: Point2[];
  direction?: number;
  blockWidth: number;
  blockDepth: number;
  roadWidth: number;
  inset?: number;
  surface?: TerrainSurfaceKind | 'none';
  material?: TerrainSurfaceRecipe;
  intensity?: number;
  tags?: string[];
}

interface PlaceAlongRouteInput {
  routeId: string;
  assetId?: string | null;
  name?: string;
  spacing: number;
  offset?: number;
  side?: 'left' | 'right' | 'both' | 'alternate';
  startInset?: number;
  endInset?: number;
  facing?: 'forward' | 'toward-route' | 'away-from-route';
  scale?: number | Point3;
  dimensions?: Point3;
  size?: Point3;
  terrain?: boolean;
  role?: CodeAssetRole;
  groupId?: string;
  layer?: MapCompositionLayer;
}

interface StreetFrontageItem extends Omit<PlacementInput, 'position' | 'rotationY' | 'facing' | 'sourceGuideId'> {
  dimensions: Point3;
}

interface PlaceStreetFrontageInput {
  routeId: string;
  side: 'left' | 'right';
  items: StreetFrontageItem[];
  startInset?: number;
  endInset?: number;
  gap?: number;
  setback?: number;
}

interface MoveObjectInput {
  objectId: string;
  position?: PlacementInput['position'];
  rotationY?: number;
  scale?: number | Point3;
}

interface PlacementIntent {
  referenceId: string;
  assetId: string | null;
  name: string;
  position: Point3;
  rotationY: number;
  scale: Point3;
  size: Point3;
  heightMode: 'terrain' | 'fixed';
  role: CodeAssetRole;
  semantic: string;
  bridgeWaterId?: string;
  roomOpeningId?: string;
  designGroupId?: string;
  compositionLayer?: MapCompositionLayer;
  sourceGuideId?: string;
  foundation?: MapFoundation;
  attachment?: {
    parentId: string;
    kind: 'supported' | 'mounted';
    side?: RoomWall;
    offset?: Point2;
    contact?: number;
    anchorY?: 'bottom' | 'center' | 'top';
  };
  connectionMode?: 'explicit';
  connection?: {
    start: Point2;
    end: Point2;
    spanAxis: 'x' | 'z';
    gapRatio: number;
    frontTarget?: Point2;
  };
}

interface AttachmentInput {
  assetId?: string | null;
  name?: string;
  parentId: string;
  kind: 'supported' | 'mounted';
  side?: RoomWall;
  offset?: Point2;
  contact?: number;
  anchorY?: 'bottom' | 'center' | 'top';
  scale?: number;
  rotationY?: number;
  role?: CodeAssetRole;
  groupId?: string;
  layer?: MapCompositionLayer;
}

interface RoomOpeningInput {
  id: string;
  kind: 'door' | 'window';
  wall: RoomWall;
  offset?: number;
  bottom?: number;
  width?: number;
  height?: number;
}

interface RoomWallFrame {
  point: Point3;
  inward: Point2;
  outward: Point2;
  tangent: Point2;
}

interface BezierFrame {
  point: Point2;
  tangent: Point2;
  normal: Point2;
}

export interface CodeAssetRequirement {
  key: string;
  name: string;
  prompt: string;
  tags: string[];
  variants: number;
  dimensions?: Point3;
  role?: CodeAssetRole;
  optional?: boolean;
}

interface CodeAssetRequirementInput {
  key: string;
  name: string;
  prompt: string;
  tags?: string[];
  variants?: number;
  dimensions?: Point3;
  role?: CodeAssetRole;
  optional?: boolean;
}

interface CodeExecutionOptions {
  mode?: 'discovery' | 'final';
  requestMode?: MapCodeRequestMode;
  assetBindings?: ReadonlyMap<string, readonly MapAsset[]>;
  minNewAssets?: number;
  maxNewAssets?: number;
  scope?: MapCodeScope;
  executionTimeoutMs?: number;
  refinableObjectIds?: ReadonlySet<string>;
  /** Emits the executed layout after every discovery run, including attempts later repaired away. */
  onPlanPreview?: (plan: CodePlanPreviewPayload) => void;
}

interface CodeExecutionResult {
  suggestion: MapAiSuggestion;
  requirements: CodeAssetRequirement[];
}

interface MapCodeReplayContext {
  mapId: string;
  mapVersion: number;
  planningMap: EditableMap;
  expiresAt: number;
  code: string;
  assets: MapAsset[];
  bindings: Map<string, MapAsset[]>;
  generatedAssets: MapAsset[];
  failedTasks: Array<{ key: string; name: string }>;
  requirements: CodeAssetRequirement[];
  repairAttempts: number;
  requestMode: MapCodeRequestMode;
  scope: MapCodeScope | undefined;
  maxNewAssets: number;
  refinableObjectIds: string[];
}

const MAP_CODE_REPLAY_TTL_MS = 30 * 60 * 1_000;
const mapCodeReplayContexts = new Map<string, MapCodeReplayContext>();

export async function generateMapCodeSuggestion(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapCodePlannerOptions = {}
): Promise<MapAiSuggestion> {
  const requestMode = options.mode ?? 'generate';
  options.onProgress?.({
    phase: 'planning',
    label: requestMode === 'refine'
      ? `AI 正在编写${map.sceneMode === 'indoor' ? '室内差量规划' : '场景差量 Code'}`
      : map.sceneMode === 'indoor'
        ? 'AI 正在编排完整室内布局'
        : options.scope === 'scene' ? 'AI 正在编写完整场景 Code' : 'AI 正在编写程序化环境规划代码'
  });
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const maxNewAssets = assetRange.max;
  const reusableIds = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  const reusableAssets = requestMode === 'refine'
    ? assets
    : options.reuseExistingAssets === true
    ? assets.filter((asset) => (
        (!reusableIds || reusableIds.has(asset.id))
        && asset.libraryMetadata?.analysisStatus !== 'pending'
        && asset.libraryMetadata?.enabled !== false
      ))
    : [];
  const systemPrompt = buildMapCodePlannerSystemPrompt(
    map,
    reusableAssets,
    assetRange.min,
    maxNewAssets,
    options.scope,
    requestMode,
    prompt,
    options.refinableObjectIds
  );
  const focalPreference = options.focusPrompt?.trim().slice(0, 300);
  const userPrompt = [
    prompt.trim().slice(0, 1_200),
    focalPreference ? `User focal preference (optional, interpret rather than blindly obey): ${focalPreference}` : ''
  ].filter(Boolean).join('\n\n');
  let code = options.approvedCode
    ? extractCode(options.approvedCode)
    : extractCode(await llmChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], {
        apiBase: options.apiBase,
        provider: options.provider ?? 'gpt',
        temperature: 0.25,
        maxTokens: 16_000,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        onProgress: options.onProgress
      }));
  const execution = await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, reusableAssets, maxNewAssets, options);
  code = execution.code;
  const discovery = execution.discovery;
  options.onPlanPreview?.(distillCodePlanPreview(discovery.suggestion, discovery.requirements));
  if (options.discoveryOnly) {
    options.onProgress?.({ phase: 'complete', label: '室内功能规划与资产清单已生成，等待确认' });
    return withCodePlanDetails(discovery.suggestion, discovery.requirements, execution.repairAttempts);
  }
  if (discovery.requirements.length === 0) {
    options.onProgress?.({ phase: 'complete', label: `${map.sceneMode === 'indoor' ? '室内规划' : 'Code 规划'}已完成，未请求新资产` });
    return withCodePlanDetails(discovery.suggestion, discovery.requirements, execution.repairAttempts);
  }
  if (!options.createAsset) throw new Error('map_code_asset_generation_unavailable');

  const tasks = discovery.requirements.flatMap((requirement) => (
    Array.from({ length: requirement.variants }, (_, variantIndex) => ({
      key: requirement.key,
      variantIndex,
      name: requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
      request: {
        name: requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
        prompt: [
          codeAssetOrientationPrompt(requirement.prompt, requirement.dimensions),
          requirement.variants > 1
            ? `Create variation ${variantIndex + 1} of ${requirement.variants}; preserve the same reusable asset family while varying silhouette and details.`
            : ''
        ].filter(Boolean).join('\n'),
        tags: requirement.tags,
        mode: map.assetGenerationMode
      } satisfies AssetGenerationRequest
    }))
  ));
  options.onProgress?.({
    phase: 'checking-assets',
    label: `${map.sceneMode === 'indoor' ? '室内规划' : 'Code 规划'}请求生成 ${tasks.length} 个新资产`,
    current: 0,
    total: tasks.length
  });
  const generatedResults = await runAssetGenerationPool(
    tasks,
    async (task, _index, report) => {
      try {
        const asset = await options.createAsset!(task.request, report);
        options.onAssetReady?.({ key: task.key, variantIndex: task.variantIndex, asset });
        return asset;
      } catch (error) {
        options.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('map_asset_generation_failed:')) throw error;
        report({ status: 'failed', detail: message });
        return null;
      }
    },
    { signal: options.signal, onProgress: options.onProgress }
  );
  const generatedAssets = generatedResults.filter((asset): asset is MapAsset => asset !== null);
  const bindings = new Map<string, MapAsset[]>();
  tasks.forEach((task, index) => {
    const asset = generatedResults[index];
    if (!asset) return;
    const family = bindings.get(task.key) ?? [];
    family[task.variantIndex] = asset;
    bindings.set(task.key, family);
  });
  options.onProgress?.({
    phase: 'replanning',
    label: map.sceneMode === 'indoor' ? '使用新资产重放室内布局' : '使用新资产重放程序化环境规划'
  });
  const failedTasks = tasks.filter((_task, index) => generatedResults[index] === null);
  const replayContext: Omit<MapCodeReplayContext, 'expiresAt'> = {
    mapId: map.id,
    mapVersion: map.version,
    planningMap: map,
    code,
    assets: [...reusableAssets, ...generatedAssets],
    bindings,
    generatedAssets,
    failedTasks: failedTasks.map((task) => ({ key: task.key, name: task.name })),
    requirements: discovery.requirements,
    repairAttempts: execution.repairAttempts,
    requestMode,
    scope: options.scope,
    maxNewAssets,
    refinableObjectIds: [...new Set(options.refinableObjectIds ?? [])]
  };
  let final: MapAiSuggestion;
  try {
    final = executeFinalMapCodeReplay(
      replayContext,
      clampInteger(options.finalExecutionTimeoutMs ?? FINAL_EXECUTION_TIMEOUT_MS, 1, FINAL_EXECUTION_TIMEOUT_MS)
    );
  } catch (error) {
    if (!isScriptExecutionTimeout(error)) throw error;
    const replayToken = rememberMapCodeReplay(replayContext);
    throw new Error(`map_code_final_replay_timed_out:${replayToken}`);
  }
  if (failedTasks.length > 0) {
    const allOptional = failedTasks.every((task) => (
      discovery.requirements.find((requirement) => requirement.key === task.key)?.optional === true
    ));
    options.onProgress?.({
      phase: 'repairing',
      label: allOptional
        ? `${failedTasks.length} 个可选环境资产失败，已保留完整主体继续`
        : `${failedTasks.length} 个资产失败，已保留其余结果继续`,
      detail: failedTasks.map((task) => task.name).join('、')
    });
  }
  options.onProgress?.({
    phase: 'complete',
    label: `${map.sceneMode === 'indoor' ? '室内规划' : '整体 Code'}与 ${generatedAssets.length} 个新资产已完成`
  });
  return completeGeneratedMapCodeSuggestion(map, final, replayContext);
}

export function replayGeneratedMapCode(token: string, map: EditableMap): MapAiSuggestion {
  pruneMapCodeReplayContexts();
  const context = mapCodeReplayContexts.get(token);
  if (!context) throw new Error('map_code_replay_expired');
  if (context.mapId !== map.id || context.mapVersion !== map.version) {
    mapCodeReplayContexts.delete(token);
    throw new Error('map_code_replay_stale');
  }
  try {
    const final = executeFinalMapCodeReplay(context, REPLAY_EXECUTION_TIMEOUT_MS);
    mapCodeReplayContexts.delete(token);
    return completeGeneratedMapCodeSuggestion(context.planningMap, final, context);
  } catch (error) {
    if (isScriptExecutionTimeout(error)) throw new Error(`map_code_final_replay_timed_out:${token}`);
    throw error;
  }
}

function executeFinalMapCodeReplay(
  context: Omit<MapCodeReplayContext, 'expiresAt'>,
  executionTimeoutMs: number
): MapAiSuggestion {
  return runMapCodePlan(context.code, context.planningMap, context.assets, {
    mode: 'final',
    requestMode: context.requestMode,
    assetBindings: context.bindings,
    maxNewAssets: context.maxNewAssets,
    scope: context.scope,
    executionTimeoutMs,
    refinableObjectIds: new Set(context.refinableObjectIds)
  }).suggestion;
}

function completeGeneratedMapCodeSuggestion(
  map: EditableMap,
  final: MapAiSuggestion,
  context: Omit<MapCodeReplayContext, 'expiresAt'>
): MapAiSuggestion {
  const placedAssetIds = new Set(final.operations.flatMap((operation) => (
    operation.type === 'object.add' && operation.object.assetId ? [operation.object.assetId] : []
  )));
  const unplacedGeneratedAssets = context.generatedAssets.filter((asset) => !placedAssetIds.has(asset.id));
  const finalProgramIssues = findAuthoredSceneProgramIssues(map, final);
  return withCodePlanDetails({
    ...final,
    generatedAssets: context.generatedAssets.map((asset) => ({ id: asset.id, name: asset.name })),
    diagnostics: [
      ...(final.diagnostics ?? []),
      ...(context.failedTasks.length > 0 ? [{
        code: 'asset.generation-degraded' as const,
        severity: 'warning' as const,
        message: `资产“${context.failedTasks.map((task) => task.name).join('、')}”生成失败；其余可执行内容已保留，可稍后单独修复。`,
        repaired: false
      }] : []),
      ...(unplacedGeneratedAssets.length > 0 ? [{
        code: 'asset.unplaced' as const,
        severity: 'warning' as const,
        message: `资产“${unplacedGeneratedAssets.map((asset) => asset.name).join('、')}”已生成但未能安全落位；当前预览已保留，可稍后单独修复。`,
        repaired: false
      }] : []),
      ...sceneProgramDiagnostics(finalProgramIssues)
    ]
  }, context.requirements, context.repairAttempts);
}

function rememberMapCodeReplay(context: Omit<MapCodeReplayContext, 'expiresAt'>): string {
  pruneMapCodeReplayContexts();
  const token = createId('code-replay');
  mapCodeReplayContexts.set(token, { ...context, expiresAt: Date.now() + MAP_CODE_REPLAY_TTL_MS });
  return token;
}

function pruneMapCodeReplayContexts(): void {
  const now = Date.now();
  for (const [token, context] of mapCodeReplayContexts) {
    if (context.expiresAt <= now) mapCodeReplayContexts.delete(token);
  }
}

function isScriptExecutionTimeout(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error ?? '');
  return /Script execution timed out after \d+ms/i.test(message);
}

export function executeMapCodePlan(
  code: string,
  map: EditableMap,
  assets: readonly MapAsset[] = []
): MapAiSuggestion {
  return runMapCodePlan(code, map, assets).suggestion;
}

export function discoverMapCodeAssets(
  code: string,
  map: EditableMap,
  assets: readonly MapAsset[] = [],
  maxNewAssets?: number
): CodeAssetRequirement[] {
  return runMapCodePlan(code, map, assets, {
    mode: 'discovery',
    maxNewAssets: normalizeMapAiMaxNewAssets(maxNewAssets)
  }).requirements;
}

function runMapCodePlan(
  code: string,
  map: EditableMap,
  assets: readonly MapAsset[] = [],
  options: CodeExecutionOptions = {}
): CodeExecutionResult {
  const cleanCode = extractCode(code);
  if (!cleanCode || cleanCode.length > MAX_CODE_LENGTH) throw new Error('invalid_map_code_plan');

  const placements: PlacementIntent[] = [];
  const sceneOperations: MapOperation[] = [];
  const renderPromptSuggestions: string[] = [];
  const requirements = new Map<string, CodeAssetRequirement>();
  const unresolvedAssetIds = new Set<string>();
  const foundationWarnings: string[] = [];
  const missingAssetBindings = new Set<string>();
  const usedFunctions = new Set<string>();
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  // Asset geometry is immutable during one run; keep model traversal outside the sandbox time budget.
  const assetBoundsById = new Map(assets.map((asset) => [asset.id, calculateModelVisualBounds(asset.modelJson)]));
  const roleByAssetId = new Map<string, CodeAssetRole>();
  const indoorRoom = map.sceneMode === 'indoor' && map.room
    ? normalizeMapRoom(map.room, map.box.size, map.room)
    : null;
  const roomOpenings = indoorRoom ? [...indoorRoom.openings] : [];
  const mode = options.mode ?? 'final';
  const requestMode = options.requestMode ?? 'generate';
  const scope = options.scope ?? 'general';
  const maxNewAssets = options.maxNewAssets ?? normalizeMapAiMaxNewAssets(undefined);
  const random = mulberry32(map.seed);
  const record = (name: string) => usedFunctions.add(name);
  let sceneIntent: CodeSceneIntent | undefined;
  let sceneIntentReason = '';
  let sceneIntentCallCount = 0;
  let designSemantics = map.designSemantics;
  let designCallCount = 0;
  let spawnRequest: { point: Point2; yaw: number } | undefined;
  const emitSceneOperation = (operation: MapOperation) => {
    if (sceneOperations.length >= MAX_SCENE_OPERATIONS) throw new Error('map_code_scene_operation_limit');
    sceneOperations.push(operation);
  };
  const emitRoute = (input: RouteInput): string => {
    if (!input || typeof input !== 'object') throw new Error('invalid_map_code_route');
    const id = cleanId(input.id, 'route');
    const points = codePointArray(input.points, 'invalid_map_code_route_points').slice(0, 64);
    if (points.length < 2) throw new Error('invalid_map_code_route_points');
    const width = clampFinite(input.width ?? 1.5, 0.2, Math.min(map.box.size[0], map.box.size[2]));
    emitSceneOperation({
      type: 'guide.upsert',
      guide: {
        id,
        name: cleanText(input.name ?? id, 80),
        points,
        curve: input.curve === 'catmull-rom' ? 'catmull-rom' : 'polyline',
        closed: input.closed === true && points.length >= 3,
        width,
        tags: normalizeAssetTags(['route', 'circulation', ...(input.tags ?? [])]) ?? ['route', 'circulation']
      }
    });
    if (input.surface !== 'none') {
      const material = TERRAIN_SURFACE_RECIPES.includes(input.material as TerrainSurfaceRecipe)
        ? input.material as TerrainSurfaceRecipe
        : 'default';
      const surface = normalizeCodeTerrainSurface(input.surface ?? (
        material === 'default' ? 'paving' : terrainSurfaceForRecipe(material)
      )) ?? 'paving';
      emitSceneOperation({
        type: 'terrain.surface',
        ...normalizeTerrainSurfaceParams({
          surface,
          material,
          region: { kind: 'path', points, width },
          intensity: input.intensity ?? 1,
          zoneId: `code:route:${id}`,
          clearNatural: true
        }, map)
      });
    }
    return id;
  };
  const emitPlacement = (input: PlacementInput): string => {
    if (placements.length >= MAX_PLACEMENTS) throw new Error('map_code_plan_too_many_placements');
    if (!input || typeof input !== 'object') throw new Error('invalid_map_code_placement');
    const referenceId = codePlacementReference(placements.length);
    const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : null;
    if (requestedAssetId && isCodeMissingAsset(requestedAssetId)) return referenceId;
    let assetId = requestedAssetId;
    if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
      assetId = resolveMapCodeAssetId(input.name, assets);
      if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
    }
    const roomOpeningId = input.roomOpeningId?.trim();
    if (roomOpeningId && !roomOpenings.some((opening) => opening.id === roomOpeningId)) {
      throw new Error(`unknown_map_code_room_opening:${roomOpeningId}`);
    }
    if (input.position === undefined && !roomOpeningId) throw new Error('invalid_map_code_position');
    const terrain = map.sceneMode !== 'indoor'
      && input.terrain !== false
      && input.position !== undefined
      && placementUsesTerrain(input.position);
    const position = input.position === undefined
      ? roomOpeningPlacement(requireIndoorRoom(indoorRoom), roomOpenings, roomOpeningId!)
      : placementPosition(input.position, map, terrain);
    const asset = assetId ? assetById.get(assetId) : undefined;
    const role = roleByAssetId.get(assetId ?? '')
      ?? normalizeCodePlacementRole(input.role, map.sceneMode)
      ?? (map.sceneMode === 'indoor' ? 'functional' : inferCodeAssetRole([
        input.name,
        asset?.name,
        asset?.prompt,
        ...(asset?.tags ?? [])
      ].filter(Boolean).join(' ')));
    const dimensions = input.dimensions === undefined ? undefined : point3(input.dimensions);
    const fitted = fittedPlacementTransform(asset, input.scale ?? 1, dimensions, asset ? assetBoundsById.get(asset.id) : undefined);
    placements.push({
      referenceId,
      assetId,
      name: cleanText(input.name ?? assetById.get(assetId ?? '')?.name ?? '程序化物体', 80),
      position,
      rotationY: placementRotation(input.facing, position, input.rotationY),
      scale: fitted.scale,
      size: dimensions ?? point3(input.size ?? [1, 1, 1]),
      heightMode: terrain ? 'terrain' : 'fixed',
      role,
      semantic: [input.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' '),
      ...(roomOpeningId ? { roomOpeningId } : {}),
      ...(input.sourceGuideId ? { sourceGuideId: cleanId(input.sourceGuideId, 'route') } : {}),
      ...(input.foundation ? { foundation: input.foundation } : {}),
      ...placementDesignMetadata(input.groupId, input.layer)
    });
    return referenceId;
  };
  const api = Object.freeze({
    TAU: Math.PI * 2,
    PHI: (1 + Math.sqrt(5)) / 2,
    seed: map.seed,
    bounds: Object.freeze(getMapBounds(map)),
    room: indoorRoom ? Object.freeze({ ...indoorRoom, openings: Object.freeze([...roomOpenings]) }) : null,
    roomPoint(localX: number, localZ: number, height = 0): Point3 {
      record('roomPoint');
      const room = requireIndoorRoom(indoorRoom);
      const inset = room.wallThickness;
      return [
        room.position[0] + clampFinite(localX, -room.size[0] / 2 + inset, room.size[0] / 2 - inset),
        room.position[1] + clampFinite(height, 0, room.size[1] - room.wallThickness),
        room.position[2] + clampFinite(localZ, -room.size[2] / 2 + inset, room.size[2] / 2 - inset)
      ];
    },
    wallFrame(wall: RoomWall, offset = 0, bottom = 0, inset = 0.02): RoomWallFrame {
      record('wallFrame');
      return roomWallFrame(requireIndoorRoom(indoorRoom), normalizeRoomWall(wall), offset, bottom, inset);
    },
    ceilingPoint(localX: number, localZ: number, objectHeight = 0, drop = 0): Point3 {
      record('ceilingPoint');
      const room = requireIndoorRoom(indoorRoom);
      const point = roomInteriorPoint(room, localX, localZ);
      return [
        point[0],
        room.position[1] + room.size[1] - room.wallThickness
          - Math.max(0, finite(objectHeight)) - Math.max(0, finite(drop)),
        point[1]
      ];
    },
    opening(input: RoomOpeningInput): string {
      record('opening');
      const room = requireIndoorRoom(indoorRoom);
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_room_opening');
      const id = cleanText(input.id, 80);
      if (!id) throw new Error('invalid_map_code_room_opening');
      const existingIndex = roomOpenings.findIndex((opening) => opening.id === id);
      if (existingIndex >= 0 && requestMode !== 'refine') return id;
      const requestedOpening = {
        id,
        kind: input.kind === 'window' ? 'window' as const : 'door' as const,
        wall: normalizeRoomWall(input.wall),
        offset: input.offset ?? 0,
        bottom: input.bottom ?? (input.kind === 'window' ? 1 : 0),
        width: input.width ?? (input.kind === 'window' ? 1.8 : 1.2),
        height: input.height ?? (input.kind === 'window' ? 1.2 : 2.1)
      };
      const requestedOpenings = existingIndex >= 0
        ? roomOpenings.map((opening, index) => index === existingIndex ? requestedOpening : opening)
        : [...roomOpenings, requestedOpening];
      const normalizedRoom = normalizeMapRoom({
        ...room,
        openings: requestedOpenings
      }, map.box.size, room);
      const opening = normalizedRoom.openings.find((item) => item.id === id);
      if (!opening) throw new Error('invalid_map_code_room_opening');
      roomOpenings.splice(0, roomOpenings.length, ...normalizedRoom.openings);
      return opening.id;
    },
    sceneIntent(input: { kind: CodeSceneIntent; reason?: string }): CodeSceneIntent {
      record('sceneIntent');
      sceneIntentCallCount += 1;
      if (sceneIntentCallCount > 1) throw new Error('duplicate_map_code_scene_intent');
      if (!input || (input.kind !== 'natural' && input.kind !== 'authored')) {
        throw new Error('invalid_map_code_scene_intent');
      }
      if (sceneIntent && sceneIntent !== input.kind) throw new Error('conflicting_map_code_scene_intent');
      sceneIntent = input.kind;
      sceneIntentReason = cleanText(input.reason ?? input.kind, 120);
      return input.kind;
    },
    design(input: unknown): MapDesignSemantics {
      record('design');
      designCallCount += 1;
      if (designCallCount > 1) throw new Error('duplicate_map_code_design');
      designSemantics = normalizeMapDesignSemantics(input, map.box.size);
      return designSemantics;
    },
    move(input: MoveObjectInput): string {
      record('move');
      if (requestMode !== 'refine') throw new Error('map_code_refine_api_outside_refine');
      const objectId = String(input?.objectId ?? '').trim();
      const workingMap = sceneOperations.length > 0 ? applyMapOperations(map, sceneOperations) : map;
      const object = workingMap.objects.find((item) => item.id === objectId);
      if (!object) throw new Error(`unknown_map_code_object:${objectId}`);
      if (object.locked && !options.refinableObjectIds?.has(objectId)) throw new Error(`locked_map_code_object:${objectId}`);
      const transform: NonNullable<Extract<MapOperation, { type: 'object.update' }>['patch']['transform']> = {};
      let heightMode = object.heightMode;
      if (input.position !== undefined) {
        const terrain = map.sceneMode !== 'indoor' && placementUsesTerrain(input.position);
        transform.position = placementPosition(input.position, workingMap, terrain);
        heightMode = terrain ? 'terrain' : 'fixed';
      }
      if (input.rotationY !== undefined) transform.rotation = [0, finite(input.rotationY) * Math.PI / 180, 0];
      if (input.scale !== undefined) transform.scale = scale3(input.scale);
      if (Object.keys(transform).length === 0) throw new Error('empty_map_code_object_update');
      emitSceneOperation({ type: 'object.update', objectId, patch: { heightMode, transform } });
      return objectId;
    },
    removeObject(objectIdValue: string): string {
      record('removeObject');
      if (requestMode !== 'refine') throw new Error('map_code_refine_api_outside_refine');
      const objectId = String(objectIdValue ?? '').trim();
      const workingMap = sceneOperations.length > 0 ? applyMapOperations(map, sceneOperations) : map;
      const object = workingMap.objects.find((item) => item.id === objectId);
      if (!object) throw new Error(`unknown_map_code_object:${objectId}`);
      if (object.locked && !options.refinableObjectIds?.has(objectId)) throw new Error(`locked_map_code_object:${objectId}`);
      emitSceneOperation({ type: 'object.remove', objectId });
      return objectId;
    },
    updateWater(input: Record<string, unknown>): string {
      record('updateWater');
      if (requestMode !== 'refine') throw new Error('map_code_refine_api_outside_refine');
      const form = codeObject(input, 'invalid_map_code_water_update');
      const waterId = String(form.waterId ?? form.id ?? '').trim();
      const workingMap = sceneOperations.length > 0 ? applyMapOperations(map, sceneOperations) : map;
      if (!workingMap.waterBodies.some((item) => item.id === waterId)) throw new Error(`unknown_map_code_water:${waterId}`);
      emitSceneOperation({
        type: 'water.update',
        waterId,
        patch: {
          ...(form.name !== undefined ? { name: optionalString(form.name) } : {}),
          ...(form.level !== undefined ? { level: finite(form.level) } : {}),
          ...(form.depth !== undefined ? { depth: finite(form.depth) } : {}),
          ...(form.width !== undefined ? { width: finite(form.width) } : {}),
          ...(form.points !== undefined ? { points: codePointArray(form.points, 'invalid_map_code_water_points') } : {}),
          ...(form.shorelineSmoothness !== undefined ? { shorelineSmoothness: finite(form.shorelineSmoothness) } : {}),
          ...(form.shorelineIrregularity !== undefined ? { shorelineIrregularity: finite(form.shorelineIrregularity) } : {})
        }
      });
      return waterId;
    },
    removeWater(waterIdValue: string): string {
      record('removeWater');
      if (requestMode !== 'refine') throw new Error('map_code_refine_api_outside_refine');
      const waterId = String(waterIdValue ?? '').trim();
      const workingMap = sceneOperations.length > 0 ? applyMapOperations(map, sceneOperations) : map;
      if (!workingMap.waterBodies.some((item) => item.id === waterId)) throw new Error(`unknown_map_code_water:${waterId}`);
      emitSceneOperation({ type: 'water.remove', waterId });
      return waterId;
    },
    terrain(presetValue: string | Record<string, unknown>, optionsValue: Record<string, unknown> = {}): string {
      record('terrain');
      if (sceneOperations.some((operation) => operation.type === 'terrain.generate')) {
        throw new Error('map_code_base_terrain_already_generated');
      }
      const form = presetValue && typeof presetValue === 'object' && !Array.isArray(presetValue)
        ? codeObject(presetValue, 'invalid_map_code_terrain_form')
        : undefined;
      const preset = normalizeCodeTerrainPreset(String(form?.preset ?? presetValue ?? ''));
      if (!preset) throw new Error('invalid_map_code_terrain_preset');
      const options = form ?? codeObject(optionsValue, 'invalid_map_code_terrain_options');
      const params = normalizeTerrainGenerationParams({
        ...options,
        preset,
        amplitude: codeTerrainMagnitude(options.amplitude),
        direction: codeTerrainDirection(options.direction)
      }, map);
      emitSceneOperation({
        type: 'terrain.generate',
        ...params
      });
      return preset;
    },
    modifyTerrain(
      modifierValue: string | Record<string, unknown>,
      regionValue?: unknown,
      optionsValue: Record<string, unknown> = {}
    ): string {
      record('modifyTerrain');
      const form = modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)
        ? codeObject(modifierValue, 'invalid_map_code_terrain_modifier_form')
        : undefined;
      const rawModifier = String(form?.modifier ?? modifierValue ?? '');
      const modifier = normalizeCodeTerrainModifier(rawModifier);
      if (!modifier) {
        throw new Error(`invalid_map_code_terrain_modifier:${rawModifier}:expected=${TERRAIN_MODIFIERS.join('|')}`);
      }
      const options = form ?? codeObject(optionsValue, 'invalid_map_code_terrain_modifier_options');
      const region = form?.region ?? regionValue;
      const params = normalizeTerrainModifierParams({
        ...options,
        modifier,
        region: codeTerrainRegion(region),
        seed: options.seed ?? map.seed + sceneOperations.length,
        amplitude: codeTerrainMagnitude(options.amplitude),
        direction: codeTerrainDirection(options.direction),
        layers: codeTerrainLayerCount(options.layers),
        layout: codeTerrainLayout(options.layout, modifier),
        access: codeTerrainAccess(options.access)
      }, map);
      emitSceneOperation({
        type: 'terrain.modify',
        ...params
      });
      return modifier;
    },
    refineTerrain(optionsValue: Record<string, unknown> = {}): void {
      record('refineTerrain');
      const options = codeObject(optionsValue, 'invalid_map_code_terrain_refinement');
      const params = normalizeTerrainRefinementParams({
        ...options,
        iterations: codeTerrainLayerCount(options.iterations)
      });
      emitSceneOperation({
        type: 'terrain.refine',
        ...params
      });
    },
    surface(
      idValue: string | Record<string, unknown>,
      surfaceValue?: string,
      regionValue?: unknown,
      intensityValue = 1
    ): void {
      record('surface');
      const form = idValue && typeof idValue === 'object' && !Array.isArray(idValue)
        ? codeObject(idValue, 'invalid_map_code_surface_form')
        : undefined;
      const rawSurface = String(form?.surface ?? surfaceValue ?? '');
      const surface = normalizeCodeTerrainSurface(rawSurface);
      if (!surface) {
        throw new Error(`invalid_map_code_surface:${rawSurface}:expected=${TERRAIN_SURFACES.join('|')}`);
      }
      const surfaceId = form ? optionalString(form.id) : String(idValue ?? '');
      if (!surfaceId) throw new Error('invalid_map_code_surface_id');
      const region = form?.region ?? regionValue;
      const intensity = form?.intensity ?? intensityValue;
      const params = normalizeTerrainSurfaceParams({
        surface,
        material: form?.material,
        region: codeTerrainRegion(region),
        intensity,
        zoneId: `code:${cleanId(surfaceId, 'surface')}`,
        clearNatural: form?.clearNatural === true
      }, map);
      emitSceneOperation({
        type: 'terrain.surface',
        ...params
      });
    },
    route(input: RouteInput): string {
      record('route');
      return emitRoute(input);
    },
    routeNetwork(input: RouteNetworkInput): string[] {
      record('routeNetwork');
      if (!input || typeof input !== 'object' || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
        throw new Error('invalid_map_code_route_network');
      }
      const networkId = cleanId(input.id, 'network');
      const nodes = new Map<string, { point: Point2; role?: string }>();
      for (const raw of input.nodes.slice(0, 32)) {
        if (!raw || typeof raw !== 'object') continue;
        const id = cleanId(raw.id, 'node');
        if (nodes.has(id)) continue;
        nodes.set(id, { point: point2(raw.point), role: optionalString(raw.role) });
      }
      if (nodes.size < 2) throw new Error('invalid_map_code_route_network_nodes');
      return input.edges.slice(0, 64).map((edge, index) => {
        const from = nodes.get(cleanId(edge.from, 'node'));
        const to = nodes.get(cleanId(edge.to, 'node'));
        if (!from || !to) throw new Error('invalid_map_code_route_network_edge');
        const id = cleanId(edge.id ?? `${networkId}-${index + 1}`, `${networkId}-${index + 1}`);
        return emitRoute({
          ...edge,
          id,
          points: [from.point, ...codePointArray(edge.via ?? [], 'invalid_map_code_route_network_via'), to.point],
          tags: [
            ...(edge.tags ?? []),
            `network:${networkId}`,
            ...(from.role ? [`from:${from.role}`] : []),
            ...(to.role ? [`to:${to.role}`] : [])
          ]
        });
      });
    },
    streetGrid(input: StreetGridInput): { routeIds: string[]; blocks: MapPlannedBlock[] } {
      record('streetGrid');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_street_grid');
      const id = cleanId(input.id, 'settlement');
      const grid = createMapStreetGrid({
        idPrefix: id,
        region: codePointArray(input.region, 'invalid_map_code_street_grid_region'),
        direction: finite(input.direction ?? 0),
        blockWidth: clampFinite(input.blockWidth, 2, map.box.size[0]),
        blockDepth: clampFinite(input.blockDepth, 2, map.box.size[2]),
        roadWidth: clampFinite(input.roadWidth, 0.5, Math.min(map.box.size[0], map.box.size[2])),
        inset: clampFinite(input.inset ?? input.roadWidth / 2, 0, Math.min(map.box.size[0], map.box.size[2]) / 2),
        tags: normalizeAssetTags(['street', 'settlement', ...(input.tags ?? [])]) ?? ['street', 'settlement']
      });
      if (grid.streets.length === 0 || grid.blocks.length === 0) {
        throw new Error('map_code_street_grid_empty');
      }
      const routeIds = grid.streets.map((street) => emitRoute({
        id: street.id,
        name: street.name,
        points: street.points,
        curve: street.curve,
        closed: street.closed,
        width: street.width,
        surface: input.surface,
        material: input.material,
        intensity: input.intensity,
        tags: street.tags
      }));
      return {
        routeIds,
        blocks: grid.blocks.map((block) => ({
          id: block.id,
          points: block.points.map((point) => [...point] as Point2),
          center: [...block.center] as Point2
        }))
      };
    },
    placeAlongRoute(input: PlaceAlongRouteInput): string[] {
      record('placeAlongRoute');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_place_along_route');
      const routeId = cleanId(input.routeId, 'route');
      const workingMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
      const guide = workingMap.guides.find((candidate) => candidate.id === routeId);
      if (!guide) throw new Error(`unknown_map_code_route:${routeId}`);
      const spacing = clampFinite(input.spacing, 1, 80);
      const startOffset = clampFinite(input.startInset ?? 0, 0, Math.max(map.box.size[0], map.box.size[2]));
      const endOffset = clampFinite(input.endInset ?? 0, 0, Math.max(map.box.size[0], map.box.size[2]));
      const centerSamples = sampleMapGuide(guide, { spacing, startOffset, endOffset });
      const offset = Math.max(0.1, Math.abs(finite(input.offset ?? guide.width / 2 + 0.8)));
      const side = input.side ?? 'both';
      const leftSamples = sampleMapGuide(guide, { spacing, offset, startOffset, endOffset });
      const rightSamples = sampleMapGuide(guide, { spacing, offset: -offset, startOffset, endOffset });
      const references: string[] = [];
      const maxCount = Math.min(MAX_POINT_RESULTS, MAX_PLACEMENTS - placements.length);
      for (let index = 0; index < centerSamples.length && references.length < maxCount; index += 1) {
        const sides = side === 'both'
          ? [leftSamples[index], rightSamples[index]]
          : side === 'left'
            ? [leftSamples[index]]
            : side === 'right'
              ? [rightSamples[index]]
              : [index % 2 === 0 ? leftSamples[index] : rightSamples[index]];
        for (const sample of sides) {
          if (!sample || references.length >= maxCount) continue;
          const center = centerSamples[index];
          const facing: PlacementInput['facing'] = input.facing === 'toward-route'
            ? { target: [center.x, center.z] }
            : input.facing === 'away-from-route'
              ? { target: [sample.x * 2 - center.x, sample.z * 2 - center.z] }
              : { direction: [sample.tangentX, sample.tangentZ] };
          references.push(emitPlacement({
            assetId: input.assetId,
            name: input.name,
            position: [sample.x, sample.z],
            facing,
            scale: input.scale,
            dimensions: input.dimensions,
            size: input.size,
            terrain: input.terrain,
            role: input.role,
            groupId: input.groupId,
            layer: input.layer,
            sourceGuideId: guide.id
          }));
        }
      }
      return references;
    },
    placeStreetFrontage(input: PlaceStreetFrontageInput): string[] {
      record('placeStreetFrontage');
      if (!input || typeof input !== 'object' || !Array.isArray(input.items) || input.items.length === 0) {
        throw new Error('invalid_map_code_street_frontage');
      }
      if (input.side !== 'left' && input.side !== 'right') throw new Error('invalid_map_code_street_frontage_side');
      const routeId = cleanId(input.routeId, 'route');
      const workingMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
      const guide = workingMap.guides.find((candidate) => candidate.id === routeId);
      if (!guide) throw new Error(`unknown_map_code_route:${routeId}`);
      const points = mapGuidePolyline(guide);
      const routeLength = points.slice(1).reduce((sum, point, index) => (
        sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1])
      ), 0);
      const maxDimension = Math.max(map.box.size[0], map.box.size[1], map.box.size[2]);
      const items = input.items.slice(0, 32).map((item) => ({
        ...item,
        dimensions: point3(item.dimensions).map((value) => clampFinite(value, 0.2, maxDimension)) as Point3
      }));
      const gap = clampFinite(input.gap ?? 0.8, 0.2, 8);
      const setback = clampFinite(input.setback ?? 0.8, 0.2, 8);
      const startInset = clampFinite(input.startInset ?? 0, 0, routeLength);
      const endInset = clampFinite(input.endInset ?? 0, 0, routeLength);
      const requiredLength = startInset + endInset
        + items.reduce((sum, item) => sum + item.dimensions[0], 0)
        + gap * Math.max(0, items.length - 1);
      if (requiredLength > routeLength + 0.001) {
        throw new Error(`map_code_street_frontage_too_short:required=${requiredLength.toFixed(2)}:available=${routeLength.toFixed(2)}`);
      }
      const references: string[] = [];
      let cursor = startInset;
      for (const item of items) {
        cursor += item.dimensions[0] / 2;
        const sampleOptions = {
          spacing: routeLength + 1,
          startOffset: cursor,
          endOffset: routeLength - cursor
        };
        const center = sampleMapGuide(guide, sampleOptions)[0];
        const offset = guide.width / 2 + item.dimensions[2] / 2 + setback;
        const sample = sampleMapGuide(guide, {
          ...sampleOptions,
          offset: input.side === 'left' ? offset : -offset
        })[0];
        references.push(emitPlacement({
          ...item,
          position: [sample.x, sample.z],
          facing: { target: [center.x, center.z] },
          sourceGuideId: guide.id
        }));
        cursor += item.dimensions[0] / 2 + gap;
      }
      return references;
    },
    water(idValue: string, optionsValue: Record<string, unknown>): string {
      record('water');
      const options = codeObject(optionsValue, 'invalid_map_code_water_options');
      const type = String(options.type ?? '') as MapWaterBodyType;
      if (type !== 'lake' && type !== 'river' && type !== 'ocean') throw new Error('invalid_map_code_water_type');
      const points = codePointArray(options.points, 'invalid_map_code_water_points').slice(0, 64);
      if (points.length < (type === 'river' ? 2 : 3)) throw new Error('invalid_map_code_water_points');
      const id = cleanId(idValue, 'water');
      emitSceneOperation({
        type: 'water.add',
        water: {
          id,
          name: optionalString(options.name),
          type,
          points,
          width: optionalFinite(options.width),
          level: optionalFinite(options.level),
          depth: optionalFinite(options.depth),
          shorelineSmoothness: optionalFinite(options.shorelineSmoothness),
          shorelineIrregularity: optionalFinite(options.shorelineIrregularity),
          seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length
        }
      });
      return id;
    },
    grass(idValue: string | Record<string, unknown>, regionValue?: unknown, optionsValue: Record<string, unknown> = {}): string {
      record('grass');
      const form = idValue && typeof idValue === 'object' && !Array.isArray(idValue)
        ? codeObject(idValue, 'invalid_map_code_grass_form')
        : undefined;
      const regionForm = regionValue && typeof regionValue === 'object' && !Array.isArray(regionValue)
        ? regionValue as Record<string, unknown>
        : undefined;
      const options = form ?? {
        ...regionForm,
        ...codeObject(optionsValue, 'invalid_map_code_grass_options')
      };
      const idSource = form?.id ?? form?.name ?? idValue;
      const id = cleanId(idSource, 'grass');
      const name = optionalString(options.name) ?? (typeof idSource === 'string' ? idSource : undefined);
      const presetValue = optionalString(options.preset);
      const preset = GRASS_PRESET_IDS.includes(presetValue as GrassPresetId)
        ? presetValue as GrassPresetId
        : inferGrassPreset(`${presetValue ?? ''} ${name ?? ''}`);
      const presetDefinition = GRASS_PRESET_DEFINITIONS.find((item) => item.id === preset) ?? GRASS_PRESET_DEFINITIONS[0];
      const authored = sceneIntent === 'authored';
      const requestedHeight = optionalFinite(options.height) ?? presetDefinition.defaultHeight;
      const height = authored
        ? Math.max(preset === 'wetland' ? 0.85 : 0.65, requestedHeight)
        : requestedHeight;
      const requestedMix = options.mix && typeof options.mix === 'object' && !Array.isArray(options.mix)
        ? options.mix as Record<string, unknown>
        : undefined;
      const authoredMix = preset === 'meadow'
        ? { short: 0.62, tall: 0.34, flowers: 0.04 }
        : presetDefinition.defaultMix;
      const mix = normalizeGrassMix(requestedMix ? {
        short: optionalFinite(requestedMix.short),
        tall: optionalFinite(requestedMix.tall),
        flowers: optionalFinite(requestedMix.flowers)
      } : undefined, authored ? authoredMix : presetDefinition.defaultMix);
      const region = codeGrassRegion(form?.region ?? regionForm?.region ?? form ?? regionValue);
      const alreadyExists = map.grassLayers.some((layer) => layer.id === id)
        || sceneOperations.some((operation) => operation.type === 'grass.layer.add' && operation.layer.id === id);
      if (!alreadyExists) {
        emitSceneOperation({
          type: 'grass.layer.add',
          layer: {
            id,
            name,
            preset,
            height,
            mix,
            seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length
          }
        });
      }
      emitSceneOperation({
        type: 'grass.generate',
        layerId: id,
        region,
        density: authored
          ? Math.max(0.72, optionalFinite(options.density) ?? 0.78)
          : optionalFinite(options.density) ?? 0.65,
        variation: authored
          ? clampFinite(optionalFinite(options.variation) ?? 0.2, 0.12, 0.28)
          : optionalFinite(options.variation) ?? 0.25,
        softness: optionalFinite(options.softness) ?? 0.2,
        seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length
      });
      return id;
    },
    spawn(pointValue: Point2, yawDegrees = 0): void {
      record('spawn');
      spawnRequest = { point: point2(pointValue), yaw: finite(yawDegrees) * Math.PI / 180 };
    },
    renderSuggestion(text: string): void {
      record('renderSuggestion');
      const suggestion = cleanText(text, 240);
      if (!renderPromptSuggestions.includes(suggestion)) renderPromptSuggestions.push(suggestion);
    },
    clamp(value: number, min: number, max: number) {
      record('clamp');
      return clampFinite(value, min, max);
    },
    lerp(from: number, to: number, amount: number) {
      record('lerp');
      return finite(from) + (finite(to) - finite(from)) * finite(amount);
    },
    remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
      record('remap');
      const denominator = finite(inMax) - finite(inMin);
      if (Math.abs(denominator) < 0.000001) return finite(outMin);
      const amount = (finite(value) - finite(inMin)) / denominator;
      return finite(outMin) + (finite(outMax) - finite(outMin)) * amount;
    },
    smoothstep(min: number, max: number, value: number) {
      record('smoothstep');
      const amount = clampFinite((finite(value) - finite(min)) / Math.max(0.000001, finite(max) - finite(min)), 0, 1);
      return amount * amount * (3 - 2 * amount);
    },
    random(min = 0, max = 1) {
      record('random');
      return finite(min) + random() * (finite(max) - finite(min));
    },
    distance2D(left: Point2, right: Point2) {
      record('distance2D');
      const a = point2(left);
      const b = point2(right);
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    },
    rotate2D(point: Point2, angle: number, center: Point2 = [0, 0]): Point2 {
      record('rotate2D');
      const source = point2(point);
      const pivot = point2(center);
      const cosine = Math.cos(finite(angle));
      const sine = Math.sin(finite(angle));
      const x = source[0] - pivot[0];
      const z = source[1] - pivot[1];
      return codePoint(pivot[0] + x * cosine - z * sine, pivot[1] + x * sine + z * cosine);
    },
    mirrorPoint(point: Point2, axis: 'x' | 'z', coordinate = 0): Point2 {
      record('mirrorPoint');
      const source = point2(point);
      const center = finite(coordinate);
      if (axis === 'x') return codePoint(center * 2 - source[0], source[1]);
      if (axis === 'z') return codePoint(source[0], center * 2 - source[1]);
      throw new Error('invalid_map_code_mirror_axis');
    },
    linePoint(amount: number, from: Point2, to: Point2): Point2 {
      record('linePoint');
      const start = point2(from);
      const end = point2(to);
      const t = clampFinite(amount, 0, 1);
      return codePoint(start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t);
    },
    bezierPoint(amount: number, p0: Point2, p1: Point2, p2: Point2, p3: Point2) {
      record('bezierPoint');
      return bezierPoint(clampFinite(amount, 0, 1), point2(p0), point2(p1), point2(p2), point2(p3));
    },
    sampleBezier(p0: Point2, p1: Point2, p2: Point2, p3: Point2, segments = 16): Point2[] {
      record('sampleBezier');
      const count = boundedCount(segments, 1, MAX_POINT_RESULTS);
      return Array.from({ length: count + 1 }, (_, index) => (
        bezierPoint(index / count, point2(p0), point2(p1), point2(p2), point2(p3)).point
      ));
    },
    sampleBezierFrames(p0: Point2, p1: Point2, p2: Point2, p3: Point2, segments = 16) {
      record('sampleBezierFrames');
      const count = boundedCount(segments, 1, MAX_POINT_RESULTS);
      const start = point2(p0);
      const control1 = point2(p1);
      const control2 = point2(p2);
      const end = point2(p3);
      return Array.from({ length: count + 1 }, (_, index) => (
        bezierPoint(index / count, start, control1, control2, end)
      ));
    },
    sampleBezierFramesBySpacing(
      p0: Point2,
      p1: Point2,
      p2: Point2,
      p3: Point2,
      spacing: number,
      gapRatio = 0.08
    ) {
      record('sampleBezierFramesBySpacing');
      return sampleBezierFramesBySpacing(
        point2(p0),
        point2(p1),
        point2(p2),
        point2(p3),
        spacing,
        gapRatio
      );
    },
    circlePoint(index: number, count: number, radius: number, center: Point2 = [0, 0]): Point2 {
      record('circlePoint');
      const total = boundedCount(count, 1, MAX_POINT_RESULTS);
      const pivot = point2(center);
      const angle = finite(index) * Math.PI * 2 / total;
      const distance = Math.max(0, finite(radius));
      return codePoint(pivot[0] + Math.cos(angle) * distance, pivot[1] + Math.sin(angle) * distance);
    },
    ellipsePoint(
      index: number,
      count: number,
      radiusX: number,
      radiusZ: number,
      center: Point2 = [0, 0],
      phase = 0
    ): Point2 {
      record('ellipsePoint');
      const total = boundedCount(count, 3, MAX_POINT_RESULTS);
      const pivot = point2(center);
      const angle = finite(phase) + finite(index) * Math.PI * 2 / total;
      return codePoint(
        pivot[0] + Math.cos(angle) * Math.max(0, finite(radiusX)),
        pivot[1] + Math.sin(angle) * Math.max(0, finite(radiusZ))
      );
    },
    keepDry(pointValue: Point2, clearance = 0.8): Point2 {
      record('keepDry');
      const point = point2(pointValue);
      const environmentMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
      return nearestDryPoint(environmentMap, point, clampFinite(clearance, 0, 12));
    },
    waterPoint(waterIdValue: string, pointValue: Point2, draft = 0): Point3 {
      record('waterPoint');
      const waterId = cleanText(waterIdValue, 80);
      const point = point2(pointValue);
      const environmentMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
      const water = environmentMap.waterBodies.find((candidate) => candidate.id === waterId);
      if (!water) throw new Error(`unknown_map_code_water:${waterId}`);
      if (!isPointInsideWaterBody(water, point[0], point[1], environmentMap)) {
        throw new Error(`map_code_water_point_outside:${waterId}`);
      }
      return [point[0], waterSurfaceLevelAt(water, point[0], point[1]) - clampFinite(draft, 0, water.depth), point[1]];
    },
    gridPoints(options: { center?: Point2; columns: number; rows: number; spacing: number | Point2 }): Point2[] {
      record('gridPoints');
      const columns = boundedCount(options.columns, 1, MAX_POINT_RESULTS);
      const rows = boundedCount(options.rows, 1, Math.max(1, Math.floor(MAX_POINT_RESULTS / columns)));
      const center = point2(options.center ?? [0, 0]);
      const spacing = Array.isArray(options.spacing)
        ? point2(options.spacing)
        : [Math.max(0.01, finite(options.spacing)), Math.max(0.01, finite(options.spacing))] satisfies Point2;
      return Array.from({ length: rows * columns }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return codePoint(
          center[0] + (column - (columns - 1) / 2) * spacing[0],
          center[1] + (row - (rows - 1) / 2) * spacing[1]
        );
      });
    },
    noise2D(x: number, z: number, scale = 1, seed = map.seed) {
      record('noise2D');
      return valueNoise2D(finite(x) * finite(scale), finite(z) * finite(scale), Math.trunc(finite(seed)));
    },
    fbm2D(x: number, z: number, options: { scale?: number; octaves?: number; lacunarity?: number; gain?: number; seed?: number } = {}) {
      record('fbm2D');
      const octaves = boundedCount(options.octaves ?? 4, 1, 8);
      let amplitude = 1;
      let frequency = finite(options.scale ?? 1);
      let total = 0;
      let weight = 0;
      for (let octave = 0; octave < octaves; octave += 1) {
        total += valueNoise2D(finite(x) * frequency, finite(z) * frequency, Math.trunc(finite(options.seed ?? map.seed)) + octave * 1013) * amplitude;
        weight += amplitude;
        frequency *= finite(options.lacunarity ?? 2);
        amplitude *= finite(options.gain ?? 0.5);
      }
      return weight > 0 ? total / weight : 0;
    },
    poissonDisk(options: {
      bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
      minDistance: number;
      maxPoints?: number;
      attempts?: number;
      seed?: number;
    }): Point2[] {
      record('poissonDisk');
      const bounds = options.bounds ?? getMapBounds(map);
      return poissonDiskPoints(bounds, options.minDistance, options.maxPoints, options.attempts, options.seed ?? map.seed);
    },
    tangentYaw(tangent: Point2 | { tangent: Point2 }): number {
      record('tangentYaw');
      const direction = point2(
        tangent && typeof tangent === 'object' && !Array.isArray(tangent) && 'tangent' in tangent
          ? tangent.tangent
          : tangent
      );
      return Math.atan2(direction[0], direction[1]);
    },
    faceYaw(from: Point2, to: Point2): number {
      record('faceYaw');
      const origin = point2(from);
      const target = point2(to);
      return Math.atan2(target[0] - origin[0], target[1] - origin[1]);
    },
    requireAsset(input: CodeAssetRequirementInput): string {
      record('requireAsset');
      const requirement = normalizeCodeAssetRequirement(input, scope === 'scene', map.sceneMode);
      const existing = requirements.get(requirement.key);
      if (existing && !sameCodeAssetRequirement(existing, requirement)) {
        throw new Error(`conflicting_map_code_asset_requirement:${requirement.key}`);
      }
      if (!existing) {
        const requestedCount = [...requirements.values()]
          .reduce((total, item) => total + item.variants, 0) + requirement.variants;
        if (requestedCount > maxNewAssets) throw new Error('map_code_asset_requirement_limit');
        requirements.set(requirement.key, requirement);
      }
      return requirement.key;
    },
    asset(key: string, index = 0): string {
      record('asset');
      const normalizedKey = normalizeCodeAssetKey(key);
      const requirement = requirements.get(normalizedKey);
      if (!requirement) throw new Error(`unknown_map_code_asset_requirement:${normalizedKey}`);
      const variantIndex = positiveModulo(Math.trunc(finite(index)), requirement.variants);
      const role = requirement.role
        ?? (map.sceneMode === 'indoor' ? 'functional' : inferCodeAssetRole(requirement.tags.join(' ')));
      if (mode === 'discovery') {
        const placeholder = codeAssetPlaceholder(normalizedKey, variantIndex);
        roleByAssetId.set(placeholder, role);
        return placeholder;
      }
      const family = options.assetBindings?.get(normalizedKey);
      const asset = family?.[variantIndex];
      if (!asset) {
        const missingAssetId = codeMissingAsset(normalizedKey, variantIndex);
        roleByAssetId.set(missingAssetId, role);
        missingAssetBindings.add(missingAssetId);
        return missingAssetId;
      }
      roleByAssetId.set(asset.id, role);
      return asset.id;
    },
    place(input: PlacementInput): string {
      record('place');
      return emitPlacement(input);
    },
    foundation(input: FoundationInput): string {
      record('foundation');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_foundation');
      const linked = Array.isArray(input.under)
        ? [...new Set(input.under.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(0, 64)
        : [];
      const linkedPlacements = linked.flatMap((id) => placements.filter((placement) => placement.referenceId === id));
      const existingBounds = new Map(getMapObjectVisualAabbs(map).map((bounds) => [bounds.objectId, bounds]));
      const linkedBounds = linked.flatMap((id) => {
        const placement = linkedPlacements.find((candidate) => candidate.referenceId === id);
        if (placement) return [{
          min: [placement.position[0] - placement.size[0] * placement.scale[0] / 2, placement.position[2] - placement.size[2] * placement.scale[2] / 2] as Point2,
          max: [placement.position[0] + placement.size[0] * placement.scale[0] / 2, placement.position[2] + placement.size[2] * placement.scale[2] / 2] as Point2
        }];
        const bounds = existingBounds.get(id);
        return bounds ? [{ min: [bounds.min[0], bounds.min[2]] as Point2, max: [bounds.max[0], bounds.max[2]] as Point2 }] : [];
      });
      const explicit = input.position === undefined ? null : placementPosition(input.position, map, false);
      const margin = clampFinite(input.margin ?? 0.35, 0, 8);
      const minX = linkedBounds.length ? Math.min(...linkedBounds.map((bounds) => bounds.min[0])) : (explicit?.[0] ?? 0) - 2;
      const maxX = linkedBounds.length ? Math.max(...linkedBounds.map((bounds) => bounds.max[0])) : (explicit?.[0] ?? 0) + 2;
      const minZ = linkedBounds.length ? Math.min(...linkedBounds.map((bounds) => bounds.min[1])) : (explicit?.[2] ?? 0) - 2;
      const maxZ = linkedBounds.length ? Math.max(...linkedBounds.map((bounds) => bounds.max[1])) : (explicit?.[2] ?? 0) + 2;
      const centerX = explicit?.[0] ?? (minX + maxX) / 2;
      const centerZ = explicit?.[2] ?? (minZ + maxZ) / 2;
      const foundation = normalizeMapFoundation({
        ...input,
        shape: input.shape ?? 'rounded-rectangle',
        top: input.top ?? 'level',
        width: input.width ?? maxX - minX + margin * 2,
        depth: input.depth ?? maxZ - minZ + margin * 2,
        linkedObjectIds: linked
      });
      if (!foundation) throw new Error('invalid_map_code_foundation');
      const yaw = finite(input.rotationY ?? linkedPlacements[0]?.rotationY ?? 0);
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const boundary = foundationBoundary(foundation);
      const terrainHeights = boundary.map(([x, z]) => sampleTerrainHeight(
        map,
        centerX + x * cos + z * sin,
        centerZ - x * sin + z * cos
      ));
      const existingTopCandidates = linked.flatMap((id) => {
        const bounds = existingBounds.get(id);
        if (!bounds) return [];
        const objectX = (bounds.min[0] + bounds.max[0]) / 2;
        const objectZ = (bounds.min[2] + bounds.max[2]) / 2;
        const dx = objectX - centerX;
        const dz = objectZ - centerZ;
        return [bounds.min[1] - foundationTopHeight(foundation, dx * cos - dz * sin, dx * sin + dz * cos)];
      });
      const explicitTopY = explicit && !placementUsesTerrain(input.position) ? explicit[1] : undefined;
      const topY = explicitTopY
        ?? (existingTopCandidates.length > 0 ? Math.min(...existingTopCandidates) : undefined)
        ?? Math.max(...terrainHeights, sampleTerrainHeight(map, centerX, centerZ)) + 0.03;
      const requiredThickness = topY - Math.min(...terrainHeights, topY);
      if (requiredThickness > foundation.maxThickness + 0.001) {
        foundationWarnings.push(`${input.name ?? '地基'} 需要 ${requiredThickness.toFixed(2)}m 厚度，超过 ${foundation.maxThickness.toFixed(2)}m 上限，已跳过。`);
        return '';
      }
      return emitPlacement({
        name: input.name ?? (foundation.shape === 'path' ? '地基/海堤' : '建筑地基'),
        position: [centerX, topY, centerZ],
        rotationY: yaw,
        terrain: false,
        role: 'structure',
        foundation
      });
    },
    attach(input: AttachmentInput): string {
      record('attach');
      if (placements.length >= MAX_PLACEMENTS) throw new Error('map_code_plan_too_many_placements');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_attachment');
      const parentId = cleanText(input.parentId, 120);
      if (!parentId) throw new Error('invalid_map_code_attachment_parent');
      const referenceId = codePlacementReference(placements.length);
      const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : null;
      if (requestedAssetId && isCodeMissingAsset(requestedAssetId)) return referenceId;
      let assetId = requestedAssetId;
      if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
        assetId = resolveMapCodeAssetId(input.name, assets);
        if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
      }
      const asset = assetId ? assetById.get(assetId) : undefined;
      const semantic = [input.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
      const entranceBottomAnchor = input.anchorY === undefined && ENTRANCE_ASSET.test(semantic);
      const attachmentOffset = input.offset ? point2(input.offset) : undefined;
      if (entranceBottomAnchor && attachmentOffset) attachmentOffset[1] = 0;
      const anchorY = normalizeAttachmentAnchor(input.anchorY) ?? (entranceBottomAnchor ? 'bottom' : undefined);
      const role = roleByAssetId.get(assetId ?? '')
        ?? normalizeCodePlacementRole(input.role, map.sceneMode)
        ?? (map.sceneMode === 'indoor' ? 'decor' : inferCodeAssetRole(semantic));
      const parentPlacement = placements.find((placement) => placement.referenceId === parentId);
      const existingParent = map.objects.find((object) => object.id === parentId);
      const fallbackPosition = parentPlacement?.position
        ?? existingParent?.transform.position
        ?? [0, sampleTerrainHeight(map, 0, 0), 0];
      placements.push({
        referenceId,
        assetId,
        name: cleanText(input.name ?? asset?.name ?? '室内附件', 80),
        position: [...fallbackPosition],
        rotationY: finite(input.rotationY ?? 0),
        scale: scale3(input.scale ?? 1),
        size: [1, 1, 1],
        heightMode: 'fixed',
        role,
        semantic,
        ...placementDesignMetadata(input.groupId, input.layer),
        attachment: {
          parentId,
          kind: input.kind === 'mounted' ? 'mounted' : 'supported',
          ...(input.side ? { side: normalizeRoomWall(input.side) } : {}),
          ...(attachmentOffset ? { offset: attachmentOffset } : {}),
          ...(input.contact === undefined ? {} : { contact: finite(input.contact) }),
          ...(anchorY ? { anchorY } : {})
        }
      });
      return referenceId;
    },
    bridge(input: BridgeInput): void {
      record('bridge');
      if (placements.length >= MAX_PLACEMENTS) throw new Error('map_code_plan_too_many_placements');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_bridge');
      let replacementAssetId: string | undefined;
      if (input.replaceObjectId !== undefined) {
        if (requestMode !== 'refine') throw new Error('map_code_bridge_replace_outside_refine');
        const objectId = String(input.replaceObjectId).trim();
        const workingMap = sceneOperations.length > 0 ? applyMapOperations(map, sceneOperations) : map;
        const object = workingMap.objects.find((item) => item.id === objectId);
        if (!object) throw new Error(`unknown_map_code_object:${objectId}`);
        const objectAsset = object.assetId ? assetById.get(object.assetId) : undefined;
        const semantic = [object.name, objectAsset?.name, objectAsset?.prompt, ...(objectAsset?.tags ?? [])]
          .filter(Boolean)
          .join(' ');
        if (!/\bbridge\b|桥/i.test(semantic)) throw new Error(`map_code_bridge_replace_non_bridge:${objectId}`);
        replacementAssetId = object.assetId ?? undefined;
        emitSceneOperation({ type: 'object.remove', objectId });
      }
      const waterId = cleanId(input.waterId, 'water');
      const environmentMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
      const water = environmentMap.waterBodies.find((item) => item.id === waterId);
      if (!water) throw new Error(`unknown_map_code_bridge_water:${waterId}`);
      const center = point2(input.crossingCenter);
      const rawDirection = point2(input.direction);
      const directionLength = Math.hypot(rawDirection[0], rawDirection[1]);
      if (directionLength < 0.000001) throw new Error('invalid_map_code_bridge_direction');
      const direction: Point2 = [rawDirection[0] / directionLength, rawDirection[1] / directionLength];
      const dimensions = point3(input.dimensions ?? input.size ?? [2, 1, 4]);
      if (dimensions[2] <= 0.000001) throw new Error('invalid_map_code_bridge_dimensions');
      const crossing = solveWaterCrossing(water, center, direction, input.bankInset ?? 1, dimensions[0]);
      const bridgeCenter: Point2 = [
        (crossing.start[0] + crossing.end[0]) / 2,
        (crossing.start[1] + crossing.end[1]) / 2
      ];
      const distance = Math.hypot(crossing.end[0] - crossing.start[0], crossing.end[1] - crossing.start[1]);
      const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim()
        ? input.assetId.trim()
        : replacementAssetId ?? null;
      if (requestedAssetId && isCodeMissingAsset(requestedAssetId)) return;
      let assetId = requestedAssetId;
      if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
        assetId = resolveMapCodeAssetId(input.name, assets);
        if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
      }
      const asset = assetId ? assetById.get(assetId) : undefined;
      const role = roleByAssetId.get(assetId ?? '') ?? input.role ?? 'structure';
      const scale = scale3(input.scale ?? 1);
      let localMinY = 0;
      if (asset) {
        const bounds = assetBoundsById.get(asset.id)!;
        const actualDimensions: Point3 = [
          Math.max(0.000001, bounds.max[0] - bounds.min[0]),
          Math.max(0.000001, bounds.max[1] - bounds.min[1]),
          Math.max(0.000001, bounds.max[2] - bounds.min[2])
        ];
        for (let axis = 0; axis < 3; axis += 1) scale[axis] /= actualDimensions[axis];
        localMinY = bounds.min[1];
      }
      const supportHeight = Math.max(
        waterSurfaceLevelAt(water, bridgeCenter[0], bridgeCenter[1]) + clampFinite(input.deckClearance ?? 0.2, 0.05, 3),
        sampleTerrainHeight(environmentMap, crossing.start[0], crossing.start[1]),
        sampleTerrainHeight(environmentMap, crossing.end[0], crossing.end[1])
      );
      const bridgeName = cleanText(input.name ?? asset?.name ?? '跨水桥', 80);
      const semantic = [input.name, asset?.name, asset?.prompt, ...(asset?.tags ?? []), 'bridge'].filter(Boolean).join(' ');
      const metadata = placementDesignMetadata(input.groupId, input.layer);
      const curvePoints = input.kind === 'curved'
        ? quadraticBridgePoints(
            crossing.start,
            crossing.end,
            clampFinite(input.curveOffset ?? distance * 0.12, -distance * 0.4, distance * 0.4),
            clampInteger(input.segmentCount ?? Math.ceil(distance / Math.max(1, dimensions[2])), 3, 24)
          )
        : [crossing.start, crossing.end];
      emitSceneOperation({
        type: 'guide.upsert',
        guide: {
          id: cleanId(`bridge-route-${waterId}-${placements.length}`, 'bridge-route'),
          name: `${bridgeName}动线`,
          points: curvePoints,
          curve: input.kind === 'curved' ? 'catmull-rom' : 'polyline',
          closed: false,
          width: dimensions[0],
          tags: ['route', 'bridge', 'circulation']
        }
      });
      for (let index = 0; index < curvePoints.length - 1; index += 1) {
        const start = curvePoints[index];
        const end = curvePoints[index + 1];
        const segmentDirection: Point2 = [end[0] - start[0], end[1] - start[1]];
        const segmentLength = Math.hypot(segmentDirection[0], segmentDirection[1]);
        const targetSize: Point3 = [dimensions[0], dimensions[1], segmentLength];
        placements.push({
          referenceId: codePlacementReference(placements.length),
          assetId,
          name: curvePoints.length > 2 ? `${bridgeName} ${index + 1}` : bridgeName,
          position: [
            (start[0] + end[0]) / 2,
            supportHeight - localMinY * scale[1] * targetSize[1],
            (start[1] + end[1]) / 2
          ],
          rotationY: yawFromDirection(segmentDirection),
          scale: [...scale],
          size: targetSize,
          heightMode: 'fixed',
          role,
          semantic,
          bridgeWaterId: waterId,
          ...metadata
        });
      }
      if (input.abutments !== false) {
        const abutmentSize: Point3 = [dimensions[0] + 0.6, 0.35, 1.2];
        for (const [index, point] of [crossing.start, crossing.end].entries()) {
          placements.push({
            referenceId: codePlacementReference(placements.length),
            assetId: null,
            name: `${bridgeName}桥台 ${index + 1}`,
            position: [point[0], supportHeight - abutmentSize[1] / 2, point[1]],
            rotationY: yawFromDirection(direction),
            scale: [1, 1, 1],
            size: abutmentSize,
            heightMode: 'fixed',
            role: 'structure',
            semantic: 'bridge abutment 桥台',
            bridgeWaterId: waterId,
            ...metadata
          });
        }
      }
    },
    placeBetween(input: PlaceBetweenInput): void {
      record('placeBetween');
      if (placements.length >= MAX_PLACEMENTS) throw new Error('map_code_plan_too_many_placements');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_placement');
      const start = point2(input.start);
      const end = point2(input.end);
      const direction = codePoint(end[0] - start[0], end[1] - start[1]);
      const distance = Math.hypot(direction[0], direction[1]);
      if (!Number.isFinite(distance) || distance < 0.000001) throw new Error('invalid_map_code_connection');
      let spanAxis: 'x' | 'z' = input.spanAxis === 'z' ? 'z' : 'x';
      let spanIndex = spanAxis === 'x' ? 0 : 2;
      const gapRatio = clampFinite(input.gapRatio ?? 0, 0, 0.25);
      const fittedLength = distance * (1 - gapRatio);
      const dimensions = point3(input.dimensions ?? input.size ?? [1, 1, 1]);
      const center: Point2 = codePoint(
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2
      );
      const terrain = map.sceneMode !== 'indoor' && input.terrain !== false;
      const position = placementPosition(center, map, terrain);
      const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : null;
      if (requestedAssetId && isCodeMissingAsset(requestedAssetId)) return;
      let assetId = requestedAssetId;
      if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
        assetId = resolveMapCodeAssetId(input.name, assets);
        if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
      }
      const asset = assetId ? assetById.get(assetId) : undefined;
      const semantic = [input.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
      if (ARENA_SEATING_ASSET.test(semantic)) {
        spanAxis = 'x';
        spanIndex = 0;
      }
      if (dimensions[spanIndex] <= 0.000001) throw new Error('invalid_map_code_connection_dimensions');
      const lineRotation = spanAxis === 'x'
        ? Math.atan2(-direction[1], direction[0])
        : yawFromDirection(direction);
      const frontTarget = input.frontTarget
        ? point2(input.frontTarget)
        : ARENA_SEATING_ASSET.test(semantic) && input.facing && !Array.isArray(input.facing) && input.facing.target
          ? point2(input.facing.target)
          : undefined;
      const role = roleByAssetId.get(assetId ?? '')
        ?? normalizeCodePlacementRole(input.role, map.sceneMode)
        ?? (map.sceneMode === 'indoor' ? 'functional' : inferCodeAssetRole([
          input.name,
          asset?.name,
          asset?.prompt,
          ...(asset?.tags ?? [])
        ].filter(Boolean).join(' ')));
      const targetSize: Point3 = [...dimensions];
      targetSize[spanIndex] = fittedLength;
      const scale = scale3(input.scale ?? 1);
      const boundAsset = assetId ? assetById.get(assetId) : undefined;
      if (boundAsset) {
        const bounds = assetBoundsById.get(boundAsset.id)!;
        const actualDimensions: Point3 = [
          Math.max(0.000001, bounds.max[0] - bounds.min[0]),
          Math.max(0.000001, bounds.max[1] - bounds.min[1]),
          Math.max(0.000001, bounds.max[2] - bounds.min[2])
        ];
        for (let axis = 0; axis < 3; axis += 1) scale[axis] /= actualDimensions[axis];
      }
      placements.push({
        referenceId: codePlacementReference(placements.length),
        assetId,
        name: cleanText(input.name ?? assetById.get(assetId ?? '')?.name ?? '程序化连接', 80),
        position,
        rotationY: frontTarget
          ? parallelYawFacingTarget(lineRotation, center, frontTarget)
          : input.facing === undefined
          ? lineRotation
          : placementRotation(input.facing, position, lineRotation),
        scale,
        size: targetSize,
        heightMode: terrain ? 'terrain' : 'fixed',
        role,
        semantic,
        connectionMode: 'explicit',
        connection: { start, end, spanAxis, gapRatio, ...(frontTarget ? { frontTarget } : {}) },
        ...placementDesignMetadata(input.groupId, input.layer)
      });
    }
  });

  const script = new vm.Script(`${cleanCode}\n;if (typeof plan !== 'function') throw new Error('missing_plan_function');\nplan(api);`, {
    filename: 'worldforge-map-plan.js'
  });
  const context = vm.createContext({
    api,
    Math: safeMath(random),
    console: Object.freeze({ log() {}, warn() {}, error() {} })
  }, {
    codeGeneration: { strings: false, wasm: false }
  });
  const emitDiscoveryDraft = (interrupted: boolean): void => {
    if (mode !== 'discovery' || !options.onPlanPreview) return;
    if (placements.length === 0 && sceneOperations.length === 0) return;
    const draftRoomOperation = indoorRoom
      ? [{ type: 'room.set', room: { ...indoorRoom, openings: roomOpenings } } satisfies MapOperation]
      : [];
    const plan = distillDraftCodePlanPreview(
      placements,
      [...requirements.values()],
      [...draftRoomOperation, ...sceneOperations]
    );
    options.onPlanPreview(interrupted
      ? { ...plan, summary: `代码执行中断：已产生 ${placements.length} 个摆放，正在自动修复` }
      : plan);
  };
  const returned = (() => {
    try {
      return script.runInContext(context, {
        timeout: options.executionTimeoutMs ?? DISCOVERY_EXECUTION_TIMEOUT_MS
      });
    } catch (error) {
      // A crashed attempt still placed real content before dying; show it so
      // the user watches each repair iteration rather than an empty scene.
      emitDiscoveryDraft(true);
      throw error;
    }
  })();
  if (returned && typeof returned.then === 'function') {
    emitDiscoveryDraft(true);
    throw new Error('async_map_code_plan_not_supported');
  }
  // Stream every executed discovery attempt immediately, even ones the checks
  // below will repair away: the user sees the code's first version and each
  // repair iteration rather than waiting for a validated plan.
  emitDiscoveryDraft(false);
  if (indoorRoom && sceneOperations.some((operation) => (
    operation.type.startsWith('terrain.') || operation.type.startsWith('water.') || operation.type.startsWith('grass.')
  ))) {
    throw new Error('indoor_map_code_outdoor_operation');
  }
  if (indoorRoom && placements.some((placement) => INDOOR_FORBIDDEN_CONTENT.test(placement.semantic))) {
    throw new Error('indoor_map_code_forbidden_content');
  }
  if (map.sceneMode === 'outdoor' && requestMode === 'generate' && scope === 'scene' && !sceneIntent) {
    throw new Error('missing_map_code_scene_intent');
  }
  if (map.sceneMode === 'outdoor' && mode === 'discovery' && requestMode === 'generate' && sceneIntent === 'authored'
    && !placements.some((placement) => placement.role === 'structure')) {
    throw new Error('authored_scene_missing_structure');
  }
  if (placements.length === 0 && sceneOperations.length === 0 && missingAssetBindings.size === 0) {
    throw new Error('empty_map_code_plan');
  }
  if (mode === 'discovery') {
    const requestedAssetCount = [...requirements.values()].reduce((total, requirement) => total + requirement.variants, 0);
    if (requestedAssetCount < (options.minNewAssets ?? 0)) throw new Error('map_code_asset_minimum_not_met');
    const placedAssetIds = new Set(placements.flatMap((placement) => placement.assetId ? [placement.assetId] : []));
    const unusedVariants = [...requirements.values()].flatMap((requirement) => (
      Array.from({ length: requirement.variants }, (_, index) => codeAssetPlaceholder(requirement.key, index))
        .filter((assetId) => !placedAssetIds.has(assetId))
    ));
    if (unusedVariants.length > 0) throw new Error(`unused_map_code_asset_variants:${unusedVariants.join(',')}`);
  }

  const planningMap: EditableMap = {
    ...map,
    assets: [...new Map([...(map.assets ?? []), ...assets].map((asset) => [asset.id, asset])).values()]
  };
  if (mode === 'final' && map.sceneMode === 'outdoor') fitConnectedPlacementRuns(placements, planningMap.assets ?? []);
  const roomOperation = indoorRoom
    ? { type: 'room.set', room: { ...indoorRoom, openings: roomOpenings } } satisfies MapOperation
    : null;
  const baseOperations = [...(roomOperation ? [roomOperation] : []), ...sceneOperations];
  const terrainMap = baseOperations.length > 0
    ? applyMapOperations(planningMap, baseOperations)
    : planningMap;
  const objectOperations: Extract<MapOperation, { type: 'object.add' }>[] = [];
  const objectIdByReference = new Map<string, string>();
  let workingMap = terrainMap;
  let attachmentFallbackCount = 0;
  for (const placement of placements) {
    const objectId = createId('obj-code');
    let object: Extract<MapOperation, { type: 'object.add' }>['object'];
    if (placement.attachment) {
      const parentId = objectIdByReference.get(placement.attachment.parentId)
        ?? (workingMap.objects.some((item) => item.id === placement.attachment!.parentId)
          ? placement.attachment.parentId
          : null);
      const asset = placement.assetId
        ? (workingMap.assets ?? []).find((item) => item.id === placement.assetId)
        : undefined;
      if (parentId && asset) {
        try {
          object = planMapObjectAttachment(workingMap, {
            id: objectId,
            name: placement.name,
            parentId,
            asset,
            kind: placement.attachment.kind,
            side: placement.attachment.side,
            scale: placement.scale[0],
            yaw: placement.rotationY,
            offset: placement.attachment.offset,
            contact: placement.attachment.contact,
            anchorY: placement.attachment.anchorY
          });
          Object.assign(object, {
            locked: map.sceneMode === 'outdoor' && placement.role === 'structure',
            ...(placement.designGroupId ? { designGroupId: placement.designGroupId } : {}),
            ...(placement.compositionLayer ? { compositionLayer: placement.compositionLayer } : {})
          });
        } catch {
          attachmentFallbackCount += mode === 'final' ? 1 : 0;
          object = placementObject(placement, objectId, terrainMap, map.sceneMode);
        }
      } else {
        attachmentFallbackCount += mode === 'final' ? 1 : 0;
        object = placementObject(placement, objectId, terrainMap, map.sceneMode);
      }
    } else {
      object = placementObject(placement, objectId, terrainMap, map.sceneMode);
    }
    const operation = { type: 'object.add', object } satisfies Extract<MapOperation, { type: 'object.add' }>;
    objectOperations.push(operation);
    objectIdByReference.set(placement.referenceId, objectId);
    workingMap = applyMapOperations(workingMap, [operation]);
  }
  const linkedObjectUpdates: Extract<MapOperation, { type: 'object.update' }>[] = [];
  for (const operation of objectOperations) {
    const foundation = operation.object.foundation;
    if (!foundation) continue;
    const linkedObjectIds = foundation.linkedObjectIds
      .map((id) => objectIdByReference.get(id) ?? id)
      .filter((id) => workingMap.objects.some((object) => object.id === id));
    operation.object.foundation = { ...foundation, linkedObjectIds };
    const basePosition = operation.object.transform?.position ?? [0, 0, 0];
    const yaw = operation.object.transform?.rotation?.[1] ?? 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const linkedObjectId of linkedObjectIds) {
      const linkedAdd = objectOperations.find((candidate) => candidate.object.id === linkedObjectId);
      const linkedObject = linkedAdd?.object ?? workingMap.objects.find((object) => object.id === linkedObjectId);
      if (!linkedObject) continue;
      if (!linkedAdd && linkedObject.locked && !options.refinableObjectIds?.has(linkedObjectId)) continue;
      const position = [...(linkedObject.transform?.position ?? [0, 0, 0])] as Point3;
      const dx = position[0] - basePosition[0];
      const dz = position[2] - basePosition[2];
      const localX = dx * cos - dz * sin;
      const localZ = dx * sin + dz * cos;
      position[1] = basePosition[1] + foundationTopHeight(foundation, localX, localZ);
      if (linkedAdd) {
        linkedAdd.object.heightMode = 'fixed';
        linkedAdd.object.transform = { ...linkedAdd.object.transform, position };
      } else {
        linkedObjectUpdates.push({ type: 'object.update', objectId: linkedObjectId, patch: { heightMode: 'fixed', transform: { position } } });
      }
    }
  }
  const waterRepair = map.sceneMode === 'outdoor'
    ? relocateOutdoorWaterIntrusions(terrainMap, objectOperations, placements, assets)
    : { operations: objectOperations, count: 0 };
  const accessRepair = map.sceneMode === 'outdoor' && scope === 'scene'
    ? relocateOutdoorAccessBlockers(terrainMap, waterRepair.operations, assets)
    : { operations: waterRepair.operations, count: 0 };
  const operations: MapOperation[] = [
    ...baseOperations,
    ...accessRepair.operations,
    ...linkedObjectUpdates
  ];
  if (designCallCount > 0 || map.designSemantics.groups.length > 0) {
    designSemantics = remapMapDesignObjectReferences(designSemantics, objectIdByReference);
    const placedMap = applyMapOperations(planningMap, operations);
    designSemantics = resolveMapDesignFocusObjects(placedMap, designSemantics);
    const relationOperations = compileMapDesignRelations(placedMap, designSemantics);
    operations.push(...relationOperations);
    const relatedMap = relationOperations.length > 0
      ? applyMapOperations(placedMap, relationOperations)
      : placedMap;
    const pruningOperations = compileMapDesignPruning(relatedMap, designSemantics);
    operations.push(...pruningOperations);
    const prunedMap = pruningOperations.length > 0
      ? applyMapOperations(relatedMap, pruningOperations)
      : relatedMap;
    operations.push(...compileMapDesignDensityFill(prunedMap, designSemantics));
    operations.push({ type: 'map.update', designSemantics });
  }
  const clearanceOperations = map.sceneMode === 'outdoor' && operations.length > 0
    ? compileMapNaturalClearance(applyMapOperations(planningMap, operations))
    : [];
  operations.push(...clearanceOperations);
  if (map.sceneMode === 'outdoor' && ((requestMode === 'generate' && scope === 'scene') || spawnRequest)) {
    const candidate = applyMapOperations(planningMap, operations);
    const requestedSpawn = spawnRequest?.point
      ?? (map.spawnPoints[0] ? [map.spawnPoints[0][0], map.spawnPoints[0][2]] satisfies Point2 : [0, 0]);
    const [spawnX, spawnZ] = findSafeSpawnPosition(candidate, requestedSpawn[0], requestedSpawn[1]);
    operations.push({
      type: 'reference.set',
      point: [spawnX, sampleTerrainHeight(candidate, spawnX, spawnZ), spawnZ],
      yaw: spawnRequest?.yaw ?? map.spawnYaw
    });
  }
  if (operations.length === 0 && missingAssetBindings.size > 0) {
    const point = map.spawnPoints[0] ?? [0, sampleTerrainHeight(map, 0, 0), 0];
    operations.push({ type: 'reference.set', point, yaw: map.spawnYaw });
  }
  const suggestion: MapAiSuggestion = {
    summary: map.sceneMode === 'indoor'
      ? `室内功能规划生成了 ${placements.length} 个摆放意图与 ${roomOpenings.length} 个门窗预留`
      : `整体 Code 生成了 ${placements.length} 个摆放意图与 ${sceneOperations.length} 项环境操作`,
    operations,
    renderPromptSuggestions,
    generatedAssets: [],
    codePlan: {
      code: cleanCode,
      placementCount: placements.length,
      functions: [...usedFunctions].sort(),
      sceneIntent,
      sceneIntentReason: sceneIntentReason || undefined
    }
  };
  const accessDiagnostics = accessRepair.count > 0 ? [{
    code: 'outdoor.access-repaired' as const,
    severity: 'warning' as const,
    message: `已移动 ${accessRepair.count} 个阻挡入口通道的环境物体。`,
    repaired: true
  }] : [];
  const waterDiagnostics = waterRepair.count > 0 ? [{
    code: 'outdoor.water-intrusion-repaired' as const,
    severity: 'warning' as const,
    message: `已将 ${waterRepair.count} 个必须落在旱地上的物体移出水面。`,
    repaired: true
  }] : [];
  const clearanceDiagnostics = clearanceOperations.length > 0 ? [{
    code: 'outdoor.clearance-repaired' as const,
    severity: 'warning' as const,
    message: `已剔除 ${clearanceOperations.length} 个侵入道路或功能空地的自然装饰。`,
    repaired: true
  }] : [];
  const attachmentDiagnostics = attachmentFallbackCount > 0 ? [{
    code: 'object.invalid-support' as const,
    severity: 'warning' as const,
    message: `${attachmentFallbackCount} 个附件无法安全连接到父物体，已保留为独立可编辑物体。`,
    repaired: true
  }] : [];
  const unresolvedBridgeDiagnostics = map.sceneMode === 'outdoor' && placements.some((placement) => (
    !placement.bridgeWaterId && /\bbridge\b|桥/i.test(placement.semantic)
  )) ? [{
    code: 'bridge.unresolved-crossing' as const,
    severity: 'warning' as const,
    message: '桥梁未使用跨水求解器，无法确认水面高度和两岸连接；可通过“调整当前地图”让 AI 定向修复。',
    repaired: false
  }] : [];
  const missingDesignDiagnostics = map.sceneMode === 'outdoor' && scope === 'scene'
    && requestMode === 'generate' && designCallCount === 0 ? [{
      code: 'scene.design-missing' as const,
      severity: 'warning' as const,
      message: '本轮 Code 未填写设计组与焦点表，场景仍可应用；可点击“调整当前地图”补充构图语义。',
      repaired: false
    }] : [];
  const repairableObjectIds = new Set([
    ...objectOperations.map((operation) => operation.object.id!),
    ...(options.refinableObjectIds ?? [])
  ]);
  const validated = validateMapSuggestion(planningMap, {
    ...suggestion,
    diagnostics: [
      ...waterDiagnostics, ...accessDiagnostics, ...clearanceDiagnostics, ...attachmentDiagnostics,
      ...unresolvedBridgeDiagnostics, ...missingDesignDiagnostics,
      ...foundationWarnings.map((message) => ({
        code: 'foundation.max-thickness' as const,
        severity: 'warning' as const,
        message,
        repaired: false
      }))
    ]
  }, { repairableObjectIds }).suggestion;
  return {
    suggestion: unresolvedAssetIds.size === 0 ? validated : {
      ...validated,
      diagnostics: [...(validated.diagnostics ?? []), {
        code: 'asset.unplaced',
        severity: 'warning',
        message: `Code 规划引用了 ${unresolvedAssetIds.size} 个不存在的资产 ID，已按名称匹配或降级为编辑器代理。`,
        repaired: true
      }]
    },
    requirements: [...requirements.values()]
  };
}

function withCodePlanDetails(
  suggestion: MapAiSuggestion,
  requirements: readonly CodeAssetRequirement[],
  repairAttempts: number
): MapAiSuggestion {
  if (!suggestion.codePlan) return suggestion;
  return {
    ...suggestion,
    codePlan: {
      ...suggestion.codePlan,
      repairAttempts,
      assetRequirements: requirements.map((requirement) => ({
        key: requirement.key,
        name: requirement.name,
        variants: requirement.variants,
        ...(requirement.dimensions ? { dimensions: requirement.dimensions } : {}),
        ...(requirement.role ? { role: requirement.role } : {}),
        ...(requirement.optional ? { optional: true } : {})
      })),
      diagnostics: (suggestion.diagnostics ?? []).slice(0, 100).map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        repaired: issue.repaired
      }))
    }
  };
}

/** Environment-only operations safe to visualize before objects exist. */
const SCENE_PREVIEW_OPERATION_TYPES = new Set([
  'room.set',
  'terrain.set',
  'terrain.generate',
  'terrain.brush',
  'terrain.modify',
  'terrain.refine',
  'terrain.surface',
  'water.add',
  'water.update',
  'water.remove',
  'grass.layer.add',
  'grass.layer.update',
  'grass.layer.remove',
  'grass.fill',
  'grass.brush',
  'grass.generate',
  'guide.upsert',
  'guide.remove',
  'reference.set',
  'sun.set',
  'paint.add'
]);

function scenePreviewOperations(operations: readonly MapOperation[]): MapOperation[] {
  return operations.filter((operation) => SCENE_PREVIEW_OPERATION_TYPES.has(operation.type)
    || (operation.type === 'object.add' && Boolean(operation.object.foundation)));
}

function isUnitFootprint(value: readonly number[]): boolean {
  return value.every((axis) => Math.abs(axis - 1) <= 0.05);
}

function requirementDimensionsByKey(
  requirements: readonly CodeAssetRequirement[]
): Map<string, Point3> {
  return new Map(
    requirements
      .filter((requirement) => requirement.dimensions)
      .map((requirement) => [requirement.key, requirement.dimensions as Point3])
  );
}

function requirementPreviews(requirements: readonly CodeAssetRequirement[]): CodePlanRequirementPreview[] {
  return requirements.map((requirement) => ({
    key: requirement.key,
    name: requirement.name,
    variants: requirement.variants,
    ...(requirement.role ? { role: requirement.role } : {}),
    ...(requirement.optional ? { optional: true } : {})
  }));
}

function placeholderKeyOf(assetId: string | null): string | null {
  return assetId && isCodePlanPlaceholderAssetId(assetId)
    ? assetId.slice('code-asset://'.length).split('/')[0]
    : null;
}

function distillDraftCodePlanPreview(
  placements: readonly PlacementIntent[],
  requirements: readonly CodeAssetRequirement[],
  sceneOperations: readonly MapOperation[]
): CodePlanPreviewPayload {
  const dimensionsByKey = requirementDimensionsByKey(requirements);
  return {
    summary: `代码已执行：${placements.length} 个摆放意图，等待校验与资产生成`,
    placements: placements.map((placement): CodePlanPlacementPreview => {
      const placeholderKey = placeholderKeyOf(placement.assetId);
      const resolvedSize = placeholderKey && isUnitFootprint(placement.size)
        ? dimensionsByKey.get(placeholderKey) ?? placement.size
        : placement.size;
      return {
        objectId: placement.referenceId,
        name: placement.name,
        assetId: placement.assetId,
        pending: placeholderKey !== null,
        position: placement.position,
        rotationY: placement.rotationY,
        size: resolvedSize,
        scale: placement.scale,
        heightMode: placement.heightMode,
        ...(placement.role ? { role: placement.role } : {})
      };
    }),
    requirements: requirementPreviews(requirements),
    sceneOperations: scenePreviewOperations(sceneOperations)
  };
}

function distillCodePlanPreview(
  suggestion: MapAiSuggestion,
  requirements: readonly CodeAssetRequirement[]
): CodePlanPreviewPayload {
  // requireAsset dimensions live in the generation contract, not in each place()
  // call, so backfill them onto placeholder placements whose transform carried
  // no explicit footprint.
  const dimensionsByKey = requirementDimensionsByKey(requirements);
  const placements = suggestion.operations.flatMap((operation): CodePlanPlacementPreview[] => {
    if (operation.type !== 'object.add') return [];
    const object = operation.object;
    const transform = object.transform;
    if (!transform?.position) return [];
    const assetId = object.assetId ?? null;
    const placeholderKey = placeholderKeyOf(assetId);
    const declaredSize = transform.size ?? [1, 1, 1];
    const resolvedSize = placeholderKey && isUnitFootprint(declaredSize)
      ? dimensionsByKey.get(placeholderKey) ?? declaredSize
      : declaredSize;
    const role = placeholderKey
      ? requirements.find((requirement) => requirement.key === placeholderKey)?.role
      : undefined;
    return [{
      objectId: object.id ?? '',
      name: object.name ?? '程序化物体',
      assetId,
      pending: placeholderKey !== null,
      position: transform.position,
      rotationY: transform.rotation?.[1] ?? 0,
      size: resolvedSize,
      scale: transform.scale ?? [1, 1, 1],
      heightMode: object.heightMode,
      ...(role ? { role } : {})
    }];
  });
  return {
    summary: suggestion.summary,
    placements,
    requirements: requirementPreviews(requirements),
    sceneOperations: scenePreviewOperations(suggestion.operations)
  };
}

function buildMapCodeSceneProfile(taskPrompt: string): string {
  if (!/\b(?:compact town|small town|town|village|settlement)\b|小镇|城镇|村庄|村落|聚落/i.test(taskPrompt)) return '';
  return `
## Active scene profile: settlement.compact-town
Treat these as scale-aware composition targets inside the settlement envelope, not across the whole map:
- building footprint inside the settlement envelope: 25%-40%; primary-street frontage: 55%-75%.
- intentional named open space: 8%-18%; no unassigned empty area should consume more than 10% of the settlement envelope.
- establish a compact center, a normal residential belt and a looser rural edge instead of one uniform sparse scatter.
- call api.streetGrid before placing ordinary buildings; assign each returned block a use, route connection, building cluster or named public space.
- use api.placeStreetFrontage for ordinary shops, inns, workshops and houses that address a street. It derives facade spacing, setback and facing from real building dimensions; do not manually rotate or scatter those buildings.
- reserve free api.place for landmarks, courtyard buildings and rural outliers whose relationship is explicitly composed.
- Public street furniture such as lamps, public benches, bins, signs and barriers must use api.placeAlongRoute. Furniture belonging to a shop terrace or courtyard is not generic roadside scatter: compose that shop terrace furniture as a small functional group facing its shop or table, with entrance and walking clearance.
- complete routes, thresholds and street edges before decorative vegetation. Preserve only purposeful, bounded negative space.`;
}

export function buildMapCodePlannerSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  minNewAssets = 0,
  maxNewAssets = normalizeMapAiMaxNewAssets(undefined),
  scope: MapCodeScope = 'general',
  requestMode: MapCodeRequestMode = 'generate',
  taskPrompt = '',
  refinableIds: readonly string[] = []
): string {
  if (map.sceneMode === 'indoor') {
    return buildIndoorMapCodePlannerSystemPrompt(map, assets, minNewAssets, maxNewAssets, requestMode, refinableIds);
  }
  const bounds = getMapBounds(map);
  const assetCatalog = assets.length > 0
    ? assets.map((asset) => `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}`).join('\n')
    : '- No reusable assets are available. Declare the assets you need with api.requireAsset.';
  const refinableObjectIds = new Set(refinableIds);
  const refineContext = requestMode === 'refine'
    ? `\n## Outdoor Scene Code refinement\nReturn a delta over the current map, not a rebuilt scene. Preserve everything the user did not ask to change. Do not call sceneIntent and do not regenerate base terrain unless explicitly requested. Use api.move, api.removeObject, api.updateWater and api.removeWater for existing content. Never move or remove an object with locked:true unless it also has refinable:true; those refinable objects belong to the current unapplied AI preview. To replace a misplaced bridge, call api.bridge with replaceObjectId and the existing or newly generated bridge asset. Existing objects: ${JSON.stringify(map.objects.slice(0, 240).map((object) => ({ id: object.id, name: object.name, assetId: object.assetId, position: object.transform.position, rotationY: object.transform.rotation[1], locked: object.locked, refinable: refinableObjectIds.has(object.id) })))}. Existing waters: ${JSON.stringify(map.waterBodies)}.\n`
    : '';
  const scopeContract = requestMode === 'refine'
    ? refineContext
    : scope === 'scene'
    ? `\n## Unified scene ownership\nYou are the single author of the complete outdoor scene. No separate director or later ecology planner will repair your composition. You own terrain, water, surfaces, grass, constructed forms, circulation, vegetation, rocks, creatures and their spatial relationships in one coordinate system.\nFirst call api.sceneIntent({kind:'natural'|'authored',reason:'short explanation'}). Decide semantically from the requested place, not from a keyword list. A culturally designed or purpose-built place such as a garden, courtyard, campus, park, village, arena or temple ground is normally authored even when plants and water dominate it. A wilderness without built intent is natural.\nThen call api.design({...}) once to describe the composition you are about to build. Choose one focus, multiple peer focuses, a primary-secondary hierarchy, a sequential experience, or a mixture according to the scene. Different groups may be peers while each group has its own hierarchy; groups may nest. Do not force every scene into a centered landmark or one fixed route pattern. Every leaf design group is a complete scene room: give it a purpose, at least one arrival or through-route, an anchor or spatial edge, supporting content and human-scale detail. Every declared layer intent must be fulfilled by actual placements carrying that exact groupId and layer; do not write aspirational layers that the code never builds.\nUse transferable spatial-design methods: hierarchy, axes or counter-axes, arrival and circulation, framed/borrowed/opposed views, thresholds, reveal timing, compression and release, rhythm, clustering, and intentional negative space. A library may reveal one dominant mass immediately; an arena may use a strong center and radial tiers; a Chinese garden may use several sequential scenes with enclosure, moon gates, pavilions, corridors, bridges, paving, pond, frame views and counter-views. Create recognizable architecture for authored scenes before natural decoration. For natural scenes, omit unnecessary architecture but still compose landform, paths, water and populations coherently. A large empty surface is not automatically meaningful negative space: it needs a specific use, proportionate dimensions, shaped boundaries and composed edges. In a large garden, do not spend the whole foreground on one broad empty arrival road; divide it into connected courts, planted pockets, side rooms or secondary destinations according to the design.\nPlace layer 1 anchors first, layer 2 supporting forms next, then intentionally over-place removable layer 3/4 scenery where richness is wanted; the local compiler may thin only those decorative layers. After structure and circulation, complete a dedicated detail-fill pass for thresholds, route rhythm, focal framing, vegetation masses and small accents. Preserve playable routes and deliberate empty space. Buildings that normally form an ensemble should be composed as related wings, halls, pavilions or corridors rather than represented by one token object. Compose water from multiple banks and arrival points: place waterside architecture, rocks, seating, lanterns and planting where routes reach, turn beside or cross the shore.\n`
    : '';
  const activeSceneProfile = requestMode === 'generate' ? buildMapCodeSceneProfile(taskPrompt) : '';
  const capabilityCatalog = worldCapabilitySummary('map-code').map((capability) => ({
    id: capability.id,
    description: capability.description,
    method: capability.bindings[0]?.method,
    inputSchema: capability.inputSchema
  }));
  return `You are WorldForge Studio's procedural environment planner.${scopeContract}

## Output contract
Return only one synchronous JavaScript function: function plan(api) { ... }.
Do not return markdown, explanations, JSON, imports, async code, promises, eval, Function, network, files, timers, or global state.
Use api. on every WorldForge call. The code must emit at least one map operation. ${requestMode === 'refine' ? 'Refine code must emit only the requested delta.' : 'Full-scene code should normally combine environment operations with api.place/api.placeBetween.'}
Allowed JavaScript: const/let, numbers, strings, arrays, plain objects, local helper functions, for, for...of, while, if/else, and Math scalar functions.

## World and coordinate contract
This is a 2D environment layout API: horizontal coordinates are x/z, terrain height is y.
Map bounds: x=${bounds.minX}..${bounds.maxX}, z=${bounds.minZ}..${bounds.maxZ}, seed=${map.seed}.
place({position:[x,z]}) samples terrain automatically; place({position:[x,y,z]}) uses fixed height.
Every generated point supports both point[0]/point[1] and point.x/point.z.
Never add or subtract arrays directly. Use [a[0] - b[0], a[1] - b[1]]. Never read points[index + 1] without checking index < points.length - 1. Guard divisions and only pass finite numbers.

## Asset coordinate and orientation contract
Every generated model uses local Y+ as up, local Z+ as its front/forward direction, and local X+ as its right side.
For a building, gate, wall facade, stall, vehicle, or prop with a recognizable front, put its entrance, facade, opening, windshield, or nose toward local Z+ in the model-generation prompt.
World rotationY rotates that local Z+ front on the map. api.tangentYaw(direction) makes local Z+ follow a path tangent; api.faceYaw(from,to) makes local Z+ face a target point; add api.TAU / 2 when the back should face the target.
Do not use random rotation for directional assets. For a ring or arena, use api.faceYaw(point, center) for inward-facing fronts and api.faceYaw(point, center) + api.TAU / 2 for outward-facing backs.

## Design philosophy
Build a readable composition, not a random pile. Let the requested place determine whether focus is singular, multiple, sequential, or mixed.
Use big-medium-small hierarchy: a few large anchors, a moderate number of supporting pieces, and enough controlled small details to make authored space feel intentionally finished.
Keep key routes clear, respect the map bounds, avoid filling every cell, and keep repeated elements deterministic from api.seed.
Treat declared building dimensions as real footprints: keep standalone building footprints disjoint, with a small street or courtyard gap between their edges. Do not stack several houses at nearly the same center.
Use proxy placements without assetId only for abstract markers or when no visual asset is appropriate; visible prompt-specific content should use real assets.
${scope === 'scene' ? "Set each design layer's optional minCount to the number of placements your own design actually needs, so an architectural ensemble or detail family is not collapsed into one token object." : ''}
${activeSceneProfile}

## Callable capability manifest
Prefer these bounded semantic capabilities over manually emitting repeated coordinates. Their local implementations own geometry, sampling and operation limits:
${JSON.stringify(capabilityCatalog)}

## API quick reference
Constants: api.TAU, api.PHI, api.seed, api.bounds.
Scene intent: api.sceneIntent({kind:'natural'|'authored',reason?}). ${requestMode === 'refine' ? 'Do not call it during refinement.' : 'Required exactly once for unified scene ownership.'}
Design semantics: api.design({experienceMode:'immediate'|'sequential'|'mixed',intent,groups:[{id,name,parentId?,intent,region?,focusIds?,guideIds?,entryGuideIds?,exitGuideIds?,axisGuideIds?,protectedObjectIds?,removableObjectIds?,layers:[{level:1|2|3|4,intent,density:'tight'|'normal'|'open',minCount?:1..64}]}],focuses:[{id,groupId,name,kind:'primary'|'secondary'|'node',rank,selector?,objectId?,reveal:'visible'|'screened'|'framed'|'sequence'}],viewpoints:[{id,groupId?,point:[x,z],targetFocusId?,role:'entry'|'route'|'node'|'overview'}],relations:[{id,kind:'attract'|'repel'|'support',sourceSelector,targetSelector?,sourceGroupId?,targetGroupId?,strength:'tight'|'normal'|'open',minDistance?,maxDistance?}]}). ${requestMode === 'refine' ? 'Optional: call once only when the user changes composition semantics.' : 'Call once in unified scene ownership, after sceneIntent and before placement.'}
Environment: api.terrain(preset,{amplitude?,roughness?,seed?,direction?}); api.refineTerrain({...}); api.water(id,{type:'lake'|'river'|'ocean',points,...}); api.grass(id,region,{preset:'meadow'|'sand'|'wetland'|'farm'|'magic'|'alpine-moss',density?,variation?,softness?,height?,mix?:{short?,tall?,flowers?}}); api.keepDry([x,z],clearance?) returns the nearest dry point after water operations; api.waterPoint(waterId,[x,z],draft?) returns [x,y,z] on that water surface after water operations; use it for boats and other floating assets, normally with role:'environment'; api.spawn([x,z],yawDegrees?); api.renderSuggestion(text).
Circulation: api.route({id,name?,points:[[x,z],...],curve?:'polyline'|'catmull-rom',closed?,width?,surface?:'paving'|'soil'|'grass'|'sand'|'rock'|'none',material?:'default'|'compacted-earth'|'garden-stone'|'asphalt'|'concrete'|'brick-paver'|'cobblestone'|'gravel'|'mud',intensity?,tags?}) records the editable guide and lays real terrain paving by default. Choose asphalt for modern vehicle streets, concrete for sidewalks, brick-paver for plazas and old streets, garden-stone or cobblestone for gardens, compacted-earth or gravel for informal paths, and mud only for visibly wet rustic ground. api.routeNetwork({id,nodes:[{id,point:[x,z],role?}],edges:[{id,from,to,via?,curve?,width?,surface?,material?,tags?}]}) expresses a free-form connected graph with shared junctions; you choose its topology. api.streetGrid({id,region:[[x,z],...],direction?:degrees,blockWidth,blockDepth,roadWidth,inset?,surface?,material?,tags?}) returns {routeIds,blocks}; use blocks for building groups and routeIds for roadside facilities. api.placeStreetFrontage({routeId,side:'left'|'right',items:[{assetId?,name,dimensions:[frontageWidth,height,depth],role?,groupId?,layer?},...],startInset?,endInset?,gap?,setback?}) sequentially fits varied ordinary buildings along one street side, keeps their real footprints separated and turns local Z+ facades toward the road. api.placeAlongRoute({routeId,assetId?,name?,spacing,offset?,side?:'left'|'right'|'both'|'alternate',startInset?,endInset?,facing?:'forward'|'toward-route'|'away-from-route',role?,groupId?,layer?}) derives repeated facilities from an existing route. A large authored garden needs an experience network rather than one ring: combine an entrance sequence, asymmetric branches or shortcuts to local scenes, waterside or quiet routes, and intentional shared junctions according to the design. Do not force one fixed topology. Use bridge for water crossings; place generated stair/step modules where a route must change level.
${MAP_CODE_ENVIRONMENT_FORM_CONTRACT}
Regions: {kind:'circle',x,z,radius}, {kind:'path',points:[[x,z],...],width}, or {kind:'polygon',points:[[x,z],...]}.
Scalar math: api.clamp(value,min,max), api.lerp(a,b,t), api.remap(value,inMin,inMax,outMin,outMax), api.smoothstep(min,max,value), api.random(min?,max?).
Transforms: api.rotate2D(point,angle,center?), api.mirrorPoint(point,'x'|'z',coordinate?), api.distance2D(a,b), api.tangentYaw(tangent), api.faceYaw(from,to). mirrorPoint with 'x' mirrors left/right around x=coordinate; 'z' mirrors front/back around z=coordinate.
Curves: api.linePoint(t,a,b) -> [x,z]; api.bezierPoint(t,p0,p1,p2,p3) -> {point,tangent,normal}; api.sampleBezier(...) -> point arrays; api.sampleBezierFrames(...) -> frame objects with point,tangent,normal; api.sampleBezierFramesBySpacing(...,spacing,gapRatio?) -> approximately even arc-length frames. frame.normal is the normalized left-side normal [-tangentZ,tangentX] as t increases.
Fields: api.noise2D(x,z,scale?,seed?) -> [-1,1]; api.fbm2D(x,z,{scale?,octaves?,lacunarity?,gain?,seed?}) -> [-1,1].
Layouts: api.circlePoint(index,count,radius,center?) -> [x,z]; api.ellipsePoint(index,count,radiusX,radiusZ,center?,phase?) -> [x,z]; api.gridPoints({center?,columns,rows,spacing}) -> points; api.poissonDisk({bounds?,minDistance,maxPoints?,attempts?,seed?}) -> points.
Assets: api.requireAsset({key,name,prompt,tags?,variants?,dimensions:[width,height,depth]?,role:'structure'|'environment',optional?}) -> key; api.asset(key,index?) -> generated assetId. role is required in unified scene ownership; only loose natural decoration may be optional.
Output: api.place({assetId?,name?,position:[x,z]|[x,y,z],rotationY?,facing?,scale?,size?,terrain?,role?,groupId?,layer?:1|2|3|4}); api.placeStreetFrontage(...) for varied ordinary street-facing buildings; api.placeAlongRoute(...) for repeated street furniture. api.foundation(...) creates an independent editable foundation after its target buildings are placed: pass their api.place references or existing object IDs in under. Use rounded-rectangle/capsule for buildings, polygon for irregular footprints, and path + catmull-rom for curved seawalls; closed path makes a continuous ring. Choose level, slope or steps from intent, keep maxThickness bounded, and never flatten terrain. api.attach({assetId?,name?,parentId,kind:'supported'|'mounted',side?,offset?,anchorY?:'bottom'|'center'|'top',contact?,scale?,rotationY?,role?,groupId?,layer?}) attaches a child to an earlier placement or existing object. Use supported for objects resting on top; use mounted for doors, windows, banners, signs and facade ornaments that must follow a host surface. mounted side is the host-local north|south|east|west face, offset is [horizontal,vertical], anchorY selects the host's vertical baseline, and contact is embed depth. Entrances default to anchorY:'bottom', so never put an absolute world height into offset. api.bridge({waterId,assetId?,name?,crossingCenter:[x,z],direction:[dx,dz],dimensions:[width,height,depth],kind?:'straight'|'curved',curveOffset?,segmentCount?,bankInset?,deckClearance?,abutments?,groupId?,layer?}). A curved bridge uses the asset as a repeatable module. The local solver samples the full bridge width, snaps both ends beyond the real shoreline, records the route guide, and creates small bridgeheads unless abutments:false.
Never use standalone api.place with [x,y,z] for a door, window, banner, sign or facade ornament intended as part of another structure. Either include it in the host asset itself or create the host first and use api.attach.
Refine existing content: api.move({objectId,position?,rotationY?,scale?}); api.removeObject(objectId); api.updateWater({waterId,level?,depth?,width?,points?}); api.removeWater(waterId). These APIs are available only during refinement.
facing may be a direction [dx,dz], {direction:[dx,dz]}, {tangent:[dx,dz]}, {normal:[nx,nz]}, {target:[x,z]}, or any of those with offsetY; it overrides rotationY when present.
For long connected dry-land scenery, prefer api.placeBetween({assetId?,name?,start:[x,z],end:[x,z],dimensions:[width,height,depth],spanAxis:'x'|'z',gapRatio?,frontTarget?:[x,z],facing?,scale?,terrain?,groupId?,layer?}). It places the model at the midpoint, aligns its declared connection axis to the line from start to end, and fits only that axis to the endpoint distance. Use spanAxis:'x' for side-by-side walls, railings, facades, seating rows and stands; use spanAxis:'z' for traversal modules. frontTarget chooses which side local Z+ faces without breaking the endpoint connection. Bridges must use api.bridge so the server solves the real shoreline, dry bank endpoints and water clearance.

## Scene pattern guide
- Spaced props along a curve may use sampleBezierFramesBySpacing with a visible gap ratio; this uses arc length instead of parameter t and avoids bunching.
- Connected modular elements between computed points use placeBetween rather than manually calculating midpoint and rotation. Continuous structures use gapRatio:0 and consecutive shared endpoints; never place a continuous wall, arcade, corridor, railing or stand as isolated samples. For a closed loop, connect the last point back to the first.
- Arena seating is not a radial traversal strip: its long row edge connects tangent-to-tangent on local X, while local Z+ faces the arena floor. Use spanAxis:'x' and frontTarget:center. The compiler preserves this contract even if a seating call accidentally asks for spanAxis:'z'.
- For a continuous connected run, use one asset family and normally variants:1. Do not alternate visibly different variants along the same uninterrupted line. The ordered start->end direction determines which side local Z+ faces when spanAxis:'x'.
- Elements whose long axis follows travel: use facing:{tangent:frame.tangent}; elements whose front faces across the curve: use facing:{normal:frame.normal}; add offsetY:api.TAU / 2 for the opposite side. If an interior anchor is known, facing:{target:interiorPoint} is the safest inward-facing choice.
- Organic scatter: poissonDisk plus noise2D/fbm2D density filtering; enforce minDistance. When vegetation is part of the composition, use several bounded groves or edge buffers sized from the available area instead of one tiny global sample.
- Dry structures and land vegetation must not be placed in water. Call api.keepDry after defining water for walls, gates, buildings, lamps and trees near a shoreline. Place boats with api.waterPoint after defining their water body and use role:'environment'. Bridges alone use api.bridge. The local compiler performs one final non-blocking dry-land repair if a placement still intrudes.
- Grass in an authored green landscape should read as a continuous ground layer rather than isolated tufts: normally use density 0.72-0.9, moderate variation, and a short/tall mix such as {short:0.62,tall:0.34,flowers:0.04}. Use meadow for the general garden floor and reserve wetland for a narrow shore band; do not color the whole garden as wetland merely because it contains a pond.
- Paired or axial decoration uses mirrorPoint and density:'tight' so flags, lamps, statues, planters and gate ornaments remain complete pairs. Use normal/open only for scenery that may be asymmetrically thinned.
- Before finishing an authored scene, complete a dedicated detail-fill pass: inspect each group for empty thresholds, unsupported route edges, unframed focuses, missing near/mid/far vegetation masses and absent small-scale accents. Keep intentional clearings, but do not confuse unplanned emptiness with negative space.
- Treat route-network nodes as authored detail anchors. Enrich bridgeheads, junctions, thresholds, waterside pauses and focus approaches with context-appropriate paired or asymmetric clusters such as lanterns, stone seats, Taihu rocks, planting and low props, placed beside rather than on the walkable surface.
- A route edge earns its place by reaching a distinct programmed scene, shortcut, overlook or threshold. Do not substitute many nearly identical guide lines for actual destinations. In a garden, generate and place small furnishing families such as stone lanterns, stone tables and seats, scholar rocks, low walls and planting groups where they support those destinations.
- Farms, buildings, stalls, streets: gridPoints with an explicit center and spacing.
- Plazas, circular rings, lamps and portals use circlePoint with deterministic index/count. Oval arenas and elliptical walls use ellipsePoint and consecutive shared endpoints. Connect the final point back to the first with placeBetween and gapRatio:0; the compiler adds bounded miter overlap at turns so rectangular modules do not leave outer-corner seams.
- Arena stands, gates, shops, and facades around a center: faceYaw(point, center) so the front faces inward; use + api.TAU / 2 for outward-facing backs.
- Fades and zones: remap/smoothstep/clamp, not abrupt magic thresholds.
- Variation: api.random(min,max), never Math.random and never an unseeded random source.

## Asset rules
The sum of all requireAsset variants must be between ${minNewAssets} and ${maxNewAssets}.
Each requireAsset.name is user-facing UI text: use one short Simplified Chinese noun with 2-8 Chinese characters, such as "城门", "看台", or "塔柱"; never use an English marketing phrase. Keep the detailed asset prompt in whichever language best serves model generation.
When the minimum is greater than zero, declare and place that many prompt-specific generated assets even if reusable assets exist.
Use api.asset(key,index) for generated assets; do not invent asset IDs and do not modify catalog IDs.
Each asset prompt must describe a standalone reusable object with no ground, scene, text, or background unless the object itself requires it.
In unified scene ownership, label every generated family role:'structure' or role:'environment'. ${requestMode === 'refine' ? 'New assets must directly serve the requested delta.' : 'Structural anchors are mandatory; only replaceable natural accents may use optional:true.'}
For any modular asset repeated along a line or curve, explicitly state its span axis, connection axis, and canonical dimensions: side-by-side modules should span local X with depth/front on local Z; traversal modules should span local Z. Never leave the long axis or dimensions implicit.
Append this orientation instruction to every generated asset prompt: "Coordinate contract: Y+ is up, Z+ is the front/entrance/forward direction, X+ is right; place doors, facades, openings, windshields, or noses toward local Z+ and keep the model centered at its origin."

## Correct patterns
Road curve:
const road = api.requireAsset({key:'road',name:'霓虹道路',prompt:'Standalone low-poly wet neon road segment, no scene or background',tags:['road','neon'],variants:2,role:'structure'});
const curve = api.sampleBezier([-36,0],[-12,18],[12,-18],[36,0],12);
for (let i = 0; i < curve.length; i += 1) api.place({assetId:api.asset(road,i),position:curve[i],facing:{direction:i < curve.length - 1 ? [curve[i + 1][0]-curve[i][0],curve[i + 1][1]-curve[i][1]] : [1,0]}});

Natural scatter:
const tree = api.requireAsset({key:'tree',name:'发光树',prompt:'Standalone stylized luminous cyberpunk street tree, no ground or background',tags:['tree','neon'],variants:2,role:'environment',optional:true});
const points = api.poissonDisk({minDistance:4.5,maxPoints:48,attempts:24,seed:api.seed});
for (let i = 0; i < points.length; i += 1) { const p = points[i]; if (api.fbm2D(p.x,p.z,{scale:0.08}) > -0.35) api.place({assetId:api.asset(tree,i),position:[p.x,p.z]}); }

Inward arena ring:
const center = [0,0];
const gate = api.requireAsset({key:'gate',name:'竞技场入口',prompt:'Standalone arena gate with facade and entrance, no ground or background',tags:['arena','gate'],variants:1,role:'structure'});
for (let i = 0; i < 8; i += 1) { const point = api.circlePoint(i,8,28,center); api.place({assetId:api.asset(gate,0),position:point,facing:{target:center}}); }

Curved wall with a consistent facade:
const wall = api.requireAsset({key:'wall',name:'花园围墙',prompt:'Standalone modular garden wall segment with decorative facade toward local Z+, seamless ends, no ground or background; span axis local X; canonical dimensions 6 wide x 3 high x 0.5 deep',dimensions:[6,3,0.5],tags:['wall','garden'],variants:1,role:'structure'});
const frames = api.sampleBezierFramesBySpacing([-32,-12],[-18,24],[18,-24],[32,12],6,0);
for (let i = 0; i < frames.length - 1; i += 1) api.placeBetween({assetId:api.asset(wall,0),start:frames[i].point,end:frames[i + 1].point,dimensions:[6,3,0.5],spanAxis:'x',gapRatio:0});

## Final self-check before returning
1. Exactly one function named plan and no markdown.
2. ${requestMode === 'refine' ? 'Refine code does not call sceneIntent, preserves unrelated content, and emits at least one delta operation.' : 'Unified scene code calls sceneIntent once, emits terrain/surface/water/grass when relevant, and places the recognizable content; all loops have bounded counts.'}
3. All positions are inside the stated bounds or intentionally clamped.
4. No undefined point, invalid array index, direct array arithmetic, division by zero, invented asset ID, or unbounded placement loop.
5. Generated assets are declared with requireAsset and bound only through api.asset.
6. Every declared variant is referenced by at least one api.place, api.bridge or api.placeBetween call; never generate an unused variant.
7. Authored scenes contain connected structural anchors plus a clear entrance/spawn route; natural scenes do not invent buildings merely to satisfy a pattern.
8. Structural accessories are part of their host asset or use api.attach; none float at an unrelated fixed world height.
9. Routes and functional clearings exclude loose trees and rocks; use routeNetwork for a multi-choice garden circulation graph and clearNatural:true for non-route open space.
10. Every leaf design group realizes each declared layer with placements in that group; no oversized clear surface or broad arrival road is left as grass or paving without a specific use and composed edges.

Reusable asset catalog:
${assetCatalog}`;
}

function buildIndoorMapCodePlannerSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  minNewAssets: number,
  maxNewAssets: number,
  requestMode: MapCodeRequestMode,
  refinableIds: readonly string[]
): string {
  const room = requireIndoorRoom(map.room);
  const suggestedAssetCount = indoorAssetTargetCount(map, minNewAssets, maxNewAssets);
  const assetCatalog = assets.length > 0
    ? assets.map((asset) => `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}`).join('\n')
    : '- No reusable assets are available. Declare the assets you need with api.requireAsset.';
  const refinableObjectIds = new Set(refinableIds);
  const refineContext = requestMode === 'refine'
    ? `\n## Indoor Code refinement\nReturn only a delta over the current room. Preserve every object, opening and finish the user did not ask to change. Never move or remove an object with locked:true unless it also has refinable:true. Use api.move and api.removeObject for existing content; add new openings only when the user explicitly requests one. Existing objects: ${JSON.stringify(map.objects.slice(0, 240).map((object) => ({ id: object.id, name: object.name, assetId: object.assetId, position: object.transform.position, rotationY: object.transform.rotation[1], parentId: object.parentId, roomOpeningId: object.roomOpeningId, locked: object.locked, refinable: refinableObjectIds.has(object.id) })))}.\n`
    : `\n## Unified indoor ownership\nYou are the single author of the complete indoor layout. No second director, specialist agent, or silent local backfill will redesign it. Local code only enforces room bounds, opening semantics, collision safety, attachment validity and door circulation. If a functional requirement is missing, this same Code Composer will receive a targeted repair request.\n`;
  return `You are WorldForge Studio's procedural indoor-scene planner.${refineContext}

## Output contract
Return only one synchronous JavaScript function: function plan(api) { ... }.
Do not return Markdown, explanations, JSON, imports, async code, promises, eval, Function, network, files, timers, or global state.
Use api. on every WorldForge call and emit at least one placement or requested refinement delta. All loops must be bounded.

## Indoor structural contract
This is one standalone parameterized room. Its size is user-owned and must not be changed by Code.
Room floor-center=${JSON.stringify(room.position)}, size=[width=${room.size[0]},height=${room.size[1]},depth=${room.size[2]}], wallThickness=${room.wallThickness}.
Existing openings=${JSON.stringify(room.openings)}.
Do not generate a whole room, floor, ceiling, wall shell, terrain, outdoor ground, sky, road, river, forest, garden, building exterior, Render Scheme, wallpaper, floor finish, carpet or rug finish.
The room shell and interior finishes remain owned by existing map systems. Generate furniture, fixtures, doors, windows, wall-mounted objects, ceiling-mounted objects and their functional relationships.
Indoor objects use fixed Y positions relative to the room floor; never use terrain-following placement.

## Indoor coordinate API
api.room is the current room data.
api.roomPoint(localX,localZ,height?) returns [x,y,z] inside the room. localX/localZ are offsets from room center and height is above the floor.
api.wallFrame(wall,offset?,bottom?,inset?) returns {point,inward,outward,tangent}. wall is north|south|east|west. Put wall-mounted assets at frame.point with facing:{direction:frame.inward}.
api.ceilingPoint(localX,localZ,objectHeight?,drop?) returns [x,y,z] with the object below the ceiling. Pass its declared height.
api.opening({id,kind:'door'|'window',wall,offset?,bottom?,width?,height?}) declares a parameterized opening and returns its ID. Then api.place({assetId,roomOpeningId:id,dimensions:[w,h,d]}) binds a separate door/window model to it; position and rotation are resolved locally.
Every generated point supports both point[0]/point[1] and point.x/point.z where applicable. Never add or subtract arrays directly.

## Placement and asset contract
Every model uses local Y+ up, local Z+ front/forward, and local X+ right.
api.place({assetId?,name?,position?,rotationY?,facing?,scale?,size?,dimensions?,roomOpeningId?,role:'functional'|'decor'}) places one object. dimensions is the intended world [width,height,depth] and is fitted to the generated model's actual visual bounds.
api.attach({assetId?,name?,parentId,kind:'supported'|'mounted',side?,offset?,anchorY?:'bottom'|'center'|'top',contact?,scale?,rotationY?,role:'functional'|'decor'}) attaches a child to an earlier api.place/api.attach return value or an existing object ID. supported uses local [x,z] offset on a surface; mounted requires side north|south|east|west and uses local [horizontal,vertical] offset relative to anchorY.
api.placeBetween remains available for connected counters, shelves, railings, partitions or bench rows.
api.requireAsset({key,name,prompt,tags?,variants?,dimensions,role:'functional'|'decor',optional?}) declares assets; api.asset(key,index?) binds them. Functional families are core room content; only restrained decor may be optional.
The hard user-selected range for all requireAsset variants is ${minNewAssets}-${maxNewAssets}. For this room size, aim for about ${suggestedAssetCount} reusable variants only when they serve distinct functional or visual roles; this is guidance, not permission to add filler. Each name is one short 2-8 character Simplified Chinese noun. Every declared variant must be placed.
Use existing reusable IDs exactly as listed; never invent an asset ID. Do not generate assets already available and suitable for reuse.

## Indoor composition philosophy
Plan two conceptual passes inside this one program:
1. Establish entrance/daylight fixtures, primary activity groups, service/storage furniture and one readable focal relationship.
2. Add restrained lighting and decor only after function and circulation are clear.
Build relationships rather than scattering props: desk+chair facing a board, dining chairs around a table, sofas around a focal table, checkout counter plus queue clearance, or workstations facing a shared screen.
Keep a continuous route at least 0.8 world units wide from every door into the primary activity area. Keep door clearance empty and preserve useful negative space.
Scale repeated furniture counts to room area. Avoid piling everything at the center or lining every wall.
Wall-mounted objects must use wallFrame, ceiling objects must use ceilingPoint, and floor furniture must use roomPoint with height 0 unless intentionally supported above the floor.

## Shared helpers
Constants: api.TAU, api.PHI, api.seed, api.bounds, api.room.
Math/layout: api.clamp, api.lerp, api.remap, api.smoothstep, api.random, api.rotate2D, api.distance2D, api.faceYaw, api.tangentYaw, api.gridPoints, api.circlePoint, api.linePoint.
Refine: api.move({objectId,position?,rotationY?,scale?}); api.removeObject(objectId). These are available only during refinement and reject locked objects.

## Final self-check
1. Exactly one function named plan and no Markdown.
2. No terrain, water, grass, outdoor scenery, whole-room asset or final render styling.
3. Primary furniture and functional relationships exist before decor.
4. Every door keeps a continuous 0.8-unit route to the main activity area.
5. All objects stay inside the room; wall and ceiling objects use their dedicated APIs.
6. Generated assets use requireAsset/api.asset, declare dimensions, use role:'functional'|'decor', and every variant is placed.
7. ${requestMode === 'refine' ? 'Only the requested delta is emitted; locked and unrelated content is preserved.' : 'The complete room is authored in this one program without relying on a later director.'}

Reusable asset catalog:
${assetCatalog}`;
}

function extractCode(raw: string): string {
  const fenced = raw.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}

async function discoverMapCodeWithRepairs(
  initialCode: string,
  userPrompt: string,
  systemPrompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxNewAssets: number,
  options: MapCodePlannerOptions
): Promise<{ code: string; discovery: CodeExecutionResult; repairAttempts: number }> {
  let code = initialCode;
  let programRepairAttempted = false;
  let executionRepairAttempts = 0;
  let repairAttempts = 0;
  while (true) {
    try {
      const discovery = runMapCodePlan(code, map, assets, {
        mode: 'discovery',
        requestMode: options.mode ?? 'generate',
        minNewAssets: options.minNewAssets,
        maxNewAssets,
        scope: options.scope,
        refinableObjectIds: new Set(options.refinableObjectIds ?? []),
        onPlanPreview: options.onPlanPreview
      });
      const programIssues = findAuthoredSceneProgramIssues(map, discovery.suggestion);
      if (programIssues.length > 0 && !programRepairAttempted) {
        programRepairAttempted = true;
        repairAttempts += 1;
        options.onProgress?.({
          phase: 'replanning',
          label: '场景片区内容不足，AI 正在自动补全 1/1',
          detail: programIssues.join('\n')
        });
        code = extractCode(await llmChat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: code },
          {
            role: 'user',
            content: `The program executed, but its authored scene program is incomplete:\n${programIssues.join('\n')}\n\nReturn corrected JavaScript only. Preserve the overall concept, terrain and playable circulation, but complete every promised leaf-group layer with actual placements using the same groupId and layer. Do not merely rewrite the design descriptions. If a clear paved or grass area consumes most of a scene group while containing almost no authored content, shrink or reshape it and compose its edges with purposeful architecture, stopping places and near/mid/small details. Routes must connect distinct programmed destinations, and route nodes such as thresholds, bridgeheads, turns and waterside pauses should receive context-appropriate details beside the walkable surface. Keep deliberate negative space only when it has a specific use, a shaped boundary and enough surrounding content to read as intentional. Do not scale loop counts from map width, map area, or fine coordinate steps. Use bounded api.gridPoints, api.poissonDisk, or curve-sampling results and iterate each result once; avoid while loops and nested placement loops.`
          }
        ], {
          apiBase: options.apiBase,
          provider: options.provider ?? 'gpt',
          temperature: 0.15,
          maxTokens: 16_000,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          onProgress: options.onProgress
        }));
        continue;
      }
      return {
        code,
        repairAttempts,
        discovery: programIssues.length > 0 ? {
          ...discovery,
          suggestion: {
            ...discovery.suggestion,
            diagnostics: [...(discovery.suggestion.diagnostics ?? []), ...sceneProgramDiagnostics(programIssues)]
          }
        } : discovery
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const executionError = mapCodeExecutionErrorDetail(error, code);
      if (executionRepairAttempts === 2) throw new Error(`map_code_execution_failed:${executionError}`);
      executionRepairAttempts += 1;
      repairAttempts += 1;
      const timeoutRepairGuidance = /script execution timed out/i.test(executionError)
        ? `\n\nThis was an execution timeout. Do not scale loop counts from map width, map area, or fine coordinate steps. Replace manual area scans with bounded api.gridPoints, api.poissonDisk, or curve-sampling results and iterate each result once. Avoid while loops and nested placement loops; keep each explicit loop below ${MAX_POINT_RESULTS} iterations and total placements below ${MAX_PLACEMENTS}.`
        : '';
      const lockedObjectRepairGuidance = /locked_map_code_object:([^\s]+)/i.exec(executionError)
        ? `\n\nThe referenced object is locked and not refinable. Leave it unchanged. Do not replace api.move with api.removeObject for the same ID; instead adjust only objects whose catalog entry has refinable:true, or add unlocked supporting content elsewhere.`
        : '';
      options.onProgress?.({
        phase: 'replanning',
        label: `检测到规划参数或边界错误，AI 正在自动修复 ${executionRepairAttempts}/2`,
        detail: executionError
      });
      code = extractCode(await llmChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: code },
        {
          role: 'user',
          content: map.sceneMode === 'indoor'
            ? `The indoor program failed during its sandboxed discovery run with this error:\n${executionError}\n\nReturn corrected JavaScript only. Preserve the requested room design. Check every array index, loop endpoint, division, room wall, opening ID, locked object and optional argument. Use roomPoint for floor furniture, wallFrame for wall objects, ceilingPoint for ceiling objects, and opening plus roomOpeningId for doors/windows. Never use terrain, water, grass or outdoor APIs. Ensure every numeric value is finite.${timeoutRepairGuidance}${lockedObjectRepairGuidance}`
            : `The program failed during its sandboxed discovery run with this error:\n${executionError}\n\nReturn corrected JavaScript only. Preserve the requested design. Check every array index, loop endpoint, division, vector component, enum field, and optional argument. JavaScript arrays cannot be added or subtracted directly; calculate x/z components separately. bezierPoint returns {point,tangent,normal}, sampleBezier returns point arrays, and sampleBezierFrames returns frame objects. Use facing:{tangent:frame.tangent} for along-curve objects and facing:{normal:frame.normal} for curve-side facades or walls. Ensure every numeric value passed to the API is finite.${timeoutRepairGuidance}${lockedObjectRepairGuidance}\n\n${MAP_CODE_ENVIRONMENT_FORM_CONTRACT}`
        }
      ], {
        apiBase: options.apiBase,
        provider: options.provider ?? 'gpt',
        temperature: 0.1,
        maxTokens: 16_000,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        onProgress: options.onProgress
      }));
    }
  }
  throw new Error('map_code_execution_failed:missing_discovery_result');
}

function findAuthoredSceneProgramIssues(map: EditableMap, suggestion: MapAiSuggestion): string[] {
  if (suggestion.codePlan?.sceneIntent !== 'authored') return [];
  let candidate: EditableMap;
  try {
    candidate = applyMapOperations(map, suggestion.operations);
  } catch {
    return [];
  }
  const groups = candidate.designSemantics.groups;
  const parentIds = new Set(groups.flatMap((group) => group.parentId ? [group.parentId] : []));
  const issues: string[] = [];
  for (const group of groups) {
    if (parentIds.has(group.id) || !group.region) continue;
    const objects = candidate.objects.filter((object) => object.designGroupId === group.id);
    for (const layer of group.layers) {
      const actualCount = objects.filter((object) => object.compositionLayer === layer.level).length;
      const requiredCount = Math.max(1, layer.minCount ?? 1);
      if (layer.intent.trim() && actualCount === 0) {
        issues.push(`scene_group_missing_layer:${group.id}:${layer.level}`);
      } else if (layer.intent.trim() && actualCount < requiredCount) {
        issues.push(`scene_group_underfilled_layer:${group.id}:${layer.level}:${actualCount}/${requiredCount}`);
      }
    }
    const groupArea = designRegionArea(group.region);
    if (groupArea < 180 || objects.length >= 3) continue;
    const oversizedClearing = candidate.visualSemantics.zones.some((zone) => (
      zone.tags.includes('clear')
      && !zone.id.startsWith('code:route:')
      && zone.region
      && designRegionContains(group.region!, zone.center[0], zone.center[1])
      && designRegionArea(zone.region) >= groupArea * 0.45
    ));
    if (oversizedClearing) issues.push(`scene_group_oversized_clear_space:${group.id}`);
  }
  for (const issue of evaluateSettlementQuality(candidate).issues) {
    issues.push(`${issue.code}:${formatQualityValue(issue.actual)}/${formatQualityValue(issue.expected)}`);
  }
  return [...new Set(issues)].slice(0, 12);
}

function formatQualityValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function sceneProgramDiagnostics(issues: readonly string[]): NonNullable<MapAiSuggestion['diagnostics']> {
  return issues.length === 0 ? [] : [{
    code: 'scene.program-incomplete',
    severity: 'warning',
    message: `仍有 ${issues.length} 项场景片区内容承诺未完全落位；当前结果已保留，可继续使用“调整当前地图”补充。`,
    repaired: false
  }];
}

function designRegionArea(region: NonNullable<MapDesignSemantics['groups'][number]['region']>): number {
  if (region.kind === 'circle') return Math.PI * region.radius * region.radius;
  if (region.kind === 'path') {
    return region.points.slice(1).reduce((sum, point, index) => (
      sum + pointDistance2(region.points[index], point) * region.width
    ), 0);
  }
  return Math.abs(region.points.reduce((sum, point, index) => {
    const next = region.points[(index + 1) % region.points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

function designRegionContains(
  region: NonNullable<MapDesignSemantics['groups'][number]['region']>,
  x: number,
  z: number
): boolean {
  if (region.kind === 'circle') return Math.hypot(x - region.x, z - region.z) <= region.radius;
  if (region.kind === 'path') return region.points.slice(1).some((point, index) => (
    pointSegmentDistance2(x, z, region.points[index], point) <= region.width / 2
  ));
  let inside = false;
  for (let index = 0, previous = region.points.length - 1; index < region.points.length; previous = index++) {
    const left = region.points[index];
    const right = region.points[previous];
    if ((left[1] > z) !== (right[1] > z)
      && x < (right[0] - left[0]) * (z - left[1]) / (right[1] - left[1]) + left[0]) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance2(x: number, z: number, start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared <= 0.000001
    ? 0
    : clampFinite(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(x - (start[0] + dx * amount), z - (start[1] + dz * amount));
}

function mapCodeExecutionErrorDetail(error: unknown, code?: string): string {
  if (!(error instanceof Error)) return String(error || 'unknown_map_code_execution_error').slice(0, 1_000);
  const generatedFrame = error.stack
    ?.split('\n')
    .find((line) => line.includes('worldforge-map-plan.js'))
    ?.trim();
  const lineNumber = generatedFrame?.match(/worldforge-map-plan\.js:(\d+):\d+/)?.[1];
  const sourceLine = lineNumber && code
    ? code.split('\n')[Math.max(0, Number(lineNumber) - 1)]?.trim()
    : undefined;
  return [error.message, generatedFrame, sourceLine ? `source: ${sourceLine}` : undefined]
    .filter(Boolean)
    .join(' at ')
    .slice(0, 1_000);
}

function normalizeCodeAssetRequirement(
  input: CodeAssetRequirementInput,
  requireRole = false,
  sceneMode: EditableMap['sceneMode'] = 'outdoor'
): CodeAssetRequirement {
  if (!input || typeof input !== 'object') throw new Error('invalid_map_code_asset_requirement');
  const key = normalizeCodeAssetKey(input.key);
  const name = cleanText(input.name, 42);
  const prompt = cleanText(input.prompt, 500);
  if (!name || !prompt) throw new Error('invalid_map_code_asset_requirement');
  if (sceneMode === 'indoor' && INDOOR_FORBIDDEN_CONTENT.test(`${name} ${prompt} ${(input.tags ?? []).join(' ')}`)) {
    throw new Error('indoor_map_code_forbidden_content');
  }
  const allowedRoles: readonly CodeAssetRole[] = sceneMode === 'indoor'
    ? ['functional', 'decor']
    : ['structure', 'environment'];
  if (input.role !== undefined && !allowedRoles.includes(input.role)) {
    throw new Error('invalid_map_code_asset_role');
  }
  if (requireRole && input.role === undefined) throw new Error('missing_map_code_asset_role');
  return {
    key,
    name,
    prompt,
    tags: normalizeAssetTags(input.tags) ?? [],
    variants: boundedCount(input.variants ?? 1, 1, 8),
    ...(input.dimensions === undefined ? {} : { dimensions: point3(input.dimensions) }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.optional === true ? { optional: true } : {})
  };
}

function codeAssetOrientationPrompt(prompt: string, dimensions?: Point3): string {
  const dimensionContract = dimensions
    ? `Canonical dimensions contract: width=${dimensions[0]}, height=${dimensions[1]}, depth=${dimensions[2]} world units. Keep the generated mesh within this centered bounding size.`
    : '';
  return `${prompt}\n${CODE_ASSET_ORIENTATION_PROMPT}${dimensionContract ? `\n${dimensionContract}` : ''}`;
}

function normalizeCodeAssetKey(value: string): string {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  if (!key) throw new Error('invalid_map_code_asset_key');
  return key;
}

function sameCodeAssetRequirement(left: CodeAssetRequirement, right: CodeAssetRequirement): boolean {
  return left.name === right.name
    && left.prompt === right.prompt
    && left.variants === right.variants
    && left.tags.join('\n') === right.tags.join('\n')
    && JSON.stringify(left.dimensions) === JSON.stringify(right.dimensions)
    && left.role === right.role
    && Boolean(left.optional) === Boolean(right.optional);
}

function codeAssetPlaceholder(key: string, index: number): string {
  return `code-asset://${key}/${index}`;
}

function codeMissingAsset(key: string, index: number): string {
  return `code-asset-missing://${key}/${index}`;
}

function codePlacementReference(index: number): string {
  return `code-object://${index}`;
}

function isCodeAssetPlaceholder(value: string): boolean {
  return value.startsWith('code-asset://');
}

function isCodeMissingAsset(value: string): boolean {
  return value.startsWith('code-asset-missing://');
}

function placementObject(
  placement: PlacementIntent,
  objectId: string,
  terrainMap: EditableMap,
  sceneMode: EditableMap['sceneMode']
): Extract<MapOperation, { type: 'object.add' }>['object'] {
  return {
    id: objectId,
    name: placement.name,
    assetId: placement.assetId,
    locked: sceneMode === 'outdoor' && placement.role === 'structure' && !FLOATING_WATER_ASSET.test(placement.semantic),
    heightMode: placement.heightMode,
    ...(placement.roomOpeningId ? { roomOpeningId: placement.roomOpeningId } : {}),
    ...(placement.designGroupId ? { designGroupId: placement.designGroupId } : {}),
    ...(placement.compositionLayer ? { compositionLayer: placement.compositionLayer } : {}),
    ...(placement.sourceGuideId ? { sourceGuideId: placement.sourceGuideId } : {}),
    ...(placement.foundation ? { foundation: placement.foundation } : {}),
    transform: {
      position: placement.heightMode === 'terrain'
        ? [placement.position[0], sampleTerrainHeight(terrainMap, placement.position[0], placement.position[2]), placement.position[2]]
        : placement.position,
      rotation: [0, placement.rotationY, 0],
      scale: placement.scale,
      size: placement.size
    }
  };
}

function placementDesignMetadata(
  groupIdValue: unknown,
  layerValue: unknown
): { designGroupId?: string; compositionLayer?: MapCompositionLayer } {
  const designGroupId = typeof groupIdValue === 'string' ? groupIdValue.trim().slice(0, 80) : '';
  const layer = Number(layerValue);
  return {
    ...(designGroupId ? { designGroupId } : {}),
    ...([1, 2, 3, 4].includes(layer) ? { compositionLayer: layer as MapCompositionLayer } : {})
  };
}

function remapMapDesignObjectReferences(
  design: MapDesignSemantics,
  objectIdByReference: ReadonlyMap<string, string>
): MapDesignSemantics {
  const resolve = (id: string) => objectIdByReference.get(id) ?? id;
  return {
    ...design,
    groups: design.groups.map((group) => ({
      ...group,
      protectedObjectIds: group.protectedObjectIds.map(resolve),
      removableObjectIds: group.removableObjectIds.map(resolve)
    })),
    focuses: design.focuses.map((focus) => ({
      ...focus,
      ...(focus.objectId ? { objectId: resolve(focus.objectId) } : {})
    }))
  };
}

function resolveMapCodeAssetId(name: string | undefined, assets: readonly MapAsset[]): string | null {
  const normalizedName = String(name ?? '').trim().toLowerCase();
  if (!normalizedName) return null;
  const exact = assets.find((asset) => asset.name.trim().toLowerCase() === normalizedName);
  return exact?.id ?? null;
}

function inferCodeAssetRole(semantic: string): CodeAssetRole {
  return ENVIRONMENT_ASSET.test(semantic) ? 'environment' : 'structure';
}

function normalizeCodePlacementRole(
  value: unknown,
  sceneMode: EditableMap['sceneMode']
): CodeAssetRole | undefined {
  if (value === undefined) return undefined;
  const allowed: readonly CodeAssetRole[] = sceneMode === 'indoor'
    ? ['functional', 'decor']
    : ['structure', 'environment'];
  if (allowed.includes(value as CodeAssetRole)) return value as CodeAssetRole;
  throw new Error('invalid_map_code_asset_role');
}

function normalizeCodeTerrainPreset(value: string): TerrainGenerationPreset | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  const exact = TERRAIN_GENERATION_PRESETS.find((item) => item.replace(/-/g, ' ') === normalized);
  if (exact) return exact;
  const aliases: Array<[RegExp, TerrainGenerationPreset]> = [
    [/\b(?:plain|flat|level)\b|平原|平地|平坦/, 'plain'],
    [/\b(?:rolling|undulating|hilly|hill)\b|丘陵|起伏/, 'hills'],
    [/\b(?:valley|basin)\b|山谷|谷地|盆地/, 'valley'],
    [/\b(?:archipelago|island chain)\b|群岛/, 'archipelago'],
    [/\b(?:island|isle)\b|岛屿|小岛/, 'island'],
    [/\b(?:canyon|gorge)\b|峡谷/, 'canyon'],
    [/\b(?:cliff plateau|mesa|tableland)\b|悬崖台地|高原/, 'cliff-plateau'],
    [/\b(?:dune|desert)\b|沙丘|沙漠/, 'dune-desert']
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1];
}

function normalizeCodeTerrainModifier(value: string): TerrainModifier | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  const exact = TERRAIN_MODIFIERS.find((item) => item === normalized);
  if (exact) return exact;
  const aliases: Array<[RegExp, TerrainModifier]> = [
    [/\bbasin\b|盆地|洼地|凹地/, 'basin'],
    [/\bmountain\b|山峰|高山/, 'mountain'],
    [/\bridge\b|山脊|山梁/, 'ridge'],
    [/\bvalley\b|山谷|谷地/, 'valley'],
    [/\bcliff\b|悬崖|峭壁/, 'cliff'],
    [/\bterrace\b|梯田|台地/, 'terrace'],
    [/\bdune\b|沙丘/, 'dune'],
    [/\bisland\b|岛屿|小岛/, 'island']
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1];
}

function normalizeCodeTerrainSurface(value: string): TerrainSurfaceKind | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  const exact = TERRAIN_SURFACES.find((item) => item === normalized);
  if (exact) return exact;
  const aliases: Array<[RegExp, TerrainSurfaceKind]> = [
    [/\b(?:paving|paved|pavement|cobble|brick)\b|铺地|铺装|石板路|砖地/, 'paving'],
    [/\b(?:packed earth|earth|dirt|loam|mud)\b|夯土|泥土|土地/, 'soil'],
    [/\b(?:grass|lawn|turf)\b|草地|草坪/, 'grass'],
    [/\bsand\b|沙地|砂地/, 'sand'],
    [/\b(?:rock|stone)\b|岩石|裸岩/, 'rock']
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1];
}

function codeTerrainMagnitude(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : undefined;
}

function codeTerrainDirection(value: unknown): number | undefined {
  const pair = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).z]
      : null;
  if (pair && pair.length >= 2 && pair.slice(0, 2).every((item) => Number.isFinite(Number(item)))) {
    return Math.atan2(Number(pair[1]), Number(pair[0])) * 180 / Math.PI;
  }
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const semantic = codeSemanticText(value);
  if (/\beast\b|向东|东西向/.test(semantic)) return 0;
  if (/\bsouth\b|向南|南北向/.test(semantic)) return 90;
  if (/\bwest\b|向西/.test(semantic)) return 180;
  if (/\bnorth\b|向北/.test(semantic)) return 270;
  return undefined;
}

function codeTerrainLayerCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length || undefined;
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return codeTerrainLayerCount(input.count ?? input.layers ?? input.steps);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function codeTerrainLayout(value: unknown, modifier: TerrainModifier): TerrainCliffLayout | undefined {
  const semantic = codeSemanticText(value);
  const exact = TERRAIN_CLIFF_LAYOUTS.find((item) => item === semantic);
  if (exact) return exact;
  if (/terrace|step|梯田|台阶/.test(semantic) || modifier === 'terrace') return 'terraces';
  if (/coast|shore|海岸|岸线/.test(semantic)) return 'coast';
  if (/canyon|gorge|峡谷/.test(semantic)) return 'canyon';
  if (/wall|barrier|城墙|峭壁墙/.test(semantic)) return 'wall';
  if (/plateau|tableland|高原|平台/.test(semantic) || modifier === 'cliff') return 'plateau';
  return undefined;
}

function codeTerrainAccess(value: unknown): TerrainAccessMode | undefined {
  const semantic = codeSemanticText(value);
  const exact = TERRAIN_ACCESS_MODES.find((item) => item === semantic);
  if (exact) return exact;
  if (/walk|path|pass|play|通行|步行|可玩/.test(semantic)) return 'walkable';
  if (/scenic|visual|steep|landmark|观景|景观|陡峭/.test(semantic)) return 'scenic';
  return undefined;
}

function codeSemanticText(value: unknown): string {
  if (Array.isArray(value)) return value.map(codeSemanticText).join(' ').toLowerCase();
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(codeSemanticText).join(' ').toLowerCase();
  return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function codeObject(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function optionalFinite(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : finite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanId(value: unknown, fallback: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || `${fallback}-${Math.abs(hashText(String(value ?? fallback)))}`;
}

function codePointArray(value: unknown, error: string): Point2[] {
  if (!Array.isArray(value)) throw new Error(error);
  return value.map((point) => point2(point));
}

function solveWaterCrossing(
  water: MapWaterBody,
  center: Point2,
  direction: Point2,
  bankInsetValue: number,
  bridgeWidthValue = 0
): { start: Point2; end: Point2 } {
  const boundary = waterBoundaryPoints(water);
  if (boundary.length < 3) throw new Error('invalid_map_code_bridge_water_boundary');
  const bridgeWidth = clampFinite(bridgeWidthValue, 0, 16);
  const normal: Point2 = [-direction[1], direction[0]];
  const offsets = bridgeWidth > 0.1 ? [-bridgeWidth / 2, 0, bridgeWidth / 2] : [0];
  const spans = offsets.map((offset) => lineWaterSpan(
    boundary,
    [center[0] + normal[0] * offset, center[1] + normal[1] * offset],
    direction
  ));
  const low = Math.min(...spans.map((span) => span.low));
  const high = Math.max(...spans.map((span) => span.high));
  const bankInset = clampFinite(bankInsetValue, 0.2, 8);
  return {
    start: codePoint(center[0] + direction[0] * (low - bankInset), center[1] + direction[1] * (low - bankInset)),
    end: codePoint(center[0] + direction[0] * (high + bankInset), center[1] + direction[1] * (high + bankInset))
  };
}

function lineWaterSpan(
  boundary: Point2[],
  center: Point2,
  direction: Point2
): { low: number; high: number } {
  const hits: number[] = [];
  for (let index = 0; index < boundary.length; index += 1) {
    const start = boundary[index];
    const end = boundary[(index + 1) % boundary.length];
    const segment: Point2 = [end[0] - start[0], end[1] - start[1]];
    const denominator = cross2(direction, segment);
    if (Math.abs(denominator) < 0.000001) continue;
    const offset: Point2 = [start[0] - center[0], start[1] - center[1]];
    const lineAmount = cross2(offset, segment) / denominator;
    const segmentAmount = cross2(offset, direction) / denominator;
    if (segmentAmount < -0.000001 || segmentAmount > 1.000001) continue;
    if (!hits.some((value) => Math.abs(value - lineAmount) < 0.001)) hits.push(lineAmount);
  }
  hits.sort((left, right) => left - right);
  const before = hits.filter((value) => value <= 0).at(-1);
  const after = hits.find((value) => value >= 0);
  const low = before ?? hits[0];
  const high = after ?? hits.at(-1);
  if (low === undefined || high === undefined || high - low < 0.1) {
    throw new Error('invalid_map_code_bridge_crossing');
  }
  return { low, high };
}

function quadraticBridgePoints(start: Point2, end: Point2, curveOffset: number, segmentCount: number): Point2[] {
  const direction: Point2 = [end[0] - start[0], end[1] - start[1]];
  const length = Math.max(0.0001, Math.hypot(direction[0], direction[1]));
  const normal: Point2 = [-direction[1] / length, direction[0] / length];
  const control: Point2 = [
    (start[0] + end[0]) / 2 + normal[0] * curveOffset,
    (start[1] + end[1]) / 2 + normal[1] * curveOffset
  ];
  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    const t = index / segmentCount;
    const inverse = 1 - t;
    return codePoint(
      inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
      inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1]
    );
  });
}

function clampInteger(value: unknown, min: number, max: number): number {
  return Math.round(clampFinite(Number(value), min, max));
}

function cross2(left: Point2, right: Point2): number {
  return left[0] * right[1] - left[1] * right[0];
}

function codeTerrainRegion(value: unknown): TerrainRegion {
  const region = codeObject(value, 'invalid_map_code_terrain_region');
  if (region.kind === 'circle') {
    const center = region.center === undefined ? [region.x, region.z] : region.center;
    const [x, z] = point2(center);
    return {
      kind: 'circle',
      x,
      z,
      radius: Math.max(0.1, finite(region.radius ?? region.r))
    };
  }
  if (region.kind === 'path') {
    return {
      kind: 'path',
      points: codePointArray(region.points, 'invalid_map_code_terrain_region').slice(0, 64),
      width: Math.max(0.1, finite(region.width))
    };
  }
  if (region.kind === 'polygon') {
    return {
      kind: 'polygon',
      points: codePointArray(region.points, 'invalid_map_code_terrain_region').slice(0, 64)
    };
  }
  throw new Error('invalid_map_code_terrain_region');
}

function codeGrassRegion(value: unknown): GrassRegion {
  const region = codeObject(value, 'invalid_map_code_grass_region');
  const points = region.points ?? region.outline ?? region.boundary
    ?? (Array.isArray(region.outer) ? region.outer : undefined);
  const center = region.center ?? region.origin ?? region.position
    ?? (region.x !== undefined || region.z !== undefined ? [region.x, region.z] : undefined);
  const radius = region.radius ?? region.r
    ?? (typeof region.outer === 'number' ? region.outer : undefined)
    ?? region.outerRadius;
  if (region.kind === 'circle' || (center !== undefined && radius !== undefined)) {
    return {
      kind: 'circle',
      center: point2(center),
      radius: Math.max(0.1, finite(radius))
    };
  }
  if (region.kind === 'polygon' || points !== undefined) {
    return {
      kind: 'polygon',
      points: codePointArray(points, 'invalid_map_code_grass_region').slice(0, 64)
    };
  }
  throw new Error('invalid_map_code_grass_region');
}

interface CodeAccessCorridor {
  start: Point2;
  end: Point2;
  halfWidth: number;
}

function relocateOutdoorWaterIntrusions(
  terrainMap: EditableMap,
  operations: readonly Extract<MapOperation, { type: 'object.add' }>[],
  placements: readonly PlacementIntent[],
  assets: readonly MapAsset[]
): { operations: Array<Extract<MapOperation, { type: 'object.add' }>>; count: number } {
  if (terrainMap.waterBodies.length === 0) return { operations: [...operations], count: 0 };
  const assetById = new Map([...(terrainMap.assets ?? []), ...assets].map((asset) => [asset.id, asset]));
  const repaired = [...operations];
  const eligible = operations.flatMap((operation, index) => {
    const placement = placements[index];
    const asset = operation.object.assetId ? assetById.get(operation.object.assetId) : undefined;
    const semantic = [placement?.semantic, operation.object.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])]
      .filter(Boolean)
      .join(' ');
    return operation.object.heightMode === 'terrain'
      && !placement?.bridgeWaterId
      && DRY_LAND_ASSET.test(semantic)
      && !WATER_COMPATIBLE_ASSET.test(semantic)
      ? [{ index, placement, semantic }]
      : [];
  });
  const grouped = new Set<number>();
  const batches: number[][] = [];
  for (const candidate of eligible) {
    if (grouped.has(candidate.index)) continue;
    const placement = candidate.placement;
    const continuous = placement && CONTINUOUS_STRUCTURE_ASSET.test(candidate.semantic);
    const batch = continuous
      ? eligible.filter((other) => (
        other.placement?.assetId === placement.assetId
        && other.placement?.designGroupId === placement.designGroupId
        && other.placement?.compositionLayer === placement.compositionLayer
        && CONTINUOUS_STRUCTURE_ASSET.test(other.semantic)
      )).map((other) => other.index)
      : [candidate.index];
    batch.forEach((index) => grouped.add(index));
    batches.push(batch);
  }
  let count = 0;
  for (const batch of batches) {
    const points = batch.flatMap((index) => {
      const transform = repaired[index].object.transform!;
      const center = [transform.position![0], transform.position![2]] satisfies Point2;
      const connection = placements[index]?.connection;
      if (!connection) return [center];
      return [
        center,
        connection.start,
        midpoint2(connection.start, connection.end),
        connection.end
      ];
    });
    if (points.every((point) => pointIsDry(terrainMap, point, 0.45))) continue;
    const translation = findDryTranslation(terrainMap, points, 0.45);
    if (!translation) continue;
    for (const index of batch) {
      const operation = repaired[index];
      const transform = operation.object.transform!;
      const x = transform.position![0] + translation[0];
      const z = transform.position![2] + translation[1];
      repaired[index] = {
        ...operation,
        object: {
          ...operation.object,
          transform: {
            ...transform,
            position: [x, sampleTerrainHeight(terrainMap, x, z), z]
          }
        }
      };
      count += 1;
    }
  }
  return { operations: repaired, count };
}

function nearestDryPoint(map: EditableMap, point: Point2, clearance: number): Point2 {
  const translation = findDryTranslation(map, [point], clearance);
  return translation ? codePoint(point[0] + translation[0], point[1] + translation[1]) : codePoint(point[0], point[1]);
}

function findDryTranslation(map: EditableMap, points: readonly Point2[], clearance: number): Point2 | null {
  if (points.every((point) => pointIsDry(map, point, clearance))) return codePoint(0, 0);
  const bounds = getMapBounds(map);
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const primaryAngles = [-Math.PI / 2, Math.PI / 2, 0, Math.PI];
  const angles = [
    ...primaryAngles,
    ...Array.from({ length: 24 }, (_, index) => index * Math.PI * 2 / 24)
      .filter((angle) => !primaryAngles.some((primary) => Math.abs(Math.sin((angle - primary) / 2)) < 0.0001))
  ];
  for (let radius = 0.5; radius <= extent; radius += 0.5) {
    for (const angle of angles) {
      const translation: Point2 = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      const candidates = points.map((point) => codePoint(point[0] + translation[0], point[1] + translation[1]));
      if (candidates.some((point) => point[0] < bounds.minX || point[0] > bounds.maxX || point[1] < bounds.minZ || point[1] > bounds.maxZ)) continue;
      if (candidates.every((point) => pointIsDry(map, point, clearance))) return translation;
    }
  }
  return null;
}

function pointIsDry(map: EditableMap, point: Point2, clearance: number): boolean {
  if (map.waterBodies.some((water) => isPointInsideWaterBody(water, point[0], point[1], map))) return false;
  return distanceToWater(map, point[0], point[1]) >= clearance;
}

function relocateOutdoorAccessBlockers(
  terrainMap: EditableMap,
  operations: readonly Extract<MapOperation, { type: 'object.add' }>[],
  assets: readonly MapAsset[]
): { operations: Array<Extract<MapOperation, { type: 'object.add' }>>; count: number } {
  if (terrainMap.sceneMode !== 'outdoor') return { operations: [...operations], count: 0 };
  const assetById = new Map([...(terrainMap.assets ?? []), ...assets].map((asset) => [asset.id, asset]));
  const player = getMapPlayerMetrics(terrainMap);
  const corridors = operations.flatMap((operation): CodeAccessCorridor[] => {
    if (!operation.object.locked || !operation.object.assetId) return [];
    const asset = assetById.get(operation.object.assetId);
    const semantic = [operation.object.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
    if (!ENTRANCE_ASSET.test(semantic)) return [];
    const transform = operation.object.transform!;
    const radius = (asset?.footprintRadius ?? (asset ? assetFootprintRadius(asset.colliderPlan) : 0.8))
      * Math.max(transform.scale?.[0] ?? 1, transform.scale?.[2] ?? 1);
    const yaw = transform.rotation?.[1] ?? 0;
    const direction: Point2 = [Math.sin(yaw), Math.cos(yaw)];
    const reach = Math.max(player.height * 2.2, radius * 1.25);
    return [{
      start: [transform.position![0] - direction[0] * reach, transform.position![2] - direction[1] * reach],
      end: [transform.position![0] + direction[0] * reach, transform.position![2] + direction[1] * reach],
      halfWidth: Math.max(player.radius * 1.6, Math.min(player.height * 1.25, radius * 0.45))
    }];
  });
  if (corridors.length === 0) return { operations: [...operations], count: 0 };
  const bounds = getMapBounds(terrainMap);
  let count = 0;
  return {
    operations: operations.map((operation) => {
      if (operation.object.locked) return operation;
      const transform = operation.object.transform!;
      const asset = operation.object.assetId ? assetById.get(operation.object.assetId) : undefined;
      const radius = (asset?.footprintRadius ?? (asset ? assetFootprintRadius(asset.colliderPlan) : 0.4))
        * Math.max(transform.scale?.[0] ?? 1, transform.scale?.[2] ?? 1);
      const point: Point2 = [transform.position![0], transform.position![2]];
      const blocking = corridors.find((corridor) => pointSegmentDistance(point, corridor.start, corridor.end) < corridor.halfWidth + radius);
      if (!blocking) return operation;
      const relocated = relocateBesideCorridor(point, radius, blocking, bounds);
      count += 1;
      return {
        ...operation,
        object: {
          ...operation.object,
          transform: {
            ...transform,
            position: [
              relocated[0],
              operation.object.heightMode === 'terrain'
                ? sampleTerrainHeight(terrainMap, relocated[0], relocated[1])
                : transform.position![1],
              relocated[1]
            ]
          }
        }
      };
    }),
    count
  };
}

function relocateBesideCorridor(
  point: Point2,
  radius: number,
  corridor: CodeAccessCorridor,
  bounds: ReturnType<typeof getMapBounds>
): Point2 {
  const dx = corridor.end[0] - corridor.start[0];
  const dz = corridor.end[1] - corridor.start[1];
  const length = Math.max(0.0001, Math.hypot(dx, dz));
  const direction: Point2 = [dx / length, dz / length];
  const perpendicular: Point2 = [-direction[1], direction[0]];
  const amount = clampFinite(
    ((point[0] - corridor.start[0]) * dx + (point[1] - corridor.start[1]) * dz) / (length * length),
    0,
    1
  );
  const closest: Point2 = [corridor.start[0] + dx * amount, corridor.start[1] + dz * amount];
  const side = (point[0] - closest[0]) * perpendicular[0] + (point[1] - closest[1]) * perpendicular[1] >= 0 ? 1 : -1;
  const distance = corridor.halfWidth + radius + 0.35;
  const candidate: Point2 = [closest[0] + perpendicular[0] * distance * side, closest[1] + perpendicular[1] * distance * side];
  return [
    clampFinite(candidate[0], bounds.minX + radius, bounds.maxX - radius),
    clampFinite(candidate[1], bounds.minZ + radius, bounds.maxZ - radius)
  ];
}

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.0001) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const amount = Math.min(1, Math.max(0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + dx * amount), point[1] - (start[1] + dz * amount));
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash | 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function placementPosition(value: PlacementInput['position'], map: EditableMap, terrain: boolean): Point3 {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'point' in value) {
    return placementPosition(value.point, map, terrain);
  }
  if (Array.isArray(value) && value.length === 3) return point3(value);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'x' in value && 'z' in value) {
    const x = finite(value.x);
    const z = finite(value.z);
    if (value.y !== undefined) return [x, finite(value.y), z];
    return [x, terrain ? sampleTerrainHeight(map, x, z) : map.sceneMode === 'indoor' ? map.room?.position[1] ?? 0 : 0, z];
  }
  if (Array.isArray(value) && value.length === 2) {
    const position = point2(value);
    return [
      position[0],
      terrain ? sampleTerrainHeight(map, position[0], position[1]) : map.sceneMode === 'indoor' ? map.room?.position[1] ?? 0 : 0,
      position[1]
    ];
  }
  throw new Error(`invalid_map_code_position:${describeCodeValue(value)}`);
}

function placementUsesTerrain(value: PlacementInput['position']): boolean {
  if (Array.isArray(value)) return value.length === 2;
  if (!value || typeof value !== 'object') return false;
  if ('point' in value) return placementUsesTerrain(value.point);
  return 'x' in value && 'z' in value && value.y === undefined;
}

function requireIndoorRoom(room: MapRoom | null): MapRoom {
  if (!room) throw new Error('map_code_indoor_api_requires_room');
  return room;
}

function normalizeRoomWall(value: unknown): RoomWall {
  if (value === 'north' || value === 'south' || value === 'east' || value === 'west') return value;
  throw new Error('invalid_map_code_room_wall');
}

function normalizeAttachmentAnchor(value: unknown): 'bottom' | 'center' | 'top' | undefined {
  return value === 'bottom' || value === 'center' || value === 'top' ? value : undefined;
}

function roomInteriorPoint(room: MapRoom, localX: number, localZ: number): Point2 {
  const inset = room.wallThickness;
  return codePoint(
    room.position[0] + clampFinite(localX, -room.size[0] / 2 + inset, room.size[0] / 2 - inset),
    room.position[2] + clampFinite(localZ, -room.size[2] / 2 + inset, room.size[2] / 2 - inset)
  );
}

function roomWallFrame(
  room: MapRoom,
  wall: RoomWall,
  rawOffset: number,
  rawBottom: number,
  rawInset: number
): RoomWallFrame {
  const horizontalLength = wall === 'north' || wall === 'south' ? room.size[0] : room.size[2];
  const offset = clampFinite(rawOffset, -horizontalLength / 2 + room.wallThickness, horizontalLength / 2 - room.wallThickness);
  const bottom = clampFinite(rawBottom, 0, room.size[1] - room.wallThickness);
  const inset = Math.max(0, finite(rawInset)) + room.wallThickness / 2;
  const directions: Record<RoomWall, { inward: Point2; tangent: Point2 }> = {
    north: { inward: codePoint(0, 1), tangent: codePoint(1, 0) },
    south: { inward: codePoint(0, -1), tangent: codePoint(-1, 0) },
    east: { inward: codePoint(-1, 0), tangent: codePoint(0, 1) },
    west: { inward: codePoint(1, 0), tangent: codePoint(0, -1) }
  };
  const direction = directions[wall];
  const point: Point3 = wall === 'north'
    ? [room.position[0] + offset, room.position[1] + bottom, room.position[2] - room.size[2] / 2 + inset]
    : wall === 'south'
      ? [room.position[0] + offset, room.position[1] + bottom, room.position[2] + room.size[2] / 2 - inset]
      : wall === 'east'
        ? [room.position[0] + room.size[0] / 2 - inset, room.position[1] + bottom, room.position[2] + offset]
        : [room.position[0] - room.size[0] / 2 + inset, room.position[1] + bottom, room.position[2] + offset];
  return {
    point,
    inward: direction.inward,
    outward: codePoint(-direction.inward[0], -direction.inward[1]),
    tangent: direction.tangent
  };
}

function roomOpeningPlacement(room: MapRoom, openings: readonly MapRoomOpening[], openingId: string): Point3 {
  const opening = openings.find((item) => item.id === openingId);
  if (!opening) throw new Error(`unknown_map_code_room_opening:${openingId}`);
  return roomWallFrame(room, opening.wall, opening.offset, opening.bottom, 0.02).point;
}

function fittedPlacementTransform(
  asset: MapAsset | undefined,
  rawScale: number | Point3,
  dimensions?: Point3,
  visualBounds?: Aabb
): { scale: Point3 } {
  const scale = scale3(rawScale);
  if (!asset || !dimensions) return { scale };
  const bounds = visualBounds ?? calculateModelVisualBounds(asset.modelJson);
  const actualDimensions: Point3 = [
    Math.max(0.000001, bounds.max[0] - bounds.min[0]),
    Math.max(0.000001, bounds.max[1] - bounds.min[1]),
    Math.max(0.000001, bounds.max[2] - bounds.min[2])
  ];
  for (let axis = 0; axis < 3; axis += 1) scale[axis] /= actualDimensions[axis];
  return { scale };
}

function fitConnectedPlacementRuns(placements: PlacementIntent[], assets: readonly MapAsset[]): void {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  fitExplicitConnectedPlacementRuns(placements, assetById);
  const groups = new Map<string, Array<{ index: number; placement: PlacementIntent }>>();
  placements.forEach((placement, index) => {
    if (!placement.assetId || placement.connectionMode === 'explicit' || placement.attachment || placement.bridgeWaterId) return;
    if (placement.role !== 'structure' || !CONTINUOUS_STRUCTURE_ASSET.test(placement.semantic)) return;
    if (!placement.size.every((value) => Math.abs(value - 1) < 0.000001)) return;
    if (!assetById.has(placement.assetId)) return;
    const key = [placement.assetId, placement.designGroupId ?? '', placement.compositionLayer ?? 0].join('|');
    const group = groups.get(key) ?? [];
    group.push({ index, placement });
    groups.set(key, group);
  });

  for (const entries of groups.values()) {
    if (entries.length < 3) continue;
    const distances = entries.slice(1).map((entry, index) => horizontalDistance(entries[index].placement, entry.placement));
    const typicalDistance = median(distances.filter((distance) => distance > 0.001));
    if (!Number.isFinite(typicalDistance) || typicalDistance <= 0) continue;
    const gapThreshold = Math.max(typicalDistance * 1.8, typicalDistance + 1);
    const runs: typeof entries[] = [];
    let run: typeof entries = [entries[0]];
    for (let index = 1; index < entries.length; index += 1) {
      if (distances[index - 1] > gapThreshold) {
        runs.push(run);
        run = [];
      }
      run.push(entries[index]);
    }
    runs.push(run);
    const closesLoop = runs.length === 1
      && horizontalDistance(entries.at(-1)!.placement, entries[0].placement) <= gapThreshold;
    const asset = assetById.get(entries[0].placement.assetId!);
    if (!asset) continue;
    for (const connectedRun of runs) {
      if (connectedRun.length < 3) continue;
      fitConnectedPlacementRun(connectedRun.map((entry) => entry.placement), asset, closesLoop);
    }
  }
}

function fitExplicitConnectedPlacementRuns(
  placements: PlacementIntent[],
  assetById: ReadonlyMap<string, MapAsset>
): void {
  const groups = new Map<string, PlacementIntent[]>();
  for (const placement of placements) {
    if (!placement.assetId || !placement.connection || !assetById.has(placement.assetId)) continue;
    const key = [placement.assetId, placement.designGroupId ?? '', placement.compositionLayer ?? 0].join('|');
    const group = groups.get(key) ?? [];
    group.push(placement);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const asset = assetById.get(group[0].assetId!);
    if (!asset) continue;
    const semantic = [asset.name, asset.prompt, ...(asset.tags ?? [])].join(' ');
    const implicitFrontTarget = ARENA_SEATING_ASSET.test(semantic)
      ? group.reduce((sum, placement) => {
          const connection = placement.connection!;
          return [
            sum[0] + (connection.start[0] + connection.end[0]) / 2 / group.length,
            sum[1] + (connection.start[1] + connection.end[1]) / 2 / group.length
          ] as Point2;
        }, [0, 0] as Point2)
      : undefined;
    const runs: PlacementIntent[][] = [];
    let run: PlacementIntent[] = [];
    for (const placement of group) {
      const previous = run.at(-1)?.connection;
      const current = placement.connection!;
      if (previous && pointDistance2(previous.end, current.start) > 0.05) {
        if (run.length > 0) runs.push(run);
        run = [];
      }
      run.push(placement);
    }
    if (run.length > 0) runs.push(run);
    for (const connected of runs) fitExplicitConnectedPlacementRun(connected, asset, implicitFrontTarget);
  }
}

function fitExplicitConnectedPlacementRun(run: PlacementIntent[], asset: MapAsset, implicitFrontTarget?: Point2): void {
  if (run.length === 0) return;
  const bounds = calculateModelVisualBounds(asset.modelJson);
  const actual: Point3 = [
    Math.max(0.000001, bounds.max[0] - bounds.min[0]),
    Math.max(0.000001, bounds.max[1] - bounds.min[1]),
    Math.max(0.000001, bounds.max[2] - bounds.min[2])
  ];
  const closed = run.length >= 3
    && pointDistance2(run.at(-1)!.connection!.end, run[0].connection!.start) <= 0.05;
  run.forEach((placement, index) => {
    const connection = placement.connection!;
    const spanIndex = connection.spanAxis === 'x' ? 0 : 2;
    const crossIndex = connection.spanAxis === 'x' ? 2 : 0;
    const direction = normalizedDirection(connection.start, connection.end);
    const previous = index > 0 ? run[index - 1] : closed ? run.at(-1)! : undefined;
    const next = index < run.length - 1 ? run[index + 1] : closed ? run[0] : undefined;
    const halfDepth = actual[crossIndex] * placement.scale[crossIndex] * placement.size[crossIndex] / 2;
    const startExtension = connection.gapRatio === 0 && previous
      ? connectedMiterExtension(previous.connection!, connection, halfDepth)
      : 0;
    const endExtension = connection.gapRatio === 0 && next
      ? connectedMiterExtension(connection, next.connection!, halfDepth)
      : 0;
    const start = codePoint(
      connection.start[0] - direction[0] * startExtension,
      connection.start[1] - direction[1] * startExtension
    );
    const end = codePoint(
      connection.end[0] + direction[0] * endExtension,
      connection.end[1] + direction[1] * endExtension
    );
    const targetSize: Point3 = [...placement.size];
    targetSize[spanIndex] = pointDistance2(connection.start, connection.end) * (1 - connection.gapRatio)
      + startExtension + endExtension;
    const lineRotation = spanIndex === 0
      ? Math.atan2(-(end[1] - start[1]), end[0] - start[0])
      : yawFromDirection([end[0] - start[0], end[1] - start[1]]);
    const midpoint: Point2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const rotationY = connection.frontTarget || implicitFrontTarget
      ? parallelYawFacingTarget(lineRotation, midpoint, connection.frontTarget ?? implicitFrontTarget!)
      : lineRotation;
    placement.size = targetSize;
    placement.rotationY = rotationY;
    placement.position = centeredVisualPlacement(asset, midpoint, placement.position[1], rotationY, placement.scale, targetSize);
  });
}

function connectedMiterExtension(previous: NonNullable<PlacementIntent['connection']>, next: NonNullable<PlacementIntent['connection']>, halfDepth: number): number {
  const incoming = normalizedDirection(previous.start, previous.end);
  const outgoing = normalizedDirection(next.start, next.end);
  const turn = Math.acos(clampFinite(incoming[0] * outgoing[0] + incoming[1] * outgoing[1], -1, 1));
  const shorter = Math.min(pointDistance2(previous.start, previous.end), pointDistance2(next.start, next.end));
  return Math.min(halfDepth * Math.tan(turn / 2), halfDepth * 1.5, shorter * 0.2);
}

function fitConnectedPlacementRun(run: PlacementIntent[], asset: MapAsset, closed: boolean): void {
  const bounds = calculateModelVisualBounds(asset.modelJson);
  const dimensions: Point3 = [
    Math.max(0.000001, bounds.max[0] - bounds.min[0]),
    Math.max(0.000001, bounds.max[1] - bounds.min[1]),
    Math.max(0.000001, bounds.max[2] - bounds.min[2])
  ];
  const spanIndex = dimensions[0] >= dimensions[2] ? 0 : 2;
  const original = run.map((placement) => [placement.position[0], placement.position[2]] satisfies Point2);
  run.forEach((placement, index) => {
    const point = original[index];
    const previous = original[(index - 1 + original.length) % original.length];
    const next = original[(index + 1) % original.length];
    const start = closed || index > 0
      ? midpoint2(previous, point)
      : codePoint(point[0] - (next[0] - point[0]) / 2, point[1] - (next[1] - point[1]) / 2);
    const end = closed || index < original.length - 1
      ? midpoint2(point, next)
      : codePoint(point[0] + (point[0] - previous[0]) / 2, point[1] + (point[1] - previous[1]) / 2);
    const direction = codePoint(end[0] - start[0], end[1] - start[1]);
    const length = Math.hypot(direction[0], direction[1]);
    if (length <= 0.000001) return;
    const targetSize: Point3 = [...dimensions];
    targetSize[spanIndex] = length;
    placement.rotationY = spanIndex === 0
      ? Math.atan2(-direction[1], direction[0])
      : yawFromDirection(direction);
    placement.scale = fittedPlacementTransform(asset, placement.scale, targetSize).scale;
    placement.size = targetSize;
    placement.position = centeredVisualPlacement(
      asset,
      [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
      placement.position[1],
      placement.rotationY,
      placement.scale,
      targetSize
    );
  });
}

function centeredVisualPlacement(
  asset: MapAsset,
  target: Point2,
  y: number,
  rotationY: number,
  scale: Point3,
  size: Point3
): Point3 {
  const bounds = calculateModelVisualBounds(asset.modelJson);
  const localX = (bounds.min[0] + bounds.max[0]) / 2 * scale[0] * size[0];
  const localZ = (bounds.min[2] + bounds.max[2]) / 2 * scale[2] * size[2];
  const worldX = localX * Math.cos(rotationY) + localZ * Math.sin(rotationY);
  const worldZ = -localX * Math.sin(rotationY) + localZ * Math.cos(rotationY);
  return [target[0] - worldX, y, target[1] - worldZ];
}

function normalizedDirection(start: Point2, end: Point2): Point2 {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.max(0.000001, Math.hypot(dx, dz));
  return codePoint(dx / length, dz / length);
}

function pointDistance2(left: Point2, right: Point2): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function midpoint2(left: Point2, right: Point2): Point2 {
  return codePoint((left[0] + right[0]) / 2, (left[1] + right[1]) / 2);
}

function horizontalDistance(left: PlacementIntent, right: PlacementIntent): number {
  return Math.hypot(left.position[0] - right.position[0], left.position[2] - right.position[2]);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function placementRotation(
  facing: PlacementInput['facing'],
  position: Point3,
  rotationY: number | undefined
): number {
  if (facing === undefined) return finite(rotationY ?? 0);
  const offsetY = !Array.isArray(facing) && facing && typeof facing === 'object'
    ? finite(facing.offsetY ?? 0)
    : 0;
  if (Array.isArray(facing)) return yawFromDirection(point2(facing)) + offsetY;
  if (!facing || typeof facing !== 'object') throw new Error('invalid_map_code_facing');
  if (facing.target !== undefined) {
    const target = point2(facing.target);
    return yawFromDirection([target[0] - position[0], target[1] - position[2]]) + offsetY;
  }
  if (facing.normal !== undefined) return yawFromDirection(point2(facing.normal)) + offsetY;
  if (facing.tangent !== undefined) return yawFromDirection(point2(facing.tangent)) + offsetY;
  if (facing.direction !== undefined) return yawFromDirection(point2(facing.direction)) + offsetY;
  throw new Error('invalid_map_code_facing');
}

function yawFromDirection(direction: Point2): number {
  return Math.atan2(finite(direction[0]), finite(direction[1]));
}

function parallelYawFacingTarget(lineRotation: number, position: Point2, target: Point2): number {
  const toward: Point2 = [target[0] - position[0], target[1] - position[1]];
  const front: Point2 = [Math.sin(lineRotation), Math.cos(lineRotation)];
  return front[0] * toward[0] + front[1] * toward[1] >= 0 ? lineRotation : lineRotation + Math.PI;
}

function point2(value: unknown): Point2 {
  if (Array.isArray(value) && value.length >= 2) return [finite(value[0]), finite(value[1])];
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    if (input.point !== undefined) return point2(input.point);
    if (input.x !== undefined && input.z !== undefined) return [finite(input.x), finite(input.z)];
    if (input.x !== undefined && input.y !== undefined) return [finite(input.x), finite(input.y)];
  }
  throw new Error(`invalid_map_code_point:${describeCodeValue(value)}`);
}

function codePoint(x: number, z: number): Point2 {
  const point: Point2 = [finite(x), finite(z)];
  Object.defineProperties(point, {
    x: { value: point[0], enumerable: false },
    z: { value: point[1], enumerable: false }
  });
  return point;
}

function point3(value: readonly number[]): Point3 {
  if (!Array.isArray(value) || value.length < 3) throw new Error('invalid_map_code_point');
  return [finite(value[0]), finite(value[1]), finite(value[2])];
}

function scale3(value: number | Point3): Point3 {
  if (Array.isArray(value)) return point3(value);
  const scale = Math.max(0.01, finite(value));
  return [scale, scale, scale];
}

function finite(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`non_finite_map_code_value:${describeCodeValue(value)}`);
  return number;
}

function describeCodeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'object') return `object(keys=${Object.keys(value).slice(0, 8).join(',')})`;
  return `${typeof value}:${String(value).slice(0, 80)}`;
}

function clampFinite(value: number, min: number, max: number): number {
  return Math.min(finite(max), Math.max(finite(min), finite(value)));
}

function boundedCount(value: number, min: number, max: number): number {
  return Math.round(clampFinite(value, min, max));
}

function cleanText(value: string, maxLength: number): string {
  return String(value).trim().slice(0, maxLength) || '程序化物体';
}

function bezierPoint(
  amount: number,
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2
): { point: Point2; tangent: Point2; normal: Point2 } {
  const inverse = 1 - amount;
  const inverse2 = inverse * inverse;
  const amount2 = amount * amount;
  const point = codePoint(
    inverse2 * inverse * p0[0] + 3 * inverse2 * amount * p1[0] + 3 * inverse * amount2 * p2[0] + amount2 * amount * p3[0],
    inverse2 * inverse * p0[1] + 3 * inverse2 * amount * p1[1] + 3 * inverse * amount2 * p2[1] + amount2 * amount * p3[1]
  );
  const tangent = codePoint(
    3 * inverse2 * (p1[0] - p0[0]) + 6 * inverse * amount * (p2[0] - p1[0]) + 3 * amount2 * (p3[0] - p2[0]),
    3 * inverse2 * (p1[1] - p0[1]) + 6 * inverse * amount * (p2[1] - p1[1]) + 3 * amount2 * (p3[1] - p2[1])
  );
  const fallback = codePoint(p3[0] - p0[0], p3[1] - p0[1]);
  const direction = Math.hypot(tangent[0], tangent[1]) > 0.000001 ? tangent : fallback;
  const length = Math.max(0.000001, Math.hypot(direction[0], direction[1]));
  const normal = codePoint(-direction[1] / length, direction[0] / length);
  return { point, tangent, normal };
}

function sampleBezierFramesBySpacing(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2,
  rawSpacing: number,
  rawGapRatio = 0.08
): BezierFrame[] {
  const spacing = Math.max(0.01, finite(rawSpacing));
  const gapRatio = clampFinite(rawGapRatio, 0, 0.25);
  const denseCount = 256;
  const denseFrames = Array.from({ length: denseCount + 1 }, (_, index) => (
    bezierPoint(index / denseCount, p0, p1, p2, p3)
  ));
  const cumulative = [0];
  for (let index = 1; index < denseFrames.length; index += 1) {
    const previous = denseFrames[index - 1].point;
    const current = denseFrames[index].point;
    cumulative.push(cumulative[index - 1] + Math.hypot(current[0] - previous[0], current[1] - previous[1]));
  }
  const totalLength = cumulative[cumulative.length - 1];
  const effectiveSpacing = spacing * (1 + gapRatio);
  const segmentCount = Math.max(1, Math.min(MAX_POINT_RESULTS - 1, Math.floor(totalLength / effectiveSpacing)));
  return Array.from({ length: segmentCount + 1 }, (_, index) => (
    interpolateBezierFrame(denseFrames, cumulative, totalLength * index / segmentCount)
  ));
}

function interpolateBezierFrame(
  frames: readonly BezierFrame[],
  cumulative: readonly number[],
  targetDistance: number
): BezierFrame {
  let right = 1;
  while (right < cumulative.length - 1 && cumulative[right] < targetDistance) right += 1;
  const left = Math.max(0, right - 1);
  const span = Math.max(0.000001, cumulative[right] - cumulative[left]);
  const amount = clampFinite((targetDistance - cumulative[left]) / span, 0, 1);
  const previous = frames[left];
  const next = frames[right];
  const point = codePoint(
    previous.point[0] + (next.point[0] - previous.point[0]) * amount,
    previous.point[1] + (next.point[1] - previous.point[1]) * amount
  );
  const tangent = codePoint(
    previous.tangent[0] + (next.tangent[0] - previous.tangent[0]) * amount,
    previous.tangent[1] + (next.tangent[1] - previous.tangent[1]) * amount
  );
  return frameFromTangent(point, tangent);
}

function frameFromTangent(point: Point2, tangent: Point2): BezierFrame {
  const length = Math.max(0.000001, Math.hypot(tangent[0], tangent[1]));
  return {
    point,
    tangent,
    normal: codePoint(-tangent[1] / length, tangent[0] / length)
  };
}

function poissonDiskPoints(
  rawBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  rawMinDistance: number,
  rawMaxPoints = 128,
  rawAttempts = 30,
  seed = 1
): Point2[] {
  const bounds = {
    minX: finite(rawBounds.minX),
    maxX: finite(rawBounds.maxX),
    minZ: finite(rawBounds.minZ),
    maxZ: finite(rawBounds.maxZ)
  };
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new Error('invalid_poisson_bounds');
  const minDistance = Math.max(0.05, finite(rawMinDistance));
  const maxPoints = boundedCount(rawMaxPoints, 1, MAX_POINT_RESULTS);
  const attempts = boundedCount(rawAttempts, 1, 100);
  const random = mulberry32(Math.trunc(finite(seed)));
  const points: Point2[] = [];
  const maxCandidates = maxPoints * attempts;
  for (let candidate = 0; candidate < maxCandidates && points.length < maxPoints; candidate += 1) {
    const point = codePoint(
      bounds.minX + random() * (bounds.maxX - bounds.minX),
      bounds.minZ + random() * (bounds.maxZ - bounds.minZ)
    );
    if (points.every((existing) => Math.hypot(existing[0] - point[0], existing[1] - point[1]) >= minDistance)) {
      points.push(point);
    }
  }
  return points;
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

function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function safeMath(random: () => number): Readonly<Record<string, unknown>> {
  const math = Object.fromEntries(Object.getOwnPropertyNames(Math).map((name) => [
    name,
    name === 'random' ? random : Reflect.get(Math, name)
  ]));
  return Object.freeze(math);
}
