/** Bounded, pure geometry for road-connected urban fabric and analogous layouts. */
export type UrbanPoint = [number, number];
export interface UrbanLayoutBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface UrbanLayoutOptions {
  id?: string;
  pattern?: 'grid' | 'radial' | 'branching' | 'organic';
  center?: UrbanPoint;
  size?: UrbanPoint;
  rotation?: number;
  region?: UrbanPoint[];
  blockSize?: number | UrbanPoint;
  roadWidth?: number;
  arterialWidth?: number;
  irregularity?: number;
  parcelWidth?: number;
  parcelDepth?: number;
  setback?: number;
  seed?: number;
  rings?: number;
  spokes?: number;
}
export interface UrbanRoad {
  id: string;
  points: UrbanPoint[];
  width: number;
  kind: 'arterial' | 'street';
  closed: boolean;
}
export interface UrbanBlock { id: string; points: UrbanPoint[]; center: UrbanPoint }
export interface UrbanParcel {
  id: string;
  blockId: string;
  roadId: string;
  center: UrbanPoint;
  width: number;
  depth: number;
  rotationY: number;
  /** Point on the road centerline facing the local Z+ entrance. */
  front: UrbanPoint;
  points: UrbanPoint[];
}
export interface UrbanLayout { roads: UrbanRoad[]; blocks: UrbanBlock[]; parcels: UrbanParcel[] }

const EPS = 1e-7;
const MAX_BLOCKS = 64;
const MAX_PARCELS = 512;
const MAX_ROADS = 80;
// Coordinate arithmetic loses meaningful map-scale detail at astronomical magnitudes.
const MAX_SPATIAL_VALUE = 1_000_000;

