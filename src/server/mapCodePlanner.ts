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
import { assetFootprintRadius, normalizeAssetTags, normalizeMapAssetLight, type MapAssetLight } from '../shared/mapAssetMetadata';
import { planMapObjectAttachment } from '../shared/mapAttachment';
import { indoorAssetTargetCount } from '../shared/indoorScenePlanning';
import { normalizeMapAiMaxNewAssets, normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import { calculateModelVisualBounds, inspectModelSpace, type Aabb } from '../shared/modelBounds';
import { normalizeMapDesignSemantics, type MapCompositionLayer, type MapDesignSemantics } from '../shared/mapDesign';
import {
  compileMapNaturalClearance,
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
  normalizeGrassHabitat,
  sampleGrassDensity,
  type GrassPresetId,
  type GrassRegion
} from '../shared/mapGrass';
import { findSafeSpawnPosition } from '../shared/mapSpawnSafety';
import { distanceToWater, isPointInsideWaterBody, waterBoundaryPoints, waterSurfaceLevelAt } from '../shared/mapWater';
import { createMapStreetGrid, mapGuidePolyline, sampleMapGuide, type MapPlannedBlock } from '../shared/mapGuide';
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
import { lintMap } from '../shared/mapLint';
import { llmChat } from './modelApi';
import { recordGenerationTrace } from './generationTrace';
import type { MapLintIssue } from '../shared/mapLint';
import { describeMapRefineScope, scopeMapRefinement, type MapRefineScope } from '../shared/mapRefineScope';

/**
 * Raw codeplan default for this experiment branch (feat/raw-codeplan-minimal-prompt):
 * the first generated program is the final result — no LLM repair loops, no
 * second-pass asset adaptation, no local relocation/pruning/lint repairs.
 * Engine caps (placements, scene operations, code length, route points,
 * sandbox timeouts) are lifted so the AI's output lands verbatim.
 * The sandbox exposes only RAW_CODEPLAN_API_KEYS; everything else is left to
 * plain JavaScript written by the model.
 * Set WORLDFORGE_RAW_CODEPLAN=0 to restore the standard managed pipeline.
 */
const RAW_CODEPLAN_MODE = process.env.WORLDFORGE_RAW_CODEPLAN !== '0';
const RAW_CODEPLAN_API_KEYS = [
  'terrain', 'modifyTerrain', 'surface', 'water', 'route',
  'grass', 'requireAsset', 'asset', 'place', 'random'
] as const;

const MAX_CODE_LENGTH = RAW_CODEPLAN_MODE ? 400_000 : 40_000;
const MAX_PLACEMENTS = RAW_CODEPLAN_MODE ? 100_000 : 2_000;
const MAX_SCENE_OPERATIONS = RAW_CODEPLAN_MODE ? 20_000 : 256;
const MAX_POINT_RESULTS = 512;
const MAX_PROBABILITY_CANDIDATES = 4_096;
const MAX_GRASS_FIELD_RESOLUTION = 64;
const MAX_LAYOUT_ITEMS = 64;
const MAX_LAYOUT_ITERATIONS = 512;
const DISCOVERY_EXECUTION_TIMEOUT_MS = RAW_CODEPLAN_MODE ? 15_000 : 500;
const FINAL_EXECUTION_TIMEOUT_MS = RAW_CODEPLAN_MODE ? 30_000 : 1_000;
const REPLAY_EXECUTION_TIMEOUT_MS = RAW_CODEPLAN_MODE ? 45_000 : 3_000;
const REFINE_ASSET_CATALOG_LIMIT = 64;
const EXECUTION_REPAIR_MAX_TOKENS = 8_000;
const ASSET_SEMANTIC_SNAPSHOT_MAX_CHARS = 900;
const ASSET_CATALOG_SNAPSHOT_CONTEXT_MAX_CHARS = 12_000;
const GENERATED_ASSET_CONTEXT_MAX_CHARS = 12_000;
const MAP_CODE_ENVIRONMENT_FORM_CONTRACT = `Use these structured environment forms:
api.terrain({preset:'plain'|'hills'|'valley'|'island'|'archipelago'|'canyon'|'cliff-plateau'|'dune-desert',amplitude?,roughness?,seed?,direction?:degrees|[x,z]});
api.modifyTerrain({modifier:'mountain'|'ridge'|'valley'|'basin'|'cliff'|'terrace'|'dune'|'island',region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width}|{kind:'polygon',points:[[x,z],...]},amplitude?:positiveNumber,softness?:number,direction?:degrees|[x,z],variation?:number,layers?:number|stepArray,layout?:'plateau'|'coast'|'canyon'|'wall'|'terraces',access?:'walkable'|'scenic',seed?});
api.surface({id:'short-id',surface:'grass'|'sand'|'rock'|'soil'|'paving',material?:'default'|'compacted-earth'|'garden-stone'|'asphalt',region:{kind:'circle'|'path'|'polygon',...},intensity?,clearNatural?}); Use clearNatural:true only when the authored area must exclude loose natural objects. Route surfaces are clear automatically.
api.grass({id:'short-id',name?,preset:'meadow'|'sand'|'wetland'|'farm'|'magic'|'alpine-moss',region:{kind:'circle',center:[x,z],radius}|{kind:'polygon',points:[[x,z],...]},density?,variation?,softness?,height?,mix?:{short?,tall?,flowers?},habitat?:{waterDistance?:[outerMin,preferredMin,preferredMax,outerMax],height?:[outerMin,preferredMin,preferredMax,outerMax]},seed?}); Habitat bands fade density smoothly at their outer limits. waterDistance is world units from the actual water edge, height is terrain Y; choose each layer's band from the intended ecology, not from a scene-name keyword.
api.grassField({id:'short-id',name?,preset?,resolution?:number|[x,z],height?,mix?,seed?}, sample => density) writes a serializable bounded density field. sample provides x,z,u,v,height,slope,waterDistance,index; return a finite value from 0 to 1.
api.foundation({name?,shape:'capsule'|'rounded-rectangle'|'polygon'|'path',under?:[objectReferenceOrExistingId,...],position?:[x,z]|[x,y,z],width?,depth?,margin?,cornerRadius?,points?:[[localX,localZ],...],curve?:'polyline'|'catmull-rom',closed?,top?:'level'|'slope'|'steps',thickness?,maxThickness?,slope?,slopeDirection?:radians,stepHeight?,stepCount?,material?}); The top is walkable, the bottom follows terrain, and terrain is never flattened.
Mechanical ownership: preset:'plain' always writes a zero-height field; amplitude and roughness do not change it. api.terrain and api.modifyTerrain create landform elevation. api.surface only paints existing terrain and cannot create land, water or a shoreline. Water points define the actual water coverage. When the scene depends on a landform boundary, express that boundary with non-flat terrain or a terrain modifier and coordinate the surface and water regions with it; use a rectangular boundary only when the intended landform is rectangular.
Enum fields are closed choices, not descriptions. Put descriptive meaning in id/name or comments; never write phrases such as "gentle central basin" in modifier or "packed earth" in surface.`;
const MAP_CODE_TOPOLOGY_CONTRACT = `Use these topology return and geometry contracts:
- api.route(...) returns the route ID string, not an object. Use const mainRouteId=api.route(...), then routeId:mainRouteId; never read .id from that string. Never use mainRoute.id.
- api.routeNetwork returns a string[] of route IDs in edge order. api.streetGrid returns {routeIds,blocks}.
- api.bridge accepts one object argument only: api.bridge({ waterId:'canal', assetId:api.asset(bridgeKey,0), crossingCenter:[x,z], direction:[dx,dz], dimensions:[width,height,depth] }). crossingCenter must lie inside the named water body and direction must cross two opposite shoreline boundaries. For a river, place the center on its centerline and use a direction perpendicular to the local river path. Do not distribute bridges with circlePoint.`;
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

export interface MapCodePlannerOptions extends MapRefineScope {
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
  assemblyId?: string;
  assemblyRole?: 'opening';
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
  elevation?: number;
  role?: CodeAssetRole;
  groupId?: string;
  assemblyId?: string;
  assemblyRole?: 'opening';
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
  groupId?: string;
  guideRole?: 'entry' | 'exit' | 'axis';
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
  assemblyId?: string;
  assemblyRole?: 'opening';
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

interface SubdividePathInput {
  points: Point2[];
  span: number;
  closed?: boolean;
  startInset?: number;
  endInset?: number;
  fit?: 'stretch' | 'center';
}

interface GridInsideRegionInput {
  region:
    | { kind: 'circle'; center: Point2; radius: number }
    | { kind: 'polygon'; points: Point2[] };
  spacing: number | Point2;
  angle?: number;
  inset?: number;
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
  fitToDimensions?: boolean;
  heightMode: 'terrain' | 'fixed';
  terrainOffset?: number;
  role: CodeAssetRole;
  semantic: string;
  bridgeWaterId?: string;
  roomOpeningId?: string;
  designGroupId?: string;
  assemblyId?: string;
  assemblyRole?: 'opening';
  compositionLayer?: MapCompositionLayer;
  sourceGuideId?: string;
  foundation?: MapFoundation;
  attachment?: {
    parentId: string;
    kind: 'supported' | 'mounted' | 'local';
    localPosition?: Point3;
    supportNodeId?: string;
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
    nominalSpan?: number;
    elevation?: number;
    frontTarget?: Point2;
  };
}

interface AttachmentInput {
  assetId?: string | null;
  name?: string;
  parentId: string;
  kind: 'supported' | 'mounted' | 'local';
  localPosition?: Point3;
  supportNodeId?: string;
  side?: RoomWall;
  offset?: Point2;
  contact?: number;
  anchorY?: 'bottom' | 'center' | 'top';
  scale?: number;
  rotationY?: number;
  role?: CodeAssetRole;
  groupId?: string;
  assemblyId?: string;
  assemblyRole?: 'opening';
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

const CODE_ASSET_LIGHT_CONTRACT = 'For functional lamps, lanterns, ceiling fixtures or neon emitters, requireAsset also accepts light:{kind:"point"|"spot",color:"#RRGGBB",intensity:0.5..12,range:1..20,offset:[localX,localY,localZ],direction?:[x,y,z],coneAngleDegrees?:10..90,penumbra?:0..1}. Declare this physical emitter metadata explicitly; bright geometry or emissive tags alone do not illuminate neighbors. Preserve it through asset adaptation. Do not light unrelated decorative objects. Final mood/exposure still belongs to the separately confirmed render stage.';

const CODE_ACTIVITY_CONTRACT = `## Object composition mechanics
api.assetSpace(assetId) reports measured local bounds and support surfaces when geometry exists; evidence:'unavailable' and interior:'unknown' mean no interior or support surface may be inferred from the bounding box.
api.placeRelative({parentId,assetId,name?,localPosition:[x,y,z],supportNodeId?,rotationY?,scale?,role?,groupId?,layer?}) keeps a separate child in the host's centered-XZ, floor-aligned local frame. Use a measured supportNodeId for exact support; otherwise keep independently usable props as ordinary world placements. Use api.attach for whole-host top or facade contact.
requireAsset may use mountOnAssetId only for a fixed non-interactive accessory on an existing catalog asset. It creates a new combined asset, consumes the normal asset budget, and never mutates the source.
Only route-derived objects should set sourceGuideId. Freely composed scenery keeps its authored position. Choose activity props, building variants, visible interiors and detail density from the user's request and the available asset budget rather than a fixed checklist.`;

export interface CodeAssetRequirement {
  mountOnAssetId?: string;
  light?: MapAssetLight;
  key: string;
  name: string;
  prompt: string;
  tags: string[];
  variants: number;
  generatedVariants?: number;
  dimensions?: Point3;
  role?: CodeAssetRole;
  optional?: boolean;
}

interface CodeAssetRequirementInput {
  mountOnAssetId?: string;
  light?: MapAssetLight;
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
  refineScope?: MapRefineScope;
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
  issues: CodeExecutionIssue[];
  fitToDimensionsObjectIds: ReadonlySet<string>;
}

interface CodeExecutionIssue {
  key: string;
  code: MapLintIssue['code'];
  message: string;
  repaired: boolean;
  repairHint?: string;
}

interface MapCodeReplayContext {
  refineScope?: MapRefineScope;
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

function selectRefinePromptAssets(
  map: EditableMap,
  assets: readonly MapAsset[],
  prompt: string,
  options: MapCodePlannerOptions
): MapAsset[] {
  const referencedIds = new Set([
    ...(map.assets ?? []).map((asset) => asset.id),
    ...map.objects.flatMap((object) => object.assetId ? [object.assetId] : []),
    ...(options.selectedObjectIds ?? []).flatMap((objectId) => {
      const object = map.objects.find((candidate) => candidate.id === objectId);
      return object?.assetId ? [object.assetId] : [];
    }),
    ...(options.refinableObjectIds ?? []).flatMap((objectId) => {
      const object = map.objects.find((candidate) => candidate.id === objectId);
      return object?.assetId ? [object.assetId] : [];
    })
  ]);
  const reusableIds = new Set(options.reusableAssetIds ?? []);
  const terms = `${prompt} ${options.focusPrompt ?? ''}`
    .toLocaleLowerCase()
    .split(/[\s,，。；、：:!?！？/\\|]+/)
    .filter((term) => term.length >= 2);
  const selected: MapAsset[] = [];
  const selectedIds = new Set<string>();
  const add = (asset: MapAsset): void => {
    if (selected.length >= REFINE_ASSET_CATALOG_LIMIT || selectedIds.has(asset.id)) return;
    selected.push(asset);
    selectedIds.add(asset.id);
  };
  for (const asset of assets) {
    if (referencedIds.has(asset.id)) add(asset);
  }
  const ranked = assets.map((asset, index) => {
    const semantic = `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}`.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (semantic.includes(term) ? 1 : 0), 0);
    return { asset, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  for (const entry of ranked) {
    if (entry.score > 0 && reusableIds.has(entry.asset.id)) add(entry.asset);
  }
  for (const entry of ranked) {
    if (entry.score > 0) add(entry.asset);
  }
  for (const asset of assets) {
    if (reusableIds.has(asset.id)) add(asset);
  }
  return selected;
}

export async function generateMapCodeSuggestion(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapCodePlannerOptions = {}
): Promise<MapAiSuggestion> {
  const requestMode = options.mode ?? 'generate';
  const refineScope: MapRefineScope | undefined = requestMode === 'refine'
    ? { targetVisualZoneId: options.targetVisualZoneId, targetRegionId: options.targetRegionId } : undefined;
  const scopePrompt = refineScope ? describeMapRefineScope(map, refineScope) : '';
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
    ? selectRefinePromptAssets(map, assets, prompt, options)
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
    scopePrompt,
    options.selectedObjectIds?.length
      ? `Currently selected map object IDs: ${options.selectedObjectIds.slice(0, 64).join(', ')}. Treat these as the default targets when the request says selected objects/buildings/foundations.`
      : '',
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
        traceStage: 'map.initial-plan',
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        onProgress: options.onProgress
      }));
  const executionAssets = requestMode === 'refine' ? assets : reusableAssets;
  const rawMode = RAW_CODEPLAN_MODE && options.scope === 'scene' && requestMode === 'generate' && map.sceneMode === 'outdoor';
  const execution = rawMode
    ? runRawMapCodeDiscovery(code, map, executionAssets, maxNewAssets, options)
    : await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, executionAssets, maxNewAssets, options);
  code = execution.code;
  let discovery = execution.discovery;
  options.onPlanPreview?.(distillCodePlanPreview(
    discovery.suggestion, discovery.requirements, discovery.fitToDimensionsObjectIds
  ));
  if (options.discoveryOnly) {
    options.onProgress?.({ phase: 'complete', label: '室内功能规划与资产清单已生成，等待确认' });
    return withCodePlanDetails(discovery.suggestion, discovery.requirements, execution.repairAttempts);
  }
  if (discovery.requirements.length === 0) {
    options.onProgress?.({ phase: 'complete', label: `${map.sceneMode === 'indoor' ? '室内规划' : 'Code 规划'}已完成，未请求新资产` });
    return withCodePlanDetails(discovery.suggestion, discovery.requirements, execution.repairAttempts);
  }
  if (!options.createAsset) throw new Error('map_code_asset_generation_unavailable');

  const tasks = discovery.requirements.flatMap((requirement) => {
    const seededFamily = supportsSeededEnvironmentVariants(requirement);
    const variantCount = generatedVariantCount(requirement);
    return Array.from({ length: variantCount }, (_, variantIndex) => ({
      key: requirement.key,
      variantIndex,
      name: variantCount > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
      request: {
        name: variantCount > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
        prompt: [
          codeAssetOrientationPrompt(requirement.prompt, requirement.dimensions),
          variantCount > 1 && !seededFamily
            ? `Create variation ${variantIndex + 1} of ${variantCount}; preserve the same reusable asset family while varying silhouette and details.`
            : ''
        ].filter(Boolean).join('\n'),
        tags: requirement.tags,
        ...(requirement.mountOnAssetId ? { mountOnAssetId: requirement.mountOnAssetId } : {}),
        ...(requirement.light ? { light: requirement.light } : {}),
        mode: map.assetGenerationMode,
        ...(seededFamily ? {
          seedFamilyKey: requirement.key,
          variantIndex,
          variantCount
        } : {})
      } satisfies AssetGenerationRequest
    }));
  });
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
  const adapted = rawMode
    ? { code, discovery }
    : await adaptMapCodeToGeneratedAssets(
    code,
    userPrompt,
    systemPrompt,
    map,
    [...executionAssets, ...generatedAssets],
    bindings,
    discovery,
    maxNewAssets,
    options
  );
  code = adapted.code;
  discovery = adapted.discovery;
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
    refineScope,
    maxNewAssets,
    refinableObjectIds: [...new Set(options.refinableObjectIds ?? [])]
  };
  let final: MapAiSuggestion;
  try {
    final = adapted.final ?? executeFinalMapCodeReplay(
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

async function adaptMapCodeToGeneratedAssets(
  code: string,
  userPrompt: string,
  systemPrompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  bindings: ReadonlyMap<string, readonly MapAsset[]>,
  discovery: CodeExecutionResult,
  maxNewAssets: number,
  options: MapCodePlannerOptions
): Promise<{ code: string; discovery: CodeExecutionResult; final?: MapAiSuggestion }> {
  const assetContext = generatedAssetResultContext(discovery.requirements, bindings);
  if (!assetContext.hasSemanticSnapshot) return { code, discovery };
  options.onProgress?.({
    phase: 'replanning',
    label: 'AI 正在根据新资产的实际结构调整布局'
  });
  try {
    const candidateCode = applyLocalCodeRepair(code, await llmChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: code },
      {
        role: 'user',
        content: [
          'The requested assets have now been generated. Read their actual model-local bounds and semantic snapshots. Return only JSON {"edits":[{"old":"exact unique substring from the current code","new":"replacement substring"}]}. Make at most four small, exact replacements at placements that need adjustment; never return the full function. If no adjustment is needed, return {"edits":[]}.',
          'Preserve every requireAsset declaration exactly: same key, name, prompt, tags, variants, dimensions, role and optional flag. Do not add, remove or rename asset requirements, and keep using api.asset(key,index) rather than real asset IDs.',
          'Preserve the scene concept, terrain, water, routes, design groups and intended content. Only adjust spatial use of the generated results when needed: placement position, dimensions, scale, facing, attachments, connections, repetition spacing and nearby clearance. Do not add another copy of a structural or decorative part that the snapshot says is already included.',
          'semanticSnapshot coordinates are model-local. Convert their meaning through each placement instead of treating them as map-space coordinates. localBounds is authoritative for the generated model extent; representative snapshot meshes are not the full bounds.',
          'Keep all existing placements and their roles. If the original layout already fits the generated results, return an empty edits array.',
          `Generated asset results:\n${assetContext.text}`
        ].join('\n\n')
      }
    ], {
      apiBase: options.apiBase,
      provider: options.provider ?? 'gpt',
      temperature: 0.1,
      maxTokens: 3_000,
      traceStage: 'map.asset-adaptation',
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      onProgress: options.onProgress
    }), true);
    if (candidateCode === code) return { code, discovery };
    const candidateDiscovery = runMapCodePlan(candidateCode, map, assets, {
      refineScope: options.mode === 'refine' ? options : undefined,
      mode: 'discovery',
      requestMode: options.mode ?? 'generate',
      minNewAssets: options.minNewAssets,
      maxNewAssets,
      scope: options.scope,
      refinableObjectIds: new Set(options.refinableObjectIds ?? [])
    });
    if (!sameCodeAssetRequirements(discovery.requirements, candidateDiscovery.requirements)
      || !preservesCodePlanContent(discovery, candidateDiscovery)) {
      throw new Error('generated_asset_adaptation_changed_scene_content');
    }
    const baselineIssueKeys = new Set(discovery.issues
      .filter((issue) => !issue.repaired)
      .map((issue) => issue.key));
    const introducedIssues = candidateDiscovery.issues.filter((issue) => (
      !issue.repaired && !baselineIssueKeys.has(issue.key)
    ));
    if (introducedIssues.length > 0) {
      throw new Error(`generated_asset_adaptation_introduced_issues:${[...new Set(
        introducedIssues.map((issue) => issue.code)
      )].join(',')}`);
    }
    const candidateFinal = runMapCodePlan(candidateCode, map, assets, {
      refineScope: options.mode === 'refine' ? options : undefined,
      mode: 'final',
      requestMode: options.mode ?? 'generate',
      assetBindings: bindings,
      maxNewAssets,
      scope: options.scope,
      executionTimeoutMs: clampInteger(options.finalExecutionTimeoutMs ?? FINAL_EXECUTION_TIMEOUT_MS, 1, FINAL_EXECUTION_TIMEOUT_MS),
      refinableObjectIds: new Set(options.refinableObjectIds ?? [])
    }).suggestion;
    const unsafe = (candidateFinal.diagnostics ?? []).filter((issue) => (
      issue.code === 'object.invalid-support'
      || (!issue.repaired && (issue.severity === 'error' || issue.code === 'object.overlap'))
    ));
    if (unsafe.length > 0) {
      throw new Error(`generated_asset_adaptation_unsafe:${[...new Set(unsafe.map((issue) => issue.code))].join(',')}`);
    }
    const baselineProgramIssues = new Set(findAuthoredSceneProgramIssues(map, discovery.suggestion));
    if (findAuthoredSceneProgramIssues(map, candidateFinal).some((issue) => (
      issue.startsWith('scene_group_missing_layer:') && !baselineProgramIssues.has(issue)
    ))) {
      throw new Error('generated_asset_adaptation_incomplete_scene');
    }
    recordGenerationTrace('code.adaptation.accepted', { code: candidateCode, suggestion: candidateFinal });
    return { code: candidateCode, discovery: candidateDiscovery, final: candidateFinal };
  } catch (error) {
    recordGenerationTrace('code.adaptation.rejected', { error, retainedCode: code });
    if (error instanceof Error && error.name === 'AbortError') throw error;
    options.onProgress?.({
      phase: 'replanning',
      label: '新资产布局调整未通过校验，继续使用原布局',
      detail: error instanceof Error ? error.message : String(error)
    });
    return { code, discovery };
  }
}

function generatedAssetResultContext(
  requirements: readonly CodeAssetRequirement[],
  bindings: ReadonlyMap<string, readonly MapAsset[]>
): { text: string; hasSemanticSnapshot: boolean } {
  const lines: string[] = [];
  let chars = 0;
  let hasSemanticSnapshot = false;
  for (const requirement of requirements) {
    const family = bindings.get(requirement.key) ?? [];
    for (let variantIndex = 0; variantIndex < family.length; variantIndex += 1) {
      const asset = family[variantIndex];
      if (!asset) continue;
      const semanticSnapshot = compactAssetSemanticSnapshot(asset);
      hasSemanticSnapshot ||= Boolean(semanticSnapshot);
      const line = JSON.stringify({
        key: requirement.key,
        variantIndex,
        declaredDimensions: requirement.dimensions,
        role: requirement.role,
        assetId: asset.id,
        name: asset.name,
        localBounds: assetLocalGeometry(asset),
        spatialSummary: assetSpaceSummary(asset),
        ...(semanticSnapshot ? { semanticSnapshot } : {})
      });
      if (chars + line.length > GENERATED_ASSET_CONTEXT_MAX_CHARS) return {
        text: [...lines, '{"truncated":true}'].join('\n'),
        hasSemanticSnapshot
      };
      lines.push(line);
      chars += line.length + 1;
    }
  }
  return { text: lines.join('\n'), hasSemanticSnapshot };
}

function sameCodeAssetRequirements(
  left: readonly CodeAssetRequirement[],
  right: readonly CodeAssetRequirement[]
): boolean {
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map((requirement) => [requirement.key, requirement]));
  return left.every((requirement) => {
    const candidate = rightByKey.get(requirement.key);
    return Boolean(candidate && sameCodeAssetRequirement(requirement, candidate));
  });
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
    refineScope: context.refineScope,
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
  const failedMountSources = new Set(context.failedTasks.flatMap(task => {
    const source = context.requirements.find(requirement => requirement.key === task.key)?.mountOnAssetId;
    return source ? [source] : [];
  }));
  if (failedMountSources.size) {
    const retained = new Set(map.objects.filter(object => object.assetId && failedMountSources.has(object.assetId)).map(object => object.id));
    final = { ...final, operations: final.operations.filter(operation =>
      !((operation.type === 'object.remove' || operation.type === 'object.update') && retained.has(operation.objectId))) };
  }
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
  assets: readonly MapAsset[] = [],
  options: CodeExecutionOptions = {}
): MapAiSuggestion {
  return runMapCodePlan(code, map, assets, options).suggestion;
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
  const started = Date.now();
  recordGenerationTrace('code.execution.start', {
    code, mapId: map.id, mapVersion: map.version, mode: options.mode ?? 'final', requestMode: options.requestMode ?? 'generate',
    assetIds: assets.map((asset) => asset.id),
    bindings: options.assetBindings ? Object.fromEntries([...options.assetBindings].map(([key, family]) => [key, family.map((asset) => asset?.id ?? null)])) : undefined
  });
  try {
    const result = executeMapCodePlanInternal(code, map, assets, options);
    recordGenerationTrace('code.execution.result', { elapsedMs: Date.now() - started, ...result });
    return result;
  } catch (error) {
    recordGenerationTrace('code.execution.error', { code, detail: mapCodeExecutionErrorDetail(error, code), error, elapsedMs: Date.now() - started });
    throw error;
  }
}

