import { describe, expect, it, vi } from 'vitest';
import { ECOLOGY_CHUNK_SIZE, generateEcologyChunk, selectEcologyChunks, validateEcologyRules, type EcologyRule } from '../src/shared/worldEcology';
import { createWorldSampler, type WorldRecipe, type WorldSample } from '../src/shared/worldTerrain';

const recipe: WorldRecipe = { version: 1, seed: 42, size: 64000, constraints: [{ region: 'center', biome: 'forest' }] };
const trees: EcologyRule[] = [
  { id: 'oak', kind: 'broadleaf', biome: 'forest', density: 1, spacing: 18, maxSlope: 25, scale: [0.8, 1.4] },
  { id: 'pine', kind: 'pine', biome: 'forest', density: 1, spacing: 22, maxSlope: 25, scale: [0.9, 1.2] }
];
const flat = (_x: number, _z: number): WorldSample => ({
  height: 50, temperature: 0.6, moisture: 0.8, continentalness: 0.7,
  weights: { ocean: 0, grassland: 0, forest: 1, desert: 0, mountains: 0, snow: 0 },
  waterLevel: null, waterBodyId: null
});

describe('deterministic chunk ecology', () => {
  it('validates bounded rules and returns independent canonical copies', () => {
    const original = structuredClone(trees).reverse();
    const result = validateEcologyRules(original);
    expect(result.map(rule => rule.id)).toEqual(['oak', 'pine']);
    result[0].scale[0] = 2;
    expect(original[1].scale[0]).toBe(0.8);
    expect(validateEcologyRules([])).toEqual([]);
    expect(validateEcologyRules([{ ...trees[0], scale: [1, 8] }])[0].scale).toEqual([1, 8]);
    for (const value of [
      null, {}, [null], [...trees, trees[0]],
      Array.from({ length: 9 }, (_, i) => ({ ...trees[0], id: 'r' + i })),
      ...[
        { id: '' }, { id: 'x'.repeat(65) }, { kind: '__proto__' }, { biome: 'swamp' },
        { density: -0.1 }, { density: 1.1 }, { density: NaN }, { spacing: 5.9 }, { spacing: 101 },
        { maxSlope: -1 }, { maxSlope: 61 }, { scale: [0, 1] }, { scale: [2, 1] }, { scale: [1, Infinity] }, { scale: [1, 8.01] }
      ].map(change => [{ ...trees[0], ...change }])
    ]) expect(() => validateEcologyRules(value)).toThrow();
  });

  it('repeats stable identities and transforms independent of rule or chunk request order', () => {
    const chunk = { x: -1, z: 0 };
    const first = generateEcologyChunk(recipe, trees, chunk, { sample: flat });
    generateEcologyChunk(recipe, trees, { x: 17, z: -21 }, { sample: flat });
    expect(generateEcologyChunk(recipe, [...trees].reverse(), chunk, { sample: flat })).toEqual(first);
    expect(first.instances.length).toBeGreaterThan(20);
    expect(first.rejectedCount + first.instances.length).toBe(first.candidateCount);
    for (const point of first.instances) {
      expect(point.x).toBeGreaterThanOrEqual(-ECOLOGY_CHUNK_SIZE);
      expect(point.x).toBeLessThan(0);
      expect(point.z).toBeGreaterThanOrEqual(0);
      expect(point.z).toBeLessThan(ECOLOGY_CHUNK_SIZE);
      expect(point.y).toBe(50);
      expect(point.rotation).toBeGreaterThanOrEqual(0);
      expect(point.rotation).toBeLessThan(Math.PI * 2);
      const rule = trees.find(rule => rule.kind === point.kind)!;
      expect(point.scale).toBeGreaterThanOrEqual(rule.scale[0]);
      expect(point.scale).toBeLessThanOrEqual(rule.scale[1]);
    }
    expect(generateEcologyChunk({ ...recipe, seed: 43 }, trees, chunk, { sample: flat }).instances).not.toEqual(first.instances);
  });

  it('thins density monotonically without moving trees or changing neighboring species', () => {
    const generate = (factor: number) => generateEcologyChunk(recipe, trees.map(rule => ({ ...rule, density: factor })), { x: 0, z: 0 }, { sample: flat });
    const high = generate(1), medium = generate(0.6), low = generate(0.25);
    expect(low.instances.length).toBeGreaterThan(0);
    expect(low.instances.length).toBeLessThan(medium.instances.length);
    expect(medium.instances.length).toBeLessThan(high.instances.length);
    const mediumById = new Map(medium.instances.map(point => [point.id, point]));
    const highById = new Map(high.instances.map(point => [point.id, point]));
    for (const point of low.instances) expect(mediumById.get(point.id)).toEqual(point);
    for (const point of medium.instances) expect(highById.get(point.id)).toEqual(point);
    expect(low.candidateCount).toBe(high.candidateCount);
    const noOak = generateEcologyChunk(recipe, trees.map(rule => ({ ...rule, density: rule.kind === 'pine' ? 1 : 0 })), { x: 0, z: 0 }, { sample: flat });
    expect(noOak.instances).toEqual(high.instances.filter(point => point.kind === 'pine'));
  });


  it('applies a smooth density field as stable thinning with finite clamped values', () => {
    const chunk = { x: 0, z: 0 };
    const smooth = (x: number) => { const t = x / ECOLOGY_CHUNK_SIZE; return t * t * (3 - 2 * t); };
    const generate = (density?: (x: number, z: number) => number) => generateEcologyChunk(recipe, trees, chunk, { sample: flat, density });
    const base = generate(), fade = generate(smooth), thin = generate(x => smooth(x) * 0.5);
    expect(thin.instances.length).toBeGreaterThan(0);
    expect(thin.instances.length).toBeLessThan(fade.instances.length);
    expect(fade.instances.length).toBeLessThan(base.instances.length);
    const baseById = new Map(base.instances.map(point => [point.id, point]));
    const fadeById = new Map(fade.instances.map(point => [point.id, point]));
    for (const point of fade.instances) expect(baseById.get(point.id)).toEqual(point);
    for (const point of thin.instances) expect(fadeById.get(point.id)).toEqual(point);
    expect(fade.instances.filter(point => point.x >= 128).length).toBeGreaterThan(fade.instances.filter(point => point.x < 128).length);
    expect(generate(() => 2)).toEqual(base);
    expect(generate(() => -1).instances).toHaveLength(0);
    expect(fade.candidateCount).toBe(base.candidateCount);
    for (const density of [NaN, Infinity, -Infinity, '0.5' as unknown as number, undefined as unknown as number]) {
      expect(() => generate(() => density)).toThrow('invalid_ecology_density');
    }
    const sample = vi.fn(flat);
    expect(generateEcologyChunk(recipe, trees, chunk, { sample, density: () => 0 }).instances).toHaveLength(0);
    expect(sample).not.toHaveBeenCalled();
  });
  it('enforces mixed-tree spacing across seams and the four-chunk negative-coordinate corner', () => {
    const chunks = [{ x: -1, z: -1 }, { x: 0, z: -1 }, { x: -1, z: 0 }, { x: 0, z: 0 }];
    const results = chunks.map(chunk => generateEcologyChunk(recipe, trees, chunk, { sample: flat }));
    const points = results.flatMap(result => result.instances);
    expect(points.length).toBeGreaterThan(80);
    expect(new Set(points.map(point => point.id)).size).toBe(points.length);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j];
      const spacing = Math.max(a.kind === 'pine' ? 22 : 18, b.kind === 'pine' ? 22 : 18);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(spacing);
    }
    for (let i = chunks.length - 1; i >= 0; i--) {
      expect(generateEcologyChunk(recipe, trees, chunks[i], { sample: flat })).toEqual(results[i]);
    }
  });

  it('uses biome weights, sea level and central-difference slope before emitting grounded instances', () => {
    const generate = (sample: (x: number, z: number) => WorldSample) => generateEcologyChunk(recipe, trees, { x: 0, z: 0 }, { sample });
    expect(generate(() => ({ ...flat(0, 0), height: -1 })).instances).toHaveLength(0);
    expect(generate(() => ({ ...flat(0, 0), weights: { ...flat(0, 0).weights, ocean: 1 } })).instances).toHaveLength(0);
    expect(generate(() => ({ ...flat(0, 0), weights: { ...flat(0, 0).weights, forest: 0, desert: 1 } })).instances).toHaveLength(0);
    expect(generate((x, z) => ({ ...flat(x, z), height: 1000 + x * 2 })).instances).toHaveLength(0);
    const gentle = generate((x, z) => ({ ...flat(x, z), height: 1000 + x * 0.1 }));
    expect(gentle.instances.length).toBeGreaterThan(20);
    for (const point of gentle.instances) expect(point.y).toBe(1000 + point.x * 0.1);
    const base = generate(flat);
    const blended = generate((x, z) => ({ ...flat(x, z), weights: { ...flat(x, z).weights, forest: 0.4, grassland: 0.6 } }));
    expect(blended.instances.length).toBeGreaterThan(0);
    expect(blended.instances.length).toBeLessThan(base.instances.length);
    for (const point of blended.instances) expect(base.instances).toContainEqual(point);
  });

  it('passes a footprint radius to exclusion and does not rearrange surviving candidates', () => {
    const exclusion = vi.fn((x: number, _z: number, radius: number) => x - radius < 128);
    const base = generateEcologyChunk(recipe, trees, { x: 0, z: 0 }, { sample: flat });
    const result = generateEcologyChunk(recipe, trees, { x: 0, z: 0 }, { sample: flat, exclusion });
    expect(result.instances.length).toBeGreaterThan(0);
    expect(result.instances.length).toBeLessThan(base.instances.length);
    expect(exclusion).toHaveBeenCalled();
    for (const point of result.instances) {
      expect(point.x - (point.kind === 'pine' ? 11 : 9)).toBeGreaterThanOrEqual(128);
      expect(base.instances).toContainEqual(point);
    }
    expect(new Set(exclusion.mock.calls.map(call => call[2]))).toEqual(new Set([9, 11]));
  });

  it('bounds local candidate and environment work independently of total world area', () => {
    const rules = Array.from({ length: 8 }, (_, i): EcologyRule => ({ ...trees[0], id: 'tree-' + i, spacing: 6 }));
    const sample = vi.fn(flat);
    const small = generateEcologyChunk({ ...recipe, size: 8000 }, rules, { x: 0, z: 0 }, { sample });
    expect(small.candidateCount).toBeLessThanOrEqual(8 * 44 * 44);
    expect(sample.mock.calls.length).toBeLessThanOrEqual(small.candidateCount * 5);
    expect(sample.mock.calls.length).toBeGreaterThan(0);
    sample.mockClear();
    expect(generateEcologyChunk({ ...recipe, size: 256000 }, rules, { x: 0, z: 0 }, { sample })).toEqual(small);
    const zeroSample = vi.fn(flat);
    expect(generateEcologyChunk(recipe, trees.map(rule => ({ ...rule, density: 0 })), { x: 0, z: 0 }, { sample: zeroSample }).instances).toHaveLength(0);
    expect(zeroSample).not.toHaveBeenCalled();
    expect(generateEcologyChunk(recipe, trees, { x: 10000, z: 10000 }, { sample: zeroSample }).candidateCount).toBe(0);
    expect(zeroSample).not.toHaveBeenCalled();
    expect(() => generateEcologyChunk(recipe, trees, { x: 0.5, z: 0 })).toThrow();
    expect(() => generateEcologyChunk({ ...recipe, seed: -1 }, trees, { x: 0, z: 0 }, { sample: flat })).toThrow();
  });

  it('samples the actual world recipe by default and clips partial edge chunks', () => {
    const sample = createWorldSampler(recipe);
    const result = generateEcologyChunk(recipe, trees, { x: 0, z: 0 });
    expect(result.instances.length).toBeGreaterThan(0);
    for (const point of result.instances) expect(point.y).toBe(sample(point.x, point.z).height);
    const edge = generateEcologyChunk({ ...recipe, size: 8000 }, trees, { x: 15, z: 15 }, { sample: flat });
    expect(edge.instances.length).toBeGreaterThan(0);
    for (const point of edge.instances) {
      expect(point.x).toBeLessThan(4000);
      expect(point.z).toBeLessThan(4000);
    }
  });
});

