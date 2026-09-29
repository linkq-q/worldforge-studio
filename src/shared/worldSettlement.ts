import type { MapGuide } from './mapGuide';
import { createUrbanLayout, type UrbanPoint, type UrbanRoad } from './mapUrbanLayout';
import {
  createTownTasks, segmentBox, segmentBuildingFootprint, townBuildingBounds, validateTownPatch, worldPlanKey, worldTownBuildingQuota,
  type TownBuilding, type TownIntent, type TownPatch, type WorldPlan
} from './worldPlanning';
import { sampleWorldSlope, type WorldSample, type WorldSampler } from './worldTerrain';

export type WorldSettlementSampler = WorldSampler;
export type WorldSettlementKind = 'city' | 'village';
export type WorldSettlementPattern = 'organic' | 'grid';

export interface WorldSettlementOptions {
  kind: WorldSettlementKind;
  pattern?: WorldSettlementPattern;
  /** Authored anchors such as cathedrals or caravanserais. Ordinary growth reserves their footprints. */
  landmarks?: TownBuilding[];
  seed?: number;
  /** Occupancy multiplier. City and village presets still provide their own base density. */
  density?: number;
  /** Preference for a shore-following arterial when usable water lies inside the town core. */
  waterfrontBias?: number;
  /** Maximum rise/run accepted anywhere on a road. */
  maxRoadSlope?: number;
  /** Maximum rise/run accepted under a building footprint. */
  maxSiteSlope?: number;
  /** Dry clearance sampled around roads and building footprints. */
  waterSetback?: number;
}

export interface WorldSettlementAudit {
  roadSurfaceArea: number;
  builtFootprintArea: number;
  buildingCount: number;
  roadWidthRange: [number, number];
  maxRoadSlope: number;
  maxBuildingSlope: number;
}
export type WorldLandmarkRequirement = Omit<TownBuilding, 'x' | 'z' | 'rotation'>;

type Point = [number, number];
type Edge = { a: Point; b: Point; kind: UrbanRoad['kind']; source: string };
type Settings = Required<WorldSettlementOptions> & {
  roadWidth: number;
  arterialWidth: number;
  blockSize: number;
  parcelWidth: number;
  parcelDepth: number;
  buildingGap: number;
  roadBudget: number;
};
type Shore = { point: Point; tangent: Point; waterDistance: number };

const EPS = 1e-6;
const TAU = Math.PI * 2;
const MAX_LOCAL_EARTHWORK = 1.5;
const LANDMARK_SITE_ATTEMPT_LIMIT = 24;

/**
 * Builds one deterministic TownPatch from the shared urban geometry kernel, then adapts it to sampled terrain.
 * City and village use the same growth path; presets only change scale and occupancy.
 */