/** Raw mode keeps lint findings as diagnostics; lint repairs are never appended. */
function rawLintDiagnosticsOnly(
  map: EditableMap,
  suggestion: MapAiSuggestion,
  options: { repairableObjectIds?: ReadonlySet<string> }
): MapAiSuggestion {
  const lint = lintMap(applyMapOperations(map, suggestion.operations), options);
  return { ...suggestion, diagnostics: [...(suggestion.diagnostics ?? []), ...lint.issues] };
}

function executeMapCodePlanInternal(
  code: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: CodeExecutionOptions
): CodeExecutionResult {
  const cleanCode = normalizeUnsafeExponentSyntax(extractCode(code));
  if (!cleanCode || cleanCode.length > MAX_CODE_LENGTH) throw new Error('invalid_map_code_plan');

  const placements: PlacementIntent[] = [];
  const sceneOperations: MapOperation[] = [];
  const renderPromptSuggestions: string[] = [];
  const requirements = new Map<string, CodeAssetRequirement>();
  const unresolvedAssetIds = new Set<string>();
  const foundationWarnings: string[] = [];
  const missingAssetBindings = new Set<string>();
  const executionIssues = new Map<string, CodeExecutionIssue>();
  let cachedEnvironmentOperationCount = -1;
  let cachedEnvironmentMap: EditableMap | null = null;
  const currentEnvironmentMap = (): EditableMap => {
    if (cachedEnvironmentOperationCount !== sceneOperations.length) {
      cachedEnvironmentOperationCount = sceneOperations.length;
      cachedEnvironmentMap = sceneOperations.length > 0
        ? applyMapOperations({ ...map, assets: [...assets] }, sceneOperations)
        : map;
    }
    return cachedEnvironmentMap ?? map;
  };
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
  const rawMode = RAW_CODEPLAN_MODE && map.sceneMode === 'outdoor'
    && requestMode === 'generate' && scope === 'scene';
  const maxNewAssets = options.maxNewAssets ?? normalizeMapAiMaxNewAssets(undefined);
  const random = mulberry32(map.seed);
  const record = (name: string) => usedFunctions.add(name);
  const reportIssue = (issue: CodeExecutionIssue): void => {
    executionIssues.set(issue.key, issue);
  };
  const normalizeCodeSurfaceParams = (
    value: Record<string, unknown>,
    issueKey: string
  ): ReturnType<typeof normalizeTerrainSurfaceParams> => {
    try {
      return normalizeTerrainSurfaceParams(value, map);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const material = TERRAIN_SURFACE_RECIPES.includes(value.material as TerrainSurfaceRecipe)
        ? value.material as TerrainSurfaceRecipe
        : 'default';
      if (!message.startsWith('invalid_terrain_surface_material:') || material === 'default') throw error;
      const surface = terrainSurfaceForRecipe(material);
      reportIssue({
        key: `surface-material:${issueKey}`,
        code: 'terrain.surface-material-repaired',
        message: `铺装材质 ${material} 与 surface 不兼容，已按材质改用 ${surface}。`,
        repaired: true
      });
      return normalizeTerrainSurfaceParams({ ...value, surface }, map);
    }
  };
  let sceneIntent: CodeSceneIntent | undefined;
  let sceneIntentReason = '';
  let sceneIntentCallCount = 0;
  let designSemantics = map.designSemantics;
  let designCallCount = 0;
  let noChangeReason = '';
  let spawnRequest: { point: Point2; yaw: number } | undefined;
  const emitSceneOperation = (operation: MapOperation) => {
    if (sceneOperations.length >= MAX_SCENE_OPERATIONS) throw new Error('map_code_scene_operation_limit');
    sceneOperations.push(operation);
  };
  const emitRoute = (input: RouteInput): string => {
    if (!input || typeof input !== 'object') throw new Error('invalid_map_code_route');
    const id = cleanId(input.id, 'route');
    const points = codePointArray(input.points, 'invalid_map_code_route_points').slice(0, RAW_CODEPLAN_MODE ? 16_384 : 64);
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
    if (input.groupId && designSemantics.groups.some((group) => group.id === input.groupId)) {
      designSemantics = {
        ...designSemantics,
        groups: designSemantics.groups.map((group) => group.id === input.groupId ? {
          ...group,
          guideIds: [...new Set([...group.guideIds, id])],
          ...(input.guideRole === 'entry' ? { entryGuideIds: [...new Set([...group.entryGuideIds, id])] } : {}),
          ...(input.guideRole === 'exit' ? { exitGuideIds: [...new Set([...group.exitGuideIds, id])] } : {}),
          ...(input.guideRole === 'axis' ? { axisGuideIds: [...new Set([...group.axisGuideIds, id])] } : {})
        } : group)
      };
    }
    if (input.surface !== 'none') {
      const material = TERRAIN_SURFACE_RECIPES.includes(input.material as TerrainSurfaceRecipe)
        ? input.material as TerrainSurfaceRecipe
        : 'default';
      const surface = normalizeCodeTerrainSurface(input.surface ?? (
        material === 'default' ? 'paving' : terrainSurfaceForRecipe(material)
      )) ?? 'paving';
      emitSceneOperation({
        type: 'terrain.surface',
        ...normalizeCodeSurfaceParams({
          surface,
          material,
          region: { kind: 'path', points, width },
          intensity: input.intensity ?? 1,
          zoneId: `code:route:${id}`,
          clearNatural: true
        }, `route:${id}`)
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
      ...(dimensions ? { fitToDimensions: true } : {}),
      heightMode: terrain ? 'terrain' : 'fixed',
      role,
      semantic: [input.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' '),
      ...(roomOpeningId ? { roomOpeningId } : {}),
      ...(input.sourceGuideId ? { sourceGuideId: cleanId(input.sourceGuideId, 'route') } : {}),
      ...(input.foundation ? { foundation: input.foundation } : {}),
      ...placementDesignMetadata(input.groupId, input.layer, input.assemblyId, input.assemblyRole)
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
      if (!input || (input.kind !== 'natural' && input.kind !== 'authored')) {
        throw new Error('invalid_map_code_scene_intent');
      }
      if (sceneIntentCallCount > 1) {
        const changed = sceneIntent !== input.kind;
        reportIssue({
          key: 'declaration:scene-intent',
          code: 'code.declaration-normalized',
          message: changed
            ? `场景意图被重复声明且互相冲突，已采用最后一次的 ${input.kind}。`
            : `场景意图 ${input.kind} 被重复声明，已合并为一次。`,
          repaired: !changed,
          ...(changed ? {
            repairHint: 'Declare sceneIntent exactly once and make it match the actual authored or natural scene content.'
          } : {})
        });
      }
      sceneIntent = input.kind;
      sceneIntentReason = cleanText(input.reason ?? input.kind, 120);
      return input.kind;
    },
    design(input: unknown): MapDesignSemantics {
      record('design');
      designCallCount += 1;
      if (designCallCount > 1) {
        reportIssue({
          key: 'declaration:design',
          code: 'code.declaration-normalized',
          message: '设计语义被重复声明，已采用最后一次完整声明。',
          repaired: false,
          repairHint: 'Combine all design groups, focuses, viewpoints and relations into one api.design call.'
        });
      }
      const nextDesign = normalizeMapDesignSemantics(input, map.box.size);
      designSemantics = requestMode === 'refine'
        ? mergeRefinedDesignSemantics(designSemantics, nextDesign, input)
        : nextDesign;
      return designSemantics;
    },
    noChange(reason = '当前地图已满足调整要求'): void {
      record('noChange');
      if (requestMode !== 'refine') throw new Error('map_code_no_change_outside_refine');
      noChangeReason = cleanText(reason, 160);
    },
    move(input: MoveObjectInput): string {
      record('move');
      if (requestMode !== 'refine') throw new Error('map_code_refine_api_outside_refine');
      const objectId = String(input?.objectId ?? '').trim();
      const workingMap = currentEnvironmentMap();
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
      const workingMap = currentEnvironmentMap();
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
      const workingMap = currentEnvironmentMap();
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
      const workingMap = currentEnvironmentMap();
      if (!workingMap.waterBodies.some((item) => item.id === waterId)) throw new Error(`unknown_map_code_water:${waterId}`);
      emitSceneOperation({ type: 'water.remove', waterId });
      return waterId;
    },
    terrain(presetValue: string | Record<string, unknown>, optionsValue: Record<string, unknown> = {}): string {
      record('terrain');
      if (sceneOperations.some((operation) => operation.type === 'terrain.generate')) {
        reportIssue({
          key: 'declaration:terrain',
          code: 'code.declaration-normalized',
          message: '基础地形被重复生成，已保留第一次声明并跳过后续声明。',
          repaired: true
        });
        return sceneOperations.find((operation) => operation.type === 'terrain.generate')?.preset ?? 'plain';
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
      const params = normalizeCodeSurfaceParams({
        surface,
        material: form?.material,
        region: codeTerrainRegion(region),
        intensity,
        zoneId: `code:${cleanId(surfaceId, 'surface')}`,
        clearNatural: form?.clearNatural === true
      }, `surface:${surfaceId}`);
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
      if (nodes.size < 2) {
        reportIssue({
          key: `route_network_nodes:${networkId}`,
          code: 'code.route-unresolved',
          message: `路线网络 ${networkId} 的有效节点不足，已跳过该局部网络。`,
          repaired: false,
          repairHint: 'Give routeNetwork at least two finite, uniquely named nodes and reconnect its edges to those exact node IDs.'
        });
        return [];
      }
      const routeIds: string[] = [];
      for (const [index, edge] of input.edges.slice(0, 64).entries()) {
        if (!edge || typeof edge !== 'object') {
          reportIssue({
            key: `route_network_edge:${networkId}:${index}`,
            code: 'code.route-unresolved',
            message: `路线网络 ${networkId} 的第 ${index + 1} 条边格式无效，已跳过该边。`,
            repaired: false,
            repairHint: 'Replace the invalid routeNetwork edge with an object containing from and to node IDs.'
          });
          continue;
        }
        const from = nodes.get(cleanId(edge.from, 'node'));
        const to = nodes.get(cleanId(edge.to, 'node'));
        if (!from || !to) {
          reportIssue({
            key: `route_network_edge:${networkId}:${index}`,
            code: 'code.route-unresolved',
            message: `路线网络 ${networkId} 的第 ${index + 1} 条边引用了不存在的节点，已跳过该边。`,
            repaired: false,
            repairHint: 'Make every routeNetwork edge.from and edge.to match an exact node ID declared in the same network.'
          });
          continue;
        }
        const id = cleanId(edge.id ?? `${networkId}-${index + 1}`, `${networkId}-${index + 1}`);
        routeIds.push(emitRoute({
          ...edge,
          id,
          points: [from.point, ...codePointArray(edge.via ?? [], 'invalid_map_code_route_network_via'), to.point],
          tags: [
            ...(edge.tags ?? []),
            `network:${networkId}`,
            ...(from.role ? [`from:${from.role}`] : []),
            ...(to.role ? [`to:${to.role}`] : [])
          ]
        }));
      }
      return routeIds;
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
        reportIssue({
          key: `street_grid_empty:${id}`,
          code: 'scene.program-incomplete',
          message: `街区 ${id} 的区域不足以形成道路和地块，已跳过该局部网格。`,
          repaired: false,
          repairHint: 'Enlarge or simplify the streetGrid region, or replace it with an explicit route/routeNetwork that fits the intended district.'
        });
        return { routeIds: [], blocks: [] };
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
      const workingMap = currentEnvironmentMap();
      const guide = workingMap.guides.find((candidate) => candidate.id === routeId);
      if (!guide) {
        reportIssue({
          key: `route:${routeId}:roadside`,
          code: 'code.route-unresolved',
          message: `沿路设施引用了不存在的路线 ${routeId}，该局部摆放已跳过。`,
          repaired: false,
          repairHint: 'Use an exact route ID string created earlier in the program for placeAlongRoute.'
        });
        return [];
      }
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
            assemblyId: input.assemblyId,
            assemblyRole: input.assemblyRole,
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
      const workingMap = currentEnvironmentMap();
      const guide = workingMap.guides.find((candidate) => candidate.id === routeId);
      if (!guide) {
        reportIssue({
          key: `route:${routeId}:frontage`,
          code: 'code.route-unresolved',
          message: `建筑界面引用了不存在的路线 ${routeId}，该局部摆放已跳过。`,
          repaired: false,
          repairHint: 'Use an exact route ID string created earlier in the program for placeStreetFrontage.'
        });
        return [];
      }
      if (!guide.tags.includes('street')) {
        emitSceneOperation({ type: 'guide.upsert', guide: { ...guide, tags: [...guide.tags, 'street'] } });
      }
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
        reportIssue({
          key: `street_frontage_too_short:${routeId}`,
          code: 'scene.program-incomplete',
          message: `路线 ${routeId} 可用长度 ${routeLength.toFixed(2)}，不足以容纳 ${requiredLength.toFixed(2)} 的建筑界面，已跳过该组建筑。`,
          repaired: false,
          repairHint: 'Shorten the frontage item list or dimensions, reduce insets/gaps, split it across route sides, or use a longer route.'
        });
        return [];
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
      const requestedHeight = optionalFinite(options.height) ?? presetDefinition.defaultHeight;
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
      } : undefined, sceneIntent === 'authored' ? authoredMix : presetDefinition.defaultMix);
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
            height: requestedHeight,
            mix,
            seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length
          }
        });
      }
      emitSceneOperation({
        type: 'grass.generate',
        layerId: id,
        region,
        density: optionalFinite(options.density) ?? (sceneIntent === 'authored' ? 0.78 : 0.65),
        variation: optionalFinite(options.variation) ?? (sceneIntent === 'authored' ? 0.2 : 0.25),
        softness: optionalFinite(options.softness) ?? 0.2,
        seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length,
        habitat: normalizeGrassHabitat(options.habitat)
      });
      return id;
    },
    grassField(
      optionsValue: Record<string, unknown>,
      densityFunction: (sample: {
        x: number;
        z: number;
        u: number;
        v: number;
        height: number;
        slope: number;
        waterDistance: number;
        index: number;
      }) => number
    ): string {
      record('grassField');
      const options = codeObject(optionsValue, 'invalid_map_code_grass_field_options');
      if (typeof densityFunction !== 'function') throw new Error('invalid_map_code_grass_field_function');
      const id = cleanId(options.id ?? options.name, 'grass');
      const name = optionalString(options.name) ?? optionalString(options.id);
      const presetValue = optionalString(options.preset);
      const preset = GRASS_PRESET_IDS.includes(presetValue as GrassPresetId)
        ? presetValue as GrassPresetId
        : inferGrassPreset(`${presetValue ?? ''} ${name ?? ''}`);
      const presetDefinition = GRASS_PRESET_DEFINITIONS.find((item) => item.id === preset) ?? GRASS_PRESET_DEFINITIONS[0];
      const resolutionValue = options.resolution;
      const resolution = Array.isArray(resolutionValue)
        ? [
          boundedCount(finite(resolutionValue[0]), 2, MAX_GRASS_FIELD_RESOLUTION),
          boundedCount(finite(resolutionValue[1]), 2, MAX_GRASS_FIELD_RESOLUTION)
        ] as const
        : [
          boundedCount(finite(resolutionValue ?? 32), 2, MAX_GRASS_FIELD_RESOLUTION),
          boundedCount(finite(resolutionValue ?? 32), 2, MAX_GRASS_FIELD_RESOLUTION)
        ] as const;
      const requestedMix = options.mix && typeof options.mix === 'object' && !Array.isArray(options.mix)
        ? options.mix as Record<string, unknown>
        : undefined;
      const mix = normalizeGrassMix(requestedMix ? {
        short: optionalFinite(requestedMix.short),
        tall: optionalFinite(requestedMix.tall),
        flowers: optionalFinite(requestedMix.flowers)
      } : undefined, presetDefinition.defaultMix);
      const alreadyExists = map.grassLayers.some((layer) => layer.id === id)
        || sceneOperations.some((operation) => operation.type === 'grass.layer.add' && operation.layer.id === id);
      if (!alreadyExists) {
        emitSceneOperation({
          type: 'grass.layer.add',
          layer: {
            id,
            name,
            preset,
            height: optionalFinite(options.height) ?? presetDefinition.defaultHeight,
            mix,
            seed: optionalFinite(options.seed) ?? map.seed + sceneOperations.length
          }
        });
      }
      const environmentMap = currentEnvironmentMap();
      const bounds = getMapBounds(environmentMap);
      const densities: number[] = [];
      for (let zIndex = 0; zIndex < resolution[1]; zIndex += 1) {
        const v = zIndex / (resolution[1] - 1);
        const z = bounds.minZ + v * (bounds.maxZ - bounds.minZ);
        for (let xIndex = 0; xIndex < resolution[0]; xIndex += 1) {
          const u = xIndex / (resolution[0] - 1);
          const x = bounds.minX + u * (bounds.maxX - bounds.minX);
          const index = zIndex * resolution[0] + xIndex;
          const density = densityFunction(Object.freeze({
            x,
            z,
            u,
            v,
            height: sampleTerrainHeight(environmentMap, x, z),
            slope: terrainSlopeDegrees(environmentMap, x, z),
            waterDistance: distanceToWater(environmentMap, x, z),
            index
          }));
          densities.push(clampFinite(density, 0, 1));
        }
      }
      emitSceneOperation({
        type: 'grass.density.set',
        layerId: id,
        resolutionX: resolution[0],
        resolutionZ: resolution[1],
        densities
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
      return nearestDryPoint(currentEnvironmentMap(), point, clampFinite(clearance, 0, 12));
    },
    waterPoint(waterIdValue: string, pointValue: Point2, draft = 0): Point3 {
      record('waterPoint');
      const waterId = cleanText(waterIdValue, 80);
      const point = point2(pointValue);
      const environmentMap = currentEnvironmentMap();
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
    subdividePathBySpan(input: SubdividePathInput) {
      record('subdividePathBySpan');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_path_subdivision');
      return subdividePathBySpan(
        codePointArray(input.points, 'invalid_map_code_path_subdivision_points'),
        clampFinite(input.span, 0.2, Math.max(map.box.size[0], map.box.size[2])),
        input.closed === true,
        clampFinite(input.startInset ?? 0, 0, Math.max(map.box.size[0], map.box.size[2])),
        clampFinite(input.endInset ?? 0, 0, Math.max(map.box.size[0], map.box.size[2])),
        input.fit === 'center' ? 'center' : 'stretch'
      );
    },
    offsetPolygon(input: { points: Point2[]; distance: number }): Point2[] {
      record('offsetPolygon');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_polygon_offset');
      return offsetPolygon(
        codePointArray(input.points, 'invalid_map_code_polygon_offset_points'),
        clampFinite(input.distance, 0, Math.max(map.box.size[0], map.box.size[2]) / 2)
      );
    },
    insetPolygon(input: { points: Point2[]; distance: number }): Point2[] {
      record('insetPolygon');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_polygon_inset');
      return offsetPolygon(
        codePointArray(input.points, 'invalid_map_code_polygon_inset_points'),
        -clampFinite(input.distance, 0, Math.max(map.box.size[0], map.box.size[2]) / 2)
      );
    },
    gridInsideRegion(input: GridInsideRegionInput): Point2[] {
      record('gridInsideRegion');
      if (!input || typeof input !== 'object' || !input.region || typeof input.region !== 'object') {
        throw new Error('invalid_map_code_region_grid');
      }
      const spacing = Array.isArray(input.spacing)
        ? point2(input.spacing)
        : codePoint(Math.max(0.2, finite(input.spacing)), Math.max(0.2, finite(input.spacing)));
      const region = input.region.kind === 'circle'
        ? {
          kind: 'circle' as const,
          center: point2(input.region.center),
          radius: clampFinite(input.region.radius, 0.2, Math.max(map.box.size[0], map.box.size[2]) / 2)
        }
        : {
          kind: 'polygon' as const,
          points: codePointArray(input.region.points, 'invalid_map_code_region_grid_points')
        };
      return gridInsideRegion(
        region,
        codePoint(Math.max(0.2, Math.abs(spacing[0])), Math.max(0.2, Math.abs(spacing[1]))),
        finite(input.angle ?? 0),
        clampFinite(input.inset ?? 0, 0, Math.max(map.box.size[0], map.box.size[2]) / 2)
      );
    },
    localToWorld3D(
      local: Point3,
      origin: Point3,
      forward: Point3,
      up: Point3 = [0, 1, 0]
    ): Point3 {
      record('localToWorld3D');
      return localToWorld3D(local, origin, forward, up);
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
      bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
        | { xMin: number; xMax: number; zMin: number; zMax: number }
        | [Point2, Point2];
      minDistance: number;
      maxPoints?: number;
      attempts?: number;
      seed?: number;
    }): Point2[] {
      record('poissonDisk');
      const bounds = normalizePoissonBounds(options.bounds, getMapBounds(map));
      return poissonDiskPoints(bounds, options.minDistance, options.maxPoints, options.attempts, options.seed ?? map.seed);
    },
    sampleProbabilityField(
      options: {
        bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
          | { xMin: number; xMax: number; zMin: number; zMax: number }
          | [Point2, Point2];
        maxPoints?: number;
        candidates?: number;
        minDistance?: number;
        seed?: number;
      },
      weightFunction: (point: Point2 & { x: number; z: number }, index: number) => number
    ): Point2[] {
      record('sampleProbabilityField');
      if (!options || typeof options !== 'object') throw new Error('invalid_probability_field_options');
      if (typeof weightFunction !== 'function') throw new Error('invalid_probability_field_function');
      const bounds = normalizePoissonBounds(options.bounds, getMapBounds(map));
      return sampleProbabilityFieldPoints(bounds, options, weightFunction);
    },
    optimizeLayout(
      options: {
        items: Array<{ id: string; position: Point2; rotationY?: number; fixed?: boolean }>;
        bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
          | { xMin: number; xMax: number; zMin: number; zMax: number }
          | [Point2, Point2];
        iterations?: number;
        translationStep?: number;
        rotationStep?: number;
        temperature?: number;
        seed?: number;
      },
      costFunction: (items: ReadonlyArray<{
        id: string;
        position: Point2 & { x: number; z: number };
        rotationY: number;
        fixed: boolean;
      }>) => number
    ) {
      record('optimizeLayout');
      if (!options || typeof options !== 'object' || !Array.isArray(options.items)) {
        throw new Error('invalid_layout_optimizer_options');
      }
      if (typeof costFunction !== 'function') throw new Error('invalid_layout_optimizer_cost');
      return optimizeLayoutItems(
        options.items,
        normalizePoissonBounds(options.bounds, getMapBounds(map)),
        { ...options, seed: options.seed ?? map.seed },
        costFunction
      );
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
      const allowedRoles: readonly CodeAssetRole[] = map.sceneMode === 'indoor'
        ? ['functional', 'decor']
        : ['structure', 'environment'];
      const hasValidRole = allowedRoles.includes(input?.role as CodeAssetRole);
      const requirement = normalizeCodeAssetRequirement(
        hasValidRole ? input : { ...input, role: undefined },
        map.sceneMode
      );
      if (scope === 'scene' && !hasValidRole) {
        const semantic = `${requirement.name} ${requirement.prompt} ${requirement.tags.join(' ')}`;
        requirement.role = map.sceneMode === 'indoor'
          ? (ENVIRONMENT_ASSET.test(semantic) ? 'decor' : 'functional')
          : inferCodeAssetRole(semantic);
        reportIssue({
          key: `asset-role:${requirement.key}`,
          code: 'asset.role-inferred',
          message: `资产 ${requirement.name} 未提供有效 role，已按语义推断为 ${requirement.role}。`,
          repaired: true
        });
      }
      const existing = requirements.get(requirement.key);
      if (requirement.mountOnAssetId && !assetById.has(requirement.mountOnAssetId)) throw new Error('map_mount_source_not_available');
      if (existing && !sameCodeAssetRequirement(existing, requirement)) {
        throw new Error(`conflicting_map_code_asset_requirement:${requirement.key}`);
      }
      if (!existing) {
        if (requirements.size >= maxNewAssets) throw new Error('map_code_asset_requirement_limit');
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
      const available = family?.filter((candidate): candidate is MapAsset => Boolean(candidate)) ?? [];
      const asset = family?.[variantIndex] ?? available[positiveModulo(variantIndex, available.length || 1)];
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
    assetSpace(assetId: string) {
      record('assetSpace');
      const asset = assetById.get(assetId);
      return asset ? assetSpaceSummary(asset) : { evidence: 'unavailable', interior: 'unknown', supportSurfaces: [], parts: [] };
    },
    placeRelative(input: Omit<AttachmentInput, 'kind'> & { localPosition: Point3 }): string {
      record('placeRelative');
      return api.attach({ ...input, kind: 'local' });
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
        ...placementDesignMetadata(input.groupId, input.layer, input.assemblyId, input.assemblyRole),
        attachment: {
          parentId,
          kind: input.kind === 'local' ? 'local' : input.kind === 'mounted' ? 'mounted' : 'supported',
          ...(input.kind === 'local' ? { localPosition: point3(input.localPosition ?? []) } : {}),
          ...(input.supportNodeId ? { supportNodeId: cleanText(input.supportNodeId, 120) } : {}),
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
      let replacementObjectId: string | undefined;
      if (input.replaceObjectId !== undefined) {
        if (requestMode !== 'refine') throw new Error('map_code_bridge_replace_outside_refine');
        const objectId = String(input.replaceObjectId).trim();
        const workingMap = currentEnvironmentMap();
        const object = workingMap.objects.find((item) => item.id === objectId);
        if (!object) throw new Error(`unknown_map_code_object:${objectId}`);
        const objectAsset = object.assetId ? assetById.get(object.assetId) : undefined;
        const semantic = [object.name, objectAsset?.name, objectAsset?.prompt, ...(objectAsset?.tags ?? [])]
          .filter(Boolean)
          .join(' ');
        if (!/\bbridge\b|桥/i.test(semantic)) throw new Error(`map_code_bridge_replace_non_bridge:${objectId}`);
        replacementAssetId = object.assetId ?? undefined;
        replacementObjectId = objectId;
      }
      const waterId = cleanId(input.waterId, 'water');
      const environmentMap = currentEnvironmentMap();
      const water = environmentMap.waterBodies.find((item) => item.id === waterId);
      if (!water) {
        reportIssue({
          key: `bridge-water:${waterId}`,
          code: 'bridge.unresolved-crossing',
          message: `桥梁引用了不存在的水体 ${waterId}，该局部摆放已跳过。`,
          repaired: false,
          repairHint: 'Use the exact ID of a water body created earlier in the program.'
        });
        return;
      }
      const center = point2(input.crossingCenter);
      const rawDirection = point2(input.direction);
      const directionLength = Math.hypot(rawDirection[0], rawDirection[1]);
      if (directionLength < 0.000001) {
        reportIssue({
          key: `bridge-direction:${waterId}:${center.join(',')}`,
          code: 'code.geometry-unresolved',
          message: `桥梁在 ${waterId} 上的跨越方向长度为零，已跳过该局部摆放。`,
          repaired: false,
          repairHint: 'Give bridge.direction a non-zero [dx,dz] vector that points across the water.'
        });
        return;
      }
      const direction: Point2 = [rawDirection[0] / directionLength, rawDirection[1] / directionLength];
      const dimensions = point3(input.dimensions ?? input.size ?? [2, 1, 4]);
      if (dimensions[2] <= 0.000001) {
        reportIssue({
          key: `bridge-dimensions:${waterId}:${center.join(',')}`,
          code: 'code.geometry-unresolved',
          message: `桥梁在 ${waterId} 上的长度无效，已跳过该局部摆放。`,
          repaired: false,
          repairHint: 'Give bridge.dimensions a positive depth along the traversal axis.'
        });
        return;
      }
      let crossing: ReturnType<typeof solveWaterCrossing>;
      try {
        crossing = solveWaterCrossing(water, center, direction, input.bankInset ?? 1, dimensions[0]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== 'invalid_map_code_bridge_crossing' && message !== 'invalid_map_code_bridge_water_boundary') {
          throw error;
        }
        reportIssue({
          key: `bridge-crossing:${waterId}:${center.join(',')}`,
          code: 'bridge.unresolved-crossing',
          message: `桥梁没有形成 ${waterId} 的有效跨水线，已跳过该局部摆放。`,
          repaired: false,
          repairHint: 'Move crossingCenter onto the actual water body and orient direction across its opposite shores.'
        });
        return;
      }
      if (replacementObjectId) emitSceneOperation({ type: 'object.remove', objectId: replacementObjectId });
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
          fitToDimensions: true,
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
      if (distance < 0.000001) {
        reportIssue({
          key: `connection:${start.join(',')}`,
          code: 'code.geometry-unresolved',
          message: '连接构件的起点与终点重合，已跳过该局部摆放。',
          repaired: false,
          repairHint: 'Give placeBetween two distinct finite endpoints.'
        });
        return;
      }
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
      const elevation = clampFinite(input.elevation ?? 0, -64, 128);
      position[1] += elevation;
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
      if (dimensions[spanIndex] <= 0.000001) {
        reportIssue({
          key: `connection-dimensions:${start.join(',')}:${end.join(',')}`,
          code: 'code.geometry-unresolved',
          message: '连接构件在声明连接轴上的尺寸为零，已跳过该局部摆放。',
          repaired: false,
          repairHint: 'Give placeBetween dimensions a positive size on spanAxis.'
        });
        return;
      }
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
        fitToDimensions: true,
        heightMode: terrain && elevation === 0 ? 'terrain' : 'fixed',
        ...(terrain && elevation !== 0 ? { terrainOffset: elevation } : {}),
        role,
        semantic,
        connectionMode: 'explicit',
        connection: { start, end, spanAxis, gapRatio, elevation, ...((input.dimensions || input.size) ? { nominalSpan: dimensions[spanIndex] } : {}), ...(frontTarget ? { frontTarget } : {}) },
        ...placementDesignMetadata(input.groupId, input.layer, input.assemblyId, input.assemblyRole)
      });
    }
  });

  const sandboxApi = rawMode
    ? Object.freeze(Object.fromEntries(RAW_CODEPLAN_API_KEYS.map((key) => [key, (api as Record<string, unknown>)[key]])))
    : api;
  // Raw mode accepts a bare top-level script: wrap it as plan(api) so the
  // model may ignore the wrapper convention without failing the whole run.
  const entryCode = rawMode && !/\bfunction\s+plan\s*\(/.test(cleanCode)
    ? `function plan(api) {\n${cleanCode}\n}`
    : cleanCode;
  const script = new vm.Script(`${entryCode}\n;if (typeof plan !== 'function') throw new Error('missing_plan_function');\nplan(api);`, {
    filename: 'worldforge-map-plan.js'
  });
  const context = vm.createContext({
    api: sandboxApi,
    Math: safeMath(random),
    console: Object.freeze({ log() {}, warn() {}, error() {} })
  }, {
    codeGeneration: { strings: false, wasm: false }
  });
  const emitDiscoveryDraft = (interrupted: boolean): void => {
    if (mode !== 'discovery' || !options.onPlanPreview) return;
    // Scoped previews wait for resolved parent transforms and boundary checks below.
    if (options.refineScope?.targetRegionId || options.refineScope?.targetVisualZoneId) return;
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
  if (noChangeReason) {
    const hasPlannedChanges = placements.length > 0 || sceneOperations.length > 0 || requirements.size > 0
      || missingAssetBindings.size > 0 || renderPromptSuggestions.length > 0
      || (options.minNewAssets ?? 0) > 0;
    if (hasPlannedChanges) {
      reportIssue({
        key: 'declaration:no-change',
        code: 'code.declaration-normalized',
        message: '程序同时声明了 noChange 和实际修改，已保留实际修改并忽略 noChange。',
        repaired: true
      });
      noChangeReason = '';
    }
  }
  if (noChangeReason) {
    return {
      suggestion: {
        summary: `无需调整：${noChangeReason}`,
        operations: [],
        renderPromptSuggestions: [],
        generatedAssets: [],
        codePlan: {
          code: cleanCode,
          placementCount: 0,
          functions: [...usedFunctions].sort()
        }
      },
      requirements: [],
      issues: [...executionIssues.values()],
      fitToDimensionsObjectIds: new Set<string>()
    };
  }
  if (map.sceneMode === 'outdoor' && requestMode === 'generate' && scope === 'scene' && !sceneIntent) {
    sceneIntent = placements.some((placement) => placement.role === 'structure') || designCallCount > 0
      ? 'authored'
      : 'natural';
    sceneIntentReason = '由可执行场景内容推断';
    reportIssue({
      key: 'declaration:scene-intent',
      code: 'code.declaration-normalized',
      message: `程序未声明 sceneIntent，已根据内容推断为 ${sceneIntent}。`,
      repaired: true
    });
  }
  if (map.sceneMode === 'outdoor' && mode === 'discovery' && requestMode === 'generate' && sceneIntent === 'authored'
    && !placements.some((placement) => placement.role === 'structure')) {
    reportIssue({
      key: 'authored_scene_missing_structure',
      code: 'scene.program-incomplete',
      message: '人工营造场景尚未包含可识别的结构锚点；当前地形与环境内容仍可保留。',
      repaired: false,
      repairHint: 'Add at least one recognizable structural anchor that serves the requested place, then compose its supporting spatial edges before decoration.'
    });
  }
  if (placements.length === 0 && sceneOperations.length === 0 && missingAssetBindings.size === 0 && renderPromptSuggestions.length === 0) {
    throw new Error('empty_map_code_plan');
  }
  if (mode === 'discovery') {
    const placedAssetIds = new Set(placements.flatMap((placement) => placement.assetId ? [placement.assetId] : []));
    for (const [key, requirement] of requirements) {
      const usedIndices = Array.from({ length: requirement.variants }, (_, index) => index)
        .filter((index) => placedAssetIds.has(codeAssetPlaceholder(key, index)));
      if (usedIndices.length === 0) {
        requirements.delete(key);
        continue;
      }
      if (usedIndices.every((index, position) => index === position) && usedIndices.length < requirement.variants) {
        requirement.generatedVariants = usedIndices.length;
      }
    }
    const requestedAssetCount = requirements.size;
    const minimumAssetCount = options.minNewAssets ?? 0;
    if (requestedAssetCount < minimumAssetCount) {
      reportIssue({
        key: 'asset-minimum',
        code: 'asset.minimum-degraded',
        message: `用户要求至少 ${minimumAssetCount} 个新资产，当前可执行规划包含 ${requestedAssetCount} 个；已保留其余场景内容。`,
        repaired: false,
        repairHint: `Declare and place ${minimumAssetCount - requestedAssetCount} more genuinely useful reusable asset families without adding filler or removing existing scene content.`
      });
    }
  }

  const planningMap: EditableMap = {
    ...map,
    assets: [...new Map([...(map.assets ?? []), ...assets].map((asset) => [asset.id, asset])).values()]
  };
  if (mode === 'final' && map.sceneMode === 'outdoor' && !rawMode) fitConnectedPlacementRuns(placements, planningMap.assets ?? []);
  if (designCallCount > 0) {
    reportAssemblyIssues(designSemantics, placements, reportIssue, (assetId, key) =>
      mode === 'discovery'
        ? assetId.startsWith(`code-asset://${key}/`)
        : options.assetBindings?.get(key)?.some((asset) => asset.id === assetId) ?? false);
    if (sceneIntent === 'authored' && scope === 'scene' && requestMode === 'generate') {
      const parentIds = new Set(designSemantics.groups.flatMap((group) => group.parentId ? [group.parentId] : []));
      for (const group of designSemantics.groups) {
        if (parentIds.has(group.id)) continue;
        const minimum = group.spatialRole === 'landmark-ensemble' ? 3
          : group.spatialRole === 'urban-fabric' ? 6 : Infinity;
        const primaryForms = placements.filter((placement) => placement.designGroupId === group.id
          && placement.compositionLayer === 1 && placement.role === 'structure');
        if (primaryForms.length < minimum) continue;
        const connected = designSemantics.assemblies.some((assembly) => assembly.groupId === group.id
          && assembly.topology !== 'group'
          && placements.filter((placement) => placement.assemblyId === assembly.id && placement.connection).length >= 3
          && ![...executionIssues.keys()].some((key) => key.startsWith(`assembly:${assembly.id}:`)));
        if (!connected) reportIssue({
          key: `scene_group_missing_assembly:${group.id}`,
          code: 'scene.program-incomplete',
          message: `建筑组「${group.name}」只有独立结构，尚无连续拼接的主体；场景仍可保留。`,
          repaired: false
        });
      }
    }
  }
  const roomOperation = indoorRoom
    ? { type: 'room.set', room: { ...indoorRoom, openings: roomOpenings } } satisfies MapOperation
    : null;
  const baseOperations = [...(roomOperation ? [roomOperation] : []), ...sceneOperations];
  const terrainMap = baseOperations.length > 0
    ? applyMapOperations(planningMap, baseOperations)
    : planningMap;
  const objectOperations: Extract<MapOperation, { type: 'object.add' }>[] = [];
  const objectIdByReference = new Map<string, string>();
  const fitToDimensionsObjectIds = new Set<string>();
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
            localPosition: placement.attachment.localPosition,
            supportNodeId: placement.attachment.supportNodeId,
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
            ...(placement.assemblyId ? { assemblyId: placement.assemblyId } : {}),
            ...(placement.assemblyRole ? { assemblyRole: placement.assemblyRole } : {}),
            ...(placement.compositionLayer ? { compositionLayer: placement.compositionLayer } : {})
          });
        } catch (error) {
          if (placement.attachment.kind === 'local') {
            reportIssue({ key: `local:${placement.referenceId}`, code: 'code.geometry-unresolved', message: `已跳过无法安全放置的局部物件 ${placement.name}：${error instanceof Error ? error.message : 'invalid_placement'}`, repaired: false });
            continue;
          }
          attachmentFallbackCount += mode === 'final' ? 1 : 0;
          object = placementObject(placement, objectId, terrainMap, map.sceneMode);
        }
      } else {
        if (placement.attachment.kind === 'local' && mode === 'final') {
          reportIssue({ key: `local:${placement.referenceId}`, code: 'code.geometry-unresolved', message: `局部物件 ${placement.name} 缺少可用宿主或资产，已跳过。`, repaired: false });
          continue;
        }
        attachmentFallbackCount += mode === 'final' ? 1 : 0;
        object = placementObject(placement, objectId, terrainMap, map.sceneMode);
      }
    } else {
      object = placementObject(placement, objectId, terrainMap, map.sceneMode);
    }
    const operation = { type: 'object.add', object } satisfies Extract<MapOperation, { type: 'object.add' }>;
    objectOperations.push(operation);
    objectIdByReference.set(placement.referenceId, objectId);
    if (placement.fitToDimensions && placement.assetId) fitToDimensionsObjectIds.add(objectId);
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
  const waterRepair = map.sceneMode === 'outdoor' && !rawMode
    ? relocateOutdoorWaterIntrusions(terrainMap, objectOperations, placements, assets, designSemantics)
    : { operations: objectOperations, count: 0, conflicts: [] };
  const substrateConflicts = mergeSubstrateConflicts([
    ...waterRepair.conflicts,
    ...findDeclaredSubstrateConflicts(terrainMap, waterRepair.operations, placements, designSemantics)
  ]);
  for (const conflict of substrateConflicts) {
    const declared = conflict.substrate ? `声明为 ${conflict.substrate}` : '尚未声明 substrate';
    reportIssue({
      key: `scene_group_substrate_conflict:${conflict.groupId}`,
      code: 'scene.program-incomplete',
      message: `设计组 ${conflict.groupId} ${declared}，但有 ${conflict.count} 个主要物体与水陆基底冲突；已在资产生成前报告，自动兜底不会搬运超过 ${MAX_LOCAL_WATER_RELOCATION} 米。`,
      repaired: false,
      repairHint: `Edit only group ${conflict.groupId}: declare the intended dry/water/amphibious/underwater substrate, then resolve its local shoreline, terrain or placement calls without translating the whole composition.`
    });
  }
  const accessRepair = map.sceneMode === 'outdoor' && scope === 'scene' && !rawMode
    ? relocateOutdoorAccessBlockers(terrainMap, waterRepair.operations, assets)
    : { operations: waterRepair.operations, count: 0 };
  const operations: MapOperation[] = [
    ...baseOperations,
    ...accessRepair.operations,
    ...linkedObjectUpdates
  ];
  if (renderPromptSuggestions.length > 0) {
    operations.push({
      type: 'map.update',
      renderPromptSuggestions: [...new Set([...map.renderPromptSuggestions, ...renderPromptSuggestions])].slice(-8)
    });
  }
  recordGenerationTrace('layout.before-relations', { mode, operations });
  if (designCallCount > 0 || map.designSemantics.groups.length > 0) {
    designSemantics = remapMapDesignObjectReferences(designSemantics, objectIdByReference);
    const placedMap = applyMapOperations(planningMap, operations);
    designSemantics = resolveMapDesignFocusObjects(placedMap, designSemantics);
    const relationOperations = compileMapDesignRelations(placedMap, designSemantics);
    recordGenerationTrace('layout.relations', { designSemantics, operations: relationOperations });
    operations.push(...relationOperations);
    operations.push({ type: 'map.update', designSemantics });
  }
  const clearanceOperations = map.sceneMode === 'outdoor' && operations.length > 0 && !rawMode
    ? compileMapNaturalClearance(applyMapOperations(planningMap, operations))
    : [];
  operations.push(...clearanceOperations);
  recordGenerationTrace('layout.clearance', { operations: clearanceOperations });
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
  const executionDiagnostics = [...executionIssues.values()].map(({ code, message, repaired }) => ({
    code,
    severity: 'warning' as const,
    message,
    repaired
  }));
  const visualReviewMap = map.sceneMode === 'outdoor' && scope === 'scene' && requestMode === 'generate'
    ? applyMapOperations(planningMap, operations) : undefined;
  const compositionDiagnostics = visualReviewMap && sceneIntent === 'authored'
    ? reviewCodeDesignComposition(visualReviewMap) : [];
  const vegetationDiagnostics = visualReviewMap ? reviewCodeVegetation(visualReviewMap) : [];
  const repairableObjectIds = new Set([
    ...objectOperations.map((operation) => operation.object.id!),
    ...(options.refinableObjectIds ?? [])
  ]);
  const scopedOperations = scopeMapRefinement(planningMap, suggestion.operations, options.refineScope ?? {});
  const candidate = {
    ...suggestion,
    operations: scopedOperations,
    diagnostics: [
      ...executionDiagnostics,
      ...waterDiagnostics, ...accessDiagnostics, ...clearanceDiagnostics, ...attachmentDiagnostics,
      ...unresolvedBridgeDiagnostics, ...compositionDiagnostics, ...vegetationDiagnostics,
      ...foundationWarnings.map((message) => ({
        code: 'foundation.max-thickness' as const,
        severity: 'warning' as const,
        message,
        repaired: false
      }))
    ]
  };
  const validated = scopedOperations.length
    ? rawMode
      ? rawLintDiagnosticsOnly(planningMap, candidate, { repairableObjectIds })
      : validateMapSuggestion(planningMap, candidate, { repairableObjectIds }).suggestion
    : candidate;
  const boundedOperations = scopeMapRefinement(planningMap, validated.operations, options.refineScope ?? {});
  if (scopedOperations.length !== suggestion.operations.length || boundedOperations.length !== validated.operations.length) {
    validated.diagnostics = [...(validated.diagnostics ?? []), {
      code: 'scene.refine-scope', severity: 'warning', repaired: true,
      message: '已跳过超出选定区域或影响全图的操作，保留区域内的有效修改。'
    }];
  }
  validated.operations = boundedOperations;
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
    requirements: [...requirements.values()],
    issues: [...executionIssues.values()],
    fitToDimensionsObjectIds
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
        variants: generatedVariantCount(requirement),
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
  'grass.density.set',
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
    variants: generatedVariantCount(requirement),
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
      const placeholderSize = placeholderKey && isUnitFootprint(placement.size)
        ? dimensionsByKey.get(placeholderKey)
        : undefined;
      return {
        objectId: placement.referenceId,
        name: placement.name,
        assetId: placement.assetId,
        pending: placeholderKey !== null,
        position: placement.position,
        rotationY: placement.rotationY,
        size: placement.size,
        scale: placement.scale,
        ...(placeholderSize ? { placeholderSize } : {}),
        ...(placement.fitToDimensions ? { fitToDimensions: true } : {}),
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
  requirements: readonly CodeAssetRequirement[],
  fitToDimensionsObjectIds: ReadonlySet<string>
): CodePlanPreviewPayload {
  // requireAsset dimensions estimate the ghost, not the final object transform.
  const dimensionsByKey = requirementDimensionsByKey(requirements);
  const placements = suggestion.operations.flatMap((operation): CodePlanPlacementPreview[] => {
    if (operation.type !== 'object.add') return [];
    const object = operation.object;
    const transform = object.transform;
    if (!transform?.position) return [];
    const assetId = object.assetId ?? null;
    const placeholderKey = placeholderKeyOf(assetId);
    const declaredSize = transform.size ?? [1, 1, 1];
    const placeholderSize = placeholderKey && isUnitFootprint(declaredSize)
      ? dimensionsByKey.get(placeholderKey)
      : undefined;
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
      size: declaredSize,
      scale: transform.scale ?? [1, 1, 1],
      ...(placeholderSize ? { placeholderSize } : {}),
      ...(fitToDimensionsObjectIds.has(object.id ?? '') ? { fitToDimensions: true } : {}),
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

function generatedVariantCount(requirement: CodeAssetRequirement): number {
  return requirement.generatedVariants ?? requirement.variants;
}

function assetSpaceSummary(asset: MapAsset) {
  const space = inspectModelSpace(asset.modelJson);
  return { ...space, parts: space.parts.slice(0, 12), supportSurfaces: space.supportSurfaces.slice(0, 12), truncated: space.parts.length > 12 || space.supportSurfaces.length > 12 };
}

function compactAssetSemanticSnapshot(asset: MapAsset, maxChars = ASSET_SEMANTIC_SNAPSHOT_MAX_CHARS): string {
  const model = asset.modelJson && typeof asset.modelJson === 'object'
    ? asset.modelJson as { _meta?: { semanticSnapshot?: { text?: unknown } } }
    : null;
  const text = model?._meta?.semanticSnapshot?.text;
  if (typeof text !== 'string') return '';
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .join('\n')
    .slice(0, maxChars);
}

function assetLocalGeometry(asset: MapAsset): { min: Point3; max: Point3; size: Point3 } {
  const bounds = calculateModelVisualBounds(asset.modelJson);
  const min = bounds.min.map(contextNumber) as Point3;
  const max = bounds.max.map(contextNumber) as Point3;
  return {
    min,
    max,
    size: max.map((value, axis) => contextNumber(value - min[axis])) as Point3
  };
}

function contextNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function assetCatalogLine(asset: MapAsset, snapshot: string): string {
  const geometry = assetLocalGeometry(asset);
  return `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}; localBounds=min${JSON.stringify(geometry.min)},max${JSON.stringify(geometry.max)},size${JSON.stringify(geometry.size)}${snapshot ? `; semanticSnapshot=${JSON.stringify(snapshot)}` : ''}`;
}

function assetCatalogContext(assets: readonly MapAsset[]): string {
  if (assets.length === 0) return '- No reusable assets are available. Declare the assets you need with api.requireAsset.';
  let remainingSnapshotChars = ASSET_CATALOG_SNAPSHOT_CONTEXT_MAX_CHARS;
  let truncated = false;
  const lines = assets.map((asset) => {
    const fullSnapshot = compactAssetSemanticSnapshot(asset);
    const snapshot = fullSnapshot.slice(0, remainingSnapshotChars);
    remainingSnapshotChars -= snapshot.length;
    if (snapshot.length < fullSnapshot.length) truncated = true;
    return assetCatalogLine(asset, snapshot);
  });
  return [
    'Asset context: localBounds and size are model-local coordinates before each map instance transform. semanticSnapshot describes generated groups and representative geometry; use it as structural evidence, not as scene-space coordinates.',
    ...lines,
    ...(truncated ? ['Asset semanticSnapshot context was truncated to the bounded prompt budget; IDs, tags and localBounds remain complete.'] : [])
  ].join('\n');
}

function mergeRefinedDesignSemantics(
  current: MapDesignSemantics,
  update: MapDesignSemantics,
  rawUpdate: unknown
): MapDesignSemantics {
  const mergeById = <T extends { id: string }>(
    existing: readonly T[],
    additions: readonly T[],
    merge: (before: T, after: T) => T = (_before, after) => after
  ): T[] => {
    const next = existing.map((item) => ({ ...item }));
    for (const item of additions) {
      const index = next.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) next.push(item);
      else next[index] = merge(next[index], item);
    }
    return next;
  };
  const groups = mergeById(current.groups, update.groups, (before, after) => ({
    ...before,
    ...after,
    name: after.name === after.id && before.name !== before.id ? before.name : after.name,
    intent: after.intent || before.intent,
    region: after.region ?? before.region,
    spatialRole: after.spatialRole ?? before.spatialRole,
    substrate: after.substrate ?? before.substrate,
    focusIds: [...new Set([...before.focusIds, ...after.focusIds])],
    guideIds: [...new Set([...before.guideIds, ...after.guideIds])],
    entryGuideIds: [...new Set([...before.entryGuideIds, ...after.entryGuideIds])],
    exitGuideIds: [...new Set([...before.exitGuideIds, ...after.exitGuideIds])],
    axisGuideIds: [...new Set([...before.axisGuideIds, ...after.axisGuideIds])],
    protectedObjectIds: [...new Set([...before.protectedObjectIds, ...after.protectedObjectIds])],
    removableObjectIds: [...new Set([...before.removableObjectIds, ...after.removableObjectIds])],
    layers: after.layers.length > 0
      ? mergeById(
        before.layers.map((layer) => ({ ...layer, id: String(layer.level) })),
        after.layers.map((layer) => ({ ...layer, id: String(layer.level) }))
      ).map(({ id: _id, ...layer }) => layer)
      : before.layers
  }));
  const raw = rawUpdate && typeof rawUpdate === 'object' && !Array.isArray(rawUpdate)
    ? rawUpdate as Record<string, unknown> : {};
  return {
    version: 1,
    experienceMode: raw.experienceMode === undefined ? current.experienceMode : update.experienceMode,
    intent: raw.intent === undefined ? current.intent : update.intent,
    groups,
    assemblies: mergeById(current.assemblies, update.assemblies, (before, after) => ({
      ...before,
      ...after,
      intent: after.intent || before.intent,
      moduleKeys: after.moduleKeys ?? before.moduleKeys,
      functionalSequence: after.functionalSequence ?? before.functionalSequence
    })),
    focuses: mergeById(current.focuses, update.focuses),
    viewpoints: mergeById(current.viewpoints, update.viewpoints),
    relations: mergeById(current.relations, update.relations)
  };
}

function compactRefineObjectContext(map: EditableMap, refinableIds: ReadonlySet<string>) {
  const limit = 200;
  const prioritized = map.objects.filter((object) => refinableIds.has(object.id));
  const remaining = map.objects.filter((object) => !refinableIds.has(object.id));
  const sampleCount = Math.max(0, limit - prioritized.length);
  const sampled = sampleCount >= remaining.length
    ? remaining
    : Array.from({ length: sampleCount }, (_, index) => (
      remaining[Math.round(index * (remaining.length - 1) / Math.max(1, sampleCount - 1))]
    ));
  return [...prioritized, ...sampled].slice(0, limit).map((object) => ({
    id: object.id,
    name: object.name,
    assetId: object.assetId,
    position: object.transform.position,
    rotationY: object.transform.rotation[1],
    scale: object.transform.scale,
    size: object.transform.size,
    parentId: object.parentId,
    groupId: object.designGroupId,
    assemblyId: object.assemblyId,
    layer: object.compositionLayer,
    sourceGuideId: object.sourceGuideId,
    locked: object.locked,
    refinable: refinableIds.has(object.id)
  }));
}

function mapRefineSpatialSummary(map: EditableMap) {
  const groupIds = new Set(map.designSemantics.groups.map((group) => group.id));
  const groups = map.designSemantics.groups.map((group) => {
    const objects = map.objects.filter((object) => object.designGroupId === group.id && !object.parentId);
    const xs = objects.map((object) => object.transform.position[0]);
    const zs = objects.map((object) => object.transform.position[2]);
    return {
      id: group.id,
      name: group.name,
      spatialRole: group.spatialRole,
      substrate: group.substrate,
      region: group.region,
      objectCount: objects.length,
      layerCounts: Object.fromEntries([1, 2, 3, 4].map((level) => [
        level,
        objects.filter((object) => object.compositionLayer === level).length
      ])),
      assemblyCounts: Object.fromEntries([...new Set(objects.flatMap((object) => object.assemblyId ? [object.assemblyId] : []))]
        .map((assemblyId) => [assemblyId, objects.filter((object) => object.assemblyId === assemblyId).length])),
      guideIds: [...new Set([...group.guideIds, ...group.entryGuideIds, ...group.exitGuideIds, ...group.axisGuideIds])],
      ...(objects.length > 0 ? { occupiedBounds: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] } : {})
    };
  });
  return {
    totalObjects: map.objects.length,
    ungroupedObjects: map.objects.filter((object) => !object.designGroupId || !groupIds.has(object.designGroupId)).length,
    groups
  };
}

/**
 * Minimal raw-mode system prompt: only the ten basic APIs and the spatial
 * rhythm mandate. Every other technique (curves, sampling, noise, connected
 * modules) is intentionally left for the model to author in plain JavaScript.
 */
export function buildRawSceneCodeSystemPrompt(
  map: EditableMap,
  minNewAssets: number,
  maxNewAssets: number
): string {
  const bounds = getMapBounds(map);
  return `You are a scene composer. Write ONE JavaScript function \`function plan(api) { ... }\` that lays out the complete outdoor scene on a 2D map (x/z are ground coordinates, y is terrain height). This first version is final — nobody will iterate on it.

Map bounds: x=${bounds.minX}..${bounds.maxX}, z=${bounds.minZ}..${bounds.maxZ}, seed=${map.seed}. \`Math\` is available and \`Math.random\` is seeded, so it is deterministic.

You have total creative freedom: theme, landform, architecture, vegetation and density are yours to derive from the user's request. Your one standing duty is SPATIAL RHYTHM: compose like music. Alternate open and enclosed areas, dense and sparse patches, tall and low masses. Stagger elements irregularly — never uniform grids, never even spacing. Give the scene one dominant focus, a few subordinate ones, deliberate sightline reveals and honest empty space.

Composition style — shape grammar. Think like CGA rule systems: build the scene top-down with recursive subdivision. Write small split functions that take a region and return its parts (splits, margins, setbacks, hierarchy tiers), assign each part a role, and recurse until you reach placeable primitives. Express every repeated structure as a rewrite rule applied across many lots instead of placing objects by hand — one good rule can generate a whole street. Never enumerate coordinates when a rule expresses the intent.


Reference example — one complete plan written in this style for an earlier request (a Jiangnan garden). Treat it as a calibration of idiom, structure and elegance only: match its discipline and craft, never its theme, content or asset names.

const rand = (a, b) => a + Math.random() * (b - a);
const circle = (x, z, radius) => ({kind: "circle", center: [x, z], radius});
const polygon = points => ({kind: "polygon", points});
const contract = " Coordinate contract: Y+ is up, Z+ is the front/entrance direction, X+ is right.";
let serial = 0;
const id = prefix => prefix + "_" + serial++;

api.terrain("plain", {seed: 2435787201});
api.surface({
  id: "garden_ground",
  surface: "grass",
  region: polygon([[-48,-48],[48,-48],[48,48],[-48,48]])
});

const families = [
  ["gate", "月洞门", [12,4.8,1.5], "structure",
   "One Jiangnan garden entrance wall, white lime plaster with dark gray curved tile coping, a generous central circular moon gate opening, subtle weathering, restrained traditional Chinese detailing. No attached scenery."],
  ["screen", "砖雕影壁", [8,3.6,1.1], "structure",
   "One freestanding Jiangnan garden spirit screen wall, pale plaster framed by gray brick, elegant dark tile coping and a restrained central floral brick relief, solid opaque wall."],
  ["pavilion", "临池主亭", [10,9,9], "structure",
   "One exquisite open Jiangnan garden hexagonal pavilion, dominant double eaved dark gray tiled roof with graceful upturned corners, dark timber columns, restrained carved brackets, low stone plinth with integrated front steps, open views through the structure, no surrounding scenery."],
  ["gallery", "回廊单元", [3.2,4.1,6], "structure",
   "One straight six meter long open Jiangnan covered corridor bay, longitudinal direction along Z, dark timber posts, white low side balustrades, dark gray tiled roof, stone walkway at ground level, open ends allowing consecutive modules to join. No end walls, no surrounding scenery."],
  ["waterside", "临水水榭", [9,5.8,7], "structure",
   "One Jiangnan waterside open hall, single elegant gray tiled roof, dark wood pillars, delicate lattice panels at rear, wide open front veranda with low railings and stone foundation, restrained refined architecture, no surrounding water or scenery."],
  ["rock", "太湖石", [2.8,4.2,2.2], "environment",
   "One naturally weathered Taihu limestone scholar rock, upright irregular silhouette with intricate eroded holes, pale gray surface, slender waist and broad sculptural crown, stable natural base, no pedestal."],
  ["lantern", "石灯笼", [0.9,1.7,0.9], "environment",
   "One modest traditional Chinese garden stone lantern, aged pale gray granite, short pedestal, square hollow light chamber and small tiled stone cap, unlit."],
  ["willow", "垂柳", [10,10,9], "environment",
   "One mature Chinese weeping willow tree, elegantly leaning trunk, airy irregular crown with long cascading green foliage, visible branch structure, natural roots at ground level, no terrain."],
  ["bamboo", "竹丛", [5,7,4], "environment",
   "One natural cluster of slender green bamboo culms with airy leaves, varied stalk heights and gently arching tips, dense at base but transparent above, no planter or terrain."],
  ["flower", "花木", [4.8,4.4,4.3], "environment",
   "One elegant small Chinese flowering crabapple tree, irregular branching, sparse soft pink and white blossoms mixed with fresh green foliage, sculptural trunk, no planter or terrain."]
];
const assets = {};
for (const [key, name, dimensions, role, prompt] of families) {
  api.requireAsset({key, name, dimensions, role, prompt: prompt + contract});
  assets[key] = api.asset(key);
}
function place(key, x, z, rotationY = 0, scale = 1) {
  api.place({
    assetId: assets[key], name: id(key), position: [x,z], rotationY, scale,
    role: families.find(f => f[0] === key)[3]
  });
}
function ellipse(cx, cz, rx, rz, count, irregularity = 0) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i * Math.PI * 2 / count;
    const r = 1 + irregularity * (0.62 * Math.sin(3*t + 0.4) + 0.38 * Math.cos(5*t - 0.7));
    points.push([cx + rx * r * Math.cos(t), cz + rz * r * Math.sin(t)]);
  }
  return points;
}
function path(name, points, width, surface = "paving", closed = false) {
  return api.route({id: id(name), name, points, width, surface, closed, curve: "catmull-rom"});
}

// The root splits into an entrance court, pond precinct, and a planted outer frame.
function splitRegion(r, axis, fraction, gap) {
  if (axis === "x") {
    const cut = r.x0 + (r.x1-r.x0)*fraction;
    return [
      {...r, x1: cut-gap/2},
      {...r, x0: cut+gap/2}
    ];
  }
  const cut = r.z0 + (r.z1-r.z0)*fraction;
  return [
    {...r, z1: cut-gap/2},
    {...r, z0: cut+gap/2}
  ];
}
const root = {x0:-44, x1:44, z0:-44, z1:44};
const [precinct, entrance] = splitRegion(root, "z", 0.79, 1);
const [west, middleEast] = splitRegion(precinct, "x", 0.23, 1);
const [middle, east] = splitRegion(middleEast, "x", 0.78, 1);
const [north, pondRegion] = splitRegion(middle, "z", 0.20, 1);

const pondCenter = [-3,-1];
const shore = ellipse(pondCenter[0], pondCenter[1], 18.5, 14.7, 52, 0.115);
api.modifyTerrain({
  modifier:"basin", region:polygon(shore), amplitude:-2.3, softness:0.16
});
api.surface({
  id:"pond_bank", surface:"soil",
  region:polygon(ellipse(-3,-1,19.3,15.5,52,0.115)), intensity:0.8
});
api.water("central_pond", {
  type:"lake", points:ellipse(-3,-1,17.9,14.1,52,0.115),
  level:-0.48, depth:1.7
});

// White space in front of the focal pavilion is deliberately broad and empty.
api.surface({
  id:"pavilion_court", surface:"paving",
  region:polygon([[-13,-28],[2,-28],[3,-19],[-12,-18]])
});
place("pavilion", -5, -24, 0);
path("主亭引路", [[-5,-18],[-5,-16.8]], 3.1);

const gateX = -5;
place("gate", gateX, 40);
place("screen", gateX, 32.7);
api.surface({
  id:"entrance_court", surface:"paving",
  region:polygon([[-15,43],[6,43],[8,30],[2,26],[-15,29]])
});
path("入园障景左转", [[gateX,45],[gateX,37],[-12,35],[-13,30],[-10,25],[-7,22]], 2.7);
path("影壁东侧支路", [[gateX,37],[2,36],[3,30],[8,25],[12,21]], 2.0);

const loop = [];
for (let i = 0; i < 20; i++) {
  const t = i * Math.PI * 2 / 20;
  const rx = 24.7 + 1.1*Math.sin(3*t+0.7);
  const rz = 21.5 + 1.4*Math.cos(2*t-0.2);
  loop.push([-3 + rx*Math.cos(t), -1 + rz*Math.sin(t)]);
}
path("环池回游", loop, 2.2, "paving", true);

// A bent corridor is rewritten into joined bays, with a low waterside ending.
const galleryLine = [[29,24],[29,12],[25,4],[25,-8],[20,-16]];
function galleryRule(points) {
  for (let i=0; i<points.length-1; i++) {
    const a=points[i], b=points[i+1];
    const dx=b[0]-a[0], dz=b[1]-a[1];
    const length=Math.hypot(dx,dz);
    const n=Math.max(1,Math.round(length/6));
    const bayLength=length/n;
    api.route({
      id:id("廊下石径"), points:[a,b], width:3.1,
      curve:"polyline", surface:"paving"
    });
    for (let j=0;j<n;j++) {
      const t=(j+0.5)/n;
      place("gallery",a[0]+dx*t,a[1]+dz*t,Math.atan2(dx,dz),[1,1,bayLength/6]);
    }
  }
}
galleryRule(galleryLine);
place("waterside", 17, -17.3, Math.atan2(-13,13));
path("水榭接主亭", [[20,-16],[13,-22],[5,-24],[0,-24]], 2.1);
path("东廊入口", [[15,19],[23,23],[29,24]], 2.0);

// Subdivision leaves alternate dense bamboo rooms, flowering pockets, and silence.
function inset(r, margin) {
  return {x0:r.x0+margin,x1:r.x1-margin,z0:r.z0+margin,z1:r.z1-margin};
}
function center(r) {
  return [(r.x0+r.x1)/2,(r.z0+r.z1)/2];
}
function plantRule(region, depth, type, parity) {
  const w=region.x1-region.x0, h=region.z1-region.z0;
  if (depth>0 && Math.max(w,h)>12) {
    const parts=splitRegion(region,w>h?"x":"z",rand(0.39,0.62),rand(1.2,2.8));
    parts.forEach((part,i)=>plantRule(part,depth-1,type,parity+i+1));
    return;
  }
  const r=inset(region,2.3);
  if (r.x1<=r.x0 || r.z1<=r.z0) return;
  const c=center(r);
  if (parity%5===0) {
    api.grass(id("留白草地"),polygon([
      [r.x0,r.z0],[r.x1,r.z0],[r.x1,r.z1],[r.x0,r.z1]
    ]),{preset:"meadow",density:0.28,height:0.18,mix:{short:0.95,tall:0.04,flowers:0.01}});
    return;
  }
  const count=type==="bamboo" ? 3 : 1;
  for(let j=0;j<count;j++) {
    const x=count===1?c[0]:rand(r.x0,r.x1);
    const z=count===1?c[1]:rand(r.z0,r.z1);
    place(type,x,z,rand(-Math.PI,Math.PI),rand(0.78,1.13));
  }
  api.surface({id:id("种植土"),surface:"soil",region:circle(c[0],c[1],Math.min(w,h)*0.31),intensity:0.65});
}
plantRule(west,3,"bamboo",1);
plantRule(east,3,"bamboo",2);
plantRule(north,2,"flower",1);
const entranceWings=splitRegion(entrance,"x",0.5,30);
entranceWings.forEach((r,i)=>plantRule(r,2,i===0?"bamboo":"flower",i+1));

// Unequal shore sectors create dense silhouettes separated by clear water views.
function shoreRule(start,end,count,role) {
  for(let i=0;i<count;i++) {
    const t=start+(end-start)*(i+rand(0.18,0.75))/count;
    const x=-3+21.2*Math.cos(t);
    const z=-1+17.4*Math.sin(t);
    if(role==="willow") {
      place("willow",x,z,rand(-Math.PI,Math.PI),rand(0.78,0.98));
      api.grass(id("柳岸草"),circle(x,z,2.4),{
        preset:"meadow",density:0.48,height:0.3,mix:{short:0.8,tall:0.17,flowers:0.03}
      });
    } else {
      place("rock",x,z,rand(-Math.PI,Math.PI),rand(0.55,0.92));
    }
  }
}
shoreRule(0.40,1.10,2,"willow");
shoreRule(2.55,3.20,2,"willow");
shoreRule(3.70,4.05,1,"willow");
shoreRule(1.9,2.32,2,"rock");
shoreRule(5.5,5.78,1,"rock");

// Path furnishings use sparse, unequal recursive intervals rather than a ring of dots.
function furnishingRule(a,b,depth) {
  if(depth>0) {
    const m=a+(b-a)*rand(0.36,0.62);
    furnishingRule(a,m,depth-1);
    furnishingRule(m,b,depth-1);
    return;
  }
  const t=rand(a+0.1*(b-a),b-0.1*(b-a));
  const x=-3+28*Math.cos(t), z=-1+24.8*Math.sin(t);
  if (x>20 || z<-20 || (z>21 && x>-16 && x<9)) return;
  place("lantern",x,z,Math.atan2(-3-x,-1-z),rand(0.87,1.03));
}
furnishingRule(0.75,4.12,3);

// An intimate western flower pocket is the secondary reveal after the entrance turn.
const pocket=[-30,13];
path("花坞支径", [[-23,15],[-29,18],[-33,12],[-28,5],[-26,0]], 1.4,"soil");
api.surface({id:"花坞小坪",surface:"sand",region:circle(pocket[0],pocket[1],3.5)});
place("rock",pocket[0],pocket[1],0.65,0.9);
for(let i=0;i<3;i++) {
  const t=2.0+i*1.16+rand(-0.22,0.22);
  place("flower",pocket[0]+6*Math.cos(t),pocket[1]+6*Math.sin(t),rand(0,6.28),rand(0.75,0.98));
}
place("lantern",-13,28,0.6,0.9);

// Low meadow at the southeast keeps the approach legible and gives the pond room to breathe.
api.grass("东南留白",polygon([[10,29],[23,29],[27,39],[12,41],[7,35]]),{
  preset:"meadow",density:0.32,height:0.18,mix:{short:0.94,tall:0.04,flowers:0.02}
});
return;

Define as many of your own variables, constants and helper functions inside plan as you like — geometry helpers, samplers, noise, small data tables — anything synchronous and bounded. Plain JavaScript is fully available: \`const\`/\`let\`, \`for\` / \`for...of\` / \`while\` loops, \`if\`/\`else\`, function declarations and arrows, arrays, objects, and all of \`Math\` (including seeded \`Math.random\`).

The sandbox exposes exactly these 10 APIs. Everything else is yours to build: plain JavaScript is fully available — \`const\`/\`let\`, \`for\` / \`for...of\` / \`while\` loops, \`if\`/\`else\`, local helper functions, arrays, objects, and all of \`Math\` (including seeded \`Math.random\`). Write your own helpers freely: curve sampling, grid or Poisson point sets, value noise, path subdivision, jitter, orientation math — all of it is just JS you author yourself. For example:

  function jitter(point, radius) {
    return [point[0] + (Math.random() - 0.5) * radius, point[1] + (Math.random() - 0.5) * radius];
  }

The 10 APIs:
1. api.terrain(preset, {amplitude?, roughness?, seed?}) — preset: 'plain'|'rolling'|'hilly'|'mountainous'|'dunes'|'islands'|'mesa'|'canyon'; 'plain' stays flat.
2. api.modifyTerrain({modifier:'mountain'|'ridge'|'valley'|'basin'|'cliff'|'terrace'|'dune'|'island', region:{kind:'circle',center:[x,z],radius}|{kind:'path',points, width}|{kind:'polygon',points}, amplitude, softness?}) — local landform.
3. api.surface({id, surface:'grass'|'sand'|'rock'|'soil'|'paving', material?, region, intensity?}) — paints existing terrain; cannot create height.
4. api.water(id, {type:'lake'|'river'|'ocean', points:[[x,z],...], level, depth}).
5. api.route({id, name?, points:[[x,z],...], width?, curve?:'polyline'|'catmull-rom', closed?, surface?:'paving'|'soil'|'grass'|'sand'|'rock'|'none'}) — returns the route id; paints the path unless surface:'none'.
6. api.grass(id, region, {preset:'meadow'|'sand'|'wetland'|'farm'|'magic'|'alpine-moss', density?, height?, mix?:{short?,tall?,flowers?}}).
7. api.requireAsset({key, name /* short Simplified Chinese */, prompt /* English, ONE standalone object, append exactly: " Coordinate contract: Y+ is up, Z+ is the front/entrance direction, X+ is right." */, dimensions:[width,height,depth], role:'structure'|'environment', variants?, optional?}).
8. api.asset(key, index?) — returns the assetId to place; never invent asset IDs.
9. api.place({assetId, name?, position:[x,z], rotationY?, scale?, role?}) — terrain height auto-sampled; rotationY is radians around Y, and Math.atan2(dx, dz) turns the model's local Z+ front toward direction (dx,dz).
10. api.random(min?, max?) — seeded.

Rules:
- Declare ${minNewAssets}..${maxNewAssets} requireAsset families; place every declared variant at least once.
- Return only the function body: no markdown, imports, async, eval, timers, network, or global state. Synchronous code, finite numbers only.
- There are no hard caps in this mode — your output is applied verbatim — so keep loops sane on your own: seconds of computation, not minutes.
- Keep every coordinate inside the bounds; guard array indices and divisions.`;
}

export function buildMapCodePlannerSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  minNewAssets = 0,
  maxNewAssets = normalizeMapAiMaxNewAssets(undefined),
  scope: MapCodeScope = 'general',
  requestMode: MapCodeRequestMode = 'generate',
  _taskPrompt = '',
  refinableIds: readonly string[] = []
): string {
  if (map.sceneMode === 'indoor') {
    return buildIndoorMapCodePlannerSystemPrompt(map, assets, minNewAssets, maxNewAssets, requestMode, refinableIds);
  }
  if (RAW_CODEPLAN_MODE && requestMode === 'generate' && scope === 'scene') {
    return buildRawSceneCodeSystemPrompt(map, minNewAssets, maxNewAssets);
  }
  const bounds = getMapBounds(map);
  const assetCatalog = assetCatalogContext(assets);
  const refinableObjectIds = new Set(refinableIds);
  const refineObjects = compactRefineObjectContext(map, refinableObjectIds);
  const refineSpatialSummary = mapRefineSpatialSummary(map);
  const refineContext = requestMode === 'refine'
    ? `\n## Outdoor Scene Code refinement\nReturn a delta over the current map, not a rebuilt scene. Preserve everything the user did not ask to change. Do not call sceneIntent or regenerate base terrain unless explicitly requested. Use api.move, api.removeObject, api.updateWater and api.removeWater for existing content. If the map already satisfies the request, call api.noChange('short reason') and emit nothing else. Never move or remove an object with locked:true unless it also has refinable:true; refinable objects belong to the current unapplied AI preview. To replace a bridge, call api.bridge with replaceObjectId. api.design is an optional semantic patch: declare only entries intentionally changed; omitted entries are preserved. Use the spatial summary as context, but do not repair unrelated density, layer or composition findings. Existing design semantics: ${JSON.stringify(map.designSemantics)}. Existing guides: ${JSON.stringify(map.guides)}. Full-map spatial summary: ${JSON.stringify(refineSpatialSummary)}. Representative existing objects sampled across the whole map (all refinable objects are retained): ${JSON.stringify(refineObjects)}. Existing waters: ${JSON.stringify(map.waterBodies)}.\n`
    : '';
  const scopeContract = requestMode === 'refine'
    ? refineContext
    : scope === 'scene'
    ? `\n## Unified scene ownership\nYou author the complete outdoor scene in one coordinate system: terrain, water, surfaces, vegetation, constructed forms, circulation and their relationships.\napi.sceneIntent and api.design are optional compression tools, not mandatory planning stages. Use them only when their persistent labels clarify the executable scene; otherwise express the composition directly with bounded math, fields, routes and placements.\nLet the user's request determine landform, ecology, architectural language, density, hierarchy, rhythm and negative space. Use the spatial APIs to keep entrances, routes, footprints, adjacency and compound structures coherent, not to force a template or optimize a diagnostic score. Intentional open space is valid and is never auto-filled merely to satisfy metadata.\n`
    : '';
  return `You are WorldForge Studio's procedural environment planner.${scopeContract}
${CODE_ASSET_LIGHT_CONTRACT}
${CODE_ACTIVITY_CONTRACT}

## Output contract
Return only one synchronous JavaScript function: function plan(api) { ... }.
Do not return markdown, explanations, JSON, imports, async code, promises, eval, Function, network, files, timers, or global state.
Use api. on every WorldForge call. The code must emit at least one map operation. ${requestMode === 'refine' ? 'Refine code must emit only the requested delta.' : 'Full-scene code should normally combine environment operations with api.place/api.placeBetween.'}
Allowed JavaScript: const/let, numbers, strings, arrays, plain objects, local helper functions, for, for...of, while, if/else, and Math scalar functions. You may author bounded helper functions that express the requested geometry, variation or spatial field; the named APIs are conveniences, not a closed vocabulary of scene forms.

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
Do not randomize the rotation of directional assets unless the requested composition calls for it.

## Spatial planning boundary
Use spatial contracts where calculation helps: connected entrances and routes, believable footprints and setbacks, explicit water/ground substrate, and connected module geometry. The model remains free to choose the scene's form, terrain, ecology, density, style and detail language.
Inspect the scene from the viewpoints that matter to the request. Use api.design groups and assemblies only when they clarify real spatial responsibilities; they are optional semantics, not a required layer count or visual recipe.
Keep generated coordinates inside bounds, important circulation usable, and repeated geometry deterministic from api.seed. Visible prompt-specific content should use real assets; proxies are for abstract markers or unavailable visuals.

## API quick reference
Constants: api.TAU, api.PHI, api.seed, api.bounds.
Scene intent: api.sceneIntent({kind:'natural'|'authored',reason?}). ${requestMode === 'refine' ? 'Do not call it during refinement.' : 'Optional: use it when the natural/authored distinction materially clarifies the plan; otherwise it is inferred from executable content.'}
Design semantics: api.design({experienceMode:'immediate'|'sequential'|'mixed',intent,groups:[{id,name,parentId?,intent,region?,spatialRole?:'landmark-ensemble'|'urban-fabric'|'open-space'|'landscape',substrate?:'dry'|'water'|'amphibious'|'underwater',focusIds?,guideIds?,entryGuideIds?,exitGuideIds?,axisGuideIds?,protectedObjectIds?,removableObjectIds?,layers:[{level:1|2|3|4,intent,density:'tight'|'normal'|'open',minCount?:1..64}]}],focuses:[{id,groupId,name,kind:'primary'|'secondary'|'node',rank,selector?,objectId?,reveal:'visible'|'screened'|'framed'|'sequence'}],viewpoints:[{id,groupId?,point:[x,z],targetFocusId?,role:'entry'|'route'|'node'|'overview'}],relations:[{id,kind:'attract'|'repel'|'support',sourceSelector,targetSelector?,sourceGroupId?,targetGroupId?,strength:'tight'|'normal'|'open',minDistance?,maxDistance?}]}). Optional: call once only when these persistent labels clarify real spatial responsibilities. The runtime preserves declared semantics and explicit relations but does not add objects, prune objects, or fill density merely to satisfy group metadata. Make any declared focus, arrival, axis and boundary concrete in the water, terrain, routes and placements; prose alone does not shape the scene. Declare substrate for every group affected by water: dry means its primary forms need dry ground, water means surface/floating composition, amphibious deliberately spans shore and water, and underwater remains below the water surface. Bind a route to its design group with groupId and guideRole when it serves as entry, exit or axis. Keep shared routes connected across neighboring groups; do not force a straight central avenue when the requested experience calls for bends, enclosure or a reveal.
Compound architecture: api.design may declare assemblies:[{id,groupId,intent,topology:'group'|'path'|'loop',openings?,stories?,moduleKeys?:string[],spatialOrganization?:'centralized'|'linear'|'radial'|'grid'|'clustered'|'courtyard-network',footprintFamily?:'bar'|'l-shape'|'u-shape'|'closed-court'|'cross'|'ring'|'tower-podium'|'multi-wing'|'free-polygon',massingProfile?:'monolith'|'base-body-crown'|'setback'|'stepped'|'tower-cluster'|'domed-hall-wings',structuralRhythm?:'wall-bays'|'colonnade'|'arcade'|'frame-bays'|'buttresses'|'continuous-truss'|'wall-opening-alternation',functionalSequence?:string[]}]. Use an assembly only when a building benefits from reusable placed modules. Members share assemblyId and groupId; an actual entrance member may use assemblyRole:'opening'. Use bounded loops, canonical module spans and explicit story elevations for connected multi-part construction. Whole reusable assets remain valid for buildings that do not benefit from decomposition.
Environment: api.terrain(preset,{amplitude?,roughness?,seed?,direction?}); api.refineTerrain({...}); api.water(id,{type:'lake'|'river'|'ocean',points,...}); api.grass(id,region,{preset:'meadow'|'sand'|'wetland'|'farm'|'magic'|'alpine-moss',density?,variation?,softness?,height?,mix?:{short?,tall?,flowers?},habitat?:{waterDistance?:[outerMin,preferredMin,preferredMax,outerMax],height?:[outerMin,preferredMin,preferredMax,outerMax]}}); api.keepDry([x,z],clearance?) returns the nearest dry point after water operations; api.waterPoint(waterId,[x,z],draft?) returns [x,y,z] on that water surface after water operations; use it for boats and other floating assets, normally with role:'environment'; api.spawn([x,z],yawDegrees?); api.renderSuggestion(text).
Circulation: api.route({id,name?,points:[[x,z],...],groupId?,guideRole?:'entry'|'exit'|'axis',curve?:'polyline'|'catmull-rom',closed?,width?,surface?:'paving'|'soil'|'grass'|'sand'|'rock'|'none',material?:'default'|'compacted-earth'|'garden-stone'|'asphalt'|'concrete'|'brick-paver'|'cobblestone'|'gravel'|'mud',intensity?,tags?}) records an editable guide and lays terrain paving unless surface:'none'. api.routeNetwork({id,nodes:[{id,point:[x,z],role?}],edges:[{id,from,to,via?,groupId?,guideRole?,curve?,width?,surface?,material?,tags?}]}) creates a free-form connected graph. api.streetGrid({id,region,direction?,blockWidth,blockDepth,roadWidth,inset?,surface?,material?,tags?}) returns {routeIds,blocks}; use it only when the chosen design needs blocks. api.placeStreetFrontage({routeId,side,items,startInset?,endInset?,gap?,setback?}) fits building footprints along a route. api.placeAlongRoute({routeId,assetId?,name?,spacing,offset?,side?,startInset?,endInset?,facing?,role?,groupId?,layer?}) distributes route-owned objects. Use bridge for water crossings.
${MAP_CODE_ENVIRONMENT_FORM_CONTRACT}
${MAP_CODE_TOPOLOGY_CONTRACT}
Design relations of kind 'support' describe compositional support only; they never move objects or create physical parentId links. Physical mounting or resting on a named host must use api.attach with an explicit parentId.
Regions: {kind:'circle',x,z,radius}, {kind:'path',points:[[x,z],...],width}, or {kind:'polygon',points:[[x,z],...]}.
Scalar math: api.clamp(value,min,max), api.lerp(a,b,t), api.remap(value,inMin,inMax,outMin,outMax), api.smoothstep(min,max,value), api.random(min?,max?).
Transforms: api.rotate2D(point,angle,center?), api.mirrorPoint(point,'x'|'z',coordinate?), api.distance2D(a,b), api.tangentYaw(tangent), api.faceYaw(from,to). mirrorPoint with 'x' mirrors left/right around x=coordinate; 'z' mirrors front/back around z=coordinate.
3D local frames: api.localToWorld3D(local:[right,up,forward],origin:[x,y,z],forward:[x,y,z],up?:[x,y,z]) -> [x,y,z]. It builds an orthonormal frame and rejects zero or parallel axes. Use it when one compact local rule should drive elevated, tilted or repeated positions; it does not rotate asset geometry beyond the existing rotationY/facing contract.
Curves: api.linePoint(t,a,b) -> [x,z]; api.bezierPoint(t,p0,p1,p2,p3) -> {point,tangent,normal}; api.sampleBezier(...) -> point arrays; api.sampleBezierFrames(...) -> frame objects with point,tangent,normal; api.sampleBezierFramesBySpacing(...,spacing,gapRatio?) -> approximately even arc-length frames. frame.normal is the normalized left-side normal [-tangentZ,tangentX] as t increases.
Fields: api.noise2D(x,z,scale?,seed?) -> [-1,1]; api.fbm2D(x,z,{scale?,octaves?,lacunarity?,gain?,seed?}) -> [-1,1]; api.grassField({id,name?,preset?,resolution?,...}, sample => density) persists a bounded custom density grid instead of executable code.
Layouts: api.circlePoint(index,count,radius,center?) -> [x,z]; api.ellipsePoint(index,count,radiusX,radiusZ,center?,phase?) -> [x,z]; api.gridPoints({center?,columns,rows,spacing}) -> points; api.poissonDisk({bounds?:{minX,maxX,minZ,maxZ},minDistance,maxPoints?,attempts?,seed?}) -> points; api.sampleProbabilityField({bounds?,maxPoints?,candidates?,minDistance?,seed?}, (point,index) => weight) -> points. Weight is clamped to [0,1], candidates to 4096 and results to 512, so use any bounded mathematical field that serves the scene rather than choosing from a closed formula list.
Relationships: api.optimizeLayout({items:[{id,position:[x,z],rotationY?,fixed?}],bounds?,iterations?,translationStep?,rotationStep?,temperature?,seed?}, items => cost) returns optimized items. The model owns the finite cost function: combine attraction, repulsion, target distance, alignment, access or other scene-specific terms. The solver only performs a bounded search over at most 64 items and 512 iterations; it does not place objects or impose a composition. Mark anchors fixed, then place the returned positions yourself.
Architectural geometry: api.subdividePathBySpan({points,span,closed?,startInset?,endInset?,fit?:'stretch'|'center'}) returns bounded {start,end,center,tangent,length,index} bays; use each start/end with placeBetween instead of stretching one module. api.offsetPolygon({points,distance}) creates an outer arcade, wing or perimeter from a footprint. api.insetPolygon({points,distance}) creates a courtyard, setback tier or roof outline. api.gridInsideRegion({region:{kind:'circle',center,radius}|{kind:'polygon',points},spacing,angle?,inset?}) returns bounded column, room or parcel centers. Build major architecture hierarchically: footprint -> offset/inset depth layers -> massing tiers/stories -> boundary runs -> bays -> corner/entrance/ordinary modules. These helpers return geometry only; you still own entrances, structural roles and connected placements.
Assets: api.requireAsset({key,name,prompt,tags?,variants?,dimensions:[width,height,depth]?,role:'structure'|'environment',optional?}) -> key; api.asset(key,index?) -> generated assetId. role is required in unified scene ownership; only loose natural decoration may be optional. Give each new asset plausible canonical dimensions so the greybox has its intended size before the model exists; otherwise its pending placeholder is only 1x1x1. Choose dimensions from the scene plan, not to compensate for unknown model output.
Output: api.place({assetId?,name?,position:[x,z]|[x,y,z],rotationY?,facing?,scale?,size?,terrain?,role?,groupId?,layer?:1|2|3|4}); api.placeStreetFrontage(...) and api.placeAlongRoute(...) use existing routes. api.foundation(...) creates an independent editable foundation after its target objects are placed; pass their placement references or existing object IDs in under. Its bottom follows terrain and its top is level, sloped or stepped; keep maxThickness bounded. api.attach({assetId?,name?,parentId,kind:'supported'|'mounted',side?,offset?,anchorY?:'bottom'|'center'|'top',contact?,scale?,rotationY?,role?,groupId?,layer?}) attaches a child to an earlier placement or existing object. mounted side is the host-local north|south|east|west face, offset is [horizontal,vertical], anchorY selects the host's vertical baseline, and contact is embed depth. Entrances default to anchorY:'bottom'; offset remains host-relative. api.bridge({waterId,assetId?,name?,crossingCenter:[x,z],direction:[dx,dz],dimensions:[width,height,depth],kind?:'straight'|'curved',curveOffset?,segmentCount?,bankInset?,deckClearance?,abutments?,groupId?,layer?}) solves shoreline endpoints and water clearance.
api.place and api.placeBetween also accept assemblyId?:string and assemblyRole?:'opening'. These labels persist on objects; they do not generate geometry or change coordinates by themselves.
Never use standalone api.place with [x,y,z] for a door, window, banner, sign or facade ornament intended as part of another structure. Either include it in the host asset itself or create the host first and use api.attach.
Refine existing content: api.move({objectId,position?,rotationY?,scale?}); api.removeObject(objectId); api.updateWater({waterId,level?,depth?,width?,points?}); api.removeWater(waterId); api.noChange(reason). These APIs are available only during refinement. noChange is exclusive: use it only when no operation is needed.
facing may be a direction [dx,dz], {direction:[dx,dz]}, {tangent:[dx,dz]}, {normal:[nx,nz]}, {target:[x,z]}, or any of those with offsetY; it overrides rotationY when present.
For long connected dry-land scenery, prefer api.placeBetween({assetId?,name?,start:[x,z],end:[x,z],dimensions:[width,height,depth],spanAxis:'x'|'z',gapRatio?,frontTarget?:[x,z],facing?,scale?,terrain?,elevation?:number,groupId?,layer?}). It places the model at the midpoint, aligns its declared connection axis to the line from start to end, and fits only that axis to the endpoint distance. elevation lifts a module above the FINAL terrain height in meters and fixes its height; use floorIndex * canonicalModuleHeight to stack structural tiers rather than repeating a ground-level ring. Use spanAxis:'x' for side-by-side walls, railings, facades, seating rows and stands; use spanAxis:'z' for traversal modules. frontTarget chooses which side local Z+ faces without breaking the endpoint connection. Bridges must use api.bridge so the server solves the real shoreline, dry bank endpoints and water clearance.

## Asset rules
Declare between ${minNewAssets} and ${maxNewAssets} distinct requireAsset families; variants within one family count as one asset toward this range. Variants still require separate model generation calls, so request only useful visual diversity.
Each requireAsset.name is short Simplified Chinese UI text; keep detailed generation guidance in prompt.
When the minimum is greater than zero, declare and place that many prompt-specific generated assets even if reusable assets exist.
Use api.asset(key,index) for generated assets; do not invent asset IDs and do not modify catalog IDs.
Each asset prompt must describe a standalone reusable object with no ground, scene, text, or background unless the object itself requires it.
The server attaches the selected palette intent to each asset request. Never copy palette instructions or raw HEX lists into requireAsset.prompt; keep the subject, structure, orientation and user-requested color semantics first.
Choose variants from actual reuse needs and the asset budget. Continuous modules that must join stay compatible; other repeated families may vary when useful.
Label every generated family role:'structure' or role:'environment'. ${requestMode === 'refine' ? 'New assets must directly serve the requested delta.' : ''}
For modular assets, state the span axis and canonical dimensions so connected placement can fit them correctly.
Append this orientation instruction to every generated asset prompt: "Coordinate contract: Y+ is up, Z+ is the front/entrance/forward direction, X+ is right; place doors, facades, openings, windshields, or noses toward local Z+ and keep the model centered at its origin."

## Final self-check before returning
1. Exactly one function named plan and no markdown.
2. ${requestMode === 'refine' ? 'Refine code does not call sceneIntent, preserves unrelated content, and either emits at least one delta operation or calls noChange exactly once.' : 'Unified scene code emits the relevant environment and recognizable content with bounded calculations; sceneIntent/design appear only when their labels are useful.'}
3. All positions are inside the stated bounds or intentionally clamped.
4. No undefined point, invalid array index, direct array arithmetic, division by zero, invented asset ID, or unbounded placement loop.
5. Generated assets are declared with requireAsset and bound only through api.asset.
6. Every declared variant is referenced by at least one api.place, api.bridge or api.placeBetween call; never generate an unused variant.
7. Required routes, supports, water/ground substrate and connected modules are physically coherent. Optional design fields do not need to be populated merely to satisfy this checklist.

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
  const assetCatalog = assetCatalogContext(assets);
  const refinableObjectIds = new Set(refinableIds);
  const refineContext = requestMode === 'refine'
    ? `\n## Indoor Code refinement\nReturn only a delta over the current room. Preserve every object, opening and finish the user did not ask to change. If the room already satisfies the request, call api.noChange('short reason') and emit nothing else. Never move or remove an object with locked:true unless it also has refinable:true. Use api.move and api.removeObject for existing content; add new openings only when the user explicitly requests one. Existing objects: ${JSON.stringify(map.objects.slice(0, 240).map((object) => ({ id: object.id, name: object.name, assetId: object.assetId, position: object.transform.position, rotationY: object.transform.rotation[1], scale: object.transform.scale, size: object.transform.size, parentId: object.parentId, groupId: object.designGroupId, roomOpeningId: object.roomOpeningId, locked: object.locked, refinable: refinableObjectIds.has(object.id) })))}.\n`
    : `\n## Unified indoor ownership\nYou are the single author of the complete indoor layout. No second director, specialist agent, or silent local backfill will redesign it. Local code only enforces room bounds, opening semantics, collision safety, attachment validity and door circulation. If a functional requirement is missing, this same Code Composer will receive a targeted repair request.\n`;
  return `You are WorldForge Studio's procedural indoor-scene planner.${refineContext}
${CODE_ASSET_LIGHT_CONTRACT}
${CODE_ACTIVITY_CONTRACT}

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
The hard user-selected range is ${minNewAssets}-${maxNewAssets} distinct requireAsset families, regardless of variants per family. For this room size, aim for about ${suggestedAssetCount} useful reusable families; variants still cost separate model generation calls, so add them only for visible diversity. Each name is one short 2-8 character Simplified Chinese noun. Every declared variant must be placed.
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
Refine: api.move({objectId,position?,rotationY?,scale?}); api.removeObject(objectId); api.noChange(reason). These are available only during refinement and reject locked objects. noChange is exclusive: use it only when no operation is needed.

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
  const answer = raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  const fenced = answer.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? answer).trim();
}

/**
 * `-base ** exp` is a SyntaxError in JavaScript whenever the base carries a
 * unary minus — `-x**2`, `-(a+b)**2` and `-((x-cx)/rx)**2` all throw — yet
 * that is the natural way to author gaussian falloffs and field decay. The
 * author's intent is always the negative square, so rewrite to
 * `-(base ** exp)`; `(-base) ** exp` would silently flip the sign of every
 * falloff. Binary minus never matches (its right side is not a unary
 * context), strings are skipped, and valid code passes through unchanged.
 */
function normalizeUnsafeExponentSyntax(code: string): string {
  const UNARY_KEYWORDS = new Set(['return', 'typeof', 'new', 'delete', 'void', 'case', 'in', 'of', 'instanceof', 'do', 'else', 'yield', 'await', 'throw']);
  const skipSpaces = (input: string, index: number): number => {
    while (index < input.length && /\s/.test(input[index])) index += 1;
    return index;
  };
  const skipSpacesBack = (input: string, index: number): number => {
    while (index >= 0 && /\s/.test(input[index])) index -= 1;
    return index;
  };
  const skipString = (input: string, index: number): number => {
    const quote = input[index];
    index += 1;
    while (index < input.length) {
      if (input[index] === '\\') { index += 2; continue; }
      if (input[index] === quote) return index + 1;
      index += 1;
    }
    return input.length;
  };
  const matchParenForward = (input: string, index: number): number => {
    let depth = 0;
    while (index < input.length) {
      const character = input[index];
      if (character === '"' || character === "'" || character === '`') { index = skipString(input, index); continue; }
      if (character === '(') depth += 1;
      else if (character === ')') { depth -= 1; if (depth === 0) return index + 1; }
      index += 1;
    }
    return -1;
  };
  const isUnaryContext = (input: string, index: number): boolean => {
    const j = skipSpacesBack(input, index - 1);
    if (j < 0) return true;
    if (!/[\w$]/.test(input[j])) return '(+*,;{[&|!?<>%*:~^=/-'.includes(input[j]);
    let k = j;
    while (k >= 0 && /[\w$]/.test(input[k])) k -= 1;
    return UNARY_KEYWORDS.has(input.slice(k + 1, j + 1));
  };
  const readOperand = (input: string, index: number): { start: number; end: number } => {
    const start = skipSpaces(input, index);
    let j = start;
    if (input[j] === '(') {
      const end = matchParenForward(input, j);
      return end < 0 ? { start, end: start } : { start, end };
    }
    let match = /^[A-Za-z_$][\w$]*/.exec(input.slice(j)) ?? /^\d+(?:\.\d+)?/.exec(input.slice(j));
    if (!match) return { start, end: start };
    j += match[0].length;
    for (;;) {
      if (input[j] === '.' && /[A-Za-z_$]/.test(input[j + 1] ?? '')) {
        const member = /^[A-Za-z_$][\w$]*/.exec(input.slice(j + 1));
        if (!member) break;
        j += 1 + member[0].length;
        continue;
      }
      if (input[j] === '(') {
        const end = matchParenForward(input, j);
        if (end < 0) break;
        j = end;
        continue;
      }
      break;
    }
    return { start, end: j };
  };
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const character = code[i];
    if (character === '"' || character === "'" || character === '`') {
      const end = skipString(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (character === '-' && isUnaryContext(code, i)) {
      const { start: baseStart, end: baseEnd } = readOperand(code, i + 1);
      if (baseEnd > baseStart) {
        const k = skipSpaces(code, baseEnd);
        if (code[k] === '*' && code[k + 1] === '*') {
          let expEnd = readOperand(code, k + 2).end;
          for (;;) {
            const m = skipSpaces(code, expEnd);
            if (code[m] === '*' && code[m + 1] === '*') {
              const next = readOperand(code, m + 2).end;
              if (next > m + 2) { expEnd = next; continue; }
            }
            break;
          }
          if (expEnd > k + 2) {
            out += '-(' + code.slice(baseStart, expEnd) + ')';
            i = expEnd;
            continue;
          }
        }
      }
    }
    out += character;
    i += 1;
  }
  return out;
}

