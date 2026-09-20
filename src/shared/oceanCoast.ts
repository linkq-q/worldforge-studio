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
