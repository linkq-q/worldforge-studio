import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { buildMapCodePlannerSystemPrompt, executeMapCodePlan, generateMapCodeSuggestion } from '../src/server/mapCodePlanner';

describe('Scene Code API contracts', () => {
  it('preserves surface options in both object and named-object calls', () => {
    const form = { id: 'court', surface: 'paving', material: 'garden-stone',
      region: { kind: 'circle', center: [0, 0], radius: 5 }, intensity: 0.7, clearNatural: true };
    const map = createEmptyMap();
    const run = (call: string) => executeMapCodePlan(`function plan(api) { ${call}; }`, map, [],
      { scope: 'scene', promptMode: 'main', spatialPolicy: 'diagnose' }).operations;
    const { id, ...options } = form;
    expect(run(`api.surface('${id}', ${JSON.stringify(options)})`))
      .toEqual(run(`api.surface(${JSON.stringify(form)})`));
    expect(() => run(`api.surface('court', {surface:'not-a-surface',region:${JSON.stringify(form.region)}})`))
      .toThrow('invalid_map_code_surface');
    expect(() => run(`api.surface('other', ${JSON.stringify(form)})`)).toThrow('conflicting_map_code_surface_id');
  });

  it('resolves declared Chinese water IDs consistently across sampling, fields, bridges and waterPoint', () => {
    const map = createEmptyMap('water', 'water', [48, 16, 48]);
    const result = executeMapCodePlan(`function plan(api) {
      const id = api.water('溪流', {type:'river',points:[[-20,0],[20,0]],width:6,level:2,depth:1});
      const sample = api.environmentSample([0,0],{waterId:'溪流'});
      if (sample.water.id !== id || sample.water.surfaceHeight !== 2) throw new Error('wrong_water');
      const field = api.sampleProbabilityField({maxPoints:1,candidates:2,waterId:'溪流'}, p => {
        if (p.water.id !== id) throw new Error('wrong_field_water');
        return 1;
      });
      if (field.length !== 1) throw new Error('missing_field');
      const p = api.waterPoint('溪流',[0,0]);
      if (p[1] !== 2) throw new Error('wrong_water_point');
      api.bridge({waterId:'溪流',crossingCenter:[0,0],direction:[0,1],dimensions:[3,1,10]});
    }`, map, [], { spatialPolicy: 'diagnose' });
    const water = result.operations.find(operation => operation.type === 'water.add');
    expect(water?.type).toBe('water.add');
    expect(result.operations.some(operation => operation.type === 'object.add')).toBe(true);
    expect(() => applyMapOperations(map, result.operations)).not.toThrow();
  });

  it('uses declared aliases for water updates and removals, and preserves existing exact IDs', () => {
    const original = createEmptyMap('water', 'water', [48, 16, 48]);
    const map = applyMapOperations(original, [{type:'water.add',water:{id:'Old-Lake',name:'老湖',
      type:'lake',points:[[-5,-5],[5,-5],[5,5],[-5,5]],level:2,depth:1}}]);
    const result = executeMapCodePlan(`function plan(api) {
      api.environmentSample([0,0],{waterId:'Old-Lake'});
      api.bridge({waterId:'Old-Lake',crossingCenter:[0,0],direction:[0,1],dimensions:[3,1,12]});
      api.water('新湖', {type:'lake',points:[[8,8],[12,8],[12,12],[8,12]],level:2,depth:1});
      api.updateWater({waterId:'新湖',level:3});
      if (api.environmentSample([10,10],{waterId:'新湖'}).water.surfaceHeight !== 3) throw new Error('update_missed');
      api.removeWater('新湖');
    }`, map, [], { requestMode: 'refine', spatialPolicy: 'diagnose' });
    expect(result.diagnostics?.some(issue => issue.message.includes('不存在的水体'))).toBe(false);
    expect(applyMapOperations(map, result.operations).waterBodies.map(water => water.id)).toEqual(['Old-Lake']);
    expect(() => executeMapCodePlan(`function plan(api) {
      api.water('Old-Lake',{type:'river',points:[[-10,8],[10,8]],width:4});
    }`, map)).toThrow('ambiguous_map_code_water_id:Old-Lake');
  });

  it('rejects missing water references and normalized ID collisions instead of guessing', () => {
    const run = (tail: string) => executeMapCodePlan(`function plan(api) {
      api.water('Bay A',{type:'river',points:[[-10,0],[10,0]],width:4}); ${tail}
    }`, createEmptyMap());
    expect(() => run("api.environmentSample([0,0],{waterId:'Bay B'});")).toThrow('unknown_map_environment_water');
    expect(() => run("api.water('bay-a',{type:'river',points:[[-10,8],[10,8]],width:4});"))
      .toThrow('duplicate_water_id');
  });

  it('asks for focused asset descriptions and rejects empty descriptions before any paid call', async () => {
    for (const mode of ['main', 'minimal', 'standard'] as const) {
      expect(buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 16, 'scene', 'generate', '', [], mode))
        .toContain('Keep asset descriptions focused');
    }
    const fetchImpl = vi.fn();
    const createAsset = vi.fn();
    await expect(generateMapCodeSuggestion('a hall', createEmptyMap(), [], {
      scope:'scene',promptMode:'main',revisionMode:'first-pass',spatialPolicy:'diagnose',
      fetchImpl, createAsset,
      approvedCode:`function plan(api) { api.requireAsset({key:'hall',name:'大厅',role:'structure',prompt:'   '}); }`
    })).rejects.toThrow('invalid_map_code_asset_requirement');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('samples the same bounds for axis ranges and min/max objects and rejects malformed ranges', () => {
    const sample = (bounds: unknown) => executeMapCodePlan(`function plan(api) {
      const points = api.sampleProbabilityField({bounds:${JSON.stringify(bounds)},maxPoints:3,seed:7}, () => 1);
      for (const point of points) api.place({name:JSON.stringify(point),position:point});
    }`, createEmptyMap(), [], {scope:'scene',promptMode:'main',spatialPolicy:'diagnose'})
      .operations.flatMap(operation => operation.type === 'object.add' ? [operation.object.name] : []);
    const expected = sample({minX:-5,maxX:5,minZ:6,maxZ:9});
    expect(expected).toHaveLength(3);
    expect(sample({x:[-5,5],z:[6,9]})).toEqual(expected);
    expect(sample([[-5,6],[5,9]])).toEqual(expected);
    expect(() => sample({x:[-5],z:[6,9]})).toThrow('invalid_map_code_sampling_bounds');
    expect(() => sample({x:[-5,5],z:[6,9],minX:-4})).toThrow('invalid_map_code_sampling_bounds:mixed_forms');
    expect(() => sample({x:[5,-5],z:[6,9]})).toThrow('invalid_probability_field_bounds');
  });
});