function applyLocalCodeRepair(code: string, response: string, allowUnchanged = false): string {
  const answer = response.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
  const payload = answer.match(/^```(?:json)?\s*([\s\S]*?)```$/i)?.[1] ?? answer;
  let edits: unknown;
  try {
    edits = (JSON.parse(payload) as { edits?: unknown }).edits;
  } catch {
    throw new Error('map_code_repair_requires_exact_edits');
  }
  if (!Array.isArray(edits) || edits.length > 4 || (edits.length === 0 && !allowUnchanged)) {
    throw new Error(allowUnchanged ? 'map_code_repair_requires_0_to_4_edits' : 'map_code_repair_requires_1_to_4_edits');
  }
  let next = code;
  let changedCharacters = 0;
  for (const edit of edits) {
    const oldText = edit?.old;
    const newText = edit?.new;
    if (typeof oldText !== 'string' || typeof newText !== 'string' || !oldText.trim()
      || oldText === newText || oldText.length > 1_200 || newText.length > 1_800
      || oldText.includes('function plan(')) {
      throw new Error('map_code_repair_edit_not_local');
    }
    const index = next.indexOf(oldText);
    if (index < 0 || next.indexOf(oldText, index + oldText.length) >= 0) {
      throw new Error('map_code_repair_anchor_not_unique');
    }
    changedCharacters += oldText.length + newText.length;
    if (changedCharacters > 4_000) throw new Error('map_code_repair_too_large');
    next = next.slice(0, index) + newText + next.slice(index + oldText.length);
  }
  return next;
}