export function generateWorldSettlement(
  plan: WorldPlan,
  townId: string,
  sample: WorldSettlementSampler,
  options: WorldSettlementOptions
): TownPatch {
  if (typeof sample !== 'function') throw new Error('world_settlement_invalid_sampler');
  const task = createTownTasks(plan).find(candidate => candidate.town.id === townId);
  if (!task) throw new Error('world_settlement_unknown_town');
  const town = task.town;
  const settings = normalizeOptions(options, town, task.seed);
  const random = seededRandom(settings.seed);
  const landmarkBounds = settings.landmarks.map(townBuildingBounds);
  const slope = (point: Point) => sampleSlope(sample, town, point);
  const dry = (point: Point, clearance = 0) => dryPoint(sample, town, point, clearance);
  const terrainRoadSafe = (a: Point, b: Point, width: number) => segmentSafe(
    sample, town, a, b, width, settings.waterSetback, settings.maxRoadSlope
  );
  const roadSafe = (a: Point, b: Point, width: number) => terrainRoadSafe(a, b, width)
    && landmarkBounds.every(bounds => !segmentBox(a, b, bounds, width / 2 + 1));

  const site = selectSite(town, dry, slope);
  if (!site) throw new Error('world_settlement_no_buildable_site');
  const shore = settings.waterfrontBias > 0
    ? findShore(town, sample, site, settings.waterSetback + settings.arterialWidth / 2)
    : undefined;
  const rotation = shore
    ? Math.atan2(shore.tangent[1], shore.tangent[0])
    : contourAngle(sample, town, site, random);
  const region = Array.from({ length: 16 }, (_, index): Point => {
    const angle = index / 16 * TAU;
    return [Math.cos(angle) * town.radius * 0.84, Math.sin(angle) * town.radius * 0.84];
  });
  const layout = createUrbanLayout({
    id: `${town.id}-fabric`, pattern: settings.pattern, center: site,
    size: [town.radius * 1.58, town.radius * 1.58], region,
    rotation: rotation * 180 / Math.PI, blockSize: settings.blockSize,
    roadWidth: settings.roadWidth, arterialWidth: settings.arterialWidth,
    parcelWidth: settings.parcelWidth, parcelDepth: settings.parcelDepth,
    setback: 1, irregularity: settings.pattern === 'organic' ? 0.72 : 0.42, seed: settings.seed
  }, { minX: -town.radius, maxX: town.radius, minZ: -town.radius, maxZ: town.radius });

  const candidates = safeUrbanEdges(layout.roads, roadSafe);
  const reserved = town.ports.length + settings.landmarks.length + (shore ? 2 : 0);
  const selected = connectedEdges(candidates, shore?.point ?? site, Math.max(1, settings.roadBudget - reserved), random);
  if (!selected.length) throw new Error('world_settlement_no_buildable_network');

  const streets: MapGuide[] = selected.map((edge, index) => guide(
    `${town.id}-street-${index + 1}`, [edge.a, edge.b],
    edge.kind === 'arterial' ? settings.arterialWidth : settings.roadWidth,
    ['settlement', settings.kind, edge.kind]
  ));

  if (shore) {
    const shorePoints = traceShore(shore, town, sample, settings, roadSafe);
    if (shorePoints.length >= 2) {
      const shoreRoad = guide(`${town.id}-waterfront`, shorePoints, settings.arterialWidth,
        ['settlement', settings.kind, 'arterial', 'waterfront']);
      const link = routeToNetwork(shorePoints[Math.floor(shorePoints.length / 2)], roadNodes(streets), roadSafe, settings.roadWidth);
      if (link) {
        streets.push(shoreRoad);
        if (link.length > 1 && !same(link[0], link.at(-1)!)) {
          streets.push(guide(`${town.id}-waterfront-link`, link, settings.roadWidth,
            ['settlement', settings.kind, 'street']));
        }
      }
    }
  }

  for (const port of town.ports) {
    const portSafe = (a: Point, b: Point, width: number) => {
      const length = distance(a, b);
      if (length < EPS) return false;
      const clearance = settings.waterSetback + width / 2 + 0.1;
      const inset = (endpoint: Point, other: Point): Point => {
        let fraction = 0;
        for (let axis = 0; axis < 2; axis++) {
          if (Math.abs(Math.abs(endpoint[axis]) - town.radius) > EPS) continue;
          const inward = Math.abs(other[axis] - endpoint[axis]);
          if (inward < EPS) return endpoint;
          fraction = Math.max(fraction, clearance / inward);
        }
        return fraction > 0 ? mix(endpoint, other, Math.min(0.45, fraction)) : endpoint;
      };
      const from = same(a, port.position) ? inset(a, b) : a;
      const to = same(b, port.position) ? inset(b, a) : b;
      return roadSafe(from, to, width);
    };
    let route = routeToNetwork(port.position, roadNodes(streets), portSafe, port.width);
    if (!route) throw new Error(`world_settlement_port_unreachable:${port.id}`);
    if (route.length === 1) {
      const alreadyConnected = streets.some(street => street.width === port.width
        && [street.points[0], street.points.at(-1)!].some(point => same(point, port.position)));
      if (!alreadyConnected) route = routeToNetwork(port.position, roadNodes(streets).filter(point => !same(point, port.position)), portSafe, port.width);
      if (!route) throw new Error(`world_settlement_port_unreachable:${port.id}`);
    }
    if (route.length > 1) streets.push(guide(`${town.id}-port-${port.id}`, route, port.width,
      ['settlement', settings.kind, 'arterial', 'port']));
  }
  for (let landmarkIndex = 0; landmarkIndex < settings.landmarks.length; landmarkIndex++) {
    const landmark = settings.landmarks[landmarkIndex];
    const accessSafe = (a: Point, b: Point, width: number) => terrainRoadSafe(a, b, width)
      && landmarkBounds.every((bounds, index) => index === landmarkIndex
        ? !segmentBuildingFootprint(a, b, landmark, width / 2)
        : !segmentBox(a, b, bounds, width / 2 + 1));
    const entry = landmarkEntry(landmark, settings.roadWidth);
    const direction: Point = [Math.sin(landmark.rotation ?? 0), Math.cos(landmark.rotation ?? 0)];
    const outside = add(entry, scale(direction, landmarkAccessLength(settings.blockSize)));
    const tailSafe = (a: Point, b: Point, width: number) => terrainRoadSafe(a, b, width)
      && landmarkBounds.every((bounds, index) => index === landmarkIndex
        ? !segmentBuildingFootprint(a, b, landmark, width / 2)
        : !segmentBox(a, b, bounds, width / 2 + 1));
    const roadside = insertRoadNodeAt(streets, outside);
    const tail = roadside ? [roadside] : routeToNetwork(outside, roadNodes(streets), tailSafe, settings.roadWidth);
    const route = tail && accessSafe(entry, tail[0], settings.roadWidth) ? [entry, ...tail] : undefined;
    if (!route) {
      const reason = !tail ? 'network'
        : !terrainRoadSafe(entry, tail[0], settings.roadWidth) ? 'terrain'
          : 'footprint';
      throw new Error(`world_settlement_landmark_unreachable:${landmark.id}:${reason}`);
    }
    if (route.length > 1) streets.push(guide(`${town.id}-landmark-${landmark.id}`, route, settings.roadWidth,
      ['settlement', settings.kind, 'street', 'landmark-access']));
  }
  if (streets.length > 48) throw new Error('world_settlement_road_budget');
  splitRoadIntersections(streets);

  const buildings = placeBuildings(plan, town, streets, sample, settings, random);
  if (!buildings.length) throw new Error('world_settlement_no_buildings');
  const patch: TownPatch = {
    townId: town.id,
    worldKey: worldPlanKey(plan),
    summary: `${settings.kind} settlement grown from ${settings.pattern} streets; ${streets.length} roads and ${buildings.length} buildings`,
    streets,
    buildings
  };
  return validateTownPatch(plan, patch);
}

export interface WorldLandmarkResolution {
  id: string;
  from: Point;
  to: Point;
  reason: string;
}

