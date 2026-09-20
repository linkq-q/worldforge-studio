import { describe, expect, it } from 'vitest';
import { buildOceanCoastField, extractCoastLoops, sampleCoastGrid, smoothCoastLoops, type CoastGrid } from '../src/shared/oceanCoast';
import { createEmptyMap } from '../src/shared/map';

function gridFor(height: (x: number, z: number) => number): CoastGrid {
  return { width: 33, depth: 33, minX: -16, minZ: -16, stepX: 1, stepZ: 1,
    heights: Array.from({ length: 33 * 33 }, (_, i) => height(i % 33 - 16, Math.floor(i / 33) - 16)) };
}

describe('continuous ocean coast', () => {
  it('rebuilds only the tidal band and leaves source heights and inland foundations intact', () => {
    const map = createEmptyMap('coast');
    const cell = map.box.size[0] / (map.terrain.resolutionX - 1);
    map.terrain.heights = map.terrain.heights.map((_, i) => Math.max(0, Math.min(3, 15 - Math.hypot(i % map.terrain.resolutionX * cell - map.box.size[0] / 2, Math.floor(i / map.terrain.resolutionX) * cell - map.box.size[2] / 2))));
    const before = [...map.terrain.heights];
    const field = buildOceanCoastField(map, 0);
    expect(sampleCoastGrid(field, 0, 0)).toBeCloseTo(3);
    expect(sampleCoastGrid(field, 20, 0)).toBeLessThan(-1);
    expect(field.loops).toHaveLength(1);
    expect(map.terrain.heights).toEqual(before);
    expect(Array.from(field.heights).every(Number.isFinite)).toBe(true);
  });

  it('extends boundary land continuously and leaves distant corners submerged', () => {
    const map = createEmptyMap('edge coast');
    const cell = map.box.size[0] / (map.terrain.resolutionX - 1);
    map.terrain.heights = map.terrain.heights.map((_, i) => Math.max(0, 3 - Math.hypot(i % map.terrain.resolutionX * cell, Math.floor(i / map.terrain.resolutionX) * cell - map.box.size[2] / 2) * 0.4));
    const field = buildOceanCoastField(map, 0);
    expect(field.loops).toHaveLength(1);
    expect(sampleCoastGrid(field, -map.box.size[0] / 2, 0)).toBeCloseTo(3);
    expect(sampleCoastGrid(field, -map.box.size[0] / 2 - 2, 0)).toBeGreaterThan(field.sinkTarget);
    expect(field.heights[0]).toBeLessThanOrEqual(field.sinkTarget);
  });

  it('gives steep rock shores a narrower submerged profile than gentle beaches', () => {
    const fields = [0.15, 2].map(slope => {
      const map = createEmptyMap('shore profiles');
      const cell = map.box.size[0] / (map.terrain.resolutionX - 1);
      map.terrain.heights = map.terrain.heights.map((_, i) => Math.max(0, (15 - Math.hypot(i % map.terrain.resolutionX * cell - map.box.size[0] / 2, Math.floor(i / map.terrain.resolutionX) * cell - map.box.size[2] / 2)) * slope));
      return buildOceanCoastField(map, 0);
    });
    expect(sampleCoastGrid(fields[1], 18, 0)).toBeLessThan(sampleCoastGrid(fields[0], 18, 0) - 0.5);
  });

  it('extracts sub-cell coast crossings without changing the source', () => {
    const grid = gridFor((x, z) => 8.3 - Math.hypot(x, z));
    const before = Array.from(grid.heights);
    const loops = extractCoastLoops(grid, 0);
    expect(loops).toHaveLength(1);
    expect(loops[0].some(([x, z]) => x !== Math.round(x) || z !== Math.round(z))).toBe(true);
    expect(Array.from(grid.heights)).toEqual(before);
    const smooth = smoothCoastLoops(loops, 1)[0];
    for (const [x, z] of smooth) expect(Math.abs(Math.hypot(x, z) - 8.3)).toBeLessThan(0.4);
  });

  it('retains lagoon holes, distinct islets and narrow sea channels', () => {
    const ring = extractCoastLoops(gridFor((x, z) => Math.min(10 - Math.hypot(x, z), Math.hypot(x, z) - 5)), 0.01);
    expect(smoothCoastLoops(ring, 1)).toHaveLength(2);
    const islands = extractCoastLoops(gridFor((x, z) => Math.max(3.8 - Math.hypot(x - 4.5, z), 3.8 - Math.hypot(x + 4.5, z))), 0);
    const smooth = smoothCoastLoops(islands, 1);
    expect(smooth).toHaveLength(2);
    expect(smooth.flat().every(([x]) => Math.abs(x) > 0.4)).toBe(true);
  });

  it('softens staircase corners without erasing a concave bay or tiny islet', () => {
    const grid = gridFor((x, z) => Math.max(Math.min(10 - Math.hypot(x, z), Math.hypot(x, z + 8) - 7), 0.3 - Math.hypot(x - 13, z)));
    const loops = extractCoastLoops(grid, 0);
    const smooth = smoothCoastLoops(loops, 1);
    expect(smooth).toHaveLength(2);
    expect(smooth.flat().some(([x, z]) => Math.abs(x) < 1 && z > -2 && z < 0)).toBe(true);
    expect(smooth.some(loop => loop.every(([x]) => x > 12))).toBe(true);
    expect(smooth).not.toEqual(loops);
  });
});
