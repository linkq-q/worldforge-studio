import type { MapGuide } from './mapGuide';
import { createUrbanLayout, type UrbanLayout, type UrbanParcel, type UrbanPoint, type UrbanRoad } from './mapUrbanLayout';
import {
  buildingsOverlap, createTownTasks, segmentBox, segmentBuildingFootprint, validateTownPatch,
  worldPlanKey, worldRoadPolyline, worldTownBuildingQuota, worldTownContainsBuilding, worldTownContainsPoint,
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
export type WorldLandmarkSiting = 'central' | 'waterfront' | 'gateway' | 'high-ground';
export type WorldLandmarkRequirement = Omit<TownBuilding, 'x' | 'z' | 'rotation'> & {
  siting?: WorldLandmarkSiting;
};

type Point = [number, number];
type Edge = { a: Point; b: Point; kind: UrbanRoad['kind']; source: string };
type SiteCandidate = { point: Point; roadAngle?: number; score: number };
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
const LANDMARK_LAYOUT_ATTEMPT_LIMIT = 192;
const LANDMARK_CONFIGURATION_LIMIT = 50_000;
const LANDMARK_LAYOUT_QUALITY_CANDIDATE_LIMIT = 4;
const PARTIAL_LANDMARK_LAYOUT_ATTEMPT_LIMIT = 4;
const PARTIAL_LANDMARK_CONFIGURATION_LIMIT = 1_000;

type LandmarkLayoutCandidate = { landmarks: TownBuilding[]; patch: TownPatch };

function cachedLandmarkSampler(sample: WorldSettlementSampler): WorldSettlementSampler {
  const cache = new Map<string, WorldSample>();
  return (x, z) => {
    const key = `${x},${z}`;
    const known = cache.get(key);
    if (known) return known;
    const surface = sample(x, z);
    if (cache.size < 50_000) cache.set(key, surface);
    return surface;
  };
}

function preferLandmarkLayout(candidate: LandmarkLayoutCandidate, current: LandmarkLayoutCandidate): boolean {
  if (candidate.landmarks.length !== current.landmarks.length) {
    return candidate.landmarks.length > current.landmarks.length;
  }
  const quality = ({ landmarks, patch }: LandmarkLayoutCandidate): [number, number] => {
    const landmarkIds = new Set(landmarks.map(landmark => landmark.id));
    const ordinary = patch.buildings.filter(building => !landmarkIds.has(building.id));
    const x = ordinary.map(building => building.x), z = ordinary.map(building => building.z);
    const extent = ordinary.length
      ? Math.max(Math.max(...x) - Math.min(...x), Math.max(...z) - Math.min(...z)) : 0;
    return [ordinary.length, extent];
  };
  const [candidateBuildings, candidateExtent] = quality(candidate);
  const [currentBuildings, currentExtent] = quality(current);
  return candidateBuildings > currentBuildings
    || candidateBuildings === currentBuildings && candidateExtent > currentExtent + EPS;
}

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
  const slope = (point: Point) => sampleSlope(sample, town, point);
  const dry = (point: Point, clearance = 0) => dryPoint(sample, town, point, clearance);
  const terrainRoadSafe = (a: Point, b: Point, width: number, maxSlope = settings.maxRoadSlope) => segmentSafe(
    sample, town, a, b, width, settings.waterSetback, maxSlope
  );
  const roadSafe = (a: Point, b: Point, width: number, maxSlope = settings.maxRoadSlope) => terrainRoadSafe(a, b, width, maxSlope)
    && settings.landmarks.every(building => !segmentBuildingFootprint(a, b, building, width / 2 + 1));

  const sites = selectSites(plan, town, dry, slope);
  if (!sites.length) throw new Error('world_settlement_no_buildable_site');
  const region = Array.from({ length: 16 }, (_, index): Point => {
    const angle = index / 16 * TAU;
    return [Math.cos(angle) * town.radius * 0.94, Math.sin(angle) * town.radius * 0.94];
  });
  let site: Point | undefined, shore: Shore | undefined, layout: UrbanLayout | undefined, selected: Edge[] = [];
  let best: { site: Point; shore?: Shore; layout: UrbanLayout; selected: Edge[]; parcels: number } | undefined;
  const trySite = (candidate: SiteCandidate, index: number, blockSize: number,
    maxRoadSlope = settings.maxRoadSlope) => {
    const siteRandom = maxRoadSlope === settings.maxRoadSlope ? random : seededRandom(settings.seed);
    const candidateShore = settings.waterfrontBias > 0
      ? findShore(town, sample, candidate.point, settings.waterSetback + settings.arterialWidth / 2, town.targetWaterBodyId)
      : undefined;
    const rotation = candidateShore
      ? Math.atan2(candidateShore.tangent[1], candidateShore.tangent[0])
      : candidate.roadAngle ?? contourAngle(sample, town, candidate.point,
        index === 0 ? siteRandom : seededRandom(settings.seed ^ index));
    const candidateLayout = createUrbanLayout({
      id: `${town.id}-fabric`, pattern: settings.pattern, center: candidate.point,
      size: [town.radius * 1.82, town.radius * 1.82], region,
      rotation: rotation * 180 / Math.PI, blockSize,
      roadWidth: settings.roadWidth, arterialWidth: settings.arterialWidth,
      parcelWidth: settings.parcelWidth, parcelDepth: settings.parcelDepth,
      setback: 1, irregularity: settings.pattern === 'organic' ? 0.72 : 0.42, seed: settings.seed
    }, { minX: -town.radius, maxX: town.radius, minZ: -town.radius, maxZ: town.radius });
    const safeEdges = safeUrbanEdges(candidateLayout.roads,
      (a, b, width) => roadSafe(a, b, width, maxRoadSlope));
    const reserved = town.ports.length + (candidateShore ? 2 : 0);
    let candidateSelected = connectedEdges(safeEdges, candidateShore?.point ?? candidate.point, Math.max(1, Math.min(
      settings.roadBudget - reserved, 48 - reserved - settings.landmarks.length
    )), index === 0 && blockSize === settings.blockSize ? siteRandom : seededRandom(settings.seed ^ index), candidateLayout);
    const parcels = buildableParcelCount(candidateLayout, candidateSelected, town, sample, settings);
    const neededParcels = ordinaryBuildingTarget(parcels, town, settings);
    while (settings.kind === 'village' && town.population === undefined
      && plan.generationPolicy === 'raw-first-call' && candidateSelected.length > 1) {
      const shorter = candidateSelected.slice(0, -1);
      if (buildableParcelCount(candidateLayout, shorter, town, sample, settings) < neededParcels) break;
      candidateSelected = shorter;
    }
    return { site: candidate.point, shore: candidateShore, layout: candidateLayout, selected: candidateSelected, parcels };
  };
  const primary = trySite(sites[0], 0, settings.blockSize);
  const foothill = plan.generationPolicy === 'raw-first-call' && settings.kind === 'city'
    && options.maxRoadSlope === undefined && primary.selected.length < 6
    ? trySite(sites[0], 0, settings.blockSize, 0.25) : undefined;
  const initial = foothill && foothill.selected.length >= 6
    && foothill.selected.length > primary.selected.length ? foothill : primary;
  if (initial.selected.length && (initial.parcels || plan.generationPolicy !== 'raw-first-call')) best = initial;
  else if (plan.generationPolicy === 'raw-first-call') {
    const compactBlockSize = Math.min(settings.blockSize, 16);
    for (let index = 0; index < sites.length; index++) for (const blockSize of new Set([settings.blockSize, compactBlockSize])) {
      const candidate = index === 0 && blockSize === settings.blockSize ? foothill ?? primary
        : trySite(sites[index], index, blockSize, foothill ? 0.25 : settings.maxRoadSlope);
      if (!candidate.selected.length) continue;
      if (!best || candidate.parcels > best.parcels
        || candidate.parcels === best.parcels && candidate.selected.length > best.selected.length) best = candidate;
    }
  }
  if (!best) throw new Error('world_settlement_no_buildable_network');
  ({ site, shore, layout, selected } = best);

  const streets: MapGuide[] = selected.map((edge, index) => guide(
    `${town.id}-street-${index + 1}`, [edge.a, edge.b],
    edge.kind === 'arterial' ? settings.arterialWidth : settings.roadWidth,
    ['settlement', settings.kind, edge.kind]
  ));

  if (shore) {
    const shorePoints = traceShore(shore, town, sample, settings, roadSafe);
    if (shorePoints.length >= 2) {
      const workingWidth=Math.max(settings.kind==='city'?6.4:4.6,settings.arterialWidth);
      const shoreRoad = guide(`${town.id}-waterfront`, shorePoints, workingWidth,
        ['settlement', settings.kind, 'arterial', 'waterfront','working-waterfront']);
      const link = routeToNetwork(shorePoints[Math.floor(shorePoints.length / 2)], roadNodes(streets), roadSafe, settings.roadWidth);
      if (link) {
        streets.push(shoreRoad);
        if (link.length > 1 && !same(link[0], link.at(-1)!)) {
          streets.push(guide(`${town.id}-waterfront-link`, link, settings.roadWidth,
            ['settlement', settings.kind, 'street']));
        }
        if(town.targetWaterBodyId==='sea') {
          const landing=shoreLanding(shorePoints,town,sample,settings,roadSafe);
          if(landing) streets.push(guide(`${town.id}-sea-landing`,landing,workingWidth,
            ['settlement',settings.kind,'street','waterfront','sea-landing','harbor-quay']));
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
          const extent = Math.abs(endpoint[axis]), safeExtent = town.radius - clearance;
          if (extent <= safeExtent + EPS) continue;
          const inward = extent - other[axis] * (Math.sign(endpoint[axis]) || 1);
          if (inward < EPS) return endpoint;
          fraction = Math.max(fraction, (extent - safeExtent) / inward);
        }
        return fraction > 0 && fraction < 1 ? mix(endpoint, other, fraction) : endpoint;
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
  const authoredRoadNodes = settings.landmarks.length ? plan.roads.filter(road => authoredBuildingFrontage(road.tags))
    .flatMap(road => worldRoadPolyline(road).map(point =>
      [point[0] - town.center[0], point[1] - town.center[1]] as Point))
    .filter(point => inside(town, point, settings.roadWidth / 2)) : [];
  for (let landmarkIndex = 0; landmarkIndex < settings.landmarks.length; landmarkIndex++) {
    const landmark = settings.landmarks[landmarkIndex];
    const accessSafe = (a: Point, b: Point, width: number) => terrainRoadSafe(a, b, width)
      && settings.landmarks.every((building, index) => index === landmarkIndex
        ? !segmentBuildingFootprint(a, b, landmark, width / 2)
        : !segmentBuildingFootprint(a, b, building, width / 2 + 1));
    const entry = landmarkEntry(landmark, settings.roadWidth);
    const direction: Point = [Math.sin(landmark.rotation ?? 0), Math.cos(landmark.rotation ?? 0)];
    const outside = add(entry, scale(direction, landmarkAccessLength(settings.blockSize)));
    const tailSafe = (a: Point, b: Point, width: number) => terrainRoadSafe(a, b, width)
      && settings.landmarks.every((building, index) => index === landmarkIndex
        ? !segmentBuildingFootprint(a, b, landmark, width / 2)
        : !segmentBuildingFootprint(a, b, building, width / 2 + 1));
    const roadside = insertRoadNodeAt(streets, outside);
    const tail = roadside ? [roadside] : routeToNetwork(outside,
      [...roadNodes(streets), ...authoredRoadNodes], tailSafe, settings.roadWidth);
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
  for (const port of town.ports) for (const street of streets) for (const index of [0, street.points.length - 1]) {
    if (same(street.points[index], port.position)) street.points[index] = [...port.position];
  }

  let buildings = placeBuildings(plan, town, streets, layout, selected, sample, settings, random);
  const districts = town.districts?.filter(district => district.density > 0) ?? [];
  if (districts.length && !settings.landmarks.length) {
    const totalDensity = districts.reduce((sum, district) => sum + district.density, 0);
    const assignedDistrict = (building: TownBuilding) => districts.filter(district =>
      distance([building.x, building.z], district.offset) <= district.radius)
      .sort((a, b) => distance([building.x, building.z], a.offset) / a.radius
        - distance([building.x, building.z], b.offset) / b.radius)[0]?.anchorId;
    const countIn = (items: TownBuilding[], anchorId: string) =>
      items.filter(building => assignedDistrict(building) === anchorId).length;
    const crossesStreet = (a: Point, b: Point) => streets.some(street => street.points.slice(1).some((end, index) => {
      const start = street.points[index];
      if (same(a, start) || same(a, end)) return false;
      const cross = (p: Point, q: Point, r: Point) =>
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      return cross(a, b, start) * cross(a, b, end) < -EPS
        && cross(start, end, a) * cross(start, end, b) < -EPS;
    }));
    const localBound = Math.max(town.radius, ...districts.map(district => Math.max(
      Math.abs(district.offset[0]) + district.radius, Math.abs(district.offset[1]) + district.radius)));
    const worldBound = plan.recipe.size / 2 - settings.roadWidth / 2;
    const authoredConnectors = plan.roads.filter(road => road.tags.some(tag =>
      ['town-internal', 'town-access', 'local_street', 'local_lane'].includes(tag)))
      .flatMap(road => {
        const points = worldRoadPolyline(road).map(point =>
          [point[0] - town.center[0], point[1] - town.center[1]] as Point);
        return points.slice(1).flatMap((end, index) => {
          const start = points[index], steps = Math.max(1, Math.ceil(distance(start, end) / 10));
          return Array.from({ length: steps + 1 }, (_, step) => mix(start, end, step / steps))
            .filter(point => Math.abs(point[0]) <= localBound && Math.abs(point[1]) <= localBound);
        });
      });
    for (const district of districts) {
      const wanted = Math.max(2, Math.ceil((town.population === undefined ? buildings.length : town.population / 5)
        * district.density / totalDensity * 0.6));
      for (let branch = 0; branch < 2 && streets.length < 48 && countIn(buildings, district.anchorId) < wanted; branch++) {
        const offsets = [-0.6, -0.3, 0, 0.3, 0.6];
        const ends = offsets.flatMap(x => offsets.map(z => add(district.offset,
          [x * district.radius, z * district.radius] as Point)))
          .filter(point => distance(point, district.offset) <= district.radius - settings.roadWidth / 2
            && dry(point, settings.waterSetback + settings.roadWidth / 2));
        const proposals = ends.flatMap(end => [...roadNodes(streets), ...authoredConnectors].map(start => ({ start, end,
          length: distance(start, end) })))
          .filter(item => item.length >= 14 && item.length <= Math.max(90, town.radius * 1.8))
          .sort((a, b) => a.length - b.length || distance(a.end, district.offset) - distance(b.end, district.offset));
        let bestBranch: { road: MapGuide; buildings: TownBuilding[]; count: number } | undefined;
        for (const { start, end } of proposals.slice(0, 96)) {
          if ([start, end].some(point => Math.abs(town.center[0] + point[0]) > worldBound
            || Math.abs(town.center[1] + point[1]) > worldBound)) continue;
          if (!segmentSafe(sample, town, start, end, settings.roadWidth, settings.waterSetback,
            options.maxRoadSlope ?? (settings.kind === 'city' ? 0.25 : settings.maxRoadSlope), true)
            || settings.landmarks.some(building => segmentBuildingFootprint(start, end, building,
              settings.roadWidth / 2 + 1)) || crossesStreet(start, end)) continue;
          const road = guide(`${town.id}-district-access-${streets.length + 1}`, [start, end], settings.roadWidth,
            ['settlement', settings.kind, 'street', 'district-access', district.anchorId]);
          const candidate = placeBuildings(plan, town, [...streets, road], layout, selected, sample, settings,
            seededRandom(settings.seed));
          const count = countIn(candidate, district.anchorId);
          if (count <= countIn(buildings, district.anchorId)
            || candidate.length < buildings.length - Math.max(2, Math.floor(buildings.length * 0.05))) continue;
          try {
            validateTownPatch(plan, { townId: town.id, worldKey: worldPlanKey(plan), summary: 'district access',
              streets: [...streets, road], buildings: candidate });
          } catch (error) {
            if (error instanceof Error && /^(world_streets_disconnected|world_street_outside|world_building_(outside|intersects_road|intersects_street))$/.test(error.message)) continue;
            throw error;
          }
          if (!bestBranch || count > bestBranch.count
            || count === bestBranch.count && candidate.length > bestBranch.buildings.length) {
            bestBranch = { road, buildings: candidate, count };
          }
        }
        if (!bestBranch) break;
        streets.push(bestBranch.road);
        buildings = bestBranch.buildings;
      }
    }
  }
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
  sample = cachedLandmarkSampler(sample);
  const town=plan.towns.find(item=>item.id===townId);
  if(!town) throw new Error('world_settlement_unknown_town');
  const task=createTownTasks(plan).find(candidate=>candidate.town.id===townId)!;
  const settings=normalizeOptions(options,town,task.seed);
  const base=generateWorldSettlement(plan,townId,sample,{...options,landmarks:[]});
  const authoredFrontage=authoredTownFrontage(plan,town,sample,settings);
  const authoredWaterfront=requirements.some(requirement=>requirement.siting==='waterfront')
    ? authoredTownFrontage(plan,town,sample,settings,true):[];
  const ordered=[...requirements].sort((a,b)=>b.width*b.depth-a.width*a.depth||a.id.localeCompare(b.id));
  const sites=ordered.map(requirement=>{
    const {siting,...building}=requirement;
    const candidates=boundedLandmarkSites(frontageLandmarkSites(
      building,base.streets,town,sample,settings,siting,siting==='waterfront'?authoredWaterfront:authoredFrontage));
    if(!candidates.length&&siting==='waterfront') throw new Error(`world_settlement_no_waterfront_site:${requirement.id}`);
    return candidates;
  });
  const failures=ordered.map(()=>new Set<string>()),landmarks:TownBuilding[]=[];
  let attempts=0,searchSteps=0,deepest=0,feasible=0,searchLimited=false,best:LandmarkLayoutCandidate|undefined;
  const search=(index:number):void=>{
    if(searchLimited||feasible>=LANDMARK_LAYOUT_QUALITY_CANDIDATE_LIMIT) return;
    if(index===ordered.length) {
      if(attempts++>=LANDMARK_LAYOUT_ATTEMPT_LIMIT) {searchLimited=true;return;}
      try {
        const candidate={landmarks:[...landmarks],patch:generateWorldSettlement(plan,townId,sample,{...options,landmarks})};
        feasible++;
        if(!best||preferLandmarkLayout(candidate,best)) best=candidate;
      } catch(error) {failures[index-1].add(error instanceof Error?error.message:String(error));}
      return;
    }
    deepest=Math.max(deepest,index);
    for(const candidate of sites[index]) {
      if(!landmarks.every(landmark=>landmarkSitesCompatible(candidate,landmark))) continue;
      if(searchSteps++>=LANDMARK_CONFIGURATION_LIMIT) {searchLimited=true;return;}
      landmarks.push(candidate);
      search(index+1);
      landmarks.pop();
      if(searchLimited||feasible>=LANDMARK_LAYOUT_QUALITY_CANDIDATE_LIMIT) return;
    }
  };
  search(0);
  if(!best) {
    const index=Math.min(deepest,ordered.length-1),requirement=ordered[index];
    throw new Error(`world_settlement_no_landmark_site:${requirement.id}:${[...failures[index]].join('|')}`);
  }
  const byId=new Map(best.landmarks.map(landmark=>[landmark.id,landmark]));
  return {landmarks:requirements.map(requirement=>byId.get(requirement.id)!),patch:best.patch};
}

/** Keeps the best feasible subset found by one bounded deterministic layout search. */
export function createWorldSettlementPartialLandmarkLayout(
  plan: WorldPlan,
  townId: string,
  sample: WorldSettlementSampler,
  options: Omit<WorldSettlementOptions,'landmarks'>,
  requirements: readonly WorldLandmarkRequirement[]
): {landmarks:TownBuilding[];patch:TownPatch;unrealized:Array<{id:string;reason:string}>} {
  sample = cachedLandmarkSampler(sample);
  const town=plan.towns.find(item=>item.id===townId);
  if(!town) throw new Error('world_settlement_unknown_town');
  const task=createTownTasks(plan).find(candidate=>candidate.town.id===townId)!;
  const settings=normalizeOptions(options,town,task.seed);
  const base=generateWorldSettlement(plan,townId,sample,{...options,landmarks:[]});
  const authoredFrontage=authoredTownFrontage(plan,town,sample,settings);
  const authoredWaterfront=requirements.some(requirement=>requirement.siting==='waterfront')
    ? authoredTownFrontage(plan,town,sample,settings,true):[];
  const worldRoads=plan.roads.flatMap(road=>{
    const points=worldRoadPolyline(road);
    return points.slice(1).map((b,index)=>({a:points[index],b,width:road.width}));
  });
  const entries=requirements.map(requirement=>{
    const {siting,...building}=requirement;
    const sites=boundedLandmarkSites(frontageLandmarkSites(
      building,base.streets,town,sample,settings,siting,siting==='waterfront'?authoredWaterfront:authoredFrontage)).filter(candidate=>{
      const worldBuilding={...candidate,x:candidate.x+town.center[0],z:candidate.z+town.center[1]};
      return !worldRoads.some(road=>segmentBuildingFootprint(road.a,road.b,worldBuilding,road.width/2));
    });
    return {requirement,sites};
  }).sort((a,b)=>b.requirement.width*b.requirement.depth-a.requirement.width*a.requirement.depth
    ||a.sites.length-b.sites.length
    ||a.requirement.id.localeCompare(b.requirement.id));
  const remainingCandidateRequirements=entries.map((_,index)=>entries.slice(index).filter(entry=>entry.sites.length).length);
  const targetCount=remainingCandidateRequirements[0]??0;
  const landmarks:TownBuilding[]=[];
  let best={landmarks:[] as TownBuilding[],patch:base},attempts=0,searchSteps=0,searchLimited=false;
  const search=(index:number):void=>{
    if(searchLimited) return;
    if(index===entries.length) {
      if(landmarks.length<best.landmarks.length) return;
      if(attempts++>=PARTIAL_LANDMARK_LAYOUT_ATTEMPT_LIMIT) {searchLimited=true;return;}
      try {
        const patch=generateWorldSettlement(plan,townId,sample,{...options,landmarks});
        const candidate={landmarks:[...landmarks],patch};
        if(preferLandmarkLayout(candidate,best)) best=candidate;
      } catch { /* Keep searching other sites and landmark subsets. */ }
      return;
    }
    if(landmarks.length+remainingCandidateRequirements[index]<best.landmarks.length) return;
    for(const candidate of entries[index].sites) {
      if(searchLimited) return;
      if(!landmarks.every(landmark=>landmarkSitesCompatible(candidate,landmark))) continue;
      if(searchSteps++>=PARTIAL_LANDMARK_CONFIGURATION_LIMIT) {searchLimited=true;return;}
      landmarks.push(candidate);
      search(index+1);
      landmarks.pop();
    }
    search(index+1);
  };
  search(0);
  if(!best.landmarks.length&&targetCount>1&&searchSteps<PARTIAL_LANDMARK_CONFIGURATION_LIMIT) {
    const targetSearchLimited=searchLimited,maxSites=Math.max(0,...entries.map(entry=>entry.sites.length));
    let fallbackLimited=false;
    attempts=0;
    fallback: for(let siteIndex=0;siteIndex<maxSites;siteIndex++) for(const entry of entries) {
      const candidate=entry.sites[siteIndex];
      if(!candidate) continue;
      if(attempts++>=PARTIAL_LANDMARK_LAYOUT_ATTEMPT_LIMIT) {fallbackLimited=true;break fallback;}
      if(searchSteps++>=PARTIAL_LANDMARK_CONFIGURATION_LIMIT) {fallbackLimited=true;break fallback;}
      try {
        const layout={landmarks:[candidate],patch:generateWorldSettlement(plan,townId,sample,{...options,landmarks:[candidate]})};
        if(preferLandmarkLayout(layout,best)) best=layout;
      } catch { /* Keep the base settlement when no bounded singleton fallback succeeds. */ }
    }
    searchLimited=targetSearchLimited||fallbackLimited;
  }
  const byId=new Map(best.landmarks.map(landmark=>[landmark.id,landmark]));
  const entriesById=new Map(entries.map(entry=>[entry.requirement.id,entry]));
  return {
    landmarks:requirements.flatMap(requirement=>byId.get(requirement.id)??[]),patch:best.patch,
    unrealized:requirements.filter(requirement=>!byId.has(requirement.id)).map(requirement=>({
      id:requirement.id,
      reason:entriesById.get(requirement.id)!.sites.length
        ? searchLimited?'layout_search_limit':'no_compatible_landmark_layout'
        : requirement.siting==='waterfront'?'no_waterfront_site':'no_landmark_site'
    }))
  };
}

function frontageLandmarkSites(
  requirement:Omit<WorldLandmarkRequirement,'siting'>,streets:MapGuide[],town:TownIntent,
  sample:WorldSettlementSampler,settings:Settings,siting?:WorldLandmarkSiting,
  authoredFrontage:readonly MapGuide[]=[]
):TownBuilding[] {
  const points:TownBuilding[]=[],roadWidth=settings.roadWidth,blockSize=settings.blockSize;
  const ordinary=streets.filter(street=>!street.tags.some(tag=>['landmark-access','port','sea-landing'].includes(tag)));
  const frontage=siting==='waterfront'
    ? [...ordinary.filter(street=>street.tags.includes('working-waterfront')),...authoredFrontage]
    :[...ordinary,...authoredFrontage];
  const safetyStreets=authoredFrontage.length?[...streets,...authoredFrontage]:streets;
  for(const street of frontage) for(let segment=1;segment<street.points.length;segment++) {
    const a=street.points[segment-1],b=street.points[segment],delta=sub(b,a),length=distance(a,b);
    if(length<EPS) continue;
    const tangent=scale(delta,1/length),normal:Point=[-tangent[1],tangent[0]],steps=Math.max(1,Math.ceil(length/4));
    for(let index=0;index<=steps;index++) for(const side of [-1,1]) {
      const roadPoint=mix(a,b,index/steps),direction=scale(normal,-side),rotation=normalizeAngle(Math.atan2(direction[0],direction[1]));
      const setback=requirement.depth/2+roadWidth/2+landmarkAccessLength(blockSize);
      const candidate={...requirement,x:roundPoint(roadPoint[0]-direction[0]*setback),
        z:roundPoint(roadPoint[1]-direction[1]*setback),rotation};
      if(landmarkSiteSafe(candidate,safetyStreets,town,sample,settings)) points.push(candidate);
    }
  }
  const unique=new Map(points.map(item=>[`${item.x.toFixed(6)},${item.z.toFixed(6)},${(item.rotation??0).toFixed(6)}`,item]));
  const candidates=[...unique.values()],tie=(a:TownBuilding,b:TownBuilding)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z)||a.x-b.x||a.z-b.z;
  if(siting==='waterfront') {
    const reach=Math.min(180,town.radius);
    return candidates.map(candidate=>({candidate,water:nearestWater(
      sample,town,[candidate.x,candidate.z],reach,town.targetWaterBodyId)}))
      .filter((item):item is {candidate:TownBuilding;water:{direction:Point;distance:number}}=>Boolean(item.water))
      .sort((a,b)=>a.water.distance-b.water.distance||tie(a.candidate,b.candidate)).map(item=>item.candidate);
  }
  if(siting==='gateway') {
    if(!town.ports.length) return candidates.sort((a,b)=>Math.hypot(b.x,b.z)-Math.hypot(a.x,a.z)||tie(a,b));
    const gatewayDistance=(candidate:TownBuilding)=>Math.min(...town.ports.map(port=>distance([candidate.x,candidate.z],port.position)));
    return candidates.sort((a,b)=>gatewayDistance(a)-gatewayDistance(b)||tie(a,b));
  }
  if(siting==='high-ground') return candidates.sort((a,b)=>
    sampleAt(sample,town,[b.x,b.z]).height-sampleAt(sample,town,[a.x,a.z]).height||tie(a,b));
  return candidates.sort(tie);
}

function authoredTownFrontage(
  plan:WorldPlan,town:TownIntent,sample:WorldSettlementSampler,settings:Settings,waterfrontOnly=false
):MapGuide[] {
  const result:MapGuide[]=[],reach=Math.min(40,town.radius*.58);
  for(const road of plan.roads) {
    if(!authoredBuildingFrontage(road.tags)) continue;
    const points=worldRoadPolyline(road);
    for(let segment=1;segment<points.length;segment++) {
      const worldA=points[segment-1],worldB=points[segment];
      const clipped=clipTownSegment(
        [worldA[0]-town.center[0],worldA[1]-town.center[1]],
        [worldB[0]-town.center[0],worldB[1]-town.center[1]],
        Math.max(town.radius, ...town.districts?.map(district => Math.max(
          Math.abs(district.offset[0]) + district.radius, Math.abs(district.offset[1]) + district.radius
        )) ?? []));
      if(!clipped) continue;
      const steps=Math.max(1,Math.ceil(distance(...clipped)/8));
      for(let step=0;step<steps;step++) {
        const a=mix(clipped[0],clipped[1],step/steps),b=mix(clipped[0],clipped[1],(step+1)/steps);
        if(!segmentSafe(sample,town,a,b,road.width,settings.waterSetback,settings.maxRoadSlope)
          ||waterfrontOnly&&!hasGradedWaterAccess(mix(a,b,.5),road.width,town,sample,settings,reach)) continue;
        result.push(guide(`${road.id}-frontage-${segment}-${step+1}`,[a,b],road.width,road.tags));
      }
    }
  }
  return result;
}

function hasGradedWaterAccess(
  point:Point,width:number,town:TownIntent,sample:WorldSettlementSampler,settings:Settings,reach:number
):boolean {
  const water=nearestWater(sample,town,point,reach,town.targetWaterBodyId);
  if(!water) return false;
  const clearance=settings.waterSetback+width/2+1,desired=Math.max(0,water.distance-clearance);
  if(desired<EPS) return false;
  let low=0,high=desired;
  for(let attempt=0;attempt<10;attempt++) {
    const length=(low+high)/2,end=add(point,scale(water.direction,length));
    if(segmentSafe(sample,town,point,end,width,settings.waterSetback,settings.maxRoadSlope)) low=length;
    else high=length;
  }
  const end=add(point,scale(water.direction,low));
  const waterSample=sampleAt(sample,town,add(point,scale(water.direction,water.distance)));
  const remaining=nearestWater(sample,town,end,Math.min(24,reach),town.targetWaterBodyId)?.distance;
  return waterSample.waterLevel!==null&&remaining!==undefined&&remaining<water.distance-EPS&&remaining<=20
    &&sampleAt(sample,town,end).height-waterSample.waterLevel<=MAX_LOCAL_EARTHWORK+EPS;
}

function landmarkSiteSafe(
  building:TownBuilding,streets:MapGuide[],town:TownIntent,sample:WorldSettlementSampler,settings:Settings
):boolean {
  const probes=buildingProbePoints(building);
  if(!worldTownContainsBuilding(town,building)
    ||!buildingEarthworkSafe(sample,town,building)
    ||probes.some(point=>!dryPoint(sample,town,point,settings.waterSetback)
      ||sampleSlope(sample,town,point)>settings.maxSiteSlope+EPS)) return false;
  if(streets.some(street=>street.points.slice(1).some((to,index)=>
    segmentBuildingFootprint(street.points[index],to,building,street.width/2+1)))) return false;
  const [entry,outside]=landmarkAccess(building,settings);
  return segmentSafe(sample,town,entry,outside,settings.roadWidth,settings.waterSetback,settings.maxRoadSlope);
}

function landmarkSitesCompatible(a:TownBuilding,b:TownBuilding):boolean {
  return !buildingsOverlap(a,b);
}

function landmarkAccess(building:TownBuilding,settings:Settings):[Point,Point] {
  const entry=landmarkEntry(building,settings.roadWidth);
  const direction:Point=[Math.sin(building.rotation??0),Math.cos(building.rotation??0)];
  return [entry,add(entry,scale(direction,landmarkAccessLength(settings.blockSize)))];
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
  const villageGrowth=Math.max(0,town.radius-60);
  return {
    kind: options.kind,
    pattern: options.pattern ?? 'organic',
    seed: Math.trunc(number(options.seed, fallbackSeed, 0, Number.MAX_SAFE_INTEGER, 'world_settlement_invalid_seed')),
    density,
    landmarks: options.landmarks?.map(building => ({ ...building })) ?? [],
    waterfrontBias: number(options.waterfrontBias, city ? 0.8 : 0.55, 0, 1, 'world_settlement_invalid_waterfront_bias'),
    maxRoadSlope: number(options.maxRoadSlope, city ? 0.18 : 0.24, 0.01, 0.5, 'world_settlement_invalid_road_slope'),
    maxSiteSlope: number(options.maxSiteSlope, city ? 0.25 : 0.2, 0.01, 0.5, 'world_settlement_invalid_site_slope'),
    waterSetback: number(options.waterSetback, city ? 7 : 5, 0, town.radius / 2, 'world_settlement_invalid_water_setback'),
    roadWidth: city ? 4.2 : 3,
    arterialWidth: city ? 6.4 : 4.6,
    blockSize: city?Math.max(34,Math.min(76,town.radius*.22)):Math.max(38,Math.min(80,town.radius*.38)),
    parcelWidth: city?5.8:town.radius>=90?(town.targetWaterBodyId==='sea'?5:7.2):9,
    parcelDepth: city ? 8.5 : town.radius>=90?9:10,
    buildingGap: city ? 1.2 : 7,
    roadBudget: city ? Math.max(Math.round(26+density*10+Math.max(0,town.radius-100)/20),
      town.population===undefined?0:Math.ceil(town.population/6))
      : Math.max(7,Math.round(6+density*8+villageGrowth/16),
        town.population===undefined?0:Math.ceil(town.population/10))
  };
}

function selectSites(
  plan: WorldPlan,
  town: TownIntent,
  dry: (point: Point, clearance?: number) => boolean,
  slope: (point: Point) => number
): SiteCandidate[] {
  const grid: SiteCandidate[] = [], candidates: SiteCandidate[] = [];
  const add = (target: SiteCandidate[], point: Point, roadAngle?: number) => {
    if (!inside(town, point, 3) || !dry(point, 3)) return;
    target.push({ point, roadAngle, score: slope(point) * town.radius * 5 + Math.hypot(...point) });
  };
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    const point: Point = [x * town.radius * 0.1, z * town.radius * 0.1];
    add(grid, point);
  }
  for (const road of plan.roads) for (let index = 1; index < road.points.length; index++) {
    const worldA = road.points[index - 1], worldB = road.points[index];
    const a: Point = [worldA[0] - town.center[0], worldA[1] - town.center[1]];
    const b: Point = [worldB[0] - town.center[0], worldB[1] - town.center[1]];
    const length = distance(a, b), steps = Math.max(1, Math.ceil(length / 8));
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (let step = 0; step <= steps; step++) add(candidates, mix(a, b, step / steps), angle);
  }
  const primary = grid.reduce((best, candidate) => !best || candidate.score < best.score ? candidate : best, undefined as SiteCandidate | undefined);
  const unique = new Map<string, SiteCandidate>();
  for (const candidate of [...candidates.sort((a, b) => a.score - b.score).slice(0, 4),
    ...grid.sort((a, b) => a.score - b.score)]) {
    const key = pointKey(candidate.point);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  if (primary) unique.delete(pointKey(primary.point));
  return [...(primary ? [primary] : []), ...unique.values()].slice(0, 12);
}

function findShore(
  town: TownIntent,
  sample: WorldSettlementSampler,
  center: Point,
  clearance: number,
  targetWaterBodyId?: string
): Shore | undefined {
  let best: { point: Point; direction: Point; distance: number; score: number } | undefined;
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    const point: Point = [center[0] + x * town.radius * 0.1, center[1] + z * town.radius * 0.1];
    if (!inside(town, point, clearance) || wet(sampleAt(sample, town, point))) continue;
    const water = nearestWater(sample, town, point, Math.min(180, town.radius * 0.58),targetWaterBodyId);
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
  reach: number,
  targetWaterBodyId?: string
): { direction: Point; distance: number } | undefined {
  let best: { direction: Point; distance: number } | undefined;
  const step = Math.max(4, Math.min(10, reach / 12));
  for (let direction = 0; direction < 16; direction++) {
    const angle = direction / 16 * TAU;
    const unit: Point = [Math.cos(angle), Math.sin(angle)];
    for (let distance = step; distance <= reach + EPS; distance += step) {
      const probe = add(point, scale(unit, distance));
      if (!inside(town, probe, 0)) break;
      const value=sampleAt(sample,town,probe);
      const target=targetWaterBodyId===undefined||targetWaterBodyId==='sea'?value.waterBodyId===null:value.waterBodyId===targetWaterBodyId;
      if (wet(value) && (targetWaterBodyId===undefined||target)) {
        if (!best || distance < best.distance) best = { direction: unit, distance };
        break;
      }
    }
  }
  return best;
}

function shoreLanding(
  shore:Point[],town:TownIntent,sample:WorldSettlementSampler,settings:Settings,
  safe:(a:Point,b:Point,width:number)=>boolean
):Point[]|undefined {
  const width=Math.max(6.4,settings.arterialWidth),clearance=settings.waterSetback+width/2+1;
  const usableLength=Math.max(12,width*2);
  const candidates=shore.map(point=>({point,water:nearestWater(sample,town,point,Math.min(180,town.radius*.58),'sea')}))
    .filter((item):item is {point:Point;water:{direction:Point;distance:number}}=>Boolean(item.water))
    .sort((a,b)=>a.water.distance-b.water.distance||distance(a.point,[0,0])-distance(b.point,[0,0]));
  for(const {point,water} of candidates) {
    let low=0,high=Math.max(0,water.distance-clearance);
    for(let attempt=0;attempt<10;attempt++) {
      const length=(low+high)/2,end=add(point,scale(water.direction,length));
      if(safe(point,end,width)) low=length; else high=length;
    }
    // Keep enough dry approach for small-scale loading and turning, scaled to wider quays.
    if(low+EPS<usableLength) continue;
    const end=add(point,scale(water.direction,low));
    const remaining=nearestWater(sample,town,end,Math.min(24,town.radius*.58),'sea')?.distance;
    if(safe(point,end,width)&&remaining!==undefined&&remaining<water.distance-EPS&&remaining<=20) return [point,end];
  }
  return undefined;
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

function buildableParcelCount(
  layout: UrbanLayout,
  selected: Edge[],
  town: TownIntent,
  sample: WorldSettlementSampler,
  settings: Settings
): number {
  const city = settings.kind === 'city', selectedByRoad = new Map<string, Edge[]>();
  for (const edge of selected) selectedByRoad.set(edge.source, [...(selectedByRoad.get(edge.source) ?? []), edge]);
  return layout.parcels.filter(parcel => selectedByRoad.get(parcel.roadId)?.some(edge =>
    pointSegmentDistance(parcel.front, edge.a, edge.b) < 1e-4)).filter(parcel => {
    const width = parcel.width - Math.min(city ? 0.25 : 1.2, parcel.width * 0.16);
    const depth = parcel.depth * (city ? 0.72 : 0.62);
    if (width < 3.5 || depth < 3.8) return false;
    const forward: Point = [Math.sin(parcel.rotationY), Math.cos(parcel.rotationY)];
    const center = add(parcel.center, scale(forward, (parcel.depth - depth) / 2));
    const building: TownBuilding = { id: 'probe', x: center[0], z: center[1], width, depth, height: 1,
      use: 'probe', rotation: parcel.rotationY };
    const probes = buildingProbePoints(building);
    return worldTownContainsBuilding(town, building)
      && buildingEarthworkSafe(sample, town, building)
      && probes.every(point => dryPoint(sample, town, point, settings.waterSetback)
        && sampleSlope(sample, town, point) <= settings.maxSiteSlope + EPS);
  }).length;
}

function connectedEdges(edges: Edge[], anchor: Point, budget: number, random: () => number, layout: UrbanLayout): Edge[] {
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
  const selectedSet = new Set<number>();
  const noise = new Map(component.map(index => [index, random() * 8]));
  const blockEdges = urbanBlockEdgeGroups(layout, edges, allowed);
  const blocksByEdge = new Map<number,number[][]>();
  for(const group of blockEdges) for(const index of group) blocksByEdge.set(index,[...(blocksByEdge.get(index)??[]),group]);
  const targetCycles=Math.max(2,Math.min(6,Math.round(budget/6)));
  const targetExtent=Math.max(...component.flatMap(index=>[distance(edges[index].a,anchor),distance(edges[index].b,anchor)]))*.92;
  let cycles=0,reachedExtent=distance(parsePoint(startNode),anchor);
  const frontier = [...(byNode.get(startNode) ?? [])].filter(index => allowed.has(index));
  while (frontier.length && selected.length < budget) {
    const priority=(index:number) => {
      const edge=edges[index],ka=pointKey(edge.a),kb=pointKey(edge.b),closing=reached.has(ka)&&reached.has(kb);
      const groups=blocksByEdge.get(index)??[];
      const progress=Math.max(0,...groups.map(group=>group.filter(candidate=>selectedSet.has(candidate)).length/group.length));
      const completes=groups.some(group=>group.every(candidate=>candidate===index||selectedSet.has(candidate)));
      const outward=Math.max(distance(edge.a,anchor),distance(edge.b,anchor));
      return edgePriority(edge,anchor,noise.get(index)!)-(completes?180:progress*28)
        -(closing&&cycles<targetCycles?120:0)-Math.max(0,outward-reachedExtent)*(reachedExtent<targetExtent?4:.3);
    };
    frontier.sort((a, b) => priority(a)-priority(b));
    const edgeIndex = frontier.shift()!;
    if (selectedSet.has(edgeIndex)) continue;
    const edge = edges[edgeIndex], ka = pointKey(edge.a), kb = pointKey(edge.b);
    if (!reached.has(ka) && !reached.has(kb)) continue;
    const closing=reached.has(ka)&&reached.has(kb);
    selected.push(edgeIndex);
    selectedSet.add(edgeIndex);
    if(closing) cycles++;
    reachedExtent=Math.max(reachedExtent,distance(edge.a,anchor),distance(edge.b,anchor));
    for (const key of [ka, kb]) if (!reached.has(key)) {
      reached.add(key);
      frontier.push(...(byNode.get(key) ?? []).filter(index => allowed.has(index)));
    }
  }
  return selected.map(index => edges[index]);
}

function urbanBlockEdgeGroups(layout:UrbanLayout,edges:Edge[],allowed:Set<number>):number[][] {
  // The block polygon is inset from its roads, so recover each safe source edge by parallel proximity.
  const maxOffset=Math.max(...layout.roads.map(road=>road.width),0)/2+2.5;
  const groups:number[][]=[];
  for(const block of layout.blocks) {
    const group:number[]=[];
    for(let side=0;side<block.points.length;side++) {
      const a=block.points[side],b=block.points[(side+1)%block.points.length],middle=mix(a,b,.5),delta=normalize(sub(b,a));
      let best:{index:number;distance:number;score:number}|undefined;
      for(const index of allowed) {
        const edge=edges[index],edgeDelta=normalize(sub(edge.b,edge.a));
        const alignment=Math.abs(delta[0]*edgeDelta[0]+delta[1]*edgeDelta[1]);
        if(alignment<.8) continue;
        const separation=pointSegmentDistance(middle,edge.a,edge.b),score=separation+(1-alignment)*20;
        if(!best||score<best.score) best={index,distance:separation,score};
      }
      if(best&&best.distance<=maxOffset) group.push(best.index);
    }
    const unique=[...new Set(group)];
    if(unique.length>=3) groups.push(unique);
  }
  return groups;
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
  const width=Math.max(6.4,settings.arterialWidth);
  const desired = settings.waterSetback + width / 2 + 2;
  const step = Math.max(18, Math.min(settings.blockSize * 0.72, 48));
  const extend = (direction: Point): Point[] => {
    const points: Point[] = [];
    let current = shore.point, heading = direction;
    for (let count = 0; count < 5; count++) {
      let best: { point: Point; heading: Point; score: number } | undefined;
      for (const turn of [-0.42, -0.2, 0, 0.2, 0.42]) {
        const nextHeading = rotate(heading, turn);
        const next = add(current, scale(nextHeading, step));
        if (!inside(town, next, width / 2) || !safe(current, next, width)) continue;
        const water = nearestWater(sample, town, next, Math.min(180, town.radius * 0.58),town.targetWaterBodyId);
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

function ordinaryBuildingTarget(candidateCount: number, town: TownIntent, settings: Settings): number {
  if (town.population !== undefined) return Math.ceil(town.population / 5);
  if (settings.kind === 'city') return Math.max(24, Math.round(candidateCount * settings.density));
  const floor = Math.round(8 + Math.max(0, town.radius - 60) * settings.density * 0.42);
  const occupancy = town.targetWaterBodyId === 'sea'
    ? Math.min(1, settings.density + settings.waterfrontBias * 0.4) : settings.density;
  return Math.max(floor, Math.round(candidateCount * occupancy));
}

function reservedFrontage(tags:readonly string[]):boolean {
  return tags.some(tag=>[
    'walking_trail','rim_trail','shore_trail','sea-landing','sea_landing',
    'landmark-access','landmark_access','public-space','public_space','plaza','square'
  ].includes(tag.toLowerCase()));
}

function authoredBuildingFrontage(tags:readonly string[]):boolean {
  return tags.some(tag=>['local_street','local_lane','access_lane'].includes(tag.toLowerCase()))
    &&!reservedFrontage(tags);
}

function placeBuildings(
  plan: WorldPlan,
  town: TownIntent,
  streets: MapGuide[],
  layout: UrbanLayout,
  selected: Edge[],
  sample: WorldSettlementSampler,
  settings: Settings,
  random: () => number
): TownBuilding[] {
  const result: TownBuilding[] = settings.landmarks.map(building => ({ ...building }));
  const city = settings.kind === 'city';
  const worldBound = plan.recipe.size / 2;
  const localRoads = streets.flatMap(road => road.points.slice(1).map((b, index) => ({ a: road.points[index], b, width: road.width, road })));
  const worldRoads = plan.roads.flatMap(road => {
    const points = worldRoadPolyline(road);
    return points.slice(1).map((b, index) => ({ a: points[index], b, width: road.width }));
  });
  const localFrontageRoads = localRoads.filter(segment => !reservedFrontage(segment.road.tags));
  const worldFrontageRoads = plan.roads.filter(road => authoredBuildingFrontage(road.tags))
    .flatMap(road => {
      const points = worldRoadPolyline(road);
      return points.slice(1).map((worldB, index) => {
        const worldA = points[index];
        return clipTownSegment(
          [worldA[0] - town.center[0], worldA[1] - town.center[1]],
          [worldB[0] - town.center[0], worldB[1] - town.center[1]],
          Math.max(town.radius, ...town.districts?.map(district => Math.max(
            Math.abs(district.offset[0]) + district.radius, Math.abs(district.offset[1]) + district.radius
          )) ?? [])
        );
      }).filter((segment): segment is [Point, Point] => Boolean(segment))
        .map(([a, b]) => ({ a, b, width: road.width }));
    });
  const selectedByRoad = new Map<string, Edge[]>();
  for (const edge of selected) selectedByRoad.set(edge.source, [...(selectedByRoad.get(edge.source) ?? []), edge]);
  const candidates = layout.parcels.filter(parcel => selectedByRoad.get(parcel.roadId)?.some(edge =>
    pointSegmentDistance(parcel.front, edge.a, edge.b) < 1e-4));
  const blockCenters = new Map(layout.blocks.map(block => [block.id, block.center]));
  const civicAnchors: Point[] = [[0,0],...town.ports.map(port=>port.position),...result.map(building=>[building.x,building.z] as Point)];
  const waterfront = localRoads.filter(segment => segment.road.tags.includes('waterfront'));
  const nearest = (point: Point, anchors: Point[]) => Math.min(...anchors.map(anchor => distance(point, anchor)));
  const waterfrontDistance = (point: Point) => waterfront.length
    ? Math.min(...waterfront.map(road => pointSegmentDistance(point, road.a, road.b))) : town.radius;
  const score = (parcel: UrbanParcel) => {
    const center = blockCenters.get(parcel.blockId) ?? parcel.center;
    return nearest(center, civicAnchors) + waterfrontDistance(center) * (waterfront.length ? 0.3 : 0);
  };
  candidates.sort((a, b) => score(a) - score(b) || a.blockId.localeCompare(b.blockId)
    || a.roadId.localeCompare(b.roadId) || a.id.localeCompare(b.id));
  const parcelDistricts = new Map<string, NonNullable<TownIntent['districts']>[number]>();
  const districtIntent = town.districts?.length ? town.districts.filter(district => district.density > 0) : [];
  const districtUseCounts = new Map<string, number>();
  const districtUse = (district: NonNullable<TownIntent['districts']>[number]) => {
    const index = districtUseCounts.get(district.anchorId) ?? 0;
    return district.kind === 'civic' ? index % 3 === 0 ? 'shop' : 'home'
      : district.kind === 'working' ? index % 2 === 0 ? 'workshop' : 'home'
        : district.kind === 'edge' ? 'farmhouse' : 'home';
  };
  if (districtIntent.length) {
    const order = new Map(candidates.map((parcel, index) => [parcel.id, index]));
    const groups = districtIntent.map(district => ({ district, used: 0, parcels: [] as UrbanParcel[] }));
    for (const parcel of candidates) {
      const group = groups.filter(candidate => distance(parcel.center, candidate.district.offset) <= candidate.district.radius * 1.5)
        .sort((a, b) => distance(parcel.center, a.district.offset) / a.district.radius
          - distance(parcel.center, b.district.offset) / b.district.radius
          || a.district.anchorId.localeCompare(b.district.anchorId))[0];
      if (!group) continue;
      group.parcels.push(parcel);
      parcelDistricts.set(parcel.id, group.district);
    }
    for (const group of groups) group.parcels.sort((a, b) =>
      distance(a.center, group.district.offset) - distance(b.center, group.district.offset)
      || order.get(a.id)! - order.get(b.id)!);
    const distributed: UrbanParcel[] = [];
    while (groups.some(group => group.parcels.length)) {
      const group = groups.filter(candidate => candidate.parcels.length)
        .sort((a, b) => (a.used + 1) / a.district.density - (b.used + 1) / b.district.density
          || a.district.anchorId.localeCompare(b.district.anchorId))[0];
      distributed.push(group.parcels.shift()!);
      group.used++;
    }
    candidates.splice(0, candidates.length, ...distributed);
  } else if(town.population!==undefined) {
    const districts:UrbanParcel[][]=[[],[],[]];
    for(const parcel of candidates) {
      const radius=distance(parcel.center,[0,0])/town.radius;
      districts[radius<.4?0:radius<.68?1:2].push(parcel);
    }
    for(let district=0;district<districts.length;district++) {
      const blocks=new Map<string,UrbanParcel[]>();
      for(const parcel of districts[district]) blocks.set(parcel.blockId,[...(blocks.get(parcel.blockId)??[]),parcel]);
      districts[district]=[];
      while([...blocks.values()].some(block=>block.length)) for(const block of blocks.values()) {
        districts[district].push(...block.splice(0,3));
      }
    }
    const distributed:UrbanParcel[]=[],districtOrder=[0,0,1,0,1,2],offsets=[0,0,0];
    while(distributed.length<candidates.length) {
      let added=false;
      for(const district of districtOrder) if(offsets[district]<districts[district].length) {
        distributed.push(districts[district][offsets[district]++]);added=true;
      }
      if(!added) break;
    }
    candidates.splice(0,candidates.length,...distributed);
  }
  const populationHomes=town.population===undefined?0:Math.ceil(town.population/5);
  const fallbackWidth=city?4:5,fallbackDepth=city?6:7;
  const worldFrontageTarget=Math.ceil(worldFrontageRoads
    .reduce((area,road)=>area+distance(road.a,road.b)*road.width,0)
    *settings.density/(fallbackWidth*fallbackDepth));
  const frontageTarget = town.population === undefined && plan.generationPolicy === 'raw-first-call'
    ? Math.ceil([...localFrontageRoads, ...worldFrontageRoads]
      .reduce((area, road) => area + distance(road.a, road.b) * road.width, 0)
      * settings.density / (fallbackWidth * fallbackDepth))
    : 0;
  const ordinaryTarget = Math.max(ordinaryBuildingTarget(candidates.length, town, settings), frontageTarget);
  const target = Math.min(worldTownBuildingQuota(town), result.length + ordinaryTarget);
  const districtLimit = Math.min(worldTownBuildingQuota(town), result.length + Math.max(ordinaryTarget, populationHomes * 2));
  const householdCount=()=>result.filter(building=>building.use==='home'||building.use==='farmhouse').length;
  const filled=()=>town.population===undefined?result.length>=target:householdCount()>=populationHomes;
  for (const landmark of result) {
    const probes = buildingProbePoints(landmark);
    if (!worldTownContainsBuilding(town, landmark)
      || probes.some(point => Math.abs(town.center[0] + point[0]) > worldBound
        || Math.abs(town.center[1] + point[1]) > worldBound)
      || !buildingEarthworkSafe(sample, town, landmark)
      || probes.some(point => !dryPoint(sample, town, point, settings.waterSetback)
        || sampleSlope(sample, town, point) > settings.maxSiteSlope + EPS)
      || localRoads.some(road => road.road.id === `${town.id}-landmark-${landmark.id}`
        && road.road.tags.includes('landmark-access')
        ? segmentBuildingFootprint(road.a, road.b, landmark, road.width / 2)
        : segmentBuildingFootprint(road.a, road.b, landmark, road.width / 2 + 1))) {
      throw new Error(`world_settlement_invalid_landmark:${landmark.id}`);
    }
    const worldBuilding = { ...landmark, x: landmark.x + town.center[0], z: landmark.z + town.center[1] };
    if (worldRoads.some(road => segmentBuildingFootprint(road.a, road.b, worldBuilding, road.width / 2))) {
      throw new Error(`world_settlement_invalid_landmark:${landmark.id}`);
    }
  }
  for (let left = 0; left < result.length; left++) for (let right = left + 1; right < result.length; right++) {
    if (buildingsOverlap(result[left], result[right])) {
      throw new Error('world_settlement_landmarks_overlap');
    }
  }
  const canPlace = (building: TownBuilding): boolean => {
    if (!worldTownContainsBuilding(town, building)) return false;
    const probes = buildingProbePoints(building);
    if (probes.some(point => Math.abs(town.center[0] + point[0]) > worldBound
      || Math.abs(town.center[1] + point[1]) > worldBound)) return false;
    if (!buildingEarthworkSafe(sample, town, building)
      || probes.some(point => !dryPoint(sample, town, point, settings.waterSetback)
      || sampleSlope(sample, town, point) > settings.maxSiteSlope + EPS)) return false;
    if (result.some(other => buildingsOverlap(building, other))) return false;
    if (localRoads.some(road => segmentBuildingFootprint(road.a, road.b, building, road.width / 2))) return false;
    const worldBuilding = { ...building, x: building.x + town.center[0], z: building.z + town.center[1] };
    return !worldRoads.some(road => segmentBuildingFootprint(road.a, road.b, worldBuilding, road.width / 2));
  };
  const placeRoadside = (roads: readonly { a:Point; b:Point; width:number }[], limit=target,
    onlyDistrict?: NonNullable<TownIntent['districts']>[number]) => {
    if (districtIntent.length) {
      const groups = (onlyDistrict ? [onlyDistrict] : districtIntent).map(district => ({ district, used: 0,
        sites: [] as Array<{ center: Point; rotation: number }> }));
      for (const road of roads) {
        const delta=sub(road.b,road.a),length=distance(road.a,road.b);
        if(length<EPS) continue;
        const tangent=scale(delta,1/length),normal:Point=[-tangent[1],tangent[0]];
        const steps=Math.max(1,Math.floor(length/(fallbackWidth+settings.buildingGap*(1-settings.density))));
        for(let index=0;index<=steps;index++) for(const side of [-1,1]) {
          const roadPoint=mix(road.a,road.b,(index+.5)/(steps+1)),outward=scale(normal,side);
          const center=add(roadPoint,scale(outward,road.width/2+fallbackDepth/2+1));
          const group=groups.filter(candidate=>distance(center,candidate.district.offset)<=candidate.district.radius*1.5)
            .sort((a,b)=>distance(center,a.district.offset)/a.district.radius-distance(center,b.district.offset)/b.district.radius
              ||a.district.anchorId.localeCompare(b.district.anchorId))[0];
          if(group && (!onlyDistrict || distance(center, onlyDistrict.offset) <= onlyDistrict.radius)) {
            group.sites.push({center,rotation:normalizeAngle(Math.atan2(-outward[0],-outward[1]))});
          }
        }
      }
      while(groups.some(group=>group.sites.length)&&(!filled()||onlyDistrict!==undefined)
        &&result.length<limit&&result.length<worldTownBuildingQuota(town)) {
        const group=groups.filter(candidate=>candidate.sites.length)
          .sort((a,b)=>(a.used+1)/a.district.density-(b.used+1)/b.district.density
            ||a.district.anchorId.localeCompare(b.district.anchorId))[0];
        const site=group.sites.shift()!,use=districtUse(group.district);
        const building:TownBuilding={id:`${town.id}-building-${result.length+1}`,x:site.center[0],z:site.center[1],
          width:fallbackWidth,depth:fallbackDepth,height:city?7+random()*4:4.5+random()*3,use,rotation:site.rotation};
        if(canPlace(building)) {
          result.push(building);group.used++;
          districtUseCounts.set(group.district.anchorId,(districtUseCounts.get(group.district.anchorId)??0)+1);
        }
      }
      return;
    }
    for(const road of roads) {
      if(filled()||result.length>=limit||result.length>=worldTownBuildingQuota(town)) break;
      const delta=sub(road.b,road.a),length=distance(road.a,road.b);
      if(length<EPS) continue;
      const tangent=scale(delta,1/length),normal:Point=[-tangent[1],tangent[0]];
      const steps=Math.max(1,Math.floor(length/(fallbackWidth+settings.buildingGap*(1-settings.density))));
      for(let index=0;index<=steps&&!filled()&&result.length<limit&&result.length<worldTownBuildingQuota(town);index++) {
        for(const side of [-1,1]) {
          if(filled()||result.length>=limit||result.length>=worldTownBuildingQuota(town)) break;
          const roadPoint=mix(road.a,road.b,(index+.5)/(steps+1)),outward=scale(normal,side);
          const center=add(roadPoint,scale(outward,road.width/2+fallbackDepth/2+1));
          const building:TownBuilding={id:`${town.id}-building-${result.length+1}`,x:center[0],z:center[1],
            width:fallbackWidth,depth:fallbackDepth,height:city?7+random()*4:4.5+random()*3,use:'home',
            rotation:normalizeAngle(Math.atan2(-outward[0],-outward[1]))};
          if(canPlace(building)) result.push(building);
        }
      }
    }
  };
  for (const district of districtIntent) {
    const branches = localFrontageRoads.filter(road => road.road.tags.includes('district-access')
      && road.road.tags.includes(district.anchorId));
    if (branches.length) placeRoadside(branches, Math.min(districtLimit,
      result.length + Math.max(2, Math.ceil(populationHomes * district.density / Math.max(1,
        districtIntent.reduce((sum, candidate) => sum + candidate.density, 0)) * 0.6))), district);
  }
  if(plan.generationPolicy==='raw-first-call'&&town.population===undefined&&!districtIntent.length) {
    placeRoadside(worldFrontageRoads,Math.min(target,result.length+worldFrontageTarget));
  }
  if(districtIntent.length) placeRoadside(worldFrontageRoads,districtLimit);
  for (let index = 0; index < candidates.length && !filled() && result.length<worldTownBuildingQuota(town)
    && (!districtIntent.length || result.length < districtLimit); index++) {
    const parcel = candidates[index];
    const width = parcel.width - Math.min(city ? 0.25 : 1.2, parcel.width * 0.16);
    const depth = parcel.depth * (city ? 0.72 : 0.62);
    if (width < 3.5 || depth < 3.8) continue;
    const forward: Point = [Math.sin(parcel.rotationY), Math.cos(parcel.rotationY)];
    const spareDepth = parcel.depth - depth;
    const civicDistance = nearest(parcel.center, civicAnchors);
    const shoreDistance = waterfrontDistance(parcel.center);
    const outer = distance(parcel.center, [0, 0]) / town.radius;
    const district = parcelDistricts.get(parcel.id);
    const use = district ? districtUse(district)
      : city ? civicDistance < settings.blockSize * 1.1 && index % 3 !== 0 ? 'shop'
        : shoreDistance < settings.blockSize * 0.65 && index % 3 === 0 ? 'workshop'
          : outer > 0.68 && index % 4 === 0 ? 'workshop' : 'home'
      : civicDistance < settings.blockSize && index % 4 === 0 ? 'shop'
        : outer > 0.58 && index % 3 !== 0 ? 'farmhouse'
          : index % 5 === 0 ? 'workshop' : 'home';
    const height = city
      ? 7 + random() * 5 + Math.max(0, 1 - civicDistance / (settings.blockSize * 2)) * 4
      : 4.5 + random() * 3.5;
    const center = add(parcel.center, scale(forward, spareDepth / 2));
    const building: TownBuilding = {
      id: `${town.id}-building-${result.length + 1}`,
      x: center[0], z: center[1], width, depth, height, use, rotation: parcel.rotationY
    };
    if (canPlace(building)) {
      result.push(building);
      if (district) districtUseCounts.set(district.anchorId, (districtUseCounts.get(district.anchorId) ?? 0) + 1);
    }
  }
  if(!filled()&&(town.population!==undefined||plan.generationPolicy==='raw-first-call')) placeRoadside(localFrontageRoads,
    districtIntent.length ? districtLimit : target);
  if(!districtIntent.length&&plan.generationPolicy==='raw-first-call'&&town.population!==undefined&&!filled()) placeRoadside(worldFrontageRoads);
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
  maxSlope: number,
  allowOutsideTown = false
): boolean {
  const length = distance(a, b);
  if (length < EPS) return false;
  const steps = Math.max(1, Math.ceil(length / 8));
  const startHeight = sampleAt(sample, town, a).height, endHeight = sampleAt(sample, town, b).height;
  for (let index = 0; index <= steps; index++) {
    const t = index / steps, point = mix(a, b, t);
    if ((!allowOutsideTown && !inside(town, point, width / 2))
      || !dryPoint(sample, town, point, waterSetback + width / 2, allowOutsideTown)
      || sampleSlope(sample, town, point) > maxSlope + EPS
      || Math.abs(sampleAt(sample, town, point).height - (startHeight + (endHeight - startHeight) * t)) > MAX_LOCAL_EARTHWORK) return false;
  }
  return true;
}

function dryPoint(sample: WorldSettlementSampler, town: TownIntent, point: Point, clearance: number,
  allowOutsideTown = false): boolean {
  if ((!allowOutsideTown && !inside(town, point, clearance)) || wet(sampleAt(sample, town, point))) return false;
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
    building.x + c * x * building.width / 2 + s * z * building.depth / 2,
    building.z - s * x * building.width / 2 + c * z * building.depth / 2
  ]);
  return [[building.x, building.z], ...corners, ...corners.map((point, index) => mix(point, corners[(index + 1) % 4], 0.5))];
}

function buildingEarthworkSafe(sample: WorldSettlementSampler, town: TownIntent, building: TownBuilding): boolean {
  const heights = buildingProbePoints(building).map(point => sampleAt(sample, town, point).height).sort((a, b) => a - b);
  const target = heights[Math.floor(heights.length / 2)];
  return heights.every(height => Math.abs(height - target) <= MAX_LOCAL_EARTHWORK + EPS);
}

function landmarkAccessLength(blockSize: number): number {
  // A street-facing civic building needs a short entry walk, not an empty
  // forecourt that consumes a quarter of a compact town's buildable radius.
  return Math.max(2.5, Math.min(5, blockSize / 12));
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

function clipTownSegment(a: Point, b: Point, radius: number): [Point, Point] | undefined {
  const delta=sub(b,a);
  let from=0,to=1;
  for(let axis=0;axis<2;axis++) {
    if(Math.abs(delta[axis])<EPS) {
      if(Math.abs(a[axis])>radius) return undefined;
      continue;
    }
    let near=(-radius-a[axis])/delta[axis],far=(radius-a[axis])/delta[axis];
    if(near>far) [near,far]=[far,near];
    from=Math.max(from,near);to=Math.min(to,far);
    if(from>to) return undefined;
  }
  return [mix(a,b,from),mix(a,b,to)];
}

function inside(town: TownIntent, point: Point, margin: number): boolean {
  return worldTownContainsPoint(town, point, margin);
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