/** Places authored public functions on sampled, reachable street frontage without asking a model for coordinates. */
export function createWorldSettlementLandmarkLayout(
  plan: WorldPlan,
  townId: string,
  sample: WorldSettlementSampler,
  options: Omit<WorldSettlementOptions,'landmarks'>,
  requirements: readonly WorldLandmarkRequirement[]
): { landmarks:TownBuilding[]; patch:TownPatch } {
  const town=plan.towns.find(item=>item.id===townId);
  if(!town) throw new Error('world_settlement_unknown_town');
  const landmarks:TownBuilding[]=[];
  let patch=generateWorldSettlement(plan,townId,sample,{...options,landmarks});
  for(const requirement of requirements) {
    let next:TownPatch|undefined,resolved:TownBuilding|undefined;
    const failures=new Set<string>();
    for(const candidate of boundedLandmarkSites(frontageLandmarkSites(requirement,patch.streets,town,options.kind))) {
      try {
        next=generateWorldSettlement(plan,townId,sample,{...options,landmarks:[...landmarks,candidate]});
        resolved=candidate;break;
      } catch(error) {failures.add(error instanceof Error?error.message:String(error));}
    }
    if(!resolved||!next) throw new Error(`world_settlement_no_landmark_site:${requirement.id}:${[...failures].join('|')}`);
    landmarks.push(resolved);patch=next;
  }
  return {landmarks,patch};
}

function frontageLandmarkSites(requirement:WorldLandmarkRequirement,streets:MapGuide[],town:TownIntent,kind:WorldSettlementKind):TownBuilding[] {
  const points:TownBuilding[]=[],roadWidth=kind==='city'?4.2:3;
  const blockSize=Math.max(kind==='city'?34:52,Math.min(kind==='city'?76:110,town.radius*(kind==='city'?.22:.32)));
  for(const street of streets) for(let segment=1;segment<street.points.length;segment++) {
    const a=street.points[segment-1],b=street.points[segment],delta=sub(b,a),length=distance(a,b);
    if(length<EPS) continue;
    const tangent=scale(delta,1/length),normal:Point=[-tangent[1],tangent[0]],steps=Math.max(1,Math.ceil(length/8));
    for(let index=0;index<=steps;index++) for(const side of [-1,1]) {
      const roadPoint=mix(a,b,index/steps),direction=scale(normal,-side),rotation=normalizeAngle(Math.atan2(direction[0],direction[1]));
      const setback=requirement.depth/2+roadWidth/2+landmarkAccessLength(blockSize);
      points.push({...requirement,x:roundPoint(roadPoint[0]-direction[0]*setback),
        z:roundPoint(roadPoint[1]-direction[1]*setback),rotation});
    }
  }
  const unique=new Map(points.map(item=>[`${item.x.toFixed(6)},${item.z.toFixed(6)},${(item.rotation??0).toFixed(6)}`,item]));
  return [...unique.values()].sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z)||a.x-b.x||a.z-b.z);
}

/** Keeps authored landmark program/rotation while resolving an unreachable preferred position nearby. */
export function resolveWorldSettlementLandmarks(
  plan: WorldPlan,
  townId: string,
  sample: WorldSettlementSampler,
  options: WorldSettlementOptions
): { options: WorldSettlementOptions; resolutions: WorldLandmarkResolution[] } {
  const town=plan.towns.find(item=>item.id===townId);
  if(!town) throw new Error('world_settlement_unknown_town');
  if(!options.landmarks?.length) return {options,resolutions:[]};
  const landmarks:TownBuilding[]=[],resolutions:WorldLandmarkResolution[]=[];
  let patch=generateWorldSettlement(plan,townId,sample,{...options,landmarks:[]});
  for(const authored of options.landmarks) {
    const preferred:[number,number]=[authored.x,authored.z];
    const sites=boundedLandmarkSites([preferred,...nearbyLandmarkSites(preferred,authored,town.radius,patch.streets,options.kind)]);
    const unique=new Map(sites.map(point=>[pointKey(point),point]));
    let resolved:TownBuilding|undefined,next:TownPatch|undefined,reason='world_settlement_invalid_landmark:'+authored.id;
    const failures=new Set<string>();
    for(const point of unique.values()) {
      const candidate={...authored,x:point[0],z:point[1]};
      try {
        next=generateWorldSettlement(plan,townId,sample,{...options,landmarks:[...landmarks,candidate]});
        resolved=candidate;break;
      } catch(error) {const message=error instanceof Error?error.message:String(error);failures.add(message);if(point===preferred) reason=message;}
    }
    if(!resolved||!next) throw new Error(`world_settlement_no_landmark_site:${authored.id}:${[...failures].join('|')||reason}`);
    landmarks.push(resolved);patch=next;
    if(resolved.x!==authored.x||resolved.z!==authored.z) resolutions.push({id:resolved.id,from:preferred,to:[resolved.x,resolved.z],reason});
  }
  return {options:{...options,landmarks},resolutions};
}

function nearbyLandmarkSites(preferred:Point,landmark:TownBuilding,townRadius:number,streets:MapGuide[],kind:WorldSettlementKind):Point[] {
  const limit=townRadius*.25,step=Math.max(4,Math.min(landmark.width,landmark.depth)*.3),points:Point[]=[];
  const direction:Point=[Math.sin(landmark.rotation??0),Math.cos(landmark.rotation??0)];
  const roadWidth=kind==='city'?4.2:3,blockSize=Math.max(kind==='city'?34:52,Math.min(kind==='city'?76:110,townRadius*(kind==='city'?.22:.32)));
  const setback=landmark.depth/2+roadWidth/2+landmarkAccessLength(blockSize);
  for(const street of streets) for(let segment=1;segment<street.points.length;segment++) {
    const a=street.points[segment-1],b=street.points[segment],length=distance(a,b),steps=Math.max(1,Math.ceil(length/8));
    for(let index=0;index<=steps;index++) {
      const roadPoint=mix(a,b,index/steps),point:Point=[roundPoint(roadPoint[0]-direction[0]*setback),roundPoint(roadPoint[1]-direction[1]*setback)];
      if(Math.max(Math.abs(point[0]-preferred[0]),Math.abs(point[1]-preferred[1]))<=limit+EPS) points.push(point);
    }
  }
  for(let z=-limit;z<=limit+EPS;z+=step) for(let x=-limit;x<=limit+EPS;x+=step) {
    points.push([roundPoint(preferred[0]+x),roundPoint(preferred[1]+z)]);
  }
  const unique=new Map(points.map(point=>[pointKey(point),point]));
  return [...unique.values()].sort((a,b)=>distance(a,preferred)-distance(b,preferred)||a[0]-b[0]||a[1]-b[1]);
}

