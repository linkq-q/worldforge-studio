import { WORLD_REGIONS, createWorldSampler, sampleWorldSlope, worldFreshWaterDistance,
  type WorldRecipe, type WorldRegion, type WorldSampler } from './worldTerrain';

type Point = [number, number];

export interface WorldSiteIntent {
  id: string;
  radius: number;
  blend: number;
  region: WorldRegion;
  waterfrontBias?: number;
  targetWaterBodyId?: string;
}

export interface WorldSiteCandidate {
  id: string;
  townId: string;
  center: Point;
  foundation: number;
  dryRatio: number;
  relief: number;
  maxSlope: number;
  passableDirections: number;
  accessDirections: Point[];
  water: null | { distance: number; type: 'sea' | 'lake' | 'river'; id: string | null; direction: Point };
  score: number;
}

export interface WorldRouteResult {
  points: Point[];
  length: number;
  maxSlope: number;
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const pathLength = (points: Point[]) => points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);

function nearestWater(recipe: WorldRecipe, sample: WorldSampler, center: Point, maxDistance: number, target?: string) {
  let best: WorldSiteCandidate['water'] = null;
  const body=target&&target!=='sea'?recipe.waterBodies?.find(item=>item.id===target):undefined;
  const knownDistance=body?worldFreshWaterDistance({seed:recipe.seed,waterBodies:[body]},center[0],center[1]):undefined;
  if(knownDistance!==undefined&&knownDistance>maxDistance) return null;
  const start=knownDistance===undefined?12:Math.max(0,Math.floor(knownDistance/12)*12);
  const end=knownDistance===undefined?maxDistance:Math.min(maxDistance,knownDistance+24);
  for (let ring = start; ring <= end; ring += 12) for (let ray = 0; ray < 24; ray++) {
    const angle = ray * Math.PI / 12, point: Point = [center[0] + Math.cos(angle) * ring, center[1] + Math.sin(angle) * ring];
    const value = sample(point[0], point[1]);
    if (value.waterLevel === null) continue;
    const body = value.waterBodyId ? recipe.waterBodies?.find(item => item.id === value.waterBodyId) : undefined;
    const type=body?.type??'sea';
    if(target && (target==='sea'?type!=='sea':value.waterBodyId!==target)) continue;
    best = { distance: ring, type, id: value.waterBodyId, direction: [Math.cos(angle), Math.sin(angle)] };
    return best;
  }
  return best;
}

function inspectSite(recipe: WorldRecipe, sample: WorldSampler, intent: WorldSiteIntent, center: Point): WorldSiteCandidate | null {
  const values = [];
  let dry = 0, maxSlope = 0;
  for (let iz = -2; iz <= 2; iz++) for (let ix = -2; ix <= 2; ix++) {
    if (ix * ix + iz * iz > 4) continue;
    const x = center[0] + ix * intent.radius / 2, z = center[1] + iz * intent.radius / 2;
    const value = sample(x, z), slope = sampleWorldSlope(sample, x, z);
    values.push(value.height); maxSlope = Math.max(maxSlope, slope);
    if (value.waterLevel === null && value.height > 2) dry++;
  }
  const middle = sample(center[0], center[1]);
  if (middle.waterLevel !== null || middle.height <= 2 || dry < Math.ceil(values.length * 0.52)) return null;
  const dryRatio = dry / values.length;
  const water = nearestWater(recipe, sample, center, Math.max(intent.radius * 2, 160), intent.targetWaterBodyId);
  const target = intent.targetWaterBodyId;
  if (target && (!water || (target === 'sea' ? water.type !== 'sea' : water.id !== target))) return null;
  const accessDirections:Point[] = [];
  for (let ray = 0; ray < 8; ray++) {
    const angle = ray * Math.PI / 4;
    let passable = true;
    for (let step = 1; step <= 4; step++) {
      const x = center[0] + Math.cos(angle) * intent.radius * step / 4;
      const z = center[1] + Math.sin(angle) * intent.radius * step / 4, value = sample(x, z);
      if (value.waterLevel !== null || value.height <= 2 || sampleWorldSlope(sample, x, z) > 0.5) { passable = false; break; }
    }
    if (passable) accessDirections.push([Math.cos(angle),Math.sin(angle)]);
  }
  const passableDirections=accessDirections.length;
  if (passableDirections < 2) return null;
  const relief = Math.max(...values) - Math.min(...values);
  const waterPenalty = (intent.waterfrontBias ?? 0) > 0 && water
    ? Math.abs(water.distance - intent.radius) / Math.max(1, intent.radius) * (intent.waterfrontBias ?? 0) : 0;
  const score = (1 - dryRatio) * 8 + relief / Math.max(8, intent.radius) + maxSlope * 5 + waterPenalty - passableDirections * 0.08;
  return { id: '', townId: intent.id, center, foundation: middle.height, dryRatio, relief, maxSlope,
    passableDirections, accessDirections, water, score };
}

