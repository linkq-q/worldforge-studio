import { describe, expect, it } from 'vitest';
import { compileTerrainProgram } from '../src/server/terrainProgram';
import { createWorldSampler, validateWorldRecipe } from '../src/shared/worldTerrain';
import { sampleTerrainProgramField, validateTerrainProgramField } from '../src/shared/terrainProgramField';

const request = {seed: 47, size: 500, resolution: 65};
describe('terrain programs', () => {
  it('replaces earlier noise where the fixed ridge profile wins and preserves explicitly added later detail', async () => {
    const points: Array<[number, number]> = [[-31.25, -15.625], [31.25, -15.625], [-31.25, 15.625], [31.25, 15.625]];
    const result = await compileTerrainProgram(`function generate(t) {
      const points = ${JSON.stringify(points)};
      const detail = (x,z) => 3 * t.noise(x+17,z+23,32,2);
      t.map((x,z) => 10 + detail(x,z));
      t.inspect('before-ridge', points);
      t.ridge([[0,-250,80,100],[0,250,80,100]], {base:5});
      t.inspect('after-ridge', points);
      t.map((x,z,h) => h + detail(x,z));
      t.inspect('after-detail', points);
    }`, request);
    const [before, ridge, detailed] = result.observations;
    const profile = 5 + 75 * (1 - 31.25 / 100) ** 1.6;
    expect(new Set(before.samples).size).toBeGreaterThan(1);
    expect(result.observations.map(report => report.terrainRevision)).toEqual([1, 2, 3]);
    const world = createWorldSampler({version:1, seed:47, size:500, reliefProfile:'compact',
      constraints:[{region:'center',biome:'mountains'}], terrainProgram:result});
    for (let index = 0; index < points.length; index++) {
      expect(ridge.samples[index]).toBeCloseTo(profile, 10);
      expect(detailed.samples[index]).toBeCloseTo(profile + before.samples[index] - 10, 10);
      expect(world(...points[index]).height).toBeCloseTo(detailed.samples[index], 10);
    }
  });

  it('retains inspection coordinates and actual terrain revisions with immutable report snapshots', async () => {
    const result = await compileTerrainProgram(`function generate(t) {
      const points = [[-100,0],[100,0]];
      const initial = t.inspect('same-label', points);
      points[0][0] = -200;
      initial.points[1][0] = 200; initial.samples[0] = 99;
      t.map((x,z)=> 50 + x / 10);
      t.inspect('same-label', [[-100,0],[100,0]]);
      t.map((x,z,h)=>h);
      t.erode({iterations:0});
      t.erode({iterations:1,thermal:0,drainage:0});
      t.inspect('no-change', [[0,0]]);
      t.erode({iterations:1,thermal:0,drainage:1});
      t.inspect('after-erosion', [[0,0]]);
      const exposed = t.result();
      exposed.heights[0] = 499;
      exposed.observations[0].points[0][0] = 250;
    }`, request);
    expect(result.terrainRevision).toBe(2);
    expect(result.observations.map(item => item.terrainRevision)).toEqual([0, 1, 1, 2]);
    expect(result.observations[0]).toMatchObject({ points: [[-100, 0], [100, 0]], samples: [0, 0] });
    expect(result.observations[1]).toMatchObject({ points: [[-100, 0], [100, 0]], samples: [40, 60] });
    expect(result.heights[0]).not.toBe(499);
  });

  it('preserves optional provenance during normalization and keeps legacy provenance unknown', async () => {
    const current = await compileTerrainProgram('function generate(t){t.map(()=>8);t.inspect("height",[[0,0]])}', request);
    const normalized = validateTerrainProgramField(current);
    current.observations[0].points![0][0] = 9;
    expect(normalized.observations[0].points).toEqual([[0, 0]]);
    expect(normalized.terrainRevision).toBe(1);
    const legacy = { version: 1 as const, source: 'old', resolution: 33, heights: Array(33 ** 2).fill(1),
      observations: [{ label: 'old', min: 1, max: 1, samples: [1] }] };
    expect(validateTerrainProgramField(legacy)).toEqual(legacy);
    expect(validateTerrainProgramField(legacy)).not.toHaveProperty('terrainRevision');
    for (const bad of [
      { ...normalized, terrainRevision: -1 }, { ...normalized, terrainRevision: 1.5 },
      { ...normalized, observations: [{ ...normalized.observations[0], terrainRevision: 2 }] },
      { ...normalized, observations: [{ ...normalized.observations[0], points: [] }] },
      { ...normalized, observations: [{ ...normalized.observations[0], points: [[NaN, 0]] }] }
    ]) expect(() => validateTerrainProgramField(bad as never)).toThrow('invalid_terrain_program_field');
  });

  it('reduces narrow ridge error with 513 samples while preserving legacy 257 fields exactly', async () => {
    const source = 'function generate(t){t.map((x,z)=>40+10*Math.exp(-(((x-0.9765625)/0.35)**2)))}';
    const coarse = await compileTerrainProgram(source, {...request, resolution: 257});
    const fine = await compileTerrainProgram(source, {...request, resolution: 513});
    expect(50 - sampleTerrainProgramField(coarse, 500, 0.9765625, 0)).toBeGreaterThan(9);
    expect(sampleTerrainProgramField(fine, 500, 0.9765625, 0)).toBeCloseTo(50, 8);
    for (const field of [coarse, fine]) {
      const saved = JSON.parse(JSON.stringify({version: 1, seed: 47, size: 500,
        constraints: [{region: 'center', biome: 'grassland'}], terrainProgram: field}));
      const loaded = validateWorldRecipe(saved);
      expect(loaded.terrainProgram).toEqual(field);
      expect(createWorldSampler(loaded)(0.9765625, 0).height)
        .toBeCloseTo(sampleTerrainProgramField(field, 500, 0.9765625, 0), 8);
    }
  });
  it('preserves the default sampling budget for existing programs', async () => {
    const field = await compileTerrainProgram('function generate(t){t.map(()=>t.spacing)}', {seed:47,size:500});
    expect(field.resolution).toBe(257);
    expect(field.heights[0]).toBe(1.953125);
  });
  it('accepts explicit sub-metre spacing and a rich field over the old output cap', async () => {
    const field = await compileTerrainProgram(`function generate(t){
      t.map((x,z)=>40+Math.sin(x*0.13)+Math.cos(z*0.17));
      t.inspect('spacing', [[0,0]]);
      if(t.spacing !== 0.9765625 || t.resolution !== 513) throw new Error('wrong_sampling_context');
    }`, {seed:47,size:500,resolution:513});
    expect(field.resolution).toBe(513);
    expect(field.heights).toHaveLength(263169);
    expect(Buffer.byteLength(JSON.stringify(field))).toBeGreaterThan(4000000);
  });
  it('rejects a requested resolution beyond the sample budget before executing code', async () => {
    await expect(compileTerrainProgram('function generate(){throw new Error("executed")}',
      {...request, resolution: 1025})).rejects.toThrow('terrain_program_resolution_out_of_budget');
    await expect(compileTerrainProgram('function generate(){}',
      {...request, resolution: 513.5})).rejects.toThrow('invalid_terrain_program_resolution');
    await expect(compileTerrainProgram('function generate(){}',
      {...request, resolution: null} as never).then(field => field.resolution))
      .rejects.toThrow('invalid_terrain_program_resolution');
  });
  it('runs custom numerical composition and persists the exact field through the shared sampler', async () => {
    const source = `function generate(t) {
      const plane = (x,z) => 40 + x * 0.04 - z * 0.02;
      t.map((x,z) => plane(x,z));
      t.inspect('plane');
    }`;
    const compiled = await compileTerrainProgram(source, request);
    const recipe = validateWorldRecipe({version: 1, seed: 47, size: 500,
      constraints: [{region: 'center', biome: 'grassland'}], terrainProgram: compiled});
    const sample = createWorldSampler(JSON.parse(JSON.stringify(recipe)));
    expect(sample(37, -23).height).toBeCloseTo(41.94, 5);
    expect(compiled.source).toBe(source);
    expect(compiled.observations[0].label).toBe('plane');
  });
  it('connects a ridge with a saddle and carves a downhill tributary joining the main valley', async () => {
    const result = await compileTerrainProgram(`function generate(t) {
      t.map(() => 25);
      t.ridge([[-150,0,90,85],[0,0,65,90],[150,0,110,85]]);
      t.channel([[0,-180,32,8],[0,0,20,14],[0,180,6,25]], {bankSlope:0.7});
      t.channel([[-140,-130,45,5],[-70,-60,33,8],[0,0,20,14]], {bankSlope:0.7});
      t.inspect('junction', [[0,0],[-70,-60]]);
    }`, request);
    const sample = createWorldSampler({version:1, seed:47,size:500,
      constraints:[{region:'center',biome:'mountains'}],terrainProgram:result});
    expect(sample(-80,0).height).toBeGreaterThan(40);
    expect(sample(80,0).height).toBeGreaterThan(40);
    expect(sample(0,180).height).toBeLessThan(sample(0,0).height);
    expect(sample(0,0).height).toBeLessThan(sample(-70,-60).height);
    expect(sample(0,0).height).toBeCloseTo(20, 4);
  });
  it('is deterministic, including noise and shared erosion', async () => {
    const code = `function generate(t) {
      t.map((x,z) => 60 + t.noise(x,z,80,3)*20 - z*0.1);
      t.erode({iterations:2, thermal:0.3, drainage:0.4, talus:35});
    }`;
    expect(await compileTerrainProgram(code, request)).toEqual(await compileTerrainProgram(code, request));
  });
  it('rejects invalid heights without silently repairing them', async () => {
    await expect(compileTerrainProgram('function generate(t){t.map(()=>NaN)}', request)).rejects.toThrow();
    await expect(compileTerrainProgram('function generate(t){t.map(()=>9000)}', request)).rejects.toThrow();
  });
  it('has no process/require or host function constructor and stops infinite execution', async () => {
    await expect(compileTerrainProgram('function generate(t){ process.exit(0); }', request)).rejects.toThrow();
    await expect(compileTerrainProgram('function generate(t){ t.map.constructor("return process")(); }', request)).rejects.toThrow();
    await expect(compileTerrainProgram('function generate(t){ while(true){} }', request, 100)).rejects.toThrow();
  });
  it('rejects malformed persisted fields instead of dropping them', () => {
    expect(() => validateWorldRecipe({version:1,seed:47,size:500,constraints:[{region:'center',biome:'grassland'}],
      terrainProgram:{version:1, source:'x',resolution:65,heights:[0],observations:[]}} as never)).toThrow();
  });
  it('does not expose binary allocations outside the worker heap budget or permit setup hoisting', async () => {
    await expect(compileTerrainProgram('function generate(t){new Uint8Array(160*1024*1024).fill(1);t.map(()=>1)}', request)).rejects.toThrow();
    await expect(compileTerrainProgram('function globalThis(){} function generate(t){new Uint8Array(160*1024*1024);}', request)).rejects.toThrow();
    await expect(compileTerrainProgram('function generate(t){new WebAssembly.Memory({initial:2560});}', request)).rejects.toThrow();
  });
});
