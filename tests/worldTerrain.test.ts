import { describe, expect, it } from 'vitest';
import { createWorldSampler, createWorldTerrainContext, dominantBiome, parseWorldPrompt, sampleWorldSlope,
  sampleWorldTile, selectWorldTiles, validateWorldRecipe, worldFreshWaterDistance, WORLD_BIOMES,
  type WorldRecipe } from '../src/shared/worldTerrain';
import { waterBoundaryContainsPoint, waterBoundaryDistance } from '../src/shared/mapWater';

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

  it('blends finite water material through the carved lake bank', () => {
    const base = createWorldSampler(original), level = base(0, 0).height + 2;
    const sample = createWorldSampler({ ...original, reliefProfile: 'compact', waterBodies: [{
      id: 'lake-bank', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 },
      levels: [level], depth: 6, shorelineSmoothness: 0, shorelineIrregularity: 0
    }] });
    expect(sample(0, 0).weights.ocean).toBe(1);
    expect(sample(41, 0).weights.ocean).toBeGreaterThan(sample(55, 0).weights.ocean);
    expect(sample(55, 0).weights.ocean).toBeGreaterThan(sample(70, 0).weights.ocean);
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

  it('keeps missing and explicit legacy relief profiles sample-identical', () => {
    const recipe: WorldRecipe = { version: 1, seed: 147, size: 500, constraints: [
      { region: 'center', biome: 'grassland' }, { region: 'north', biome: 'mountains' }
    ], landforms: [{ center: [-55, -235], radius: [110, 70], height: 26 }] };
    const implicit = createWorldSampler(recipe), explicit = createWorldSampler({ ...recipe, reliefProfile: 'legacy' });
    for (const [x, z] of [[0, 0], [-55, -235], [-120, -180], [200, 200]]) {
      expect(implicit(x, z)).toEqual(explicit(x, z));
    }
  });
});

