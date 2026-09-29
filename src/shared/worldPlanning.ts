import type { MapGuide } from './mapGuide';
import { validateEcologyRules, type EcologyRule } from './worldEcology';
import { createWorldSampler, createWorldTerrainContext, validateWorldRecipe,
  type WorldRecipe, type WorldSampler, type WorldTerrainContext } from './worldTerrain';

export interface WorldPlan {
  version: 1;
  id: string;
  revision: number;
  prompt: string;
  recipe: WorldRecipe;
  ecology: EcologyRule[];
  towns: TownIntent[];
  roads: MapGuide[];
}
export interface TownIntent {
  id: string;
  name: string;
  prompt: string;
  center: [number, number];
  radius: number;
  blend: number;
  foundation: number;
  ports: TownPort[];
  terrainMode?: 'platform' | 'conform';
}
export interface TownPort { id: string; guideId: string; position: [number, number]; width: number }
export interface TownTask { worldKey: string; town: TownIntent; seed: number }
export interface TownBuilding {
  id: string; x: number; z: number; width: number; depth: number; height: number; use: string; rotation?: number;
  assetKey?: string; enterable?: boolean;
}
export interface TownPatch { townId: string; worldKey: string; summary: string; streets: MapGuide[]; buildings: TownBuilding[] }
export interface WorldBundle { plan: WorldPlan; patches: TownPatch[] }

export const WORLD_ROAD_SAMPLE_SPACING = 24;
export const WORLD_ROAD_VERTEX_BUDGET = 32768;
export const worldRoadSampleSpacing = (size: number) => Math.min(WORLD_ROAD_SAMPLE_SPACING, size / 250);

type Point = [number, number];
const TOLERANCE = 1e-6;
const MAX_TOWN_SLOPE = 0.65;
const MAX_ROAD_SLOPE = 0.5;
const MAX_BUILDING_CUT_FILL = 1.5;
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function fail(code: string): never { throw new Error(code); }

function record(input: unknown, code: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(code);
  return input as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: string[], code: string): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(code);
}
function text(input: unknown, code: string, max = 96, empty = false): string {
  if (typeof input !== 'string' || input.length > max || (!empty && !input.trim())) fail(code);
  return input as string;
}
function safeId(input: unknown, code: string): string {
  const value = text(input, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail(code);
  return value;
}
function number(input: unknown, min: number, max: number, code: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) fail(code);
  return Object.is(input, -0) ? 0 : input as number;
}
function list(input: unknown, max: number, code: string): unknown[] {
  if (!Array.isArray(input) || input.length > max) fail(code);
  return input as unknown[];
}
function point(input: unknown, bound: number, code: string): Point {
  if (!Array.isArray(input) || input.length !== 2) fail(code);
  return [number(input[0], -bound, bound, code), number(input[1], -bound, bound, code)];
}
function unique(ids: string[], code = 'world_duplicate_id'): void {
  if (new Set(ids).size !== ids.length) fail(code);
}
function samePoint(a: Point, b: Point): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOLERANCE;
}
function segments(guide: MapGuide): Array<[Point, Point]> {
  const result: Array<[Point, Point]> = guide.points.slice(1).map((p, i) => [guide.points[i], p]);
  if (guide.closed) result.push([guide.points[guide.points.length - 1], guide.points[0]]);
  return result;
}
function guide(input: unknown, bound: number): MapGuide {
  const raw = record(input, 'world_invalid_guide');
  keys(raw, ['id', 'name', 'points', 'curve', 'closed', 'width', 'tags', 'generation'], 'world_unknown_guide_field');
  if (raw.curve !== 'polyline' || typeof raw.closed !== 'boolean') fail('world_polyline_required');
  const points = list(raw.points, raw.closed ? 64 : 65, 'world_guide_segment_quota')
    .map(value => point(value, bound, 'world_guide_outside'));
  if (points.length < 2) fail('world_guide_needs_points');
  const result: MapGuide = {
    id: text(raw.id, 'world_invalid_guide_id'),
    name: text(raw.name, 'world_invalid_guide_name', 160),
    points, curve: 'polyline', closed: raw.closed,
    width: number(raw.width, 2, 64, 'world_invalid_guide_width'),
    tags: list(raw.tags, 16, 'world_invalid_guide_tags').map(value => text(value, 'world_invalid_guide_tag', 64)).sort()
  };
  unique(result.tags, 'world_duplicate_guide_tag');
  if (segments(result).some(([a, b]) => samePoint(a, b))) fail('world_zero_length_guide_segment');
  if (raw.generation !== undefined) {
    const owner = record(raw.generation, 'world_invalid_guide_owner');
    keys(owner, ['kind', 'id', 'generationId'], 'world_invalid_guide_owner');
    if (owner.kind !== 'region' && owner.kind !== 'seam') fail('world_invalid_guide_owner');
    result.generation = {
      kind: owner.kind,
      id: text(owner.id, 'world_invalid_guide_owner'),
      generationId: text(owner.generationId, 'world_invalid_guide_owner')
    };
  }
  return result;
}