function boundedLandmarkSites<T>(sites: readonly T[]): T[] {
  if (sites.length <= LANDMARK_SITE_ATTEMPT_LIMIT) return [...sites];
  const nearby = Math.min(12, LANDMARK_SITE_ATTEMPT_LIMIT), result = sites.slice(0, nearby);
  const spread = LANDMARK_SITE_ATTEMPT_LIMIT - nearby, remaining = sites.length - nearby;
  for (let index = 0; index < spread; index++) {
    result.push(sites[nearby + Math.floor(index * remaining / spread)]);
  }
  return result;
}

/** Recomputes review metrics from delivered geometry; diagnostics are deliberately not persisted in TownPatch. */
export function auditWorldSettlement(
  patch: TownPatch,
  town: TownIntent,
  sample: WorldSettlementSampler
): WorldSettlementAudit {
  if (!patch.streets.length) throw new Error('world_settlement_audit_no_roads');
  const widths = patch.streets.map(road => road.width);
  let roadSurfaceArea = 0;
  let maxRoadSlope = 0;
  for (const road of patch.streets) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i];
    const length = distance(a, b);
    roadSurfaceArea += length * road.width;
    const steps = Math.max(1, Math.ceil(length / 8));
    for (let step = 0; step <= steps; step++) {
      const point = mix(a, b, step / steps);
      maxRoadSlope = Math.max(maxRoadSlope, sampleSlope(sample, town, point));
    }
  }
  let maxBuildingSlope = 0;
  for (const building of patch.buildings) {
    const points = buildingProbePoints(building);
    for (const point of points) maxBuildingSlope = Math.max(maxBuildingSlope, sampleSlope(sample, town, point));
  }
  return {
    roadSurfaceArea,
    builtFootprintArea: patch.buildings.reduce((sum, building) => sum + building.width * building.depth, 0),
    buildingCount: patch.buildings.length,
    roadWidthRange: [Math.min(...widths), Math.max(...widths)],
    maxRoadSlope,
    maxBuildingSlope
  };
}

function normalizeOptions(options: WorldSettlementOptions, town: TownIntent, fallbackSeed: number): Settings {
  if (!options || !['city', 'village'].includes(options.kind)
    || (options.pattern !== undefined && !['organic', 'grid'].includes(options.pattern))) {
    throw new Error('world_settlement_invalid_options');
  }
  const city = options.kind === 'city';
  const number = (value: number | undefined, fallback: number, min: number, max: number, code: string) => {
    const result = value ?? fallback;
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(code);
    return result;
  };
  const density = number(options.density, city ? 0.82 : 0.38, 0.05, 1, 'world_settlement_invalid_density');
  return {
    kind: options.kind,
    pattern: options.pattern ?? 'organic',
    seed: Math.trunc(number(options.seed, fallbackSeed, 0, Number.MAX_SAFE_INTEGER, 'world_settlement_invalid_seed')),
    density,
    landmarks: options.landmarks?.map(building => ({ ...building })) ?? [],
    waterfrontBias: number(options.waterfrontBias, city ? 0.8 : 0.55, 0, 1, 'world_settlement_invalid_waterfront_bias'),
    maxRoadSlope: number(options.maxRoadSlope, city ? 0.18 : 0.24, 0.01, 0.5, 'world_settlement_invalid_road_slope'),
    maxSiteSlope: number(options.maxSiteSlope, city ? 0.14 : 0.2, 0.01, 0.5, 'world_settlement_invalid_site_slope'),
    waterSetback: number(options.waterSetback, city ? 7 : 5, 0, town.radius / 2, 'world_settlement_invalid_water_setback'),
    roadWidth: city ? 4.2 : 3,
    arterialWidth: city ? 6.4 : 4.6,
    blockSize: Math.max(city ? 34 : 52, Math.min(city ? 76 : 110, town.radius * (city ? 0.22 : 0.32))),
    parcelWidth: city ? 8 : 9,
    parcelDepth: city ? 8.5 : 10,
    buildingGap: city ? 1.2 : 7,
    roadBudget: city ? Math.round(24 + density * 10) : Math.max(7, Math.round(6 + density * 8))
  };
}

function selectSite(
  town: TownIntent,
  dry: (point: Point, clearance?: number) => boolean,
  slope: (point: Point) => number
): Point | undefined {
  let best: { point: Point; score: number } | undefined;
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    const point: Point = [x * town.radius * 0.1, z * town.radius * 0.1];
    if (!dry(point, 3)) continue;
    const grade = slope(point);
    const score = grade * town.radius * 5 + Math.hypot(...point);
    if (!best || score < best.score) best = { point, score };
  }
  return best?.point;
}