function preservesCodePlanContent(before: CodeExecutionResult, after: CodeExecutionResult): boolean {
  const required = new Map(after.requirements.map((item) => [item.key, item.variants]));
  if (before.requirements.some((item) => (required.get(item.key) ?? 0) < item.variants)) return false;
  const significantTypes = ['terrain.generate', 'water.add', 'guide.upsert', 'grass.layer.add'] as const;
  for (const type of significantTypes) {
    if (after.suggestion.operations.filter((operation) => operation.type === type).length
      < before.suggestion.operations.filter((operation) => operation.type === type).length) return false;
  }
  const signature = (operation: Extract<MapOperation, { type: 'object.add' }>) => JSON.stringify([
    operation.object.name, operation.object.assetId,
    operation.object.designGroupId, operation.object.compositionLayer
  ]);
  const remaining = new Map<string, number>();
  for (const operation of after.suggestion.operations) {
    if (operation.type !== 'object.add') continue;
    const key = signature(operation);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const operation of before.suggestion.operations) {
    if (operation.type !== 'object.add') continue;
    const key = signature(operation);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else return false;
  }
  return true;
}

function localRepairSignals(discovery: CodeExecutionResult): string[] {
  return discovery.issues.filter(shouldAutoRepairCodeIssue).map((issue) => issue.code);
}

