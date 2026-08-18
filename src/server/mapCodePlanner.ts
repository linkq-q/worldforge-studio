import vm from 'node:vm';
import { createId, getMapBounds, sampleTerrainHeight, type EditableMap, type MapAsset } from '../shared/map';
import { normalizeAssetTags } from '../shared/mapAssetMetadata';
import { normalizeMapAiMaxNewAssets, normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import type { AgentProgressEvent, ChatProvider } from '../shared/protocol';
import type { MapAiSuggestion, MapOperation } from '../shared/mapOperations';
import { runAssetGenerationPool, type AssetTaskReporter } from './assetGenerationPool';
import type { AssetGenerationRequest } from './mapAi';
import { validateMapSuggestion } from './mapSuggestionValidation';
import { llmChat } from './modelApi';

const MAX_CODE_LENGTH = 40_000;
const MAX_PLACEMENTS = 2_000;
const MAX_POINT_RESULTS = 512;
const EXECUTION_TIMEOUT_MS = 250;

type Point2 = [number, number];
type Point3 = [number, number, number];

export interface MapCodePlannerOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  minNewAssets?: number;
  maxNewAssets?: number;
  onProgress?: (event: AgentProgressEvent) => void;
  createAsset?: (request: AssetGenerationRequest, report: AssetTaskReporter) => Promise<MapAsset>;
}

export interface MapCodePlanMetadata {
  code: string;
  placementCount: number;
  functions: string[];
}

interface PlacementInput {
  assetId?: string | null;
  name?: string;
  position: Point2 | Point3 | { x: number; y?: number; z: number } | { point: Point2 | Point3 };
  rotationY?: number;
  scale?: number | Point3;
  size?: Point3;
  terrain?: boolean;
}

interface PlacementIntent {
  assetId: string | null;
  name: string;
  position: Point3;
  rotationY: number;
  scale: Point3;
  size: Point3;
  heightMode: 'terrain' | 'fixed';
}

export interface CodeAssetRequirement {
  key: string;
  name: string;
  prompt: string;
  tags: string[];
  variants: number;
}

interface CodeAssetRequirementInput {
  key: string;
  name: string;
  prompt: string;
  tags?: string[];
  variants?: number;
}

interface CodeExecutionOptions {
  mode?: 'discovery' | 'final';
  assetBindings?: ReadonlyMap<string, readonly MapAsset[]>;
  maxNewAssets?: number;
}

interface CodeExecutionResult {
  suggestion: MapAiSuggestion;
  requirements: CodeAssetRequirement[];
}

