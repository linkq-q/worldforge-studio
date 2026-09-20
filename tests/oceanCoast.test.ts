import { describe, expect, it } from 'vitest';
import { extractCoastLoops, smoothCoastLoops, type CoastGrid } from '../src/shared/oceanCoast';

function gridFor(height: (x: number, z: number) => number): CoastGrid {
  return { width: 33, depth: 33, minX: -16, minZ: -16, stepX: 1, stepZ: 1,
    heights: Array.from({ length: 33 * 33 }, (_, i) => height(i % 33 - 16, Math.floor(i / 33) - 16)) };
}

describe('continuous ocean coast', () => {
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
