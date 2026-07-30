import {
  applyMapOperations,
  type MapAiSuggestion,
  type MapOperation
} from '../shared/mapOperations';
import {
  createId,
  getMapBounds,
  getMapObjectAabbs,
  normalizeMap,
  PLAYER_RADIUS,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type TerrainBrushMode
} from '../shared/map';
import {
  CHAT_PROVIDER_OPTIONS,
  type ChatProvider,
  type Vec3
} from '../shared/protocol';
import { planLimits, type MapPlanLimits } from '../shared/mapPlanning';
import {
  expandMapScatter,
  isNearWater,
  terrainSlopeDegrees,
  type MapScatterPlan
} from '../shared/mapScatter';
import { llmChat } from './modelApi';

export interface MapAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface AssetGenerationRequest {
  name: string;
  prompt: string;
}

export interface MapAgentOptions extends MapAiOptions {
  createAsset: (request: AssetGenerationRequest) => Promise<MapAsset>;
}

export async function generateMapSuggestion(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAiOptions = {}
): Promise<MapAiSuggestion> {
  const content = await requestMapPlan(prompt, map, assets, options, false);
  return normalizeMapSuggestion(content, map, assets);
}

export async function runMapAgent(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAgentOptions
): Promise<MapAiSuggestion> {
  const firstContent = await requestMapPlan(prompt, map, assets, options, false);
  const limits = planLimits(getMapBounds(map));
  const requests = normalizeAssetRequests(
    parseJsonObject(firstContent).assetRequests,
    limits.assetRequestCount
  );
  if (requests.length === 0) {
    const firstSuggestion = normalizeMapSuggestion(firstContent, map, assets);
    if (hasSpatialOperations(firstSuggestion)) return firstSuggestion;
    const retryContent = await requestMapPlan(prompt, map, assets, options, true);
    const retrySuggestion = normalizeMapSuggestion(retryContent, map, assets);
    if (!hasSpatialOperations(retrySuggestion)) throw new Error('map_agent_no_spatial_plan');
    return retrySuggestion;
  }

  const generatedAssets: MapAsset[] = [];
  for (const request of requests) {
    options.signal?.throwIfAborted();
    generatedAssets.push(await options.createAsset(request));
  }

  const expandedAssets = [...assets, ...generatedAssets];
  const finalContent = await requestMapPlan(prompt, map, expandedAssets, options, true);
  if (normalizeAssetRequests(
    parseJsonObject(finalContent).assetRequests,
    limits.assetRequestCount
  ).length > 0) {
    throw new Error('map_agent_asset_limit');
  }
  const suggestion = {
    ...normalizeMapSuggestion(finalContent, map, expandedAssets),
    generatedAssets: generatedAssets.map((asset) => ({ id: asset.id, name: asset.name }))
  };
  if (!hasSpatialOperations(suggestion)) throw new Error('map_agent_no_spatial_plan');
  return suggestion;
}