export async function generateMapCodeSuggestion(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapCodePlannerOptions = {}
): Promise<MapAiSuggestion> {
  options.onProgress?.({ phase: 'planning', label: 'AI 正在编写程序化环境规划代码' });
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const maxNewAssets = assetRange.max;
  const systemPrompt = buildMapCodePlannerSystemPrompt(map, assets, assetRange.min, maxNewAssets);
  const userPrompt = prompt.trim().slice(0, 1_200);
  let code = extractCode(await llmChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    apiBase: options.apiBase,
    provider: options.provider ?? 'gpt',
    temperature: 0.25,
    maxTokens: 6_000,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  }));
  let execution = await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, assets, maxNewAssets, options);
  code = execution.code;
  let discovery = execution.discovery;
  const requestedAssetCount = () => discovery.requirements.reduce((total, requirement) => total + requirement.variants, 0);
  if (requestedAssetCount() < assetRange.min) {
    options.onProgress?.({
      phase: 'replanning',
      label: `Code 规划正在补足至少 ${assetRange.min} 个新资产`
    });
    code = extractCode(await llmChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: code },
      {
        role: 'user',
        content: `This program is valid but declares only ${requestedAssetCount()} new assets. Revise it to declare and place at least ${assetRange.min} and at most ${maxNewAssets} prompt-specific generated assets through api.requireAsset and api.asset. Return corrected JavaScript only.`
      }
    ], {
      apiBase: options.apiBase,
      provider: options.provider ?? 'gpt',
      temperature: 0.15,
      maxTokens: 6_000,
      fetchImpl: options.fetchImpl,
      signal: options.signal
    }));
    execution = await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, assets, maxNewAssets, options);
    code = execution.code;
    discovery = execution.discovery;
    if (requestedAssetCount() < assetRange.min) throw new Error('map_code_asset_minimum_not_met');
  }
  if (discovery.requirements.length === 0) {
    options.onProgress?.({ phase: 'complete', label: 'Code 规划已完成，未请求新资产' });
    return discovery.suggestion;
  }
  if (!options.createAsset) throw new Error('map_code_asset_generation_unavailable');

  const tasks = discovery.requirements.flatMap((requirement) => (
    Array.from({ length: requirement.variants }, (_, variantIndex) => ({
      key: requirement.key,
      name: requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
      request: {
        name: requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name,
        prompt: requirement.variants > 1
          ? `${requirement.prompt}\nCreate variation ${variantIndex + 1} of ${requirement.variants}; preserve the same reusable asset family while varying silhouette and details.`
          : requirement.prompt,
        tags: requirement.tags,
        mode: map.assetGenerationMode
      } satisfies AssetGenerationRequest
    }))
  ));
  options.onProgress?.({
    phase: 'checking-assets',
    label: `Code 规划请求生成 ${tasks.length} 个新资产`,
    current: 0,
    total: tasks.length
  });
  const generatedAssets = await runAssetGenerationPool(
    tasks,
    (task, _index, report) => options.createAsset!(task.request, report),
    { signal: options.signal, onProgress: options.onProgress }
  );
  const bindings = new Map<string, MapAsset[]>();
  tasks.forEach((task, index) => {
    const family = bindings.get(task.key) ?? [];
    family.push(generatedAssets[index]);
    bindings.set(task.key, family);
  });
  options.onProgress?.({ phase: 'replanning', label: '使用新资产重放程序化环境规划' });
  const final = runMapCodePlan(code, map, [...assets, ...generatedAssets], {
    mode: 'final',
    assetBindings: bindings,
    maxNewAssets
  }).suggestion;
  options.onProgress?.({ phase: 'complete', label: `Code 规划与 ${generatedAssets.length} 个新资产已完成` });
  return {
    ...final,
    generatedAssets: generatedAssets.map((asset) => ({ id: asset.id, name: asset.name }))
  };
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
  const requirements = new Map<string, CodeAssetRequirement>();
  const unresolvedAssetIds = new Set<string>();
  const usedFunctions = new Set<string>();
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const mode = options.mode ?? 'final';
  const maxNewAssets = options.maxNewAssets ?? normalizeMapAiMaxNewAssets(undefined);
  const random = mulberry32(map.seed);
  const record = (name: string) => usedFunctions.add(name);
  const api = Object.freeze({
    TAU: Math.PI * 2,
    PHI: (1 + Math.sqrt(5)) / 2,
    seed: map.seed,
    bounds: Object.freeze(getMapBounds(map)),
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
    circlePoint(index: number, count: number, radius: number, center: Point2 = [0, 0]): Point2 {
      record('circlePoint');
      const total = boundedCount(count, 1, MAX_POINT_RESULTS);
      const pivot = point2(center);
      const angle = finite(index) * Math.PI * 2 / total;
      const distance = Math.max(0, finite(radius));
      return codePoint(pivot[0] + Math.cos(angle) * distance, pivot[1] + Math.sin(angle) * distance);
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
    requireAsset(input: CodeAssetRequirementInput): string {
      record('requireAsset');
      const requirement = normalizeCodeAssetRequirement(input);
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
      if (mode === 'discovery') return codeAssetPlaceholder(normalizedKey, variantIndex);
      const family = options.assetBindings?.get(normalizedKey);
      const asset = family?.[variantIndex];
      if (!asset) throw new Error(`missing_map_code_asset_binding:${normalizedKey}:${variantIndex}`);
      return asset.id;
    },
    place(input: PlacementInput): void {
      record('place');
      if (placements.length >= MAX_PLACEMENTS) throw new Error('map_code_plan_too_many_placements');
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_placement');
      const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : null;
      let assetId = requestedAssetId;
      if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
        assetId = resolveMapCodeAssetId(input.name, assets);
        if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
      }
      const terrain = input.terrain !== false && placementUsesTerrain(input.position);
      const position = placementPosition(input.position, map, terrain);
      placements.push({
        assetId,
        name: cleanText(input.name ?? assetById.get(assetId ?? '')?.name ?? '程序化物体', 80),
        position,
        rotationY: finite(input.rotationY ?? 0),
        scale: scale3(input.scale ?? 1),
        size: point3(input.size ?? [1, 1, 1]),
        heightMode: terrain ? 'terrain' : 'fixed'
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
  const returned = script.runInContext(context, { timeout: EXECUTION_TIMEOUT_MS });
  if (returned && typeof returned.then === 'function') throw new Error('async_map_code_plan_not_supported');
  if (placements.length === 0) throw new Error('empty_map_code_plan');

  const operations = placements.map((placement): MapOperation => ({
    type: 'object.add',
    object: {
      id: createId('obj-code'),
      name: placement.name,
      assetId: placement.assetId,
      heightMode: placement.heightMode,
      transform: {
        position: placement.position,
        rotation: [0, placement.rotationY, 0],
        scale: placement.scale,
        size: placement.size
      }
    }
  }));
  const suggestion: MapAiSuggestion = {
    summary: `程序化代码规划生成了 ${placements.length} 个摆放意图`,
    operations,
    renderPromptSuggestions: [],
    generatedAssets: [],
    codePlan: {
      code: cleanCode,
      placementCount: placements.length,
      functions: [...usedFunctions].sort()
    }
  };
  const validated = validateMapSuggestion(map, suggestion).suggestion;
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

export function buildMapCodePlannerSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  minNewAssets = 0,
  maxNewAssets = normalizeMapAiMaxNewAssets(undefined)
): string {
  const bounds = getMapBounds(map);
  const assetCatalog = assets.length > 0
    ? assets.map((asset) => `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}`).join('\n')
    : '- No reusable assets are available. Declare the assets you need with api.requireAsset.';
  return `You are the procedural environment planner for WorldForge Studio.
Return JavaScript only, defining exactly one synchronous function: function plan(api) { ... }.
Basic JavaScript control flow is allowed: const/let, arrays, objects, for, for...of, while, if/else and local helper functions.
Do not use async, promises, eval, Function, imports, network, files, timers, randomness outside api.random, or global state.
JavaScript arrays are not vectors: never add or subtract arrays directly. Calculate x/z components separately, keep loop indexes in bounds, guard divisions, and only pass finite numbers to API functions.
Every point returned by the API supports both array access point[0]/point[1] and named access point.x/point.z.

The code must call api.place at least once. Position [x,z] follows terrain automatically; position [x,y,z] is fixed height.
For prompt-specific visible content, declare reusable generated assets first. Use proxy placements without assetId only for abstract editor markers, never as the normal solution.
The sum of all requireAsset variants must be between ${minNewAssets} and ${maxNewAssets}. When the minimum is greater than zero, you must declare and place that many prompt-specific new assets even if reusable assets exist.
Never invent or modify asset IDs. Copy reusable asset IDs exactly from the catalog; otherwise use api.requireAsset and api.asset.
Map bounds: x=${bounds.minX}..${bounds.maxX}, z=${bounds.minZ}..${bounds.maxZ}, seed=${map.seed}.

Available API:
- constants: api.TAU, api.PHI, api.seed, api.bounds
- scalar math: clamp, lerp, remap, smoothstep, random
- vector/layout: distance2D, rotate2D, linePoint, circlePoint, gridPoints, tangentYaw
- curves: bezierPoint(t,p0,p1,p2,p3) -> {point,tangent}; sampleBezier(...) -> points
- environment fields: noise2D(x,z,scale?,seed?), fbm2D(x,z,{scale,octaves,lacunarity,gain,seed})
- distribution: poissonDisk({bounds?,minDistance,maxPoints?,attempts?,seed?})
- assets: requireAsset({key,name,prompt,tags?,variants?}) -> key; asset(key,index?) -> generated assetId
- output: place({assetId?,name?,position:[x,z]|[x,y,z],rotationY?,scale?,size?,terrain?})

Asset example:
const pine = api.requireAsset({ key:'pine', name:'Tall pine', prompt:'Standalone low-poly tall pine tree, no ground or background', tags:['tree','pine'], variants:4 });
for (let i = 0; i < points.length; i += 1) api.place({ assetId: api.asset(pine, i), position: points[i] });

Prefer common environment-design patterns: splines for roads/rivers/edges, noise or fBm for density masks, Poisson disk for natural non-overlapping scatter, grids for settlements, circles/radial layouts for plazas, and smoothstep/remap for transitions. Keep the main paths and landmarks readable; do not fill every free space.

Reusable assets:
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
): Promise<{ code: string; discovery: CodeExecutionResult }> {
  let code = initialCode;
  for (let repairAttempt = 0; repairAttempt <= 2; repairAttempt += 1) {
    try {
      return {
        code,
        discovery: runMapCodePlan(code, map, assets, {
          mode: 'discovery',
          maxNewAssets
        })
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const executionError = mapCodeExecutionErrorDetail(error, code);
      if (repairAttempt === 2) throw new Error(`map_code_execution_failed:${executionError}`);
      options.onProgress?.({
        phase: 'replanning',
        label: `检测到代码数值或边界错误，AI 正在自动修复 ${repairAttempt + 1}/2`,
        detail: executionError
      });
      code = extractCode(await llmChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: code },
        {
          role: 'user',
          content: `The program failed during its sandboxed discovery run with this error:\n${executionError}\n\nReturn corrected JavaScript only. Preserve the requested design. Check every array index, loop endpoint, division, vector component, and optional argument. JavaScript arrays cannot be added or subtracted directly; calculate x/z components separately. bezierPoint returns {point,tangent}, while sampleBezier returns point arrays. Ensure every numeric value passed to the API is finite.`
        }
      ], {
        apiBase: options.apiBase,
        provider: options.provider ?? 'gpt',
        temperature: 0.1,
        maxTokens: 6_000,
        fetchImpl: options.fetchImpl,
        signal: options.signal
      }));
    }
  }
  throw new Error('map_code_execution_failed:missing_discovery_result');
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

function normalizeCodeAssetRequirement(input: CodeAssetRequirementInput): CodeAssetRequirement {
  if (!input || typeof input !== 'object') throw new Error('invalid_map_code_asset_requirement');
  const key = normalizeCodeAssetKey(input.key);
  const name = cleanText(input.name, 42);
  const prompt = cleanText(input.prompt, 500);
  if (!name || !prompt) throw new Error('invalid_map_code_asset_requirement');
  return {
    key,
    name,
    prompt,
    tags: normalizeAssetTags(input.tags) ?? [],
    variants: boundedCount(input.variants ?? 1, 1, 8)
  };
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
    && left.tags.join('\n') === right.tags.join('\n');
}

function codeAssetPlaceholder(key: string, index: number): string {
  return `code-asset://${key}/${index}`;
}

function isCodeAssetPlaceholder(value: string): boolean {
  return value.startsWith('code-asset://');
}

function resolveMapCodeAssetId(name: string | undefined, assets: readonly MapAsset[]): string | null {
  const normalizedName = String(name ?? '').trim().toLowerCase();
  if (!normalizedName) return null;
  const exact = assets.find((asset) => asset.name.trim().toLowerCase() === normalizedName);
  return exact?.id ?? null;
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
    return [x, terrain ? sampleTerrainHeight(map, x, z) : 0, z];
  }
  if (Array.isArray(value) && value.length === 2) {
    const position = point2(value);
    return [position[0], terrain ? sampleTerrainHeight(map, position[0], position[1]) : 0, position[1]];
  }
  throw new Error(`invalid_map_code_position:${describeCodeValue(value)}`);
}

function placementUsesTerrain(value: PlacementInput['position']): boolean {
  if (Array.isArray(value)) return value.length === 2;
  if (!value || typeof value !== 'object') return false;
  if ('point' in value) return placementUsesTerrain(value.point);
  return 'x' in value && 'z' in value && value.y === undefined;
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

function bezierPoint(amount: number, p0: Point2, p1: Point2, p2: Point2, p3: Point2): { point: Point2; tangent: Point2 } {
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
  return { point, tangent };
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