/** Reject invalid contracts instead of silently relocating an agent's work. */
export function validateWorldPlan(input: unknown): WorldPlan {
  const raw = record(input, 'world_invalid_plan');
  keys(raw, ['version', 'id', 'revision', 'prompt', 'recipe', 'ecology', 'towns', 'roads'], 'world_unknown_plan_field');
  if (raw.version !== 1) fail('world_invalid_plan_version');
  const revision = number(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'world_invalid_revision');
  if (!Number.isInteger(revision)) fail('world_invalid_revision');
  const recipe = validateWorldRecipe(raw.recipe as WorldRecipe);
  recipe.constraints.sort((a, b) => a.region.localeCompare(b.region));
  const bound = recipe.size / 2;
  const roads = list(raw.roads, 32, 'world_road_quota').map(value => guide(value, bound)).sort(byId);
  const towns = list(raw.towns, 12, 'world_town_quota').map(value => {
    const item = record(value, 'world_invalid_town');
    keys(item, ['id', 'name', 'prompt', 'center', 'radius', 'blend', 'foundation', 'ports', 'terrainMode'], 'world_unknown_town_field');
    const radius = number(item.radius, Math.min(100, recipe.size / 10), 1000, 'world_invalid_town_radius');
    const town: TownIntent = {
      id: safeId(item.id, 'world_invalid_town_id'),
      name: text(item.name, 'world_invalid_town_name', 160),
      prompt: text(item.prompt, 'world_invalid_town_prompt', 4000, true),
      center: point(item.center, bound, 'world_town_outside'),
      radius,
      blend: number(item.blend, Math.min(100, recipe.size / 25), 2000, 'world_invalid_town_blend'),
      foundation: number(item.foundation, 2, 5000, 'world_invalid_foundation'),
      ports: list(item.ports, 16, 'world_port_quota').map(value => {
        const p = record(value, 'world_invalid_port');
        keys(p, ['id', 'guideId', 'position', 'width'], 'world_unknown_port_field');
        const position = point(p.position, radius, 'world_port_outside');
        if (Math.abs(Math.max(Math.abs(position[0]), Math.abs(position[1])) - radius) > TOLERANCE) {
          fail('world_port_not_on_core_boundary');
        }
        return {
          id: text(p.id, 'world_invalid_port_id'),
          guideId: text(p.guideId, 'world_invalid_port_guide'),
          position, width: number(p.width, 2, 64, 'world_invalid_port_width')
        };
      }).sort(byId)
    };
    if (item.terrainMode !== undefined) {
      if (item.terrainMode !== 'platform' && item.terrainMode !== 'conform') fail('world_invalid_terrain_mode');
      town.terrainMode = item.terrainMode;
    }
    if (town.center.some(value => Math.abs(value) + radius + town.blend > bound)) fail('world_town_outside');
    return town;
  }).sort(byId);
  const ecology = validateEcologyRules(raw.ecology);
  const plan: WorldPlan = {
    version: 1, id: safeId(raw.id, 'world_invalid_plan_id'), revision,
    prompt: text(raw.prompt, 'world_invalid_prompt', 8000, true), recipe, ecology, towns, roads
  };
  unique([plan.id, ...ecology.map(rule => rule.id), ...roads.map(road => road.id),
    ...towns.flatMap(town => [town.id, ...town.ports.map(port => port.id)])]);
  for (let i = 0; i < towns.length; i++) {
    const town = towns[i];
    for (const other of towns.slice(i + 1)) {
      // Construction cores remain separate; their soft transition collars may overlap.
      const reach = town.radius + other.radius;
      if (Math.abs(town.center[0] - other.center[0]) < reach
        && Math.abs(town.center[1] - other.center[1]) < reach) fail('world_town_extents_overlap');
    }
    for (const port of town.ports) {
      const road = roads.find(candidate => candidate.id === port.guideId);
      if (!road) fail('world_port_unknown_road');
      const world: Point = [town.center[0] + port.position[0], town.center[1] + port.position[1]];
      if (road.closed || ![road.points[0], road.points[road.points.length - 1]].some(p => samePoint(p, world))) {
        fail('world_port_endpoint_mismatch');
      }
      if (Math.abs(road.width - port.width) > TOLERANCE) fail('world_port_width_mismatch');
    }
  }
  validateRoadGeometry(plan.roads, recipe.size);
  validateTerrain(plan);
  return plan;
}