async function requestMapPlan(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAiOptions,
  finalPass: boolean
): Promise<string> {
  const cleanPrompt = prompt.trim().slice(0, 1200);
  if (!cleanPrompt) throw new Error('missing_prompt');
  const provider = options.provider ?? 'gpt';
  const providerOption = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
  if (!providerOption || providerOption.disabled) throw new Error('provider_unavailable');
  const content = await llmChat([
    { role: 'system', content: buildSystemPrompt(map, assets, finalPass) },
    { role: 'user', content: cleanPrompt }
  ], {
    apiBase: options.apiBase,
    provider,
    temperature: 0.2,
    maxTokens: 4096,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
  return content;
}

export function normalizeMapSuggestion(
  content: string,
  map: EditableMap,
  assets: readonly MapAsset[]
): MapAiSuggestion {
  const input = parseJsonObject(content);

  const bounds = getMapBounds(map);
  const limits = planLimits(bounds);
  const renderPromptSuggestions = normalizeTextList(input.renderPromptSuggestions, 8, 80);
  const operations: MapOperation[] = renderPromptSuggestions.length > 0
    ? [{ type: 'map.update', renderPromptSuggestions }]
    : [];
  const terrainOperations = normalizeTerrainOperations(input.terrain, bounds, limits);
  operations.push(...terrainOperations);
  const waterOperations = normalizeWaterOperations(input.waters, bounds, limits);
  operations.push(...waterOperations);
  const spatialPreview = terrainOperations.length > 0 || waterOperations.length > 0
    ? applyMapOperations({ ...map, assets: [...assets] }, [...terrainOperations, ...waterOperations])
    : normalizeMap({ ...map, assets: [...assets] });
  const objectOperations = normalizeObjectOperations(input.objects, spatialPreview, assets, limits.objectCount);
  operations.push(...objectOperations);
  const scatterPreview = objectOperations.length > 0
    ? applyMapOperations(spatialPreview, objectOperations)
    : spatialPreview;
  const scatterOperations = normalizeScatterOperations(
    input.scatters ?? input.scatter,
    scatterPreview,
    assets,
    Math.max(0, limits.objectCount - objectOperations.length)
  );
  operations.push(...scatterOperations);
  const populatedPreview = scatterOperations.length > 0
    ? applyMapOperations(scatterPreview, scatterOperations)
    : scatterPreview;
  const spawnOperation = normalizeSpawnOperation(input.spawn, populatedPreview);
  if (spawnOperation) operations.push(spawnOperation);
  if (operations.length === 0) throw new Error('empty_map_suggestion');

  applyMapOperations(map, operations);
  return {
    summary: cleanText(input.summary, 'AI 地图建议', 200),
    operations,
    renderPromptSuggestions,
    generatedAssets: []
  };
}

function normalizeWaterOperations(
  value: unknown,
  bounds: ReturnType<typeof getMapBounds>,
  limits: MapPlanLimits
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.waterCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_water_plan');
    const input = item as Record<string, unknown>;
    const type = input.type;
    if (type !== 'lake' && type !== 'river') throw new Error('invalid_water_plan');
    if (!Array.isArray(input.points)) throw new Error('invalid_water_plan');
    const points = input.points.slice(0, 64).map((raw): [number, number] => {
      if (!raw || typeof raw !== 'object') throw new Error('invalid_water_plan');
      if (Array.isArray(raw)) {
        return [
          clamp(requiredNumber(raw[0], 'invalid_water_plan'), bounds.minX, bounds.maxX),
          clamp(requiredNumber(raw[1], 'invalid_water_plan'), bounds.minZ, bounds.maxZ)
        ];
      }
      const point = raw as Record<string, unknown>;
      return [
        clamp(requiredNumber(point.x, 'invalid_water_plan'), bounds.minX, bounds.maxX),
        clamp(requiredNumber(point.z, 'invalid_water_plan'), bounds.minZ, bounds.maxZ)
      ];
    });
    if (points.length < (type === 'lake' ? 3 : 2)) throw new Error('invalid_water_plan');
    return {
      type: 'water.add',
      water: {
        id: createId('water'),
        name: cleanText(input.name, type === 'lake' ? '湖泊' : '河流', 48),
        type,
        level: clamp(optionalNumber(input.level, 0.2), 0.02, bounds.maxY - 0.05),
        width: clamp(optionalNumber(input.width, 1.2), 0.3, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2),
        points
      }
    };
  });
}

function normalizeTerrainOperations(
  value: unknown,
  bounds: ReturnType<typeof getMapBounds>,
  limits: MapPlanLimits
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.terrainBrushCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_terrain_plan');
    const input = item as Record<string, unknown>;
    const mode = input.mode;
    if (mode !== 'raise' && mode !== 'lower' && mode !== 'flatten') throw new Error('invalid_terrain_plan');
    const x = requiredNumber(input.x, 'invalid_terrain_plan');
    const z = requiredNumber(input.z, 'invalid_terrain_plan');
    const operation: MapOperation = {
      type: 'terrain.brush',
      mode: mode as TerrainBrushMode,
      point: [
        clamp(x, bounds.minX, bounds.maxX),
        clamp(optionalNumber(input.targetHeight, 0), bounds.minY, bounds.maxY - 0.1),
        clamp(z, bounds.minZ, bounds.maxZ)
      ],
      size: clamp(optionalNumber(input.size, 2), 0.3, limits.brushRadiusMax),
      strength: clamp(optionalNumber(input.strength, 0.4), 0.02, 1.5)
    };
    if (mode === 'flatten') {
      operation.targetHeight = clamp(optionalNumber(input.targetHeight, 0), 0, bounds.maxY - 0.1);
    }
    return operation;
  });
}

function normalizeObjectOperations(
  value: unknown,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxCount: number
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  const bounds = getMapBounds(map);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return value.slice(0, maxCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_object_plan');
    const input = item as Record<string, unknown>;
    const assetId = typeof input.assetId === 'string' ? input.assetId : '';
    const asset = assetById.get(assetId);
    if (!asset) throw new Error('unknown_map_asset');
    const x = clamp(requiredNumber(input.x, 'invalid_object_plan'), bounds.minX, bounds.maxX);
    const z = clamp(requiredNumber(input.z, 'invalid_object_plan'), bounds.minZ, bounds.maxZ);
    const scale = clamp(optionalNumber(input.scale, 1), 0.1, 8);
    const rotationY = optionalNumber(input.rotationYDeg, 0) * Math.PI / 180;
    return {
      type: 'object.add',
      object: {
        id: createId('obj'),
        name: cleanText(input.name, asset.name, 48),
        assetId,
        transform: {
          position: [x, sampleTerrainHeight(map, x, z), z],
          rotation: [0, rotationY, 0],
          scale: [scale, scale, scale]
        }
      }
    };
  });
}