function reachableWaterfront(intent:WorldSiteIntent,candidate:WorldSiteCandidate):boolean {
  if((intent.waterfrontBias??0)<.5) return true;
  if(!candidate.water) return false;
  const reachableShore=reachableShoreDistance(intent.radius,candidate.water.direction);
  return !!candidate.water&&candidate.water.distance<=reachableShore&&candidate.dryRatio>=.68;
}

function reachableShoreDistance(radius:number,direction:Point):number {
  // Shore probes cover the central 0.8r square. Its reach depends on the sampled water direction;
  // settlement then searches another 0.58r from that probe.
  return radius*(.4*(Math.abs(direction[0])+Math.abs(direction[1]))+.58);
}

/** Deterministic, bounded site search over the requested broad world region. */
export function findWorldSiteCandidates(recipe: WorldRecipe, intent: WorldSiteIntent, limit = 8): WorldSiteCandidate[] {
  const sample = createWorldSampler(recipe), anchor = WORLD_REGIONS[intent.region];
  const origin: Point = [anchor[0] * recipe.size / 2, anchor[1] * recipe.size / 2];
  const reach = recipe.size * (intent.region === 'center' ? 0.28 : 0.32);
  const step = Math.max(32, intent.radius * 0.42), bound = recipe.size / 2 - intent.radius - intent.blend;
  const candidates: WorldSiteCandidate[] = [], seen=new Set<string>();
  for (let z = -reach; z <= reach + 1e-6; z += step) for (let x = -reach; x <= reach + 1e-6; x += step) {
    const center: Point = [Math.max(-bound, Math.min(bound, origin[0] + x)), Math.max(-bound, Math.min(bound, origin[1] + z))];
    const key=center.map(value=>value.toFixed(6)).join(':');
    if(seen.has(key)) continue;
    seen.add(key);
    const result = inspectSite(recipe, sample, intent, center);
    if(result&&reachableWaterfront(intent,result)) candidates.push(result);
    if(result&&(intent.waterfrontBias??0)>=.5&&result.water) {
      const reachableShore=reachableShoreDistance(intent.radius,result.water.direction),desired=reachableShore*.85;
      const shift=result.water.distance-desired,projected:Point=[
        Math.max(-bound,Math.min(bound,center[0]+result.water.direction[0]*shift)),
        Math.max(-bound,Math.min(bound,center[1]+result.water.direction[1]*shift))];
      const projectedKey=projected.map(value=>value.toFixed(6)).join(':');
      if(!seen.has(projectedKey)) {
        seen.add(projectedKey);
        const bank=inspectSite(recipe,sample,intent,projected);
        if(bank&&reachableWaterfront(intent,bank)) candidates.push(bank);
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.center[0] - b.center[0] || a.center[1] - b.center[1]);
  const spaced:WorldSiteCandidate[]=[];
  for(const candidate of candidates) {
    if(spaced.every(other=>distance(candidate.center,other.center)>=intent.radius*.6)) spaced.push(candidate);
    if(spaced.length===limit) break;
  }
  return spaced.map((candidate, index) => ({ ...candidate, id: `${intent.id}-site-${index + 1}` }));
}

function routeSafe(sample: WorldSampler, points: Point[], width: number): { maxSlope: number } | null {
  let maxSlope = 0;
  for (let segment = 1; segment < points.length; segment++) {
    const a = points[segment - 1], b = points[segment], length = distance(a, b), steps = Math.max(1, Math.ceil(length / 8));
    const nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
    let previous: number | undefined;
    for (let i = 0; i <= steps; i++) {
      const point = mix(a, b, i / steps), cross = [-width / 2, 0, width / 2].map(offset => sample(point[0] + nx * offset, point[1] + nz * offset));
      if (cross.some(value => value.waterLevel !== null || value.height <= 2)) return null;
      if(Math.max(Math.abs(cross[0].height-cross[1].height),Math.abs(cross[2].height-cross[1].height))>1.5) return null;
      if (previous !== undefined) maxSlope = Math.max(maxSlope, Math.abs(cross[1].height - previous) / (length / steps));
      maxSlope = Math.max(maxSlope, (Math.max(...cross.map(value => value.height)) - Math.min(...cross.map(value => value.height))) / width);
      if (maxSlope > 0.5) return null;
      previous = cross[1].height;
    }
  }
  return { maxSlope };
}

function routeGradeable(sample: WorldSampler, a: Point, b: Point, width: number): { maxSlope: number } | null {
  const length = distance(a, b), steps = Math.max(1, Math.ceil(length / 8));
  if (!length) return null;
  const nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
  let previous: number | undefined, maxSlope = 0;
  for (let i = 0; i <= steps; i++) {
    const point = mix(a, b, i / steps);
    const cross = [-width / 2, 0, width / 2].map(offset => sample(point[0] + nx * offset, point[1] + nz * offset));
    const centerHeight = cross[1].height;
    if (cross.some(value => value.waterLevel !== null || value.height <= 2
      || Math.abs(value.height - centerHeight) > 1.5)) return null;
    if (previous !== undefined) maxSlope = Math.max(maxSlope, Math.abs(cross[1].height - previous) / (length / steps));
    if (maxSlope > 0.5) return null;
    previous = cross[1].height;
  }
  return { maxSlope };
}

function findTerrainAwareRoute(sample: WorldSampler, start: Point, end: Point, width: number): WorldRouteResult | null {
  const directLength = distance(start, end);
  if (directLength > 4096) return null;
  const alongSteps = Math.max(6, Math.min(28, Math.ceil(directLength / Math.max(12, width * 2.4))));
  const step = directLength / alongSteps;
  const lateralSteps = Math.max(3, Math.min(10, Math.ceil(Math.min(128, Math.max(48, directLength * 0.48)) / step)));
  const rows = lateralSteps * 2 + 1;
  const tangent: Point = [(end[0] - start[0]) / directLength, (end[1] - start[1]) / directLength];
  const normal: Point = [-tangent[1], tangent[0]];
  const nodes: Point[] = [];
  for (let column = 0; column <= alongSteps; column++) for (let row = -lateralSteps; row <= lateralSteps; row++) {
    nodes.push([
      start[0] + tangent[0] * step * column + normal[0] * step * row,
      start[1] + tangent[1] * step * column + normal[1] * step * row
    ]);
  }
  const nodeIndex = (column: number, row: number) => column * rows + row + lateralSteps;
  const startIndex = nodeIndex(0, 0), endIndex = nodeIndex(alongSteps, 0);
  const endProbes = Array.from({ length: 32 }, (_, index): Point => {
    const angle = index * Math.PI / 16;
    return [end[0] + Math.cos(angle) * step * 3, end[1] + Math.sin(angle) * step * 3];
  }).map(point => ({ point, safe: routeGradeable(sample, end, point, width) }))
    .filter((item): item is { point: Point; safe: { maxSlope: number } } => !!item.safe);
  const cost = nodes.map(() => Number.POSITIVE_INFINITY), previous = nodes.map(() => -1);
  const open = new Set([startIndex]), edgeCache = new Map<string, { maxSlope: number } | null>();
  const terminalEdgeCache = new Map<string, { maxSlope: number } | null>();
  let endApproach: Point | null = null;
  cost[startIndex] = 0;
  while (open.size) {
    let current = -1, best = Number.POSITIVE_INFINITY;
    for (const index of open) {
      const score = cost[index] + distance(nodes[index], end);
      if (score < best || score === best && index < current) { current = index; best = score; }
    }
    if (current === endIndex) break;
    open.delete(current);
    const column = Math.floor(current / rows), row = current % rows - lateralSteps;
    const visit = (next: number, gradeable = false) => {
      if (next === current) return;
      const key = current < next ? `${current}:${next}` : `${next}:${current}`;
      const cache = gradeable ? terminalEdgeCache : edgeCache;
      let safe = cache.get(key);
      if (safe === undefined) {
        safe = gradeable ? routeGradeable(sample, nodes[current], nodes[next], width)
          : routeSafe(sample, [nodes[current], nodes[next]], width);
        cache.set(key, safe);
      }
      if (!safe) return;
      const nextCost = cost[current] + distance(nodes[current], nodes[next]) * (1 + safe.maxSlope);
      if (nextCost + 1e-9 >= cost[next]) return;
      cost[next] = nextCost; previous[next] = current; if (next === endIndex) endApproach = null; open.add(next);
    };
    for (let dr = -1; dr <= 1; dr++) {
      const dc = 1;
      const nextColumn = column + dc, nextRow = row + dr;
      if (nextColumn < 0 || nextColumn > alongSteps || nextRow < -lateralSteps || nextRow > lateralSteps) continue;
      visit(nodeIndex(nextColumn, nextRow));
    }
    if (distance(nodes[current], end) <= step * 3) visit(endIndex, true);
    if (distance(nodes[current], end) <= step * 6) for (const probe of endProbes) {
      const approach = routeSafe(sample, [nodes[current], probe.point], width);
      if (!approach) continue;
      const nextCost = cost[current] + distance(nodes[current], probe.point) * (1 + approach.maxSlope)
        + distance(probe.point, end) * (1 + probe.safe.maxSlope);
      if (nextCost + 1e-9 >= cost[endIndex]) continue;
      cost[endIndex] = nextCost; previous[endIndex] = current; endApproach = probe.point; open.add(endIndex);
    }
  }
  if (previous[endIndex] < 0) return null;
  const path: Point[] = [];
  for (let index = endIndex; index >= 0; index = previous[index]) {
    path.push(index === startIndex ? start : index === endIndex ? end : nodes[index]);
    if (index === startIndex) break;
  }
  path.reverse();
  if (endApproach) path.splice(path.length - 1, 0, endApproach);
  const simplified: Point[] = [path[0]];
  for (let from = 0; from < path.length - 1;) {
    let next = from + 1;
    for (let candidate = path.length - 1; candidate > from + 1; candidate--) {
      const terminal = (from === 0 || candidate === path.length - 1) && distance(path[from], path[candidate]) <= step * 3;
      if ((terminal ? routeGradeable(sample, path[from], path[candidate], width)
        : routeSafe(sample, [path[from], path[candidate]], width))) { next = candidate; break; }
    }
    simplified.push(path[next]); from = next;
  }
  let maxSlope = 0;
  for (let index = 1; index < simplified.length; index++) {
    const terminal = (index === 1 || index === simplified.length - 1)
      && distance(simplified[index - 1], simplified[index]) <= step * 3;
    const safe = terminal ? routeGradeable(sample, simplified[index - 1], simplified[index], width)
      : routeSafe(sample, [simplified[index - 1], simplified[index]], width);
    if (!safe) return null;
    maxSlope = Math.max(maxSlope, safe.maxSlope);
  }
  return { points: simplified, length: pathLength(simplified), maxSlope };
}

/** Small candidate set matching the settlement kernel's existing direct/elbow/offset routing strategy. */
export function findWorldRoute(sample: WorldSampler, start: Point, end: Point, width: number): WorldRouteResult | null {
  const middle = mix(start, end, 0.5), dx = end[0] - start[0], dz = end[1] - start[1], length = Math.hypot(dx, dz);
  if (!length) return null;
  const normal: Point = [-dz / length, dx / length], offsets = [0, 0.12, -0.12, 0.24, -0.24];
  const routes: Point[][] = [[start, [start[0], end[1]], end], [start, [end[0], start[1]], end],
    ...offsets.map(offset => [start, [middle[0] + normal[0] * length * offset, middle[1] + normal[1] * length * offset] as Point, end])];
  const shortcut = routes.map(points => {
    const clean=points.filter((p, i) => !i || distance(p, points[i - 1]) > 1e-6);
    return {points:clean,safe:routeSafe(sample,clean,width)};
  })
    .filter((item): item is { points: Point[]; safe: { maxSlope: number } } => !!item.safe)
    .map(item => ({ points: item.points, length: pathLength(item.points), maxSlope: item.safe.maxSlope }))
    .sort((a, b) => a.length - b.length)[0] ?? null;
  return shortcut ?? findTerrainAwareRoute(sample, start, end, width);
}
