import { mapGuidePolyline, type MapGuide, type MapGuideCurve } from './mapGuide';
import { validateEcologyRules, type EcologyRule } from './worldEcology';
import { createWorldSampler, createWorldTerrainContext, validateWorldRecipe,
  type WorldRecipe, type WorldSampler, type WorldTerrainBrush, type WorldTerrainContext } from './worldTerrain';

export interface WorldPlan {
  version: 1;
  id: string;
  revision: number;
  prompt: string;
  recipe: WorldRecipe;
  ecology: EcologyRule[];
  towns: TownIntent[];
  roads: MapGuide[];
  whitebox?: true;
  generationPolicy?: 'raw-first-call';
  concept?: WorldConcept;
  featureGraph?: FeatureGraph;
  settlementPlan?: SettlementPlan;
  mobilityPlan?: MobilityPlan;
  explorationPlan?: ExplorationPlan;
  intentionalEmptyAreas?: IntentionalEmptyAreas;
}
export interface WorldConcept { premise: string; themes: string[]; experience: string }
export interface FeatureRegion { id: string; kind: string; name: string; center: Point; radius: number }
export interface FeaturePath { id: string; kind: string; name: string; points: Point[]; curve?: MapGuideCurve; width: number }
export type FeatureSiteRole = 'structure' | 'vehicle' | 'equipment' | 'furniture' | 'landmark' | 'scenery';
export type FeatureSiteSurface = 'land' | 'water' | 'structure';
export interface FeatureSite {
  role: FeatureSiteRole;
  surface: FeatureSiteSurface;
  /** Visible whitebox size in [width, height, depth] metres. */
  dimensions: [number, number, number];
  /** Clockwise heading in radians around +Y. */
  rotation?: number;
}
export interface FeatureAnchor { id: string; kind: string; position: Point; regionId: string; site?: FeatureSite }
export interface FeatureRelation { fromId: string; toId: string; kind: string }
export interface FeatureGraph {
  regions: FeatureRegion[];
  paths: FeaturePath[];
  anchors: FeatureAnchor[];
  relations: FeatureRelation[];
}
export type SettlementDistrictKind = 'working' | 'civic' | 'residential' | 'edge';
export interface SettlementDistrictPlan { anchorId: string; kind: SettlementDistrictKind; density: number }
export interface SettlementPlanEntry {
  id: string; anchorId: string; role: string; population?: number; districts?: SettlementDistrictPlan[];
}
export interface SettlementPlan { settlements: SettlementPlanEntry[] }
export interface MobilityRouteConstruction { terrain: 'follow' | 'grade'; maxGrade?: number }
export interface MobilityRoute {
  id: string; pathId: string; mode: string; connects: string[]; construction?: MobilityRouteConstruction;
}
export interface MobilityPlan { routes: MobilityRoute[] }
export interface ExplorationPointOfInterest { id: string; anchorId: string; purpose: string }
export interface ExplorationPlan { pointsOfInterest: ExplorationPointOfInterest[]; sequence: string[] }
export interface IntentionalEmptyArea { id: string; regionId: string; purpose: string }
export type IntentionalEmptyAreas = IntentionalEmptyArea[];
export type WorldPosition = [number, number, number];
export interface WorldWhiteboxExecution {
  pointsOfInterest?: Array<{ id: string; position: WorldPosition }>;
  paths?: Array<{ id: string; points: Point[]; curve?: MapGuideCurve }>;
}
export interface WorldWhiteboxObservation {
  scope: 'planned' | 'executed';
  pointsOfInterest: {
    plannedCount: number;
    realizedCount: number;
    unrealizedIds: string[];
    spacing: { median: number; p90: number };
    items: Array<{ id: string; anchorId: string; purpose: string; plannedPosition: Point; realizedPosition?: WorldPosition }>;
  };
  sequence: string[];
  routes: Array<{
    id: string; mode: string; connects: string[]; length: number; regions: string[];
    roadTypeChanges: number; branches: number; longestContentFreeStretch: number;
  }>;
  paths: {
    totalLength: number; lengthByType: Record<string, number>; components: number;
    intersections: number; deadEnds: number; unrealizedIds: string[];
  };
  emptyAreaDiagnostics: Array<{
    id: string; regionId: string; kind: 'intentional-empty' | 'missing-content'; purpose?: string;
  }>;
}
type SemanticPlanFields = Pick<WorldPlan,
  'concept' | 'featureGraph' | 'settlementPlan' | 'mobilityPlan' | 'explorationPlan' | 'intentionalEmptyAreas'>;
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
  targetWaterBodyId?: string;
  /** Approximate permanent residents; used to keep generated housing proportional to authored intent. */
  population?: number;
  /** Feature-graph districts retained as local offsets, including connected areas beyond the core. */
  districts?: TownDistrictIntent[];
}
export interface TownDistrictIntent extends SettlementDistrictPlan { offset: Point; radius: number }
export interface TownPort { id: string; guideId: string; position: [number, number]; width: number }
export interface TownTask { worldKey: string; town: TownIntent; seed: number }
export interface TownBuilding {
  id: string; x: number; z: number; width: number; depth: number; height: number; use: string; rotation?: number;
  assetKey?: string; enterable?: boolean;
}
export interface TownPatch { townId: string; worldKey: string; summary: string; streets: MapGuide[]; buildings: TownBuilding[] }
export interface WorldBundle { plan: WorldPlan; patches: TownPatch[] }
export interface WorldRouteConstructionDiagnostic {
  routeId: string;
  pathId: string;
  code: 'world_route_grade_crosses_water' | 'world_route_grade_infeasible';
  reason: 'water' | 'cross_section_cut_fill' | 'longitudinal_grade' | 'terrain_brush_budget';
  position?: Point;
  waterBodyId?: string | null;
}
export interface WorldRouteConstructionResult {
  terrainBrushes: WorldTerrainBrush[];
  diagnostics: WorldRouteConstructionDiagnostic[];
}

export const WORLD_ROAD_SAMPLE_SPACING = 24;
export const WORLD_ROAD_VERTEX_BUDGET = 32768;
export const WORLD_ROAD_CURVE_POINT_LIMIT = 512;
export const worldRoadSampleSpacing = (size: number) => Math.min(WORLD_ROAD_SAMPLE_SPACING, size / 250);