/** Returns geometry only; the scene program chooses surfaces, assets, heights and omissions. */
export function createUrbanLayout(options: UrbanLayoutOptions, bounds: UrbanLayoutBounds, seed = 1): UrbanLayout {
  if (!options || typeof options !== 'object' || !bounds || !Object.values(bounds).every(value => Number.isFinite(value) && Math.abs(value) <= MAX_SPATIAL_VALUE)
    || !(bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ)) throw new Error('invalid_urban_layout_bounds');
  const pattern = options.pattern ?? 'grid';
  if (!['grid', 'radial', 'branching', 'organic'].includes(pattern)) throw new Error('invalid_urban_layout_pattern');
  const mapWidth = bounds.maxX - bounds.minX, mapDepth = bounds.maxZ - bounds.minZ;
  if (!Number.isFinite(mapWidth) || !Number.isFinite(mapDepth)) throw new Error('invalid_urban_layout_bounds');
  const roadWidth = positive(options.roadWidth, 3);
  const arterialWidth = Math.max(roadWidth, positive(options.arterialWidth, roadWidth * 1.5));
  const setback = nonnegative(options.setback, 0.8);
  const parcelWidth = positive(options.parcelWidth, 7);
  const parcelDepth = positive(options.parcelDepth, 9);
  const irregularity = Math.min(1, nonnegative(options.irregularity, 0.35));
  const angle = (finite(options.rotation, 0) % 360) * Math.PI / 180;
  const random = seededRandom(finite(options.seed, finite(seed, 1)));
  const center = options.center === undefined ? [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2] as UrbanPoint : point(options.center);
  const size = options.size === undefined ? [mapWidth * 0.9, mapDepth * 0.9] as UrbanPoint : point(options.size);
  if (size.some(value => value <= 0)) throw new Error('invalid_urban_layout_size');
  const blockSize = Array.isArray(options.blockSize) ? point(options.blockSize)
    : [positive(options.blockSize, 24), positive(options.blockSize, 24)] as UrbanPoint;
  if (blockSize.some(value => value <= 0)) throw new Error('invalid_urban_layout_block_size');
  const prefix = typeof options.id === 'string' ? options.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'urban' : 'urban';
  const result: UrbanLayout = { roads: [], blocks: [], parcels: [] };
  const margin = arterialWidth / 2 + 0.001;
  const region = options.region === undefined ? undefined : convexRegion(options.region);
  if (mapWidth <= margin * 2 || mapDepth <= margin * 2) return result;
  const toWorld = (x: number, z: number): UrbanPoint => [center[0] + x * Math.cos(angle) - z * Math.sin(angle), center[1] + x * Math.sin(angle) + z * Math.cos(angle)];
  let domain = rectangle(size[0], size[1]).map(([x, z]) => toWorld(x, z));
  domain = clipPolygon(domain, [
    [bounds.minX + margin, bounds.minZ + margin], [bounds.maxX - margin, bounds.minZ + margin],
    [bounds.maxX - margin, bounds.maxZ - margin], [bounds.minX + margin, bounds.maxZ - margin]
  ]);
  if (region) domain = clipPolygon(domain, region);
  if (domain.length < 3 || area(domain) < 1) return result;
  const rawBlocks: UrbanPoint[][] = [];
  const road = (points: UrbanPoint[], kind: UrbanRoad['kind'], closed = false): void => {
    if (result.roads.length >= MAX_ROADS || points.length < 2) return;
    const vertices = points.map(p => [...p] as UrbanPoint);
    if (closed && length(sub(vertices[0], vertices.at(-1)!)) > EPS) vertices.push([...vertices[0]]);
    result.roads.push({ id: `${prefix}-road-${result.roads.length + 1}`, points: vertices, width: kind === 'arterial' ? arterialWidth : roadWidth, kind, closed });
  };
  const clippedRoad = (points: UrbanPoint[], kind: UrbanRoad['kind']): void => {
    let run: UrbanPoint[] = [];
    for (let index = 1; index < points.length; index++) {
      const segment = clipSegment(points[index - 1], points[index], domain);
      if (!segment) {
        if (run.length > 1) road(run, kind);
        run = [];
        continue;
      }
      if (run.length && length(sub(run.at(-1)!, segment[0])) > EPS) {
        road(run, kind);
        run = [];
      }
      if (!run.length) run.push(segment[0]);
      run.push(segment[1]);
    }
    if (run.length > 1) road(run, kind);
  };

  if (pattern === 'grid') {
    const columns = Math.max(1, Math.min(8, Math.round(size[0] / (blockSize[0] + roadWidth))));
    const rows = Math.max(1, Math.min(Math.floor(MAX_BLOCKS / columns), 8, Math.round(size[1] / (blockSize[1] + roadWidth))));
    const dx = size[0] / columns, dz = size[1] / rows;
    const nodes = Array.from({ length: rows + 1 }, (_, row) => Array.from({ length: columns + 1 }, (_, column) => {
      const internal = row > 0 && row < rows && column > 0 && column < columns;
      const jitter = internal ? irregularity * 0.18 : 0;
      return toWorld(-size[0] / 2 + column * dx + (random() * 2 - 1) * dx * jitter,
        -size[1] / 2 + row * dz + (random() * 2 - 1) * dz * jitter);
    }));
    road(domain, 'arterial', true);
    for (let row = 1; row < rows; row++) clippedRoad(nodes[row], row === Math.floor(rows / 2) ? 'arterial' : 'street');
    for (let column = 1; column < columns; column++) clippedRoad(nodes.map(row => row[column]), column === Math.floor(columns / 2) ? 'arterial' : 'street');
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const polygon = clipPolygon([nodes[row][column], nodes[row][column + 1], nodes[row + 1][column + 1], nodes[row + 1][column]], domain);
        if (polygon.length >= 3 && area(polygon) > 1) rawBlocks.push(polygon);
      }
    }
  } else if (pattern === 'radial') {
    const hub = centroid(domain);
    const rings = Math.max(2, Math.min(6, Math.round(positive(options.rings, Math.min(size[0], size[1]) / (2 * Math.min(...blockSize)) + 1))));
    const spokes = Math.max(4, Math.min(16, Math.floor(MAX_BLOCKS / (rings - 1)), Math.round(positive(options.spokes, 10))));
    const outer = Array.from({ length: spokes }, (_, index): UrbanPoint => {
      const theta = index / spokes * Math.PI * 2 + angle + (random() - 0.5) * irregularity * Math.PI / spokes * 0.45;
      const direction: UrbanPoint = [Math.cos(theta), Math.sin(theta)];
      const local = theta - angle;
      const ellipseRadius = 1 / Math.hypot(Math.cos(local) / (size[0] / 2), Math.sin(local) / (size[1] / 2));
      let radius = ellipseRadius;
      for (let edge = 0; edge < domain.length; edge++) {
        const a = domain[edge], b = domain[(edge + 1) % domain.length], normal = inward(a, b);
        const toward = dot(normal, direction);
        if (toward < -EPS) radius = Math.min(radius, dot(normal, sub(hub, a)) / -toward);
      }
      return add(hub, scale(direction, radius * 0.99));
    });
    const ringNodes = Array.from({ length: rings }, (_, index) => {
      const radius = 0.2 + index / (rings - 1) * 0.8;
      return outer.map(p => add(hub, scale(sub(p, hub), radius)));
    });
    for (let index = 0; index < rings; index++) road(ringNodes[index], index === 0 || index === rings - 1 ? 'arterial' : 'street', true);
    for (let spoke = 0; spoke < spokes; spoke++) road(ringNodes.map(nodes => nodes[spoke]), spoke % 3 === 0 ? 'arterial' : 'street');
    for (let ring = 1; ring < rings; ring++) {
      for (let spoke = 0; spoke < spokes; spoke++) {
        const next = (spoke + 1) % spokes;
        rawBlocks.push([ringNodes[ring - 1][spoke], ringNodes[ring][spoke], ringNodes[ring][next], ringNodes[ring - 1][next]]);
      }
    }
  } else if (pattern === 'organic') {
    // A planar Voronoi graph has fewer than 3N internal edges; 26 sites fit the road budget.
    const targetArea = Math.max((roadWidth * 2 + 2) ** 2, (blockSize[0] + roadWidth) * (blockSize[1] + roadWidth));
    const siteCount = Math.max(1, Math.min(26, Math.round(area(domain) / targetArea)));
    const triangles = domain.slice(2).map((end, index) => ({ a: domain[0], b: domain[index + 1], c: end,
      area: area([domain[0], domain[index + 1], end]) }));
    const totalArea = triangles.reduce((sum, triangle) => sum + triangle.area, 0);
    const sampleSite = (): UrbanPoint => {
      let remaining = random() * totalArea;
      const triangle = triangles.find(candidate => (remaining -= candidate.area) <= 0) ?? triangles.at(-1)!;
      const radius = Math.sqrt(random()), fraction = random();
      return add(triangle.a, add(scale(sub(triangle.b, triangle.a), radius * (1 - fraction)),
        scale(sub(triangle.c, triangle.a), radius * fraction)));
    };
    const sites: UrbanPoint[] = [];
    const candidates = Math.round(3 + (1 - irregularity) * 13);
    for (let index = 0; index < siteCount; index++) {
      let best = sampleSite(), separation = -1;
      for (let candidate = 0; candidate < candidates; candidate++) {
        const point = sampleSite();
        const nearest = sites.length ? Math.min(...sites.map(site => length(sub(site, point)))) : 1;
        if (nearest > separation) { best = point; separation = nearest; }
      }
      sites.push(best);
    }
    const relaxation = (1 - irregularity) * 0.65;
    if (relaxation > 0) {
      const cells = voronoiCells(sites, domain);
      for (let index = 0; index < sites.length; index++) {
        if (cells[index].length >= 3 && area(cells[index]) > EPS) sites[index] = add(sites[index], scale(sub(centroid(cells[index]), sites[index]), relaxation));
      }
    }
    const cells = voronoiCells(sites, domain).filter(cell => cell.length >= 3 && area(cell) > EPS);
    road(domain, 'arterial', true);
    rawBlocks.push(...cells);
    const vertices: UrbanPoint[] = [];
    const vertexId = (point: UrbanPoint): number => {
      const existing = vertices.findIndex(vertex => length(sub(vertex, point)) < 1e-5);
      if (existing >= 0) return existing;
      vertices.push(point);
      return vertices.length - 1;
    };
    const emitted = new Set<string>();
    for (const cell of cells) {
      for (let index = 0; index < cell.length; index++) {
        const a = cell[index], b = cell[(index + 1) % cell.length], middle = scale(add(a, b), 0.5);
        if (domain.some((start, edge) => distanceToSegment(middle, start, domain[(edge + 1) % domain.length]) < 1e-5)) continue;
        const from = vertexId(a), to = vertexId(b);
        if (from === to) continue;
        const key = from < to ? `${from}:${to}` : `${to}:${from}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        road([vertices[from], vertices[to]], 'street');
      }
    }
  } else {
    road(domain, 'arterial', true);
    rawBlocks.push(domain);
    const targetArea = Math.max((roadWidth * 2 + 2) ** 2, (blockSize[0] + roadWidth) * (blockSize[1] + roadWidth));
    for (let split = 0; split < MAX_BLOCKS - 1; split++) {
      const candidates = rawBlocks.map((polygon, index) => ({ polygon, index, area: area(polygon) })).sort((a, b) => b.area - a.area);
      const candidate = candidates[0];
      if (!candidate || candidate.area <= targetArea * 1.3) break;
      const axisX: UrbanPoint = [Math.cos(angle), Math.sin(angle)], axisZ: UrbanPoint = [-axisX[1], axisX[0]];
      const range = (axis: UrbanPoint) => {
        const values = candidate.polygon.map(p => dot(p, axis));
        return Math.max(...values) - Math.min(...values);
      };
      const splitAngle = angle + (range(axisX) >= range(axisZ) ? 0 : Math.PI / 2) + (random() - 0.5) * irregularity * 0.9;
      const normal: UrbanPoint = [Math.cos(splitAngle), Math.sin(splitAngle)];
      const projections = candidate.polygon.map(p => dot(p, normal));
      const low = Math.min(...projections), high = Math.max(...projections);
      const cut = (low + high) / 2 + (random() - 0.5) * irregularity * (high - low) * 0.25;
      const left = clipHalfPlane(candidate.polygon, normal, cut);
      const right = clipHalfPlane(candidate.polygon, scale(normal, -1), -cut);
      if (left.length < 3 || right.length < 3 || Math.min(area(left), area(right)) < 1) break;
      const endpoints = left.filter(p => Math.abs(dot(p, normal) - cut) < 1e-5);
      if (endpoints.length < 2) break;
      road([endpoints[0], endpoints.at(-1)!], split < 2 ? 'arterial' : 'street');
      rawBlocks.splice(candidate.index, 1, left, right);
    }
  }

  const segments = result.roads.flatMap(road => road.points.slice(1).map((b, index) => ({ road, a: road.points[index], b })));
  for (const raw of rawBlocks) {
    let buildable = raw;
    for (let index = 0; index < raw.length && buildable.length >= 3; index++) {
      const a = raw[index], b = raw[(index + 1) % raw.length];
      const middle = scale(add(a, b), 0.5);
      const owner = segments.reduce((best, segment) => distanceToSegment(middle, segment.a, segment.b) < distanceToSegment(middle, best.a, best.b) ? segment : best, segments[0]);
      const normal = inward(a, b);
      buildable = clipHalfPlane(buildable, normal, dot(normal, a) + owner.road.width / 2 + setback);
    }
    if (buildable.length >= 3 && area(buildable) > 1) result.blocks.push({ id: `${prefix}-block-${result.blocks.length + 1}`, points: buildable, center: centroid(buildable) });
  }

  const parcelBudget = Math.max(1, Math.floor(MAX_PARCELS / Math.max(1, result.blocks.length)));
  for (const block of result.blocks) {
    const localParcels: UrbanParcel[] = [];
    const edges = block.points.map((a, index) => ({ a, b: block.points[(index + 1) % block.points.length] }));
    // Longer frontages first leaves useful corner and courtyard voids rather than overlapping lots.
    edges.sort((a, b) => length(sub(b.b, b.a)) - length(sub(a.b, a.a)));
    for (const edge of edges) {
      const edgeLength = length(sub(edge.b, edge.a));
      const tangent = scale(sub(edge.b, edge.a), 1 / edgeLength), normal = inward(edge.a, edge.b);
      const count = Math.max(1, Math.min(parcelBudget, Math.round(edgeLength / Math.max(0.5, parcelWidth))));
      const span = edgeLength / count;
      for (let slot = 0; slot < count && localParcels.length < parcelBudget; slot++) {
        // A capped parcel budget must not stretch a small target width across a huge frontage.
        const width = Math.min(parcelWidth * 1.5, span * (0.94 + random() * 0.04));
        const frontCenter = add(add(edge.a, scale(tangent, (slot + 0.5) * span)), scale(normal, 0.002));
        const corners = [add(frontCenter, scale(tangent, -width / 2)), add(frontCenter, scale(tangent, width / 2))];
        let depth = parcelDepth * (0.82 + random() * 0.28);
        for (const side of edges) {
          const sideNormal = inward(side.a, side.b), toward = dot(sideNormal, normal);
          for (const corner of corners) {
            const available = dot(sideNormal, sub(corner, side.a));
            if (available < -EPS) depth = 0;
            else if (toward < -EPS) depth = Math.min(depth, available / -toward - 0.002);
          }
        }
        const minimumDepth = Math.min(parcelDepth * 0.35, 2);
        if (width < 0.3 || depth < Math.max(0.3, minimumDepth)) continue;
        const footprint = (value: number): UrbanPoint[] => [corners[0], corners[1], add(corners[1], scale(normal, value)), add(corners[0], scale(normal, value))];
        const safe = (points: UrbanPoint[]) => !localParcels.some(parcel => polygonOverlap(parcel.points, points))
          && segments.every(segment => polygonSegmentDistance(points, segment.a, segment.b) >= segment.road.width / 2 + setback - 1e-5);
        if (!safe(footprint(depth))) {
          if (!safe(footprint(minimumDepth))) continue;
          let low = minimumDepth, high = depth;
          for (let attempt = 0; attempt < 12; attempt++) {
            const middle = (low + high) / 2;
            if (safe(footprint(middle))) low = middle;
            else high = middle;
          }
          depth = low;
        }
        const nearest = segments.reduce((best, segment) => distanceToSegment(frontCenter, segment.a, segment.b) < distanceToSegment(frontCenter, best.a, best.b) ? segment : best, segments[0]);
        const parcel: UrbanParcel = {
          id: `${prefix}-parcel-${result.parcels.length + localParcels.length + 1}`,
          blockId: block.id, roadId: nearest.road.id,
          center: add(frontCenter, scale(normal, depth / 2)), width, depth,
          rotationY: Math.atan2(-normal[0], -normal[1]),
          front: nearestPoint(frontCenter, nearest.a, nearest.b), points: footprint(depth)
        };
        localParcels.push(parcel);
      }
    }
    result.parcels.push(...localParcels);
  }
  return result;
}

function voronoiCells(sites: UrbanPoint[], domain: UrbanPoint[]): UrbanPoint[][] {
  return sites.map((site, index) => {
    let cell = domain;
    for (let other = 0; other < sites.length && cell.length >= 3; other++) {
      if (other === index) continue;
      const direction = sub(site, sites[other]), distance = length(direction);
      if (distance < EPS) continue;
      const normal = scale(direction, 1 / distance);
      cell = clipHalfPlane(cell, normal, dot(normal, scale(add(site, sites[other]), 0.5)));
    }
    return cell;
  });
}
function finite(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('invalid_urban_layout_number');
  return result;
}
function positive(value: unknown, fallback: number): number {
  const result = finite(value, fallback);
  if (result <= 0) throw new Error('invalid_urban_layout_dimension');
  return result;
}
function nonnegative(value: unknown, fallback: number): number {
  const result = finite(value, fallback);
  if (result < 0) throw new Error('invalid_urban_layout_dimension');
  return result;
}
function point(value: UrbanPoint): UrbanPoint {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(item => Number.isFinite(item) && Math.abs(item) <= MAX_SPATIAL_VALUE)) throw new Error('invalid_urban_layout_point');
  return [value[0], value[1]];
}
function rectangle(width: number, depth: number): UrbanPoint[] {
  return [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
}
function add(a: UrbanPoint, b: UrbanPoint): UrbanPoint { return [a[0] + b[0], a[1] + b[1]]; }
function sub(a: UrbanPoint, b: UrbanPoint): UrbanPoint { return [a[0] - b[0], a[1] - b[1]]; }
function scale(a: UrbanPoint, value: number): UrbanPoint { return [a[0] * value, a[1] * value]; }
function dot(a: UrbanPoint, b: UrbanPoint): number { return a[0] * b[0] + a[1] * b[1]; }
function length(a: UrbanPoint): number { return Math.hypot(a[0], a[1]); }
function inward(a: UrbanPoint, b: UrbanPoint): UrbanPoint {
  const d = sub(b, a), size = length(d);
  return [-d[1] / size, d[0] / size];
}
function area(points: UrbanPoint[]): number {
  return points.reduce((sum, a, index) => {
    const b = points[(index + 1) % points.length];
    return sum + a[0] * b[1] - a[1] * b[0];
  }, 0) / 2;
}
function centroid(points: UrbanPoint[]): UrbanPoint {
  let x = 0, z = 0, total = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length], cross = a[0] * b[1] - b[0] * a[1];
    x += (a[0] + b[0]) * cross;
    z += (a[1] + b[1]) * cross;
    total += cross;
  }
  return [x / (3 * total), z / (3 * total)];
}
function cleanPolygon(points: UrbanPoint[]): UrbanPoint[] {
  const clean = points.filter((p, i) => length(sub(p, points[(i + points.length - 1) % points.length])) > EPS);
  return clean.filter((p, i) => {
    const before = sub(p, clean[(i + clean.length - 1) % clean.length]), after = sub(clean[(i + 1) % clean.length], p);
    return Math.abs(before[0] * after[1] - before[1] * after[0]) > EPS;
  });
}
function convexRegion(value: UrbanPoint[]): UrbanPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 64) throw new Error('invalid_urban_layout_region');
  const vertices = value.map(point);
  if (length(sub(vertices[0], vertices.at(-1)!)) <= EPS) vertices.pop();
  let points = cleanPolygon(vertices);
  if (area(points) < 0) points = points.reverse();
  if (points.length < 3 || area(points) < EPS || points.some((a, index) => {
    const normal = inward(a, points[(index + 1) % points.length]);
    return points.some(p => dot(normal, sub(p, a)) < -EPS);
  })) throw new Error('invalid_urban_layout_region');
  return points;
}
function clipHalfPlane(points: UrbanPoint[], normal: UrbanPoint, limit: number): UrbanPoint[] {
  const result: UrbanPoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const da = dot(a, normal) - limit, db = dot(b, normal) - limit;
    if (da >= -EPS) result.push(a);
    if ((da >= -EPS) !== (db >= -EPS)) result.push(add(a, scale(sub(b, a), da / (da - db))));
  }
  return cleanPolygon(result);
}
function clipPolygon(points: UrbanPoint[], boundary: UrbanPoint[]): UrbanPoint[] {
  let result = points;
  for (let index = 0; index < boundary.length && result.length >= 3; index++) {
    const a = boundary[index], normal = inward(a, boundary[(index + 1) % boundary.length]);
    result = clipHalfPlane(result, normal, dot(normal, a));
  }
  return result;
}
function clipSegment(a: UrbanPoint, b: UrbanPoint, boundary: UrbanPoint[]): [UrbanPoint, UrbanPoint] | null {
  let low = 0, high = 1;
  const direction = sub(b, a);
  for (let index = 0; index < boundary.length; index++) {
    const start = boundary[index], normal = inward(start, boundary[(index + 1) % boundary.length]);
    const value = dot(normal, sub(a, start)), change = dot(normal, direction);
    if (Math.abs(change) < EPS) { if (value < -EPS) return null; }
    else if (change > 0) low = Math.max(low, -value / change);
    else high = Math.min(high, -value / change);
  }
  return high - low > EPS ? [add(a, scale(direction, low)), add(a, scale(direction, high))] : null;
}
function nearestPoint(point: UrbanPoint, a: UrbanPoint, b: UrbanPoint): UrbanPoint {
  const direction = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(point, a), direction) / (dot(direction, direction) || 1)));
  return add(a, scale(direction, t));
}
function distanceToSegment(point: UrbanPoint, a: UrbanPoint, b: UrbanPoint): number { return length(sub(point, nearestPoint(point, a, b))); }
function polygonSegmentDistance(points: UrbanPoint[], a: UrbanPoint, b: UrbanPoint): number {
  if (clipSegment(a, b, points)) return 0;
  let distance = Infinity;
  for (let index = 0; index < points.length; index++) {
    const p = points[index], q = points[(index + 1) % points.length];
    distance = Math.min(distance, distanceToSegment(p, a, b), distanceToSegment(a, p, q), distanceToSegment(b, p, q));
  }
  return distance;
}
function polygonOverlap(a: UrbanPoint[], b: UrbanPoint[]): boolean {
  for (const polygon of [a, b]) {
    for (let index = 0; index < polygon.length; index++) {
      const axis = inward(polygon[index], polygon[(index + 1) % polygon.length]);
      const av = a.map(p => dot(p, axis)), bv = b.map(p => dot(p, axis));
      if (Math.max(...av) <= Math.min(...bv) + EPS || Math.max(...bv) <= Math.min(...av) + EPS) return false;
    }
  }
  return true;
}
function seededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