function keyOf(plan: WorldPlan): string {
  // Full canonical content avoids hash collisions and invalidates patches on any plan change.
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, ordered(child)]));
    }
    return value;
  };
  return JSON.stringify(ordered(plan));
}
export function worldPlanKey(plan: WorldPlan): string {
  return keyOf(validateWorldPlan(plan));
}
export function createTownTasks(plan: WorldPlan): TownTask[] {
  const checked = validateWorldPlan(plan), worldKey = keyOf(checked);
  return checked.towns.map(town => {
    let seed = checked.recipe.seed;
    for (const char of town.id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    return { worldKey, town, seed };
  });
}

function patchFor(plan: WorldPlan, input: unknown, worldKey: string): TownPatch {
  const raw = record(input, 'world_invalid_town_patch');
  keys(raw, ['townId', 'worldKey', 'summary', 'streets', 'buildings'], 'world_unknown_patch_field');
  const townId = text(raw.townId, 'world_invalid_patch_town');
  const town = plan.towns.find(candidate => candidate.id === townId);
  if (!town) fail('world_unknown_patch_town');
  if (raw.worldKey !== worldKey) fail('world_stale_patch');
  const streets = list(raw.streets, 48, 'world_street_quota').map(value => guide(value, town.radius)).sort(byId);
  const buildings = list(raw.buildings, worldTownBuildingQuota(town), 'world_building_quota').map(value => {
    const b = record(value, 'world_invalid_building');
    keys(b, ['id', 'x', 'z', 'width', 'depth', 'height', 'use', 'rotation', 'assetKey', 'enterable'], 'world_unknown_building_field');
    const building: TownBuilding = {
      id: text(b.id, 'world_invalid_building_id'),
      x: number(b.x, -town.radius, town.radius, 'world_building_outside'),
      z: number(b.z, -town.radius, town.radius, 'world_building_outside'),
      width: number(b.width, 1, 300, 'world_invalid_building_width'),
      depth: number(b.depth, 1, 300, 'world_invalid_building_depth'),
      height: number(b.height, 1, 300, 'world_invalid_building_height'),
      use: text(b.use, 'world_invalid_building_use', 120)
    };
    if (b.rotation !== undefined) building.rotation = number(b.rotation, -Math.PI, Math.PI, 'world_invalid_building_rotation');
    if (b.assetKey !== undefined) building.assetKey = safeId(b.assetKey, 'world_invalid_building_asset_key');
    if (b.enterable !== undefined) {
      if (typeof b.enterable !== 'boolean') fail('world_invalid_building_enterable');
      building.enterable = b.enterable;
    }
    const bounds = townBuildingBounds(building);
    if (Math.abs(bounds.x) + bounds.width / 2 > town.radius
      || Math.abs(bounds.z) + bounds.depth / 2 > town.radius) fail('world_building_outside');
    return building;
  }).sort(byId);
  unique([...streets.map(street => street.id), ...buildings.map(building => building.id)]);
  validateStreetGraph(town, streets);
  for (let i = 0; i < buildings.length; i++) {
    const a = townBuildingBounds(buildings[i]);
    for (const b of buildings.slice(i + 1).map(townBuildingBounds)) {
      if (Math.abs(a.x - b.x) < (a.width + b.width) / 2
        && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2) fail('world_buildings_overlap');
    }
    for (const street of streets) {
      if (segments(street).some(([p, q]) => segmentBox(p, q, a, street.width / 2))) {
        fail('world_building_intersects_street');
      }
    }
    const worldBuilding = { ...a, x: a.x + town.center[0], z: a.z + town.center[1] };
    for (const road of plan.roads) {
      if (segments(road).some(([p, q]) => segmentBox(p, q, worldBuilding, road.width / 2))) {
        fail('world_building_intersects_road');
      }
    }
  }
  const result = { townId, worldKey, summary: text(raw.summary, 'world_invalid_patch_summary', 4000, true), streets, buildings };
  validatePatchTerrain(plan, town, result);
  return result;
}

export function worldTownBuildingQuota(town: Pick<TownIntent, 'radius'>): number {
  return Math.min(512, Math.max(128, Math.ceil((town.radius * 2) ** 2 / 900)));
}

/** A crossing counts as a junction only when both street graphs explicitly share a vertex. */
function validateStreetGraph(town: TownIntent, streets: MapGuide[]): void {
  const nodeKey = (p: Point) => JSON.stringify(p);
  const graph = new Map<string, Set<string>>();
  for (const street of streets) for (const [a, b] of segments(street)) {
    const ka = nodeKey(a), kb = nodeKey(b);
    if (!graph.has(ka)) graph.set(ka, new Set());
    if (!graph.has(kb)) graph.set(kb, new Set());
    graph.get(ka)!.add(kb);
    graph.get(kb)!.add(ka);
  }
  for (const port of town.ports) {
    const touching = streets.filter(street => !street.closed
      && [street.points[0], street.points[street.points.length - 1]].some(p => nodeKey(p) === nodeKey(port.position)));
    if (!touching.length) fail('world_street_port_missing');
    if (!touching.some(street => Math.abs(street.width - port.width) <= TOLERANCE)) fail('world_street_port_width_mismatch');
  }
  if (!graph.size) return;
  const reached = new Set<string>(), queue = [graph.keys().next().value!];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    if (reached.has(key)) continue;
    reached.add(key);
    for (const next of graph.get(key)!) if (!reached.has(next)) queue.push(next);
  }
  if (reached.size !== graph.size) fail('world_streets_disconnected');
}
export function validateTownPatch(plan: WorldPlan, patch: unknown): TownPatch {
  const checked = validateWorldPlan(plan);
  const result = patchFor(checked, patch, keyOf(checked));
  bundleIds(checked, [result]);
  return result;
}
function validateRoadGeometry(roads: MapGuide[], size: number): void {
  let vertices = 0;
  for (const road of roads) {
    vertices += road.points.length * 10;
    for (const [a, b] of segments(road)) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      vertices += (Math.ceil(length / worldRoadSampleSpacing(size)) + 1) * 2;
      if (vertices > WORLD_ROAD_VERTEX_BUDGET) fail('world_road_geometry_quota');
    }
  }
}
function bundleIds(plan: WorldPlan, patches: TownPatch[]): void {
  validateRoadGeometry([...plan.roads, ...patches.flatMap(patch => patch.streets)], plan.recipe.size);
  unique([plan.id, ...plan.ecology.map(rule => rule.id), ...plan.roads.map(road => road.id),
    ...plan.towns.flatMap(town => [town.id, ...town.ports.map(port => port.id)]),
    ...patches.flatMap(patch => [...patch.streets.map(street => street.id), ...patch.buildings.map(building => building.id)])]);
}
export function validateWorldBundle(input: unknown): WorldBundle {
  const raw = record(input, 'world_invalid_bundle');
  keys(raw, ['plan', 'patches'], 'world_unknown_bundle_field');
  const plan = validateWorldPlan(raw.plan), key = keyOf(plan);
  const patches = list(raw.patches, 12, 'world_patch_quota').map(patch => patchFor(plan, patch, key))
    .sort((a, b) => a.townId < b.townId ? -1 : a.townId > b.townId ? 1 : 0);
  unique(patches.map(patch => patch.townId), 'world_duplicate_town_patch');
  bundleIds(plan, patches);
  return { plan, patches };
}
export function mergeTownPatch(bundle: WorldBundle, patch: unknown): WorldBundle {
  const checked = validateWorldBundle(bundle);
  const next = patchFor(checked.plan, patch, keyOf(checked.plan));
  const patches = [...checked.patches.filter(item => item.townId !== next.townId), next]
    .sort((a, b) => a.townId < b.townId ? -1 : a.townId > b.townId ? 1 : 0);
  bundleIds(checked.plan, patches);
  return { plan: checked.plan, patches };
}

