import { describe, expect, it } from 'vitest';
import { createWorldSampler, dominantBiome, parseWorldPrompt, sampleWorldTile, selectWorldTiles, validateWorldRecipe, WORLD_BIOMES } from '../src/shared/worldTerrain';

describe('continuous biome world experiment', () => {
  it('turns the requested sentence into explicit directional constraints', () => {
    expect(parseWorldPrompt('我希望西方是海洋，东方是沙漠').constraints).toEqual([
      { region: 'west', biome: 'ocean' }, { region: 'east', biome: 'desert' }
    ]);
    expect(parseWorldPrompt('东北是雪山，西南是森林，中央是草原').constraints.map(c => c.region)).toEqual(['northeast', 'southwest', 'center']);
    expect(parseWorldPrompt('west is ocean, east is desert').constraints).toHaveLength(2);
  });

  it('refuses conflicts, negation and unsupported intent instead of silently generating another map', () => {
    for (const text of ['西方是海洋，西方是沙漠', '西方不要海洋', '西方是海洋，中部有河流', '美丽的外星球', '西方是海洋和森林']) {
      expect(() => parseWorldPrompt(text)).toThrow();
    }
    expect(() => parseWorldPrompt('西方是海洋', -1)).toThrow();
    expect(() => parseWorldPrompt('西方是海洋', 42, Infinity)).toThrow();
    expect(() => validateWorldRecipe({ version: 1, seed: 1, size: 64000, constraints: [{ region: '__proto__' as never, biome: 'forest' }] })).toThrow();
  });

  it('keeps west below sea level and east dry across seeds, including the mirror description', () => {
    for (const seed of [0, 1, 42, 2026, 4294967295]) {
      for (const reverse of [false, true]) {
        const sample = createWorldSampler(parseWorldPrompt(reverse ? '东方是海洋，西方是沙漠' : '西方是海洋，东方是沙漠', seed));
        const sign = reverse ? -1 : 1;
        for (const z of [-12000, 0, 12000]) {
          expect(sample(-25000 * sign, z).height).toBeLessThan(0);
          const desert = sample(25000 * sign, z);
          expect(desert.height).toBeGreaterThan(0);
          expect(dominantBiome(desert)).toBe('desert');
        }
      }
    }
  });

  it('reproduces coordinates independent of sampling order and changes with seed', () => {
    const first = createWorldSampler(parseWorldPrompt('西方是海洋，东方是沙漠'));
    const again = createWorldSampler(parseWorldPrompt('西方是海洋，东方是沙漠'));
    const other = createWorldSampler(parseWorldPrompt('西方是海洋，东方是沙漠', 77));
    first(111, 321);
    expect(first(14321, -4123)).toEqual(again(14321, -4123));
    expect(first(14321, -4123).height).not.toBe(other(14321, -4123).height);
  });

  it('makes positive normalized biome weights and continuous geometry across transition bands', () => {
    const sample = createWorldSampler(parseWorldPrompt('西方是海洋，东方是沙漠，北方是雪地，南方是森林，中央是山脉'));
    let blended = 0;
    for (let x = -32000; x <= 32000; x += 250) {
      const s = sample(x, 3000);
      expect(Number.isFinite(s.height)).toBe(true);
      const weights = WORLD_BIOMES.map(b => s.weights[b]);
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(Math.min(...weights)).toBeGreaterThanOrEqual(0);
      if (weights.filter(w => w > 0.1).length > 1) blended++;
      expect(Math.abs(s.height - sample(x + 0.01, 3000).height)).toBeLessThan(0.1);
    }
    expect(blended).toBeGreaterThan(20);
  });

  it('agrees on adjacent and different-LOD border heights, normals and weights', () => {
    const recipe = parseWorldPrompt('西方是海洋，东方是沙漠，中央是山脉');
    const a = sampleWorldTile(recipe, { x: -2000, z: 0, size: 2000 }, 17);
    const b = sampleWorldTile(recipe, { x: 0, z: 0, size: 1000 }, 17);
    for (let i = 0; i <= 8; i++) {
      const ai = i * 17 + 16, bi = i * 2 * 17;
      expect(a.heights[ai]).toBe(b.heights[bi]);
      expect([...a.normals.slice(ai * 3, ai * 3 + 3)]).toEqual([...b.normals.slice(bi * 3, bi * 3 + 3)]);
      expect([...a.weights.slice(ai * 6, ai * 6 + 6)]).toEqual([...b.weights.slice(bi * 6, bi * 6 + 6)]);
    }
  });

  it('spends a tight LOD budget near the requested viewpoint rather than traversal order', () => {
    for (const [x, z] of [[23500,23500], [-23500,23500], [23500,-23500], [-23500,-23500]]) {
      const tiles = selectWorldTiles(64000, x, z, 600, 70);
      const focus = tiles.find(t => x >= t.x && x < t.x + t.size && z >= t.z && z < t.z + t.size)!;
      expect(focus.size).toBeLessThanOrEqual(4000);
      expect(tiles.reduce((sum,t) => sum + t.size ** 2, 0)).toBe(64000 ** 2);
    }
  });

  it('keeps all six biome classes present in a multi-region plan across seeds', () => {
    for (const seed of [1, 42, 2026]) {
      const sample = createWorldSampler(parseWorldPrompt('西方是海洋，东方是沙漠，北方是雪地，南方是森林，中央是山脉', seed));
      const counts = Object.fromEntries(WORLD_BIOMES.map(b => [b,0]));
      for (let z = -30000; z <= 30000; z += 1500) for (let x = -30000; x <= 30000; x += 1500) counts[dominantBiome(sample(x,z))]++;
      for (const biome of WORLD_BIOMES) expect(counts[biome]).toBeGreaterThan(15);
    }
  });

  it('bounds tile memory and covers 64/256 km worlds without overlaps or holes', () => {
    for (const size of [64000, 256000]) {
      const tiles = selectWorldTiles(size, 12000, -4500, 800);
      expect(tiles.length).toBeLessThanOrEqual(256);
      expect(tiles.reduce((sum, t) => sum + t.size ** 2, 0)).toBe(size ** 2);
      expect(Math.min(...tiles.map(t => t.size))).toBeLessThanOrEqual(1000);
      for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        expect(a.x >= b.x + b.size || b.x >= a.x + a.size || a.z >= b.z + b.size || b.z >= a.z + a.size).toBe(true);
      }
    }
  });
});



describe('local continuous landforms',()=>{
  it('preserves the base outside a mound and has a smooth support boundary',()=>{
    const original=parseWorldPrompt('中央是草原',147,500);
    const recipe={...original,landforms:[{center:[0,0] as [number,number],radius:[80,60] as [number,number],height:24}]};
    const base=createWorldSampler(original),shaped=createWorldSampler(recipe);
    expect(shaped(0,0).height-base(0,0).height).toBeCloseTo(24,10);
    expect(shaped(81,0)).toEqual(base(81,0));
    expect(shaped(0,61)).toEqual(base(0,61));
    expect(Math.abs(shaped(79.999,0).height-base(79.999,0).height)).toBeLessThan(1e-8);
    expect(validateWorldRecipe(recipe)).toEqual(recipe);
    expect(()=>validateWorldRecipe({...recipe,landforms:[{...recipe.landforms[0],radius:[0,60]}]})).toThrow('invalid_world_landform');
    expect(()=>validateWorldRecipe({...recipe,landforms:Array(17).fill(recipe.landforms[0])})).toThrow('invalid_world_landform');
  });
});