export type Point = [number, number];
const TOLERANCE = 1e-6;
const MAX_TOWN_SLOPE = 0.65;
const MAX_ROAD_SLOPE = 0.5;
const MAX_BUILDING_CUT_FILL = 1.5;
const MAX_ROUTE_CUT_FILL = 1.5;
// Leave interpolation headroom, then verify the continuous sampled result against the public 1.5m budget.
const ROUTE_PROFILE_CUT_FILL = 1.25;
const DEFAULT_ROUTE_MAX_GRADE = 0.18;
const MAX_ROUTE_GRADE_POINTS = 64;
const ROUTE_GRADE_SAMPLE_SPACING = 8;
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
export function worldRoadPolyline(guide: MapGuide): Point[] {
  return mapGuidePolyline(guide, WORLD_ROAD_CURVE_POINT_LIMIT);
}
export function worldFeaturePathPolyline(path: FeaturePath): Point[] {
  return worldRoadPolyline({ ...path, curve: path.curve ?? 'polyline', closed: false, tags: [] });
}
function resampleRoutePolyline(points: Point[], spacing: number, maxPoints: number): Point[] {
  const segments = points.slice(1).map((to, index) => ({
    from: points[index], to,
    length: Math.hypot(to[0] - points[index][0], to[1] - points[index][1])
  })).filter(segment => segment.length > TOLERANCE);
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!segments.length || total <= TOLERANCE) return points.slice(0, 1).map(point => [...point]);
  const count = Math.min(maxPoints, Math.max(2, Math.ceil(total / spacing) + 1));
  return Array.from({ length: count }, (_, index): Point => {
    const target = total * index / (count - 1);
    let before = 0;
    for (const segment of segments) {
      if (target <= before + segment.length + TOLERANCE) {
        const t = Math.max(0, Math.min(1, (target - before) / segment.length));
        return [segment.from[0] + (segment.to[0] - segment.from[0]) * t,
          segment.from[1] + (segment.to[1] - segment.from[1]) * t];
      }
      before += segment.length;
    }
    return [...segments.at(-1)!.to];
  });
}
function routeConstructionGuide(plan: WorldPlan, route: MobilityRoute): MapGuide {
  const road = plan.roads.find(candidate => candidate.id === route.id);
  if (road) return road;
  const path = plan.featureGraph!.paths.find(candidate => candidate.id === route.pathId)!;
  return { id: route.id, name: path.name, points: path.points.map(point => [...point]),
    curve: path.curve ?? 'polyline', closed: false, width: path.width, tags: ['world-route', path.kind] };
}
function derivedBrushId(routeId: string, used: Set<string>): string {
  const stem = `route-grade-${routeId}`.slice(0, 88).replace(/-+$/, '');
  let id = stem;
  for (let suffix = 2; used.has(id); suffix++) id = `${stem.slice(0, 94 - String(suffix).length)}-${suffix}`;
  used.add(id);
  return id;
}
function deriveCheckedWorldRouteConstruction(plan: WorldPlan): WorldRouteConstructionResult {
  const terrainBrushes: WorldTerrainBrush[] = [], diagnostics: WorldRouteConstructionDiagnostic[] = [];
  const routes = (plan.mobilityPlan?.routes ?? []).filter(route => route.construction?.terrain === 'grade');
  if (!routes.length) return { terrainBrushes, diagnostics };
  const base = createWorldSampler(plan.recipe);
  const usedIds = new Set([
    ...(plan.recipe.terrainBrushes ?? []).map(brush => brush.id),
    ...(plan.recipe.waterBodies ?? []).map(water => water.id),
    ...(plan.recipe.biomePatches ?? []).map(patch => patch.id)
  ]);
  const availableBrushes = Math.max(0, 32 - (plan.recipe.terrainBrushes?.length ?? 0));
  for (const route of routes) {
    const guide = routeConstructionGuide(plan, route), centerline = worldRoadPolyline(guide);
    const wetSamples = resampleRoutePolyline(centerline, Math.min(4, Math.max(1, guide.width / 2)), 512);
    let wet: { position: Point; waterBodyId: string | null } | undefined;
    for (let index = 0; index < wetSamples.length && !wet; index++) {
      const point = wetSamples[index], previous = wetSamples[Math.max(0, index - 1)], next = wetSamples[Math.min(wetSamples.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1], length = Math.hypot(dx, dz) || 1;
      for (const offset of [-guide.width / 2, 0, guide.width / 2]) {
        const value = base(point[0] - dz / length * offset, point[1] + dx / length * offset);
        if (value.waterLevel !== null) { wet = { position: [...point], waterBodyId: value.waterBodyId }; break; }
      }
    }
    if (wet) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_crosses_water',
        reason: 'water', position: wet.position, waterBodyId: wet.waterBodyId });
      continue;
    }
    if (terrainBrushes.length >= availableBrushes) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'terrain_brush_budget' });
      continue;
    }
    const points = resampleRoutePolyline(centerline, ROUTE_GRADE_SAMPLE_SPACING, MAX_ROUTE_GRADE_POINTS);
    if (points.length < 2) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'longitudinal_grade' });
      continue;
    }
    const centers: number[] = [], lower: number[] = [], upper: number[] = [];
    let crossSectionFailure: Point | undefined;
    for (let index = 0; index < points.length; index++) {
      const point = points[index], previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1], length = Math.hypot(dx, dz) || 1;
      const cross = [-guide.width / 2, 0, guide.width / 2]
        .map(offset => base(point[0] - dz / length * offset, point[1] + dx / length * offset).height);
      centers.push(cross[1]);
      lower.push(Math.max(...cross.map(height => height - ROUTE_PROFILE_CUT_FILL)));
      upper.push(Math.min(...cross.map(height => height + ROUTE_PROFILE_CUT_FILL)));
      if (lower[index] > upper[index] + TOLERANCE) { crossSectionFailure = [...point]; break; }
    }
    if (crossSectionFailure) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'cross_section_cut_fill', position: crossSectionFailure });
      continue;
    }
    lower[0] = upper[0] = centers[0];
    lower[lower.length - 1] = upper[upper.length - 1] = centers.at(-1)!;
    const maxGrade = route.construction?.maxGrade ?? DEFAULT_ROUTE_MAX_GRADE;
    const constrain = (from: number, to: number, step: number): boolean => {
      for (let index = from; index !== to; index += step) {
        const adjacent = index - step, distance = Math.hypot(points[index][0] - points[adjacent][0], points[index][1] - points[adjacent][1]);
        const delta = maxGrade * distance;
        lower[index] = Math.max(lower[index], lower[adjacent] - delta);
        upper[index] = Math.min(upper[index], upper[adjacent] + delta);
        if (lower[index] > upper[index] + TOLERANCE) return false;
      }
      return true;
    };
    if (!constrain(1, points.length, 1) || !constrain(points.length - 2, -1, -1)) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'longitudinal_grade' });
      continue;
    }
    const heights = [centers[0]];
    let feasible = true;
    for (let index = 1; index < points.length; index++) {
      const distance = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
      const delta = maxGrade * distance, low = Math.max(lower[index], heights[index - 1] - delta);
      const high = Math.min(upper[index], heights[index - 1] + delta);
      if (low > high + TOLERANCE) { feasible = false; break; }
      heights.push(Math.max(low, Math.min(high, centers[index])));
    }
    if (!feasible) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'longitudinal_grade' });
      continue;
    }
    const brush: WorldTerrainBrush = { id: derivedBrushId(route.id, usedIds), mode: 'grade',
      region: { kind: 'path', points, width: guide.width }, heights, feather: 2, strength: 1 };
    const candidate = createWorldSampler({ ...plan.recipe,
      terrainBrushes: [...(plan.recipe.terrainBrushes ?? []), ...terrainBrushes, brush] });
    const verification = resampleRoutePolyline(centerline, Math.min(2, Math.max(0.5, guide.width / 4)), 512);
    let previousHeight: number | undefined, previousPoint: Point | undefined, invalidPosition: Point | undefined;
    for (let index = 0; index < verification.length && !invalidPosition; index++) {
      const point = verification[index], previous = verification[Math.max(0, index - 1)], next = verification[Math.min(verification.length - 1, index + 1)];
      const dx = next[0] - previous[0], dz = next[1] - previous[1], tangentLength = Math.hypot(dx, dz) || 1;
      const cross = [-guide.width / 2, 0, guide.width / 2].map(offset => {
        const x = point[0] - dz / tangentLength * offset, z = point[1] + dx / tangentLength * offset;
        return { raw: base(x, z).height, adjusted: candidate(x, z).height };
      });
      if (cross.some(value => Math.abs(value.adjusted - value.raw) > MAX_ROUTE_CUT_FILL + TOLERANCE)) {
        invalidPosition = [...point]; break;
      }
      if (previousHeight !== undefined && previousPoint) {
        const distance = Math.hypot(point[0] - previousPoint[0], point[1] - previousPoint[1]);
        if (Math.abs(cross[1].adjusted - previousHeight) / distance > maxGrade + 0.001) {
          invalidPosition = [...point]; break;
        }
      }
      previousHeight = cross[1].adjusted; previousPoint = point;
    }
    if (invalidPosition) {
      diagnostics.push({ routeId: route.id, pathId: route.pathId, code: 'world_route_grade_infeasible',
        reason: 'longitudinal_grade', position: invalidPosition });
      continue;
    }
    terrainBrushes.push(brush);
  }
  return { terrainBrushes, diagnostics };
}
/** Compiles only explicitly authored route earthworks; it never rewrites the plan or infers repairs. */
export function deriveWorldRouteConstruction(plan: WorldPlan): WorldRouteConstructionResult {
  return deriveCheckedWorldRouteConstruction(validateWorldPlan(plan));
}
function segments(guide: MapGuide): Array<[Point, Point]> {
  const points = worldRoadPolyline(guide);
  return points.slice(1).map((p, i) => [points[i], p]);
}
function guide(input: unknown, bound: number): MapGuide {
  const raw = record(input, 'world_invalid_guide');
  keys(raw, ['id', 'name', 'points', 'curve', 'closed', 'width', 'tags', 'generation'], 'world_unknown_guide_field');
  if ((raw.curve !== 'polyline' && raw.curve !== 'catmull-rom') || typeof raw.closed !== 'boolean') fail('world_curve_required');
  const points = list(raw.points, raw.closed ? 64 : 65, 'world_guide_segment_quota')
    .map(value => point(value, bound, 'world_guide_outside'));
  if (points.length < 2) fail('world_guide_needs_points');
  const result: MapGuide = {
    id: text(raw.id, 'world_invalid_guide_id'),
    name: text(raw.name, 'world_invalid_guide_name', 160),
    points, curve: raw.curve, closed: raw.closed,
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

function semanticText(input: unknown, code: string): string {
  return text(input, code, 240);
}
function parseSemanticPlan(raw: Record<string, unknown>, bound: number, externalRelationIds: readonly string[]): SemanticPlanFields {
  const result: SemanticPlanFields = {};
  if (raw.concept !== undefined) {
    const value = record(raw.concept, 'world_invalid_concept');
    keys(value, ['premise', 'themes', 'experience'], 'world_unknown_concept_field');
    result.concept = {
      premise: text(value.premise, 'world_invalid_concept_premise', 2000),
      themes: list(value.themes, 16, 'world_concept_theme_quota')
        .map(theme => semanticText(theme, 'world_invalid_concept_theme')).sort(),
      experience: text(value.experience, 'world_invalid_concept_experience', 2000)
    };
    unique(result.concept.themes, 'world_duplicate_concept_theme');
  }
  if (raw.featureGraph !== undefined) {
    const value = record(raw.featureGraph, 'world_invalid_feature_graph');
    keys(value, ['regions', 'paths', 'anchors', 'relations'], 'world_unknown_feature_graph_field');
    const regions = list(value.regions, 64, 'world_feature_region_quota').map(item => {
      const region = record(item, 'world_invalid_feature_region');
      keys(region, ['id', 'kind', 'name', 'center', 'radius'], 'world_unknown_feature_region_field');
      return { id: safeId(region.id, 'world_invalid_feature_id'), kind: semanticText(region.kind, 'world_invalid_feature_kind'),
        name: semanticText(region.name, 'world_invalid_feature_name'), center: point(region.center, bound, 'world_feature_outside'),
        radius: number(region.radius, 1, bound, 'world_invalid_feature_radius') };
    }).sort(byId);
    const paths = list(value.paths, 64, 'world_feature_path_quota').map(item => {
      const path = record(item, 'world_invalid_feature_path');
      keys(path, ['id', 'kind', 'name', 'points', 'curve', 'width'], 'world_unknown_feature_path_field');
      const points = list(path.points, 256, 'world_feature_path_point_quota')
        .map(item => point(item, bound, 'world_feature_outside'));
      if (points.length < 2) fail('world_feature_path_needs_points');
      const curve = path.curve;
      if (curve !== undefined && curve !== 'polyline' && curve !== 'catmull-rom') fail('world_invalid_feature_path_curve');
      return { id: safeId(path.id, 'world_invalid_feature_id'), kind: semanticText(path.kind, 'world_invalid_feature_kind'),
        name: semanticText(path.name, 'world_invalid_feature_name'), points,
        ...(curve === undefined ? {} : { curve }),
        width: number(path.width, 0.1, 256, 'world_invalid_feature_path_width') } satisfies FeaturePath;
    }).sort(byId);
    const anchors = list(value.anchors, 128, 'world_feature_anchor_quota').map(item => {
      const anchor = record(item, 'world_invalid_feature_anchor');
      keys(anchor, ['id', 'kind', 'position', 'regionId', 'site'], 'world_unknown_feature_anchor_field');
      let site: FeatureSite | undefined;
      if (anchor.site !== undefined) {
        const value = record(anchor.site, 'world_invalid_feature_site');
        keys(value, ['role', 'surface', 'dimensions', 'rotation'], 'world_unknown_feature_site_field');
        if (!['structure', 'vehicle', 'equipment', 'furniture', 'landmark', 'scenery']
          .includes(String(value.role))) fail('world_invalid_feature_site_role');
        if (!['land', 'water', 'structure'].includes(String(value.surface))) fail('world_invalid_feature_site_surface');
        if (!Array.isArray(value.dimensions) || value.dimensions.length !== 3) fail('world_invalid_feature_site_dimensions');
        site = {
          role: value.role as FeatureSiteRole,
          surface: value.surface as FeatureSiteSurface,
          dimensions: value.dimensions.map(item =>
            number(item, 0.05, bound * 2, 'world_invalid_feature_site_dimensions')) as [number, number, number],
          ...(value.rotation === undefined ? {} : {
            rotation: number(value.rotation, -Math.PI, Math.PI, 'world_invalid_feature_site_rotation')
          })
        };
      }
      return { id: safeId(anchor.id, 'world_invalid_feature_id'), kind: semanticText(anchor.kind, 'world_invalid_feature_kind'),
        position: point(anchor.position, bound, 'world_feature_outside'),
        regionId: safeId(anchor.regionId, 'world_invalid_feature_anchor_region'), ...(site ? { site } : {}) };
    }).sort(byId);
    const regionIds = new Set(regions.map(region => region.id));
    if (anchors.some(anchor => !regionIds.has(anchor.regionId))) fail('world_unknown_feature_anchor_region');
    const featureIds = [...regions, ...paths, ...anchors].map(feature => feature.id);
    unique(featureIds, 'world_duplicate_feature_id');
    const relationTargetIds = new Set([...featureIds, ...externalRelationIds]);
    const relations = list(value.relations, 256, 'world_feature_relation_quota').map(item => {
      const relation = record(item, 'world_invalid_feature_relation');
      keys(relation, ['fromId', 'toId', 'kind'], 'world_unknown_feature_relation_field');
      const parsed = { fromId: safeId(relation.fromId, 'world_invalid_feature_relation'),
        toId: safeId(relation.toId, 'world_invalid_feature_relation'), kind: semanticText(relation.kind, 'world_invalid_feature_relation') };
      if (!relationTargetIds.has(parsed.fromId) || !relationTargetIds.has(parsed.toId)) fail('world_unknown_feature_relation_target');
      return parsed;
    }).sort((a, b) => `${a.fromId}\0${a.toId}\0${a.kind}`.localeCompare(`${b.fromId}\0${b.toId}\0${b.kind}`));
    result.featureGraph = { regions, paths, anchors, relations };
  }
  const anchors = new Set(result.featureGraph?.anchors.map(item => item.id) ?? []);
  const paths = new Set(result.featureGraph?.paths.map(item => item.id) ?? []);
  const regions = new Set(result.featureGraph?.regions.map(item => item.id) ?? []);
  if (raw.settlementPlan !== undefined) {
    const value = record(raw.settlementPlan, 'world_invalid_settlement_plan');
    keys(value, ['settlements'], 'world_unknown_settlement_plan_field');
    const settlements = list(value.settlements, 64, 'world_settlement_plan_quota').map(item => {
      const settlement = record(item, 'world_invalid_settlement_plan');
      keys(settlement, ['id', 'anchorId', 'role', 'population', 'districts'], 'world_unknown_settlement_plan_field');
      const parsed = { id: safeId(settlement.id, 'world_invalid_settlement_id'),
        anchorId: safeId(settlement.anchorId, 'world_invalid_settlement_anchor'),
        role: text(settlement.role, 'world_invalid_settlement_role', 2000),
        ...(settlement.population === undefined ? {} : { population: number(settlement.population, 1, 1_000_000,
          'world_invalid_settlement_population') }),
        ...(settlement.districts === undefined ? {} : { districts: list(settlement.districts, 16,
          'world_settlement_district_quota').map(item => {
          const district = record(item, 'world_invalid_settlement_district');
          keys(district, ['anchorId', 'kind', 'density'], 'world_unknown_settlement_district_field');
          if (!['working', 'civic', 'residential', 'edge'].includes(String(district.kind))) {
            fail('world_invalid_settlement_district_kind');
          }
          const anchorId = safeId(district.anchorId, 'world_invalid_settlement_district_anchor');
          if (!anchors.has(anchorId)) fail('world_unknown_settlement_district_anchor');
          return { anchorId, kind: district.kind as SettlementDistrictKind,
            density: number(district.density, 0, 1, 'world_invalid_settlement_district_density') };
        }).sort((a, b) => a.anchorId.localeCompare(b.anchorId) || a.kind.localeCompare(b.kind)) }) };
      if (parsed.population !== undefined && !Number.isInteger(parsed.population)) fail('world_invalid_settlement_population');
      if (!anchors.has(parsed.anchorId)) fail('world_unknown_settlement_anchor');
      if (parsed.districts) unique(parsed.districts.map(district => `${district.anchorId}:${district.kind}`),
        'world_duplicate_settlement_district_anchor');
      return parsed;
    }).sort(byId);
    unique(settlements.map(item => item.id), 'world_duplicate_settlement_id');
    result.settlementPlan = { settlements };
  }
  if (raw.mobilityPlan !== undefined) {
    const value = record(raw.mobilityPlan, 'world_invalid_mobility_plan');
    keys(value, ['routes'], 'world_unknown_mobility_plan_field');
    const routes = list(value.routes, 64, 'world_mobility_route_quota').map(item => {
      const route = record(item, 'world_invalid_mobility_route');
      keys(route, ['id', 'pathId', 'mode', 'connects', 'construction'], 'world_unknown_mobility_route_field');
      const parsed = { id: safeId(route.id, 'world_invalid_mobility_route'), pathId: safeId(route.pathId, 'world_invalid_mobility_path'),
        mode: semanticText(route.mode, 'world_invalid_mobility_mode'),
        connects: list(route.connects, 32, 'world_mobility_connection_quota')
          .map(id => safeId(id, 'world_invalid_mobility_connection')) } as MobilityRoute;
      if (route.construction !== undefined) {
        const construction = record(route.construction, 'world_invalid_route_construction');
        keys(construction, ['terrain', 'maxGrade'], 'world_unknown_route_construction_field');
        if (construction.terrain !== 'follow' && construction.terrain !== 'grade') fail('world_invalid_route_terrain');
        if (construction.terrain === 'follow' && construction.maxGrade !== undefined) fail('world_unexpected_route_max_grade');
        parsed.construction = {
          terrain: construction.terrain,
          ...(construction.maxGrade === undefined ? {} : {
            maxGrade: number(construction.maxGrade, 0.02, 0.2, 'world_invalid_route_max_grade')
          })
        };
      }
      if (!paths.has(parsed.pathId) || parsed.connects.some(id => !anchors.has(id))) fail('world_unknown_mobility_feature');
      unique(parsed.connects, 'world_duplicate_mobility_connection');
      return parsed;
    }).sort(byId);
    unique(routes.map(item => item.id), 'world_duplicate_mobility_route');
    result.mobilityPlan = { routes };
  }
  if (raw.explorationPlan !== undefined) {
    const value = record(raw.explorationPlan, 'world_invalid_exploration_plan');
    keys(value, ['pointsOfInterest', 'sequence'], 'world_unknown_exploration_plan_field');
    const pointsOfInterest = list(value.pointsOfInterest, 128, 'world_poi_quota').map(item => {
      const poi = record(item, 'world_invalid_poi');
      keys(poi, ['id', 'anchorId', 'purpose'], 'world_unknown_poi_field');
      const parsed = { id: safeId(poi.id, 'world_invalid_poi_id'), anchorId: safeId(poi.anchorId, 'world_invalid_poi_anchor'),
        purpose: semanticText(poi.purpose, 'world_invalid_poi_purpose') };
      if (!anchors.has(parsed.anchorId)) fail('world_unknown_poi_anchor');
      return parsed;
    }).sort(byId);
    unique(pointsOfInterest.map(item => item.id), 'world_duplicate_poi_id');
    const poiIds = new Set(pointsOfInterest.map(item => item.id));
    const sequence = list(value.sequence, 128, 'world_exploration_sequence_quota')
      .map(id => safeId(id, 'world_invalid_exploration_sequence'));
    if (sequence.some(id => !poiIds.has(id))) fail('world_unknown_exploration_poi');
    result.explorationPlan = { pointsOfInterest, sequence };
  }
  if (raw.intentionalEmptyAreas !== undefined) {
    result.intentionalEmptyAreas = list(raw.intentionalEmptyAreas, 64, 'world_empty_area_quota').map(item => {
      const area = record(item, 'world_invalid_empty_area');
      keys(area, ['id', 'regionId', 'purpose'], 'world_unknown_empty_area_field');
      const parsed = { id: safeId(area.id, 'world_invalid_empty_area_id'), regionId: safeId(area.regionId, 'world_invalid_empty_region'),
        purpose: semanticText(area.purpose, 'world_invalid_empty_purpose') };
      if (!regions.has(parsed.regionId)) fail('world_unknown_empty_region');
      return parsed;
    }).sort(byId);
    unique(result.intentionalEmptyAreas.map(item => item.id), 'world_duplicate_empty_area_id');
  }
  return result;
}

/** Reject invalid contracts instead of silently relocating an agent's work. */
export function validateWorldPlan(input: unknown): WorldPlan {
  const raw = record(input, 'world_invalid_plan');
  keys(raw, ['version', 'id', 'revision', 'prompt', 'recipe', 'ecology', 'towns', 'roads', 'whitebox', 'generationPolicy', 'concept', 'featureGraph',
    'settlementPlan', 'mobilityPlan', 'explorationPlan', 'intentionalEmptyAreas'], 'world_unknown_plan_field');
  if (raw.version !== 1) fail('world_invalid_plan_version');
  const revision = number(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'world_invalid_revision');
  if (!Number.isInteger(revision)) fail('world_invalid_revision');
  const recipe = validateWorldRecipe(raw.recipe as WorldRecipe);
  recipe.constraints.sort((a, b) => a.region.localeCompare(b.region));
  const bound = recipe.size / 2;
  const roads = list(raw.roads, 32, 'world_road_quota').map(value => guide(value, bound)).sort(byId);
  const towns = list(raw.towns, 12, 'world_town_quota').map(value => {
    const item = record(value, 'world_invalid_town');
    keys(item, ['id', 'name', 'prompt', 'center', 'radius', 'blend', 'foundation', 'ports', 'terrainMode', 'targetWaterBodyId', 'population', 'districts'], 'world_unknown_town_field');
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
    if (item.targetWaterBodyId !== undefined) {
      const target = safeId(item.targetWaterBodyId, 'world_invalid_town_water_target');
      if (target !== 'sea' && !recipe.waterBodies?.some(body => body.id === target)) fail('world_unknown_town_water_target');
      town.targetWaterBodyId = target;
    }
    if (item.population !== undefined) {
      town.population = number(item.population, 1, 1_000_000, 'world_invalid_town_population');
      if (!Number.isInteger(town.population)) fail('world_invalid_town_population');
    }
    if (item.districts !== undefined) {
      town.districts = list(item.districts, 16, 'world_town_district_quota').map(value => {
        const district = record(value, 'world_invalid_town_district');
        keys(district, ['anchorId', 'kind', 'density', 'offset', 'radius'], 'world_unknown_town_district_field');
        if (!['working', 'civic', 'residential', 'edge'].includes(String(district.kind))) {
          fail('world_invalid_town_district_kind');
        }
        const offset = point(district.offset, bound * 2, 'world_town_district_outside');
        const districtRadius = number(district.radius, 1, bound, 'world_invalid_town_district_radius');
        if (Math.abs(town.center[0] + offset[0]) > bound + TOLERANCE
          || Math.abs(town.center[1] + offset[1]) > bound + TOLERANCE) {
          fail('world_town_district_outside');
        }
        return { anchorId: safeId(district.anchorId, 'world_invalid_town_district_anchor'),
          kind: district.kind as SettlementDistrictKind,
          density: number(district.density, 0, 1, 'world_invalid_town_district_density'), offset, radius: districtRadius };
      }).sort((a, b) => a.anchorId.localeCompare(b.anchorId) || a.kind.localeCompare(b.kind));
      unique(town.districts.map(district => `${district.anchorId}:${district.kind}`),
        'world_duplicate_town_district_anchor');
    }
    // Conforming settlements do not flatten a collar; only platform towns need blend room.
    if (town.center.some(value => Math.abs(value) + radius + (town.terrainMode === 'conform' ? 0 : town.blend) > bound + TOLERANCE)) {
      fail('world_town_outside');
    }
    return town;
  }).sort(byId);
  const ecology = validateEcologyRules(raw.ecology);
  const plan: WorldPlan = {
    version: 1, id: safeId(raw.id, 'world_invalid_plan_id'), revision,
    prompt: text(raw.prompt, 'world_invalid_prompt', 8000, true), recipe, ecology, towns, roads,
    ...parseSemanticPlan(raw, bound, recipe.waterBodies?.map(water => water.id) ?? [])
  };
  if (raw.whitebox !== undefined) {
    if (raw.whitebox !== true) fail('world_invalid_whitebox_marker');
    plan.whitebox = true;
  }
  if (raw.generationPolicy !== undefined) {
    if (raw.generationPolicy !== 'raw-first-call') fail('world_invalid_generation_policy');
    plan.generationPolicy = raw.generationPolicy;
  }
  const featureAnchorIds = new Set(plan.featureGraph?.anchors.map(anchor => anchor.id) ?? []);
  if (towns.some(town => town.districts?.some(district => !featureAnchorIds.has(district.anchorId)))) {
    fail('world_unknown_town_district_anchor');
  }
  unique([plan.id, ...ecology.map(rule => rule.id), ...roads.map(road => road.id),
    ...towns.flatMap(town => [town.id, ...town.ports.map(port => port.id)])]);
  for (let i = 0; i < towns.length; i++) {
    const town = towns[i];
    for (const other of towns.slice(i + 1)) {
      // Construction cores remain separate; their soft transition collars may overlap.
      const reach = town.radius + other.radius;
      if (plan.generationPolicy !== 'raw-first-call' && Math.abs(town.center[0] - other.center[0]) < reach
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
  if (!plan.whitebox && plan.generationPolicy !== 'raw-first-call') validateTerrain(plan);
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
function polylineLength(points: Point[]): number {
  return points.slice(1).reduce((total, p, index) => total + Math.hypot(p[0] - points[index][0], p[1] - points[index][1]), 0);
}
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}
function nearestSpacing(points: Point[]): { median: number; p90: number } {
  const distances = points.map((point, index) => Math.min(...points
    .filter((_, other) => other !== index)
    .map(other => Math.hypot(point[0] - other[0], point[1] - other[1]))));
  const finite = distances.filter(Number.isFinite);
  return { median: percentile(finite, 0.5), p90: percentile(finite, 0.9) };
}
function pointKey(value: Point): string { return `${value[0].toFixed(6)},${value[1].toFixed(6)}`; }
function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const abx = b[0] - a[0], abz = b[1] - a[1], cdx = d[0] - c[0], cdz = d[1] - c[1];
  const denominator = abx * cdz - abz * cdx;
  if (Math.abs(denominator) <= TOLERANCE) {
    return [a, b].find(p => samePoint(p, c) || samePoint(p, d))
      ?? [c, d].find(p => samePoint(p, a) || samePoint(p, b));
  }
  const acx = c[0] - a[0], acz = c[1] - a[1];
  const t = (acx * cdz - acz * cdx) / denominator, u = (acx * abz - acz * abx) / denominator;
  return t >= -TOLERANCE && t <= 1 + TOLERANCE && u >= -TOLERANCE && u <= 1 + TOLERANCE
    ? [a[0] + t * abx, a[1] + t * abz] : undefined;
}
function distanceAlong(points: Point[], target: Point): number {
  let bestDistance = Infinity, bestAlong = 0, walked = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], dx = b[0] - a[0], dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dz) / lengthSquared));
    const projected: Point = [a[0] + t * dx, a[1] + t * dz], distance = Math.hypot(target[0] - projected[0], target[1] - projected[1]);
    if (distance < bestDistance) { bestDistance = distance; bestAlong = walked + Math.sqrt(lengthSquared) * t; }
    walked += Math.sqrt(lengthSquared);
  }
  return bestAlong;
}