function findShore(
  town: TownIntent,
  sample: WorldSettlementSampler,
  center: Point,
  clearance: number
): Shore | undefined {
  let best: { point: Point; direction: Point; distance: number; score: number } | undefined;
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    const point: Point = [center[0] + x * town.radius * 0.1, center[1] + z * town.radius * 0.1];
    if (!inside(town, point, clearance) || wet(sampleAt(sample, town, point))) continue;
    const water = nearestWater(sample, town, point, Math.min(180, town.radius * 0.58));
    if (!water || water.distance < clearance) continue;
    const score = water.distance + sampleSlope(sample, town, point) * town.radius * 2;
    if (!best || score < best.score) best = { point, direction: water.direction, distance: water.distance, score };
  }
  if (!best) return undefined;
  return { point: best.point, tangent: normalize([-best.direction[1], best.direction[0]]), waterDistance: best.distance };
}

function nearestWater(
  sample: WorldSettlementSampler,
  town: TownIntent,
  point: Point,
  reach: number
): { direction: Point; distance: number } | undefined {
  let best: { direction: Point; distance: number } | undefined;
  const step = Math.max(4, Math.min(10, reach / 12));
  for (let direction = 0; direction < 16; direction++) {
    const angle = direction / 16 * TAU;
    const unit: Point = [Math.cos(angle), Math.sin(angle)];
    for (let distance = step; distance <= reach + EPS; distance += step) {
      const probe = add(point, scale(unit, distance));
      if (!inside(town, probe, 0)) break;
      if (wet(sampleAt(sample, town, probe))) {
        if (!best || distance < best.distance) best = { direction: unit, distance };
        break;
      }
    }
  }
  return best;
}

function contourAngle(sample: WorldSettlementSampler, town: TownIntent, point: Point, random: () => number): number {
  const epsilon = 8;
  const x = town.center[0] + point[0], z = town.center[1] + point[1];
  const dx = sample(x + epsilon, z).height - sample(x - epsilon, z).height;
  const dz = sample(x, z + epsilon).height - sample(x, z - epsilon).height;
  return Math.hypot(dx, dz) > EPS ? Math.atan2(dx, -dz) : random() * Math.PI;
}

function safeUrbanEdges(
  roads: UrbanRoad[],
  safe: (a: Point, b: Point, width: number) => boolean
): Edge[] {
  const result: Edge[] = [];
  const seen = new Set<string>();
  for (const road of roads) for (let index = 1; index < road.points.length; index++) {
    const a = road.points[index - 1], b = road.points[index];
    if (distance(a, b) < EPS || !safe(a, b, road.width)) continue;
    const ends = [pointKey(a), pointKey(b)].sort();
    const key = ends.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ a: [...a], b: [...b], kind: road.kind, source: road.id });
  }
  return result;
}

function connectedEdges(edges: Edge[], anchor: Point, budget: number, random: () => number): Edge[] {
  if (!edges.length || budget <= 0) return [];
  const byNode = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    for (const point of [edge.a, edge.b]) {
      const key = pointKey(point);
      const list = byNode.get(key) ?? [];
      list.push(index);
      byNode.set(key, list);
    }
  });
  const components: number[][] = [];
  const remaining = new Set(edges.map((_, index) => index));
  while (remaining.size) {
    const start = remaining.values().next().value as number;
    const component: number[] = [], queue = [start];
    remaining.delete(start);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const edgeIndex = queue[cursor];
      component.push(edgeIndex);
      for (const point of [edges[edgeIndex].a, edges[edgeIndex].b]) for (const next of byNode.get(pointKey(point)) ?? []) {
        if (remaining.delete(next)) queue.push(next);
      }
    }
    components.push(component);
  }
  const component = components.sort((left, right) => {
    const score = (list: number[]) => list.length * 10 - Math.min(...list.flatMap(index => [
      distance(edges[index].a, anchor), distance(edges[index].b, anchor)
    ])) / 100;
    return score(right) - score(left);
  })[0];
  const allowed = new Set(component);
  const nodes = [...new Set(component.flatMap(index => [pointKey(edges[index].a), pointKey(edges[index].b)]))];
  const startNode = nodes.reduce((best, key) => distance(parsePoint(key), anchor) < distance(parsePoint(best), anchor) ? key : best);
  const reached = new Set([startNode]);
  const selected: number[] = [];
  const noise = new Map(component.map(index => [index, random() * 8]));
  const frontier = [...(byNode.get(startNode) ?? [])].filter(index => allowed.has(index));
  while (frontier.length && selected.length < budget) {
    frontier.sort((a, b) => edgePriority(edges[a], anchor, noise.get(a)!) - edgePriority(edges[b], anchor, noise.get(b)!));
    const edgeIndex = frontier.shift()!;
    if (selected.includes(edgeIndex)) continue;
    const edge = edges[edgeIndex], ka = pointKey(edge.a), kb = pointKey(edge.b);
    if (!reached.has(ka) && !reached.has(kb)) continue;
    selected.push(edgeIndex);
    for (const key of [ka, kb]) if (!reached.has(key)) {
      reached.add(key);
      frontier.push(...(byNode.get(key) ?? []).filter(index => allowed.has(index)));
    }
  }
  return selected.map(index => edges[index]);
}

function edgePriority(edge: Edge, anchor: Point, noise: number): number {
  return Math.min(distance(edge.a, anchor), distance(edge.b, anchor)) + noise - (edge.kind === 'arterial' ? 12 : 0);
}