function shouldAutoRepairCodeIssue(issue: CodeExecutionIssue): boolean {
  return Boolean(issue.repairHint) && issue.key !== 'authored_scene_missing_structure';
}

const LOCAL_REPAIR_INSTRUCTION = 'Return only JSON {"edits":[{"old":"exact unique substring from the current code","new":"replacement substring"}]}. Make 1-4 small, exact replacements at the reported calls. Never return the full function or alter unrelated calls, placement loops, asset declarations, terrain, or circulation. If the listed issue cannot be fixed locally, return {"edits":[]}.';
const LOCAL_SUBSTRATE_REPAIR_INSTRUCTION = 'Return only JSON {"edits":[{"old":"exact unique substring from the current code","new":"replacement substring"}]}. Make 1-4 small, exact replacements; never return the full function. For scene_group_substrate_conflict:<groupId>, edit only that group in api.design and the directly responsible local shoreline, terrain or placement calls. Preserve its focus, route topology, assembly topology, other groups and all unrelated placements. Declare dry, water, amphibious or underwater from the intended experience; do not translate the whole group to a distant valid point. If intent is ambiguous, keep the current composition and return {"edits":[]}.';

function retainCodePlan(
  fallback: { code: string; discovery: CodeExecutionResult; programIssues: string[] },
  repairAttempts: number
): { code: string; discovery: CodeExecutionResult; repairAttempts: number } {
  return {
    code: fallback.code,
    repairAttempts,
    discovery: {
      ...fallback.discovery,
      suggestion: {
        ...fallback.discovery.suggestion,
        diagnostics: [
          ...(fallback.discovery.suggestion.diagnostics ?? []),
          ...sceneProgramDiagnostics(fallback.programIssues)
        ]
      }
    }
  };
}

