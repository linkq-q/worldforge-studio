import type { EditableMap } from './map';
import { pointInPolygon } from './mapLayout';
import { visualZoneWeight } from './visualDirection';

/** Render-derived coast data; never written back to the authored height field. */
export interface CoastGrid {
  heights: ArrayLike<number>;
  width: number;
  depth: number;
  minX: number;
  minZ: number;
  stepX: number;
  stepZ: number;
}

export type CoastPoint = readonly [number, number];

export interface OceanCoastField extends CoastGrid {
  heights: Float32Array;
  distances: Float32Array;
  level: number;
  sinkTarget: number;
  floorTarget: number;
  shoreWidth: number;
  loops: CoastPoint[][];
}

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

export function buildOceanCoastField(map: EditableMap, level: number): OceanCoastField {
  const terrain = map.terrain;
  const flatAtOceanLevel = terrain.heights.every((height) => Math.abs(height - level) <= 0.02);
  const explicitOceans = flatAtOceanLevel
    ? map.waterBodies.filter((water) => water.type === 'ocean' && water.id !== 'terrain-ocean' && water.points.length >= 3)
    : [];
  const stepX = map.box.size[0] / (terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / (terrain.resolutionZ - 1);
  const cell = Math.min(stepX, stepZ);
  const shoreWidth = Math.max(6, Math.min(12, cell * 4));
  const sinkTarget = level - 6;
  const floorTarget = level - Math.max(24, map.box.size[1] * 2);
  const paddingX = Math.ceil((shoreWidth + cell * 3) / stepX);
  const paddingZ = Math.ceil((shoreWidth + cell * 3) / stepZ);
  const source: CoastGrid = {
    width: terrain.resolutionX + paddingX * 2, depth: terrain.resolutionZ + paddingZ * 2,
    minX: -map.box.size[0] / 2 - paddingX * stepX, minZ: -map.box.size[2] / 2 - paddingZ * stepZ,
    stepX, stepZ, heights: []
  };
  const sourceHeights = new Float32Array(source.width * source.depth);
  const coastHeights = explicitOceans.length ? new Float32Array(source.width * source.depth) : sourceHeights;
  source.heights = sourceHeights;
  for (let z = 0; z < source.depth; z++) {
    for (let x = 0; x < source.width; x++) {
      const sx = Math.max(0, Math.min(terrain.resolutionX - 1, x - paddingX));
      const sz = Math.max(0, Math.min(terrain.resolutionZ - 1, z - paddingZ));
      const height = terrain.heights[sz * terrain.resolutionX + sx];
      const distance = Math.hypot((x - paddingX - sx) * stepX, (z - paddingZ - sz) * stepZ);
      // An explicit ocean polygon owns the land/sea classification. Keep the
      // authored land height separate so flat sea-level sites do not sink.
      const base = explicitOceans.length
        ? height
        : Math.abs(height - level) <= 0.02 ? level - 0.02 : height;
      const sunk = base + (Math.min(base, sinkTarget) - base) * smooth(distance / shoreWidth);
      sourceHeights[z * source.width + x] = sunk + (floorTarget - sunk)
        * smooth((distance - shoreWidth) / (cell * 3));
      if (explicitOceans.length) {
        const wx = source.minX + x * stepX;
        const wz = source.minZ + z * stepZ;
        const outsideTerrain = x < paddingX || x >= paddingX + terrain.resolutionX
          || z < paddingZ || z >= paddingZ + terrain.resolutionZ;
        coastHeights[z * source.width + x] = outsideTerrain
          || explicitOceans.some((water) => pointInPolygon(wx, wz, water.points))
          ? level - 0.02
          : level + 0.02;
      }
    }
  }
  const loops = smoothCoastLoops(extractCoastLoops({ ...source, heights: coastHeights }, level), cell);
  const width = (source.width - 1) * 3 + 1, depth = (source.depth - 1) * 3 + 1;
  const field: OceanCoastField = { ...source, width, depth, stepX: stepX / 3, stepZ: stepZ / 3,
    heights: new Float32Array(width * depth), distances: new Float32Array(width * depth), level, sinkTarget, floorTarget, shoreWidth, loops };
  const segments = loops.flatMap(loop => loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length] })));
  // Index only the coast band; don't compare every terrain sample with every edge.
  const buckets = new Map<string, typeof segments>();
  const reach = shoreWidth + cell * 2;
  for (const segment of segments) {
    for (let z = Math.floor((Math.min(segment.a[1], segment.b[1]) - reach) / reach); z <= Math.floor((Math.max(segment.a[1], segment.b[1]) + reach) / reach); z++) {
      for (let x = Math.floor((Math.min(segment.a[0], segment.b[0]) - reach) / reach); x <= Math.floor((Math.max(segment.a[0], segment.b[0]) + reach) / reach); x++) {
        const key = `${x}:${z}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(segment);
        buckets.set(key, bucket);
      }
    }
  }
  const rocky = map.visualSemantics.zones.filter(zone => zone.tags.includes('rocky'));
  const sandy = map.visualSemantics.zones.filter(zone => zone.tags.includes('sand'));
  for (let z = 0; z < depth; z++) {
    const wz = field.minZ + z * field.stepZ;
    const crossings = segments.filter(({ a, b }) => (a[1] > wz) !== (b[1] > wz))
      .map(({ a, b }) => a[0] + (b[0] - a[0]) * (wz - a[1]) / (b[1] - a[1])).sort((a, b) => a - b);
    let crossing = 0;
    for (let x = 0; x < width; x++) {
      const wx = field.minX + x * field.stepX;
      while (crossing < crossings.length && crossings[crossing] < wx) crossing++;
      const land = crossing % 2 === 1;
      let distance = reach, nearestX = wx, nearestZ = wz;
      for (const { a, b } of buckets.get(`${Math.floor(wx / reach)}:${Math.floor(wz / reach)}`) ?? []) {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((wx - a[0]) * dx + (wz - a[1]) * dz) / Math.max(1e-12, dx * dx + dz * dz)));
        const px = a[0] + dx * t, pz = a[1] + dz * t;
        const candidate = Math.hypot(wx - px, wz - pz);
        if (candidate < distance) { distance = candidate; nearestX = px; nearestZ = pz; }
      }
      const index = z * width + x;
      field.distances[index] = land ? -distance : distance;
      const authored = sampleCoastGrid(source, wx, wz);
      if (land) {
        // Restrict above-water displacement to a small tidal band; foundations stay fixed.
        const keep = Math.max(smooth(distance / (cell * 2)), smooth((authored - level) / 0.5));
        const target = level + distance * 0.2;
        field.heights[index] = target + (authored - target) * keep;
      } else {
        let rock = 0, sand = 0;
        for (const zone of rocky) rock = Math.max(rock, visualZoneWeight(zone, nearestX, nearestZ));
        for (const zone of sandy) sand = Math.max(sand, visualZoneWeight(zone, nearestX, nearestZ));
        const dx = (sampleCoastGrid(source, nearestX + cell, nearestZ) - sampleCoastGrid(source, nearestX - cell, nearestZ)) / (2 * cell);
        const dz = (sampleCoastGrid(source, nearestX, nearestZ + cell) - sampleCoastGrid(source, nearestX, nearestZ - cell)) / (2 * cell);
        const steep = Math.max(rock, smooth((Math.hypot(dx, dz) - 0.35) / 0.65)) * (1 - sand);
        const widthAtCoast = shoreWidth * (1 - steep * 0.5);
        const t = Math.min(1, distance / widthAtCoast);
        // Nonzero tangent at the waterline, horizontal tangent in deep water.
        const profile = level + (sinkTarget - level) * (t * t * (3 - 2 * t) * 0.8 + (2 * t - t * t) * 0.2);
        field.heights[index] = profile + (Math.min(profile, authored) - profile) * smooth(distance / (cell * 2));
      }
    }
  }
  return field;
}

export function sampleCoastGrid(grid: CoastGrid, x: number, z: number): number {
  const gx = Math.max(0, Math.min(grid.width - 1, (x - grid.minX) / grid.stepX));
  const gz = Math.max(0, Math.min(grid.depth - 1, (z - grid.minZ) / grid.stepZ));
  const ix = Math.min(grid.width - 2, Math.floor(gx));
  const iz = Math.min(grid.depth - 2, Math.floor(gz));
  const fx = gx - ix, fz = gz - iz;
  const a = grid.heights[iz * grid.width + ix];
  const b = grid.heights[iz * grid.width + ix + 1];
  const c = grid.heights[(iz + 1) * grid.width + ix];
  const d = grid.heights[(iz + 1) * grid.width + ix + 1];
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** March triangles instead of a binary cell boundary, including sub-cell crossings. */
export function extractCoastLoops(grid: CoastGrid, level: number): CoastPoint[][] {
  const points: CoastPoint[] = [];
  const crossings = new Map<string, number>();
  const adjacent = new Map<number, number[]>();
  const crossing = (a: number, b: number): number => {
    const t = (level - grid.heights[a]) / (grid.heights[b] - grid.heights[a]);
    const key = t < 1e-8 ? `v${a}` : t > 1 - 1e-8 ? `v${b}` : `${Math.min(a, b)}:${Math.max(a, b)}`;
    const cached = crossings.get(key);
    if (cached !== undefined) return cached;
    const index = points.length;
    points.push([
      grid.minX + ((a % grid.width) + ((b % grid.width) - (a % grid.width)) * t) * grid.stepX,
      grid.minZ + (Math.floor(a / grid.width) + (Math.floor(b / grid.width) - Math.floor(a / grid.width)) * t) * grid.stepZ
    ]);
    crossings.set(key, index);
    return index;
  };
  for (let z = 0; z < grid.depth - 1; z++) {
    for (let x = 0; x < grid.width - 1; x++) {
      const a = z * grid.width + x, b = a + 1, c = a + grid.width, d = c + 1;
      for (const triangle of [[a, c, b], [b, c, d]]) {
        const ends: number[] = [];
        for (let edge = 0; edge < 3; edge++) {
          const p = triangle[edge], q = triangle[(edge + 1) % 3];
          if ((grid.heights[p] > level) !== (grid.heights[q] > level)) ends.push(crossing(p, q));
        }
        if (ends.length !== 2 || ends[0] === ends[1]) continue;
        for (const [p, q] of [ends, [ends[1], ends[0]]]) {
          const neighbors = adjacent.get(p) ?? [];
          if (!neighbors.includes(q)) neighbors.push(q);
          adjacent.set(p, neighbors);
        }
      }
    }
  }
  const visited = new Set<number>();
  const loops: CoastPoint[][] = [];
  for (const start of adjacent.keys()) {
    if (visited.has(start)) continue;
    const loop: CoastPoint[] = [];
    let previous = -1, current = start;
    while (!visited.has(current)) {
      visited.add(current);
      loop.push(points[current]);
      const neighbors = adjacent.get(current) ?? [];
      if (neighbors.length !== 2) break;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current;
      current = next;
    }
    if (current === start && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function smoothCoastLoops(loops: CoastPoint[][], cellSize: number): CoastPoint[][] {
  const limit = cellSize * 0.35;
  const result = loops.map((loop) => {
    // Keep tiny islets intact. Equal arc-length samples avoid triangle-diagonal bias.
    const lengths = loop.map((p, i) => Math.hypot(p[0] - loop[(i + 1) % loop.length][0], p[1] - loop[(i + 1) % loop.length][1]));
    const perimeter = lengths.reduce((sum, value) => sum + value, 0);
    if (perimeter < cellSize * 6) return loop;
    const count = Math.max(8, Math.ceil(perimeter / (cellSize * 0.5)));
    const original: CoastPoint[] = [];
    let edge = 0, offset = 0;
    for (let i = 0; i < count; i++) {
      const distance = i * perimeter / count;
      while (edge < lengths.length - 1 && offset + lengths[edge] < distance) offset += lengths[edge++];
      const t = (distance - offset) / Math.max(1e-9, lengths[edge]);
      const a = loop[edge], b = loop[(edge + 1) % loop.length];
      original.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    let points = original;
    for (let iteration = 0; iteration < 4; iteration++) {
      points = points.map((p, i): CoastPoint => {
        const a = points[(i + count - 1) % count], b = points[(i + 1) % count];
        const dx = (p[0] + (a[0] + b[0]) * 0.5) * 0.5 - original[i][0];
        const dz = (p[1] + (a[1] + b[1]) * 0.5) * 0.5 - original[i][1];
        const scale = Math.min(1, limit / Math.max(1e-9, Math.hypot(dx, dz)));
        return [original[i][0] + dx * scale, original[i][1] + dz * scale];
      });
    }
    return points;
  });
  // Reject smoothing that would intersect another coast or fold a concave bay.
  const segments = result.flatMap((loop, group) => loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length], group, i, count: loop.length })));
  const cross = (a: CoastPoint, b: CoastPoint, p: CoastPoint) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (let j = i + 1; j < segments.length; j++) {
      const b = segments[j];
      if (a.group === b.group && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === a.count - 1)) continue;
      if (Math.max(a.a[0], a.b[0]) < Math.min(b.a[0], b.b[0]) || Math.max(b.a[0], b.b[0]) < Math.min(a.a[0], a.b[0])
        || Math.max(a.a[1], a.b[1]) < Math.min(b.a[1], b.b[1]) || Math.max(b.a[1], b.b[1]) < Math.min(a.a[1], a.b[1])) continue;
      if (cross(a.a, a.b, b.a) * cross(a.a, a.b, b.b) < 0 && cross(b.a, b.b, a.a) * cross(b.a, b.b, a.b) < 0) return loops;
    }
  }
  return result;
}
