import { describe, expect, it } from 'vitest';
import { createEmptyMap, getMapBounds, type MapAsset } from '../src/shared/map';
import { createUrbanLayout, type UrbanLayoutOptions } from '../src/shared/mapUrbanLayout';
import { applyMapOperations } from '../src/shared/mapOperations';
import { buildMapCodePlannerSystemPrompt, executeMapCodePlan } from '../src/server/mapCodePlanner';

describe('urban layout in the active Scene Code workflow', () => {
  it.each(['main', 'standard'] as const)('compiles %s geometry through ordinary routes and placements', (promptMode) => {
    const map = createEmptyMap('city', 'city', [128, 32, 128]);
    const code = `function plan(api) {
      api.terrain('plain');
      const city = api.urbanLayout({id:'town',pattern:'grid',size:[100,100],blockSize:30,roadWidth:4,parcelWidth:7,parcelDepth:7});
      for (const road of city.roads) api.route({...road, surface:'paving', material:'asphalt'});
      for (const p of city.parcels) api.place({name:p.id,position:p.center,rotationY:p.rotationY,dimensions:[p.width,5,p.depth],role:'structure'});
    }`;
    const run = () => executeMapCodePlan(code, map, [], { scope:'scene',promptMode,spatialPolicy:'diagnose' });
    const first = run();
    const saved = applyMapOperations(map, first.operations);
    expect(saved.guides.length).toBeGreaterThan(4);
    expect(saved.objects.length).toBeGreaterThan(20);
    expect(saved.objects.map(o => o.transform)).toEqual(applyMapOperations(map, run().operations).objects.map(o => o.transform));
    expect(first.codePlan?.functions).toContain('urbanLayout');
    expect(first.operations.some(o => o.type === 'terrain.surface')).toBe(true);
  });

  it('replays organic main plans by map seed and fits real assets to the shared street-facing parcels', () => {
    const map = createEmptyMap('seeded organic city', 'seeded-organic-city', [128, 32, 128]);
    map.seed = 214781;
    const options: UrbanLayoutOptions = {
      id: 'old-town', pattern: 'organic', size: [106, 106], blockSize: 25,
      roadWidth: 3, arterialWidth: 5, parcelWidth: 7, parcelDepth: 8, setback: 1, irregularity: 0.8
    };
    const asset: MapAsset = {
      id: 'wide-house', name: 'House', prompt: 'Complete house with its front on Z+', tags: ['building'],
      modelJson: { format: 2, nodes: [{ id: 'body', transform: { pos: [0, 4.5, 0] },
        mesh: { type: 'box', params: { width: 12, height: 9, depth: 4 } } }] },
      colliderPlan: { version: 1, boxes: [{ min: [-6, 0, -2], max: [6, 9, 2] }],
        sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    const code = `function plan(api) {
      api.terrain('plain');
      const house = api.requireAsset({key:'house',name:'House',prompt:'Complete house, front Z+',dimensions:[7,6,7],role:'structure'});
      const city = api.urbanLayout(${JSON.stringify(options)});
      for (const road of city.roads) api.route({...road,surface:'paving',material:'brick-paver'});
      for (const parcel of city.parcels) api.place({assetId:api.asset(house),name:parcel.id,
        position:parcel.center,rotationY:parcel.rotationY,dimensions:[parcel.width,6,parcel.depth],role:'structure'});
    }`;
    const run = (seed: number) => {
      const base = { ...map, seed, assets: [asset] };
      const suggestion = executeMapCodePlan(code, base, [asset], { mode:'final',scope:'scene',promptMode:'main',
        legacyApis:false,spatialPolicy:'diagnose',assetBindings:new Map([['house', [asset]]]) });
      return { suggestion, saved: applyMapOperations(base, suggestion.operations) };
    };
    const first = run(map.seed), replay = run(map.seed), changed = run(map.seed + 1);
    const geometry = createUrbanLayout(options, getMapBounds(map), map.seed);
    expect(first.suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['urbanLayout', 'route', 'requireAsset', 'place']));
    expect(first.saved.guides).toEqual(replay.saved.guides);
    expect(first.saved.objects.map(object => object.transform)).toEqual(replay.saved.objects.map(object => object.transform));
    expect(first.saved.guides.map(guide => guide.points)).not.toEqual(changed.saved.guides.map(guide => guide.points));
    expect(first.saved.guides.map(({ id, points, width, closed }) => ({ id, points, width, closed })))
      .toEqual(geometry.roads.map(({ id, points, width, closed }) => ({ id, points, width, closed })));
    expect(first.saved.objects.length).toBeGreaterThan(20);
    expect(first.saved.objects).toHaveLength(geometry.parcels.length);
    for (const parcel of geometry.parcels) {
      const object = first.saved.objects.find(candidate => candidate.name === parcel.id)!;
      expect(object.assetId).toBe(asset.id);
      const transform = object.transform;
      expect(transform.position).toEqual([parcel.center[0], 0, parcel.center[1]]);
      expect(transform.rotation[1]).toBeCloseTo(parcel.rotationY);
      expect(transform.scale[0] * transform.size[0] * 12).toBeCloseTo(parcel.width);
      expect(transform.scale[1] * transform.size[1] * 9).toBeCloseTo(6);
      expect(transform.scale[2] * transform.size[2] * 4).toBeCloseTo(parcel.depth);
      const cos = Math.cos(transform.rotation[1]), sin = Math.sin(transform.rotation[1]);
      for (const localX of [-6, 6]) for (const localZ of [-2, 2]) {
        const x = localX * transform.scale[0] * transform.size[0];
        const z = localZ * transform.scale[2] * transform.size[2];
        const world = [transform.position[0] + x * cos + z * sin, transform.position[2] - x * sin + z * cos];
        expect(Math.min(...parcel.points.map(point => Math.hypot(point[0] - world[0], point[1] - world[1])))).toBeLessThan(1e-5);
      }
      expect(sin * (parcel.front[0] - parcel.center[0]) + cos * (parcel.front[1] - parcel.center[1])).toBeGreaterThan(0);
    }
  });
  it('returns geometry without silently painting, placing or saving it', () => {
    const result = executeMapCodePlan(`function plan(api) {
      api.urbanLayout({pattern:'radial'});
      api.terrain('plain');
    }`, createEmptyMap(), [], {scope:'scene',promptMode:'main'});
    expect(result.operations.some(o => ['guide.upsert','terrain.surface','object.add'].includes(o.type))).toBe(false);
  });

  it('documents semantic transfer and fit dimensions without changing minimal mode', () => {
    const prompt = (mode: 'main' | 'standard' | 'minimal') => buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 8, 'scene', 'generate', '', [], mode);
    for (const mode of ['main', 'standard'] as const) {
      expect(prompt(mode)).toContain('api.urbanLayout');
      expect(prompt(mode)).toContain('circuit');
      expect(prompt(mode)).toContain('parcel.width');
      expect(prompt(mode)).toContain('For settlements, city ruins or network-and-cell analogies');
      expect(prompt(mode)).toContain("'organic'");
      expect(prompt(mode)).toContain('inherited irregular fabric');
      expect(prompt(mode)).toContain('blockSize - roadWidth - 2*setback');
      expect(prompt(mode)).toContain('building footprint/usable land');
      expect(prompt(mode)).not.toContain("api.route({...road,surface:'paving',material:'cobblestone'})");
    }
    expect(prompt('minimal')).not.toContain('api.urbanLayout');
  });
});