/**
 * Raw mode: execute the discovery sandbox exactly once. A failing program
 * fails the whole generation — no LLM repair request is ever issued.
 */
function runRawMapCodeDiscovery(
  code: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxNewAssets: number,
  options: MapCodePlannerOptions
): { code: string; discovery: CodeExecutionResult; repairAttempts: number } {
  try {
    const discovery = runMapCodePlan(code, map, assets, {
      refineScope: options.mode === 'refine' ? options : undefined,
      mode: 'discovery',
      requestMode: 'generate',
      minNewAssets: options.minNewAssets,
      maxNewAssets,
      scope: options.scope,
      refinableObjectIds: new Set(options.refinableObjectIds ?? []),
      onPlanPreview: options.onPlanPreview
    });
    return { code, discovery, repairAttempts: 0 };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`map_code_execution_failed:${mapCodeExecutionErrorDetail(error, code)}`);
  }
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
  let optionalFallback: {
    code: string;
    discovery: CodeExecutionResult;
    programIssues: string[];
    repairTargets: string[];
  } | undefined;
  while (true) {
    try {
      const discovery = runMapCodePlan(code, map, assets, {
        refineScope: options.mode === 'refine' ? options : undefined,
        mode: 'discovery',
        requestMode: options.mode ?? 'generate',
        minNewAssets: options.minNewAssets,
        maxNewAssets,
        scope: options.scope,
        refinableObjectIds: new Set(options.refinableObjectIds ?? []),
        onPlanPreview: options.onPlanPreview
      });
      if (optionalFallback) {
        const fallback = optionalFallback;
        const currentIssues = findAuthoredSceneProgramIssues(map, discovery.suggestion);
        const newSignals = localRepairSignals(discovery);
        const improved = fallback.repairTargets.some((signal) => (
          newSignals.filter((item) => item === signal).length
          < fallback.repairTargets.filter((item) => item === signal).length
        ));
        const introducedError = (discovery.suggestion.diagnostics ?? []).some((issue) => (
          issue.severity === 'error' && !issue.repaired
          && !(fallback.discovery.suggestion.diagnostics ?? []).some((previous) => (
            previous.code === issue.code && previous.severity === 'error' && !previous.repaired
          ))
        ));
        if (!preservesCodePlanContent(fallback.discovery, discovery)
          || !improved
          || currentIssues.some((issue) => !fallback.programIssues.includes(issue))
          || introducedError) {
          recordGenerationTrace('code.repair.rejected', { reason: 'unrelated_scene_content_changed', retainedCode: fallback.code });
          options.onProgress?.({ phase: 'replanning', label: '局部修复改变了原有场景，已保留原规划' });
          return retainCodePlan(fallback, repairAttempts);
        }
        optionalFallback = undefined;
      }
      const programIssues = findAuthoredSceneProgramIssues(map, discovery.suggestion);
      const recoverableExecutionIssues = discovery.issues.filter(shouldAutoRepairCodeIssue);
      const repairDetails = recoverableExecutionIssues.map((issue) => (
        `${issue.key}: ${issue.message}\nFix: ${issue.repairHint}`
      ));
      if (repairDetails.length > 0 && !programRepairAttempted) {
        programRepairAttempted = true;
        repairAttempts += 1;
        optionalFallback = {
          code, discovery, programIssues,
          repairTargets: recoverableExecutionIssues.map((issue) => issue.code)
        };
        options.onProgress?.({
          phase: 'replanning',
          label: '局部调用未能安全落位，AI 正在定点修复 1/1',
          detail: repairDetails.join('\n')
        });
        const repairsSubstrate = recoverableExecutionIssues.some((issue) => issue.key.startsWith('scene_group_substrate_conflict:'));
        const localInstruction = repairsSubstrate ? LOCAL_SUBSTRATE_REPAIR_INSTRUCTION : LOCAL_REPAIR_INSTRUCTION;
        const preservationInstruction = repairsSubstrate
          ? 'Keep the existing composition and edit only the reported group\'s substrate mismatch.'
          : 'Keep the existing composition, placements, asset requirements, terrain and routes.';
        try {
          const repairResponse = await llmChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: code },
            {
              role: 'user',
              content: `The current program already produced a usable scene. Repair only these reported issues:\n${repairDetails.join('\n')}\n\n${localInstruction} ${preservationInstruction} Do not add content merely to satisfy an aesthetic warning.${recoverableExecutionIssues.length ? `\n\n${MAP_CODE_TOPOLOGY_CONTRACT}` : ''}`
            }
          ], {
            apiBase: options.apiBase,
            provider: options.provider ?? 'gpt',
            temperature: 0.15,
            maxTokens: 3_000,
            traceStage: 'map.program-completion',
            fetchImpl: options.fetchImpl,
            signal: options.signal,
            onProgress: options.onProgress
          });
          code = applyLocalCodeRepair(code, repairResponse);
          continue;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          options.onProgress?.({
            phase: 'replanning',
            label: '场景自动补全暂不可用，已保留当前可用规划',
            detail: error instanceof Error ? error.message : String(error)
          });
          return retainCodePlan(optionalFallback, repairAttempts);
        }
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
      if (optionalFallback) {
        options.onProgress?.({ phase: 'replanning', label: '局部修复未能执行，已保留原有可用场景' });
        return retainCodePlan(optionalFallback, repairAttempts);
      }
      const executionError = mapCodeExecutionErrorDetail(error, code);
      recordGenerationTrace('code.repair.required', { error: executionError, code, executionRepairAttempts, repairAttempts });
      if (executionRepairAttempts === 2) throw new Error(`map_code_execution_failed:${executionError}`);
      executionRepairAttempts += 1;
      repairAttempts += 1;
      const timeoutRepairGuidance = /script execution timed out/i.test(executionError)
        ? `\n\nThis was an execution timeout. Do not scale loop counts from map width, map area, or fine coordinate steps. Replace manual area scans with bounded api.gridPoints, api.poissonDisk, api.sampleProbabilityField, api.grassField, api.optimizeLayout, or curve-sampling results and iterate each result once. Avoid while loops and nested placement loops; keep each explicit loop below ${MAX_POINT_RESULTS} iterations and total placements below ${MAX_PLACEMENTS}.`
        : '';
      const lockedObjectRepairGuidance = /locked_map_code_object:([^\s]+)/i.exec(executionError)
        ? `\n\nThe referenced object is locked and not refinable. Leave it unchanged. Do not replace api.move with api.removeObject for the same ID; instead adjust only objects whose catalog entry has refinable:true, or add unlocked supporting content elsewhere.`
        : '';
      options.onProgress?.({
        phase: 'replanning',
        label: `检测到规划参数或边界错误，AI 正在自动修复 ${executionRepairAttempts}/2`,
        detail: executionError
      });
      const repairResponse = await llmChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: code },
        {
          role: 'user',
          content: map.sceneMode === 'indoor'
            ? `The indoor program failed during its sandboxed discovery run with this error:\n${executionError}\n\n${LOCAL_REPAIR_INSTRUCTION} Correct only the failing room call or expression; use roomPoint, wallFrame, ceilingPoint or opening as appropriate. Keep every other call unchanged. Ensure every numeric value is finite.${timeoutRepairGuidance}${lockedObjectRepairGuidance}`
            : `The outdoor program failed during its sandboxed discovery run with this error:\n${executionError}\n\n${LOCAL_REPAIR_INSTRUCTION} Correct only the failing call or expression. Check array indices, point components and API argument shapes; keep every other placement and declaration unchanged. Ensure every numeric value is finite.${timeoutRepairGuidance}${lockedObjectRepairGuidance}\n\n${MAP_CODE_ENVIRONMENT_FORM_CONTRACT}\n\n${MAP_CODE_TOPOLOGY_CONTRACT}`
        }
      ], {
        apiBase: options.apiBase,
        provider: options.provider ?? 'gpt',
        temperature: 0.1,
        maxTokens: EXECUTION_REPAIR_MAX_TOKENS,
        thinking: false,
        traceStage: 'map.execution-repair',
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        onProgress: options.onProgress
      });
      try {
        code = applyLocalCodeRepair(code, repairResponse);
      } catch (repairError) {
        recordGenerationTrace('code.repair.rejected', { reason: repairError, retainedCode: code });
        if (executionRepairAttempts === 2) throw new Error(`map_code_execution_failed:${executionError}`);
      }
    }
  }
  throw new Error('map_code_execution_failed:missing_discovery_result');
}

