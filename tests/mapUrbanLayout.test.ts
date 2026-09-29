import { describe, expect, it } from 'vitest';
import { createUrbanLayout, type UrbanLayout, type UrbanLayoutOptions } from '../src/shared/mapUrbanLayout';

type Point = [number, number];
const bounds = { minX: -60, maxX: 60, minZ: -50, maxZ: 50 };
const patterns = ['grid', 'radial', 'branching', 'organic'] as const;
const settings: UrbanLayoutOptions = {
  size: [108, 88], blockSize: 24, roadWidth: 3, arterialWidth: 5,
  parcelWidth: 7, parcelDepth: 8, setback: 1, irregularity: 0.65
};

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function distance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  if (Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b)) < 1e-6) return true;
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

function overlaps(a: Point[], b: Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const axis: Point = [q[1] - p[1], p[0] - q[0]];
      const project = (points: Point[]) => points.map(v => v[0] * axis[0] + v[1] * axis[1]);
      const ap = project(a), bp = project(b);
      if (Math.max(...ap) <= Math.min(...bp) + 1e-7 || Math.max(...bp) <= Math.min(...ap) + 1e-7) return false;
    }
  }
  return true;
}

function connected(layout: UrbanLayout): boolean {
  const adjacent = (left: number, right: number) => {
    const a = layout.roads[left].points, b = layout.roads[right].points;
    return a.slice(1).some((end, i) => b.slice(1).some((otherEnd, j) => intersects(a[i], end, b[j], otherEnd)));
  };
  const reached = new Set([0]);
  const queue = [0];
  for (let index = 0; index < queue.length; index++) {
    for (let other = 0; other < layout.roads.length; other++) {
      if (!reached.has(other) && adjacent(queue[index], other)) {
        reached.add(other);
        queue.push(other);
      }
    }
  }
  return reached.size === layout.roads.length;
}

