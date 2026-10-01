import { describe, expect, it } from 'vitest';
import { createWorldSampler, createWorldTerrainContext, dominantBiome, parseWorldPrompt, sampleWorldSlope,
  sampleWorldTile, selectWorldTiles, validateWorldRecipe, worldFreshWaterDistance, WORLD_BIOMES,
  type WorldRecipe } from '../src/shared/worldTerrain';
import { riverPathSamples, waterBoundaryContainsPoint, waterBoundaryDistance, waterBoundaryPoints } from '../src/shared/mapWater';
import { findWorldSiteCandidates } from '../src/shared/worldSiting';

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
    expect(() => validateWorldRecipe({ version: 1, seed: 1, size: 500,
      reliefProfile: 'unknown' as never, constraints: [{ region: 'center', biome: 'grassland' }] }))
      .toThrow('invalid_world_relief_profile');
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
      expect(a.freshWaterWeights[ai]).toBe(b.freshWaterWeights[bi]);
    }
  });

  it('skips unused normal sampling for render-only tiles', () => {
    const recipe = parseWorldPrompt('中央是草原', 17, 500);
    const base = createWorldSampler(recipe);
    let samples = 0;
    const tile = sampleWorldTile(recipe, { x: -50, z: -50, size: 100 }, 11, (x, z) => {
      samples += 1;
      return base(x, z);
    }, false);

    expect(samples).toBe(11 * 11);
    expect(tile.normals).toHaveLength(0);
    expect(tile.heights).toHaveLength(11 * 11);
    expect(tile.weights).toHaveLength(11 * 11 * WORLD_BIOMES.length);
    expect(tile.freshWaterWeights).toHaveLength(11 * 11);
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

describe('composable world terrain operations', () => {
  const original = parseWorldPrompt('中央是草原', 77, 8000);

  it('shapes a crater floor below its rim on an existing steep mound', () => {
    const mound = validateWorldRecipe({
      ...parseWorldPrompt('中央是草原', 99173, 500), reliefProfile: 'compact', heightScale: 0.02,
      landforms: [{ center: [0, 0], radius: [70, 70], height: 45 }]
    });
    const before = createWorldSampler(mound);
    expect(before(0, 0).height).toBeGreaterThan(before(30, 0).height + 10);

    const recipe = validateWorldRecipe({ ...mound, terrainBrushes: [{
      id: 'summit-crater', mode: 'crater', region: { kind: 'circle', center: [0, 0], radius: 30 },
      depth: 8, rimHeight: 4, feather: 10
    }] });
    const sample = createWorldSampler(recipe), center = sample(0, 0).height;
    const rim = [[30, 0], [0, 30], [-30, 0], [0, -30]]
      .map(([x, z]) => sample(x, z).height);

    expect(Math.min(...rim) - center).toBeCloseTo(12, 8);
    expect(sample(41, 0)).toEqual(before(41, 0));
  });

  it('applies bounded circle and path grades through the shared sampler', () => {
    const base = createWorldSampler(original), start = base(-100, 0).height, end = start - 20;
    const recipe = validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'harbor-pad', mode: 'flatten', region: { kind: 'circle', center: [0, 0], radius: 30 }, height: start, feather: 10 },
      { id: 'ski-run', mode: 'grade', region: { kind: 'path', points: [[-100, 0], [0, 0], [100, 0]], width: 12 },
        heights: [start, start - 10, end], feather: 4 }
    ] });
    const sample = createWorldSampler(recipe);
    expect(sample(-100, 0).height).toBeCloseTo(start, 10);
    expect(sample(0, 0).height).toBeCloseTo(start - 10, 10);
    expect(sample(100, 0).height).toBeCloseTo(end, 10);
    expect(sample(0, 50)).toEqual(base(0, 50));
    expect(sampleWorldSlope(sample, 50, 0)).toBeCloseTo(0.1, 2);
  });

  it('carves finite water, exposes tile water levels and applies local biome patches', () => {
    const base = createWorldSampler(original), level = base(0, 0).height + 2;
    const recipe = validateWorldRecipe({ ...original,
      waterBodies: [{ id: 'oasis', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 }, levels: [level], depth: 6 }],
      biomePatches: [{ id: 'oasis-green', region: { kind: 'circle', center: [0, 0], radius: 90 }, biome: 'forest', feather: 20 }]
    });
    const sample = createWorldSampler(recipe), center = sample(0, 0), outside = sample(250, 0);
    expect(center).toMatchObject({ waterLevel: level, waterBodyId: 'oasis' });
    expect(center.height).toBeCloseTo(level - 6, 10);
    expect(outside).toEqual(base(250, 0));
    expect(sample(70, 0).weights.forest).toBe(1);
    const tile = sampleWorldTile(recipe, { x: -50, z: -50, size: 100 }, 11, sample);
    expect(tile.waterLevels[5 * 11 + 5]).toBeCloseTo(level, 4);
    expect(Number.isNaN(tile.waterLevels[0])).toBe(true);
  });

  it('gives narrow-feather biome patches a bounded natural deterministic transition', () => {
    const baseRecipe = parseWorldPrompt('中央是沙漠', 6103, 500);
    const recipe = validateWorldRecipe({ ...baseRecipe, biomePatches: [{
      id: 'leeward-town-grass', region: { kind: 'circle', center: [0, 0], radius: 85 },
      biome: 'grassland', feather: 0.65
    }] });
    const sample = createWorldSampler(recipe);
    expect(recipe.biomePatches?.[0].feather).toBe(0.65);
    const thresholds = Array.from({ length: 48 }, (_, index) => {
      const angle = index / 48 * Math.PI * 2;
      for (let radius = 70; radius <= 115; radius += 0.5) {
        if (sample(Math.cos(angle) * radius, Math.sin(angle) * radius).weights.grassland < 0.5) return radius;
      }
      return 115;
    });
    let blended = 0;
    for (let index = 0; index < 48; index += 1) {
      const angle = index / 48 * Math.PI * 2;
      for (let radius = 70; radius <= 115; radius += 1) {
        const weight = sample(Math.cos(angle) * radius, Math.sin(angle) * radius).weights.grassland;
        if (weight > 0.05 && weight < 0.95) blended += 1;
      }
    }

    expect(sample(0, 0).weights.grassland).toBe(1);
    expect(sample(120, 0).weights.grassland).toBe(0);
    expect(Math.max(...thresholds) - Math.min(...thresholds)).toBeGreaterThan(6);
    expect(blended).toBeGreaterThan(250);

    const left = sampleWorldTile(recipe, { x: 35, z: -50, size: 50 }, 11, sample);
    const right = sampleWorldTile(recipe, { x: 85, z: -50, size: 50 }, 11, sample);
    for (let index = 0; index < 11; index += 1) {
      const leftOffset = (index * 11 + 10) * WORLD_BIOMES.length;
      const rightOffset = index * 11 * WORLD_BIOMES.length;
      expect([...left.weights.slice(leftOffset, leftOffset + WORLD_BIOMES.length)])
        .toEqual([...right.weights.slice(rightOffset, rightOffset + WORLD_BIOMES.length)]);
    }
  });

  it('shares one deterministic natural lake boundary across sampling, water geometry, ecology distance and tile seams', () => {
    const recipe = validateWorldRecipe({ ...original, waterBodies: [{
      id: 'oasis', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 },
      levels: [100], depth: 6
    }] });
    expect(recipe.waterBodies?.[0]).toMatchObject({
      shorelineSmoothness: 0.82,
      shorelineIrregularity: 0.16
    });
    const context = createWorldTerrainContext(recipe), water = context.waterBodies[0];
    expect(water.boundary).toEqual(water.mapWater.points);
    const radii = water.boundary.map(([x, z]) => Math.hypot(x, z));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(2);
    for (let index = 0; index < 16; index += 1) for (const radius of [30, 36, 44, 50]) {
      const angle = index / 16 * Math.PI * 2, x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      expect(context.sample(x, z).waterBodyId === 'oasis')
        .toBe(waterBoundaryContainsPoint(water.boundary, x, z));
    }
    const outside: [number, number] = [60, 0];
    expect(context.freshWaterDistance(...outside)).toBeCloseTo(
      waterBoundaryDistance(water.boundary, ...outside), 10
    );
    const left = sampleWorldTile(recipe, { x: -100, z: -50, size: 100 }, 11, context.sample);
    const right = sampleWorldTile(recipe, { x: 0, z: -50, size: 100 }, 11, context.sample);
    expect(left.waterLevels[5 * 11 + 10]).toBe(right.waterLevels[5 * 11]);
    const changed = createWorldTerrainContext({ ...recipe, waterBodies: [{ ...recipe.waterBodies![0], seed: 123 }] });
    expect(changed.waterBodies[0].boundary).not.toEqual(water.boundary);
  });

  it('interpolates river levels along path control points', () => {
    const recipe = validateWorldRecipe({ ...original, waterBodies: [{ id: 'river', type: 'river',
      region: { kind: 'path', points: [[-100, 0], [0, 0], [100, 0]], width: 20 }, levels: [30, 20, 5], depth: 3 }] });
    const sample = createWorldSampler(recipe);
    expect(sample(-100, 0).waterLevel).toBeCloseTo(30, 10);
    expect(sample(-50, 0).waterLevel).toBeCloseTo(25, 10);
    expect(sample(50, 0).waterLevel).toBeCloseTo(12.5, 10);
    expect(sample(0, 20).waterLevel).toBeNull();
  });

  it('shares one irregular river path across its prepared boundary and terrain sampling', () => {
    const recipe = validateWorldRecipe({ ...original, waterBodies: [{ id: 'natural-river', type: 'river',
      region: { kind: 'path', points: [[-100, 0], [0, 0], [100, 0]], width: 20 },
      levels: [8, 5, 2], widths: [8, 20, 32], depth: 3,
      shorelineSmoothness: 0.8, shorelineIrregularity: 0.35, seed: 27 }] });
    const context = createWorldTerrainContext(recipe), prepared = context.waterBodies[0];
    const centerline = riverPathSamples(prepared.mapWater);

    expect(prepared.mapWater.shorelineIrregularity).toBe(0.35);
    expect(prepared.mapWater.widths).toEqual([8, 20, 32]);
    expect(prepared.boundary).toEqual(waterBoundaryPoints(prepared.mapWater));
    expect(centerline[0]).toMatchObject({ point: [-100, 0], width: 8 });
    expect(centerline.at(-1)).toMatchObject({ point: [100, 0], width: 32 });
    expect(Math.max(...centerline.map(sample => Math.abs(sample.point[1])))).toBeGreaterThan(0.4);
    for (const point of centerline.slice(1, -1).filter((_, index) => index % 3 === 0)) {
      expect(context.sample(...point.point).waterBodyId).toBe('natural-river');
      expect(context.sample(...point.point).waterLevel).toBeCloseTo(point.level, 8);
    }
  });

  it('ends derived river geometry at the implicit ocean with one shared surface level', () => {
    const recipe = validateWorldRecipe({ ...original, reliefProfile: 'compact', terrainBrushes: [{
      id: 'coast-grade', mode: 'grade', region: { kind: 'path', points: [[-100, 0], [100, 0]], width: 180 },
      heights: [10, -10], feather: 0
    }, {
      id: 'land-after-dip', mode: 'flatten', region: { kind: 'circle', center: [20, 0], radius: 10 },
      height: 5, feather: 0
    }], waterBodies: [{
      id: 'river-mouth', type: 'river', region: { kind: 'path', points: [[-100, 0], [100, 0]], width: 12 },
      levels: [2, 0], widths: [8, 20], depth: 2, shorelineSmoothness: 0.8, shorelineIrregularity: 0.35, seed: 27
    }] });
    const context = createWorldTerrainContext(recipe), prepared = context.waterBodies[0];
    const mouth = prepared.mapWater.points.at(-1)!;

    expect(mouth[0]).toBeGreaterThan(25);
    expect(prepared.mapWater.shorelineIrregularity).toBe(0);
    expect(prepared.mapWater.levels?.at(-1)).toBe(0);
    expect(prepared.mapWater.widths?.at(-1)).toBeGreaterThan(8);
    expect(new Set(prepared.mapWater.widths?.map(width => width.toFixed(3))).size).toBeGreaterThan(3);
    expect(prepared.boundary).toEqual(waterBoundaryPoints(prepared.mapWater));
    expect(mouth).not.toEqual((recipe.waterBodies![0].region as { points: Array<[number, number]> }).points.at(-1));
    expect(context.sample(50, 0)).toMatchObject({ waterLevel: 0, waterBodyId: null, freshWaterWeight: 0 });
  });

  it('joins lake and river banks continuously to the surrounding terrain', () => {
    const base = createWorldSampler(original);
    for (const region of [
      { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 40 },
      { kind: 'path' as const, points: [[-100, 0], [100, 0]] as Array<[number, number]>, width: 80 }
    ]) {
      const level = base(0, 40).height - 20;
      const sample = createWorldSampler({ ...original, waterBodies: [{
        id: 'bank', type: region.kind === 'circle' ? 'lake' : 'river', region,
        levels: region.kind === 'circle' ? [level] : [level, level], depth: 6,
        shorelineSmoothness: 0, shorelineIrregularity: 0
      }] });
      // A one-centimetre step across a shoreline must not become a twenty-metre wall.
      expect(Math.abs(sample(0, 40.01).height - sample(0, 39.99).height)).toBeLessThan(0.01);
      expect(sample(0, 41).waterLevel).toBeNull();
      expect(sample(0, 50).height).toBeGreaterThan(level);
      expect(sample(0, 50).height).toBeLessThan(base(0, 50).height);
      expect(sample(0, 500).height).toBe(base(0, 500).height);
    }
  });

  it('gives default rivers a continuous bed profile and compact material bank', () => {
    const level = 3, depth = 2.5;
    const context = createWorldTerrainContext({
      version: 1, seed: 4080, size: 500, reliefProfile: 'compact', heightScale: 0.02,
      constraints: [{ region: 'center', biome: 'grassland' }],
      terrainBrushes: [{
        id: 'flat-floodplain', mode: 'flatten', region: { kind: 'circle', center: [0, 0], radius: 180 },
        height: 8, feather: 0
      }],
      waterBodies: [{
        id: 'profile-river', type: 'river',
        region: { kind: 'path', points: [[-140, 0], [140, 0]], width: 20 },
        levels: [level, level], depth, shorelineSmoothness: 0, shorelineIrregularity: 0
      }]
    });
    const center = context.sample(0, 0), innerBed = context.sample(0, 4);
    const insideEdge = context.sample(0, 9.99), outsideEdge = context.sample(0, 10.01);
    const materialBank = context.sample(0, 14);

    expect(center.height).toBeCloseTo(level - depth, 8);
    expect(innerBed.height).toBeGreaterThan(level - depth + 0.5);
    expect(center).toMatchObject({ waterLevel: level, waterBodyId: 'profile-river' });
    expect(insideEdge.waterBodyId).toBe('profile-river');
    expect(outsideEdge.waterBodyId).toBeNull();
    expect(materialBank.freshWaterWeight ?? 0).toBeLessThan(0.2);
  });

  it('keeps finite-water shore weight separate from the ocean biome', () => {
    const base = createWorldSampler(original), level = base(0, 0).height + 2;
    const sample = createWorldSampler({ ...original, reliefProfile: 'compact', waterBodies: [{
      id: 'lake-bank', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 },
      levels: [level], depth: 6, shorelineSmoothness: 0, shorelineIrregularity: 0
    }] });
    expect(sample(0, 0).freshWaterWeight).toBe(1);
    expect(sample(0, 0).weights.ocean).toBeCloseTo(base(0, 0).weights.ocean, 10);
    expect(sample(41, 0).freshWaterWeight ?? 0).toBeGreaterThan(sample(55, 0).freshWaterWeight ?? 0);
    expect(sample(55, 0).freshWaterWeight ?? 0).toBeGreaterThan(sample(70, 0).freshWaterWeight ?? 0);
  });

  it('does not reinterpret an inland below-sea-level river bed as ocean', () => {
    const dry = createWorldSampler(original);
    const point: [number, number] = [0, 0];
    expect(dry(...point).height).toBeGreaterThan(0);
    const sample = createWorldSampler({ ...original, reliefProfile: 'compact', waterBodies: [{
      id: 'sunken-river', type: 'river', region: { kind: 'path', points: [[-30, 0], [30, 0]], width: 8 },
      levels: [-1, -1], widths: [5, 11], depth: 2, shorelineSmoothness: 0, shorelineIrregularity: 0
    }] });
    expect(sample(...point)).toMatchObject({ waterLevel: -1, waterBodyId: 'sunken-river', freshWaterWeight: 1 });
    expect(sample(...point).weights.ocean).toBeCloseTo(dry(...point).weights.ocean, 10);
  });

  it('widens freshwater material on an inner river bend without moving the water surface', () => {
    const context = createWorldTerrainContext({
      version: 1, seed: 4081, size: 500, reliefProfile: 'compact', heightScale: 0.02,
      constraints: [{ region: 'center', biome: 'grassland' }],
      terrainBrushes: [{
        id: 'flat-floodplain', mode: 'flatten', region: { kind: 'circle', center: [0, 0], radius: 210 },
        height: 8, feather: 0
      }],
      waterBodies: [{
        id: 'bending-river', type: 'river',
        region: { kind: 'path', points: [[-140,60],[-60,20],[0,0],[40,-60],[120,-70]], width: 12 },
        levels: [3,3,3,3,3], depth: 2, shorelineSmoothness: 0.8, shorelineIrregularity: 0
      }]
    });
    const prepared = context.waterBodies[0], samples = prepared.riverSamples;
    let bendIndex = 3, strongestBend = 0;
    for (let index = 3; index < samples.length - 3; index += 1) {
      const before = samples[index - 3].point, center = samples[index].point, after = samples[index + 3].point;
      const incoming = [center[0] - before[0], center[1] - before[1]];
      const outgoing = [after[0] - center[0], after[1] - center[1]];
      const bend = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
      if (Math.abs(bend) > Math.abs(strongestBend)) { strongestBend = bend; bendIndex = index; }
    }
    const before = samples[bendIndex - 3].point, after = samples[bendIndex + 3].point;
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]);
    const left: [number, number] = [-(after[1] - before[1]) / length, (after[0] - before[0]) / length];
    const inner = strongestBend > 0 ? left : [-left[0], -left[1]] as [number, number];
    const center = samples[bendIndex].point;
    const bankPoint = (normal: [number, number]) => {
      let distance = 0;
      while (distance < 30 && waterBoundaryContainsPoint(prepared.boundary,
        center[0] + normal[0] * distance, center[1] + normal[1] * distance)) distance += 0.5;
      return [center[0] + normal[0] * (distance + 4), center[1] + normal[1] * (distance + 4)] as [number, number];
    };
    const innerBank = context.sample(...bankPoint(inner));
    const outerBank = context.sample(...bankPoint([-inner[0], -inner[1]]));

    expect(innerBank.freshWaterWeight ?? 0).toBeGreaterThan((outerBank.freshWaterWeight ?? 0) + 0.08);
    expect(context.sample(...center)).toMatchObject({ waterLevel: 3, waterBodyId: 'bending-river' });
  });

  it('narrows freshwater material on a steep bank while keeping the river level stable', () => {
    const sample = createWorldSampler({
      version: 1, seed: 4082, size: 500, reliefProfile: 'compact', heightScale: 0.02,
      constraints: [{ region: 'center', biome: 'grassland' }],
      terrainBrushes: [
        { id: 'high-bank', mode: 'flatten', region: { kind: 'circle', center: [0,24], radius: 14 }, height: 18, feather: 0 },
        { id: 'low-bank', mode: 'flatten', region: { kind: 'circle', center: [0,-24], radius: 14 }, height: 4, feather: 0 }
      ],
      waterBodies: [{
        id: 'level-river', type: 'river', region: { kind: 'path', points: [[-100,0],[100,0]], width: 12 },
        levels: [3,3], depth: 2, shorelineSmoothness: 0, shorelineIrregularity: 0
      }]
    });
    const highBank = sample(0, 12), lowBank = sample(0, -12);
    expect(lowBank.freshWaterWeight ?? 0).toBeGreaterThan((highBank.freshWaterWeight ?? 0) + 0.2);
    expect(sample(0, 0)).toMatchObject({ waterLevel: 3, waterBodyId: 'level-river' });
  });

  it('rejects malformed or colliding operation identities', () => {
    expect(() => validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'same', mode: 'raise', region: { kind: 'circle', center: [0, 0], radius: 10 }, amount: 2 }
    ], waterBodies: [
      { id: 'same', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 10 }, levels: [1], depth: 2 }
    ] })).toThrow('invalid_world_terrain_id');
    expect(() => validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'bad-grade', mode: 'grade', region: { kind: 'path', points: [[0, 0], [10, 0]], width: 4 }, heights: [1] }
    ] })).toThrow('invalid_world_terrain_brush');
    expect(() => validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'bad-crater', mode: 'crater', region: { kind: 'path', points: [[0, 0], [10, 0]], width: 4 }, depth: 8, rimHeight: 4 } as never
    ] })).toThrow('invalid_world_terrain_brush');
    expect(() => validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'bad-crater-depth', mode: 'crater', region: { kind: 'circle', center: [0, 0], radius: 10 }, depth: 0, rimHeight: 4 }
    ] })).toThrow('invalid_world_terrain_brush');
    expect(() => validateWorldRecipe({ ...original, terrainBrushes: [
      { id: 'bad-crater-rim', mode: 'crater', region: { kind: 'circle', center: [0, 0], radius: 10 }, depth: 8, rimHeight: 1001 }
    ] })).toThrow('invalid_world_terrain_brush');
  });

  it('scales macro relief before applying authored local landforms', () => {
    const scaled = validateWorldRecipe({ ...original, heightScale: 0.1,
      landforms: [{ center: [0, 0], radius: [40, 40], height: 20 }] });
    const baseHeight = createWorldSampler(original)(0, 0).height;
    expect(createWorldSampler(scaled)(0, 0).height).toBeCloseTo(baseHeight * 0.1 + 20, 10);
    expect(() => validateWorldRecipe({ ...original, heightScale: 0 })).toThrow('invalid_world_height_scale');
  });

  it('keeps the existing desert dune relief when macro elevation is scaled across seeds and world sizes', () => {
    for (const seed of [42, 2309, 99173]) for (const size of [1600, 8000, 64000]) {
      const recipe:WorldRecipe={version:1,seed,size,constraints:[{region:'center',biome:'desert'}]};
      const full=createWorldSampler(recipe),scaled=createWorldSampler({...recipe,heightScale:.12});
      const residuals:number[]=[],heights:number[]=[];
      for(let z=-400;z<=400;z+=40)for(let x=-400;x<=400;x+=40){
        const height=scaled(x,z).height;
        heights.push(height);
        residuals.push(height-full(x,z).height*.12);
        expect(height).toBe(scaled(x,z).height);
      }
      expect(Math.max(...residuals)-Math.min(...residuals)).toBeGreaterThan(4);
      expect(Math.max(...heights)-Math.min(...heights)).toBeGreaterThan(5);
    }
  });

  it('raises ecological moisture near explicit fresh water while excluding the implicit salt ocean', () => {
    const base:WorldRecipe={version:1,seed:2309,size:1600,heightScale:.12,constraints:[
      {region:'west',biome:'ocean'},{region:'center',biome:'desert'},{region:'east',biome:'desert'}
    ]};
    const lake={id:'spring',type:'lake' as const,region:{kind:'circle' as const,center:[180,0] as [number,number],radius:30},levels:[30],depth:3};
    const recipe={...base,waterBodies:[lake]},dry=createWorldSampler(base),wet=createWorldSampler(recipe);
    const spring = createWorldTerrainContext(recipe).waterBodies[0];
    expect(worldFreshWaterDistance(recipe,220,0)).toBeCloseTo(
      waterBoundaryDistance(spring.boundary, 220, 0), 10
    );
    expect(worldFreshWaterDistance(recipe,180,0)).toBe(0);
    expect(worldFreshWaterDistance(base,-450,0)).toBe(Infinity);
    expect(wet(220,0).moisture).toBeGreaterThan(dry(220,0).moisture);
    expect(wet(220,0).weights.desert).toBeLessThan(dry(220,0).weights.desert);
    expect(wet(220,0).weights.grassland+wet(220,0).weights.forest)
      .toBeGreaterThan(dry(220,0).weights.grassland+dry(220,0).weights.forest);
    expect(wet(-450,0).moisture).toBe(dry(-450,0).moisture);
  });

  it('makes the reproduced kilometre coast traversable without removing its sea-to-land transition', () => {
    const recipe = validateWorldRecipe({ version: 1, seed: 2309, size: 1600, heightScale: 0.1, constraints: [
      { region: 'west', biome: 'ocean' }, { region: 'center', biome: 'desert' },
      { region: 'east', biome: 'desert' }, { region: 'north', biome: 'desert' }, { region: 'south', biome: 'desert' }
    ] });
    const sample = createWorldSampler(recipe);
    expect(sample(-450, 0).waterLevel).toBe(0);
    expect(sample(-250, 0).waterLevel).toBeNull();
    let maxSlope = 0;
    for (let x = -700; x <= 300; x += 4) maxSlope = Math.max(maxSlope, sampleWorldSlope(sample, x, 0));
    expect(maxSlope).toBeLessThan(0.5);
  });

  it('keeps compact worlds rolling without cliff tails across seeds and climate plans', () => {
    const scenarios: WorldRecipe['constraints'][] = [
      [
        { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'forest' },
        { region: 'south', biome: 'desert' }
      ],
      [
        { region: 'west', biome: 'ocean' }, { region: 'center', biome: 'grassland' },
        { region: 'east', biome: 'desert' }, { region: 'north', biome: 'mountains' }
      ]
    ];
    for (const constraints of scenarios) for (const seed of [1, 42, 2309, 99173]) {
      const sample = createWorldSampler({
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.035, constraints
      });
      const slopes: number[] = [];
      for (let z = -240; z <= 240; z += 8) for (let x = -240; x <= 240; x += 8) {
        slopes.push(sampleWorldSlope(sample, x, z));
      }
      expect(slopes.filter(slope => slope < 0.02).length / slopes.length).toBeLessThan(0.35);
      expect(slopes.filter(slope => slope > 0.75).length / slopes.length).toBeLessThan(0.01);
    }
  });

  it('forms a broad connected island when compact constraints specify a complete ocean ring', () => {
    const recipe: WorldRecipe = {
      version: 1, seed: 6103402, size: 500, reliefProfile: 'compact', heightScale: 0.12,
      constraints: [
        { region: 'north', biome: 'ocean' }, { region: 'south', biome: 'ocean' },
        { region: 'east', biome: 'ocean' }, { region: 'west', biome: 'ocean' },
        { region: 'northwest', biome: 'ocean' }, { region: 'northeast', biome: 'ocean' },
        { region: 'southwest', biome: 'ocean' }, { region: 'southeast', biome: 'ocean' },
        { region: 'center', biome: 'grassland' }
      ],
      landforms: [
        { center: [0, 35], radius: [175, 145], height: 7 },
        { center: [-20, -155], radius: [72, 62], height: 34 },
        { center: [-78, -128], radius: [38, 48], height: 18 }
      ],
      terrainBrushes: [
        { id: 'north-forest-ridge', mode: 'raise', amount: 9, feather: 18,
          region: { kind: 'path', points: [[-92,-190],[-55,-168],[-18,-148],[22,-158],[65,-190]], width: 22 } },
        { id: 'natural-mountain-gully', mode: 'lower', amount: 6, feather: 14,
          region: { kind: 'path', points: [[-24,-198],[-18,-174],[-10,-150],[-2,-126],[10,-103]], width: 10 } },
        { id: 'port-terrace', mode: 'flatten', height: 3, strength: 0.25, feather: 22,
          region: { kind: 'circle', center: [54,48], radius: 54 } }
      ],
      waterBodies: [{
        id: 'inland-creek', type: 'river',
        region: { kind: 'path', points: [[-20,-190],[-16,-166],[-10,-140],[-2,-112],[8,-82],[19,-48],[32,-14],[48,24]], width: 6 },
        levels: [-1,-1,-1,-1,-1,-1,-1,-1], depth: 1.2,
        shorelineSmoothness: 0.8, shorelineIrregularity: 0, shorelineProfile: 'gentle', seed: 6103402
      }]
    };
    const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)
      [Math.floor((values.length - 1) * fraction)];
    for (const seed of [6103402, 99173]) {
      const sample = createWorldSampler({ ...recipe, seed }), side = 21;
      const dry = Array.from({ length: side }, () => Array.from({ length: side }, () => false));
      const heights: number[] = [], settlementSlopes: number[] = [];
      let borderDry = 0;
      for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
        const x = -250 + ix * 25, z = -250 + iz * 25, height = sample(x, z).height;
        dry[iz][ix] = height > 2;
        if (dry[iz][ix]) heights.push(height);
        if (dry[iz][ix] && (ix === 0 || iz === 0 || ix === side - 1 || iz === side - 1)) borderDry++;
      }
      let largest = 0;
      const visited = new Set<string>();
      for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
        if (!dry[iz][ix] || visited.has(`${ix}:${iz}`)) continue;
        let count = 0;
        const pending: Array<[number, number]> = [[ix, iz]];
        while (pending.length > 0) {
          const [x, z] = pending.pop()!, key = `${x}:${z}`;
          if (visited.has(key) || !dry[z]?.[x]) continue;
          visited.add(key); count++;
          pending.push([x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]);
        }
        largest = Math.max(largest, count);
      }
      for (let z = -70; z <= 120; z += 6) for (let x = -120; x <= 120; x += 6) {
        if (Math.hypot(x, z) <= 125 && sample(x, z).height > 2) {
          settlementSlopes.push(sampleWorldSlope(sample, x, z));
        }
      }
      expect(heights.length).toBeGreaterThan(80);
      expect(heights.length).toBeLessThan(140);
      expect(largest / heights.length).toBeGreaterThan(0.97);
      expect(borderDry).toBe(0);
      expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(8.5);
      expect(percentile(settlementSlopes, 0.95)).toBeLessThan(0.32);
    }
  });

  it('uses four compact ocean sides plus a broad authored core without changing non-island controls', () => {
    const recipe: WorldRecipe = {
      version: 1, seed: 6103402, size: 500, reliefProfile: 'compact', heightScale: 0.1,
      constraints: [
        { region: 'west', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
        { region: 'north', biome: 'ocean' }, { region: 'south', biome: 'ocean' }
      ],
      landforms: [
        { center: [0,15], radius: [220,210], height: 8 },
        { center: [10,130], radius: [145,75], height: 5 },
        { center: [5,35], radius: [155,125], height: 4 },
        { center: [0,-145], radius: [125,90], height: 58 },
        { center: [-95,-120], radius: [75,55], height: 30 },
        { center: [90,-125], radius: [70,52], height: 34 },
        { center: [25,-90], radius: [38,70], height: -10 },
        { center: [-185,45], radius: [55,70], height: 18 },
        { center: [185,20], radius: [52,68], height: 16 },
        { center: [-105,160], radius: [75,45], height: 2 },
        { center: [115,155], radius: [78,42], height: 2 }
      ],
      terrainBrushes: [
        { id: 'harbor-terrace', mode: 'flatten', region: { kind: 'circle', center: [-55,112], radius: 62 },
          height: 3, strength: 0.35, feather: 24 },
        { id: 'town-coastal-grade', mode: 'grade',
          region: { kind: 'path', points: [[-100,115],[-72,108],[-42,102],[-12,94]], width: 28 },
          heights: [3,3,4,5], strength: 0.45, feather: 14 },
        { id: 'mountain-trail-slope', mode: 'grade',
          region: { kind: 'path', points: [[-12,82],[-8,45],[4,5],[18,-35],[25,-75]], width: 12 },
          heights: [5,7,10,16,23], strength: 0.3, feather: 18 },
        { id: 'north-natural-gully', mode: 'lower',
          region: { kind: 'path', points: [[36,-190],[28,-155],[20,-120],[8,-82]], width: 18 },
          amount: 7, feather: 22 }
      ]
    };
    const controlPoints = [[0,0],[120,60],[0,-130],[200,200]] as Array<[number, number]>;
    const controlHeights: Record<number, number[][]> = {
      6103402: [
        [-36.46380285830869,-39.13025069690908,-41.30290843773296,-21.43678263844177],
        [-28.58565451464436,-38.891974860581925,-41.59735313553267,-21.43678263844177],
        [-30.242735663100557,-34.314475882526196,-41.466237024453704,-21.43678263844177]
      ],
      99173: [
        [-41.346580055208335,-44.090259154492564,-45.775962198170134,-32.35528552930164],
        [-33.46840198239825,-42.516542849441706,-45.367311577307575,-32.35528552930164],
        [-35.0442612084656,-39.05324928587915,-45.24505126404188,-32.35528552930164]
      ]
    };
    const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)
      [Math.floor((values.length - 1) * fraction)];
    for (const seed of [6103402, 99173]) {
      const sample = createWorldSampler({ ...recipe, seed }), side = 17;
      const dry = Array.from({ length: side }, () => Array.from({ length: side }, () => false));
      let dryCount = 0, borderDry = 0;
      for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
        const isDry = sample(-250 + ix * 31.25, -250 + iz * 31.25).height > 2;
        dry[iz][ix] = isDry;
        if (isDry) dryCount++;
        if (isDry && (ix === 0 || iz === 0 || ix === side - 1 || iz === side - 1)) borderDry++;
      }
      const visited = new Set<string>();
      let largest = 0, span: [number, number] = [0, 0];
      for (let iz = 0; iz < side; iz++) for (let ix = 0; ix < side; ix++) {
        if (!dry[iz][ix] || visited.has(`${ix}:${iz}`)) continue;
        let count = 0, minX = ix, maxX = ix, minZ = iz, maxZ = iz;
        const pending: Array<[number, number]> = [[ix, iz]];
        while (pending.length > 0) {
          const [x, z] = pending.pop()!, key = `${x}:${z}`;
          if (visited.has(key) || !dry[z]?.[x]) continue;
          visited.add(key); count++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          pending.push([x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]);
        }
        if (count > largest) { largest = count; span = [(maxX - minX) * 31.25, (maxZ - minZ) * 31.25]; }
      }
      const edgeHeights: number[] = [], coastSlopes: number[] = [];
      for (let index = 0; index <= 50; index++) {
        const value = -250 + index * 10;
        edgeHeights.push(sample(-250, value).height, sample(250, value).height,
          sample(value, -250).height, sample(value, 250).height);
      }
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 36) {
        let previous = sample(Math.cos(angle) * 250, Math.sin(angle) * 250).height;
        for (let radius = 248; radius >= 0; radius -= 2) {
          const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius, height = sample(x, z).height;
          if (previous <= 0 && height > 0) { coastSlopes.push(sampleWorldSlope(sample, x, z)); break; }
          previous = height;
        }
      }
      const count = 144;
      const profiles = [0.45, 0.6, 0.75].map(radius => Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        return sample(Math.cos(angle) * 125 * radius, -145 + Math.sin(angle) * 90 * radius).height;
      }));
      const residuals = profiles.map(profile => profile.map((height, index) => height
        - [-5,-4,-3,3,4,5].reduce((sum, offset) => sum + profile[(index + offset + count) % count], 0) / 6));
      const port = findWorldSiteCandidates({ ...recipe, seed }, {
        id: 'port', radius: 105, blend: 32, region: 'center', waterfrontBias: 0.9, targetWaterBodyId: 'sea'
      });
      const farm = findWorldSiteCandidates({ ...recipe, seed }, {
        id: 'farm', radius: 55, blend: 24, region: 'northwest', waterfrontBias: 0.1
      });
      let maxAxisSeparation = 0;
      for (const a of port) for (const b of farm) {
        maxAxisSeparation = Math.max(maxAxisSeparation,
          Math.max(Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1])));
      }
      expect(dryCount).toBeGreaterThan(85);
      expect(largest / dryCount).toBeGreaterThan(0.98);
      expect(span[0]).toBeGreaterThan(350);
      expect(span[1]).toBeGreaterThan(330);
      expect(borderDry).toBeLessThanOrEqual(1);
      expect(Math.max(...edgeHeights)).toBeLessThan(8);
      expect(percentile(coastSlopes, 0.95)).toBeLessThan(1.2);
      expect(percentile(residuals.flat(), 0.1)).toBeLessThan(-3);
      expect(percentile(residuals.flat().map(Math.abs), 0.5)).toBeGreaterThan(1);
      expect(maxAxisSeparation).toBeGreaterThan(160);

      const controls: WorldRecipe[] = [
        { ...recipe, seed, landforms: [], terrainBrushes: [] },
        { ...recipe, seed, landforms: [{ center: [0,15], radius: [159,210], height: 8 }], terrainBrushes: [] },
        { ...recipe, seed, landforms: [{ center: [61,0], radius: [220,210], height: 8 }], terrainBrushes: [] }
      ];
      for (const [index, controlRecipe] of controls.entries()) {
        const control = createWorldSampler(controlRecipe);
        expect(controlPoints.map(([x, z]) => control(x, z).height)).toEqual(controlHeights[seed][index]);
      }
    }
  });

  it('adds broad ridges and erosion grooves to compact mountain relief without a steep slope tail', () => {
    const medianResiduals: number[] = [], grooveShares: number[] = [], ridgeShares: number[] = [];
    for (const seed of [1, 42, 2309, 99173]) {
      const sample = createWorldSampler({
        version: 1, seed, size: 2400, reliefProfile: 'compact', heightScale: 0.08,
        constraints: [
          { region: 'center', biome: 'mountains' }, { region: 'east', biome: 'ocean' },
          { region: 'southwest', biome: 'forest' }
        ],
        landforms: [
          { center: [-240, -180], radius: [630, 700], height: 180 },
          { center: [-240, -180], radius: [180, 160], height: -48 }
        ]
      });
      const slopes: number[] = [], residuals: number[] = [];
      for (let z = -672; z <= 672; z += 48) for (let x = -672; x <= 672; x += 48) {
        slopes.push(sampleWorldSlope(sample, x, z));
        residuals.push(sample(x, z).height - (sample(x + 42, z).height + sample(x - 42, z).height
          + sample(x, z + 42).height + sample(x, z - 42).height) / 4);
      }
      const absolute = residuals.map(Math.abs).sort((a, b) => a - b);
      medianResiduals.push(absolute[Math.floor(absolute.length / 2)]);
      grooveShares.push(residuals.filter(value => value < -0.5).length / residuals.length);
      ridgeShares.push(residuals.filter(value => value > 0.5).length / residuals.length);
      slopes.sort((a, b) => a - b);
      expect(slopes[Math.floor(slopes.length * 0.95)]).toBeLessThan(0.7);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(medianResiduals)).toBeGreaterThan(0.62);
    expect(mean(grooveShares)).toBeGreaterThan(0.25);
    expect(mean(ridgeShares)).toBeGreaterThan(0.27);
  });

  it('keeps compact island slopes visibly folded at streamed mesh scale across seeds', () => {
    const medianResiduals: number[] = [], grooveShares: number[] = [], ridgeShares: number[] = [];
    for (const seed of [1, 42, 2309, 9012902, 99173]) {
      const sample = createWorldSampler({
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.035,
        constraints: [
          { region: 'center', biome: 'mountains' }, { region: 'northwest', biome: 'snow' },
          { region: 'southwest', biome: 'forest' }, { region: 'east', biome: 'ocean' }
        ],
        landforms: [
          { center: [-60, -55], radius: [160, 180], height: 42 },
          { center: [-60, -55], radius: [50, 45], height: -15 }
        ]
      });
      const slopes: number[] = [], residuals: number[] = [];
      for (let z = -220; z <= 180; z += 8) for (let x = -220; x <= 120; x += 8) {
        const dx = (x + 60) / 160, dz = (z + 55) / 180, d2 = dx * dx + dz * dz;
        if (d2 < 0.15 || d2 > 0.9) continue;
        slopes.push(sampleWorldSlope(sample, x, z));
        residuals.push(sample(x, z).height - (sample(x + 16, z).height + sample(x - 16, z).height
          + sample(x, z + 16).height + sample(x, z - 16).height) / 4);
      }
      const absolute = residuals.map(Math.abs).sort((a, b) => a - b);
      medianResiduals.push(absolute[Math.floor(absolute.length / 2)]);
      grooveShares.push(residuals.filter(value => value < -0.35).length / residuals.length);
      ridgeShares.push(residuals.filter(value => value > 0.35).length / residuals.length);
      slopes.sort((a, b) => a - b);
      expect(slopes[Math.floor(slopes.length * 0.95)]).toBeLessThan(0.68);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(medianResiduals)).toBeGreaterThan(0.53);
    expect(mean(grooveShares)).toBeGreaterThan(0.33);
    expect(mean(ridgeShares)).toBeGreaterThan(0.28);
  });

  it('feathers compact coastal earthworks instead of forming one continuous slope wall', () => {
    for (const seed of [1, 42, 2309, 6103301, 99173]) {
      const sample = createWorldSampler({
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.1,
        constraints: [
          { region: 'center', biome: 'grassland' }, { region: 'east', biome: 'grassland' },
          { region: 'north', biome: 'forest' }, { region: 'west', biome: 'ocean' }
        ],
        landforms: [
          { center: [20, -185], radius: [175, 58], height: 11 },
          { center: [175, -130], radius: [60, 65], height: 5 }
        ],
        terrainBrushes: [{
          id: 'curving-western-bay', mode: 'lower', amount: 16, feather: 12,
          region: { kind: 'path', points: [
            [-165, -235], [-190, -135], [-155, -35], [-185, 65], [-150, 155], [-175, 235]
          ], width: 72 }
        }]
      });
      const shoreline: number[] = [];
      for (const z of [-220, -160, -100, -40, 20, 80, 140, 200]) {
        let previous = sample(-250, z).height, shoreX: number | undefined, maxSlope = 0;
        for (let x = -248; x <= 40; x += 2) {
          const point = sample(x, z);
          maxSlope = Math.max(maxSlope, sampleWorldSlope(sample, x, z));
          if (previous <= 0 && point.height > 0) shoreX = x;
          previous = point.height;
        }
        expect(shoreX).toBeDefined();
        expect(maxSlope).toBeLessThan(0.9);
        shoreline.push(shoreX!);
      }
      expect(Math.max(...shoreline) - Math.min(...shoreline)).toBeGreaterThan(40);
    }
  });

  it('keeps a compact fishing coast curved and its northern hill folds visible across seeds', () => {
    for (const seed of [420631, 99173]) {
      const sample = createWorldSampler({
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.1,
        constraints: [
          { region: 'center', biome: 'grassland' }, { region: 'east', biome: 'grassland' },
          { region: 'north', biome: 'forest' }, { region: 'northeast', biome: 'forest' },
          { region: 'northwest', biome: 'ocean' }, { region: 'south', biome: 'grassland' },
          { region: 'southwest', biome: 'ocean' }, { region: 'west', biome: 'ocean' }
        ],
        landforms: [
          { center: [38, 5], radius: [186, 215], height: 9 },
          { center: [155, -151], radius: [72, 67], height: 19 },
          { center: [73, -174], radius: [47, 48], height: 11 },
          { center: [170, 105], radius: [61, 75], height: 5 }
        ],
        terrainBrushes: [
          { id: 'curved-western-foreshore', mode: 'lower', amount: 3, feather: 16,
            region: { kind: 'path', points: [
              [-201, -205], [-190, -143], [-205, -80], [-183, -18], [-199, 52], [-184, 117], [-204, 202]
            ], width: 19 } },
          { id: 'northern-hill-gully', mode: 'lower', amount: 3, feather: 6,
            region: { kind: 'path', points: [[133, -201], [123, -175], [105, -147], [91, -124]], width: 7 } },
          { id: 'second-hill-gully', mode: 'lower', amount: 2, feather: 5,
            region: { kind: 'path', points: [[190, -187], [174, -164], [161, -138], [145, -115]], width: 6 } }
        ]
      });
      const shoreline: number[] = [], shoreSlopes: number[] = [];
      for (let z = -220; z <= 220; z += 20) {
        let previous = sample(-250, z).height, shoreX: number | undefined, shoreSlope = 0;
        for (let x = -248; x <= 60; x += 2) {
          const point = sample(x, z);
          if (previous <= 0 && point.height > 0) {
            shoreX = x;
            shoreSlope = sampleWorldSlope(sample, x, z);
          }
          previous = point.height;
        }
        expect(shoreX).toBeDefined();
        shoreline.push(shoreX!);
        shoreSlopes.push(shoreSlope);
      }
      const localTurns = shoreline.slice(1, -1)
        .map((x, index) => Math.abs(shoreline[index] - 2 * x + shoreline[index + 2]));
      expect(localTurns.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(60);
      shoreSlopes.sort((a, b) => a - b);
      expect(shoreSlopes[Math.floor(shoreSlopes.length * 0.95)]).toBeLessThan(0.6);

      const residuals: number[] = [], hillSlopes: number[] = [], townSlopes: number[] = [];
      for (let z = -230; z <= -80; z += 6) for (let x = 30; x <= 230; x += 6) {
        const height = sample(x, z).height;
        hillSlopes.push(sampleWorldSlope(sample, x, z));
        residuals.push(height - (sample(x + 12, z).height + sample(x - 12, z).height
          + sample(x, z + 12).height + sample(x, z - 12).height) / 4);
      }
      for (let z = 24; z <= 170; z += 8) for (let x = -64; x <= 88; x += 8) {
        if (sample(x, z).height > 0) townSlopes.push(sampleWorldSlope(sample, x, z));
      }
      const absolute = residuals.map(Math.abs).sort((a, b) => a - b);
      expect(absolute[Math.floor(absolute.length / 2)]).toBeGreaterThan(0.47);
      expect(residuals.filter(value => value > 0.35).length / residuals.length).toBeGreaterThan(0.3);
      hillSlopes.sort((a, b) => a - b);
      townSlopes.sort((a, b) => a - b);
      expect(hillSlopes[Math.floor(hillSlopes.length * 0.95)]).toBeLessThan(0.7);
      expect(townSlopes[Math.floor(townSlopes.length * 0.95)]).toBeLessThan(0.4);
    }
  });

  it('cuts coherent gullies into modest steep landforms without roughening broad town terraces', () => {
    const amplitudes: number[] = [];
    for (const seed of [1, 42, 2309, 20261001, 99173]) {
      const base: WorldRecipe = {
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.035,
        constraints: [
          { region: 'center', biome: 'forest' }, { region: 'north', biome: 'ocean' },
          { region: 'south', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
          { region: 'west', biome: 'ocean' }
        ]
      };
      const core = { center: [15, 5] as [number, number], radius: [218, 220] as [number, number], height: 13 };
      const landform = { center: [60, -62] as [number, number], radius: [69, 73] as [number, number], height: 15 };
      const plain = createWorldSampler({ ...base, landforms: [core] });
      const shaped = createWorldSampler({ ...base, landforms: [core, landform] });
      const count = 144, radius = 0.64;
      const profile = Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        const x = landform.center[0] + Math.cos(angle) * landform.radius[0] * radius;
        const z = landform.center[1] + Math.sin(angle) * landform.radius[1] * radius;
        return shaped(x, z).height - plain(x, z).height - landform.height * (1 - radius ** 2) ** 3;
      });
      const amplitude = (frequency: number) => {
        let cosine = 0, sine = 0;
        for (let index = 0; index < count; index += 1) {
          const angle = index / count * Math.PI * 2;
          cosine += profile[index] * Math.cos(frequency * angle);
          sine += profile[index] * Math.sin(frequency * angle);
        }
        return 2 * Math.hypot(cosine, sine) / count;
      };
      amplitudes.push(Math.max(amplitude(5), amplitude(7)));

      const terrace = createWorldSampler({ ...base, landforms: [
        core, { center: [-45, 95], radius: [120, 100], height: 15 }
      ] });
      const slopes: number[] = [];
      for (let z = -5; z <= 195; z += 8) for (let x = -165; x <= 75; x += 8) {
        const dx = (x + 45) / 120, dz = (z - 95) / 100;
        if (dx * dx + dz * dz < 0.75) slopes.push(sampleWorldSlope(terrace, x, z));
      }
      slopes.sort((left, right) => left - right);
      expect(slopes[Math.floor(slopes.length * 0.95)]).toBeLessThan(0.52);
    }
    expect(amplitudes.reduce((sum, value) => sum + value, 0) / amplitudes.length).toBeGreaterThan(0.55);
  });

  it('carves coherent downslope drainage into large compact island mountains across seeds', () => {
    const recipe: WorldRecipe = {
      version: 1, seed: 6103402, size: 500, reliefProfile: 'compact', heightScale: 0.12,
      constraints: [
        { region: 'center', biome: 'grassland' }, { region: 'east', biome: 'ocean' },
        { region: 'north', biome: 'mountains' }, { region: 'northeast', biome: 'forest' },
        { region: 'northwest', biome: 'forest' }, { region: 'south', biome: 'ocean' },
        { region: 'southeast', biome: 'grassland' }, { region: 'southwest', biome: 'grassland' },
        { region: 'west', biome: 'ocean' }
      ],
      landforms: [
        { center: [0, 30], radius: [220, 185], height: 5 },
        { center: [-35, -145], radius: [105, 75], height: 42 },
        { center: [35, -125], radius: [85, 65], height: 28 },
        { center: [-5, -115], radius: [150, 24], height: 18 },
        { center: [-75, -105], radius: [42, 95], height: 13 },
        { center: [78, -135], radius: [38, 85], height: 10 }
      ],
      terrainBrushes: [
        { id: 'north-ridge-west', mode: 'raise', amount: 10, feather: 18,
          region: { kind: 'path', points: [[-120,-175],[-75,-145],[-25,-130],[25,-112],[75,-105],[120,-78]], width: 24 } },
        { id: 'north-gully', mode: 'lower', amount: 8, feather: 15,
          region: { kind: 'path', points: [[72,-205],[55,-170],[42,-135],[35,-100]], width: 13 } },
        { id: 'harbor-terrace', mode: 'flatten', height: 3, strength: 0.35, feather: 22,
          region: { kind: 'circle', center: [58,92], radius: 62 } },
        { id: 'inland-farm-terrace', mode: 'flatten', height: 5, strength: 0.3, feather: 18,
          region: { kind: 'circle', center: [-55,55], radius: 48 } }
      ]
    };
    const medianAngularResiduals: number[] = [], channelTroughDepths: number[] = [];
    const radialCorrelations: number[] = [], ridgeShares: number[] = [];
    const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)
      [Math.floor((values.length - 1) * fraction)];
    const correlation = (a: number[], b: number[]) => {
      const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
      const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
      const centeredA = a.map(value => value - meanA), centeredB = b.map(value => value - meanB);
      return centeredA.reduce((sum, value, index) => sum + value * centeredB[index], 0)
        / Math.sqrt(centeredA.reduce((sum, value) => sum + value * value, 0)
          * centeredB.reduce((sum, value) => sum + value * value, 0));
    };
    for (const seed of [6103402, 99173]) {
      const sample = createWorldSampler({ ...recipe, seed }), count = 144;
      const profiles = [0.48, 0.62, 0.76].map(radius => Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        return sample(-35 + Math.cos(angle) * 105 * radius, -145 + Math.sin(angle) * 75 * radius).height;
      }));
      const residuals = profiles.map(profile => profile.map((height, index) => {
        const offsets = [-5, -4, -3, 3, 4, 5];
        return height - offsets.reduce((sum, offset) => sum + profile[(index + offset + count) % count], 0)
          / offsets.length;
      }));
      medianAngularResiduals.push(percentile(residuals.flat().map(Math.abs), 0.5));
      channelTroughDepths.push(-percentile(residuals.flat(), 0.1));
      radialCorrelations.push(correlation(residuals[0], residuals[1]), correlation(residuals[1], residuals[2]));
      ridgeShares.push(residuals.flat().filter(value => value > 0.25).length / residuals.flat().length);

      const townSlopes: number[] = [];
      for (let z = 10; z <= 155; z += 6) for (let x = 15; x <= 205; x += 6) {
        if (sample(x, z).height > 0) townSlopes.push(sampleWorldSlope(sample, x, z));
      }
      expect(percentile(townSlopes, 0.95)).toBeLessThan(0.31);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(medianAngularResiduals)).toBeGreaterThan(1.1);
    expect(mean(channelTroughDepths)).toBeGreaterThan(3.1);
    expect(mean(radialCorrelations)).toBeGreaterThan(0.58);
    expect(mean(ridgeShares)).toBeGreaterThan(0.3);
  });

  it('keeps compact ridge drainage visible and authored gullies narrow across seeds', () => {
    const base: WorldRecipe = {
      version: 1, seed: 1, size: 500, reliefProfile: 'compact', heightScale: 0.1,
      constraints: [
        { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'mountains' },
        { region: 'south', biome: 'grassland' }, { region: 'west', biome: 'ocean' }
      ],
      landforms: [{ center: [0, -145], radius: [88, 30], height: 27 }]
    };
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)
      [Math.floor((values.length - 1) * fraction)];
    const drainageResiduals: number[] = [];
    for (const seed of [1, 42, 2309, 99173]) {
      const plain = createWorldSampler({ ...base, seed });
      const carved = createWorldSampler({ ...base, seed, terrainBrushes: [{
        id: 'ridge-gully', mode: 'lower', amount: 6, feather: 7,
        region: { kind: 'path', points: [[0, -160], [0, -130]], width: 10 }
      }] });
      const count = 96;
      const profile = Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2, radius = 0.62;
        return plain(Math.cos(angle) * 88 * radius, -145 + Math.sin(angle) * 30 * radius).height;
      });
      drainageResiduals.push(...profile.map((height, index) => height
        - (profile[(index + 5) % count] + profile[(index + count - 5) % count]) / 2));

      // A requested 7m feather reaches zero 12m from the 10m-wide path centre.
      const outsideCut = plain(12, -145).height - carved(12, -145).height;
      expect(outsideCut).toBeLessThan(0.05);
      expect(sampleWorldSlope(carved, 0, -145)).toBeLessThan(0.75);

      const civicSlopes: number[] = [], shoreSlopes: number[] = [];
      for (let z = 10; z <= 150; z += 10) for (let x = -60; x <= 100; x += 10) {
        if (carved(x, z).height > 1) civicSlopes.push(sampleWorldSlope(carved, x, z));
      }
      for (let z = -220; z <= 220; z += 20) {
        let previous = carved(-250, z).height;
        for (let x = -248; x <= 80; x += 2) {
          const current = carved(x, z).height;
          if (previous <= 0 && current > 0) shoreSlopes.push(sampleWorldSlope(carved, x, z));
          previous = current;
        }
      }
      expect(percentile(civicSlopes, 0.95)).toBeLessThan(0.32);
      expect(percentile(shoreSlopes, 0.95)).toBeLessThan(0.9);
    }
    expect(mean(drainageResiduals.map(Math.abs))).toBeGreaterThan(0.35);
  });

  it('keeps authored compact mountain detail proportional beyond 500 metres', () => {
    const normalizedDetails: number[] = [];
    for (const size of [500, 1200, 2400]) {
      const center: [number, number] = [-size * 0.08, -size * 0.2];
      const radius: [number, number] = [size * 0.22, size * 0.18];
      const height = size * 0.12;
      const sample = createWorldSampler({
        version: 1, seed: 2309, size, reliefProfile: 'compact', heightScale: 0.04,
        constraints: [
          { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'mountains' },
          { region: 'south', biome: 'ocean' }
        ],
        landforms: [{ center, radius, height }]
      });
      const count = 144;
      const profiles = [0.48, 0.62, 0.76].map(distance => Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        return sample(center[0] + Math.cos(angle) * radius[0] * distance,
          center[1] + Math.sin(angle) * radius[1] * distance).height;
      }));
      const residuals = profiles.flatMap(profile => profile.map((value, index) => value
        - [-5,-4,-3,3,4,5].reduce((sum, offset) => sum + profile[(index + offset + count) % count], 0) / 6));
      residuals.sort((a, b) => Math.abs(a) - Math.abs(b));
      normalizedDetails.push(Math.abs(residuals[Math.floor(residuals.length / 2)]) / height);
    }
    expect(Math.min(...normalizedDetails) / Math.max(...normalizedDetails)).toBeGreaterThan(0.42);
  });

  it('carries coherent volcanic gullies from the upper slope into the apron', () => {
    const upperTroughs: number[] = [], upperDetails: number[] = [];
    for (const seed of [6103402, 99173]) {
      const recipe: WorldRecipe = {
        version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.035,
        constraints: [
          { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'mountains' },
          { region: 'south', biome: 'ocean' }
        ],
        landforms: [
          { center: [0,-90], radius: [110,120], height: 54 },
          { center: [0,-90], radius: [34,30], height: -15 }
        ]
      };
      const sample = createWorldSampler(recipe), count = 144, radius = 0.44;
      const profile = Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        return sample(Math.cos(angle) * 110 * radius, -90 + Math.sin(angle) * 120 * radius).height;
      });
      const residuals = profile.map((height, index) => height
        - [-6,-5,-4,4,5,6].reduce((sum, offset) => sum + profile[(index + offset + count) % count], 0) / 6);
      const ordered = [...residuals].sort((a, b) => a - b);
      const absolute = [...residuals].sort((a, b) => Math.abs(a) - Math.abs(b));
      upperTroughs.push(-ordered[Math.floor(count * 0.1)]);
      upperDetails.push(Math.abs(absolute[Math.floor(count * 0.5)]));

      const leveled = createWorldSampler({ ...recipe, terrainBrushes: [{
        id: 'mountain-road-pad', mode: 'flatten', region: { kind: 'circle', center: [66,-90], radius: 10 },
        height: 18, feather: 0
      }] });
      expect(leveled(66, -90).height).toBe(18);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(upperTroughs)).toBeGreaterThan(3.2);
    expect(mean(upperDetails)).toBeGreaterThan(1.4);
  });

  it('adds broad seeded bays to compact island coasts at multiple world sizes', () => {
    for (const size of [500, 1200, 2400]) {
      const sample = createWorldSampler({
        version: 1, seed: 42, size, reliefProfile: 'compact', heightScale: 0.05,
        constraints: [
          { region: 'west', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
          { region: 'north', biome: 'ocean' }, { region: 'south', biome: 'ocean' },
          { region: 'center', biome: 'grassland' }
        ],
        landforms: [{ center: [0, 0], radius: [size * 0.4, size * 0.4], height: size * 0.05 }]
      });
      const count = 144, coastRadii: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const angle = index / count * Math.PI * 2;
        let coastRadius = 0;
        for (let distance = 0; distance <= size / 2; distance += size / 250) {
          if (sample(Math.cos(angle) * distance, Math.sin(angle) * distance).height > 0) coastRadius = distance;
        }
        coastRadii.push(coastRadius);
      }
      const broadRadii = coastRadii.map((_, index) => {
        let total = 0;
        for (let offset = -8; offset <= 8; offset += 1) total += coastRadii[(index + offset + count) % count];
        return total / 17;
      });
      expect((Math.max(...broadRadii) - Math.min(...broadRadii)) / size).toBeGreaterThan(0.04);
      for (const [x, z] of [[-size / 2, 0], [size / 2, 0], [0, -size / 2], [0, size / 2]]) {
        expect(sample(x, z)).toMatchObject({ waterLevel: 0, waterBodyId: null });
        expect(sample(x, z).height).toBeLessThan(0);
      }
    }
  });

  it('keeps missing and explicit legacy relief profiles sample-identical', () => {
    const recipe: WorldRecipe = { version: 1, seed: 147, size: 500, constraints: [
      { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'mountains' }
    ], landforms: [{ center: [-55, -235], radius: [110, 70], height: 42 }] };
    const implicit = createWorldSampler(recipe), explicit = createWorldSampler({ ...recipe, reliefProfile: 'legacy' });
    for (const [x, z] of [[0, 0], [-55, -235], [-120, -180], [200, 200]]) {
      expect(implicit(x, z)).toEqual(explicit(x, z));
    }
  });
});