function traceShore(
  shore: Shore,
  town: TownIntent,
  sample: WorldSettlementSampler,
  settings: Settings,
  safe: (a: Point, b: Point, width: number) => boolean
): Point[] {
  const desired = Math.max(settings.waterSetback + settings.arterialWidth / 2 + 2, shore.waterDistance);
  const step = Math.max(18, Math.min(settings.blockSize * 0.72, 48));
  const extend = (direction: Point): Point[] => {
    const points: Point[] = [];
    let current = shore.point, heading = direction;
    for (let count = 0; count < 5; count++) {
      let best: { point: Point; heading: Point; score: number } | undefined;
      for (const turn of [-0.42, -0.2, 0, 0.2, 0.42]) {
        const nextHeading = rotate(heading, turn);
        const next = add(current, scale(nextHeading, step));
        if (!inside(town, next, settings.arterialWidth / 2) || !safe(current, next, settings.arterialWidth)) continue;
        const water = nearestWater(sample, town, next, Math.min(180, town.radius * 0.58));
        if (!water) continue;
        const score = Math.abs(water.distance - desired) + sampleSlope(sample, town, next) * 80 + Math.abs(turn) * 6;
        if (!best || score < best.score) best = { point: next, heading: nextHeading, score };
      }
      if (!best) break;
      points.push(best.point);
      current = best.point;
      heading = best.heading;
    }
    return points;
  };
  return [...extend(scale(shore.tangent, -1)).reverse(), shore.point, ...extend(shore.tangent)];
}

function routeToNetwork(
  start: Point,
  nodes: Point[],
  safe: (a: Point, b: Point, width: number) => boolean,
  width: number
): Point[] | undefined {
  if (nodes.some(node => same(start, node))) return [start];
  const nearest = [...nodes].sort((a, b) => distance(start, a) - distance(start, b)).slice(0, 20);
  let best: Point[] | undefined;
  for (const end of nearest) {
    const middle = mix(start, end, 0.5), delta = sub(end, start), normal = normalize([-delta[1], delta[0]]);
    const offset = Math.min(24, distance(start, end) * 0.25);
    const routes: Point[][] = [
      [start, end],
      [start, [start[0], end[1]], end],
      [start, [end[0], start[1]], end],
      [start, add(middle, scale(normal, offset)), end],
      [start, add(middle, scale(normal, -offset)), end]
    ];
    for (const route of routes) {
      const clean = route.filter((point, index) => index === 0 || !same(point, route[index - 1]));
      if (clean.length < 2 || !clean.slice(1).every((point, index) => safe(clean[index], point, width))) continue;
      if (!best || pathLength(clean) < pathLength(best)) best = clean;
    }
    if (best && pathLength(best) <= distance(start, end) * 1.25 + EPS) break;
  }
  return best;
}