describe('urban road, block and parcel geometry', () => {
  it.each(patterns)('creates deterministic, connected %s fabric with safe road-facing footprints', pattern => {
    const options = { ...settings, pattern };
    const layout = createUrbanLayout(options, bounds, 17);
    expect(createUrbanLayout(options, bounds, 17)).toEqual(layout);
    expect(createUrbanLayout(options, bounds, 18)).not.toEqual(layout);
    expect(layout.roads.length).toBeGreaterThan(3);
    expect(layout.blocks.length).toBeGreaterThan(3);
    expect(layout.parcels.length).toBeGreaterThan(20);
    expect(connected(layout)).toBe(true);
    const roadIds = new Set(layout.roads.map(road => road.id));
    expect(roadIds.size).toBe(layout.roads.length);
    for (const road of layout.roads) {
      if (road.closed) expect(road.points.at(-1)).toEqual(road.points[0]);
      for (const point of road.points) {
        expect(Number.isFinite(point[0]) && Number.isFinite(point[1])).toBe(true);
        expect(point[0]).toBeGreaterThanOrEqual(bounds.minX + road.width / 2 - 1e-6);
        expect(point[0]).toBeLessThanOrEqual(bounds.maxX - road.width / 2 + 1e-6);
        expect(point[1]).toBeGreaterThanOrEqual(bounds.minZ + road.width / 2 - 1e-6);
        expect(point[1]).toBeLessThanOrEqual(bounds.maxZ - road.width / 2 + 1e-6);
      }
    }
    for (const parcel of layout.parcels) {
      const block = layout.blocks.find(candidate => candidate.id === parcel.blockId)!;
      expect(block).toBeDefined();
      expect(roadIds.has(parcel.roadId)).toBe(true);
      expect(parcel.width).toBeGreaterThan(0);
      expect(parcel.depth).toBeGreaterThan(0);
      for (const corner of parcel.points) {
        for (let index = 0; index < block.points.length; index++) {
          expect(cross(block.points[index], block.points[(index + 1) % block.points.length], corner)).toBeGreaterThanOrEqual(-1e-5);
        }
      }
      const forward: Point = [Math.sin(parcel.rotationY), Math.cos(parcel.rotationY)];
      const toRoad: Point = [parcel.front[0] - parcel.center[0], parcel.front[1] - parcel.center[1]];
      expect(forward[0] * toRoad[0] + forward[1] * toRoad[1]).toBeGreaterThan(0);
      for (const road of layout.roads) {
        for (let index = 1; index < road.points.length; index++) {
          const a = road.points[index - 1], b = road.points[index];
          expect(parcel.points.some((point, edge) => intersects(a, b, point, parcel.points[(edge + 1) % parcel.points.length]))).toBe(false);
          const shortest = Math.min(...parcel.points.map(point => distance(point, a, b)),
            ...parcel.points.map((point, p) => distance(a, point, parcel.points[(p + 1) % parcel.points.length])),
            ...parcel.points.map((point, p) => distance(b, point, parcel.points[(p + 1) % parcel.points.length])));
          expect(shortest).toBeGreaterThanOrEqual(road.width / 2 + settings.setback! - 1e-5);
        }
      }
    }
    for (let left = 0; left < layout.parcels.length; left++) {
      for (let right = left + 1; right < layout.parcels.length; right++) {
        expect(overlaps(layout.parcels[left].points, layout.parcels[right].points)).toBe(false);
      }
    }
  });

  it('changes actual street topology rather than only building jitter', () => {
    const layouts = patterns.map(pattern => createUrbanLayout({ ...settings, pattern }, bounds, 12));
    expect(layouts[0].roads.filter(road => road.closed)).toHaveLength(1);
    expect(layouts[1].roads.filter(road => road.closed).length).toBeGreaterThan(1);
    expect(layouts[2].roads.filter(road => road.closed)).toHaveLength(1);
    expect(layouts[2].roads.filter(road => !road.closed).every(road => road.points.length === 2)).toBe(true);
    expect(layouts[0].roads.filter(road => !road.closed).some(road => road.points.length > 2)).toBe(true);
  });

  it('forms seeded organic polygon neighborhoods instead of preserving a row or ring topology', () => {
    const layouts = [17, 18, 19, 20].map(seed => createUrbanLayout({ ...settings, pattern: 'organic', seed }, bounds));
    const topology = (layout: UrbanLayout) => layout.blocks.map(block => block.points.length).sort((a, b) => a - b).join(',');
    expect(new Set(layouts.map(topology)).size).toBeGreaterThan(1);
    expect(layouts.some(layout => layout.blocks.some(block => block.points.length >= 5))).toBe(true);
    expect(layouts.some(layout => layout.blocks.some(block => block.points.length >= 6))).toBe(true);
    for (const layout of layouts) {
      expect(layout.blocks.length).toBeLessThanOrEqual(26);
      const roads = layout.roads.filter(road => !road.closed);
      expect(roads.length).toBeGreaterThan(5);
      for (let first = 0; first < roads.length; first++) {
        for (let second = first + 1; second < roads.length; second++) {
          const a = roads[first].points, b = roads[second].points;
          const same = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-5;
          expect((same(a[0], b[0]) && same(a[1], b[1])) || (same(a[0], b[1]) && same(a[1], b[0]))).toBe(false);
        }
      }
      const degree = new Map<string, number>();
      for (const road of roads) for (const point of road.points) {
        const key = point.map(value => value.toFixed(5)).join(',');
        degree.set(key, (degree.get(key) ?? 0) + 1);
      }
      expect([...degree.values()].some(value => value === 3)).toBe(true);
    }
    expect(createUrbanLayout({ ...settings, pattern: 'organic', seed: 17 }, bounds, 900)).toEqual(layouts[0]);
  });
  it.each(patterns)('clips rotated %s geometry to convex regions and map limits', pattern => {
    const region: Point[] = [[-52, -36], [17, -43], [53, 12], [25, 43], [-45, 29]];
    const layout = createUrbanLayout({ ...settings, pattern, region, rotation: 27, center: [15, 6], size: [140, 115] }, bounds, 21);
    expect(layout.blocks.length).toBeGreaterThan(0);
    expect(connected(layout)).toBe(true);
    for (const point of [...layout.roads.flatMap(road => road.points), ...layout.parcels.flatMap(parcel => parcel.points)]) {
      for (let index = 0; index < region.length; index++) {
        expect(cross(region[index], region[(index + 1) % region.length], point)).toBeGreaterThanOrEqual(-1e-5);
      }
      expect(point[0]).toBeGreaterThanOrEqual(bounds.minX);
      expect(point[0]).toBeLessThanOrEqual(bounds.maxX);
      expect(point[1]).toBeGreaterThanOrEqual(bounds.minZ);
      expect(point[1]).toBeLessThanOrEqual(bounds.maxZ);
    }
  });

  it.each(patterns)('bounds %s work for extreme scale and returns no impossible tiny parcels', pattern => {
    const huge = { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 };
    const layout = createUrbanLayout({ pattern, blockSize: 0.01, parcelWidth: 0.01, parcelDepth: 0.01 }, huge, 3);
    expect(layout.roads.length).toBeLessThanOrEqual(80);
    expect(layout.blocks.length).toBeLessThanOrEqual(64);
    expect(layout.parcels.length).toBeLessThanOrEqual(512);
    expect(connected(layout)).toBe(true);
    const tiny = createUrbanLayout({ pattern, roadWidth: 3, arterialWidth: 5 }, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, 2);
    expect(tiny.parcels).toEqual([]);
  });

  it('packs usable compact buildings across seeds without consuming road clearance', () => {
    const coverages: number[] = [];
    for (const seed of [1434940666, 101, 202, 303, 404, 505]) {
      const options: UrbanLayoutOptions = {
        pattern: 'organic', center: [0, -10], size: [108, 84], blockSize: [25, 25],
        roadWidth: 2.4, arterialWidth: 3.6, setback: 0.35, parcelWidth: 6.5,
        parcelDepth: 10, irregularity: 0.23, seed
      };
      const layout = createUrbanLayout(options, { minX: -64, maxX: 64, minZ: -64, maxZ: 64 });
      const blockArea = layout.blocks.reduce((sum, block) => sum + Math.abs(block.points.reduce((total, p, i) => {
        const q = block.points[(i + 1) % block.points.length];
        return total + p[0] * q[1] - q[0] * p[1];
      }, 0)) / 2, 0);
      // Count actual fit dimensions, excluding unusably shallow lots, rather than rewarding parcel count.
      const buildingArea = layout.parcels.reduce((sum, parcel) => {
        const width = Math.min(10, parcel.width - 0.35), depth = Math.min(10.2, parcel.depth - 0.45);
        return sum + (width >= 3.5 && depth >= 4 ? width * depth : 0);
      }, 0);
      coverages.push(buildingArea / blockArea);
      for (const parcel of layout.parcels) {
        expect(parcel.width).toBeLessThanOrEqual(options.parcelWidth! * 1.5);
        const block = layout.blocks.find(candidate => candidate.id === parcel.blockId)!;
        for (const point of parcel.points) {
          for (let edge = 0; edge < block.points.length; edge++) {
            expect(cross(block.points[edge], block.points[(edge + 1) % block.points.length], point)).toBeGreaterThanOrEqual(-1e-5);
          }
        }
        for (const road of layout.roads) for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1], b = road.points[i];
          expect(parcel.points.some((p, edge) => intersects(a, b, p, parcel.points[(edge + 1) % parcel.points.length]))).toBe(false);
          const clearance = Math.min(...parcel.points.map(p => distance(p, a, b)),
            ...parcel.points.map((p, edge) => distance(a, p, parcel.points[(edge + 1) % parcel.points.length])),
            ...parcel.points.map((p, edge) => distance(b, p, parcel.points[(edge + 1) % parcel.points.length])));
          expect(clearance).toBeGreaterThanOrEqual(road.width / 2 + options.setback! - 1e-5);
        }
      }
      for (let a = 0; a < layout.parcels.length; a++) for (let b = a + 1; b < layout.parcels.length; b++) {
        expect(overlaps(layout.parcels[a].points, layout.parcels[b].points)).toBe(false);
      }
    }
    expect(Math.min(...coverages)).toBeGreaterThanOrEqual(0.5);
    expect(coverages.reduce((sum, coverage) => sum + coverage, 0) / coverages.length).toBeGreaterThanOrEqual(0.58);
  });

  it.each(['grid', 'organic'] as const)('keeps %s parcel width bounded when the parcel budget limits long frontages', pattern => {
    const layout = createUrbanLayout({ pattern, size: [4000, 4000], blockSize: 1500,
      parcelWidth: 7, parcelDepth: 8 }, { minX: -2500, maxX: 2500, minZ: -2500, maxZ: 2500 }, 31);
    expect(layout.parcels.length).toBeGreaterThan(0);
    expect(layout.parcels.length).toBeLessThanOrEqual(512);
    expect(layout.parcels.every(parcel => parcel.width <= 10.5)).toBe(true);
  });

  it.each(patterns)('rejects numerically unusable %s coordinates and preserves huge-angle rotation semantics', pattern => {
    expect(() => createUrbanLayout({ pattern, size: [1e308, 1e308] }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ pattern, center: [1e308, 0] }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ pattern, region: [[1e308, 0], [0, 1e308], [-1e308, 0]] }, bounds)).toThrow('invalid_urban_layout');
    expect(createUrbanLayout({ ...settings, pattern, rotation: 1e308 }, bounds, 11))
      .toEqual(createUrbanLayout({ ...settings, pattern, rotation: 1e308 % 360 }, bounds, 11));
    expect(createUrbanLayout({ ...settings, pattern, center: [1000, 1000] }, bounds)).toEqual({ roads: [], blocks: [], parcels: [] });
  });

  it('normalizes duplicate, collinear and clockwise convex boundary vertices', () => {
    const simple: Point[] = [[-50, -40], [50, -40], [50, 40], [-50, 40]];
    const noisy: Point[] = [[-50, -40], [0, -40], [50, -40], [50, -40], [50, 40], [-50, 40], [-50, -40]];
    expect(createUrbanLayout({ ...settings, region: noisy }, bounds, 7))
      .toEqual(createUrbanLayout({ ...settings, region: simple }, bounds, 7));
    const clockwise = createUrbanLayout({ ...settings, region: [...simple].reverse() }, bounds, 7);
    expect(clockwise.parcels.length).toBeGreaterThan(0);
    expect(connected(clockwise)).toBe(true);
  });

  it('keeps heavily clipped networks connected and irregular blocks convex across seeds', () => {
    const region: Point[] = [[-53, -12], [45, -35], [52, -19], [-31, 40]];
    for (let seed = 0; seed < 24; seed++) {
      for (const pattern of ['grid', 'radial', 'organic'] as const) {
        const layout = createUrbanLayout({ ...settings, pattern, region, rotation: seed * 19,
          size: [145, 130], blockSize: 12, irregularity: 1, center: [seed % 9 - 4, seed % 13 - 6] }, bounds, seed);
        expect(connected(layout)).toBe(true);
        for (const block of layout.blocks) {
          for (let index = 0; index < block.points.length; index++) {
            for (const point of block.points) {
              expect(cross(block.points[index], block.points[(index + 1) % block.points.length], point)).toBeGreaterThanOrEqual(-1e-5);
            }
          }
        }
      }
    }
  });
  it('rejects malformed inputs instead of returning NaN or unbounded geometry', () => {
    expect(() => createUrbanLayout({ size: [NaN, 12] }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ center: [undefined, 12] as never }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({}, { ...bounds, minX: -1e308, maxX: 1e308 })).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ roadWidth: Infinity }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ pattern: 'anything' as never }, bounds)).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({}, { ...bounds, minX: 90 })).toThrow('invalid_urban_layout');
    expect(() => createUrbanLayout({ region: [[0, 0], [10, 0], [4, 4], [10, 10], [0, 10]] }, bounds)).toThrow('invalid_urban_layout_region');
    expect(() => createUrbanLayout({ region: [[0, 0], [1, 1], [2, 2]] }, bounds)).toThrow('invalid_urban_layout_region');
  });
});