function townWeight(town: TownIntent, x: number, z: number): number {
  const distance = Math.max(Math.abs(x - town.center[0]), Math.abs(z - town.center[1]));
  if (distance <= town.radius) return 1;
  if (distance >= town.radius + town.blend) return 0;
  const t = (distance - town.radius) / town.blend;
  return 1 - t * t * t * (t * (t * 6 - 15) + 10);
}
function platformSampler(base: WorldSampler, towns: TownIntent[]): WorldSampler {
  return (x, z) => {
    const sample = base(x, z);
    let total = 0, height = 0;
    for (const town of towns) {
      const weight = townWeight(town, x, z);
      if (weight === 0) continue;
      if (weight === 1) return { ...sample, height: town.foundation };
      // Odds preserve the original single-pad blend and approach each core continuously.
      const influence = weight / (1 - weight);
      total += influence; height += influence * town.foundation;
    }
    return total === 0 ? sample : { ...sample, height: (sample.height + height) / (1 + total) };
  };
}

interface RoadGrade { points: Point[]; heights: number[]; width: number }
interface BuildingPad { building: TownBuilding; x: number; z: number; target: number }
const CONFORM_INDEX_CELL_SIZE = 64;
type ConformFeatureIndex = Map<string, number[]>;
function conformCellKey(x: number, z: number): string {
  return Math.floor(x / CONFORM_INDEX_CELL_SIZE) + ',' + Math.floor(z / CONFORM_INDEX_CELL_SIZE);
}
function addConformFeature(index: ConformFeatureIndex, item: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
  for (let z = Math.floor(minZ / CONFORM_INDEX_CELL_SIZE); z <= Math.floor(maxZ / CONFORM_INDEX_CELL_SIZE); z++) {
    for (let x = Math.floor(minX / CONFORM_INDEX_CELL_SIZE); x <= Math.floor(maxX / CONFORM_INDEX_CELL_SIZE); x++) {
      const key = x + ',' + z, items = index.get(key);
      if (!items) index.set(key, [item]);
      else if (!items.includes(item)) items.push(item);
    }
  }
}
function roadGradeAt(grade: RoadGrade, x: number, z: number): { distance: number; height: number } {
  let nearest = { distance: Infinity, height: grade.heights[0] };
  for (let i = 1; i < grade.points.length; i++) {
    const a = grade.points[i - 1], b = grade.points[i], dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length2));
    const distance = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
    if (distance < nearest.distance) nearest = { distance, height: grade.heights[i - 1] + (grade.heights[i] - grade.heights[i - 1]) * t };
  }
  return nearest;
}
function buildingLocal(building: TownBuilding, worldX: number, worldZ: number, centerX: number, centerZ: number): Point {
  const angle = -(building.rotation ?? 0), c = Math.cos(angle), s = Math.sin(angle);
  const dx = worldX - centerX, dz = worldZ - centerZ;
  return [dx * c - dz * s, dx * s + dz * c];
}
function conformSampler(base: WorldSampler, plan: WorldPlan, patches: TownPatch[]): WorldSampler {
  const platformTowns = patches.map(patch => plan.towns.find(town => town.id === patch.townId)!)
    .filter(town => (town.terrainMode ?? 'platform') === 'platform');
  const shapedBase = platformSampler(base, platformTowns), grades: RoadGrade[] = [], pads: BuildingPad[] = [];
  for (const patch of patches) {
    const town = plan.towns.find(candidate => candidate.id === patch.townId)!;
    if ((town.terrainMode ?? 'platform') !== 'conform') continue;
    for (const street of patch.streets) {
      const points = street.points.map(point => [point[0] + town.center[0], point[1] + town.center[1]] as Point);
      grades.push({ points, heights: points.map(point => shapedBase(point[0], point[1]).height), width: street.width });
    }
    for (const building of patch.buildings) {
      const centerX = town.center[0] + building.x, centerZ = town.center[1] + building.z;
      const angle = building.rotation ?? 0, c = Math.cos(angle), s = Math.sin(angle);
      const samples: number[] = [];
      for (const lx of [-building.width / 2, 0, building.width / 2]) for (const lz of [-building.depth / 2, 0, building.depth / 2]) {
        samples.push(shapedBase(centerX + lx * c - lz * s, centerZ + lx * s + lz * c).height);
      }
      samples.sort((a, b) => a - b);
      pads.push({ building, x: centerX, z: centerZ, target: samples[Math.floor(samples.length / 2)] });
    }
  }
  const gradeIndex: ConformFeatureIndex = new Map(), padIndex: ConformFeatureIndex = new Map();
  grades.forEach((grade, index) => {
    const reach = grade.width / 2 + 2;
    for (let i = 1; i < grade.points.length; i++) {
      const a = grade.points[i - 1], b = grade.points[i];
      addConformFeature(gradeIndex, index, Math.min(a[0], b[0]) - reach, Math.min(a[1], b[1]) - reach,
        Math.max(a[0], b[0]) + reach, Math.max(a[1], b[1]) + reach);
    }
  });
  pads.forEach((pad, index) => {
    const angle = pad.building.rotation ?? 0, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const feather = Math.min(4, Math.max(1, Math.min(pad.building.width, pad.building.depth) * 0.2));
    const reachX = (c * pad.building.width + s * pad.building.depth) / 2 + feather;
    const reachZ = (s * pad.building.width + c * pad.building.depth) / 2 + feather;
    addConformFeature(padIndex, index, pad.x - reachX, pad.z - reachZ, pad.x + reachX, pad.z + reachZ);
  });
  return (x, z) => {
    const sample = shapedBase(x, z);
    let height = sample.height;
    let roadInfluence = 0, roadTargetWeight = 0, roadTarget = 0;
    for (const index of gradeIndex.get(conformCellKey(x, z)) ?? []) {
      const grade = grades[index];
      const point = roadGradeAt(grade, x, z), half = grade.width / 2, feather = 2;
      if (point.distance >= half + feather) continue;
      const weight = point.distance <= half ? 1 : townWeight1((half + feather - point.distance) / feather);
      roadInfluence = 1 - (1 - roadInfluence) * (1 - weight);
      const targetWeight = weight / Math.max(0.01, point.distance);
      roadTargetWeight += targetWeight;
      roadTarget += point.height * targetWeight;
    }
    if (roadTargetWeight > 0) height += (roadTarget / roadTargetWeight - height) * roadInfluence;
    let padWeight = 0, padTarget = height;
    for (const index of padIndex.get(conformCellKey(x, z)) ?? []) {
      const pad = pads[index];
      const local = buildingLocal(pad.building, x, z, pad.x, pad.z);
      const ox = Math.max(0, Math.abs(local[0]) - pad.building.width / 2);
      const oz = Math.max(0, Math.abs(local[1]) - pad.building.depth / 2);
      const distance = Math.hypot(ox, oz), feather = Math.min(4, Math.max(1, Math.min(pad.building.width, pad.building.depth) * 0.2));
      if (distance >= feather) continue;
      const weight = ox === 0 && oz === 0 ? 1 : townWeight1((feather - distance) / feather);
      if (weight > padWeight) { padWeight = weight; padTarget = pad.target; }
    }
    height += (padTarget - height) * padWeight;
    return height === sample.height ? sample : { ...sample, height };
  };
}
function townWeight1(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function createPlannedWorldSampler(plan: WorldPlan, patches: TownPatch[] = []): WorldSampler {
  return createPlannedWorldTerrainContext(plan, patches).sample;
}

export function createPlannedWorldTerrainContext(plan: WorldPlan, patches: TownPatch[] = []): WorldTerrainContext {
  const checked = validateWorldBundle({ plan, patches });
  const context = createWorldTerrainContext(checked.plan.recipe);
  return { ...context, sample: conformSampler(context.sample, checked.plan, checked.patches) };
}

function validateTerrain(plan: WorldPlan): void {
  const base = createWorldSampler(plan.recipe), platformTowns = plan.towns.filter(town => (town.terrainMode ?? 'platform') === 'platform');
  const planned = platformSampler(base, platformTowns);
  for (const town of plan.towns) {
    let drySamples = 0;
    for (let iz = -2; iz <= 2; iz++) for (let ix = -2; ix <= 2; ix++) {
      const point = base(town.center[0] + ix * town.radius / 2, town.center[1] + iz * town.radius / 2);
      if (point.waterLevel === null && point.height > 2) drySamples++;
      if ((town.terrainMode ?? 'platform') === 'platform') {
        if (point.waterLevel !== null || point.height <= 2) fail('world_town_core_not_land');
        if (Math.abs(point.height - town.foundation) > Math.min(350, town.blend * 0.2)) fail('world_foundation_height_budget');
      }
    }
    if (town.terrainMode === 'conform') {
      const center = base(town.center[0], town.center[1]);
      if (center.waterLevel !== null || center.height <= 2 || drySamples < 13) fail('world_town_core_not_land');
      if (Math.abs(center.height - town.foundation) > Math.min(350, town.blend * 0.2)) fail('world_foundation_height_budget');
    }
    if (town.terrainMode === 'conform') continue;
    // Bounded diagnostic stencil: 16 rays, nine samples in each transition collar.
    for (let ray = 0; ray < 16; ray++) {
      const angle = ray * Math.PI / 8, dx = Math.cos(angle), dz = Math.sin(angle);
      const scale = Math.max(Math.abs(dx), Math.abs(dz));
      for (let step = 0; step <= 8; step++) {
        const distance = town.radius + town.blend * step / 8;
        const x = town.center[0] + dx / scale * distance, z = town.center[1] + dz / scale * distance;
        const gx = (planned(x + 2, z).height - planned(x - 2, z).height) / 4;
        const gz = (planned(x, z + 2).height - planned(x, z - 2).height) / 4;
        if (Math.hypot(gx, gz) > MAX_TOWN_SLOPE) fail('world_town_transition_slope:' + town.id + ':' + Math.hypot(gx, gz).toFixed(3) + ':x=' + x.toFixed(1) + ':z=' + z.toFixed(1));
      }
    }
  }
  let sampleBudget = 0;
  for (const road of plan.roads) for (const [a, b] of segments(road)) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.ceil(length / worldRoadSampleSpacing(plan.recipe.size));
    sampleBudget += steps + 1;
    if (sampleBudget > 8192) fail('world_road_sampling_quota');
    let previous: number | undefined;
    const nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const cross = [-road.width / 2, 0, road.width / 2].map(offset => planned(x + nx * offset, z + nz * offset));
      if (cross.some(point => point.waterLevel !== null)) fail('world_road_crosses_water');
      const h = cross[1].height;
      if ((Math.max(...cross.map(point => point.height)) - Math.min(...cross.map(point => point.height))) / road.width > MAX_ROAD_SLOPE) fail('world_road_cross_slope');
      if (previous !== undefined && Math.abs(h - previous) / (length / steps) > MAX_ROAD_SLOPE) fail('world_road_slope');
      previous = h;
    }
  }
}