function normalizeScatterOperations(
  value: unknown,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxCount: number
): MapOperation[] {
  if (!Array.isArray(value) || maxCount <= 0) return [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  const bounds = getMapBounds(map);
  const operations: MapOperation[] = [];
  let workingMap = map;
  for (const [planIndex, item] of value.slice(0, 16).entries()) {
    if (operations.length >= maxCount) break;
    if (!item || typeof item !== 'object') throw new Error('invalid_scatter_plan');
    const input = item as Record<string, unknown>;
    const regionInput = input.region as Record<string, unknown> | undefined;
    const rawAssetIds = Array.isArray(input.assetIds)
      ? input.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
      : [];
    const selectedAssetIds = [...new Set(rawAssetIds)];
    if (selectedAssetIds.length === 0 || selectedAssetIds.some((assetId) => !assetIds.has(assetId))) {
      throw new Error('unknown_map_asset');
    }
    if (!regionInput || regionInput.kind !== 'circle') throw new Error('invalid_scatter_plan');
    const rawScaleRange = Array.isArray(input.scaleRange) ? input.scaleRange : [1, 1];
    const plan: MapScatterPlan = {
      assetIds: selectedAssetIds,
      region: {
        kind: 'circle',
        x: clamp(requiredNumber(regionInput.x, 'invalid_scatter_plan'), bounds.minX, bounds.maxX),
        z: clamp(requiredNumber(regionInput.z, 'invalid_scatter_plan'), bounds.minZ, bounds.maxZ),
        r: requiredNumber(regionInput.r, 'invalid_scatter_plan')
      },
      density: optionalNumber(input.density, 0.04),
      avoidWater: optionalNumber(input.avoidWater, 1),
      maxSlope: optionalNumber(input.maxSlope, 30),
      minSpacing: optionalNumber(input.minSpacing, 2),
      scaleRange: [
        optionalNumber(rawScaleRange[0], 0.9),
        optionalNumber(rawScaleRange[1], 1.1)
      ],
      seed: optionalNumber(input.seed, planIndex + 1)
    };
    const placements = expandMapScatter(
      workingMap,
      plan,
      assets,
      maxCount - operations.length,
      `scatter-${map.id}-${map.updatedAt}-${planIndex}`
    );
    const placementOperations = placements.map((placement): MapOperation => ({
      type: 'object.add',
      object: {
        id: placement.id,
        name: placement.name,
        assetId: placement.assetId,
        transform: {
          position: [placement.x, placement.y, placement.z],
          rotation: [0, placement.rotationY, 0],
          scale: [placement.scale, placement.scale, placement.scale]
        }
      }
    }));
    operations.push(...placementOperations);
    if (placementOperations.length > 0) {
      workingMap = applyMapOperations(workingMap, placementOperations);
    }
  }
  return operations;
}

function normalizeSpawnOperation(value: unknown, map: EditableMap): MapOperation | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const bounds = getMapBounds(map);
  const x = clamp(requiredNumber(input.x, 'invalid_spawn_plan'), bounds.minX, bounds.maxX);
  const z = clamp(requiredNumber(input.z, 'invalid_spawn_plan'), bounds.minZ, bounds.maxZ);
  const [safeX, safeZ] = findSafeSpawnPosition(map, x, z);
  const point: Vec3 = [safeX, sampleTerrainHeight(map, safeX, safeZ), safeZ];
  return {
    type: 'reference.set',
    point,
    yaw: optionalNumber(input.yawDeg, 0) * Math.PI / 180
  };
}

function findSafeSpawnPosition(map: EditableMap, requestedX: number, requestedZ: number): [number, number] {
  const bounds = getMapBounds(map);
  const obstacles = getMapObjectAabbs(map);
  const terrainStep = Math.max(
    1,
    Math.min(
      map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1),
      map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1)
    )
  );
  const maxRadius = Math.min(map.box.size[0], map.box.size[2]) / 3;
  for (let radius = 0; radius <= maxRadius; radius += terrainStep) {
    const candidateCount = radius === 0 ? 1 : Math.max(8, Math.ceil(Math.PI * 2 * radius / terrainStep));
    for (let index = 0; index < candidateCount; index += 1) {
      const angle = candidateCount === 1 ? 0 : index / candidateCount * Math.PI * 2;
      const x = clamp(
        requestedX + Math.cos(angle) * radius,
        bounds.minX + PLAYER_RADIUS,
        bounds.maxX - PLAYER_RADIUS
      );
      const z = clamp(
        requestedZ + Math.sin(angle) * radius,
        bounds.minZ + PLAYER_RADIUS,
        bounds.maxZ - PLAYER_RADIUS
      );
      if (isNearWater(map, x, z, PLAYER_RADIUS + 0.2)) continue;
      if (terrainSlopeDegrees(map, x, z) > 35) continue;
      if (obstacles.some((obstacle) => {
        const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
        const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
        return Math.hypot(x - closestX, z - closestZ) < PLAYER_RADIUS + 0.1;
      })) continue;
      return [x, z];
    }
  }
  return [requestedX, requestedZ];
}