describe('ecology residency', () => {
  it('selects at most 25 nearest fixed chunks independently of world size', () => {
    const small = selectEcologyChunks(64000, -1, -1, 2000);
    expect(small).toHaveLength(25);
    expect(small[0]).toEqual({ x: -1, z: -1 });
    expect(selectEcologyChunks(256000, -1, -1, 2000)).toEqual(small);
    expect(selectEcologyChunks(64000, 0, 0, 3000)).toHaveLength(25);
    expect(selectEcologyChunks(64000, 0, 0, 3001)).toEqual([]);
    expect(selectEcologyChunks(64000, 1e20, 0, 0)).toEqual([]);
    const edge = selectEcologyChunks(8000, 3999, -3999, 2000);
    expect(edge.length).toBeGreaterThan(0);
    expect(edge.length).toBeLessThan(25);
    for (const chunk of edge) {
      expect(chunk.x * ECOLOGY_CHUNK_SIZE).toBeLessThan(4000);
      expect((chunk.z + 1) * ECOLOGY_CHUNK_SIZE).toBeGreaterThan(-4000);
    }
    for (const args of [[499, 0, 0, 0], [64000, NaN, 0, 0], [64000, 0, Infinity, 0], [64000, 0, 0, -1]]) {
      expect(() => selectEcologyChunks(args[0], args[1], args[2], args[3])).toThrow();
    }
  });
});

describe('localized ecology rules', () => {
  it('uses bounded procedural regions and keeps vegetation out of finite water', () => {
    const rule: EcologyRule = { ...trees[0], spacing: 6, region: { kind: 'circle', center: [128, 128], radius: 45 }, regionFeather: 10 };
    const result = generateEcologyChunk(recipe, [rule], { x: 0, z: 0 }, {
      sample: (x, z) => ({ ...flat(x, z), waterLevel: Math.hypot(x - 128, z - 128) < 15 ? 49 : null,
        waterBodyId: Math.hypot(x - 128, z - 128) < 15 ? 'oasis' : null })
    });
    expect(result.instances.length).toBeGreaterThan(0);
    for (const point of result.instances) {
      expect(Math.hypot(point.x - 128, point.z - 128)).toBeLessThan(55);
      expect(Math.hypot(point.x - 128, point.z - 128)).toBeGreaterThanOrEqual(15);
    }
  });
});
