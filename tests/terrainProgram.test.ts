import { describe, expect, it } from 'vitest';
import { compileTerrainProgram } from '../src/server/terrainProgram';
import { createWorldSampler, validateWorldRecipe } from '../src/shared/worldTerrain';

const request = {seed: 47, size: 500, resolution: 65};
describe('terrain programs', () => {
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