function buildSystemPrompt(map: EditableMap, assets: readonly MapAsset[], finalPass: boolean): string {
  const bounds = getMapBounds(map);
  const limits = planLimits(bounds);
  const assetLibrary = assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    description: asset.prompt
  }));
  return [
    '你是 WorldForge 的地图规划器。只规划空间内容，不决定最终渲染风格。',
    '你可以使用地形笔刷、创建湖泊/河流、放置已有资产，以及设置出生点；不得删除或修改已有物体，不得编造资产 ID。',
    '根据田园、峡谷、海岛等场景词主动推导一个简单、合理的空间构图，不要求用户提供坐标。',
    finalPass
      ? '这是最终规划轮次。assetRequests 必须为空；必须至少生成一项地形、物体摆放或出生点操作，使用现有资产完成地图，无法使用的内容直接省略。'
      : `若场景需要的可复用物体在已有资产中找不到，在 assetRequests 中请求生成，最多 ${limits.assetRequestCount} 项；请求资产时不要提前编造其 assetId。`,
    `地图范围：X ${bounds.minX} 到 ${bounds.maxX}，Z ${bounds.minZ} 到 ${bounds.maxZ}，最大高度 ${bounds.maxY}。`,
    `本地图配额：terrain 最多 ${limits.terrainBrushCount} 笔、笔刷半径最多 ${limits.brushRadiusMax}、waters 最多 ${limits.waterCount} 个、最终物体总数最多 ${limits.objectCount} 个。`,
    'terrain 每项格式：{"mode":"raise|lower|flatten","x":0,"z":0,"size":2,"strength":0.4,"targetHeight":0}。',
    'waters 每项格式：{"type":"lake|river","name":"名称","level":0.2,"width":1.2,"points":[{"x":0,"z":0}]}。湖泊 points 是至少 3 点的边界；河流 points 是至少 2 点的中心线且 width 生效。需要时同时用 terrain 压低水域地形。',
    'objects 只用于少量独立物体，格式：{"assetId":"已有ID","name":"名称","x":0,"z":0,"rotationYDeg":0,"scale":1}。',
    '大量植被、岩石等重复物体必须优先使用 scatters，让代码生成坐标。scatters 每项格式：{"assetIds":["已有ID"],"region":{"kind":"circle","x":0,"z":0,"r":20},"density":0.04,"avoidWater":1,"maxSlope":30,"minSpacing":2,"scaleRange":[0.8,1.2],"seed":7}。',
    '若用户写了雾、光照、素描等氛围词，只放入 renderPromptSuggestions，不要用它改变地图。',
    '只返回一个 JSON 对象，不要 Markdown：',
    '{"summary":"简短摘要","assetRequests":[{"name":"资产名","prompt":"独立低多边形物体描述，无地面和背景"}],"terrain":[],"waters":[],"objects":[],"scatters":[],"spawn":null,"renderPromptSuggestions":[]}',
    `已有资产：${JSON.stringify(assetLibrary)}`
  ].join('\n');
}

function parseJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_map_ai_json');
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_map_ai_json');
  }
}

function normalizeAssetRequests(value: unknown, maxCount: number): AssetGenerationRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: AssetGenerationRequest[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const input = item as Record<string, unknown>;
    const name = cleanText(input.name, '', 42);
    const prompt = cleanText(input.prompt, '', 500);
    const key = `${name}\n${prompt}`;
    if (!name || !prompt || seen.has(key)) continue;
    seen.add(key);
    requests.push({ name, prompt });
    if (requests.length === maxCount) break;
  }
  return requests;
}

function hasSpatialOperations(suggestion: MapAiSuggestion): boolean {
  return suggestion.operations.some((operation) =>
    operation.type === 'terrain.brush'
    || operation.type === 'terrain.set'
    || operation.type === 'water.add'
    || operation.type === 'object.add'
    || operation.type === 'reference.set'
  );
}

function normalizeTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function requiredNumber(value: unknown, error: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(error);
  return number;
}

function optionalNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