function validatePatchTerrain(plan: WorldPlan, town: TownIntent, patch: TownPatch): void {
  if ((town.terrainMode ?? 'platform') !== 'conform') return;
  const base = createWorldSampler(plan.recipe);
  for (const building of patch.buildings) {
    const centerX = town.center[0] + building.x, centerZ = town.center[1] + building.z;
    const angle = building.rotation ?? 0, c = Math.cos(angle), s = Math.sin(angle), heights: number[] = [];
    for (const lx of [-building.width / 2, 0, building.width / 2]) for (const lz of [-building.depth / 2, 0, building.depth / 2]) {
      const point = base(centerX + lx * c - lz * s, centerZ + lx * s + lz * c);
      if (point.waterLevel !== null) fail('world_building_on_water');
      heights.push(point.height);
    }
    heights.sort((a, b) => a - b);
    const target = heights[Math.floor(heights.length / 2)];
    if (heights.some(height => Math.abs(height - target) > MAX_BUILDING_CUT_FILL)) fail('world_building_earthwork_budget');
  }
  const adjusted = conformSampler(base, plan, [patch]);
  for (const street of patch.streets) for (const [localA, localB] of segments(street)) {
    const a: Point = [localA[0] + town.center[0], localA[1] + town.center[1]];
    const b: Point = [localB[0] + town.center[0], localB[1] + town.center[1]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(length / 12));
    const nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
    let previous: number | undefined;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const cross = [-street.width / 2, 0, street.width / 2].map(offset => ({
        raw: base(x + nx * offset, z + nz * offset), adjusted: adjusted(x + nx * offset, z + nz * offset)
      }));
      if (cross.some(point => point.raw.waterLevel !== null)) fail('world_road_crosses_water');
      if (cross.some(point => Math.abs(point.adjusted.height - point.raw.height) > MAX_BUILDING_CUT_FILL)) fail('world_road_earthwork_budget');
      const heights = cross.map(point => point.adjusted.height), h = heights[1];
      if ((Math.max(...heights) - Math.min(...heights)) / street.width > MAX_ROAD_SLOPE) fail('world_road_cross_slope');
      if (previous !== undefined && Math.abs(h - previous) / (length / steps) > MAX_ROAD_SLOPE) fail('world_road_slope');
      previous = h;
    }
  }
}