function placeBuildings(
  plan: WorldPlan,
  town: TownIntent,
  streets: MapGuide[],
  sample: WorldSettlementSampler,
  settings: Settings,
  random: () => number
): TownBuilding[] {
  const result: TownBuilding[] = settings.landmarks.map(building => ({ ...building }));
  const city = settings.kind === 'city';
  const areaBudget = Math.floor((2 * town.radius) ** 2 / (city ? 600 : 3_000) * settings.density);
  const target = Math.min(worldTownBuildingQuota(town), Math.max(city ? 24 : 8, areaBudget));
  const localRoads = streets.flatMap(road => road.points.slice(1).map((b, index) => ({ a: road.points[index], b, width: road.width, road })));
  const worldRoads = plan.roads.flatMap(road => road.points.slice(1).map((b, index) => ({ a: road.points[index], b, width: road.width })));
  const candidateSegments = localRoads.filter(segment => !segment.road.tags.includes('port'))
    .sort((a, b) => distance(mix(a.a, a.b, 0.5), [0, 0]) - distance(mix(b.a, b.b, 0.5), [0, 0]));
  const uses = city ? ['home', 'home', 'shop', 'workshop'] : ['home', 'home', 'farmhouse', 'workshop'];
  for (const landmark of result) {
    const bounds = townBuildingBounds(landmark);
    const probes = buildingProbePoints(landmark);
    if (Math.abs(bounds.x) + bounds.width / 2 > town.radius || Math.abs(bounds.z) + bounds.depth / 2 > town.radius
      || !buildingEarthworkSafe(sample, town, landmark)
      || probes.some(point => !dryPoint(sample, town, point, settings.waterSetback)
        || sampleSlope(sample, town, point) > settings.maxSiteSlope + EPS)
      || localRoads.some(road => road.road.id === `${town.id}-landmark-${landmark.id}`
        && road.road.tags.includes('landmark-access')
        ? segmentBuildingFootprint(road.a, road.b, landmark, road.width / 2)
        : segmentBox(road.a, road.b, bounds, road.width / 2))) {
      throw new Error(`world_settlement_invalid_landmark:${landmark.id}`);
    }
    const worldBounds = { ...bounds, x: bounds.x + town.center[0], z: bounds.z + town.center[1] };
    if (worldRoads.some(road => segmentBox(road.a, road.b, worldBounds, road.width / 2))) {
      throw new Error(`world_settlement_invalid_landmark:${landmark.id}`);
    }
  }
  for (let left = 0; left < result.length; left++) for (let right = left + 1; right < result.length; right++) {
    if (boxesOverlap(townBuildingBounds(result[left]), townBuildingBounds(result[right]))) {
      throw new Error('world_settlement_landmarks_overlap');
    }
  }
  const canPlace = (building: TownBuilding): boolean => {
    const bounds = townBuildingBounds(building);
    if (Math.abs(bounds.x) + bounds.width / 2 > town.radius || Math.abs(bounds.z) + bounds.depth / 2 > town.radius) return false;
    const probes = buildingProbePoints(building);
    if (!buildingEarthworkSafe(sample, town, building)
      || probes.some(point => !dryPoint(sample, town, point, settings.waterSetback)
      || sampleSlope(sample, town, point) > settings.maxSiteSlope + EPS)) return false;
    if (result.some(other => boxesOverlap(bounds, townBuildingBounds(other)))) return false;
    if (localRoads.some(road => segmentBox(road.a, road.b, bounds, road.width / 2 + 0.8))) return false;
    const worldBounds = { ...bounds, x: bounds.x + town.center[0], z: bounds.z + town.center[1] };
    return !worldRoads.some(road => segmentBox(road.a, road.b, worldBounds, road.width / 2 + 0.8));
  };
  for (let pass = 0; pass < 2 && result.length < target; pass++) for (const segment of candidateSegments) {
    const length = distance(segment.a, segment.b);
    const tangent = normalize(sub(segment.b, segment.a));
    const normal: Point = [-tangent[1], tangent[0]];
    const spacing = settings.parcelWidth + settings.buildingGap;
    const slots = Math.max(0, Math.floor((length - settings.parcelWidth) / spacing) + 1);
    for (let slot = pass; slot < slots && result.length < target; slot += 2) for (const side of [-1, 1]) {
      if (result.length >= target || random() > Math.min(1, settings.density * (pass ? 1.1 : 0.9))) continue;
      const width = settings.parcelWidth * (0.82 + random() * 0.28);
      const depth = settings.parcelDepth * (0.82 + random() * 0.28);
      const along = Math.min(length - width / 2, width / 2 + slot * spacing);
      if (along < width / 2) continue;
      const frontage = add(segment.a, scale(tangent, along));
      const rotation = normalizeAngle(Math.atan2(-normal[0] * side, -normal[1] * side));
      const height = city ? 10 + random() * 28 * (1.15 - Math.min(1, distance(frontage, [0, 0]) / town.radius)) : 5 + random() * 6;
      const use = uses[Math.floor(random() * uses.length)];
      for (const extra of [0, 2, 4, 7, 11, 16]) {
        const center = add(frontage, scale(normal, side * (segment.width / 2 + 1.2 + depth / 2 + extra)));
        const building: TownBuilding = {
          id: `${town.id}-building-${result.length + 1}`,
          x: center[0], z: center[1], width, depth, height, use, rotation
        };
        if (!canPlace(building)) continue;
        result.push(building);
        break;
      }
    }
  }
  if (city && result.length < target) {
    const step = 8.5, candidates: Array<{ point: Point; score: number }> = [];
    const phase: Point = [(random() - 0.5) * step, (random() - 0.5) * step];
    for (let z = -town.radius + step; z <= town.radius - step; z += step) {
      for (let x = -town.radius + step; x <= town.radius - step; x += step) {
        const point: Point = [x + phase[0] + (random() - 0.5) * 1.2, z + phase[1] + (random() - 0.5) * 1.2];
        candidates.push({ point, score: distance(point, [0, 0]) + random() * town.radius * 0.12 });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const { point } of candidates) {
      if (result.length >= target) break;
      const nearestRoad = Math.min(...localRoads.map(road => pointSegmentDistance(point, road.a, road.b)));
      if (!Number.isFinite(nearestRoad) || nearestRoad > settings.blockSize * 0.72) continue;
      const building: TownBuilding = {
        id: `${town.id}-building-${result.length + 1}`,
        x: point[0], z: point[1], width: 5.2 + random() * 0.9, depth: 5.5 + random() * 1.1,
        height: 9 + random() * 24 * (1.15 - Math.min(1, distance(point, [0, 0]) / town.radius)),
        use: uses[Math.floor(random() * uses.length)], rotation: (random() - 0.5) * 0.32
      };
      if (canPlace(building)) result.push(building);
    }
  }
  return result;
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const delta = sub(b, a), length2 = delta[0] ** 2 + delta[1] ** 2;
  const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * delta[0] + (point[1] - a[1]) * delta[1]) / length2)) : 0;
  return distance(point, add(a, scale(delta, t)));
}

function guide(id: string, points: Point[], width: number, tags: string[]): MapGuide {
  return { id, name: id, points: points.map(point => [...point]), curve: 'polyline', closed: false, width, tags };
}

function roadNodes(roads: MapGuide[]): Point[] {
  const result = new Map<string, Point>();
  for (const point of roads.flatMap(road => road.points)) result.set(pointKey(point), point);
  return [...result.values()];
}

function insertRoadNodeAt(streets: MapGuide[], point: Point): Point | undefined {
  for (const street of streets) for (let index = 1; index < street.points.length; index++) {
    const a = street.points[index - 1], b = street.points[index], delta = sub(b, a), length2 = delta[0] ** 2 + delta[1] ** 2;
    const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * delta[0] + (point[1] - a[1]) * delta[1]) / length2)) : 0;
    const projected: Point = [roundPoint(a[0] + delta[0] * t), roundPoint(a[1] + delta[1] * t)];
    if (distance(projected, point) > 0.0001) continue;
    if (same(projected, a)) return a;
    if (same(projected, b)) return b;
    street.points.splice(index, 0, projected);
    return projected;
  }
  return undefined;
}

function segmentSafe(
  sample: WorldSettlementSampler,
  town: TownIntent,
  a: Point,
  b: Point,
  width: number,
  waterSetback: number,
  maxSlope: number
): boolean {
  const length = distance(a, b);
  if (length < EPS) return false;
  const steps = Math.max(1, Math.ceil(length / 8));
  const startHeight = sampleAt(sample, town, a).height, endHeight = sampleAt(sample, town, b).height;
  for (let index = 0; index <= steps; index++) {
    const t = index / steps, point = mix(a, b, t);
    if (!inside(town, point, width / 2) || !dryPoint(sample, town, point, waterSetback + width / 2)
      || sampleSlope(sample, town, point) > maxSlope + EPS
      || Math.abs(sampleAt(sample, town, point).height - (startHeight + (endHeight - startHeight) * t)) > MAX_LOCAL_EARTHWORK) return false;
  }
  return true;
}