/** Aesthetic signals are review-only: never move authored anchors based on proxy geometry. */
function reviewCodeDesignComposition(map: EditableMap): MapLintIssue[] {
  const design = map.designSemantics;
  const issues: MapLintIssue[] = [];
  const parentIds = new Set(design.groups.flatMap((group) => group.parentId ? [group.parentId] : []));
  const leafGroups = design.groups.filter((group) => !parentIds.has(group.id)
    && map.objects.some((object) => object.designGroupId === group.id));
  const guideById = new Map(map.guides.map((guide) => [guide.id, guide]));
  const groupGuides = leafGroups.map((group) => ({
    group,
    guides: group.guideIds.map((id) => guideById.get(id)).filter((guide) => guide !== undefined)
  }));
  if (leafGroups.length >= 2 && map.guides.length >= 2 && groupGuides.every(({ guides }) => guides.length === 0)) {
    issues.push({
      code: 'scene.group-route-unbound', severity: 'warning', repaired: false,
      message: '多个设计片区和实际路线都已生成，但没有路线归属到设计组；入口、转场与焦点的空间承诺尚未落到导览几何。'
    });
  }
  const routedGroups = groupGuides.filter(({ guides }) => guides.length > 0);
  if (design.experienceMode !== 'immediate' && routedGroups.length >= 2) {
    const points = new Map(map.guides.map((guide) => [guide.id, mapGuidePolyline(guide)]));
    const connected = new Set(routedGroups[0].guides.map((guide) => guide.id));
    for (const id of connected) {
      const guide = guideById.get(id)!;
      for (const other of map.guides) {
        if (!connected.has(other.id) && mapGuidesMeet(points.get(id)!, points.get(other.id)!, guide.width, other.width)) {
          connected.add(other.id);
        }
      }
    }
    const disconnected = routedGroups.filter(({ guides }) => !guides.some((guide) => connected.has(guide.id)));
    if (disconnected.length > 0) issues.push({
      code: 'scene.group-route-disconnected', severity: 'warning', repaired: false,
      message: `片区「${disconnected.map(({ group }) => group.name).join('、')}」的实际路线与前序片区未接通；请检查道路端点、桥头或有意留出的无路过渡。`
    });
  }
  if (leafGroups.length >= 2) {
    const edges = new Map(leafGroups.map((group) => [group.id, new Set<string>()]));
    const connect = (a: string, b: string): void => {
      if (a === b || !edges.has(a) || !edges.has(b)) return;
      edges.get(a)!.add(b);
      edges.get(b)!.add(a);
    };
    for (const relation of design.relations) {
      if (relation.sourceGroupId && relation.targetGroupId && relation.sourceGroupId !== relation.targetGroupId) {
        connect(relation.sourceGroupId, relation.targetGroupId);
      }
    }
    const guideOwners = new Map<string, string[]>();
    for (const group of leafGroups) {
      for (const id of new Set([...group.guideIds, ...group.entryGuideIds, ...group.exitGuideIds, ...group.axisGuideIds])) {
        if (!map.guides.some((guide) => guide.id === id)) continue;
        guideOwners.set(id, [...(guideOwners.get(id) ?? []), group.id]);
      }
    }
    for (const owners of guideOwners.values()) {
      for (const id of owners.slice(1)) connect(owners[0], id);
    }
    const connected = new Set([leafGroups[0].id]);
    for (const id of connected) for (const neighbor of edges.get(id) ?? []) connected.add(neighbor);
    const unlinked = leafGroups.filter((group) => !connected.has(group.id));
    if (unlinked.length > 0) issues.push({
      code: 'scene.group-relations-unclear', severity: 'warning', repaired: false,
      message: `设计组「${unlinked.map((group) => group.name).join('、')}」缺少显式跨组关系或共享导览引用；请在灰盒中检查片区过渡和游览动线。`
    });
  }
  if (leafGroups.length === 0) return issues;
  for (const group of leafGroups) {
    if (group.spatialRole !== 'urban-fabric' && group.spatialRole !== 'landmark-ensemble') continue;
    const roofs = map.objects.filter((object) => object.designGroupId === group.id
      && (object.compositionLayer === 1 || object.compositionLayer === 2)
      && object.transform.size[0] * object.transform.scale[0] >= 2.5
      && object.transform.size[2] * object.transform.scale[2] >= 2.5
      && object.transform.size[1] * object.transform.scale[1] >= 2.5)
      .map((object) => object.transform.position[1] + object.transform.size[1] * object.transform.scale[1]);
    if (roofs.length < 4) continue;
    const range = Math.max(...roofs) - Math.min(...roofs);
    if (range < Math.max(1, Math.max(...roofs) * 0.2)) issues.push({
      code: 'scene.group-massing-flat', severity: 'warning', repaired: false,
      message: `片区「${group.name}」的 ${roofs.length} 个主要体块顶部高度几乎一致；请从沿途和 45° 俯视检查屋顶、地形或树冠是否缺少高低层次。`
    });
  }
  const primaries = design.focuses.filter((focus) => focus.kind === 'primary');
  const primary = primaries.length === 1 ? primaries[0] : undefined;
  const primaryObject = map.objects.find((object) => object.id === primary?.objectId);
  if (!primary || !primaryObject) return issues;
  if (primary.reveal !== 'visible' && primary.reveal !== 'framed') return issues;
  const viewpoint = design.viewpoints.find((view) => view.role === 'entry' && view.targetFocusId === primary.id);
  if (!viewpoint) return issues;
  const [px, , pz] = primaryObject.transform.position;
  const [vx, vz] = viewpoint.point;
  const primaryDistance = Math.max(2, Math.hypot(px - vx, pz - vz));
  const prominence = (object: typeof primaryObject, distance: number): number => {
    const size = object.transform.size.map((axis, index) => axis * object.transform.scale[index]);
    return size[1] * Math.max(size[0], size[2]) / (distance * distance);
  };
  const primaryScore = prominence(primaryObject, primaryDistance);
  const rival = design.focuses.filter((focus) => focus.kind === 'secondary' && focus.reveal === 'visible')
    .map((focus) => ({ focus, object: map.objects.find((object) => object.id === focus.objectId) }))
    .find(({ object }) => {
      if (!object) return false;
      const [sx, , sz] = object.transform.position;
      const distance = Math.max(2, Math.hypot(sx - vx, sz - vz));
      const alignment = ((px - vx) * (sx - vx) + (pz - vz) * (sz - vz)) / (primaryDistance * distance);
      return alignment > 0.7 && prominence(object, distance) > primaryScore * 1.25;
    });
  if (rival) issues.push({
    code: 'scene.focus-underdominant', severity: 'warning', repaired: false,
    objectIds: [primaryObject.id, rival.object!.id],
    message: `入口视角的灰盒尺度估算中，次焦点「${rival.focus.name}」比主焦点「${primary.name}」更显眼；请检查体量、距离和遮挡。`
  });
  return issues;
}

function mapGuidesMeet(
  first: readonly Point2[], second: readonly Point2[], firstWidth: number, secondWidth: number
): boolean {
  const threshold = (firstWidth + secondWidth) / 2 + 0.5;
  const nearPath = (endpoint: Point2, path: readonly Point2[]) => path.slice(1).some((point, index) => (
    pointSegmentDistance2(endpoint[0], endpoint[1], path[index], point) <= threshold
  ));
  return nearPath(first[0], second) || nearPath(first[first.length - 1], second)
    || nearPath(second[0], first) || nearPath(second[second.length - 1], first);
}

function reviewCodeVegetation(map: EditableMap): MapLintIssue[] {
  if (map.grassLayers.length === 0 || !map.waterBodies.some((water) => water.type !== 'ocean')) return [];
  const [width, , depth] = map.box.size;
  const extent = Math.min(width, depth);
  const nearLimit = Math.max(2, extent * 0.06);
  const farLimit = Math.max(nearLimit * 2.5, extent * 0.18);
  const near: Array<[number, number]> = [];
  const far: Array<[number, number]> = [];
  for (let zIndex = 1; zIndex <= 9; zIndex += 1) {
    for (let xIndex = 1; xIndex <= 9; xIndex += 1) {
      const x = (xIndex / 10 - 0.5) * width;
      const z = (zIndex / 10 - 0.5) * depth;
      if (map.waterBodies.some((water) => isPointInsideWaterBody(water, x, z, map))) continue;
      const distance = distanceToWater(map, x, z);
      if (distance <= nearLimit) near.push([x, z]);
      else if (distance >= farLimit) far.push([x, z]);
    }
  }
  if (near.length < 3 || far.length < 3) return [];
  const meanDensity = (layer: EditableMap['grassLayers'][number], points: readonly [number, number][]) => (
    points.reduce((sum, [x, z]) => sum + sampleGrassDensity(layer, map, x, z), 0) / points.length
  );
  const blanket = map.grassLayers.find((layer) => layer.visible
    && meanDensity(layer, near) > 0.5 && meanDensity(layer, far) > 0.5);
  return blanket ? [{
    code: 'scene.vegetation-uniform', severity: 'warning', repaired: false,
    message: `草层「${blanket.name}」从水边到远地都保持高密度，近水与干地缺少可读的生境过渡；可用水岸距离/地形高度适生带分层。`
  }] : [];
}

function findAuthoredSceneProgramIssues(map: EditableMap, suggestion: MapAiSuggestion): string[] {
  let candidate: EditableMap;
  try {
    candidate = applyMapOperations(map, suggestion.operations);
  } catch {
    return [];
  }
  if (suggestion.codePlan?.sceneIntent !== 'authored' && candidate.designSemantics.groups.length === 0) return [];
  const groups = candidate.designSemantics.groups;
  const parentIds = new Set(groups.flatMap((group) => group.parentId ? [group.parentId] : []));
  const issues: string[] = [];
  for (const group of groups) {
    if (parentIds.has(group.id)) continue;
    const objects = candidate.objects.filter((object) => object.designGroupId === group.id);
    if (groups.length > 1 && group.layers.length > 0 && objects.length > 0) {
      if (!group.region) issues.push(`scene_group_region_missing:${group.id}`);
      if (!group.spatialRole) issues.push(`scene_group_spatial_role_missing:${group.id}`);
    }
    if (!group.region) continue;
    for (const layer of group.layers) {
      const actualCount = objects.filter((object) => object.compositionLayer === layer.level).length;
      const requiredCount = Math.max(1, layer.minCount ?? 1);
      if (layer.intent.trim() && actualCount === 0) {
        issues.push(`scene_group_missing_layer:${group.id}:${layer.level}`);
      } else if (layer.intent.trim() && actualCount < requiredCount) {
        issues.push(`scene_group_underfilled_layer:${group.id}:${layer.level}:target=${requiredCount}`);
      }
    }
    issues.push(...designGroupCoverageIssues(candidate, group.id));
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
  return [...new Set(issues)].slice(0, 12);
}

function designGroupCoverageIssues(map: EditableMap, groupId: string): string[] {
  const group = map.designSemantics.groups.find((candidate) => candidate.id === groupId);
  if (!group?.region || (group.spatialRole !== 'urban-fabric' && group.spatialRole !== 'landmark-ensemble')) return [];
  if (designRegionArea(group.region) < 180) return [];
  const objects = map.objects.filter((object) => object.designGroupId === group.id && !object.parentId);
  const structures = objects.filter((object) => object.compositionLayer === 1);
  if (structures.length === 0) return [];
  const boxes = structures.map(designObjectFootprint);
  const supportBoxes = objects.filter((object) => object.compositionLayer === 2).map(designObjectFootprint);
  const cells = sampleDesignRegion(group.region, 14);
  if (cells.length < 16) return [];
  const insideBox = (point: Point2, box: ReturnType<typeof designObjectFootprint>, padding = 0): boolean => (
    point[0] >= box.minX - padding && point[0] <= box.maxX + padding
    && point[1] >= box.minZ - padding && point[1] <= box.maxZ + padding
  );
  const buildingCoverage = cells.filter((point) => boxes.some((box) => insideBox(point, box))).length / cells.length;
  const layerDensity = group.layers.find((layer) => layer.level === 1)?.density ?? 'normal';
  const baseBuildingTarget = group.spatialRole === 'urban-fabric' ? 0.14 : 0.05;
  const buildingTarget = baseBuildingTarget * (layerDensity === 'tight' ? 1.2 : layerDensity === 'open' ? 0.75 : 1);
  const issues: string[] = [];
  if (buildingCoverage < buildingTarget) issues.push(`scene_group_building_coverage_low:${group.id}`);

  const guideIds = new Set([...group.guideIds, ...group.entryGuideIds, ...group.exitGuideIds, ...group.axisGuideIds]);
  const guides = map.guides.filter((guide) => guideIds.has(guide.id));
  const frontageSamples = guides.flatMap((guide) => sampleMapGuide(guide, { spacing: 2 }));
  if (frontageSamples.length >= 4) {
    const frontageCoverage = frontageSamples.filter((sample) => boxes.some((box) => (
      pointBoxDistance2(sample.x, sample.z, box) <= 6
    ))).length / frontageSamples.length;
    const frontageTarget = group.spatialRole === 'urban-fabric' ? 0.45 : 0.3;
    if (frontageCoverage < frontageTarget) issues.push(`scene_group_frontage_low:${group.id}`);
  }

  const intentionalZones = map.visualSemantics.zones.filter((zone) => zone.tags.includes('clear'));
  const assignedCount = cells.filter((point) => (
    boxes.some((box) => insideBox(point, box, 2.5))
    || supportBoxes.some((box) => insideBox(point, box, 1.5))
    || guides.some((guide) => mapGuidePolyline(guide).slice(1).some((end, index) => (
      pointSegmentDistance2(point[0], point[1], mapGuidePolyline(guide)[index], end) <= guide.width / 2 + 1.5
    )))
    || map.waterBodies.some((water) => isPointInsideWaterBody(water, point[0], point[1], map))
    || intentionalZones.some((zone) => visualZoneContainsPoint(zone, point))
  )).length;
  const unassignedRatio = 1 - assignedCount / cells.length;
  const unassignedLimit = group.spatialRole === 'urban-fabric' ? 0.45 : 0.55;
  if (unassignedRatio > unassignedLimit) issues.push(`scene_group_unassigned_space:${group.id}`);
  return issues;
}

function designObjectFootprint(object: EditableMap['objects'][number]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const width = Math.max(0.1, object.transform.size[0] * object.transform.scale[0]);
  const depth = Math.max(0.1, object.transform.size[2] * object.transform.scale[2]);
  const yaw = object.transform.rotation[1];
  const halfX = (Math.abs(Math.cos(yaw)) * width + Math.abs(Math.sin(yaw)) * depth) / 2;
  const halfZ = (Math.abs(Math.sin(yaw)) * width + Math.abs(Math.cos(yaw)) * depth) / 2;
  return {
    minX: object.transform.position[0] - halfX,
    maxX: object.transform.position[0] + halfX,
    minZ: object.transform.position[2] - halfZ,
    maxZ: object.transform.position[2] + halfZ
  };
}

function sampleDesignRegion(
  region: NonNullable<MapDesignSemantics['groups'][number]['region']>,
  resolution: number
): Point2[] {
  const boundary = region.kind === 'circle'
    ? { minX: region.x - region.radius, maxX: region.x + region.radius, minZ: region.z - region.radius, maxZ: region.z + region.radius }
    : {
      minX: Math.min(...region.points.map((point) => point[0])) - (region.kind === 'path' ? region.width / 2 : 0),
      maxX: Math.max(...region.points.map((point) => point[0])) + (region.kind === 'path' ? region.width / 2 : 0),
      minZ: Math.min(...region.points.map((point) => point[1])) - (region.kind === 'path' ? region.width / 2 : 0),
      maxZ: Math.max(...region.points.map((point) => point[1])) + (region.kind === 'path' ? region.width / 2 : 0)
    };
  const points: Point2[] = [];
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const point = codePoint(
        boundary.minX + (column + 0.5) * (boundary.maxX - boundary.minX) / resolution,
        boundary.minZ + (row + 0.5) * (boundary.maxZ - boundary.minZ) / resolution
      );
      if (designRegionContains(region, point[0], point[1])) points.push(point);
    }
  }
  return points;
}

function pointBoxDistance2(
  x: number,
  z: number,
  box: ReturnType<typeof designObjectFootprint>
): number {
  return Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minZ - z, 0, z - box.maxZ));
}