/** Conservative world-axis bounds also cover a building rotated around Y. */
export function townBuildingBounds(b: TownBuilding): Pick<TownBuilding, 'x' | 'z' | 'width' | 'depth'> {
  const c = Math.abs(Math.cos(b.rotation ?? 0)), s = Math.abs(Math.sin(b.rotation ?? 0));
  return { x: b.x, z: b.z, width: c * b.width + s * b.depth, depth: s * b.width + c * b.depth };
}

/** Exact slab intersection, with the bounding box expanded by half the road width. */
export function segmentBox(a: Point, b: Point, box: Pick<TownBuilding, 'x' | 'z' | 'width' | 'depth'>, padding = 0): boolean {
  let tMin = 0, tMax = 1;
  const min = [box.x - box.width / 2 - padding, box.z - box.depth / 2 - padding];
  const max = [box.x + box.width / 2 + padding, box.z + box.depth / 2 + padding];
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (a[axis] < min[axis] || a[axis] > max[axis]) return false;
    } else {
      let near = (min[axis] - a[axis]) / delta, far = (max[axis] - a[axis]) / delta;
      if (near > far) [near, far] = [far, near];
      tMin = Math.max(tMin, near); tMax = Math.min(tMax, far);
      if (tMin > tMax) return false;
    }
  }
  return true;
}
function distanceToSegment(x: number, z: number, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function distanceToBox(x: number, z: number, box: Pick<TownBuilding, 'x' | 'z' | 'width' | 'depth'>): number {
  return Math.hypot(Math.max(0, Math.abs(x - box.x) - box.width / 2), Math.max(0, Math.abs(z - box.z) - box.depth / 2));
}
export function createWorldExclusion(plan: WorldPlan, patches: TownPatch[] = []): (x: number, z: number, radius: number) => boolean {
  const checked = validateWorldBundle({ plan, patches });
  const roads = checked.plan.roads.flatMap(road => segments(road).map(([a, b]) => ({ a, b, width: road.width })));
  const ready = new Set(checked.patches.map(patch => patch.townId));
  const boxes = checked.plan.towns.filter(town => !ready.has(town.id)).map(town => ({
    x: town.center[0], z: town.center[1], width: town.radius * 2, depth: town.radius * 2
  }));
  for (const patch of checked.patches) {
    const town = checked.plan.towns.find(town => town.id === patch.townId)!;
    for (const street of patch.streets) for (const [a, b] of segments(street)) {
      roads.push({
        a: [a[0] + town.center[0], a[1] + town.center[1]],
        b: [b[0] + town.center[0], b[1] + town.center[1]], width: street.width
      });
    }
    boxes.push(...patch.buildings.map(townBuildingBounds).map(building => ({
      ...building, x: building.x + town.center[0], z: building.z + town.center[1]
    })));
  }
  return (x, z, radius) => {
    if (![x, z, radius].every(Number.isFinite) || radius < 0) fail('world_invalid_exclusion_query');
    return boxes.some(box => distanceToBox(x, z, box) <= radius)
      || roads.some(road => distanceToSegment(x, z, road.a, road.b) <= road.width / 2 + radius);
  };
}



/** Finished settlements retain greenery between occupied plots; pending cores stay reserved. */
export function createWorldEcologyDensity(plan: WorldPlan, patches: TownPatch[] = []): (x: number, z: number) => number {
  const checked = validateWorldBundle({ plan, patches });
  const ready = new Set(checked.patches.map(patch => patch.townId));
  return (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) fail('world_invalid_density_query');
    let density = 1;
    for (const town of checked.plan.towns) {
      density *= 1 - townWeight(town, x, z) * (ready.has(town.id) ? 0.65 : 1);
    }
    return density;
  };
}