/** Deterministic geometry observations only; no metric is an aesthetic gate or repair instruction. */
export function observeWorldWhitebox(plan: WorldPlan, execution?: WorldWhiteboxExecution): WorldWhiteboxObservation {
  const checked = validateWorldPlan(plan), bound = checked.recipe.size / 2;
  const graph = checked.featureGraph ?? { regions: [], paths: [], anchors: [], relations: [] };
  const anchors = new Map(graph.anchors.map(anchor => [anchor.id, anchor]));
  const plannedPois = checked.explorationPlan?.pointsOfInterest ?? [];
  const realizedPoiEntries = (execution?.pointsOfInterest ?? []).map(item => {
    if (!plannedPois.some(poi => poi.id === item.id)) fail('world_unknown_executed_poi');
    if (!Array.isArray(item.position) || item.position.length !== 3) fail('world_invalid_executed_poi_position');
    const position: WorldPosition = [number(item.position[0], -bound, bound, 'world_invalid_executed_poi_position'),
      number(item.position[1], -1_000_000, 1_000_000, 'world_invalid_executed_poi_position'),
      number(item.position[2], -bound, bound, 'world_invalid_executed_poi_position')];
    return [item.id, position] as const;
  });
  unique(realizedPoiEntries.map(([id]) => id), 'world_duplicate_executed_poi');
  const realizedPois = new Map(realizedPoiEntries);
  const authoredPaths = new Map(graph.paths.map(path => [path.id, path]));
  const executedPathEntries = (execution?.paths ?? []).map(item => {
    const authored = authoredPaths.get(item.id);
    if (!authored) fail('world_unknown_executed_path');
    if (item.curve !== undefined && item.curve !== 'polyline' && item.curve !== 'catmull-rom') {
      fail('world_invalid_executed_path_curve');
    }
    const points = list(item.points, 256, 'world_executed_path_point_quota').map(value => point(value, bound, 'world_executed_path_outside'));
    if (points.length < 2) fail('world_executed_path_needs_points');
    return [item.id, { ...authored, points, curve: item.curve ?? authored.curve }] as const;
  });
  unique(executedPathEntries.map(([id]) => id), 'world_duplicate_executed_path');
  const executedPaths = new Map(executedPathEntries);
  const observedPaths = execution?.paths === undefined ? graph.paths : [...executedPaths.values()].sort(byId);
  const observedGeometry = new Map(observedPaths.map(path => [path.id, worldFeaturePathPolyline(path)]));
  // Keep topology bounded by the authored control-point quota. Dense curve samples
  // are reserved for geometry-sensitive distance, terrain, and water observations.
  const pathSegments = observedPaths.flatMap(path => path.points.slice(1)
    .map((to, index) => ({ pathId: path.id, from: path.points[index], to })));
  const intersections = new Map<string, Set<string>>();
  const pathLinks = new Map(observedPaths.map(path => [path.id, new Set<string>()]));
  for (let i = 0; i < pathSegments.length; i++) for (let j = i + 1; j < pathSegments.length; j++) {
    if (pathSegments[i].pathId === pathSegments[j].pathId) continue;
    const crossing = segmentIntersection(pathSegments[i].from, pathSegments[i].to, pathSegments[j].from, pathSegments[j].to);
    if (!crossing) continue;
    const key = pointKey(crossing), ids = intersections.get(key) ?? new Set<string>();
    ids.add(pathSegments[i].pathId); ids.add(pathSegments[j].pathId); intersections.set(key, ids);
    pathLinks.get(pathSegments[i].pathId)!.add(pathSegments[j].pathId);
    pathLinks.get(pathSegments[j].pathId)!.add(pathSegments[i].pathId);
  }
  let components = 0;
  const reached = new Set<string>();
  for (const path of observedPaths) {
    if (reached.has(path.id)) continue;
    components++;
    const queue = [path.id];
    for (let i = 0; i < queue.length; i++) {
      if (reached.has(queue[i])) continue;
      reached.add(queue[i]);
      for (const next of pathLinks.get(queue[i]) ?? []) queue.push(next);
    }
  }
  const endpointDegree = new Map<string, number>();
  for (const path of observedPaths) for (const endpoint of [path.points[0], path.points[path.points.length - 1]]) {
    const key = pointKey(endpoint); endpointDegree.set(key, (endpointDegree.get(key) ?? 0) + 1);
  }
  const poiItems = plannedPois.map(({ id, anchorId, purpose }) => {
    const item: WorldWhiteboxObservation['pointsOfInterest']['items'][number] = {
      id, anchorId, purpose, plannedPosition: [...anchors.get(anchorId)!.position]
    };
    if (realizedPois.has(id)) item.realizedPosition = [...realizedPois.get(id)!];
    return item;
  });
  const spacingPoints: Point[] = execution
    ? [...realizedPois.values()].map(position => [position[0], position[2]])
    : poiItems.map(item => item.plannedPosition);
  const routes = (checked.mobilityPlan?.routes ?? []).map(route => {
    const path = (execution?.paths === undefined ? authoredPaths : executedPaths).get(route.pathId);
    const points = path ? worldFeaturePathPolyline(path) : [], length = points.length > 1 ? polylineLength(points) : 0;
    const contentDistances = plannedPois.filter(poi => route.connects.includes(poi.anchorId))
      .filter(poi => !execution || realizedPois.has(poi.id))
      .map(poi => execution ? realizedPois.get(poi.id)! : anchors.get(poi.anchorId)!.position)
      .map(position => distanceAlong(points, [position[0], position.length === 3 ? position[2] : position[1]]));
    const stops = [0, ...contentDistances.sort((a, b) => a - b), length];
    const regions = route.connects.map(id => anchors.get(id)!.regionId).filter((id, index, ids) => ids.indexOf(id) === index);
    return { id: route.id, mode: route.mode, connects: [...route.connects], length, regions, roadTypeChanges: 0,
      branches: [...intersections.values()].filter(pathIds => pathIds.has(route.pathId)).length,
      longestContentFreeStretch: stops.slice(1).reduce((longest, stop, index) => Math.max(longest, stop - stops[index]), 0) };
  });
  const lengthByType: Record<string, number> = {};
  for (const path of observedPaths) lengthByType[path.kind] = (lengthByType[path.kind] ?? 0)
    + polylineLength(observedGeometry.get(path.id)!);
  const contentRegionIds = new Set((execution ? plannedPois.filter(poi => realizedPois.has(poi.id)) : plannedPois)
    .map(poi => anchors.get(poi.anchorId)!.regionId));
  const intentionalByRegion = new Map((checked.intentionalEmptyAreas ?? []).map(area => [area.regionId, area]));
  const emptyAreaDiagnostics: WorldWhiteboxObservation['emptyAreaDiagnostics'] = [
    ...(checked.intentionalEmptyAreas ?? []).map(area => ({ ...area, kind: 'intentional-empty' as const })),
    ...graph.regions.filter(region => !contentRegionIds.has(region.id) && !intentionalByRegion.has(region.id))
      .map(region => ({ id: region.id, regionId: region.id, kind: 'missing-content' as const }))
  ].sort(byId);
  return {
    scope: execution ? 'executed' : 'planned',
    pointsOfInterest: {
      plannedCount: plannedPois.length, realizedCount: execution ? realizedPois.size : 0,
      unrealizedIds: execution ? plannedPois.filter(poi => !realizedPois.has(poi.id)).map(poi => poi.id) : [],
      spacing: nearestSpacing(spacingPoints), items: poiItems
    },
    sequence: [...(checked.explorationPlan?.sequence ?? [])], routes,
    paths: {
      totalLength: Object.values(lengthByType).reduce((sum, length) => sum + length, 0), lengthByType,
      components, intersections: intersections.size,
      deadEnds: [...endpointDegree.values()].filter(degree => degree === 1).length,
      unrealizedIds: execution?.paths === undefined ? [] : graph.paths.filter(path => !executedPaths.has(path.id)).map(path => path.id)
    },
    emptyAreaDiagnostics
  };
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
  const localBound = Math.max(town.radius, ...town.districts?.map(district => Math.max(
    Math.abs(district.offset[0]) + district.radius, Math.abs(district.offset[1]) + district.radius
  )) ?? []);
  const streets = list(raw.streets, 48, 'world_street_quota').map(value => guide(value, localBound)).sort(byId);
  if (streets.some(street => street.points.some(point =>
    Math.abs(point[0] + town.center[0]) > plan.recipe.size / 2 + TOLERANCE
    || Math.abs(point[1] + town.center[1]) > plan.recipe.size / 2 + TOLERANCE))) fail('world_street_outside');
  const buildings = list(raw.buildings, worldTownBuildingQuota(town), 'world_building_quota').map(value => {
    const b = record(value, 'world_invalid_building');
    keys(b, ['id', 'x', 'z', 'width', 'depth', 'height', 'use', 'rotation', 'assetKey', 'enterable'], 'world_unknown_building_field');
    const building: TownBuilding = {
      id: text(b.id, 'world_invalid_building_id'),
      x: number(b.x, -localBound, localBound, 'world_building_outside'),
      z: number(b.z, -localBound, localBound, 'world_building_outside'),
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
    if (!worldTownContainsBuilding(town, building)
      || Math.abs(town.center[0] + building.x) + building.width / 2 > plan.recipe.size / 2 + TOLERANCE
      || Math.abs(town.center[1] + building.z) + building.depth / 2 > plan.recipe.size / 2 + TOLERANCE) {
      fail('world_building_outside');
    }
    return building;
  }).sort(byId);
  unique([...streets.map(street => street.id), ...buildings.map(building => building.id)]);
  validateStreetGraph(town, streets, plan.roads);
  for (let i = 0; i < buildings.length; i++) {
    for (const other of buildings.slice(i + 1)) {
      if (buildingsOverlap(buildings[i], other)) fail('world_buildings_overlap');
    }
    for (const street of streets) {
      if (segments(street).some(([p, q]) => segmentBuildingFootprint(p, q, buildings[i], street.width / 2))) {
        fail('world_building_intersects_street');
      }
    }
    const worldBuilding = { ...buildings[i], x: buildings[i].x + town.center[0], z: buildings[i].z + town.center[1] };
    for (const road of plan.roads) {
      if (segments(road).some(([p, q]) => segmentBuildingFootprint(p, q, worldBuilding, road.width / 2))) {
        fail('world_building_intersects_road');
      }
    }
  }
  const result = { townId, worldKey, summary: text(raw.summary, 'world_invalid_patch_summary', 4000, true), streets, buildings };
  if (plan.generationPolicy !== 'raw-first-call') validatePatchTerrain(plan, town, result);
  return result;
}

export function worldTownBuildingQuota(town: Pick<TownIntent, 'radius'> & Partial<Pick<TownIntent, 'population'>>): number {
  return Math.min(512, Math.max(128, Math.ceil((town.radius * 2) ** 2 / 900),
    Math.ceil((town.population ?? 0) / 5) + 12));
}

/** A crossing counts as a junction only when both street graphs explicitly share a vertex. */
function validateStreetGraph(town: TownIntent, streets: MapGuide[], authoredRoads: MapGuide[]): void {
  const nodeKey = (p: Point) => JSON.stringify(p);
  for (const port of town.ports) {
    const touching = streets.filter(street => !street.closed
      && [street.points[0], street.points[street.points.length - 1]].some(p => nodeKey(p) === nodeKey(port.position)));
    if (!touching.length) fail('world_street_port_missing');
    if (!touching.some(street => Math.abs(street.width - port.width) <= TOLERANCE)) fail('world_street_port_width_mismatch');
  }
  if (!streets.length) return;
  const localGraph = new Map<string, Set<string>>();
  for (const street of streets) for (const [a, b] of segments(street)) {
    const ka = nodeKey(a), kb = nodeKey(b);
    if (!localGraph.has(ka)) localGraph.set(ka, new Set());
    if (!localGraph.has(kb)) localGraph.set(kb, new Set());
    localGraph.get(ka)!.add(kb); localGraph.get(kb)!.add(ka);
  }
  const localReached = new Set<string>(), localQueue = [localGraph.keys().next().value!];
  for (let index = 0; index < localQueue.length; index++) {
    const key = localQueue[index];
    if (localReached.has(key)) continue;
    localReached.add(key);
    for (const next of localGraph.get(key)!) if (!localReached.has(next)) localQueue.push(next);
  }
  if (localReached.size === localGraph.size) return;
  // A planned town road is part of the same walkable network. Outer district
  // lanes may meet it between authored control points without duplicating its
  // geometry in the generated patch.
  const guides = [...streets, ...authoredRoads.filter(road => road.tags.some(tag =>
    ['town-internal', 'town-access', 'local_street', 'local_lane'].includes(tag)))];
  const pieces = guides.map((guide, index) => segments(guide).map(([a, b]) => index < streets.length
    ? [[a[0] + town.center[0], a[1] + town.center[1]],
      [b[0] + town.center[0], b[1] + town.center[1]]] as [Point, Point] : [a, b]));
  const adjacent = guides.map(() => new Set<number>());
  for (let left = 0; left < guides.length; left++) for (let right = left + 1; right < guides.length; right++) {
    const localPair = left < streets.length && right < streets.length;
    const connected = localPair
      ? guides[left].points.some(point => guides[right].points.some(other => nodeKey(point) === nodeKey(other)))
      : pieces[left].some(([a, b]) => pieces[right].some(([c, d]) => segmentIntersection(a, b, c, d)));
    if (connected) { adjacent[left].add(right); adjacent[right].add(left); }
  }
  const reached = new Set<number>([0]), queue = [0];
  for (let index = 0; index < queue.length; index++) for (const next of adjacent[queue[index]]) {
    if (reached.has(next)) continue;
    reached.add(next); queue.push(next);
  }
  if (streets.some((_, index) => !reached.has(index))) fail('world_streets_disconnected');
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
      const points = worldRoadPolyline(street).map(point => [point[0] + town.center[0], point[1] + town.center[1]] as Point);
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
    if (roadTargetWeight > 0) {
      height += (roadTarget / roadTargetWeight - height) * roadInfluence;
      height = sample.height + Math.max(-MAX_BUILDING_CUT_FILL + TOLERANCE,
        Math.min(MAX_BUILDING_CUT_FILL - TOLERANCE, height - sample.height));
    }
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
    if (padWeight > 0) height = sample.height + Math.max(-MAX_BUILDING_CUT_FILL + TOLERANCE,
      Math.min(MAX_BUILDING_CUT_FILL - TOLERANCE, height - sample.height));
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
  const construction = deriveCheckedWorldRouteConstruction(checked.plan);
  const context = createWorldTerrainContext(construction.terrainBrushes.length ? {
    ...checked.plan.recipe,
    terrainBrushes: [...(checked.plan.recipe.terrainBrushes ?? []), ...construction.terrainBrushes]
  } : checked.plan.recipe);
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
    // Explicit bridge decks are elevated structures, not roads painted onto the sampled ground.
    if (road.tags.some(tag => /bridge/i.test(tag))) continue;
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

export function worldTownContainsPoint(town: TownIntent, point: Point, margin = 0): boolean {
  if (Math.abs(point[0]) <= town.radius - margin + TOLERANCE
    && Math.abs(point[1]) <= town.radius - margin + TOLERANCE) return true;
  return town.districts?.some(district => Math.hypot(
    point[0] - district.offset[0], point[1] - district.offset[1]
  ) <= district.radius - margin + TOLERANCE) ?? false;
}

export function worldTownContainsBuilding(town: TownIntent, building: TownBuilding): boolean {
  const bounds = townBuildingBounds(building);
  if (Math.abs(bounds.x) + bounds.width / 2 <= town.radius + TOLERANCE
    && Math.abs(bounds.z) + bounds.depth / 2 <= town.radius + TOLERANCE) return true;
  const angle = building.rotation ?? 0, c = Math.cos(angle), s = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([x, z]) => worldTownContainsPoint(town, [
    building.x + c * x * building.width / 2 + s * z * building.depth / 2,
    building.z - s * x * building.width / 2 + c * z * building.depth / 2
  ]));
}

/** Exact Y-rotated footprint test. Touching the padded boundary is safe for a road ending at an entrance. */
export function segmentBuildingFootprint(a: Point, b: Point, building: TownBuilding, padding = 0): boolean {
  const rotation = building.rotation ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
  const local = (point: Point): Point => {
    const x = point[0] - building.x, z = point[1] - building.z;
    return [c * x - s * z, s * x + c * z];
  };
  return segmentBox(local(a), local(b), {
    x: 0,
    z: 0,
    width: building.width,
    depth: building.depth
  }, Math.max(0, padding - TOLERANCE * 2));
}

/** Exact overlap for two Y-rotated rectangular footprints. */
export function buildingsOverlap(a: TownBuilding, b: TownBuilding): boolean {
  const edges = (building: TownBuilding): Array<[Point, Point]> => {
    const rotation = building.rotation ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
    const world = (x: number, z: number): Point => [building.x + c * x + s * z, building.z - s * x + c * z];
    const corners = [world(-building.width / 2, -building.depth / 2), world(building.width / 2, -building.depth / 2),
      world(building.width / 2, building.depth / 2), world(-building.width / 2, building.depth / 2)];
    return corners.map((point, index) => [point, corners[(index + 1) % corners.length]]);
  };
  return edges(a).some(([from, to]) => segmentBuildingFootprint(from, to, b))
    || edges(b).some(([from, to]) => segmentBuildingFootprint(from, to, a));
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