function visualZoneContainsPoint(zone: EditableMap['visualSemantics']['zones'][number], point: Point2): boolean {
  if (zone.region) return designRegionContains(zone.region, point[0], point[1]);
  return Math.hypot(point[0] - zone.center[0], point[1] - zone.center[1]) <= zone.radius;
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
  const light = input.light === undefined ? undefined : normalizeMapAssetLight(input.light);
  if (input.light !== undefined && !light) throw new Error('invalid_map_code_asset_light');
  return {
    key,
    name,
    prompt,
    ...(typeof input.mountOnAssetId === 'string' && input.mountOnAssetId.trim() ? { mountOnAssetId: input.mountOnAssetId.trim() } : {}),
    tags: normalizeAssetTags(input.tags) ?? [],
    ...(light ? { light } : {}),
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

function supportsSeededEnvironmentVariants(requirement: CodeAssetRequirement): boolean {
  if (requirement.mountOnAssetId) return false;
  if (requirement.variants < 2 || (requirement.role !== undefined && requirement.role !== 'environment')) return false;
  const semantic = `${requirement.name} ${requirement.prompt} ${requirement.tags.join(' ')}`;
  return /tree|shrub|bush|rock|stone|plant|flower|mushroom|cactus|树|灌木|岩|石|植物|花|蘑菇|仙人掌/i.test(semantic)
    && !/animal|creature|bird|fish|deer|sheep|动物|生物|鸟|鱼|鹿|羊/i.test(semantic);
}

function normalizeCodeAssetKey(value: string): string {
  const source = String(value ?? '').trim().toLowerCase();
  const ascii = source
    .trim()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  if (!source) throw new Error('invalid_map_code_asset_key');
  if (ascii === source) return ascii;
  const suffix = (hashText(source) >>> 0).toString(36);
  return ascii
    ? `${ascii.slice(0, Math.max(1, 47 - suffix.length))}-${suffix}`
    : `asset-${suffix}`;
}

function sameCodeAssetRequirement(left: CodeAssetRequirement, right: CodeAssetRequirement): boolean {
  return left.name === right.name
    && left.mountOnAssetId === right.mountOnAssetId
    && left.prompt === right.prompt
    && left.variants === right.variants
    && left.tags.join('\n') === right.tags.join('\n')
    && JSON.stringify(left.dimensions) === JSON.stringify(right.dimensions)
    && JSON.stringify(left.light) === JSON.stringify(right.light)
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
    ...(placement.assemblyId ? { assemblyId: placement.assemblyId } : {}),
    ...(placement.assemblyRole ? { assemblyRole: placement.assemblyRole } : {}),
    ...(placement.compositionLayer ? { compositionLayer: placement.compositionLayer } : {}),
    ...(placement.sourceGuideId ? { sourceGuideId: placement.sourceGuideId } : {}),
    ...(placement.foundation ? { foundation: placement.foundation } : {}),
    transform: {
      position: placement.heightMode === 'terrain' || placement.terrainOffset !== undefined
        ? [placement.position[0], sampleTerrainHeight(terrainMap, placement.position[0], placement.position[2]) + (placement.terrainOffset ?? 0), placement.position[2]]
        : placement.position,
      rotation: [0, placement.rotationY, 0],
      scale: placement.scale,
      size: placement.size
    }
  };
}

function placementDesignMetadata(
  groupIdValue: unknown,
  layerValue: unknown,
  assemblyIdValue?: unknown,
  assemblyRoleValue?: unknown
): { designGroupId?: string; compositionLayer?: MapCompositionLayer; assemblyId?: string; assemblyRole?: 'opening' } {
  const designGroupId = typeof groupIdValue === 'string' ? groupIdValue.trim().slice(0, 80) : '';
  const assemblyId = typeof assemblyIdValue === 'string' ? assemblyIdValue.trim().slice(0, 80) : '';
  const layer = Number(layerValue);
  return {
    ...(designGroupId ? { designGroupId } : {}),
    ...(assemblyId ? { assemblyId } : {}),
    ...(assemblyRoleValue === 'opening' ? { assemblyRole: 'opening' as const } : {}),
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
  return undefined;
}

function reportAssemblyIssues(
  design: MapDesignSemantics,
  placements: readonly PlacementIntent[],
  reportIssue: (issue: CodeExecutionIssue) => void,
  matchesModule: (assetId: string, key: string) => boolean
): void {
  const declared = new Set(design.assemblies.map((assembly) => assembly.id));
  for (const placement of placements) {
    if (!placement.assemblyId || declared.has(placement.assemblyId)) continue;
    reportIssue({
      key: `assembly:unknown:${placement.assemblyId}`,
      code: 'code.geometry-unresolved',
      message: `构件 ${placement.name} 引用了未声明的复合建筑 ${placement.assemblyId}`,
      repaired: false
    });
  }
  for (const assembly of design.assemblies) {
    const members = placements.filter((placement) => placement.assemblyId === assembly.id);
    const warn = (detail: string) => reportIssue({
      key: `assembly:${assembly.id}:${detail}`,
      code: 'code.geometry-unresolved',
      message: `复合建筑 ${assembly.id}：${detail}`,
      repaired: false
    });
    if (members.length === 0) {
      warn('没有摆放构件');
      continue;
    }
    if (members.some((member) => member.designGroupId !== assembly.groupId)) warn('构件与声明的设计组不一致');
    for (const declaredKey of assembly.moduleKeys ?? []) {
      const key = normalizeCodeAssetKey(declaredKey);
      if (!members.some((member) => member.assetId && matchesModule(member.assetId, key))) {
        warn(`声明的构件族 ${declaredKey} 未在建筑内摆放`);
      }
    }
    if (assembly.openings !== undefined && members.filter((member) => member.assemblyRole === 'opening').length !== assembly.openings) {
      warn(`声明 ${assembly.openings} 处开口，但对应构件数量不符`);
    }
    if (assembly.stories && assembly.stories > 1) {
      const tiers = new Set(members.map((member) => Math.round(
        (member.connection?.elevation ?? (member.heightMode === 'terrain' ? 0 : member.position[1])) * 100
      )));
      if (tiers.size < assembly.stories) warn(`声明 ${assembly.stories} 个楼层，但仅摆放 ${tiers.size} 个高度层的构件`);
    }
    if (assembly.topology === 'group') continue;
    const edges = members.flatMap((member) => member.connection ? [member.connection] : []);
    if (edges.length === 0) {
      warn('未找到声明连接端点的构件');
      continue;
    }
    const pointKey = (point: Point2) => `${Math.round(point[0] * 100)},${Math.round(point[1] * 100)}`;
    const byElevation = new Map<number, typeof edges>();
    for (const edge of edges) {
      const level = Math.round((edge.elevation ?? 0) * 100);
      const tier = byElevation.get(level) ?? [];
      tier.push(edge);
      byElevation.set(level, tier);
    }
    for (const tier of byElevation.values()) {
      const degree = new Map<string, number>();
      const adjacency = new Map<string, Set<string>>();
      for (const edge of tier) {
        const start = pointKey(edge.start);
        const end = pointKey(edge.end);
        degree.set(start, (degree.get(start) ?? 0) + 1);
        degree.set(end, (degree.get(end) ?? 0) + 1);
        if (!adjacency.has(start)) adjacency.set(start, new Set());
        if (!adjacency.has(end)) adjacency.set(end, new Set());
        adjacency.get(start)!.add(end);
        adjacency.get(end)!.add(start);
        if (edge.gapRatio > 0.01) warn('相邻构件的连接处仍有间隙');
        const span = Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]) * (1 - edge.gapRatio);
        if (edge.nominalSpan !== undefined && span > edge.nominalSpan * 1.5) warn('连接构件拉伸超过其基准跨度的 1.5 倍');
      }
      const visited = new Set<string>();
      const stack = [adjacency.keys().next().value as string];
      while (stack.length > 0) {
        const point = stack.pop()!;
        if (visited.has(point)) continue;
        visited.add(point);
        for (const neighbor of adjacency.get(point) ?? []) stack.push(neighbor);
      }
      const ends = [...degree.values()].filter((count) => count === 1).length;
      const valid = visited.size === degree.size && [...degree.values()].every((count) => count <= 2)
        && (assembly.topology === 'loop' ? tier.length >= 3 && ends === 0 : ends === 2);
      if (!valid) warn(assembly.topology === 'loop' ? '构件尚未形成连续闭环' : '构件尚未形成连续路径');
    }
  }
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
    const center = region.center === undefined
      ? region.x === undefined || region.z === undefined ? undefined : [region.x, region.z]
      : region.center;
    if (center === undefined) throw new Error('invalid_map_code_terrain_region:center');
    const radius = region.radius ?? region.r;
    if (radius === undefined) throw new Error('invalid_map_code_terrain_region:radius');
    const [x, z] = point2(center);
    return {
      kind: 'circle',
      x,
      z,
      radius: Math.max(0.1, finite(radius))
    };
  }
  if (region.kind === 'path') {
    if (region.points === undefined) throw new Error('invalid_map_code_terrain_region:points');
    if (region.width === undefined) throw new Error('invalid_map_code_terrain_region:width');
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

const MAX_LOCAL_WATER_RELOCATION = 4;

interface CodeSubstrateConflict {
  groupId: string;
  substrate?: MapDesignSemantics['groups'][number]['substrate'];
  count: number;
}

function relocateOutdoorWaterIntrusions(
  terrainMap: EditableMap,
  operations: readonly Extract<MapOperation, { type: 'object.add' }>[],
  placements: readonly PlacementIntent[],
  assets: readonly MapAsset[],
  design: MapDesignSemantics
): { operations: Array<Extract<MapOperation, { type: 'object.add' }>>; count: number; conflicts: CodeSubstrateConflict[] } {
  if (terrainMap.waterBodies.length === 0) return { operations: [...operations], count: 0, conflicts: [] };
  const assetById = new Map([...(terrainMap.assets ?? []), ...assets].map((asset) => [asset.id, asset]));
  const designGroupById = new Map(design.groups.map((group) => [group.id, group]));
  const repaired = [...operations];
  const eligible = operations.flatMap((operation, index) => {
    const placement = placements[index];
    const substrate = placement?.designGroupId
      ? designGroupById.get(placement.designGroupId)?.substrate
      : undefined;
    const asset = operation.object.assetId ? assetById.get(operation.object.assetId) : undefined;
    const semantic = [placement?.semantic, operation.object.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])]
      .filter(Boolean)
      .join(' ');
    return operation.object.heightMode === 'terrain'
      && !placement?.bridgeWaterId
      && substrate !== 'water'
      && substrate !== 'underwater'
      && substrate !== 'amphibious'
      && DRY_LAND_ASSET.test(semantic)
      && !WATER_COMPATIBLE_ASSET.test(semantic)
      ? [{ index, placement, semantic }]
      : [];
  });
  const conflictCounts = new Map<string, CodeSubstrateConflict>();
  const grouped = new Set<number>();
  const batches: number[][] = [];
  for (const candidate of eligible) {
    if (grouped.has(candidate.index)) continue;
    const placement = candidate.placement;
    const continuous = placement && CONTINUOUS_STRUCTURE_ASSET.test(candidate.semantic);
    const batch = placement?.assemblyId
      ? eligible.filter((other) => other.placement?.assemblyId === placement.assemblyId).map((other) => other.index)
      : continuous
      ? eligible.filter((other) => (
        other.placement?.assetId === placement.assetId
        && !other.placement?.assemblyId
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
    const groupId = placements[batch[0]]?.designGroupId;
    const group = groupId ? designGroupById.get(groupId) : undefined;
    if (group && Math.hypot(translation[0], translation[1]) > MAX_LOCAL_WATER_RELOCATION) {
      const existing = conflictCounts.get(group.id);
      conflictCounts.set(group.id, {
        groupId: group.id,
        ...(group.substrate ? { substrate: group.substrate } : {}),
        count: (existing?.count ?? 0) + batch.length
      });
      continue;
    }
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
  return { operations: repaired, count, conflicts: [...conflictCounts.values()] };
}

function findDeclaredSubstrateConflicts(
  terrainMap: EditableMap,
  operations: readonly Extract<MapOperation, { type: 'object.add' }>[],
  placements: readonly PlacementIntent[],
  design: MapDesignSemantics
): CodeSubstrateConflict[] {
  const conflicts: CodeSubstrateConflict[] = [];
  for (const group of design.groups) {
    if (!group.substrate || group.substrate === 'dry') continue;
    const candidates = operations.flatMap((operation, index) => {
      const placement = placements[index];
      if (placement?.designGroupId !== group.id || placement.bridgeWaterId
        || (placement.role !== 'structure' && (placement.compositionLayer ?? 4) > 2)) return [];
      const position = operation.object.transform?.position;
      return position ? [[position[0], position[2]] satisfies Point2] : [];
    });
    if (candidates.length < 2) continue;
    const wetCount = candidates.filter((point) => terrainMap.waterBodies.some((water) => (
      isPointInsideWaterBody(water, point[0], point[1], terrainMap)
    ))).length;
    const clearlyOffWater = (group.substrate === 'water' || group.substrate === 'underwater') && wetCount === 0;
    const oneSidedAmphibious = group.substrate === 'amphibious'
      && candidates.length >= 4
      && (wetCount === 0 || wetCount === candidates.length);
    if (clearlyOffWater || oneSidedAmphibious) {
      conflicts.push({ groupId: group.id, substrate: group.substrate, count: candidates.length });
    }
  }
  return conflicts;
}

function mergeSubstrateConflicts(conflicts: readonly CodeSubstrateConflict[]): CodeSubstrateConflict[] {
  const merged = new Map<string, CodeSubstrateConflict>();
  for (const conflict of conflicts) {
    const previous = merged.get(conflict.groupId);
    merged.set(conflict.groupId, {
      groupId: conflict.groupId,
      substrate: conflict.substrate ?? previous?.substrate,
      count: Math.max(conflict.count, previous?.count ?? 0)
    });
  }
  return [...merged.values()];
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
    const key = [placement.assetId, placement.designGroupId ?? '', placement.assemblyId ?? '', placement.compositionLayer ?? 0].join('|');
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
    const key = [placement.assetId, placement.designGroupId ?? '', placement.assemblyId ?? '', placement.compositionLayer ?? 0, placement.connection.elevation ?? 0].join('|');
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

function subdividePathBySpan(
  pointValues: readonly Point2[],
  span: number,
  closed: boolean,
  startInset: number,
  endInset: number,
  fit: 'stretch' | 'center'
): Array<{ start: Point2; end: Point2; center: Point2; tangent: Point2; length: number; index: number }> {
  const points = pointValues.map((point) => point2(point));
  if (closed && points.length > 2 && pointDistance2(points[0], points[points.length - 1]) < 0.000001) points.pop();
  if (points.length < 2 || (closed && points.length < 3)) throw new Error('invalid_map_code_path_subdivision_points');
  const runs = Array.from({ length: closed ? points.length : points.length - 1 }, (_, index) => {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    return { start, end, length: pointDistance2(start, end) };
  }).filter((run) => run.length > 0.000001);
  const totalLength = runs.reduce((sum, run) => sum + run.length, 0);
  const available = totalLength - startInset - endInset;
  if (available <= 0.000001) return [];
  const count = Math.min(MAX_POINT_RESULTS, Math.max(1, Math.floor(available / span)));
  const bayLength = fit === 'stretch' ? available / count : Math.min(span, available);
  const usedLength = bayLength * count;
  const firstDistance = startInset + (fit === 'center' ? (available - usedLength) / 2 : 0);
  const sample = (distanceValue: number): Point2 => {
    let distance = clampFinite(distanceValue, 0, totalLength);
    for (const run of runs) {
      if (distance <= run.length || run === runs[runs.length - 1]) {
        const amount = clampFinite(distance / run.length, 0, 1);
        return codePoint(
          run.start[0] + (run.end[0] - run.start[0]) * amount,
          run.start[1] + (run.end[1] - run.start[1]) * amount
        );
      }
      distance -= run.length;
    }
    return codePoint(points[points.length - 1][0], points[points.length - 1][1]);
  };
  return Array.from({ length: count }, (_, index) => {
    const start = sample(firstDistance + index * bayLength);
    const end = sample(firstDistance + (index + 1) * bayLength);
    const length = pointDistance2(start, end);
    const tangent = length > 0.000001
      ? codePoint((end[0] - start[0]) / length, (end[1] - start[1]) / length)
      : codePoint(0, 1);
    return { start, end, center: midpoint2(start, end), tangent, length, index };
  });
}

function offsetPolygon(pointValues: readonly Point2[], distance: number): Point2[] {
  const points = pointValues.map((point) => point2(point));
  if (points.length > 3 && pointDistance2(points[0], points[points.length - 1]) < 0.000001) points.pop();
  if (points.length < 3) throw new Error('invalid_map_code_polygon_points');
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(twiceArea) < 0.000001) throw new Error('invalid_map_code_polygon_area');
  const winding = Math.sign(twiceArea);
  const normal = (start: Point2, end: Point2): Point2 => {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.max(0.000001, Math.hypot(dx, dz));
    return codePoint(winding * dz / length, -winding * dx / length);
  };
  return points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const before = normal(previous, point);
    const after = normal(point, next);
    const sumX = before[0] + after[0];
    const sumZ = before[1] + after[1];
    const sumLength = Math.hypot(sumX, sumZ);
    if (sumLength < 0.000001) return codePoint(point[0] + after[0] * distance, point[1] + after[1] * distance);
    const bisector = codePoint(sumX / sumLength, sumZ / sumLength);
    const denominator = Math.max(0.25, Math.abs(bisector[0] * after[0] + bisector[1] * after[1]));
    const extension = Math.sign(distance) * Math.min(Math.abs(distance) / denominator, Math.abs(distance) * 4);
    return codePoint(point[0] + bisector[0] * extension, point[1] + bisector[1] * extension);
  });
}

function gridInsideRegion(
  region: { kind: 'circle'; center: Point2; radius: number } | { kind: 'polygon'; points: Point2[] },
  spacing: Point2,
  angle: number,
  inset: number
): Point2[] {
  const center = region.kind === 'circle'
    ? point2(region.center)
    : codePoint(
      region.points.reduce((sum, point) => sum + point[0], 0) / region.points.length,
      region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length
    );
  const boundary = region.kind === 'circle'
    ? Array.from({ length: 24 }, (_, index) => codePoint(
      center[0] + Math.cos(index * Math.PI * 2 / 24) * region.radius,
      center[1] + Math.sin(index * Math.PI * 2 / 24) * region.radius
    ))
    : region.points.map((point) => point2(point));
  if (boundary.length < 3) throw new Error('invalid_map_code_region_grid_points');
  const local = boundary.map((point) => rotatePoint2(point, -angle, center));
  const minX = Math.min(...local.map((point) => point[0]));
  const maxX = Math.max(...local.map((point) => point[0]));
  const minZ = Math.min(...local.map((point) => point[1]));
  const maxZ = Math.max(...local.map((point) => point[1]));
  const columns = Math.min(MAX_POINT_RESULTS, Math.max(1, Math.floor((maxX - minX) / spacing[0]) + 1));
  const rows = Math.min(Math.max(1, Math.floor(MAX_POINT_RESULTS / columns)), Math.max(1, Math.floor((maxZ - minZ) / spacing[1]) + 1));
  const startX = center[0] - (columns - 1) * spacing[0] / 2;
  const startZ = center[1] - (rows - 1) * spacing[1] / 2;
  const inside = (point: Point2): boolean => region.kind === 'circle'
    ? pointDistance2(point, center) <= Math.max(0, region.radius - inset)
    : pointInsidePolygon2(point, region.points) && polygonEdgeDistance2(point, region.points) >= inset;
  const result: Point2[] = [];
  for (let row = 0; row < rows && result.length < MAX_POINT_RESULTS; row += 1) {
    for (let column = 0; column < columns && result.length < MAX_POINT_RESULTS; column += 1) {
      const point = rotatePoint2(codePoint(startX + column * spacing[0], startZ + row * spacing[1]), angle, center);
      if (inside(point)) result.push(point);
    }
  }
  return result;
}

function rotatePoint2(point: Point2, angle: number, center: Point2): Point2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point[0] - center[0];
  const z = point[1] - center[1];
  return codePoint(center[0] + x * cosine - z * sine, center[1] + x * sine + z * cosine);
}

function pointInsidePolygon2(point: Point2, points: readonly Point2[]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const left = points[index];
    const right = points[previous];
    if (((left[1] > point[1]) !== (right[1] > point[1]))
      && point[0] < (right[0] - left[0]) * (point[1] - left[1]) / (right[1] - left[1]) + left[0]) inside = !inside;
  }
  return inside;
}

function polygonEdgeDistance2(point: Point2, points: readonly Point2[]): number {
  return points.reduce((closest, start, index) => Math.min(
    closest,
    pointSegmentDistance2(point[0], point[1], start, points[(index + 1) % points.length])
  ), Infinity);
}

function point3(value: readonly number[]): Point3 {
  if (!Array.isArray(value) || value.length < 3) throw new Error('invalid_map_code_point');
  return [finite(value[0]), finite(value[1]), finite(value[2])];
}

function localToWorld3D(
  localValue: readonly number[],
  originValue: readonly number[],
  forwardValue: readonly number[],
  upValue: readonly number[]
): Point3 {
  const local = point3(localValue);
  const origin = point3(originValue);
  const forward = normalizeVector3(point3(forwardValue));
  const requestedUp = normalizeVector3(point3(upValue));
  const right = normalizeVector3(crossVector3(requestedUp, forward));
  const up = crossVector3(forward, right);
  return [
    origin[0] + right[0] * local[0] + up[0] * local[1] + forward[0] * local[2],
    origin[1] + right[1] * local[0] + up[1] * local[1] + forward[1] * local[2],
    origin[2] + right[2] * local[0] + up[2] * local[1] + forward[2] * local[2]
  ].map(finite) as Point3;
}

function normalizeVector3(value: Point3): Point3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= 0.000001) throw new Error('invalid_map_code_frame');
  return [value[0] / length, value[1] / length, value[2] / length];
}

function crossVector3(left: Point3, right: Point3): Point3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
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

function sampleProbabilityFieldPoints(
  rawBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  options: { maxPoints?: number; candidates?: number; minDistance?: number; seed?: number },
  weightFunction: (point: Point2 & { x: number; z: number }, index: number) => number
): Point2[] {
  const bounds = {
    minX: finite(rawBounds.minX),
    maxX: finite(rawBounds.maxX),
    minZ: finite(rawBounds.minZ),
    maxZ: finite(rawBounds.maxZ)
  };
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new Error('invalid_probability_field_bounds');
  const maxPoints = boundedCount(options.maxPoints ?? 128, 1, MAX_POINT_RESULTS);
  const candidates = boundedCount(options.candidates ?? maxPoints * 8, 1, MAX_PROBABILITY_CANDIDATES);
  const minDistance = Math.max(0, finite(options.minDistance ?? 0));
  const random = mulberry32(Math.trunc(finite(options.seed ?? 1)));
  const points: Point2[] = [];
  for (let index = 0; index < candidates && points.length < maxPoints; index += 1) {
    const point = codePoint(
      bounds.minX + random() * (bounds.maxX - bounds.minX),
      bounds.minZ + random() * (bounds.maxZ - bounds.minZ)
    ) as Point2 & { x: number; z: number };
    const weight = clampFinite(weightFunction(Object.freeze(point), index), 0, 1);
    if (random() > weight) continue;
    if (minDistance > 0 && points.some((existing) => Math.hypot(existing[0] - point[0], existing[1] - point[1]) < minDistance)) {
      continue;
    }
    points.push(point);
  }
  return points;
}

function terrainSlopeDegrees(map: EditableMap, x: number, z: number): number {
  const stepX = Math.max(0.05, map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1));
  const stepZ = Math.max(0.05, map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1));
  const dx = (sampleTerrainHeight(map, x + stepX, z) - sampleTerrainHeight(map, x - stepX, z)) / (stepX * 2);
  const dz = (sampleTerrainHeight(map, x, z + stepZ) - sampleTerrainHeight(map, x, z - stepZ)) / (stepZ * 2);
  return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
}

function optimizeLayoutItems(
  rawItems: Array<{ id: string; position: Point2; rotationY?: number; fixed?: boolean }>,
  rawBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  options: {
    iterations?: number;
    translationStep?: number;
    rotationStep?: number;
    temperature?: number;
    seed?: number;
  },
  costFunction: (items: ReadonlyArray<{
    id: string;
    position: Point2 & { x: number; z: number };
    rotationY: number;
    fixed: boolean;
  }>) => number
): Array<{
  id: string;
  position: Point2 & { x: number; z: number };
  rotationY: number;
  fixed: boolean;
}> {
  if (rawItems.length === 0 || rawItems.length > MAX_LAYOUT_ITEMS) throw new Error('invalid_layout_optimizer_items');
  const bounds = {
    minX: finite(rawBounds.minX),
    maxX: finite(rawBounds.maxX),
    minZ: finite(rawBounds.minZ),
    maxZ: finite(rawBounds.maxZ)
  };
  if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new Error('invalid_layout_optimizer_bounds');
  const ids = new Set<string>();
  type MutableLayoutItem = { id: string; position: Point2; rotationY: number; fixed: boolean };
  const initial: MutableLayoutItem[] = rawItems.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_layout_optimizer_item');
    const id = cleanText(String(raw.id ?? ''), 80);
    if (!id || ids.has(id)) throw new Error('invalid_layout_optimizer_item_id');
    ids.add(id);
    const position = point2(raw.position);
    return {
      id,
      position: codePoint(
        clampFinite(position[0], bounds.minX, bounds.maxX),
        clampFinite(position[1], bounds.minZ, bounds.maxZ)
      ),
      rotationY: finite(raw.rotationY ?? 0),
      fixed: raw.fixed === true
    };
  });
  const movableIndices = initial.flatMap((item, index) => item.fixed ? [] : [index]);
  const iterations = boundedCount(options.iterations ?? 192, 1, MAX_LAYOUT_ITERATIONS);
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const translationStep = clampFinite(options.translationStep ?? extent * 0.08, 0, extent);
  const rotationStep = clampFinite(options.rotationStep ?? Math.PI / 6, 0, Math.PI * 2);
  const temperature = Math.max(0, finite(options.temperature ?? 0));
  const random = mulberry32(Math.trunc(finite(options.seed ?? 1)));
  const cloneItems = (items: readonly MutableLayoutItem[]): MutableLayoutItem[] => items.map((item) => ({
    ...item,
    position: codePoint(item.position[0], item.position[1])
  }));
  const evaluate = (items: readonly MutableLayoutItem[]): number => {
    const view = Object.freeze(items.map((item) => Object.freeze({
      id: item.id,
      position: Object.freeze(codePoint(item.position[0], item.position[1])) as Point2 & { x: number; z: number },
      rotationY: item.rotationY,
      fixed: item.fixed
    })));
    const value = costFunction(view);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_layout_optimizer_cost');
    return value;
  };
  let current = cloneItems(initial);
  let currentCost = evaluate(current);
  let best = cloneItems(current);
  let bestCost = currentCost;
  for (let iteration = 0; iteration < iterations && movableIndices.length > 0; iteration += 1) {
    const progress = iteration / iterations;
    const stepScale = 1 - progress * 0.85;
    const targetIndex = movableIndices[Math.floor(random() * movableIndices.length)];
    const candidate = cloneItems(current);
    const target = candidate[targetIndex];
    target.position = codePoint(
      clampFinite(target.position[0] + (random() * 2 - 1) * translationStep * stepScale, bounds.minX, bounds.maxX),
      clampFinite(target.position[1] + (random() * 2 - 1) * translationStep * stepScale, bounds.minZ, bounds.maxZ)
    );
    target.rotationY += (random() * 2 - 1) * rotationStep * stepScale;
    const candidateCost = evaluate(candidate);
    const currentTemperature = temperature * (1 - progress);
    const accept = candidateCost <= currentCost
      || (currentTemperature > 0 && random() < Math.exp((currentCost - candidateCost) / currentTemperature));
    if (!accept) continue;
    current = candidate;
    currentCost = candidateCost;
    if (candidateCost < bestCost) {
      best = cloneItems(candidate);
      bestCost = candidateCost;
    }
  }
  return best.map((item) => ({
    ...item,
    position: codePoint(item.position[0], item.position[1]) as Point2 & { x: number; z: number }
  }));
}

function normalizePoissonBounds(
  value: unknown,
  fallback: { minX: number; maxX: number; minZ: number; maxZ: number }
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (Array.isArray(value) && value.length >= 2) {
    const min = point2(value[0]);
    const max = point2(value[1]);
    return { minX: min[0], maxX: max[0], minZ: min[1], maxZ: max[1] };
  }
  if (value && typeof value === 'object') {
    const bounds = value as Record<string, unknown>;
    return {
      minX: finite(bounds.minX ?? bounds.xMin),
      maxX: finite(bounds.maxX ?? bounds.xMax),
      minZ: finite(bounds.minZ ?? bounds.zMin),
      maxZ: finite(bounds.maxZ ?? bounds.zMax)
    };
  }
  return fallback;
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