function dryPoint(sample: WorldSettlementSampler, town: TownIntent, point: Point, clearance: number): boolean {
  if (!inside(town, point, clearance) || wet(sampleAt(sample, town, point))) return false;
  if (clearance <= 0) return true;
  for (let index = 0; index < 8; index++) {
    const angle = index / 8 * TAU;
    if (wet(sampleAt(sample, town, add(point, [Math.cos(angle) * clearance, Math.sin(angle) * clearance])))) return false;
  }
  return true;
}

function wet(sample: WorldSample): boolean {
  return sample.waterLevel !== null;
}

function sampleAt(sample: WorldSettlementSampler, town: TownIntent, point: Point): WorldSample {
  return sample(town.center[0] + point[0], town.center[1] + point[1]);
}

function sampleSlope(sample: WorldSettlementSampler, town: TownIntent, point: Point, epsilon = 4): number {
  const x = town.center[0] + point[0], z = town.center[1] + point[1];
  return sampleWorldSlope(sample, x, z, epsilon);
}

function buildingProbePoints(building: TownBuilding): Point[] {
  const rotation = building.rotation ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]): Point => [
    building.x + c * x * building.width / 2 - s * z * building.depth / 2,
    building.z + s * x * building.width / 2 + c * z * building.depth / 2
  ]);
  return [[building.x, building.z], ...corners, ...corners.map((point, index) => mix(point, corners[(index + 1) % 4], 0.5))];
}

function buildingEarthworkSafe(sample: WorldSettlementSampler, town: TownIntent, building: TownBuilding): boolean {
  const heights = buildingProbePoints(building).map(point => sampleAt(sample, town, point).height).sort((a, b) => a - b);
  const target = heights[Math.floor(heights.length / 2)];
  return heights.every(height => Math.abs(height - target) <= MAX_LOCAL_EARTHWORK + EPS);
}

function boxesOverlap(a: Pick<TownBuilding, 'x' | 'z' | 'width' | 'depth'>, b: Pick<TownBuilding, 'x' | 'z' | 'width' | 'depth'>): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 0.5
    && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 + 0.5;
}

function landmarkAccessLength(blockSize: number): number {
  return Math.max(8, Math.min(12, blockSize / 4));
}

function landmarkEntry(building: TownBuilding, roadWidth: number): Point {
  const rotation = building.rotation ?? 0;
  const direction: Point = [Math.sin(rotation), Math.cos(rotation)];
  return add([building.x, building.z], scale(direction, building.depth / 2 + roadWidth / 2));
}

function splitRoadIntersections(streets: MapGuide[]): void {
  for (let repair = 0; repair < 128; repair++) {
    let found = false;
    outer: for (let left = 0; left < streets.length; left++) for (let right = left + 1; right < streets.length; right++) {
      for (let a = 1; a < streets[left].points.length; a++) for (let b = 1; b < streets[right].points.length; b++) {
        const intersection = properIntersection(
          streets[left].points[a - 1], streets[left].points[a],
          streets[right].points[b - 1], streets[right].points[b]
        );
        if (!intersection) continue;
        streets[left].points.splice(a, 0, intersection);
        streets[right].points.splice(b, 0, [...intersection]);
        found = true;
        break outer;
      }
    }
    if (!found) {
      // The graph validator deliberately compares authored junction coordinates exactly.
      // Canonicalize floating-point intersections and their pre-existing road vertices alike.
      for (const street of streets) street.points = street.points.map(point => [roundPoint(point[0]), roundPoint(point[1])]);
      return;
    }
  }
  throw new Error('world_settlement_intersection_budget');
}

function roundPoint(value: number): number { return Math.round(value * 1e6) / 1e6; }

function properIntersection(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  if ([a, b].some(point => [c, d].some(other => same(point, other)))) return undefined;
  const ab = sub(b, a), cd = sub(d, c), denominator = ab[0] * cd[1] - ab[1] * cd[0];
  if (Math.abs(denominator) < EPS) return undefined;
  const ac = sub(c, a);
  const t = (ac[0] * cd[1] - ac[1] * cd[0]) / denominator;
  const u = (ac[0] * ab[1] - ac[1] * ab[0]) / denominator;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS ? add(a, scale(ab, t)) : undefined;
}

function inside(town: TownIntent, point: Point, margin: number): boolean {
  return Math.abs(point[0]) <= town.radius - margin + EPS && Math.abs(point[1]) <= town.radius - margin + EPS;
}

function pointKey(point: Point): string { return `${point[0].toFixed(6)},${point[1].toFixed(6)}`; }
function parsePoint(key: string): Point { return key.split(',').map(Number) as Point; }
function same(a: Point, b: Point): boolean { return distance(a, b) <= EPS; }
function add(a: Point, b: Point): Point { return [a[0] + b[0], a[1] + b[1]]; }
function sub(a: Point, b: Point): Point { return [a[0] - b[0], a[1] - b[1]]; }
function scale(point: Point, value: number): Point { return [point[0] * value, point[1] * value]; }
function mix(a: Point, b: Point, t: number): Point { return add(a, scale(sub(b, a), t)); }
function distance(a: Point, b: Point): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function normalize(point: Point): Point { const length = Math.hypot(...point); return length < EPS ? [1, 0] : scale(point, 1 / length); }
function rotate(point: Point, angle: number): Point { const c = Math.cos(angle), s = Math.sin(angle); return [point[0] * c - point[1] * s, point[0] * s + point[1] * c]; }
function pathLength(points: Point[]): number { return points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0); }
function normalizeAngle(angle: number): number { while (angle > Math.PI) angle -= TAU; while (angle < -Math.PI) angle += TAU; return angle; }
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
