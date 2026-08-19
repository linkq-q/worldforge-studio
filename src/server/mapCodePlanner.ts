import vm from 'node:vm';
import {
  createId,
  getMapBounds,
  normalizeMapRoom,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type MapRoom,
  type MapRoomOpening,
  type RoomWall
} from '../shared/map';
import { normalizeAssetTags } from '../shared/mapAssetMetadata';
import { normalizeMapAiMaxNewAssets, normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import { calculateModelVisualBounds } from '../shared/modelBounds';
import { indoorAssetTargetCount } from '../shared/indoorScenePlanning';
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
const CODE_ASSET_ORIENTATION_PROMPT = 'Coordinate contract: local Y+ is up, local Z+ is the front, entrance, or forward direction, and local X+ is right. Put doors, facades, openings, windshields, noses, seats, and other recognizable front details toward local Z+. For a modular repeated element, explicitly choose the long axis: side-by-side modules span local X with depth/front on local Z; traversal modules span local Z. Keep the model centered at its origin.';

type Point2 = [number, number];
type Point3 = [number, number, number];

export interface MapCodePlannerOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
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
  roomOpeningId?: string;
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
  scale?: number | Point3;
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
  roomOpeningId?: string;
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
}

interface CodeAssetRequirementInput {
  key: string;
  name: string;
  prompt: string;
  tags?: string[];
  variants?: number;
  dimensions?: Point3;
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
  options.onProgress?.({
    phase: 'planning',
    label: map.sceneMode === 'indoor'
      ? 'AI 正在编写程序化室内规划代码'
      : 'AI 正在编写程序化环境规划代码'
  });
  const requestedAssetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const indoorTarget = map.sceneMode === 'indoor'
    ? indoorAssetTargetCount(map, requestedAssetRange.min, requestedAssetRange.max)
    : requestedAssetRange.min;
  const assetRange = {
    min: Math.min(requestedAssetRange.max, Math.max(requestedAssetRange.min, indoorTarget)),
    max: requestedAssetRange.max
  };
  const maxNewAssets = assetRange.max;
  const reusableIds = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  const reusableAssets = options.reuseExistingAssets === true
    ? assets.filter((asset) => (
        (!reusableIds || reusableIds.has(asset.id))
        && asset.libraryMetadata?.analysisStatus !== 'pending'
        && asset.libraryMetadata?.enabled !== false
      ))
    : [];
  const systemPrompt = buildMapCodePlannerSystemPrompt(map, reusableAssets, assetRange.min, maxNewAssets);
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
  let execution = await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, reusableAssets, maxNewAssets, options);
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
    execution = await discoverMapCodeWithRepairs(code, userPrompt, systemPrompt, map, reusableAssets, maxNewAssets, options);
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
  options.onProgress?.({
    phase: 'replanning',
    label: map.sceneMode === 'indoor'
      ? '使用新资产重放程序化室内规划'
      : '使用新资产重放程序化环境规划'
  });
  const final = runMapCodePlan(code, map, [...reusableAssets, ...generatedAssets], {
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
  const indoorRoom = map.sceneMode === 'indoor' && map.room
    ? normalizeMapRoom(map.room, map.box.size, map.room)
    : null;
  const roomOpenings = indoorRoom ? [...indoorRoom.openings] : [];
  const mode = options.mode ?? 'final';
  const maxNewAssets = options.maxNewAssets ?? normalizeMapAiMaxNewAssets(undefined);
  const random = mulberry32(map.seed);
  const record = (name: string) => usedFunctions.add(name);
  const api = Object.freeze({
    TAU: Math.PI * 2,
    PHI: (1 + Math.sqrt(5)) / 2,
    seed: map.seed,
    bounds: Object.freeze(getMapBounds(map)),
    room: indoorRoom ? Object.freeze({
      position: Object.freeze([...indoorRoom.position]),
      size: Object.freeze([...indoorRoom.size]),
      wallThickness: indoorRoom.wallThickness,
      openings: Object.freeze(indoorRoom.openings.map((opening) => Object.freeze({ ...opening })))
    }) : null,
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
        room.position[1] + room.size[1] - room.wallThickness - Math.max(0, finite(objectHeight)) - Math.max(0, finite(drop)),
        point[1]
      ];
    },
    opening(input: RoomOpeningInput): string {
      record('opening');
      const room = requireIndoorRoom(indoorRoom);
      if (!input || typeof input !== 'object') throw new Error('invalid_map_code_room_opening');
      const id = cleanText(input.id, 80);
      if (roomOpenings.some((opening) => opening.id === id)) return id;
      const opening = normalizeMapRoom({
        ...room,
        openings: [...roomOpenings, {
          id,
          kind: input.kind === 'window' ? 'window' : 'door',
          wall: normalizeRoomWall(input.wall),
          offset: input.offset ?? 0,
          bottom: input.bottom ?? (input.kind === 'window' ? 1 : 0),
          width: input.width ?? (input.kind === 'window' ? 1.8 : 1.2),
          height: input.height ?? (input.kind === 'window' ? 1.2 : 2.1)
        }]
      }, map.box.size, room).openings.at(-1);
      if (!opening) throw new Error('invalid_map_code_room_opening');
      roomOpenings.push(opening);
      return opening.id;
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
      const dimensions = input.dimensions === undefined ? undefined : point3(input.dimensions);
      const fitted = fittedPlacementTransform(assetId ? assetById.get(assetId) : undefined, input.scale ?? 1, dimensions);
      placements.push({
        assetId,
        name: cleanText(input.name ?? assetById.get(assetId ?? '')?.name ?? '程序化物体', 80),
        position,
        rotationY: placementRotation(input.facing, position, input.rotationY),
        scale: fitted.scale,
        size: dimensions ?? point3(input.size ?? [1, 1, 1]),
        heightMode: terrain ? 'terrain' : 'fixed',
        ...(roomOpeningId ? { roomOpeningId } : {})
      });
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
      const spanAxis = input.spanAxis === 'z' ? 'z' : 'x';
      const spanIndex = spanAxis === 'x' ? 0 : 2;
      const gapRatio = clampFinite(input.gapRatio ?? 0, 0, 0.25);
      const fittedLength = distance * (1 - gapRatio);
      const dimensions = point3(input.dimensions ?? input.size ?? [1, 1, 1]);
      if (dimensions[spanIndex] <= 0.000001) throw new Error('invalid_map_code_connection_dimensions');
      const center: Point2 = codePoint(
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2
      );
      const terrain = map.sceneMode !== 'indoor' && input.terrain !== false;
      const position = placementPosition(center, map, terrain);
      const lineRotation = spanAxis === 'x'
        ? Math.atan2(-direction[1], direction[0])
        : yawFromDirection(direction);
      const requestedAssetId = typeof input.assetId === 'string' && input.assetId.trim() ? input.assetId.trim() : null;
      let assetId = requestedAssetId;
      if (assetId && !assetById.has(assetId) && !(mode === 'discovery' && isCodeAssetPlaceholder(assetId))) {
        assetId = resolveMapCodeAssetId(input.name, assets);
        if (!assetId) unresolvedAssetIds.add(requestedAssetId!);
      }
      const targetSize: Point3 = [...dimensions];
      targetSize[spanIndex] = fittedLength;
      const scale = scale3(input.scale ?? 1);
      const boundAsset = assetId ? assetById.get(assetId) : undefined;
      if (boundAsset) {
        const bounds = calculateModelVisualBounds(boundAsset.modelJson);
        const actualDimensions: Point3 = [
          Math.max(0.000001, bounds.max[0] - bounds.min[0]),
          Math.max(0.000001, bounds.max[1] - bounds.min[1]),
          Math.max(0.000001, bounds.max[2] - bounds.min[2])
        ];
        for (let axis = 0; axis < 3; axis += 1) scale[axis] /= actualDimensions[axis];
      }
      placements.push({
        assetId,
        name: cleanText(input.name ?? assetById.get(assetId ?? '')?.name ?? 'procedural-connection', 80),
        position,
        rotationY: input.facing === undefined
          ? lineRotation
          : placementRotation(input.facing, position, lineRotation),
        scale,
        size: targetSize,
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

  const placementOperations = placements.map((placement): MapOperation => ({
    type: 'object.add',
    object: {
      id: createId('obj-code'),
      name: placement.name,
      assetId: placement.assetId,
      heightMode: placement.heightMode,
      ...(placement.roomOpeningId ? { roomOpeningId: placement.roomOpeningId } : {}),
      transform: {
        position: placement.position,
        rotation: [0, placement.rotationY, 0],
        scale: placement.scale,
        size: placement.size
      }
    }
  }));
  const operations: MapOperation[] = indoorRoom
    ? [{ type: 'room.set', room: { ...indoorRoom, openings: roomOpenings } }, ...placementOperations]
    : placementOperations;
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
  if (map.sceneMode === 'indoor') {
    return buildIndoorMapCodePlannerSystemPrompt(map, assets, minNewAssets, maxNewAssets);
  }
  const bounds = getMapBounds(map);
  const assetCatalog = assets.length > 0
    ? assets.map((asset) => `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}`).join('\n')
    : '- No reusable assets are available. Declare the assets you need with api.requireAsset.';
  return `You are WorldForge Studio's procedural environment planner.

## Output contract
Return only one synchronous JavaScript function: function plan(api) { ... }.
Do not return markdown, explanations, JSON, imports, async code, promises, eval, Function, network, files, timers, or global state.
Use api. on every WorldForge call. The code must call api.place or api.placeBetween at least once.
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
Build a readable composition, not a random pile: establish one or two primary paths/landmarks, add secondary structure, then add sparse accents.
Use big-medium-small hierarchy: a few large anchors, a moderate number of supporting pieces, and restrained small details.
Keep key routes clear, respect the map bounds, avoid filling every cell, and keep repeated elements deterministic from api.seed.
Use proxy placements without assetId only for abstract markers or when no visual asset is appropriate; visible prompt-specific content should use real assets.

## API quick reference
Constants: api.TAU, api.PHI, api.seed, api.bounds.
Scalar math: api.clamp(value,min,max), api.lerp(a,b,t), api.remap(value,inMin,inMax,outMin,outMax), api.smoothstep(min,max,value), api.random(min?,max?).
Transforms: api.rotate2D(point,angle,center?), api.distance2D(a,b), api.tangentYaw(tangent), api.faceYaw(from,to).
Curves: api.linePoint(t,a,b) -> [x,z]; api.bezierPoint(t,p0,p1,p2,p3) -> {point,tangent,normal}; api.sampleBezier(...) -> point arrays; api.sampleBezierFrames(...) -> frame objects with point,tangent,normal; api.sampleBezierFramesBySpacing(...,spacing,gapRatio?) -> approximately even arc-length frames. frame.normal is the normalized left-side normal [-tangentZ,tangentX] as t increases.
Fields: api.noise2D(x,z,scale?,seed?) -> [-1,1]; api.fbm2D(x,z,{scale?,octaves?,lacunarity?,gain?,seed?}) -> [-1,1].
Layouts: api.circlePoint(index,count,radius,center?) -> [x,z]; api.gridPoints({center?,columns,rows,spacing}) -> points; api.poissonDisk({bounds?,minDistance,maxPoints?,attempts?,seed?}) -> points.
Assets: api.requireAsset({key,name,prompt,tags?,variants?,dimensions:[width,height,depth]?}) -> key; api.asset(key,index?) -> generated assetId.
Output: api.place({assetId?,name?,position:[x,z]|[x,y,z],rotationY?,facing?,scale?,size?,terrain?}).
facing may be a direction [dx,dz], {direction:[dx,dz]}, {tangent:[dx,dz]}, {normal:[nx,nz]}, {target:[x,z]}, or any of those with offsetY; it overrides rotationY when present.
For long connected scenery, prefer api.placeBetween({assetId?,name?,start:[x,z],end:[x,z],dimensions:[width,height,depth],spanAxis:'x'|'z',facing?,scale?,terrain?}). It places the model at the midpoint, aligns its declared long axis to the line from start to end, and fits only that axis to the endpoint distance. Use spanAxis:'x' for side-by-side wall, railing, corridor, bridge, or facade modules and spanAxis:'z' for traversal modules. Omit facing unless a deliberate front override is required; ordinary line alignment is automatic, and facing can still override it.

## Scene pattern guide
- Repeated modular elements along a curve: use sampleBezierFramesBySpacing with the module's approximate span and the default 0.08 gap ratio; this uses arc length instead of parameter t and avoids bunching or large endpoint gaps.
- Connected modular elements between computed points: use placeBetween rather than manually calculating a midpoint plus rotationY. Give the asset a dimensions contract in requireAsset and pass the same dimensions to placeBetween.
- For a continuous connected run, use one asset family and normally variants:1. Do not alternate visibly different variants along the same uninterrupted line. The ordered start->end direction determines which side local Z+ faces when spanAxis:'x'.
- Elements whose long axis follows travel: use facing:{tangent:frame.tangent}; elements whose front faces across the curve: use facing:{normal:frame.normal}; add offsetY:api.TAU / 2 for the opposite side. If an interior anchor is known, facing:{target:interiorPoint} is the safest inward-facing choice.
- Organic scatter: poissonDisk plus noise2D/fbm2D density filtering; enforce minDistance.
- Farms, buildings, stalls, streets: gridPoints with an explicit center and spacing.
- Plazas, rings, lamps, portals: circlePoint with deterministic index/count.
- Arena stands, gates, shops, and facades around a center: faceYaw(point, center) so the front faces inward; use + api.TAU / 2 for outward-facing backs.
- Fades and zones: remap/smoothstep/clamp, not abrupt magic thresholds.
- Variation: api.random(min,max), never Math.random and never an unseeded random source.

## Asset rules
The sum of all requireAsset variants must be between ${minNewAssets} and ${maxNewAssets}.
When the minimum is greater than zero, declare and place that many prompt-specific generated assets even if reusable assets exist.
Use api.asset(key,index) for generated assets; do not invent asset IDs and do not modify catalog IDs.
Each asset prompt must describe a standalone reusable object with no ground, scene, text, or background unless the object itself requires it.
For any modular asset repeated along a line or curve, explicitly state its span axis, connection axis, and canonical dimensions: side-by-side modules should span local X with depth/front on local Z; traversal modules should span local Z. Never leave the long axis or dimensions implicit.
Append this orientation instruction to every generated asset prompt: "Coordinate contract: Y+ is up, Z+ is the front/entrance/forward direction, X+ is right; place doors, facades, openings, windshields, or noses toward local Z+ and keep the model centered at its origin."

## Correct patterns
Road curve:
const road = api.requireAsset({key:'road',name:'Neon road segment',prompt:'Standalone low-poly wet neon road segment, no scene or background',tags:['road','neon'],variants:2});
const curve = api.sampleBezier([-36,0],[-12,18],[12,-18],[36,0],12);
for (let i = 0; i < curve.length; i += 1) api.place({assetId:api.asset(road,i),position:curve[i],facing:{direction:i < curve.length - 1 ? [curve[i + 1][0]-curve[i][0],curve[i + 1][1]-curve[i][1]] : [1,0]}});

Natural scatter:
const tree = api.requireAsset({key:'tree',name:'Luminous street tree',prompt:'Standalone stylized luminous cyberpunk street tree, no ground or background',tags:['tree','neon'],variants:2});
const points = api.poissonDisk({minDistance:6,maxPoints:24,attempts:20,seed:api.seed});
for (let i = 0; i < points.length; i += 1) { const p = points[i]; if (api.fbm2D(p.x,p.z,{scale:0.08}) > -0.1) api.place({assetId:api.asset(tree,i),position:[p.x,p.z]}); }

Inward arena ring:
const center = [0,0];
const gate = api.requireAsset({key:'gate',name:'Arena gate',prompt:'Standalone arena gate with facade and entrance, no ground or background',tags:['arena','gate'],variants:1});
for (let i = 0; i < 8; i += 1) { const point = api.circlePoint(i,8,28,center); api.place({assetId:api.asset(gate,0),position:point,facing:{target:center}}); }

Curved wall with a consistent facade:
const wall = api.requireAsset({key:'wall',name:'Garden wall segment',prompt:'Standalone modular garden wall segment with decorative facade toward local Z+, seamless ends, no ground or background; span axis local X; canonical dimensions 6 wide x 3 high x 0.5 deep',dimensions:[6,3,0.5],tags:['wall','garden'],variants:1});
const frames = api.sampleBezierFramesBySpacing([-32,-12],[-18,24],[18,-24],[32,12],6,0.08);
for (let i = 0; i < frames.length - 1; i += 1) api.placeBetween({assetId:api.asset(wall,0),start:frames[i].point,end:frames[i + 1].point,dimensions:[6,3,0.5],spanAxis:'x'});

## Final self-check before returning
1. Exactly one function named plan and no markdown.
2. At least one api.place or api.placeBetween; all loops have bounded counts.
3. All positions are inside the stated bounds or intentionally clamped.
4. No undefined point, invalid array index, direct array arithmetic, division by zero, invented asset ID, or unbounded placement loop.
5. Generated assets are declared with requireAsset and bound only through api.asset.

Reusable asset catalog:
${assetCatalog}`;
}

function buildIndoorMapCodePlannerSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  minNewAssets: number,
  maxNewAssets: number
): string {
  const room = requireIndoorRoom(map.room ? normalizeMapRoom(map.room, map.box.size, map.room) : null);
  const assetCatalog = assets.length > 0
    ? assets.map((asset) => `- ${asset.id}: ${asset.name}; tags=${asset.tags?.join(',') || 'none'}`).join('\n')
    : '- No reusable assets are available. Declare the indoor assets you need with api.requireAsset.';
  return `You are WorldForge Studio's procedural indoor-scene planner.

## Output contract
Return only one synchronous JavaScript function: function plan(api) { ... }.
Do not return markdown, explanations, JSON, imports, async code, promises, eval, Function, network, files, timers, or global state.
Use api. on every WorldForge call. The code must call api.place or api.placeBetween at least once.
Allowed JavaScript: const/let, numbers, strings, arrays, plain objects, local helper functions, for, for...of, while, if/else, and Math scalar functions.

## Indoor structural contract
This is a standalone indoor map. The existing parameterized room is structural map data, not an asset.
Room floor-center=${JSON.stringify(room.position)}, size=[width=${room.size[0]},height=${room.size[1]},depth=${room.size[2]}], wallThickness=${room.wallThickness}.
Existing openings=${JSON.stringify(room.openings)}.
Do not generate a whole room, floor, ceiling, wall shell, terrain, outdoor ground, sky, road, river, forest, garden, or building exterior.
Do not use terrain-following placement. Indoor objects use fixed Y positions relative to the room floor.
The room shell automatically cuts wall segments around openings. Doors and windows are separate assets linked to declared openings.

## Indoor coordinate API
api.room is the current room data.
api.roomPoint(localX,localZ,height?) returns [x,y,z] inside the room. localX/localZ are offsets from room center; height is above the room floor. Use this for floor furniture and functional groups.
api.wallFrame(wall,offset?,bottom?,inset?) returns {point,inward,outward,tangent}. wall is north|south|east|west; offset runs along the wall; bottom is height above the floor. Place wall-mounted objects at frame.point with facing:{direction:frame.inward} so local Z+ faces into the room.
api.ceilingPoint(localX,localZ,objectHeight?,drop?) returns a fixed [x,y,z] whose object top sits below the ceiling. Pass the declared object height.
api.opening({id,kind:'door'|'window',wall,offset?,bottom?,width?,height?}) declares a parameterized opening and returns its ID. Then api.place({assetId,roomOpeningId:id,dimensions:[w,h,d]}) binds the generated model to that opening; position and rotation are automatic.
Every generated point supports both point[0]/point[1] and point.x/point.z where applicable. Never add or subtract arrays directly.

## Placement and size contract
Every generated model uses local Y+ up, local Z+ front/forward, and local X+ right.
api.place({assetId?,name?,position?,rotationY?,facing?,scale?,size?,dimensions?,roomOpeningId?}) places one indoor object. dimensions:[width,height,depth] is the intended world size and is fitted against the generated model's actual visual bounds after generation.
facing may be [dx,dz], {direction}, {target}, {tangent}, or {normal}; it overrides rotationY.
api.placeBetween remains available for genuinely connected indoor runs such as counters, shelves, railings, partitions, or bench rows.

## Indoor composition philosophy
Plan in two conceptual passes inside this one program:
1. Establish entrance/daylight fixtures, primary activity groups, service/storage furniture, and one readable focal relationship.
2. Add restrained lighting and decor only after the room functions and circulation are clear.
Build functional groups rather than scattering unrelated props. Examples include desk+chair facing a board, dining chairs around tables, sofas around a focal table, checkout counter plus queue clearance, or workstations aligned to a shared screen.
Keep a continuous route at least 0.8 world units wide from every door into the primary activity area. Do not place furniture in door clearance zones. Keep furniture inside the room shell.
Use the room area: repeated furniture counts should scale with available floor area, but preserve aisles and negative space. Avoid piling everything at the center or lining every wall.
Wall-mounted assets must use wallFrame. Ceiling-mounted assets must use ceilingPoint. Floor furniture must use roomPoint with height 0 unless its support relationship requires a raised position.

## API quick reference
Constants: api.TAU, api.PHI, api.seed, api.bounds, api.room.
Scalar math: api.clamp, api.lerp, api.remap, api.smoothstep, api.random.
Transforms/layouts: api.rotate2D, api.distance2D, api.faceYaw, api.tangentYaw, api.gridPoints, api.circlePoint, api.linePoint.
Indoor: api.roomPoint, api.wallFrame, api.ceilingPoint, api.opening.
Assets: api.requireAsset({key,name,prompt,tags?,variants?,dimensions:[width,height,depth]?}); api.asset(key,index?).
Output: api.place(...); api.placeBetween(...).

## Asset rules
The sum of all requireAsset variants must be between ${minNewAssets} and ${maxNewAssets}.
Use enough useful indoor asset families to express the requested room; do not spend the budget on tiny decorative variants before primary furniture exists.
Each generated asset is one standalone reusable object with no room, floor, wall, background, scene, or unrelated props.
Furniture prompts must state canonical dimensions and the local Z+ front. Chairs should face local Z+; desks/counters should put their user-facing front toward local Z+; wall art/boards should put the visible face toward local Z+.
Door/window assets must include the English tag door or window. Window prompts must request a visible transparent glass pane tagged base:glass, while base:glass must not be put in asset tags.
Do not request wall, floor, ceiling, or whole-room assets.

## Correct indoor patterns
Functional desk group:
const desk = api.requireAsset({key:'desk',name:'Classroom desk',prompt:'Standalone classroom desk, student-facing side toward local Z+, canonical dimensions 1.2 wide x 0.75 high x 0.6 deep',dimensions:[1.2,0.75,0.6],tags:['desk','furniture'],variants:1});
const chair = api.requireAsset({key:'chair',name:'Classroom chair',prompt:'Standalone classroom chair facing local Z+, canonical dimensions 0.5 wide x 0.85 high x 0.5 deep',dimensions:[0.5,0.85,0.5],tags:['chair','furniture'],variants:1});
for (let row = 0; row < 3; row += 1) for (let column = 0; column < 4; column += 1) {
  const x = (column - 1.5) * 1.8; const z = -1 + row * 1.8;
  api.place({assetId:api.asset(desk,0),position:api.roomPoint(x,z,0),dimensions:[1.2,0.75,0.6],facing:{direction:[0,-1]}});
  api.place({assetId:api.asset(chair,0),position:api.roomPoint(x,z+0.72,0),dimensions:[0.5,0.85,0.5],facing:{direction:[0,-1]}});
}

Wall-mounted focal object:
const board = api.requireAsset({key:'board',name:'Wall board',prompt:'Standalone wall-mounted board with visible face toward local Z+, canonical dimensions 3 wide x 1.4 high x 0.12 deep',dimensions:[3,1.4,0.12],tags:['board','wall-mounted'],variants:1});
const boardFrame = api.wallFrame('north',0,1.1,0.02);
api.place({assetId:api.asset(board,0),position:boardFrame.point,dimensions:[3,1.4,0.12],facing:{direction:boardFrame.inward}});

Door opening and bound door asset:
const doorOpening = api.opening({id:'door-main',kind:'door',wall:'south',offset:0,width:1.2,height:2.1});
const door = api.requireAsset({key:'door',name:'Main door',prompt:'Standalone interior door facing local Z+, canonical dimensions 1.2 wide x 2.1 high x 0.12 deep',dimensions:[1.2,2.1,0.12],tags:['door'],variants:1});
api.place({assetId:api.asset(door,0),roomOpeningId:doorOpening,dimensions:[1.2,2.1,0.12]});

## Final self-check
1. Exactly one function named plan and no markdown.
2. At least one api.place or api.placeBetween; all loops are bounded.
3. No terrain/outdoor scenery and no whole-room asset.
4. Primary furniture and functional relationships exist before decor.
5. Door routes remain at least 0.8 units wide; wall and ceiling objects use the indoor APIs.
6. Generated assets use requireAsset/api.asset and include dimensions.

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
          content: map.sceneMode === 'indoor'
            ? `The indoor program failed during its sandboxed discovery run with this error:\n${executionError}\n\nReturn corrected JavaScript only. Preserve the requested room design. Check every array index, loop endpoint, division, vector component, room wall name, opening ID, and optional argument. Use api.roomPoint for floor furniture, api.wallFrame for wall-mounted objects, api.ceilingPoint for ceiling-mounted objects, and api.opening plus roomOpeningId for doors/windows. Never use terrain or outdoor placement. Ensure every numeric value passed to the API is finite.`
            : `The program failed during its sandboxed discovery run with this error:\n${executionError}\n\nReturn corrected JavaScript only. Preserve the requested design. Check every array index, loop endpoint, division, vector component, and optional argument. JavaScript arrays cannot be added or subtracted directly; calculate x/z components separately. bezierPoint returns {point,tangent,normal}, sampleBezier returns point arrays, and sampleBezierFrames returns frame objects. Use facing:{tangent:frame.tangent} for along-curve objects and facing:{normal:frame.normal} for curve-side facades or walls. Ensure every numeric value passed to the API is finite.`
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
    variants: boundedCount(input.variants ?? 1, 1, 8),
    ...(input.dimensions === undefined ? {} : { dimensions: point3(input.dimensions) })
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
    && JSON.stringify(left.dimensions) === JSON.stringify(right.dimensions);
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

function requireIndoorRoom(room: MapRoom | null): MapRoom {
  if (!room) throw new Error('map_code_indoor_api_requires_room');
  return room;
}

function normalizeRoomWall(value: unknown): RoomWall {
  if (value === 'north' || value === 'south' || value === 'east' || value === 'west') return value;
  throw new Error('invalid_map_code_room_wall');
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
  dimensions?: Point3
): { scale: Point3 } {
  const scale = scale3(rawScale);
  if (!asset || !dimensions) return { scale };
  const bounds = calculateModelVisualBounds(asset.modelJson);
  const actualDimensions: Point3 = [
    Math.max(0.000001, bounds.max[0] - bounds.min[0]),
    Math.max(0.000001, bounds.max[1] - bounds.min[1]),
    Math.max(0.000001, bounds.max[2] - bounds.min[2])
  ];
  for (let axis = 0; axis < 3; axis += 1) scale[axis] /= actualDimensions[axis];
  return { scale };
}

function yawFromDirection(direction: Point2): number {
  return Math.atan2(finite(direction[0]), finite(direction[1]));
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
