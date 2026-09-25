import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject, getMapObjectAabbs, getMapObjectVisualAabbs, sampleTerrainHeight, type MapAsset } from '../src/shared/map';
import {
  buildMapCodePlannerSystemPrompt,
  discoverMapCodeAssets,
  executeMapCodePlan,
  generateMapCodeSuggestion,
  replayGeneratedMapCode
} from '../src/server/mapCodePlanner';
import { applyMapOperations, type CodePlanAssetReadyPayload, type CodePlanPreviewPayload } from '../src/shared/mapOperations';
import { isPointInsideWaterBody } from '../src/shared/mapWater';
import {
  MAX_MAP_CODE_LENGTH,
  MAX_MAP_CODE_SCENE_OPERATIONS,
  MAX_MAP_GUIDE_POINTS,
  MAX_MAP_OPERATIONS
} from '../src/shared/mapLimits';

describe('map code planner', () => {
  it('lets AI sculpt, smooth and grade terrain through ordered map operations', () => {
    const map = createEmptyMap('village', 'village', [48, 12, 48]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('hills',{seed:42,amplitude:3});
      api.sculptTerrain({mode:'smooth',point:[0,0],radius:5,strength:0.8});
      api.rampTerrain({start:[-12,0],end:[12,0],width:4,startHeight:1,endHeight:3,softness:0.6});
    }`, map);
    expect(suggestion.operations.map((operation) => operation.type)).toEqual([
      'terrain.generate', 'terrain.brush', 'terrain.ramp'
    ]);
    expect(() => applyMapOperations(map, suggestion.operations)).not.toThrow();
  });

  it('uses the shared expanded engine limits', () => {
    expect(MAX_MAP_CODE_LENGTH).toBe(400_000);
    expect(MAX_MAP_CODE_SCENE_OPERATIONS).toBe(50_000);
    expect(MAX_MAP_CODE_SCENE_OPERATIONS).toBe(MAX_MAP_OPERATIONS);
    expect(MAX_MAP_GUIDE_POINTS).toBe(16_384);
  });

  it('accepts Scene Code near the expanded length limit', () => {
    const code = `function plan(api) { /*${'x'.repeat(MAX_MAP_CODE_LENGTH - 100)}*/ api.place({ position:[0,0] }); }`;
    const excessive = `function plan(api) { /*${'x'.repeat(MAX_MAP_CODE_LENGTH)}*/ api.place({ position:[0,0] }); }`;

    expect(executeMapCodePlan(code, createEmptyMap()).codePlan?.code).toBe(code);
    expect(() => executeMapCodePlan(excessive, createEmptyMap())).toThrow('invalid_map_code_plan');
  });

  it('accepts more than the legacy placement and scene-operation caps', () => {
    const map = createEmptyMap('expanded code plan', 'expanded-code-plan', [256, 20, 256]);
    expect(() => executeMapCodePlan(`function plan(api) {
      for (let index = 0; index < 2001; index += 1) api.place({ name:'marker', position:[0,0] });
      throw new Error('placement-limit-sentinel');
    }`, map)).toThrow('placement-limit-sentinel');
    const sceneOperations = executeMapCodePlan(`function plan(api) {
      for (let index = 0; index < 300; index += 1) {
        api.route({ id:'route-' + index, points:[[-10,index % 20 - 10],[10,index % 20 - 10]], surface:'none' });
      }
    }`, map, [], { spatialPolicy: 'diagnose' });

    expect(sceneOperations.operations.filter((operation) => operation.type === 'guide.upsert')).toHaveLength(300);
  });

  it('preserves route control points above the legacy planner limit', () => {
    const points = Array.from({ length: 128 }, (_, index): [number, number] => [
      -18 + index * 36 / 127,
      Math.sin(index / 8) * 5
    ]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({ id:'long-route', points:${JSON.stringify(points)}, surface:'none' });
    }`, createEmptyMap());
    const route = suggestion.operations.find((operation) => operation.type === 'guide.upsert');

    expect(route?.type === 'guide.upsert' ? route.guide.points : []).toHaveLength(128);
  });

  it('removes a leading model thinking block without rewriting the authored plan', () => {
    const code = `function plan(api) { api.place({name:'桌椅组',position:[0,0]}); }`;
    const suggestion = executeMapCodePlan(`<think>Planning a park...</think>\n${code}`, createEmptyMap());
    expect(suggestion.codePlan?.code).toBe(code);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type:'object.add', object:expect.objectContaining({name:'桌椅组'}) })
    ]));
  });

  it('wraps a bare top-level script and stores the normalized complete plan function', () => {
    const suggestion = executeMapCodePlan("api.place({name:'树',position:[0,0],role:'environment'});", createEmptyMap());

    expect(suggestion.codePlan?.code).toBe("function plan(api) {\napi.place({name:'树',position:[0,0],role:'environment'});\n}");
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ name: '树' }) })
    ]));
  });

  it('offers the outdoor first-pass planner the supported 12-API contract', () => {
    const prompt = buildMapCodePlannerSystemPrompt(
      createEmptyMap(), [], 1, 4, 'scene', 'generate', '', [], 'minimal'
    );

    expect(prompt).toContain('exactly these 12 WorldForge APIs');
    for (const name of ['terrain', 'modifyTerrain', 'sculptTerrain', 'rampTerrain', 'surface', 'water', 'route', 'grass', 'requireAsset', 'asset', 'place', 'random']) {
      expect(prompt).toContain(`api.${name}`);
    }
    expect(prompt).toContain("'plain'|'hills'|'valley'|'island'|'archipelago'|'canyon'|'cliff-plateau'|'dune-desert'");
    expect(prompt).toContain("Region objects use kind, never type");
    expect(prompt).toContain("surface:'paving', material:'concrete'");
    expect(prompt).toContain('[-21,20] means x=-21,z=20 and samples terrain Y');
    expect(prompt).toContain("terrain accepts only boolean true or false, never 'ground'");
    expect(prompt).toContain('Return only one complete synchronous JavaScript function: function plan(api) { ... }.');
    expect(prompt).not.toContain("'mountainous'");
    expect(prompt).not.toContain("'dunes'");
    expect(prompt).not.toContain("'islands'");
    expect(prompt).not.toContain('api.design');
    expect(prompt).not.toContain('api.bridge');
  });

  it('keeps standard prompts for indoor and refinement requests even when minimal is selected', () => {
    const indoor = createEmptyMap('room', 'room', [10, 3, 8], 'voxel', 'indoor');
    const indoorPrompt = buildMapCodePlannerSystemPrompt(indoor, [], 0, 2, 'scene', 'generate', '', [], 'minimal');
    const refinePrompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 2, 'scene', 'refine', '', [], 'minimal');

    expect(indoorPrompt).toContain('procedural indoor-scene planner');
    expect(refinePrompt).toContain('Outdoor Scene Code refinement');
    expect(indoorPrompt).not.toContain('exactly these 12 WorldForge APIs');
    expect(refinePrompt).not.toContain('exactly these 12 WorldForge APIs');
  });

  it('guides large outdoor scenes through shared dependencies and bounded fields without hard zoning', () => {
    const map = createEmptyMap('botanical garden', 'botanical-garden', [192, 24, 192]);
    const coupled = buildMapCodePlannerSystemPrompt(map, [], 0, 8, 'scene', 'generate', '', [], 'coupled');
    const standard = buildMapCodePlannerSystemPrompt(map, [], 0, 8, 'scene', 'generate', '', [], 'standard');

    expect(coupled).toContain('Shared generative relationships for a large scene');
    expect(coupled).toContain('api.sampleProbabilityField');
    expect(coupled).toContain('Call this after the terrain, water and routes it reads');
    expect(coupled).toContain('Hard edges and named regions are appropriate only where');
    expect(coupled).toContain('finite candidates, maxPoints and minDistance');
    expect(standard).not.toContain('Shared generative relationships for a large scene');
  });

  it('restricts minimal execution to the documented 12 APIs', () => {
    const allowed = executeMapCodePlan(
      "function plan(api) { api.place({name:'树',position:[api.random(-1,1),0],role:'environment'}); }",
      createEmptyMap(),
      [],
      { scope: 'scene', promptMode: 'minimal' }
    );
    expect(allowed.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    const terrain = executeMapCodePlan(
      "function plan(api) { api.sculptTerrain({mode:'smooth',point:[0,0]}); api.rampTerrain({start:[-5,0],end:[5,0],width:3}); }",
      createEmptyMap(), [], { scope: 'scene', promptMode: 'minimal' }
    );
    expect(terrain.operations.slice(0, 2).map((operation) => operation.type)).toEqual(['terrain.brush', 'terrain.ramp']);
    expect(() => executeMapCodePlan(
      "function plan(api) { api.renderSuggestion('not available'); }",
      createEmptyMap(),
      [],
      { scope: 'scene', promptMode: 'minimal' }
    )).toThrow('api.renderSuggestion is not a function');
  });

  it('reports lint findings without applying spatial repairs in diagnose mode', () => {
    const map = createEmptyMap('lake diagnostics', 'lake-diagnostics');
    map.waterBodies = [{
      id: 'lake-1', name: 'Lake', type: 'lake', level: 0.2, depth: 1.5, width: 1.2,
      points: [[-4, -4], [4, -4], [4, 4], [-4, 4]]
    }];
    map.terrain.heights.fill(1);
    const code = "function plan(api) { api.place({name:'树',position:[8,8],role:'environment'}); }";

    const repaired = executeMapCodePlan(code, map, [], { scope: 'scene', spatialPolicy: 'repair' });
    const byDefault = executeMapCodePlan(code, map, [], { scope: 'scene' });
    const diagnosed = executeMapCodePlan(code, map, [], { scope: 'scene', spatialPolicy: 'diagnose' });

    expect(repaired.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'water.update', waterId: 'lake-1' })
    ]));
    expect(diagnosed.operations.some((operation) => operation.type === 'water.update')).toBe(false);
    expect(byDefault.operations.some((operation) => operation.type === 'water.update')).toBe(false);
    expect(diagnosed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'water.exposed-terrain', repaired: false })
    ]));
  });

  it('fails first-pass code without invoking the LLM repair loop', async () => {
    const fetchImpl = vi.fn();

    await expect(generateMapCodeSuggestion('broken plan', createEmptyMap(), [], {
      approvedCode: 'throw new Error("broken");',
      revisionMode: 'first-pass',
      fetchImpl,
      scope: 'scene',
      minNewAssets: 0,
      maxNewAssets: 0
    })).rejects.toThrow('map_code_execution_failed:Error: broken');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recovers a model-written grass elevation band on a large map without an LLM call', async () => {
    const map = createEmptyMap('botanical garden', 'botanical-garden', [192, 24, 192]);
    const fetchImpl = vi.fn();
    const suggestion = await generateMapCodeSuggestion('生成大型植物园', map, [], {
      approvedCode: `function plan(api) {
        api.grass('alpine-north', {kind:'circle',center:[0,0],radius:48},
          {preset:'alpine-moss',density:0.62,variation:0.65,height:[0,0,0,0]});
        api.grass('lakeside', {kind:'circle',center:[30,0],radius:12},
          {preset:'wetland',density:0.6,height:[0,1,2,4]});
      }`,
      revisionMode: 'first-pass',
      fetchImpl,
      scope: 'scene',
      minNewAssets: 0,
      maxNewAssets: 0
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'grass.layer.add', layer: expect.objectContaining({ height: 0.42 }) }),
      expect.objectContaining({ type: 'grass.generate', layerId: 'alpine-north', habitat: undefined }),
      expect.objectContaining({ type: 'grass.generate', layerId: 'lakeside', habitat: { height: [0, 1, 2, 4] } })
    ]));
  });

  it('skips asset-aware LLM code adjustment while retaining final local replay in first-pass mode', async () => {
    const generated = {
      ...testAsset('generated-tree', 'Generated tree'),
      modelJson: {
        nodes: [],
        _meta: { semanticSnapshot: { v: 1, auto: true, text: 'G:tree trunk and canopy' } }
      }
    } satisfies MapAsset;
    const code = `function plan(api) {
      const tree=api.requireAsset({key:'tree',name:'树',prompt:'A tree',dimensions:[2,5,2],role:'environment'});
      api.place({assetId:api.asset(tree),name:'树',position:[0,0],role:'environment'});
    }`;
    const fetchImpl = vi.fn();

    const suggestion = await generateMapCodeSuggestion('one tree', createEmptyMap(), [], {
      approvedCode: code,
      revisionMode: 'first-pass',
      fetchImpl,
      scope: 'scene',
      minNewAssets: 0,
      maxNewAssets: 1,
      createAsset: vi.fn().mockResolvedValue(generated)
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(suggestion.codePlan?.code).toBe(code);
    expect(suggestion.generatedAssets).toEqual([{ id: generated.id, name: generated.name }]);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: generated.id }) })
    ]));
  });
  it('routes existing-host decoration through mount without changing the selected source', async () => {
    const host = testAsset('existing-host', 'Host');
    const mounted = testAsset('decorated-host', 'Decorated host');
    const createAsset = vi.fn().mockResolvedValue(mounted);
    const code = `function plan(api) {
      const decorated=api.requireAsset({key:'decorated',name:'装饰建筑',prompt:'Add a small awning over the entrance',mountOnAssetId:'existing-host',role:'structure'});
      api.place({assetId:api.asset(decorated),position:[10,0],role:'structure'});
    }`;
    const result = await generateMapCodeSuggestion('decorate', createEmptyMap(), [host], {
      approvedCode:code, reuseExistingAssets:true, reusableAssetIds:[host.id], minNewAssets:0,maxNewAssets:1, createAsset,
      fetchImpl:vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,content:code})))
    });
    expect(createAsset.mock.calls[0][0]).toMatchObject({mountOnAssetId:host.id});
    expect(result.generatedAssets).toHaveLength(1);
    expect(host.id).toBe('existing-host');
  });

  it('executes local object composition and reports blocked children without dropping them at the origin', () => {
    const host = testAsset('host', 'host');
    const prop = testAsset('prop', 'prop');
    const suggestion = executeMapCodePlan(`function plan(api) {
      const host=api.place({assetId:'host',position:[0,0]});
      api.placeRelative({parentId:host,assetId:'prop',name:'safe',localPosition:[0,0,5]});
      api.placeRelative({parentId:host,assetId:'prop',name:'blocked',localPosition:[0,0,0]});
    }`, createEmptyMap(), [host,prop]);
    const saved = applyMapOperations({...createEmptyMap(),assets:[host,prop]}, suggestion.operations);
    expect(saved.objects.find(object => object.name === 'safe')?.parentId).toBeTruthy();
    expect(saved.objects.some(object => object.name === 'blocked')).toBe(false);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'code.geometry-unresolved'})]));
  });

  it('lets authored bounded helpers reuse one 3D local-frame rule across placements', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      function tierPoint(index) {
        return api.localToWorld3D([index - 1, index * 2, 3], [10, 0, 5], [1, 0, 0]);
      }
      for (let index = 0; index < 3; index += 1) {
        api.place({name:'构件-' + index,position:tierPoint(index),dimensions:[1,1,1],role:'structure'});
      }
    }`, createEmptyMap());
    const positions = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object.transform?.position);
    expect(positions).toEqual([[13, 0, 6], [13, 2, 5], [13, 4, 4]]);
    expect(suggestion.codePlan?.functions).toContain('localToWorld3D');
  });

  it('rejects degenerate custom 3D frames', () => {
    expect(() => executeMapCodePlan(`function plan(api) {
      api.place({name:'无效构件',position:api.localToWorld3D([0,0,0],[0,0,0],[0,1,0],[0,2,0])});
    }`, createEmptyMap())).toThrow('invalid_map_code_frame');
  });

  it.each(['indoor', 'outdoor'] as const)('documents local object composition mechanics for %s without prescribing content', (sceneMode) => {
    const map = createEmptyMap('scene', 'activity', [24, 8, 24], 'voxel', sceneMode);
    const prompt = buildMapCodePlannerSystemPrompt(map, [], 0, 12, 'scene');
    expect(prompt).toContain('Object composition mechanics');
    if (sceneMode === 'indoor') {
      expect(prompt).toContain("evidence:'unavailable'");
      expect(prompt).toContain('keeps a separate child');
    } else {
      expect(prompt).not.toContain('api.assetSpace');
      expect(prompt).not.toContain('api.placeRelative');
    }
    expect(prompt).toContain('Only route-derived objects should set sourceGuideId');
    expect(prompt).toContain("Choose activity props, building variants, visible interiors and detail density from the user's request");
    expect(prompt).not.toContain('architecture, landmarks, creatures and functional objects at variants:1');
  });

  it('keeps viewpoint choice open without prescribing one camera or spatial archetype', () => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 12, 'scene');
    expect(prompt).toContain('Inspect the scene from the viewpoints that matter to the request');
    expect(prompt).not.toContain('45-degree oblique overview');
    expect(prompt).not.toContain('street-and-block fabric');
    expect(prompt).not.toContain('For an authored multi-group scene, name one primary focus');
  });

  it('reports a flat authored building skyline without rejecting or reshaping the scene', () => {
    const plan = (lastHeight: number) => executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'compact settlement'});
      api.design({experienceMode:'mixed',intent:'small settlement',groups:[
        {id:'houses',name:'住宅片区',intent:'street-facing cluster',spatialRole:'urban-fabric',
         region:{kind:'circle',x:0,z:0,radius:24},layers:[]}
      ],focuses:[],viewpoints:[],relations:[]});
      for (let i=0;i<4;i++) api.place({name:'住宅',position:[-12+i*8,0],size:[4,i===3?${lastHeight}:5,4],groupId:'houses',layer:1,role:'structure'});
    }`, createEmptyMap(), [], { scope:'scene' });
    const flat = plan(5);
    expect(flat.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:'scene.group-massing-flat', repaired:false })
    ]));
    expect(flat.diagnostics?.some((issue) => issue.code === 'scene.primary-focus-missing')).toBe(false);
    expect(flat.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(4);
    expect(plan(8).diagnostics?.some((issue) => issue.code === 'scene.group-massing-flat')).toBe(false);
  });

  it('persists render hints in the map transaction without clearing existing intent or the selected scheme', () => {
    const map = createEmptyMap();
    map.renderSchemeId = 'user-selected';
    map.renderPromptSuggestions = ['Keep the calm atmosphere'];
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.renderSuggestion('Make the activity area readable from the entrance');
      api.renderSuggestion('Make the activity area readable from the entrance');
    }`, map);
    const saved = applyMapOperations(map, suggestion.operations);
    expect(saved.renderPromptSuggestions).toEqual(['Keep the calm atmosphere', 'Make the activity area readable from the entrance']);
    expect(saved.renderSchemeId).toBe('user-selected');
    const unchanged = executeMapCodePlan(`function plan(api) { api.place({name:'marker',position:[0,0]}); }`, saved);
    expect(applyMapOperations(saved, unchanged.operations).renderPromptSuggestions).toEqual(saved.renderPromptSuggestions);
  });

  it('plans a terrain-following foundation and lifts linked buildings onto its top', () => {
    const map = createEmptyMap('Foundation', 'foundation-code', [24, 8, 24]);
    map.terrain.heights = map.terrain.heights.map((_, index) => (index % 9) * 0.08);
    const terrainBefore = [...map.terrain.heights];
    const suggestion = executeMapCodePlan(`function plan(api) {
      const house = api.place({ name: '住宅', position: [1, 2], dimensions: [6, 4, 4], role: 'structure' });
      api.foundation({ name: '住宅地基', shape: 'rounded-rectangle', under: [house], margin: 0.4, top: 'level', maxThickness: 4, material: 'stone' });
    }`, map);
    const additions = suggestion.operations.filter((operation) => operation.type === 'object.add');
    const foundation = additions.find((operation) => operation.object.foundation);
    const house = additions.find((operation) => operation.object.name === '住宅');

    expect(foundation?.object.foundation).toMatchObject({
      shape: 'rounded-rectangle', width: 6.8, depth: 4.8, linkedObjectIds: [house?.object.id]
    });
    expect(house?.object.heightMode).toBe('fixed');
    expect(house?.object.transform?.position?.[1]).toBeCloseTo(foundation?.object.transform?.position?.[1] ?? -1);
    expect(applyMapOperations(map, suggestion.operations).terrain.heights).toEqual(terrainBefore);
    expect(suggestion.codePlan?.functions).toContain('foundation');
  });

  it('sizes a new building foundation from its visual footprint on the modified terrain', () => {
    const asset: MapAsset = {
      ...testAsset('asset-wide-hall', '宽大厅'),
      modelJson: {
        format: 2,
        nodes: [{
          id: 'hall-body',
          transform: { pos: [0, 2, 0] },
          mesh: { type: 'box', params: { width: 10, height: 4, depth: 8 } }
        }]
      }
    };
    const map = createEmptyMap('Hill hall', 'hill-hall', [48, 12, 48]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.modifyTerrain({ modifier:'cliff', region:{kind:'circle',center:[0,0],radius:15}, amplitude:4, layout:'wall' });
      const hall = api.place({ assetId:'asset-wide-hall', name:'宽大厅', position:[0,0], role:'structure' });
      api.foundation({ under:[hall], margin:0.4, maxThickness:16 });
    }`, map, [asset]);
    const applied = applyMapOperations({ ...map, assets: [asset] }, suggestion.operations);
    const foundation = applied.objects.find((object) => object.foundation);
    const hall = applied.objects.find((object) => object.assetId === asset.id);

    expect(foundation?.foundation).toMatchObject({ width: 10.8, depth: 8.8 });
    expect(foundation?.transform.position[1]).toBeGreaterThan(sampleTerrainHeight(applied, 0, 0));
    expect(hall?.transform.position[1]).toBeCloseTo(foundation?.transform.position[1] ?? -1);
  });

  it('reports the effective terrain and water limits for a high dam plan', () => {
    const map = createEmptyMap('High dam', 'high-dam', [96, 16, 96]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain({modifier:'ridge',region:{kind:'path',points:[[-35,0],[35,0]],width:27},amplitude:49,access:'scenic'});
      api.water('reservoir',{type:'lake',points:[[-20,4],[20,4],[20,28],[-20,28]],level:22,depth:23});
    }`, map, [], { spatialPolicy: 'diagnose' });
    const applied = applyMapOperations(map, suggestion.operations);

    expect(applied.waterBodies[0]).toMatchObject({ level: 15.95, depth: 12 });
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'terrain.bounds-limited', message: expect.stringContaining('7.71'), repaired: false }),
      expect.objectContaining({ code: 'water.bounds-limited', message: expect.stringContaining('12'), repaired: false })
    ]));
  });

  it('lets explicit terrain placement ground a three-component outdoor position', () => {
    const map = createEmptyMap('Grounded', 'grounded-three-component', [24, 8, 24]);
    map.terrain.heights.fill(2.5);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({ name: '贴地厂房', position: [3, 0, 4], terrain: true, role: 'structure' });
      api.place({ name: '抬高平台', position: [-3, 1.25, 4], terrain: true, role: 'structure' });
      api.place({ name: '固定标记', position: [0, 0, -4], terrain: false, role: 'environment' });
    }`, map);
    const additions = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(additions[0].object.heightMode).toBe('terrain');
    expect(additions[0].object.transform?.position).toEqual([3, 2.5, 4]);
    expect(additions[1].object.heightMode).toBe('fixed');
    expect(additions[1].object.transform?.position).toEqual([-3, 3.75, 4]);
    expect(additions[2].object.heightMode).toBe('fixed');
    expect(additions[2].object.transform?.position).toEqual([0, 0, -4]);
  });

  it('rejects a string terrain mode before accepting a misplaced object', () => {
    const code = "function plan(api) { api.place({ name:'机库', position:[-34,24,0], terrain:'ground' }); }";

    expect(() => discoverMapCodeAssets(code, createEmptyMap(), [], 0)).toThrow('invalid_map_code_terrain_mode');
    expect(() => executeMapCodePlan(code, createEmptyMap())).toThrow('invalid_map_code_terrain_mode');
  });

  it('surfaces a fixed-Y object hidden below the final terrain', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({ name:'悬浮行星', position:[4,-18,3.8], role:'environment' });
    }`, createEmptyMap(), [], { spatialPolicy: 'diagnose' });

    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.buried', message: expect.stringContaining('悬浮行星'), repaired: false })
    ]));
  });

  it('skips foundations that exceed the bounded thickness and reports why', () => {
    const map = createEmptyMap('Steep', 'steep-foundation', [24, 12, 24]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.foundation({ name: '过厚地基', position: [0, 8, 0], width: 6, depth: 6, maxThickness: 1 });
      api.place({ name: '标记', position: [8, 0], dimensions: [1, 1, 1], role: 'structure' });
    }`, map);

    expect(suggestion.operations.some((operation) => operation.type === 'object.add' && operation.object.foundation)).toBe(false);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'foundation.max-thickness', repaired: false })
    ]));
  });

  it('places a foundation at a locked existing building bottom without moving the building', () => {
    const map = createEmptyMap('Existing building foundation', 'existing-foundation', [24, 8, 24]);
    const house = createMapObject('已有住宅');
    house.id = 'existing-house';
    house.locked = true;
    house.heightMode = 'fixed';
    house.transform.position = [0, 2, 0];
    map.objects.push(house);

    const suggestion = executeMapCodePlan(`function plan(api) {
      api.foundation({ name: '补加地基', under: ['existing-house'], width: 5, depth: 5, maxThickness: 4 });
    }`, map);
    const foundation = suggestion.operations.find((operation) => operation.type === 'object.add' && operation.object.foundation);

    expect(foundation?.type === 'object.add' ? foundation.object.transform?.position?.[1] : undefined).toBeCloseTo(2);
    expect(suggestion.operations.some((operation) => operation.type === 'object.update' && operation.objectId === house.id)).toBe(false);
  });

  it('reuses existing visual bounds across a batch of foundations', () => {
    const asset: MapAsset = {
      ...testAsset('asset-complex-foundation', '复杂厂房'),
      tags: [],
      modelJson: {
        format: 2,
        nodes: Array.from({ length: 120 }, (_, index) => ({
          id: `node-${index}`,
          transform: { pos: [index % 10, (index % 3) / 10, Math.floor(index / 10) % 10] },
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } }
        }))
      }
    };
    const map = createEmptyMap('Foundation batch', 'foundation-batch', [96, 16, 96]);
    map.assets = [asset];
    for (let index = 0; index < 96; index += 1) {
      const object = createMapObject(`厂房-${index}`, asset.id);
      object.id = `factory-${index}`;
      object.transform.position = [(index % 12) * 6 - 33, 0, Math.floor(index / 12) * 6 - 21];
      map.objects.push(object);
    }
    const targets = map.objects.slice(0, 26).map((object) => object.id);

    expect(() => executeMapCodePlan(`function plan(api) {
      const ids=${JSON.stringify(targets)};
      for (let index=0; index<ids.length; index++) {
        api.foundation({name:'基础-'+index,under:[ids[index]],margin:0.2,maxThickness:4});
      }
    }`, map, [asset], { scope:'scene', executionTimeoutMs:100 })).not.toThrow();
  });

  it('gives indoor maps one room-native Code Composer contract', () => {
    const map = createEmptyMap('Classroom', 'indoor-code-prompt', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const prompt = buildMapCodePlannerSystemPrompt(map, [], 3, 8, 'scene');

    expect(prompt).toContain("WorldForge Studio's procedural indoor-scene planner");
    expect(prompt).toContain('single author of the complete indoor layout');
    expect(prompt).toContain('api.roomPoint(localX,localZ,height?)');
    expect(prompt).toContain('api.wallFrame(wall,offset?,bottom?,inset?)');
    expect(prompt).toContain('api.ceilingPoint(localX,localZ,objectHeight?,drop?)');
    expect(prompt).toContain("api.opening({id,kind:'door'|'window'");
    expect(prompt).toContain("api.attach({assetId?,name?,parentId,kind:'supported'|'mounted'");
    expect(prompt).toContain("anchorY?:'bottom'|'center'|'top'");
    expect(prompt).toContain('Keep a continuous route at least 0.8 world units wide');
    expect(prompt).toContain('Do not generate a whole room, floor, ceiling, wall shell, terrain');
    expect(prompt).toContain("role:'functional'|'decor'");
    expect(prompt).not.toContain('Outdoor Scene Code refinement');
    expect(prompt).not.toContain('Road curve:');
    expect(prompt).not.toContain('Natural scatter:');
  });

  it('executes room-native placements and opening bindings in one transaction', () => {
    const map = createEmptyMap('Classroom', 'indoor-code-execution', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      const frame = api.wallFrame('north', 0, 1.1, 0.02);
      const door = api.opening({ id: 'door-main', kind: 'door', wall: 'south', offset: 3, width: 1.2, height: 2.1 });
      api.place({ name: 'desk', role: 'functional', position: api.roomPoint(0, 1, 0), dimensions: [1.2, 0.75, 0.6], facing: { direction: [0, -1] } });
      api.place({ name: 'board', role: 'functional', position: frame.point, dimensions: [3, 1.4, 0.12], facing: { direction: frame.inward } });
      api.place({ name: 'door', role: 'functional', roomOpeningId: door, dimensions: [1.2, 2.1, 0.12] });
      api.place({ name: 'light', role: 'decor', position: api.ceilingPoint(0, 0, 0.3, 0.1), dimensions: [0.8, 0.3, 0.8] });
    }`, map);
    const roomOperation = suggestion.operations.find((operation) => operation.type === 'room.set');
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(roomOperation?.type).toBe('room.set');
    if (roomOperation?.type !== 'room.set') throw new Error('missing room operation');
    expect(roomOperation.room.openings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'door-main', kind: 'door', wall: 'south' })
    ]));
    expect(placements).toHaveLength(4);
    expect(placements.every((operation) => operation.object.heightMode === 'fixed')).toBe(true);
    expect(placements[0].object.transform?.position).toEqual([0, 0, 1]);
    expect(placements[1].object.transform?.position?.[1]).toBeCloseTo(1.1);
    expect(placements[2].object.roomOpeningId).toBe('door-main');
    expect(placements[3].object.transform?.position?.[1]).toBeCloseTo(3.44);
    const applied = applyMapOperations(map, suggestion.operations);
    const appliedDoor = applied.objects.find((object) => object.roomOpeningId === 'door-main');
    expect(appliedDoor?.transform.position[2]).toBeGreaterThan(4);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining([
      'ceilingPoint', 'opening', 'place', 'roomPoint', 'wallFrame'
    ]));
  });

  it('compiles indoor attachments against earlier placement references', () => {
    const map = createEmptyMap('Cafe', 'indoor-code-attachments', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const counter: MapAsset = {
      ...testAsset('asset-counter', '柜台'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'counter', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 1, depth: 1 } } }]
      }
    };
    const register: MapAsset = {
      ...testAsset('asset-register', '收银机'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'register', transform: { pos: [0, 0.2, 0] }, mesh: { type: 'box', params: { width: 0.4, height: 0.4, depth: 0.35 } } }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      const counterRef = api.place({ assetId: 'asset-counter', name: '柜台', position: api.roomPoint(0, 0), dimensions: [2, 1, 1], role: 'functional' });
      api.attach({ assetId: 'asset-register', name: '收银机', parentId: counterRef, kind: 'supported', offset: [0, 0], role: 'functional' });
    }`, map, [counter, register]);
    const objects = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(objects).toHaveLength(2);
    expect(objects[0].object.transform?.size).toEqual([2, 1, 1]);
    expect(objects[0].object.transform?.scale).toEqual([0.5, 1, 1]);
    expect(objects[1].object.parentId).toBe(objects[0].object.id);
    expect(objects[1].object.transform?.position?.[1]).toBeGreaterThan(0.9);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['attach', 'place', 'roomPoint']));
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'object.invalid-support')).toBe(false);
  });

  it('mounts an outdoor entrance onto its authored structure instead of leaving it in world space', () => {
    const arena: MapAsset = {
      ...testAsset('asset-arena', '竞技场主体'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'arena', transform: { pos: [0, 3, 0] }, mesh: { type: 'box', params: { width: 10, height: 6, depth: 8 } } }]
      }
    };
    const gate: MapAsset = {
      ...testAsset('asset-gate', '竞技场门'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'gate', transform: { pos: [0, 1.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 3, depth: 0.4 } } }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      const arena = api.place({ assetId:'asset-arena', name:'竞技场主体', position:[0,0], dimensions:[10,6,8], role:'structure' });
      api.attach({ assetId:'asset-gate', name:'竞技场门', parentId:arena, kind:'mounted', side:'south', offset:[0,14], contact:0.12, role:'structure' });
    }`, createEmptyMap(), [arena, gate]);
    const objects = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(objects).toHaveLength(2);
    expect(objects[1].object.parentId).toBe(objects[0].object.id);
    expect(objects[1].object.heightMode).toBe('fixed');
    expect(objects[1].object.locked).toBe(true);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'object.invalid-support')).toBe(false);
    const applied = applyMapOperations(createEmptyMap(), suggestion.operations);
    const gateBounds = getMapObjectAabbs({ ...applied, assets: [arena, gate] })
      .find((box) => box.objectId === objects[1].object.id);
    expect(gateBounds?.min[1]).toBeCloseTo(0);
    expect(gateBounds?.max[1]).toBeCloseTo(3);
  });

  it('keeps a living-room group inside the user-owned room without outdoor operations', () => {
    const map = createEmptyMap('Living room', 'indoor-code-living-room', [10, 4, 8], 'voxel', 'indoor', [10, 4, 8]);
    const originalSize = [...map.room!.size];
    const suggestion = executeMapCodePlan(`function plan(api) {
      const door = api.opening({ id: 'living-door', kind: 'door', wall: 'south', offset: 0, width: 1.2, height: 2.1 });
      api.place({ name: '客厅门', roomOpeningId: door, dimensions: [1.2, 2.1, 0.12], role: 'functional' });
      api.place({ name: '沙发', position: api.roomPoint(-2.2, -0.4), facing: { target: [0, -0.4] }, dimensions: [2.4, 0.9, 0.9], role: 'functional' });
      api.place({ name: '茶几', position: api.roomPoint(0, -0.4), dimensions: [1.2, 0.45, 0.7], role: 'functional' });
      const frame = api.wallFrame('north', 0, 0.45);
      api.place({ name: '电视', position: frame.point, facing: { direction: frame.inward }, dimensions: [1.8, 1.05, 0.12], role: 'functional' });
      api.place({ name: '落地灯', position: api.roomPoint(3.6, -2.6), dimensions: [0.45, 1.7, 0.45], role: 'decor' });
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);

    expect(applied.room?.size).toEqual(originalSize);
    expect(applied.room?.openings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'living-door' })]));
    expect(applied.objects).toHaveLength(5);
    expect(applied.objects.every((object) => object.heightMode === 'fixed')).toBe(true);
    expect(suggestion.operations.some((operation) => (
      operation.type.startsWith('terrain.') || operation.type.startsWith('water.') || operation.type.startsWith('grass.')
    ))).toBe(false);
    expect(applied.objects.every((object) => Math.abs(object.transform.position[0]) < 5 && Math.abs(object.transform.position[2]) < 4.1)).toBe(true);
  });

  it('rejects room-shell ownership and outdoor operations from indoor programs', () => {
    const map = createEmptyMap('Room', 'indoor-code-boundaries', [10, 4, 8], 'voxel', 'indoor', [10, 4, 8]);

    expect(() => discoverMapCodeAssets(`function plan(api) {
      const shell = api.requireAsset({ key: 'shell', name: '整间房', prompt: 'Complete room shell', role: 'functional' });
      api.place({ assetId: api.asset(shell), position: api.roomPoint(0, 0), role: 'functional' });
    }`, map, [], 1)).toThrow('indoor_map_code_forbidden_content');
    expect(() => executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.place({ name: '桌子', position: api.roomPoint(0, 0), role: 'functional' });
    }`, map)).toThrow('indoor_map_code_outdoor_operation');
  });

  it('gives the model a complete mechanical contract without scene recipes', () => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 2, 4);

    expect(prompt).toContain('Return only one synchronous JavaScript function: function plan(api) { ... }.');
    expect(prompt).toContain('Y-up 3D placement API with horizontal planning in x/z');
    expect(prompt).not.toContain('This is a 2D environment layout API');
    expect(prompt).toContain('asset orientation remains yaw-only');
    expect(prompt).toContain('Every generated point supports both point[0]/point[1] and point.x/point.z.');
    expect(prompt).not.toContain('sampleBezierFrames(...) -> frame objects with point,tangent,normal');
    expect(prompt).not.toContain('sampleBezierFramesBySpacing(...,spacing,gapRatio?)');
    expect(prompt).toContain('api.placeBetween({assetId?,name?,start:[x,z],end:[x,z]');
    expect(prompt).toContain('frontTarget?:[x,z]');
    expect(prompt).not.toContain('api.attach');
    expect(() => executeMapCodePlan(
      'function plan(api) { api.attach({}); }', createEmptyMap(), [], { scope: 'scene', legacyApis: false }
    )).toThrow('api.attach is not a function');
    expect(prompt).not.toContain("api.mirrorPoint(point,'x'|'z',coordinate?)");
    expect(prompt).not.toContain('api.localToWorld3D(local:[right,up,forward]');
    expect(prompt).toContain('named APIs are conveniences, not a closed vocabulary');
    expect(prompt).not.toContain('api.keepDry([x,z],clearance?)');
    expect(prompt).not.toContain('api.waterPoint');
    expect(prompt).toContain('waterId?:string');
    expect(prompt).not.toContain('api.routeNetwork');
    expect(prompt).not.toContain('api.distance2D');
    expect(prompt).toContain('clearNatural:true');
    expect(prompt).not.toContain('api.ellipsePoint(index,count,radiusX,radiusZ');
    expect(prompt).toContain('mix?:{short?,tall?,flowers?}');
    expect(prompt).toContain('api.poissonDisk({bounds?');
    expect(prompt).not.toContain('api.gridPoints({center?');
    expect(prompt).toContain('api.subdividePathBySpan');
    expect(prompt).not.toContain('api.offsetPolygon');
    expect(prompt).not.toContain('api.insetPolygon');
    expect(prompt).not.toContain('api.gridInsideRegion');
    expect(prompt).not.toContain('footprint -> offset/inset depth layers -> massing tiers/stories');
    expect(prompt).toContain('## Generative architecture compression');
    expect(prompt).toContain('function placeTier(outline, elevation, spec)');
    expect(prompt).toContain('function transformFootprint(localPoints, origin, yaw, scale)');
    expect(prompt).toContain('dependency graph, not a required order of reasoning');
    expect(prompt).toContain('not a scene recipe, minimum layer count or requirement to decompose every building');
    for (const name of ['bezierPoint', 'circlePoint', 'tangentYaw', 'faceYaw', 'waterPoint']) {
      expect(prompt).not.toContain(`api.${name}`);
      expect(() => executeMapCodePlan(`function plan(api) { api.${name}(); }`, createEmptyMap(), [], {
        scope: 'scene', legacyApis: false
      })).toThrow(`api.${name} is not a function`);
    }
    expect(prompt).toContain('facing may be a direction [dx,dz]');
    expect(prompt).not.toContain('api.design');
    expect(prompt).not.toContain('Two-tier arena shell with a ground gateway');
    expect(prompt).not.toContain('generateChineseArena');
    expect(prompt).toContain('Declare between 2 and 4 distinct requireAsset families; variants within one family count as one asset');
    expect(prompt).toContain('Give each new asset plausible canonical dimensions so the greybox has its intended size');
    expect(prompt).toContain('short Simplified Chinese UI text');
    expect(prompt).not.toContain("const tree = api.requireAsset({key:'tree'");
    expect(prompt).not.toContain('## Correct patterns');
    expect(prompt).toContain('No undefined point, invalid array index, direct array arithmetic');
  });

  it('derives bounded architectural bays, depth outlines and an interior grid from simple geometry', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      const footprint=[[-4,-4],[4,-4],[4,4],[-4,4]];
      const perimeter=api.offsetPolygon({points:footprint,distance:2});
      const courtyard=api.insetPolygon({points:footprint,distance:1});
      const bays=api.subdividePathBySpan({points:perimeter,span:4,closed:true,fit:'stretch'});
      const columns=api.gridInsideRegion({region:{kind:'polygon',points:courtyard},spacing:2,inset:0.4});
      for (const bay of bays) api.placeBetween({name:'墙段',start:bay.start,end:bay.end,dimensions:[4,3,0.5],spanAxis:'x',groupId:'hall',assemblyId:'hall-shell',layer:1});
      for (const point of columns) api.place({name:'柱',position:point,dimensions:[0.4,3,0.4],groupId:'hall',assemblyId:'hall-shell',layer:1});
    }`, createEmptyMap());
    const additions = suggestion.operations.filter((operation) => operation.type === 'object.add');
    expect(additions.filter((operation) => operation.object.name === '墙段')).toHaveLength(12);
    expect(additions.filter((operation) => operation.object.name === '柱').length).toBeGreaterThan(0);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining([
      'gridInsideRegion', 'insetPolygon', 'offsetPolygon', 'subdividePathBySpan'
    ]));
  });

  it('reuses one authored tier rule across changing architectural outlines', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      const base=[[-9,-6],[9,-6],[9,6],[-9,6]];
      const tiers=[
        {inset:0,elevation:0,height:3},
        {inset:1.5,elevation:3,height:2.5}
      ];
      function placeTier(outline,tier,tierIndex) {
        const bays=api.subdividePathBySpan({points:outline,span:3,closed:true,fit:'stretch'});
        for (const bay of bays) {
          const entranceVoid=tierIndex===0 && bay.center[1] < -5 && Math.abs(bay.center[0]) < 2;
          if (entranceVoid) continue;
          api.placeBetween({name:'通用开间',start:bay.start,end:bay.end,
            dimensions:[3,tier.height,0.8],spanAxis:'x',elevation:tier.elevation,
            groupId:'hall',assemblyId:'hall-shell',layer:1});
        }
      }
      let outline=base;
      for (let index=0;index<tiers.length;index+=1) {
        if (tiers[index].inset > 0) outline=api.insetPolygon({points:outline,distance:tiers[index].inset});
        placeTier(outline,tiers[index],index);
      }
    }`, map);
    const objects = applyMapOperations(map, suggestion.operations).objects
      .filter((object) => object.assemblyId === 'hall-shell');
    const lower = objects.filter((object) => object.transform.position[1] < 1);
    const upper = objects.filter((object) => object.transform.position[1] > 2);
    const horizontalExtent = (items: typeof objects) => Math.max(...items.map((object) => Math.max(
      Math.abs(object.transform.position[0]), Math.abs(object.transform.position[2])
    )));

    expect(lower.length).toBeGreaterThan(4);
    expect(upper.length).toBeGreaterThan(4);
    expect(horizontalExtent(upper)).toBeLessThan(horizontalExtent(lower));
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining([
      'insetPolygon', 'placeBetween', 'subdividePathBySpan'
    ]));
  });

  it('offers spatial tools without prescribing a district pattern', () => {
    const prompt = buildMapCodePlannerSystemPrompt(
      createEmptyMap('Town', 'town-capability-prompt', [96, 16, 96]),
      [],
      2,
      8,
      'scene',
      'generate',
      '生成一座紧凑、可游玩的中世纪小镇'
    );

    expect(prompt).not.toContain('api.design');
    expect(prompt).not.toContain('api.streetGrid');
    expect(prompt).toContain('api.placeAlongRoute({routeId');
    expect(prompt).not.toContain('api.placeStreetFrontage');
    expect(prompt).not.toContain('api.sightline');
    expect(prompt).not.toContain('api.passage');
    expect(prompt).not.toContain('api.connectionGap({a:placementReferenceOrExistingObjectId');
    expect(prompt).toContain('returns the route ID string, not an object');
    for (const name of ['routeNetwork', 'passage', 'sightline', 'distance2D']) {
      expect(() => executeMapCodePlan(`function plan(api) { api.${name}(); }`, createEmptyMap(), [], {
        scope: 'scene', legacyApis: false
      })).toThrow(`api.${name} is not a function`);
    }
    expect(prompt).not.toContain('ordinary building fabric');
    expect(prompt).not.toContain('## Callable capability manifest');
    expect(prompt).not.toContain('## Scene pattern guide');
  });

  it.each(['日式街道', '日本城市街景', 'Japanese urban street'])(
    'keeps specialized APIs out of default guidance for %s without keyword routing', (task) => {
      const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 24, 'scene', 'generate', task);
      expect(prompt).not.toMatch(/api\.(streetGrid|placeStreetFrontage|grassField)\b/);
      expect(prompt).not.toContain('## Active scene profile:');
      expect(prompt).toContain('api.placeAlongRoute');
    }
  );

  it('does not force urban building districts into a wilderness prompt', () => {
    const prompt = buildMapCodePlannerSystemPrompt(
      createEmptyMap(), [], 0, 4, 'scene', 'generate', '生成一片无人居住的原始森林'
    );

    expect(prompt).not.toContain('## Active scene profile:');
    expect(prompt).toContain("Let the user's request determine landform, ecology, architectural language");
    expect(prompt).not.toContain('Structural anchors are mandatory');
  });

  it('gives unified outdoor Code complete scene ownership without design declarations', () => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 6, 'scene');

    expect(prompt).toContain('Unified scene ownership');
    expect(prompt).toContain("api.sceneIntent({kind:'natural'|'authored'");
    expect(prompt).not.toContain('api.design');
    expect(() => executeMapCodePlan(
      'function plan(api) { api.design({}); }', createEmptyMap(), [], { scope: 'scene', legacyApis: false }
    )).toThrow('api.design is not a function');
    expect(prompt).toContain('For scenes with multiple functional areas');
    expect(prompt).toContain('one purposeful repeat family');
    expect(prompt).toContain('Perimeter fences, edge vegetation and scattered rocks do not satisfy core-area density');
    expect(prompt).toContain('Asset-family count is not object count');
    expect(prompt).toContain('api.sampleProbabilityField');
    expect(prompt).not.toContain('api.grassField');
    expect(prompt).toContain('api.environmentSample');
    expect(prompt).toContain('guideDistance and signed regionDistance');
    expect(prompt).toContain('marks?:[{id,minDistance?,maxPoints?,cluster?}]');
    expect(prompt).toContain('Cross-mark spacing uses the global minDistance');
    expect(prompt).not.toContain('api.optimizeLayout');
    expect(prompt).toContain('canonical module spans');
    expect(prompt).toContain('elevation?:number');
    expect(prompt).toContain('api.bridge({waterId');
    expect(prompt).toContain('api.terrain');
    expect(prompt).toContain('api.modifyTerrain');
    expect(prompt).toContain("preset:'plain' always writes a zero-height field");
    expect(prompt).toContain('turns otherwise non-positive surrounding terrain into a sloped submerged seabed');
    expect(prompt).toContain("layout:'coast' deterministically varies the shoreline");
    expect(prompt).toContain('api.surface only paints existing terrain and cannot create land, water or a shoreline');
    expect(prompt).toContain('an explicit ocean is authoritative');
    expect(prompt).toContain('declare one const landRegion={...} and reuse that exact region');
    expect(prompt).toContain('use a rectangular boundary only when the intended landform is rectangular');
    expect(prompt).toContain('api.water');
    expect(prompt).toContain('api.grass');
    expect(prompt).toContain("api.modifyTerrain({modifier:'mountain'|'ridge'|'valley'|'basin'");
    expect(prompt).toContain("api.surface({id:'short-id',surface:'grass'|'sand'|'rock'|'soil'|'paving'");
    expect(prompt).toContain("api.grass({id:'short-id',name?,preset:'meadow'|'sand'|'wetland'");
    expect(prompt).toContain('Enum fields are closed choices, not descriptions.');
    expect(prompt).toContain("role:'structure'|'environment'");
    expect(prompt).not.toContain('## Correct patterns');
    expect(prompt).not.toContain('## Scene pattern guide');
    expect(prompt).not.toContain('Activity-led near-field composition');
    expect(prompt.length).toBeLessThan(30_000);
  });

  it('warns when a multi-family authored scene omits functional groups or group-level reuse', () => {
    const assets = Array.from({ length: 6 }, (_, index) => ({
      ...testAsset(`asset-core-${index}`, `Core ${index}`), tags: []
    }));
    const ungrouped = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'multi-area campus'});
      for (let index=0; index<6; index++) {
        api.place({assetId:'asset-core-'+index,name:'设施-'+index,position:[index*4-10,index%2?6:-6],role:'structure'});
      }
    }`, createEmptyMap(), assets, { scope:'scene' });
    expect(ungrouped.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:'scene.program-incomplete', message:expect.stringContaining('功能分组') })
    ]));

    const grouped = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'operations yard'});
      api.design({experienceMode:'immediate',intent:'operations yard',groups:[{
        id:'yard',name:'作业区',spatialRole:'urban-fabric',region:{kind:'circle',x:0,z:0,radius:9},layers:[]
      }],focuses:[],viewpoints:[],relations:[]});
      for (let index=0; index<4; index++) {
        api.place({assetId:'asset-core-'+index,name:'设备-'+index,position:[index*3-5,index%2?3:-3],groupId:'yard',layer:2,role:'environment'});
      }
    }`, createEmptyMap(), assets, { scope:'scene' });
    expect(grouped.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:'scene.program-incomplete', message:expect.stringContaining('重复族') })
    ]));
  });

  it('passes the optional user focal preference in the same Code request', async () => {
    const code = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'library'});
      api.design({experienceMode:'immediate',intent:'主楼突出',groups:[],focuses:[],viewpoints:[],relations:[]});
      api.place({name:'图书馆',position:[0,0],role:'structure'});
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));

    await generateMapCodeSuggestion('生成大学校园', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      scope: 'scene', minNewAssets: 0, maxNewAssets: 0, focusPrompt: '图书馆主楼'
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.find((message) => message.role === 'user')?.content).toContain('图书馆主楼');
  });

  it('does not inject an Atlantis-specific city recipe', () => {
    const prompt = buildMapCodePlannerSystemPrompt(
      createEmptyMap('亚特兰蒂斯', 'atlantis-profile', [96, 16, 96]),
      [], 0, 16, 'scene', 'generate', '亚特兰蒂斯'
    );

    expect(prompt).not.toContain('## Active scene profile:');
    expect(prompt).not.toContain('ordinary building fabric');
    expect(prompt).not.toContain('Atlantis');
    expect(prompt).toContain('Use spatial contracts where calculation helps');
  });

  it('bounds the refine asset catalog while keeping map-referenced assets', async () => {
    const map = createEmptyMap('Refine catalog', 'refine-catalog');
    const used: MapAsset = {
      ...testAsset('used-asset', '已用资产'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'gate', transform: { pos: [0, 2, 0] }, mesh: { type: 'box', params: { width: 6, height: 4, depth: 1 } } }],
        _meta: {
          semanticSnapshot: {
            v: 1,
            auto: true,
            text: '三开间园门 · 世界坐标(Y上Z前)\n# 阅读说明: 重复说明不应进入场景提示词\nG:gate 主入口 @p(0,0,0)'
          }
        }
      }
    };
    const placed = createMapObject('已用资产', used.id);
    placed.id = 'existing-object';
    placed.transform.position = [3, 0, -4];
    placed.transform.rotation = [0, Math.PI / 2, 0];
    placed.transform.scale = [1.2, 1, 0.8];
    placed.transform.size = [6, 4, 1];
    map.objects.push(placed);
    const unrelated = Array.from({ length: 100 }, (_, index) => (
      testAsset(`unrelated-${index}`, `无关资产${index}`)
    ));
    const code = `function plan(api) {
      api.move({ objectId: 'existing-object', position: [1, 0] });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));

    await generateMapCodeSuggestion('调整已用资产位置', map, [used, ...unrelated], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', scope: 'scene', minNewAssets: 0, maxNewAssets: 0
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('used-asset');
    expect(system).toContain('三开间园门');
    expect(system).toContain('G:gate 主入口');
    expect(system).toContain('localBounds=min[-3,0,-0.5],max[3,4,0.5],size[6,4,1]');
    expect(system).toContain('"scale":[1.2,1,0.8]');
    expect(system).toContain('"size":[6,4,1]');
    expect(system).not.toContain('重复说明不应进入场景提示词');
    expect(system).not.toContain('unrelated-99');
    expect((system.match(/- [^\n]+; tags=/g) ?? []).length).toBeLessThanOrEqual(64);
  });

  it('samples refinement objects across the whole map and includes the persisted spatial contract', () => {
    const map = createEmptyMap('Large scene', 'large-refine-context', [96,16,96]);
    for (let index=0; index<315; index+=1) {
      const object=createMapObject(`对象-${index}`);
      object.id=`object-${index}`;
      object.designGroupId=index<200?'old-district':'new-district';
      object.compositionLayer=index%4+1 as 1|2|3|4;
      map.objects.push(object);
    }
    map.designSemantics = {
      ...map.designSemantics,
      groups:[{
        id:'new-district',name:'新街区',intent:'沿路线补齐建筑界面',spatialRole:'urban-fabric',
        region:{kind:'polygon',points:[[-20,-20],[20,-20],[20,20],[-20,20]]},
        focusIds:[],guideIds:[],entryGuideIds:[],exitGuideIds:[],axisGuideIds:[],protectedObjectIds:[],removableObjectIds:[],layers:[]
      }]
    };

    const prompt=buildMapCodePlannerSystemPrompt(map,[],0,8,'scene','refine');
    expect(prompt).not.toContain('api.design');
    expect(prompt).toContain('do not repair unrelated density, layer or composition findings');
    expect(prompt).toContain('"totalObjects":315');
    expect(prompt).toContain('object-314');
    expect(prompt).toContain('Representative existing objects sampled across the whole map');
  });

  it('merges refinement design declarations instead of replacing prior groups and assemblies', () => {
    const base = createEmptyMap('Design merge','design-merge');
    const initial = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'two districts'});
      api.design({groups:[{id:'old',name:'旧城区',intent:'保留',spatialRole:'urban-fabric',layers:[]}],
        assemblies:[{id:'old-hall',groupId:'old',intent:'旧厅堂',topology:'group'}],focuses:[],viewpoints:[],relations:[]});
      api.place({name:'旧建筑',position:[-10,0],groupId:'old',layer:1,role:'structure'});
    }`, base, [], {scope:'scene'});
    const map = applyMapOperations(base, initial.operations);
    const refinement = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'new',name:'新城区',intent:'新增',spatialRole:'urban-fabric',layers:[]}],
        assemblies:[{id:'new-hall',groupId:'new',intent:'新厅堂',topology:'group'}]});
      api.place({name:'新建筑',position:[10,0],groupId:'new',layer:1,role:'structure'});
    }`, map, [], {scope:'scene',requestMode:'refine'});
    const saved = applyMapOperations(map, refinement.operations);

    expect(saved.designSemantics.groups.map((group) => group.id)).toEqual(['old','new']);
    expect(saved.designSemantics.assemblies.map((assembly) => assembly.id)).toEqual(['old-hall','new-hall']);
    expect(saved.objects.map((object) => object.name)).toEqual(expect.arrayContaining(['旧建筑','新建筑']));
  });

  it('lets the model adapt layout once after reading generated asset snapshots and real bounds', async () => {
    const initial = `function plan(api) {
      const gate = api.requireAsset({
        key:'gate', name:'园门', prompt:'中式园门', tags:['gate'], variants:1,
        dimensions:[6,4,1], role:'structure'
      });
      api.place({ assetId:api.asset(gate), name:'园门', position:[0,0], dimensions:[6,4,1], role:'structure' });
    }`;
    const adapted = initial.replace('position:[0,0]', 'position:[5,0]');
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response(JSON.stringify({ edits: [{ old: 'position:[0,0]', new: 'position:[5,0]' }] })));
    const createAsset = vi.fn(async (): Promise<MapAsset> => ({
      ...testAsset('asset-gate', '园门'),
      tags: ['gate'],
      modelJson: {
        format: 2,
        nodes: [{ id: 'gate', transform: { pos: [0, 2.5, 0] }, mesh: { type: 'box', params: { width: 8, height: 5, depth: 2 } } }],
        _meta: {
          semanticSnapshot: {
            v: 1,
            auto: true,
            text: '八米宽重檐园门\n# 阅读说明: omit me\nG:gate 主入口，正面朝Z+'
          }
        }
      }
    }));

    const suggestion = await generateMapCodeSuggestion('生成园林入口', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 1, maxNewAssets: 1, createAsset
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const adaptationRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const adaptationPrompt = adaptationRequest.messages.at(-1)?.content ?? '';
    expect(adaptationPrompt).toContain('八米宽重檐园门');
    expect(adaptationPrompt).toContain('G:gate 主入口，正面朝Z+');
    expect(adaptationPrompt).toContain('localBounds');
    expect(adaptationPrompt).toContain('"size":[8,5,2]');
    expect(adaptationPrompt).toContain('never return the full function');
    expect(adaptationPrompt).not.toContain('omit me');
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({
          assetId: 'asset-gate',
          transform: expect.objectContaining({ position: [5, 0, 0] })
        })
      })
    ]));
  });

  it('rejects an adaptation whose attachment only fails after real asset binding', async () => {
    const initial = `function plan(api) {
      const host = api.requireAsset({key:'host',name:'展台',prompt:'展台',variants:1,role:'structure'});
      const prop = api.requireAsset({key:'prop',name:'摆件',prompt:'摆件',variants:1,role:'environment'});
      const hostRef = api.place({assetId:api.asset(host),name:'展台',position:[-10,0],role:'structure'});
      api.place({assetId:api.asset(prop),name:'摆件',position:[20,0],role:'environment'});
    }`;
    const invalid = JSON.stringify({ edits: [{
      old: "api.place({assetId:api.asset(prop),name:'摆件',position:[20,0],role:'environment'});",
      new: "api.attach({assetId:api.asset(prop),name:'摆件',parentId:hostRef,kind:'supported',offset:[100,0],role:'environment'});"
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(invalid));
    const progress: string[] = [];
    const suggestion = await generateMapCodeSuggestion('展台与独立摆件', createEmptyMap(), [], {
      fetchImpl, minNewAssets: 0, maxNewAssets: 2,
      createAsset: async (request) => ({
        ...testAsset(`asset-${request.name}`, request.name), tags: [],
        modelJson: { _meta: { semanticSnapshot: { text: '模型结构已生成' } } }
      }),
      onProgress: (event) => progress.push(event.label)
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.codePlan?.code).toBe(initial);
    const result = applyMapOperations(createEmptyMap(), suggestion.operations);
    expect(result.objects.find((object) => object.name === '摆件')?.transform.position).toEqual([20, 0, 0]);
    expect(result.objects.every((object) => !object.parentId)).toBe(true);
    expect(progress).toContain('新资产布局调整未通过校验，继续使用原布局');
  });

  it('rejects a local asset adaptation that removes an existing placement', async () => {
    const original = `function plan(api) {
      const tree = api.requireAsset({key:'tree',name:'树',prompt:'树',variants:1,role:'environment'});
      api.place({assetId:api.asset(tree),name:'入口树',position:[-8,0],role:'environment'});
      api.place({assetId:api.asset(tree),name:'远景树',position:[8,0],role:'environment'});
    }`;
    const removal = JSON.stringify({ edits: [{
      old: "api.place({assetId:api.asset(tree),name:'远景树',position:[8,0],role:'environment'});",
      new: ''
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response(removal));
    const suggestion = await generateMapCodeSuggestion('有两棵树的入口', createEmptyMap(), [], {
      fetchImpl, minNewAssets: 0, maxNewAssets: 1,
      createAsset: async () => ({
        ...testAsset('asset-tree', '树'),
        modelJson: { _meta: { semanticSnapshot: { text: '树冠和树干' } } }
      })
    });

    expect(suggestion.codePlan?.code).toBe(original);
    const result = applyMapOperations(createEmptyMap(), suggestion.operations);
    expect(result.objects.map((object) => object.name)).toEqual(expect.arrayContaining(['入口树', '远景树']));
  });

  it('keeps the original layout when asset adaptation returns no edits', async () => {
    const original = `function plan(api) {
      const tree = api.requireAsset({key:'tree',name:'树',prompt:'树',variants:1,role:'environment'});
      api.place({assetId:api.asset(tree),name:'入口树',position:[-8,0],role:'environment'});
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(original))
      .mockResolvedValueOnce(response(JSON.stringify({ edits: [] })));
    const progress: string[] = [];
    const suggestion = await generateMapCodeSuggestion('一棵树的入口', createEmptyMap(), [], {
      fetchImpl, minNewAssets: 0, maxNewAssets: 1,
      createAsset: async () => ({
        ...testAsset('asset-tree', '树'),
        modelJson: { _meta: { semanticSnapshot: { text: '树冠和树干' } } }
      }),
      onProgress: (event) => progress.push(event.label)
    });

    expect(suggestion.codePlan?.code).toBe(original);
    expect(progress).not.toContain('新资产布局调整未通过校验，继续使用原布局');
  });

  it('accepts an asset adaptation that preserves an existing recoverable issue without adding a new one', async () => {
    const initial = `function plan(api) {
      const gate=api.requireAsset({key:'gate',name:'园门',prompt:'Standalone garden gate',role:'structure'});
      api.place({assetId:api.asset(gate),name:'园门',position:[0,0],role:'structure'});
      api.placeAlongRoute({routeId:'missing-route',name:'路灯',spacing:4});
    }`;
    const adapted = initial.replace('position:[0,0]', 'position:[6,0]');
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response(JSON.stringify({ edits: [{ old: 'position:[0,0]', new: 'position:[6,0]' }] })));
    const progress: string[] = [];

    const suggestion = await generateMapCodeSuggestion('生成园门和沿路灯具', createEmptyMap(), [], {
      fetchImpl, minNewAssets: 0, maxNewAssets: 1,
      createAsset: async (request) => ({
        ...testAsset('asset-gate', request.name),
        modelJson: { _meta: { semanticSnapshot: { text: '完整园门模型' } } }
      }),
      onProgress: (event) => progress.push(event.label)
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(suggestion.codePlan?.code).toBe(adapted);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({ transform: expect.objectContaining({ position: [6, 0, 0] }) })
      })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'code.route-unresolved', repaired: false })
    ]));
    expect(progress).not.toContain('新资产布局调整未通过校验，继续使用原布局');
  });

  it('accepts structured terrain forms and normalizes common semantic enum labels', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain({
        modifier: 'gentle central basin',
        region: { kind: 'circle', x: 2, z: 4, radius: 24 },
        amplitude: -1.4,
        softness: 0.8,
        variation: 0.2,
        seed: api.seed
      });
      api.surface({
        id: 'garden-ground',
        surface: 'packed earth',
        region: { kind: 'polygon', points: [[-42,-42],[42,-42],[42,40],[-42,40]] },
        intensity: 0.65
      });
      api.surface({
        id: 'concrete-ground',
        surface: 'concrete',
        material: 'concrete',
        region: { kind: 'circle', center: [0,0], radius: 6 }
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.modify', modifier: 'basin' }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'soil', intensity: 0.65 }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'paving', material: 'concrete' })
    ]));

    const legacySuggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain('gentle central basin', {kind:'circle',x:2,z:4,radius:24}, {amplitude:-1.4});
      api.surface('garden-ground', 'packed earth', {kind:'polygon',points:[[-42,-42],[42,-42],[42,40],[-42,40]]}, 0.65);
    }`, createEmptyMap());
    expect(legacySuggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.modify', modifier: 'basin' }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'soil' })
    ]));
  });

  it('coerces an incompatible surface material locally instead of failing the scene', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.surface({
        id:'plaza', surface:'rock', material:'garden-stone',
        region:{kind:'polygon',points:[[-8,-4],[8,-4],[8,4],[-8,4]]}
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.surface', surface: 'paving', material: 'garden-stone' })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'terrain.surface-material-repaired', repaired: true })
    ]));
  });

  it('normalizes duplicate singleton declarations instead of failing the whole scene', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'natural',reason:'first'});
      api.sceneIntent({kind:'authored',reason:'last'});
      api.design({experienceMode:'free',intent:'first',groups:[],focuses:[],viewpoints:[],relations:[]});
      api.design({experienceMode:'sequential',intent:'last',groups:[],focuses:[],viewpoints:[],relations:[]});
      api.terrain('plain');
      api.terrain('hills');
      api.place({name:'主建筑',position:[0,0],role:'structure'});
    }`, createEmptyMap());

    expect(suggestion.codePlan?.sceneIntent).toBe('authored');
    expect(suggestion.operations.filter((operation) => operation.type === 'terrain.generate')).toHaveLength(1);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'code.declaration-normalized' })
    ]));
  });

  it('infers missing scene intent and invalid asset role metadata without an execution retry', async () => {
    const code = `function plan(api) {
      const tree=api.requireAsset({key:'tree',name:'松树',prompt:'Standalone pine tree',role:'prop'});
      api.place({assetId:api.asset(tree),name:'松树',position:[0,0],role:'prop'});
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('生成一棵松树', createEmptyMap(), [], {
      fetchImpl, scope: 'scene', discoveryOnly: true, minNewAssets: 0, maxNewAssets: 1
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.codePlan?.sceneIntent).toBe('natural');
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'asset.role-inferred', repaired: true }),
      expect.objectContaining({ code: 'code.declaration-normalized', repaired: true })
    ]));
  });

  it('reports which terrain region field is missing instead of exposing undefined', () => {
    expect(() => executeMapCodePlan(`function plan(api) {
      api.modifyTerrain({ modifier: 'basin', region: { kind: 'circle', radius: 4 } });
    }`, createEmptyMap())).toThrow('invalid_map_code_terrain_region:center');
  });

  it('compiles semantic terrain option shapes into strict map operations', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain({
        modifier: 'terrace',
        region: { kind: 'circle', center: [0, 0], radius: 20 },
        amplitude: -2,
        layout: 'stepped garden terraces',
        access: { mode: 'walkable path' },
        direction: [1, 0],
        layers: [{ height: 0.5 }, { height: 1 }, { height: 1.5 }]
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'terrain.modify',
        modifier: 'terrace',
        amplitude: 2,
        layout: 'terraces',
        access: 'walkable',
        direction: 0,
        layers: 3
      })
    ]));
  });

  it('compiles semantic terrain presets and outlined grass regions without an AI repair', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'natural', reason: '池畔自然湿地' });
      api.terrain('rolling', { amplitude: 2 });
      api.grass('池畔湿地', {
        outline: [[-10, -6], [10, -6], [12, 4], [0, 9], [-12, 4]]
      }, {
        preset: 'shore wetland reeds',
        density: 0.55
      });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const suggestion = await generateMapCodeSuggestion('一片起伏地形中的池畔湿地', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate', preset: 'hills' }),
      expect.objectContaining({
        type: 'grass.layer.add',
        layer: expect.objectContaining({ preset: 'wetland' })
      }),
      expect.objectContaining({
        type: 'grass.generate',
        region: {
          kind: 'polygon',
          points: [[-10, -6], [10, -6], [12, 4], [0, 9], [-12, 4]]
        },
        density: 0.55
      })
    ]));
  });

  it('respects authored grass height, density and variation instead of forcing a blanket carpet', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'精修园林' });
      api.grass({
        id:'garden-grass', preset:'meadow',
        region:{kind:'circle',center:[0,0],radius:18},
        density:0.3, variation:0.8, height:0.25,
        habitat:{waterDistance:[0,1,3,6]},
        mix:{short:0.55,tall:0.4,flowers:0.05}
      });
    }`, createEmptyMap());
    const layer = suggestion.operations.find((operation) => operation.type === 'grass.layer.add');
    const generated = suggestion.operations.find((operation) => operation.type === 'grass.generate');

    expect(layer).toEqual(expect.objectContaining({
      type: 'grass.layer.add',
      layer: expect.objectContaining({
        height: 0.25,
        mix: { short: 0.55, tall: 0.4, flowers: 0.05 }
      })
    }));
    expect(generated).toEqual(expect.objectContaining({
      density: 0.3, variation: 0.8,
      habitat: { waterDistance: [0, 1, 3, 6] }
    }));
  });

  it('allows AI-declared natural scenes to compose terrain without inventing architecture', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'natural', reason: 'An untouched wetland has no authored construction' });
      api.terrain('valley', { amplitude: 2, roughness: 0.25 });
      api.water('marsh-water', { type: 'lake', points: [[-8,-4],[8,-4],[8,4],[-8,4]], level: -0.3 });
      api.grass('reeds', { kind: 'circle', center: [0,0], radius: 12 }, { preset: 'meadow', density: 0.45 });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('一片无人修建的天然湿地', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(suggestion.codePlan?.sceneIntent).toBe('natural');
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(false);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' }),
      expect.objectContaining({ type: 'water.add' }),
      expect.objectContaining({ type: 'grass.layer.add' })
    ]));
  });

  it('reports an authored garden with no structural anchor without inventing one', async () => {
    const gate = { ...testAsset('moon-gate', '月洞门'), tags: ['garden', 'gate'] };
    const incomplete = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: '中式园林是人工营造的文化空间' });
      api.terrain('plain');
    }`;
    const repaired = JSON.stringify({ edits: [{
      old: "api.terrain('plain');",
      new: "api.terrain('plain');\n      api.place({ assetId: 'moon-gate', name: '月洞门', role: 'structure', position: [0,0], facing: { direction: [0,1] } });"
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(incomplete))
      .mockResolvedValueOnce(response(repaired));

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [gate], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      reuseExistingAssets: true, reusableAssetIds: [gate.id],
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.codePlan?.sceneIntent).toBe('authored');
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(false);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('reports promised layer gaps without auto-filling intentional clear space', async () => {
    const incomplete = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'人工园林' });
      api.design({
        experienceMode:'sequential', intent:'入口后展开水院',
        groups:[{
          id:'entry', name:'入口院', intent:'门内转折后进入园林',
          region:{kind:'polygon',points:[[-12,-40],[12,-40],[12,-14],[-12,-14]]},
          layers:[
            {level:1,intent:'园门和两侧建筑共同围合前院',density:'tight',minCount:2},
            {level:3,intent:'门侧竹石和坐凳',density:'tight'}
          ]
        }], focuses:[], viewpoints:[], relations:[]
      });
      api.surface({
        id:'entry-court', surface:'paving', clearNatural:true,
        region:{kind:'polygon',points:[[-9,-40],[9,-40],[9,-18],[-9,-18]]}
      });
      api.place({ name:'园门', position:[0,-38], role:'structure', groupId:'entry', layer:1 });
    }`;
    const existingGate = "api.place({ name:'园门', position:[0,-38], role:'structure', groupId:'entry', layer:1 });";
    const repaired = JSON.stringify({ edits: [
      {
        old: "{level:3,intent:'门侧竹石和坐凳',density:'tight'}",
        new: "{level:2,intent:'两侧坐凳形成停留点',density:'normal'},\n            {level:3,intent:'门侧竹石和坐凳',density:'tight'}"
      },
      {
        old: existingGate,
        new: `${existingGate}\n      api.place({ name:'入口厢房', position:[-8,-26], role:'structure', groupId:'entry', layer:1 });\n      api.place({ name:'石桌凳', position:[-7,-27], role:'environment', groupId:'entry', layer:2 });\n      api.place({ name:'竹石组景', position:[7,-25], role:'environment', groupId:'entry', layer:3 });`
      }
    ] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(incomplete))
      .mockResolvedValueOnce(response(repaired));

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });
    const applied = applyMapOperations(createEmptyMap(), suggestion.operations);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.codePlan?.code).toContain("region:{kind:'polygon',points:[[-9,-40],[9,-40],[9,-18],[-9,-18]]}");
    expect(applied.objects.filter((object) => object.designGroupId === 'entry')).toEqual([
      expect.objectContaining({ name: '园门', compositionLayer: 1 })
    ]);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('reports sparse settlement metrics without requesting a full code rewrite', async () => {
    const incomplete = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'紧凑小镇' });
      for (let i = -18; i <= 18; i += 12) {
        api.route({id:'town-x-'+i,points:[[-24,i],[24,i]],width:3,surface:'paving',tags:['street','settlement']});
        api.route({id:'town-z-'+i,points:[[i,-24],[i,24]],width:3,surface:'paving',tags:['street','settlement']});
      }
      api.place({ name:'镇门', position:[0,-22], size:[8,5,3], role:'structure' });
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(incomplete));

    const suggestion = await generateMapCodeSuggestion('生成紧凑且有生活感的小镇', createEmptyMap('Town', 'town', [72, 12, 72]), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'settlement.building-coverage-low', repaired: false }),
      expect.objectContaining({ code: 'settlement.frontage-low', repaired: false })
    ]));
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
  });

  it('reports an underused built group without injecting footprint or frontage content', async () => {
    const sparse = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'roadside district'});
      api.design({groups:[{id:'district',name:'街区',spatialRole:'urban-fabric',
        region:{kind:'polygon',points:[[-20,-20],[20,-20],[20,20],[-20,20]]},
        layers:[{level:1,intent:'沿街建筑',density:'tight'}]}],focuses:[],viewpoints:[],relations:[]});
      api.route({id:'main-road',points:[[-18,0],[18,0]],groupId:'district',guideRole:'axis',width:3});
      api.place({name:'孤立店屋',position:[0,8],size:[4,5,4],role:'structure',groupId:'district',layer:1});
    }`;
    const repaired = JSON.stringify({edits:[{
      old:"api.place({name:'孤立店屋',position:[0,8],size:[4,5,4],role:'structure',groupId:'district',layer:1});",
      new:"for(let i=0;i<10;i++) api.place({name:'沿街店屋',position:[-18+i*4,i%2?7:-7],size:[3.5,5+(i%3),5],role:'structure',groupId:'district',layer:1});"
    }]});
    const response = (content: string) => new Response(JSON.stringify({ok:true,content}), {
      status:200,headers:{'Content-Type':'application/json'}
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(sparse)).mockResolvedValueOnce(response(repaired));

    const suggestion = await generateMapCodeSuggestion('生成道路两侧紧凑的建筑街区', createEmptyMap('District','district',[64,12,64]), [], {
      legacyApis: true,
      apiBase:'https://example.test',provider:'gpt',fetchImpl,minNewAssets:0,maxNewAssets:0,scope:'scene'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(1);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('reports an isolated authored landmark without inventing an assembly', async () => {
    const incomplete = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'仪式入口'});
      api.design({groups:[{id:'entry',name:'入口',spatialRole:'landmark-ensemble',
        region:{kind:'polygon',points:[[-10,-16],[10,-16],[10,-6],[-10,-6]]},layers:[]}],
        focuses:[],viewpoints:[],relations:[]});
      api.surface({id:'entry-court',surface:'paving',clearNatural:true,
        region:{kind:'polygon',points:[[-10,-16],[10,-16],[10,-6],[-10,-6]]}});
      api.place({name:'主门',position:[0,-8],role:'structure',groupId:'entry',layer:1});
      api.place({name:'左柱',position:[-8,-8],role:'structure',groupId:'entry',layer:1});
      api.place({name:'右柱',position:[8,-8],role:'structure',groupId:'entry',layer:1});
    }`;
    const repaired = JSON.stringify({ edits: [
      { old: 'focuses:[],viewpoints:[],relations:[]', new: "assemblies:[{id:'entry-shell',groupId:'entry',intent:'连续门廊',topology:'path'}],focuses:[],viewpoints:[],relations:[]" },
      { old: "api.place({name:'右柱',position:[8,-8],role:'structure',groupId:'entry',layer:1});",
        new: `api.place({name:'右柱',position:[8,-8],role:'structure',groupId:'entry',layer:1});
      for(let i=0;i<3;i++) api.placeBetween({name:'门廊墙段',start:[-6+i*4,-12],end:[-2+i*4,-12],
        dimensions:[4,3,1],spanAxis:'x',groupId:'entry',assemblyId:'entry-shell',layer:1});` }
    ] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response(repaired));
    const map = createEmptyMap('Entry');
    const suggestion = await generateMapCodeSuggestion('生成有连续门廊的仪式入口', map, [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true
    });
    const applied = applyMapOperations(map, suggestion.operations);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(applied.designSemantics.assemblies).toEqual([]);
    expect(applied.objects).toHaveLength(3);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('does not treat assembly labels on three isolated objects as a connected building', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'built entrance'});
      api.design({groups:[{id:'entry',name:'入口',spatialRole:'landmark-ensemble',layers:[]}],
        assemblies:[{id:'shell',groupId:'entry',topology:'path'}]});
      for(let i=0;i<3;i++) api.place({name:'独立塔',position:[i*12,0],
        role:'structure',groupId:'entry',assemblyId:'shell',layer:1});
    }`, createEmptyMap('Entry'), [], { scope: 'scene' });

    expect(suggestion.blocked).not.toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', message: expect.stringContaining('连续拼接') })
    ]));
  });

  it('reports named districts with missing regions without redesigning the city', async () => {
    const sparse = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'失落海洋城市'});
      api.design({experienceMode:'sequential',intent:'神殿和港口',groups:[
        {id:'citadel',name:'圣城',intent:'神殿与大街',layers:[{level:1,intent:'神殿',density:'tight'}]},
        {id:'harbor',name:'港口',intent:'港亭',layers:[{level:1,intent:'港亭',density:'tight'}]}
      ],focuses:[],viewpoints:[],relations:[]});
      api.route({id:'avenue',points:[[0,-25],[0,25]],width:5});
      api.place({name:'海神殿',position:[0,20],size:[10,10,8],role:'structure',groupId:'citadel',layer:1});
      api.place({name:'港亭',position:[25,0],size:[6,7,6],role:'structure',groupId:'harbor',layer:1});
      for (let i=0;i<12;i++) api.place({name:'水晶灯',position:[-9+i*1.5,-12],role:'environment',groupId:'citadel',layer:3});
    }`;
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, content: sparse }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const suggestion = await generateMapCodeSuggestion('亚特兰蒂斯', createEmptyMap('亚特兰蒂斯'), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(14);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('accepts a freestanding garden lantern without rewriting otherwise valid code', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'庭院' });
      api.route({ id:'garden-path', points:[[-10,0],[10,0]], width:3 });
      api.place({ name:'亭子', position:[0,8], role:'structure' });
      api.place({ name:'灯笼', position:[0,2], role:'environment' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('生成庭院', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'roadside.route-unbound')).toBe(false);
  });

  it('keeps a usable plan without requesting aesthetic scene completion', async () => {
    const incomplete = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'人工园林' });
      api.design({
        experienceMode:'sequential', intent:'入口院',
        groups:[{
          id:'entry', name:'入口院', intent:'门内转折',
          region:{kind:'polygon',points:[[-12,-12],[12,-12],[12,12],[-12,12]]},
          layers:[
            {level:1,intent:'园门与厢房',density:'tight',minCount:2},
            {level:3,intent:'门侧竹石',density:'normal'}
          ]
        }], focuses:[], viewpoints:[], relations:[]
      });
      api.place({ name:'园门', position:[0,-10], role:'structure', groupId:'entry', layer:1 });
    }`;
    const response = (body: object, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, content: incomplete }))
      .mockResolvedValueOnce(response({ ok: false, error: 'provider_unavailable' }, 503));
    const progress: string[] = [];

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene',
      onProgress: (event) => progress.push(event.label)
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
    expect(progress).not.toContain('场景自动补全暂不可用，已保留当前可用规划');
  });

  it('does not request an aesthetic rewrite for declared layer metadata', async () => {
    const original = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'花园'});
      api.design({experienceMode:'sequential',intent:'花园',groups:[{
        id:'garden',name:'花园',intent:'休憩',region:{kind:'circle',center:[0,0],radius:12},
        layers:[{level:1,intent:'树木',density:'normal'},{level:3,intent:'座椅',density:'normal'}]
      }],focuses:[],viewpoints:[],relations:[]});
      api.place({name:'园亭',position:[0,-5],role:'structure',groupId:'garden',layer:1});
      for (let i=0;i<12;i++) api.place({name:'树',position:[i-6,4],role:'environment',groupId:'garden',layer:1});
    }`;
    const rewritten = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'花园'});
      api.place({name:'座椅',position:[0,0],role:'functional'});
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(original))
      .mockResolvedValueOnce(response(rewritten));

    const suggestion = await generateMapCodeSuggestion('花园', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(13);
    expect(suggestion.codePlan?.code).toBe(original);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('does not request a density edit that could thin unrelated placements', async () => {
    const original = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'花园'});
      api.design({experienceMode:'sequential',intent:'花园',groups:[{
        id:'garden',name:'花园',intent:'休憩',region:{kind:'circle',center:[0,0],radius:12},
        layers:[{level:1,intent:'树木',density:'normal'},{level:3,intent:'座椅',density:'normal'}]
      }],focuses:[],viewpoints:[],relations:[]});
      api.place({name:'园亭',position:[0,-5],role:'structure',groupId:'garden',layer:1});
      for (let i=0;i<12;i++) api.place({name:'树',position:[i-6,4],role:'environment',groupId:'garden',layer:1});
    }`;
    const repair = JSON.stringify({ edits: [{
      old: "for (let i=0;i<12;i++) api.place({name:'树',position:[i-6,4],role:'environment',groupId:'garden',layer:1});",
      new: "for (let i=0;i<1;i++) api.place({name:'树',position:[i-6,4],role:'environment',groupId:'garden',layer:1});\n      api.place({name:'座椅',position:[2,2],role:'functional',groupId:'garden',layer:3});"
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response(repair));

    const suggestion = await generateMapCodeSuggestion('花园', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(13);
    expect(suggestion.codePlan?.code).toBe(original);
  });

  it('does not run risky completion code for an underfilled semantic layer', async () => {
    const underfilled = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'人工园林' });
      api.design({
        experienceMode:'sequential', intent:'入口院',
        groups:[{
          id:'entry', name:'入口院', intent:'门内转折',
          region:{kind:'polygon',points:[[-12,-12],[12,-12],[12,12],[-12,12]]},
          layers:[
            {level:1,intent:'园门与厢房',density:'tight',minCount:2},
            {level:3,intent:'门侧竹石',density:'normal'}
          ]
        }], focuses:[], viewpoints:[], relations:[]
      });
      api.place({ name:'园门', position:[0,-10], role:'structure', groupId:'entry', layer:1 });
    }`;
    const gate = "api.place({ name:'园门', position:[0,-10], role:'structure', groupId:'entry', layer:1 });";
    const timedOutEdit = JSON.stringify({ edits: [{
      old: gate,
      new: `${gate}\n      for (let index = 0; index < 1_000_000_000; index += 1) api.random();`
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(underfilled))
      .mockResolvedValueOnce(response(timedOutEdit));

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(1);
    expect(suggestion.codePlan?.code).toBe(underfilled);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', repaired: false })
    ]));
  });

  it('explains the one-object bridge signature when repairing positional arguments', async () => {
    const invalid = `function plan(api) {
      api.water('canal', { type:'lake', points:[[-8,-4],[8,-4],[8,4],[-8,4]], level:0.2 });
      api.bridge('canal', { name:'水晶桥', crossingCenter:[0,0], direction:[1,0], dimensions:[3,1,4] });
    }`;
    const repaired = JSON.stringify({ edits: [{
      old: "api.bridge('canal', { name:'水晶桥', crossingCenter:[0,0], direction:[1,0], dimensions:[3,1,4] });",
      new: "api.bridge({ waterId:'canal', name:'水晶桥', crossingCenter:[0,0], direction:[1,0], dimensions:[3,1,4] });"
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValue(response(repaired));

    const suggestion = await generateMapCodeSuggestion('生成一条运河和跨河桥', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages.at(-1).content).toContain('api.bridge accepts one object argument only');
    expect(repairRequest.messages.at(-1).content).toContain('api.bridge({ waterId:');
    expect(suggestion.codePlan?.repairAttempts).toBe(1);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.add' })
    ]));
  });

  it('uses the second execution-repair attempt when the first edit anchor is not unique', async () => {
    const invalid = `function plan(api) {
      api.surface({id:'yard',surface:'cement',region:{kind:'circle',center:[0,0],radius:6}});
      api.place({name:'cement marker',position:[0,0],role:'environment'});
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify({ edits: [{ old: 'cement', new: 'paving' }] })))
      .mockResolvedValueOnce(response(JSON.stringify({ edits: [{ old: "surface:'cement'", new: "surface:'paving'" }] })));

    const suggestion = await generateMapCodeSuggestion('生成水泥院子', createEmptyMap(), [], {
      approvedCode: invalid,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.codePlan?.repairAttempts).toBe(2);
    expect(suggestion.codePlan?.code).toContain("surface:'paving'");
  });

  it('explains valid bridge crossing geometry when repairing an off-water bridge', async () => {
    const invalid = `function plan(api) {
      api.water('canal', { type:'lake', points:[[-8,-4],[8,-4],[8,4],[-8,4]], level:0.2 });
      api.bridge({ waterId:'canal', name:'水晶桥', crossingCenter:[20,20], direction:[1,0], dimensions:[3,1,4] });
    }`;
    const repaired = `function plan(api) {
      api.sceneIntent({ kind:'natural', reason:'测试修复流程' });
      api.place({ name:'修复完成标记', position:[0,0], role:'environment' });
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValue(response(repaired));

    await generateMapCodeSuggestion('生成一条运河和跨河桥', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages.at(-1).content).toContain('crossingCenter must lie inside the named water body');
    expect(repairRequest.messages.at(-1).content).toContain('direction perpendicular to the local river path');
    expect(repairRequest.messages.at(-1).content).toContain('Do not distribute bridges on a generic ring');
  });

  it('keeps valid scene content when a local bridge crossing remains unresolved', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('canal', {type:'lake',points:[[-8,-4],[8,-4],[8,4],[-8,4]],level:0.2});
      api.bridge({waterId:'canal',name:'偏离水面的桥',crossingCenter:[20,20],direction:[1,0],dimensions:[3,1,4]});
      api.place({name:'神殿',position:[0,10],role:'structure'});
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'water.add' }),
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ name: '神殿' }) })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bridge.unresolved-crossing', repaired: false })
    ]));
  });

  it('keeps valid scene content when bridge and connection geometry degenerates locally', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('canal', {type:'lake',points:[[-8,-4],[8,-4],[8,4],[-8,4]],level:0.2});
      api.bridge({waterId:'canal',name:'零方向桥',crossingCenter:[0,0],direction:[0,0],dimensions:[3,1,4]});
      api.placeBetween({name:'零长度连廊',start:[4,4],end:[4,4],dimensions:[3,2,1]});
      api.place({name:'神殿',position:[0,10],role:'structure'});
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'water.add' }),
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ name: '神殿' }) })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'code.geometry-unresolved', repaired: false })
    ]));
  });

  it('explains the route return contract when repairing an object-style route reference', async () => {
    const invalid = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'测试路线引用修复'});
      api.place({name:'城门',position:[0,-4],role:'structure'});
      const mainRoute = api.route({ id:'main', points:[[-8,0],[8,0]], width:3 });
      api.placeAlongRoute({ routeId:mainRoute.id, name:'路灯', spacing:4 });
    }`;
    const repaired = `function plan(api) {
      api.sceneIntent({ kind:'natural', reason:'测试修复流程' });
      api.place({ name:'修复完成标记', position:[0,0], role:'environment' });
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValue(response(repaired));

    await generateMapCodeSuggestion('生成一条道路和路灯', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages.at(-1).content).toContain('api.route(...) returns the route ID string, not an object');
    expect(repairRequest.messages.at(-1).content).toContain('Never use mainRoute.id');
    expect(repairRequest.messages.at(-1).content).not.toContain('api.routeNetwork');
  });

  it('keeps a usable scene when the model still misses the requested asset minimum after one repair', async () => {
    const underMinimum = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'测试资产数量降级'});
      const gate=api.requireAsset({key:'gate',name:'城门',prompt:'Standalone gate',variants:1,role:'structure'});
      api.place({assetId:api.asset(gate,0),position:[0,0],role:'structure'});
    }`;
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, content: underMinimum }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const suggestion = await generateMapCodeSuggestion('生成一座城门', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 2, maxNewAssets: 2, scope: 'scene', discoveryOnly: true
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'asset.minimum-degraded', severity: 'warning', repaired: false })
    ]));
  });

  it('hides existing assets by default and exposes only explicitly selected reusable assets', async () => {
    const selected = testAsset('asset-selected', 'Selected neon lamp');
    const unselected = testAsset('asset-unselected', 'Unselected old building');
    const code = 'function plan(api) { api.place({ name: "marker", position: [0, 0] }); }';
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(body.messages[0].content);
      return new Response(JSON.stringify({ ok: true, content: code }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    await generateMapCodeSuggestion('make a street', createEmptyMap(), [selected, unselected], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      minNewAssets: 0,
      maxNewAssets: 0
    });
    await generateMapCodeSuggestion('make a street', createEmptyMap(), [selected, unselected], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      reuseExistingAssets: true,
      reusableAssetIds: [selected.id],
      minNewAssets: 0,
      maxNewAssets: 0
    });

    expect(prompts[0]).not.toContain(selected.id);
    expect(prompts[0]).not.toContain(unselected.id);
    expect(prompts[1]).toContain(selected.id);
    expect(prompts[1]).not.toContain(unselected.id);
  });

  it('supports basic JavaScript control flow and preserves deterministic placement order', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        for (let index = 0; index < 6; index += 1) {
          if (index % 2 === 0) {
            api.place({ name: 'marker', position: [index * 2 - 4, 0] });
          }
        }
      }
    `, createEmptyMap());

    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');
    expect(placements).toHaveLength(3);
    expect(placements.map((operation) => operation.object.transform?.position?.[0])).toEqual([-4, 0, 4]);
    expect(suggestion.codePlan?.functions).toEqual(['place']);
    expect(() => applyMapOperations(createEmptyMap(), suggestion.operations)).not.toThrow();
    expect(placements.every((operation) => Boolean(operation.object.id))).toBe(true);
  });

  it('combines Bezier sampling with deterministic noise masks', () => {
    const map = createEmptyMap();
    const code = `
      function plan(api) {
        const points = api.sampleBezier([-18,-10], [-8,14], [8,-14], [18,10], 24);
        for (const point of points) {
          if (api.noise2D(point[0], point[1], 0.12) > -0.15) {
            api.place({ name: 'trail-edge', position: point, scale: 0.5 });
          }
        }
      }
    `;

    const first = executeMapCodePlan(code, map);
    const second = executeMapCodePlan(code, map);
    const spatialOperations = (suggestion: typeof first) => suggestion.operations.map((operation) => {
      if (operation.type !== 'object.add') return operation;
      return { ...operation, object: { ...operation.object, id: undefined } };
    });
    expect(spatialOperations(first)).toEqual(spatialOperations(second));
    expect(first.codePlan?.functions).toEqual(['noise2D', 'place', 'sampleBezier']);
  });

  it('accepts Bezier frame objects as placement points and tangents', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frame = api.bezierPoint(0.5, [-8, -4], [-4, 8], [4, -8], [8, 4]);
        api.place({ position: frame, rotationY: api.tangentYaw(frame) });
      }
    `, map);
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing placement');
    expect(placement.object.transform?.position?.every(Number.isFinite)).toBe(true);
    expect(placement.object.transform?.rotation?.every(Number.isFinite)).toBe(true);
  });

  it('resolves declarative facing directions and targets into Y rotation', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.place({ name: 'east', position: [0, 0], facing: [1, 0] });
        api.place({ name: 'north', position: [4, 0], facing: { target: [4, 10] } });
        api.place({ name: 'south', position: [8, 0], facing: { target: [8, 10], offsetY: api.TAU / 2 } });
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(3);
    if (placements[0].type !== 'object.add' || placements[1].type !== 'object.add' || placements[2].type !== 'object.add') {
      throw new Error('missing placements');
    }
    expect(placements[0].object.transform?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
    expect(placements[1].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[2].object.transform?.rotation?.[1]).toBeCloseTo(Math.PI);
    expect(suggestion.codePlan?.functions).toContain('place');
  });

  it('fits generated model dimensions between two endpoints', () => {
    const connectedAsset: MapAsset = {
      ...testAsset('asset-connected-wall', 'Connected wall'),
      modelJson: {
        format: 2,
        nodes: [{
          id: 'wall-body',
          transform: { pos: [0, 2, 0] },
          mesh: { type: 'box', params: { width: 2, height: 4, depth: 1 } }
        }]
      }
    };
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.placeBetween({
          assetId: 'asset-connected-wall',
          name: 'connected-wall',
          start: [0, 0],
          end: [10, 0],
          dimensions: [4, 3, 1],
          spanAxis: 'x',
          gapRatio: 0.1
        });
        api.placeBetween({
          name: 'connected-path',
          start: [0, 0],
          end: [0, 8],
          dimensions: [2, 1, 4],
          spanAxis: 'z'
        });
      }
    `, createEmptyMap(), [connectedAsset]);
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(2);
    if (placements[0].type !== 'object.add' || placements[1].type !== 'object.add') {
      throw new Error('missing connected placements');
    }
    expect(placements[0].object.transform?.position?.[0]).toBeCloseTo(5);
    expect(placements[0].object.transform?.position?.[2]).toBeCloseTo(0);
    expect(placements[0].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[0].object.transform?.size).toEqual([9, 3, 1]);
    expect(placements[0].object.transform?.scale).toEqual([0.5, 0.25, 1]);
    expect(placements[1].object.transform?.position?.[2]).toBeCloseTo(4);
    expect(placements[1].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[1].object.transform?.size).toEqual([2, 1, 8]);
    expect(placements[1].object.transform?.scale).toEqual([1, 1, 1]);
    expect(suggestion.codePlan?.functions).toEqual(['placeBetween']);
  });

  it('keeps arena seating connected on local X while its local front faces the arena', () => {
    const stand: MapAsset = {
      ...testAsset('asset-arena-stand', '环形看台'),
      tags: ['stand', 'arena', 'seating'],
      prompt: 'Modular spectator stand. Tangent connection axis is local X and spectator-facing front is local Z+.',
      modelJson: {
        format: 2,
        nodes: [{
          id: 'stand-body', transform: { pos: [0, 4, 0] },
          mesh: { type: 'box', params: { width: 7, height: 8, depth: 8 } }
        }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.placeBetween({
        assetId:'asset-arena-stand', name:'环形看台',
        start:[24,0], end:[22,7], dimensions:[7,8,8],
        spanAxis:'z', facing:{target:[0,0]}, groupId:'arena', layer:1
      });
    }`, createEmptyMap(), [stand]);
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing arena stand');
    expect(placement.object.transform?.size?.[0]).toBeCloseTo(Math.hypot(2, 7));
    expect(placement.object.transform?.size?.[2]).toBeCloseTo(8);
    const position = placement.object.transform?.position ?? [0, 0, 0];
    const yaw = placement.object.transform?.rotation?.[1] ?? 0;
    const front = [Math.sin(yaw), Math.cos(yaw)];
    expect(front[0] * -position[0] + front[1] * -position[2]).toBeGreaterThan(0);
  });

  it('builds a closed ellipse from shared endpoints with bounded miter overlap', () => {
    const wall: MapAsset = {
      ...testAsset('asset-ellipse-wall', '竞技场外墙'),
      tags: ['wall', 'arena'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'wall-body', transform: { pos: [0, 2, 0] },
          mesh: { type: 'box', params: { width: 4, height: 4, depth: 1 } }
        }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      const points=[];
      for(let i=0;i<12;i+=1) points.push(api.ellipsePoint(i,12,18,12));
      for(let i=0;i<points.length;i+=1) api.placeBetween({
        assetId:'asset-ellipse-wall', name:'竞技场外墙',
        start:points[i], end:points[(i+1)%points.length],
        dimensions:[4,4,1], spanAxis:'x', gapRatio:0,
        role:'structure', groupId:'arena', layer:1
      });
    }`, createEmptyMap(), [wall], { spatialPolicy: 'repair' });
    const objects = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object);
    const firstStart = [18, 0] as const;
    const firstEnd = [18 * Math.cos(Math.PI / 6), 12 * Math.sin(Math.PI / 6)] as const;
    const chord = Math.hypot(firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]);

    expect(objects).toHaveLength(12);
    expect(objects[0].transform?.size?.[0]).toBeGreaterThan(chord);
    expect(suggestion.codePlan?.functions).toEqual(['ellipsePoint', 'placeBetween']);
  });

  it('keeps walls and trees out of water without blocking the plan', () => {
    const wall = { ...testAsset('asset-dry-wall', '园林围墙'), tags: ['wall', 'garden'] };
    const tree = { ...testAsset('asset-dry-tree', '造型松'), tags: ['tree', 'pine'] };
    const map = createEmptyMap('water repair', 'water-repair', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('pond',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:1.5});
      api.place({assetId:'asset-dry-wall',name:'园林围墙',position:[0,0],role:'structure'});
      api.place({assetId:'asset-dry-tree',name:'造型松',position:api.keepDry([2,2],1),role:'environment'});
    }`, map, [wall, tree], { spatialPolicy: 'repair' });
    const applied = applyMapOperations({ ...map, assets: [wall, tree] }, suggestion.operations);
    const water = applied.waterBodies[0];

    expect(applied.objects.every((object) => !isPointInsideWaterBody(
      water, object.transform.position[0], object.transform.position[2], applied
    ))).toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'outdoor.water-intrusion-repaired', repaired: true })
    ]));
    expect(suggestion.codePlan?.functions).toContain('keepDry');
  });

  it('reports a dry-group substrate conflict instead of moving the architecture far away', () => {
    const wall = { ...testAsset('asset-dry-wall', '园林围墙'), tags: ['wall', 'garden'] };
    const map = createEmptyMap('substrate preflight', 'substrate-preflight', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'island',name:'岛上建筑',substrate:'dry',layers:[]} ]});
      api.water('lagoon',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:1.5});
      api.place({assetId:'asset-dry-wall',name:'园林围墙',position:[0,0],role:'structure',groupId:'island',layer:1});
    }`, map, [wall], { scope: 'scene', spatialPolicy: 'repair' });
    const applied = applyMapOperations({ ...map, assets: [wall] }, suggestion.operations);

    expect(applied.objects[0].transform.position[0]).toBeCloseTo(0);
    expect(applied.objects[0].transform.position[2]).toBeCloseTo(0);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'scene.program-incomplete', repaired: false,
        message: expect.stringContaining('island')
      })
    ]));
  });

  it('still performs a surgical dry-land correction near the shoreline', () => {
    const tree = { ...testAsset('asset-shore-tree', '岸边松树'), tags: ['tree', 'pine'] };
    const map = createEmptyMap('local substrate repair', 'local-substrate-repair', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'shore',name:'岸边林',substrate:'dry',layers:[]} ]});
      api.water('lagoon',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:1.5});
      api.place({assetId:'asset-shore-tree',name:'岸边松树',position:[9.5,0],role:'environment',groupId:'shore',layer:3});
    }`, map, [tree], { scope: 'scene', spatialPolicy: 'repair' });
    const applied = applyMapOperations({ ...map, assets: [tree] }, suggestion.operations);
    const position = applied.objects[0].transform.position;

    expect(Math.hypot(position[0] - 9.5, position[2])).toBeLessThanOrEqual(4);
    expect(isPointInsideWaterBody(applied.waterBodies[0], position[0], position[2], applied)).toBe(false);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'outdoor.water-intrusion-repaired', repaired: true })
    ]));
  });

  it('keeps explicitly underwater architecture in its authored water position', () => {
    const hall = { ...testAsset('asset-underwater-hall', '海底建筑'), tags: ['building', 'hall'] };
    const map = createEmptyMap('underwater substrate', 'underwater-substrate', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'ruins',name:'水下遗迹',substrate:'underwater',layers:[]} ]});
      api.water('lagoon',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:3});
      api.place({assetId:'asset-underwater-hall',name:'海底建筑',position:[0,0],role:'structure',groupId:'ruins',layer:1});
    }`, map, [hall], { scope: 'scene' });
    const applied = applyMapOperations({ ...map, assets: [hall] }, suggestion.operations);

    expect(applied.objects[0].transform.position[0]).toBeCloseTo(0);
    expect(applied.objects[0].transform.position[2]).toBeCloseTo(0);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'outdoor.water-intrusion-repaired')).toBe(false);
  });

  it('reports a clear water-group mismatch without enforcing a single shoreline point', () => {
    const hall = { ...testAsset('asset-water-hall', '水上厅堂'), tags: ['building', 'hall'] };
    const map = createEmptyMap('water substrate mismatch', 'water-substrate-mismatch', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'harbor',name:'水上街区',substrate:'water',layers:[]} ]});
      api.water('lagoon',{type:'lake',points:[[-6,-6],[6,-6],[6,6],[-6,6]],level:0.2,depth:3});
      api.place({assetId:'asset-water-hall',name:'水上厅堂一',position:[18,12],role:'structure',groupId:'harbor',layer:1});
      api.place({assetId:'asset-water-hall',name:'水上厅堂二',position:[22,12],role:'structure',groupId:'harbor',layer:1});
    }`, map, [hall], { scope: 'scene' });

    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.program-incomplete', message: expect.stringContaining('harbor') })
    ]));
  });

  it('repairs a substrate contract before asset generation without translating the group', async () => {
    const original = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'水下遗迹'});
      api.design({groups:[{id:'ruins',name:'水下遗迹',substrate:'dry',layers:[]} ]});
      api.water('lagoon',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:3});
      api.place({name:'海底建筑',position:[0,0],role:'structure',groupId:'ruins',layer:1});
    }`;
    const repair = JSON.stringify({ edits: [{ old: "substrate:'dry'", new: "substrate:'underwater'" }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response(repair));

    const suggestion = await generateMapCodeSuggestion('生成水下遗迹', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene', discoveryOnly: true, spatialPolicy: 'repair'
    });
    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    const applied = applyMapOperations(createEmptyMap(), suggestion.operations);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repairRequest.messages.at(-1).content).toContain('scene_group_substrate_conflict:ruins');
    expect(repairRequest.messages.at(-1).content).toContain('do not translate the whole group');
    expect(applied.designSemantics.groups[0].substrate).toBe('underwater');
    expect(applied.objects[0].transform.position[0]).toBeCloseTo(0);
    expect(applied.objects[0].transform.position[2]).toBeCloseTo(0);
  });

  it('places boats at the authored water surface and keeps them movable', () => {
    const boat = { ...testAsset('asset-boat', '乌篷船'), tags: ['boat', '船'] };
    const map = createEmptyMap('water placement', 'water-placement', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('pond',{type:'lake',points:[[-10,-10],[10,-10],[10,10],[-10,10]],level:0.2,depth:1.5});
      api.place({assetId:'asset-boat',name:'乌篷船',position:api.waterPoint('pond',[0,0]),role:'structure'});
    }`, map, [boat]);
    const applied = applyMapOperations({ ...map, assets: [boat] }, suggestion.operations);
    const placedBoat = applied.objects[0];

    expect(placedBoat.transform.position[1]).toBeCloseTo(0.2);
    expect(placedBoat.locked).toBe(false);
    expect(suggestion.codePlan?.functions).toContain('waterPoint');
  });

  it('samples a named water surface through the environment query in new outdoor plans', () => {
    const map = createEmptyMap('river field', 'river-field', [64, 12, 64]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('stream',{type:'river',points:[[-8,0],[8,0]],levels:[3,1],widths:[4,4],depth:1});
      const upstream=api.environmentSample([-6,0],{waterId:'stream'});
      const downstream=api.environmentSample([6,0],{waterId:'stream'});
      const outside=api.environmentSample([0,10],{waterId:'stream'});
      if (!upstream.water.inside || !downstream.water.inside || outside.water.inside || outside.water.surfaceHeight !== null) {
        throw new Error('invalid_water_field');
      }
      api.place({name:'上游船',position:[-6,upstream.water.surfaceHeight-0.2,0],terrain:false});
      api.place({name:'下游船',position:[6,downstream.water.surfaceHeight-0.2,0],terrain:false});
    }`, map, [], { scope: 'scene', legacyApis: false });
    const placed = applyMapOperations(map, suggestion.operations).objects;

    expect(placed).toHaveLength(2);
    expect(placed[0].transform.position[1]).toBeGreaterThan(placed[1].transform.position[1]);
    expect(suggestion.codePlan?.functions).toContain('environmentSample');
    expect(suggestion.codePlan?.functions).not.toContain('waterPoint');
    expect(() => executeMapCodePlan(`function plan(api) {
      api.environmentSample([0,0],{waterId:'missing'});
    }`, createEmptyMap(), [], { scope: 'scene', legacyApis: false })).toThrow('unknown_map_environment_water:missing');
  });

  it('repairs repeated ordinary wall samples into shared-endpoint segments', () => {
    const wall: MapAsset = {
      ...testAsset('asset-arc-wall', '竞技场外墙'),
      tags: ['wall', 'arena'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'wall-body',
          transform: { pos: [0, 2, 0] },
          mesh: { type: 'box', params: { width: 4, height: 4, depth: 1 } }
        }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      const points = [[-8,0],[-4,2],[0,3],[4,2],[8,0]];
      for (const point of points) api.place({
        assetId:'asset-arc-wall', name:'竞技场外墙', position:point,
        role:'structure', groupId:'outer-ring', layer:1
      });
    }`, createEmptyMap(), [wall], { spatialPolicy: 'repair' });
    const objects = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object);

    expect(objects).toHaveLength(5);
    expect(objects.every((object) => (object.transform?.size?.[0] ?? 0) > 3)).toBe(true);
    for (let index = 0; index < objects.length - 1; index += 1) {
      const left = horizontalSpanEndpoint(objects[index], wall, 1);
      const right = horizontalSpanEndpoint(objects[index + 1], wall, -1);
      expect(left[0]).toBeCloseTo(right[0], 5);
      expect(left[1]).toBeCloseTo(right[1], 5);
    }
  });

  it('solves a bridge against the actual water boundary and fixes it above the water surface', () => {
    const bridge: MapAsset = {
      ...testAsset('asset-stone-bridge', '石拱桥'),
      tags: ['bridge', 'garden'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'bridge-body',
          transform: { pos: [0, 0.5, 0] },
          mesh: { type: 'box', params: { width: 2, height: 1, depth: 4 } }
        }]
      }
    };
    const base = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('garden-pond', {
        type: 'lake',
        points: [[-8,-5],[8,-5],[8,5],[-8,5]],
        level: 0.5,
        shorelineSmoothness: 0.8,
        shorelineIrregularity: 0
      });
      api.bridge({
        waterId: 'garden-pond',
        assetId: 'asset-stone-bridge',
        name: '石拱桥',
        crossingCenter: [0, 0],
        direction: [1, 0],
        dimensions: [2, 1, 4],
        bankInset: 1,
        deckClearance: 0.2
      });
    }`, base, [bridge]);
    const applied = applyMapOperations({ ...base, assets: [bridge] }, suggestion.operations);
    const object = applied.objects.find((item) => item.assetId === bridge.id);
    const water = applied.waterBodies.find((item) => item.id === 'garden-pond');

    expect(object).toBeDefined();
    expect(water).toBeDefined();
    expect(object?.heightMode).toBe('fixed');
    expect(object?.transform.position[1]).toBeGreaterThanOrEqual(0.7);
    expect(object?.transform.rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(object?.transform.size[2]).toBeGreaterThan(16);
    const halfSpan = (object?.transform.size[2] ?? 0) / 2;
    expect(isPointInsideWaterBody(water!, -halfSpan, 0, applied)).toBe(false);
    expect(isPointInsideWaterBody(water!, halfSpan, 0, applied)).toBe(false);
    expect(suggestion.codePlan?.functions).toContain('bridge');
    expect(applied.guides).toEqual(expect.arrayContaining([
      expect.objectContaining({ tags: expect.arrayContaining(['bridge', 'route']) })
    ]));
    expect(applied.objects.filter((item) => item.name.includes('桥台'))).toHaveLength(2);
  });

  it('uses full bridge width for an irregular shore and compiles a curved bridge from local segments', () => {
    const bridge = testAsset('asset-curve-bridge', '曲桥模块');
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('pond', { type:'lake', points:[[-10,-6],[5,-6],[9,-2],[6,6],[-7,5],[-10,1]], level:0.4 });
      api.bridge({
        waterId:'pond', assetId:'asset-curve-bridge', name:'曲桥',
        crossingCenter:[0,0], direction:[1,0], dimensions:[4,0.8,3],
        kind:'curved', curveOffset:3, segmentCount:5, groupId:'water-scene', layer:2
      });
    }`, map, [bridge]);
    const applied = applyMapOperations({ ...map, assets: [bridge] }, suggestion.operations);
    const segments = applied.objects.filter((object) => object.assetId === bridge.id);
    const guide = applied.guides.find((item) => item.tags.includes('bridge'));

    expect(segments).toHaveLength(5);
    expect(segments.every((object) => object.designGroupId === 'water-scene' && object.compositionLayer === 2)).toBe(true);
    expect(guide?.curve).toBe('catmull-rom');
    expect(guide?.points).toHaveLength(6);
    const water = applied.waterBodies.find((item) => item.id === 'pond')!;
    const start = guide!.points[0];
    const end = guide!.points.at(-1)!;
    expect(isPointInsideWaterBody(water, start[0], start[1] - 2, applied)).toBe(false);
    expect(isPointInsideWaterBody(water, start[0], start[1] + 2, applied)).toBe(false);
    expect(isPointInsideWaterBody(water, end[0], end[1] - 2, applied)).toBe(false);
    expect(isPointInsideWaterBody(water, end[0], end[1] + 2, applied)).toBe(false);
  });

  it('persists AI-authored design relations without silently reshaping placements', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'garden'});
      api.design({
        experienceMode:'sequential', intent:'一步一景',
        groups:[{id:'garden',name:'园林组',intent:'沿路线展开',focusIds:['pavilion-focus'],guideIds:[],entryGuideIds:[],exitGuideIds:[],axisGuideIds:[],protectedObjectIds:[],removableObjectIds:[],layers:[
          {level:1,intent:'主体',density:'tight'}, {level:4,intent:'成对密铺点景',density:'tight'}
        ]}],
        focuses:[{id:'pavilion-focus',groupId:'garden',name:'主亭',kind:'primary',rank:1,selector:'主亭',reveal:'framed'}],
        viewpoints:[{id:'entry',groupId:'garden',point:[-8,0],targetFocusId:'pavilion-focus',role:'entry'}],
        relations:[{id:'stone-to-pavilion',kind:'attract',sourceSelector:'景石',targetSelector:'主亭',strength:'normal',minDistance:2,maxDistance:4}]
      });
      api.place({name:'主亭',position:[0,0],groupId:'garden',layer:1,size:[4,4,4],role:'structure'});
      for (let i=0;i<6;i++) api.place({name:'景石',position:[10+i*2,0],groupId:'garden',layer:4,size:[1,1,1],role:'environment'});
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);
    const focus = applied.designSemantics.focuses[0];
    const pavilion = applied.objects.find((object) => object.name === '主亭');
    const stones = applied.objects.filter((object) => object.name === '景石');

    expect(applied.designSemantics.experienceMode).toBe('sequential');
    expect(focus.objectId).toBe(pavilion?.id);
    expect(pavilion?.designGroupId).toBe('garden');
    expect(stones).toHaveLength(6);
    expect(stones.map((stone) => stone.transform.position[0])).toEqual([10, 12, 14, 16, 18, 20]);
    expect(applied.designSemantics.relations).toEqual([
      expect.objectContaining({ id:'stone-to-pavilion', kind:'attract', minDistance:2, maxDistance:4 })
    ]);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['design', 'place', 'sceneIntent']));
  });

  it('compiles circulation into both an editable guide and real paving', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'garden-walk',name:'园路',points:[[-10,-8],[-4,0],[4,3],[10,8]],curve:'catmull-rom',width:2,surface:'paving'});
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);

    expect(applied.guides).toEqual([expect.objectContaining({ id: 'garden-walk', curve: 'catmull-rom', width: 2 })]);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.surface', surface: 'paving' })
    ]));
    expect(suggestion.codePlan?.functions).toContain('route');
  });

  it('keeps an AI-looped building assembly connected and editable after replay', () => {
    const map = createEmptyMap('Connected court');
    const code = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'one composed court'});
      api.design({groups:[{id:'court',name:'庭院',layers:[]}],assemblies:[
        {id:'perimeter',groupId:'court',intent:'四边连续围合',topology:'loop'}
      ],focuses:[],viewpoints:[],relations:[]});
      const points=[[-6,-6],[6,-6],[6,6],[-6,6]];
      for(let i=0;i<points.length;i++) api.placeBetween({
        name:'围墙',start:points[i],end:points[(i+1)%points.length],
        dimensions:[12,3,1],spanAxis:'x',gapRatio:0,groupId:'court',assemblyId:'perimeter',layer:1
      });
    }`;
    const suggestion = executeMapCodePlan(code, map, [], { scope: 'scene' });
    const saved = applyMapOperations(map, suggestion.operations);
    expect(saved.designSemantics.assemblies).toEqual([
      expect.objectContaining({ id: 'perimeter', groupId: 'court', topology: 'loop' })
    ]);
    expect(saved.objects.filter((object) => object.assemblyId === 'perimeter')).toHaveLength(4);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'code.geometry-unresolved'
      && issue.message.includes('围墙'))).toBe(false);
  });

  it('stacks reusable building modules in two distinct levels without terrain snapping the upper tier', () => {
    const map = createEmptyMap('Layered arena');
    const code = `function plan(api) {
      api.sceneIntent({kind:'authored',reason:'layered courtyard'});
      api.design({groups:[{id:'court',name:'庭院',layers:[]}],assemblies:[
        {id:'arena',groupId:'court',intent:'two-story colonnade',topology:'loop',stories:2}
      ]});
      const corners=[[-8,-8],[8,-8],[8,8],[-8,8]];
      for(let floor=0;floor<2;floor+=1) for(let i=0;i<4;i+=1) {
        api.placeBetween({name:'拱廊模块',start:corners[i],end:corners[(i+1)%4],
          dimensions:[16,4,1],spanAxis:'x',elevation:floor*4,groupId:'court',assemblyId:'arena',layer:1});
      }
    }`;
    const suggestion = executeMapCodePlan(code, map, [], { scope: 'scene' });
    const saved = applyMapOperations(map, suggestion.operations);
    expect(saved.designSemantics.assemblies[0]).toMatchObject({ id: 'arena', stories: 2 });
    const members = saved.objects.filter((object) => object.assemblyId === 'arena');
    expect(members).toHaveLength(8);
    expect(members.filter((member) => member.heightMode === 'fixed')).toHaveLength(4);
    expect(members.slice(4).map((member, index) => member.transform.position[1] - members[index].transform.position[1]))
      .toEqual([4, 4, 4, 4]);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'code.geometry-unresolved'
      && issue.message.includes('arena'))).toBe(false);
  });

  it('anchors elevated modules to terrain generated later in the same scene transaction', () => {
    const map = createEmptyMap('Terraced structure');
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('hills',{amplitude:3});
      api.placeBetween({name:'底层墙',start:[3,4],end:[7,4],dimensions:[4,3,1]});
      api.placeBetween({name:'二层墙',start:[3,4],end:[7,4],dimensions:[4,3,1],elevation:3});
    }`, map);
    const saved = applyMapOperations(map, suggestion.operations);
    const ground = saved.objects.find((object) => object.name === '底层墙')!;
    const upper = saved.objects.find((object) => object.name === '二层墙')!;
    expect(ground.transform.position[1]).toBeCloseTo(sampleTerrainHeight(saved, 5, 4));
    expect(upper.transform.position[1]).toBeCloseTo(ground.transform.position[1] + 3);
    expect(upper.heightMode).toBe('fixed');
  });

  it('advises when declared multi-story architecture only builds the ground tier', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'court',layers:[]}],assemblies:[
        {id:'arena',groupId:'court',intent:'two story building',topology:'loop',stories:2}
      ]});
      const p=[[-5,-5],[5,-5],[5,5],[-5,5]];
      for(let i=0;i<4;i+=1) api.placeBetween({name:'墙段',start:p[i],end:p[(i+1)%4],
        dimensions:[10,3,1],groupId:'court',assemblyId:'arena'});
    }`, createEmptyMap());
    expect(suggestion.blocked).not.toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:'code.geometry-unresolved', message:expect.stringContaining('楼层') })
    ]));
  });

  it('reports a declared structural module family that the building never places', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'court',layers:[]}],assemblies:[
        {id:'hall',groupId:'court',intent:'modular hall',topology:'group',moduleKeys:['wall','column']}
      ]});
      const wall=api.requireAsset({key:'wall',name:'墙段',prompt:'A reusable wall bay',role:'structure',dimensions:[3,3,1]});
      api.place({name:'墙段',assetId:api.asset(wall),position:[0,0],groupId:'court',assemblyId:'hall'});
    }`, createEmptyMap(), [], {mode:'discovery'});
    expect(suggestion.blocked).not.toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({code:'code.geometry-unresolved',message:expect.stringContaining('column')})
    ]));
  });

  it('reuses one set of bound structural modules across two distinct building assemblies', () => {
    const bay = testAsset('bay-asset','拱廊段');
    const pillar = testAsset('pillar-asset','柱');
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'district',layers:[]}],assemblies:[
        {id:'hall-a',groupId:'district',intent:'first hall',topology:'group',moduleKeys:['bay','pillar']},
        {id:'hall-b',groupId:'district',intent:'second hall',topology:'group',moduleKeys:['bay','pillar']}
      ]});
      const bay=api.requireAsset({key:'bay',name:'拱廊段',prompt:'reusable arcade bay',role:'structure',dimensions:[4,3,1]});
      const pillar=api.requireAsset({key:'pillar',name:'柱',prompt:'reusable column',role:'structure',dimensions:[1,3,1]});
      for(let i=0;i<2;i+=1) {
        const x=i*16-8; const id=i===0?'hall-a':'hall-b';
        api.placeBetween({assetId:api.asset(bay),start:[x,0],end:[x+4,0],dimensions:[4,3,1],groupId:'district',assemblyId:id});
        api.place({assetId:api.asset(pillar),position:[x,3],groupId:'district',assemblyId:id});
      }
    }`, createEmptyMap(), [bay,pillar], {scope:'scene',assetBindings:new Map([
      ['bay',[bay]],['pillar',[pillar]]
    ])});
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(4);
    expect(suggestion.diagnostics?.some((issue) => issue.message.includes('构件族'))).toBe(false);
  });

  it('reports disconnected or over-stretched assemblies without rejecting the scene', () => {
    const map = createEmptyMap('Incomplete court');
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'court'});
      api.design({groups:[{id:'court',layers:[]}],assemblies:[
        {id:'wall',groupId:'court',topology:'loop',openings:1}
      ],focuses:[],viewpoints:[],relations:[]});
      api.placeBetween({name:'围墙',start:[-10,0],end:[10,0],dimensions:[4,3,1],
        spanAxis:'x',groupId:'court',assemblyId:'wall',layer:1});
      api.place({name:'围墙',position:[0,10],groupId:'court',assemblyId:'wall',layer:1});
    }`, map, [], { scope: 'scene' });
    expect(suggestion.blocked).not.toBe(true);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(2);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'code.geometry-unresolved', message: expect.stringContaining('wall') })
    ]));
  });

  it('allows a connected path assembly to include separately placed architectural detail', () => {
    const map = createEmptyMap('Gateway court');
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.design({groups:[{id:'court',layers:[]}],assemblies:[
        {id:'side-wall',groupId:'court',topology:'path'}
      ]});
      for (let i=0;i<2;i++) api.placeBetween({name:'墙段',start:[i*4,0],end:[(i+1)*4,0],
        dimensions:[4,3,1],groupId:'court',assemblyId:'side-wall'});
      api.place({name:'檐柱',position:[4,0],groupId:'court',assemblyId:'side-wall'});
    }`, map);
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'code.geometry-unresolved'
      && issue.message.includes('side-wall'))).toBe(false);
  });

  it('binds authored routes and network edges to their design groups in the saved map', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'connected garden rooms'});
      api.design({experienceMode:'sequential',intent:'entry to pavilion',groups:[
        {id:'entry',name:'入口',intent:'arrival',layers:[]},
        {id:'pavilion',name:'亭院',intent:'destination',layers:[]}
      ],focuses:[],viewpoints:[],relations:[]});
      api.route({id:'arrival',points:[[0,-20],[0,-5]],groupId:'entry',guideRole:'entry'});
      api.routeNetwork({id:'garden',nodes:[{id:'a',point:[0,-5]},{id:'b',point:[8,8]}],edges:[
        {id:'pavilion-walk',from:'a',to:'b',groupId:'pavilion',guideRole:'axis'}
      ]});
    }`, map);
    const saved = applyMapOperations(map, suggestion.operations);

    expect(saved.designSemantics.groups[0]).toMatchObject({
      guideIds: ['arrival'], entryGuideIds: ['arrival']
    });
    expect(saved.designSemantics.groups[1]).toMatchObject({
      guideIds: ['pavilion-walk'], axisGuideIds: ['pavilion-walk']
    });
    expect(saved.guides.map((guide) => guide.id)).toEqual(['arrival', 'pavilion-walk']);
  });

  it('reports unbound or physically disconnected design-group routes without rejecting the scene', () => {
    const plan = (secondRoute: string) => executeMapCodePlan(`function plan(api) {
      api.sceneIntent({kind:'authored',reason:'two garden rooms'});
      api.design({experienceMode:'sequential',intent:'entry to pavilion',groups:[
        {id:'entry',name:'入口',intent:'arrival',layers:[]},
        {id:'pavilion',name:'亭院',intent:'destination',layers:[]}
      ],focuses:[],viewpoints:[],relations:[]});
      api.place({name:'门',position:[0,-18],groupId:'entry',layer:1,role:'structure'});
      api.place({name:'亭',position:[15,15],groupId:'pavilion',layer:1,role:'structure'});
      api.route({id:'arrival',points:[[0,-22],[0,-8]],${secondRoute}});
      api.route({id:'destination',points:[[15,8],[15,20]]${secondRoute ? ",groupId:'pavilion'" : ''}});
    }`, createEmptyMap(), [], { scope: 'scene' });

    expect(plan('').diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.group-route-unbound', repaired: false })
    ]));
    expect(plan("groupId:'entry'").diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.group-route-disconnected', repaired: false })
    ]));
  });

  it('reports uniform near-to-far grass without rewriting the authored ecology', async () => {
    const map = createEmptyMap('草层修正', 'map-grass-correction');
    const broad = `function plan(api) {
      api.sceneIntent({kind:'natural',reason:'pond meadow'});
      api.water('pond',{type:'lake',points:[[-6,-6],[6,-6],[6,6],[-6,6]],level:-0.2});
      api.grass({id:'blanket',preset:'meadow',region:{kind:'circle',center:[0,0],radius:30},density:0.8,variation:0});
    }`;
    const response = (content: string) => new Response(JSON.stringify({ok:true,content}), {
      status:200,headers:{'Content-Type':'application/json'}
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(broad)).mockResolvedValueOnce(response(JSON.stringify({ edits: [{
      old: "api.grass({id:'blanket',preset:'meadow',region:{kind:'circle',center:[0,0],radius:30},density:0.8,variation:0});",
      new: "api.grass({id:'shore',preset:'wetland',region:{kind:'circle',center:[0,0],radius:30},density:0.8,habitat:{waterDistance:[0,1,3,6]}});\n      api.grass({id:'upland',preset:'meadow',region:{kind:'circle',center:[0,0],radius:30},density:0.6,habitat:{waterDistance:[6,10,30,34]}});"
    }] })));
    expect(executeMapCodePlan(broad, map, [], { scope:'scene' }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code:'scene.vegetation-uniform' })])
    );
    const suggestion = await generateMapCodeSuggestion('池边草地', map, [], {
      apiBase:'https://example.test',provider:'gpt',fetchImpl,
      minNewAssets:0,maxNewAssets:0,scope:'scene'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
    expect(suggestion.operations.filter((operation) => operation.type === 'grass.generate')).toHaveLength(1);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.vegetation-uniform' })
    ]));
  });

  it('keeps the original usable scene without requesting visual correction', async () => {
    const broad = `function plan(api) {
      api.sceneIntent({kind:'natural',reason:'pond meadow'});
      api.water('pond',{type:'lake',points:[[-6,-6],[6,-6],[6,6],[-6,6]],level:-0.2});
      api.grass({id:'blanket',preset:'meadow',region:{kind:'circle',center:[0,0],radius:30},density:0.8});
    }`;
    const response = (content: string) => new Response(JSON.stringify({ok:true,content}), {
      status:200,headers:{'Content-Type':'application/json'}
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(broad)).mockResolvedValueOnce(response('function plan(api) { throw new Error("broken"); }'));
    const suggestion = await generateMapCodeSuggestion('池边草地', createEmptyMap(), [], {
      apiBase:'https://example.test',provider:'gpt',fetchImpl,
      minNewAssets:0,maxNewAssets:0,scope:'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({type:'water.add'}),
      expect.objectContaining({type:'grass.generate',layerId:'blanket'})
    ]));
  });

  it('lets AI select distinct road material recipes for paths and town streets', () => {
    const map = createEmptyMap('material routes');
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'garden-walk',points:[[-12,-4],[0,2],[12,5]],curve:'catmull-rom',width:2.2,material:'garden-stone'});
      api.route({id:'town-street',points:[[-12,0],[12,0]],width:4,material:'asphalt',tags:['street','settlement']});
      api.route({id:'dirt-path',points:[[0,-12],[0,12]],width:1.6,material:'compacted-earth'});
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);

    expect(applied.visualSemantics.zones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'code:route:garden-walk', material: 'garden-stone', tags: expect.arrayContaining(['paving', 'clear']) }),
      expect.objectContaining({ id: 'code:route:town-street', material: 'asphalt', tags: expect.arrayContaining(['paving', 'clear']) }),
      expect.objectContaining({ id: 'code:route:dirt-path', material: 'compacted-earth', tags: expect.arrayContaining(['soil', 'clear']) })
    ]));
  });

  it('compiles a free-form route graph into connected editable branches', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.routeNetwork({
        id:'garden-network',
        nodes:[
          {id:'entry',point:[0,-20],role:'entry'},
          {id:'pond',point:[0,0],role:'junction'},
          {id:'pavilion',point:[-16,12],role:'focus'},
          {id:'rockery',point:[15,15],role:'quiet'}
        ],
        edges:[
          {id:'arrival',from:'entry',to:'pond',via:[[-4,-10]],width:2.4,surface:'paving'},
          {id:'west',from:'pond',to:'pavilion',via:[[-9,4]],curve:'catmull-rom',surface:'soil'},
          {id:'east',from:'pond',to:'rockery',via:[[8,5]],curve:'catmull-rom',surface:'soil'},
          {id:'cross-link',from:'pavilion',to:'rockery',via:[[0,18]],curve:'catmull-rom',surface:'rock'}
        ]
      });
    }`, createEmptyMap());
    const applied = applyMapOperations(createEmptyMap(), suggestion.operations);

    expect(applied.guides).toHaveLength(4);
    expect(applied.guides.filter((guide) => guide.points.some((point) => point[0] === 0 && point[1] === 0))).toHaveLength(3);
    expect(applied.visualSemantics.zones.every((zone) => zone.tags.includes('clear'))).toBe(true);
    expect(suggestion.codePlan?.functions).toContain('routeNetwork');
  });

  it('builds settlement streets and derives roadside objects from a route', () => {
    const lamp = { ...testAsset('asset-town-lamp', '路灯'), tags: ['lamp', 'street'] };
    const map = createEmptyMap('Tool town', 'tool-town', [72, 12, 72]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      const town = api.streetGrid({
        id:'town',
        region:[[-26,-24],[26,-24],[26,24],[-26,24]],
        direction:0,
        blockWidth:12,
        blockDepth:10,
        roadWidth:3,
        material:'asphalt'
      });
      api.placeAlongRoute({
        routeId:town.routeIds[0],
        assetId:'asset-town-lamp',
        name:'路灯',
        spacing:8,
        offset:2,
        side:'both',
        startInset:2,
        endInset:2,
        role:'environment'
      });
    }`, map, [lamp]);
    const applied = applyMapOperations({ ...map, assets: [lamp] }, suggestion.operations);
    const lamps = applied.objects.filter((object) => object.assetId === lamp.id);

    expect(applied.guides.length).toBeGreaterThan(2);
    expect(applied.guides.every((guide) => guide.tags.includes('street'))).toBe(true);
    expect(applied.visualSemantics.zones.every((zone) => zone.material === 'asphalt')).toBe(true);
    expect(lamps.length).toBeGreaterThan(4);
    expect(lamps.every((object) => object.sourceGuideId === applied.guides[0].id)).toBe(true);
    expect(new Set(lamps.map((object) => `${object.transform.position[0]}:${object.transform.position[2]}`)).size)
      .toBe(lamps.length);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['placeAlongRoute', 'streetGrid']));
  });

  it('places varied buildings as a collision-free street frontage with route-derived facing', () => {
    const shop = { ...testAsset('asset-town-shop', '商铺'), tags: ['building', 'shop'] };
    const house = { ...testAsset('asset-town-house', '民居'), tags: ['building', 'house'] };
    const map = createEmptyMap('Frontage town', 'frontage-town', [72, 12, 72]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'main-street',points:[[-24,0],[24,0]],width:4,surface:'paving',tags:['settlement','street']});
      api.placeStreetFrontage({
        routeId:'main-street', side:'left', startInset:3, gap:1, setback:0.8,
        items:[
          {assetId:'asset-town-shop',name:'商铺',dimensions:[8,6,6],role:'structure'},
          {assetId:'asset-town-house',name:'民居',dimensions:[6,5,5],role:'structure'},
          {assetId:'asset-town-shop',name:'商铺',dimensions:[7,6,6],role:'structure'}
        ]
      });
    }`, map, [shop, house]);
    const applied = applyMapOperations({ ...map, assets: [shop, house] }, suggestion.operations);
    const buildings = applied.objects.filter((object) => object.sourceGuideId === 'main-street');
    const boxes = getMapObjectVisualAabbs(applied).filter((box) => buildings.some((object) => object.id === box.objectId));

    expect(buildings).toHaveLength(3);
    expect(buildings.every((object) => object.transform.position[2] > 0)).toBe(true);
    expect(buildings.every((object) => Math.abs(Math.abs(object.transform.rotation[1]) - Math.PI) < 0.001)).toBe(true);
    expect(boxes[0].max[0]).toBeLessThan(boxes[1].min[0]);
    expect(boxes[1].max[0]).toBeLessThan(boxes[2].min[0]);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['placeStreetFrontage', 'route']));
  });

  it('marks frontage routes as streets and preserves authored setbacks on both sides', () => {
    const map = createEmptyMap('street frontage', 'street-frontage', [96, 16, 96]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'street',points:[[-30,0],[30,0]],width:6});
      for (const side of ['left','right']) api.placeStreetFrontage({
        routeId:'street',side,startInset:4,gap:2,setback:3,
        items:[
          {name:'商铺 A',dimensions:[8,6,6],role:'structure'},
          {name:'商铺 B',dimensions:[8,6,6],role:'structure'}
        ]
      });
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);
    expect(applied.guides[0].tags).toContain('street');
    expect(applied.objects).toHaveLength(4);
    expect(applied.objects.every((object) => object.sourceGuideId === 'street')).toBe(true);
    expect(applied.objects.map((object) => object.transform.position)).toEqual([
      [-22, 0, 9], [-12, 0, 9], [-22, 0, -9], [-12, 0, -9]
    ]);
  });

  it('reports unclear group links and a secondary anchor overpowering the primary from entry', async () => {
    const code = `function plan(api) {
      api.sceneIntent({kind:'authored'});
      api.design({
        experienceMode:'sequential', intent:'两处建筑沿路展开',
        groups:[
          {id:'main',name:'主院',intent:'主场景',layers:[]},
          {id:'side',name:'侧院',intent:'次场景',layers:[]}
        ],
        focuses:[
          {id:'main-focus',groupId:'main',name:'主殿',kind:'primary',rank:1,selector:'主殿',reveal:'visible'},
          {id:'side-focus',groupId:'side',name:'侧殿',kind:'secondary',rank:2,selector:'侧殿',reveal:'visible'}
        ],
        viewpoints:[{id:'entry',point:[-12,0],targetFocusId:'main-focus',role:'entry'}],
        relations:[]
      });
      api.place({name:'主殿',position:[8,0],groupId:'main',size:[2,2,2],role:'structure'});
      api.place({name:'侧殿',position:[0,0],groupId:'side',size:[5,5,5],role:'structure'});
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      headers: { 'Content-Type': 'application/json' }
    }));
    const suggestion = await generateMapCodeSuggestion('两处建筑沿路展开', createEmptyMap(), [], {
      legacyApis: true,
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, scope: 'scene', discoveryOnly: true
    });

    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene.group-relations-unclear', repaired: false }),
      expect.objectContaining({ code: 'scene.focus-underdominant', repaired: false })
    ]));
    const connectedCode = code
      .replace('relations:[]', "relations:[{id:'main-side',kind:'support',sourceSelector:'主殿',sourceGroupId:'main',targetGroupId:'side',strength:'normal'}]")
      .replace("size:[2,2,2]", "size:[12,8,8]");
    const connected = await generateMapCodeSuggestion('两处建筑沿路展开', createEmptyMap(), [], {
      legacyApis: true,
      approvedCode: connectedCode, scope: 'scene', discoveryOnly: true
    });
    expect(connected.diagnostics?.some((issue) => issue.code === 'scene.group-relations-unclear'
      || issue.code === 'scene.focus-underdominant')).toBe(false);
  });

  it('removes natural decoration from routes and AI-declared functional clearings without blocking', () => {
    const tree = { ...testAsset('asset-clear-tree', '古树'), tags: ['tree'] };
    const rock = { ...testAsset('asset-clear-rock', '景石'), tags: ['rock'] };
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'main-road',points:[[-12,0],[12,0]],width:3,surface:'paving'});
      api.surface({id:'arena-floor',surface:'sand',region:{kind:'circle',x:0,z:10,radius:6},clearNatural:true});
      api.place({assetId:'asset-clear-tree',name:'道路树',position:[0,0],role:'environment',groupId:'grounds',layer:3});
      api.place({assetId:'asset-clear-rock',name:'场内景石',position:[0,10],role:'environment',groupId:'grounds',layer:4});
      api.place({assetId:'asset-clear-tree',name:'保留树',position:[20,20],role:'environment',groupId:'grounds',layer:3});
    }`, createEmptyMap(), [tree, rock], { spatialPolicy: 'repair' });
    const applied = applyMapOperations({ ...createEmptyMap(), assets: [tree, rock] }, suggestion.operations);

    expect(applied.objects.map((object) => object.name)).toEqual(['保留树']);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'outdoor.clearance-repaired', repaired: true })
    ]));
  });

  it('offers a non-blocking repair diagnostic when bridge scenery bypasses the crossing solver', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({ name: '装饰石桥', position: [0, 0], size: [2, 1, 8] });
    }`, createEmptyMap());

    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'bridge.unresolved-crossing',
        severity: 'warning',
        repaired: false
      })
    ]));
  });

  it('replaces an existing bridge through a refinement delta without resetting the map', async () => {
    const bridge: MapAsset = {
      ...testAsset('asset-stone-bridge', '石拱桥'),
      tags: ['bridge', 'garden'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'bridge-body',
          transform: { pos: [0, 0.5, 0] },
          mesh: { type: 'box', params: { width: 2, height: 1, depth: 4 } }
        }]
      }
    };
    const base = createEmptyMap();
    base.assets = [bridge];
    const initial = executeMapCodePlan(`function plan(api) {
      api.water('garden-pond', { type: 'lake', points: [[-8,-5],[8,-5],[8,5],[-8,5]], level: 0.5 });
      api.place({ assetId: 'asset-stone-bridge', name: '石拱桥', position: [0,0], size: [2,1,4] });
    }`, base, [bridge]);
    const map = applyMapOperations(base, initial.operations);
    map.assets = [bridge];
    const oldBridge = map.objects.find((object) => object.assetId === bridge.id)!;
    const code = `function plan(api) {
      api.bridge({
        waterId: 'garden-pond',
        assetId: 'asset-stone-bridge',
        replaceObjectId: '${oldBridge.id}',
        crossingCenter: [0,0],
        direction: [1,0],
        dimensions: [2,1,4]
      });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('修复石桥，让它连接池塘两岸', map, [bridge], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', scope: 'scene', minNewAssets: 0, maxNewAssets: 0
    });

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      { type: 'object.remove', objectId: oldBridge.id },
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: bridge.id }) })
    ]));
    expect(suggestion.operations.some((operation) => operation.type === 'reference.set')).toBe(false);
  });

  it('lets a refinement continue editing locked objects that belong to the current AI preview', async () => {
    const map = createEmptyMap('Preview town', 'preview-town');
    const house = createMapObject('AI 民居', null);
    house.id = 'preview-house';
    house.locked = true;
    map.objects = [house];
    const code = `function plan(api) {
      api.move({ objectId:'preview-house', position:[12,8] });
    }`;
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('拉开当前预览中重叠的民居', map, [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', scope: 'scene', minNewAssets: 0, maxNewAssets: 0,
      refinableObjectIds: ['preview-house']
    });

    expect(suggestion.operations).toContainEqual(expect.objectContaining({
      type: 'object.update', objectId: 'preview-house'
    }));
  });

  it('keeps persisted locked objects protected and tells repair not to delete the same object', async () => {
    const map = createEmptyMap('Saved town', 'saved-town');
    const house = createMapObject('已保存民居', null);
    house.id = 'saved-house';
    house.locked = true;
    map.objects = [house];
    const code = `function plan(api) { api.move({ objectId:'saved-house', position:[12,8] }); }`;
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(generateMapCodeSuggestion('移动已保存建筑', map, [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', scope: 'scene', minNewAssets: 0, maxNewAssets: 0
    })).rejects.toThrow('map_code_execution_failed:locked_map_code_object:saved-house');

    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages.at(-1).content).toContain('Leave it unchanged');
    expect(repairRequest.messages.at(-1).content).toContain('Do not replace api.move with api.removeObject');
  });

  it('separates severely overlapping outdoor buildings before returning the preview', () => {
    const house: MapAsset = {
      ...testAsset('asset-town-house', '小镇民居'),
      tags: ['building', 'house'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'house',
          transform: { pos: [0, 2.5, 0] },
          mesh: { type: 'box', params: { width: 8, height: 5, depth: 8 } }
        }]
      }
    };
    const map = createEmptyMap('Overlap town', 'overlap-town', [64, 12, 64]);
    map.assets = [house];

    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({ assetId:'asset-town-house', name:'民居 A', position:[0,0], dimensions:[8,5,8], role:'structure' });
      api.place({ assetId:'asset-town-house', name:'民居 B', position:[2,1], dimensions:[8,5,8], role:'structure' });
    }`, map, [house], { spatialPolicy: 'repair' });
    const applied = applyMapOperations(map, suggestion.operations);
    const [left, right] = applied.objects;

    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap', repaired: true })
    ]));
    expect(Math.hypot(
      left.transform.position[0] - right.transform.position[0],
      left.transform.position[2] - right.transform.position[2]
    )).toBeGreaterThan(7.5);
  });

  it('allows facing to override automatic line orientation', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.placeBetween({
          name: 'front-overridden-connection',
          start: [0, 0],
          end: [10, 0],
          dimensions: [10, 2, 1],
          spanAxis: 'x',
          facing: { direction: [1, 0] }
        });
      }
    `, createEmptyMap());
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing connected placement');
    expect(placement.object.transform?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
  });

  it('uses Bezier normals for curved wall facades', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frames = api.sampleBezierFrames([0, -10], [0, -4], [0, 4], [0, 10], 4);
        for (let index = 0; index < frames.length; index += 1) {
          api.place({ name: 'garden-wall', position: frames[index].point, facing: { normal: frames[index].normal } });
        }
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(5);
    if (placements[2].type !== 'object.add') throw new Error('missing wall placement');
    expect(placements[2].object.transform?.rotation?.[1]).toBeCloseTo(-Math.PI / 2);
    expect(suggestion.codePlan?.functions).toEqual(['place', 'sampleBezierFrames']);
  });

  it('samples repeated curve elements by arc length with a configurable spacing gap', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frames = api.sampleBezierFramesBySpacing([0, 0], [0, 10], [0, 20], [0, 30], 5, 0.1);
        for (let index = 0; index < frames.length; index += 1) {
          api.place({ name: 'modular-element', position: frames[index].point, facing: { tangent: frames[index].tangent } });
        }
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');
    const zPositions = placements.map((operation) => {
      if (operation.type !== 'object.add') throw new Error('unexpected operation');
      return operation.object.transform?.position?.[2] ?? 0;
    });
    const distances = zPositions.slice(1).map((value, index) => value - zPositions[index]);

    expect(distances.length).toBeGreaterThan(3);
    expect(distances.every((distance) => distance > 5)).toBe(true);
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.2);
    expect(suggestion.codePlan?.functions).toEqual(['place', 'sampleBezierFramesBySpacing']);
  });

  it('reports declared sightline blockers with distance and approximation evidence', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({name:'view-blocker',position:[0,0,0],size:[2,4,2],terrain:false});
      const sightline=api.sightline({
        from:[-5,2,0],to:[5,2,0],required:true,label:'gate-to-stage'
      });
      if(!sightline.clear) api.place({
        name:sightline.blockers[0].id+'@'+Math.round(sightline.blockers[0].distance),
        position:[0,0,5]
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({ name: 'code-object://0@4' })
      })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'code.geometry-unresolved',
        message: expect.stringMatching(/gate-to-stage.*code-object:\/\/0.*4\.00m.*collider-aabb/i)
      })
    ]));
  });

  it('checks a declared passage with practical body clearance', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({name:'narrow-blocker',position:[0,0,0],size:[1,3,1],terrain:false});
      const passage=api.passage({
        points:[[-4,0],[4,0]],width:1.2,height:1.8,required:true,label:'main-access'
      });
      if(!passage.clear) api.place({
        name:'blocked-'+passage.blockers[0].id,
        position:[0,0,4]
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({ name: 'blocked-code-object://0' })
      })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'code.geometry-unresolved',
        message: expect.stringMatching(/main-access.*code-object:\/\/0.*2\.90m.*collider-aabb/i)
      })
    ]));
  });

  it('measures the gap between declared building parts without moving them', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      const left=api.place({name:'left-wing',position:[-2,0,0],size:[2,2,2],terrain:false});
      const right=api.place({name:'right-wing',position:[2,0,0],size:[2,2,2],terrain:false});
      const gap=api.connectionGap({a:left,b:right,tolerance:0.1,required:true,label:'wing-joint'});
      api.place({name:'gap-'+gap.distance.toFixed(1),position:[0,0,4]});
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({ name: 'gap-2.0' })
      })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'code.geometry-unresolved',
        message: expect.stringMatching(/wing-joint.*2\.00m.*collider-aabb/i)
      })
    ]));
  });

  it('provides bounded minimum-distance environment scattering', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const points = api.poissonDisk({ minDistance: 5, maxPoints: 30, seed: 77 });
        for (const point of points) api.place({ name: 'tree-proxy', position: point });
      }
    `, createEmptyMap());
    const points = suggestion.operations.map((operation) => {
      if (operation.type !== 'object.add') throw new Error('unexpected operation');
      const position = operation.object.transform?.position;
      return [position?.[0] ?? 0, position?.[2] ?? 0] as const;
    });
    expect(points.length).toBeGreaterThan(5);
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        expect(Math.hypot(points[left][0] - points[right][0], points[left][1] - points[right][1])).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('samples deterministic points from an arbitrary bounded probability field', () => {
    const code = `function plan(api) {
      const points = api.sampleProbabilityField(
        { bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20}, maxPoints:40, candidates:400, minDistance:2, seed:91 },
        point => {
          const radius = Math.hypot(point.x, point.z);
          return (1 - api.smoothstep(4, 18, radius)) * (0.55 + 0.45 * api.noise2D(point.x, point.z, 0.15, 7));
        }
      );
      for (const point of points) api.place({name:'tree-proxy',position:point});
    }`;
    const first = executeMapCodePlan(code, createEmptyMap());
    const second = executeMapCodePlan(code, createEmptyMap());
    const positions = first.operations.flatMap((operation) => operation.type === 'object.add'
      ? [operation.object.transform?.position]
      : []).filter(Boolean);

    expect(positions.length).toBeGreaterThan(5);
    const secondPositions = second.operations.flatMap((operation) => operation.type === 'object.add'
      ? [operation.object.transform?.position]
      : []).filter(Boolean);
    expect(positions).toEqual(secondPositions);
    expect(positions.every((position) => Math.hypot(position?.[0] ?? 99, position?.[2] ?? 99) < 18)).toBe(true);
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        expect(Math.hypot(
          (positions[left]?.[0] ?? 0) - (positions[right]?.[0] ?? 0),
          (positions[left]?.[2] ?? 0) - (positions[right]?.[2] ?? 0)
        )).toBeGreaterThanOrEqual(2);
      }
    }
    expect(first.codePlan?.functions).toEqual(expect.arrayContaining(['noise2D', 'place', 'sampleProbabilityField']));
  });

  it('inherits the map seed when a probability field does not override it', () => {
    const code = `function plan(api) {
      const points = api.sampleProbabilityField(
        { bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20}, maxPoints:12, candidates:24 },
        () => 1
      );
      for (const point of points) api.place({name:'seeded-point',position:point});
    }`;
    const positionsFor = (seed: number) => {
      const map = createEmptyMap();
      map.seed = seed;
      return executeMapCodePlan(code, map).operations.flatMap((operation) => operation.type === 'object.add'
        ? [operation.object.transform?.position]
        : []);
    };

    expect(positionsFor(11)).toEqual(positionsFor(11));
    expect(positionsFor(11)).not.toEqual(positionsFor(99));
  });

  it('shares one environment sample across direct, probability, and grass callbacks', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.route({id:'road',points:[[-20,0],[20,0]],width:2,surface:'none'});
      api.water('pond',{type:'lake',points:[[-2,8],[2,8],[2,12],[-2,12]],level:0,depth:1});
      const environment={guideIds:['road'],region:{kind:'circle',x:0,z:0,radius:6}};
      const direct=api.environmentSample([0,4],environment);
      api.place({name:['env',direct.height,direct.slope,direct.waterDistance,direct.guideDistance,direct.regionDistance].join('-'),position:[0,0,20]});
      const points=api.sampleProbabilityField({
        bounds:{minX:-8,maxX:8,minZ:-8,maxZ:8},maxPoints:5,candidates:20,seed:17,...environment
      }, sample => {
        const same=api.environmentSample([sample.x,sample.z],environment);
        return same.height===sample.height && same.slope===sample.slope
          && same.waterDistance===sample.waterDistance && same.guideDistance===sample.guideDistance
          && same.regionDistance===sample.regionDistance ? 1 : 0;
      });
      for(const point of points) api.place({name:'shared-probability',position:point});
      api.grassField({id:'shared-grass',resolution:[3,3],...environment}, sample => {
        const same=api.environmentSample([sample.x,sample.z],environment);
        return same.height===sample.height && same.slope===sample.slope
          && same.waterDistance===sample.waterDistance && same.guideDistance===sample.guideDistance
          && same.regionDistance===sample.regionDistance ? 1 : 0;
      });
    }`, createEmptyMap());
    const names = suggestion.operations.flatMap((operation) => operation.type === 'object.add' ? [operation.object.name] : []);
    const density = suggestion.operations.find((operation) => operation.type === 'grass.density.set');

    expect(names.find((name) => name?.startsWith('env-'))).toMatch(/^env-0-0-\d+(?:\.\d+)?-3--2$/);
    expect(names.filter((name) => name === 'shared-probability')).toHaveLength(5);
    expect(density?.type).toBe('grass.density.set');
    if (density?.type !== 'grass.density.set') throw new Error('missing shared grass field');
    expect(density.densities).toEqual(new Array(9).fill(1));
  });

  it('samples deterministic clustered marks with per-mark spacing and quotas', () => {
    const code = `function plan(api) {
      const points=api.sampleProbabilityField({
        bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20},maxPoints:42,candidates:4096,minDistance:0.2,seed:73,
        marks:[
          {id:'tree',minDistance:5,maxPoints:12,cluster:{strength:0.8,scale:0.08,seed:11}},
          {id:'flower',minDistance:1,maxPoints:30,cluster:{strength:0.35,scale:0.18,seed:29}}
        ]
      }, sample => ({
        tree:0.4*(1-api.smoothstep(10,26,Math.hypot(sample.x,sample.z))),
        flower:0.8
      }));
      for(const point of points) api.place({name:point.mark,position:point});
    }`;
    const map = createEmptyMap();
    const first = executeMapCodePlan(code, map);
    const second = executeMapCodePlan(code, map);
    const placements = (suggestion: typeof first) => suggestion.operations.flatMap((operation) => {
      if (operation.type !== 'object.add') return [];
      return [{
        name: operation.object.name,
        position: operation.object.transform?.position?.slice() ?? []
      }];
    });
    const result = placements(first);
    const trees = result.filter((item) => item.name === 'tree');
    const flowers = result.filter((item) => item.name === 'flower');

    expect(placements(second)).toEqual(result);
    expect(trees).toHaveLength(12);
    expect(flowers).toHaveLength(30);
    for (const group of [{ items: trees, spacing: 5 }, { items: flowers, spacing: 1 }]) {
      for (let left = 0; left < group.items.length; left += 1) {
        for (let right = left + 1; right < group.items.length; right += 1) {
          expect(Math.hypot(
            group.items[left].position[0] - group.items[right].position[0],
            group.items[left].position[2] - group.items[right].position[2]
          )).toBeGreaterThanOrEqual(group.spacing);
        }
      }
    }
  });

  it('serializes custom grass callbacks into a bounded density operation', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('hills', {amplitude:4, roughness:0.3, seed:17});
      api.grassField({id:'wild-growth',preset:'meadow',resolution:[5,4]}, sample => {
        const centerFalloff = 1 - Math.min(1, Math.hypot(sample.x, sample.z) / 30);
        return centerFalloff * (sample.slope < 35 ? 1 : 0);
      });
    }`, createEmptyMap());
    const density = suggestion.operations.find((operation) => operation.type === 'grass.density.set');

    expect(density).toEqual(expect.objectContaining({
      type: 'grass.density.set',
      layerId: 'wild-growth',
      resolutionX: 5,
      resolutionZ: 4
    }));
    if (density?.type !== 'grass.density.set') throw new Error('missing density field');
    expect(density.densities).toHaveLength(20);
    expect(density.densities.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(suggestion.codePlan?.functions).toEqual(['grassField', 'terrain']);
  });

  it('lets a model-authored cost function solve attraction and repulsion without moving fixed anchors', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      const initial = [
        {id:'table',position:[8,2],fixed:true},
        {id:'chair-a',position:[-12,-9]},
        {id:'chair-b',position:[-10,-8]}
      ];
      const solved = api.optimizeLayout({
        items:initial,bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20},
        iterations:512,translationStep:5,rotationStep:0,seed:33
      }, items => {
        const table = items[0];
        const a = items[1];
        const b = items[2];
        const targetA = (a.position.x - (table.position.x - 4)) ** 2 + (a.position.z - table.position.z) ** 2;
        const targetB = (b.position.x - (table.position.x + 4)) ** 2 + (b.position.z - table.position.z) ** 2;
        const separation = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        const repel = Math.max(0, 6 - separation) ** 2 * 8;
        return targetA + targetB + repel;
      });
      for (const item of solved) api.place({name:item.id,position:item.position});
    }`, createEmptyMap());
    const placements = suggestion.operations.flatMap((operation) => operation.type === 'object.add'
      ? [{ name: operation.object.name, position: operation.object.transform?.position }]
      : []);
    const byName = new Map(placements.map((item) => [item.name, item.position]));
    const table = byName.get('table');
    const chairA = byName.get('chair-a');
    const chairB = byName.get('chair-b');

    expect(table).toEqual([8, 0, 2]);
    expect(Math.hypot((chairA?.[0] ?? 99) - 4, (chairA?.[2] ?? 99) - 2)).toBeLessThan(1.5);
    expect(Math.hypot((chairB?.[0] ?? 99) - 12, (chairB?.[2] ?? 99) - 2)).toBeLessThan(1.5);
    expect(Math.hypot(
      (chairA?.[0] ?? 0) - (chairB?.[0] ?? 0),
      (chairA?.[2] ?? 0) - (chairB?.[2] ?? 0)
    )).toBeGreaterThan(6);
    expect(suggestion.codePlan?.functions).toEqual(['optimizeLayout', 'place']);
  });

  it('rejects non-finite model-authored layout costs', () => {
    expect(() => executeMapCodePlan(`function plan(api) {
      api.optimizeLayout({items:[{id:'a',position:[0,0]}]}, () => Infinity);
    }`, createEmptyMap())).toThrow('invalid_layout_optimizer_cost');
  });

  it('accepts common object and corner-pair bounds for Poisson scattering', () => {
    for (const bounds of [
      `{ xMin:-12, xMax:12, zMin:-8, zMax:8 }`,
      `[[-12,-8],[12,8]]`
    ]) {
      const suggestion = executeMapCodePlan(`function plan(api) {
        const points = api.poissonDisk({ bounds:${bounds}, minDistance:4, maxPoints:12, seed:api.seed });
        for (const point of points) api.place({ name:'tree-proxy', position:point });
      }`, createEmptyMap());
      const positions = suggestion.operations.flatMap((operation) => {
        const position = operation.type === 'object.add' ? operation.object.transform?.position : undefined;
        return position ? [position] : [];
      });

      expect(positions.length).toBeGreaterThan(1);
      expect(positions.every(([x, _y, z]) => x >= -12 && x <= 12 && z >= -8 && z <= 8)).toBe(true);
    }
  });

  it('exposes generated points through array and named coordinates', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const point = api.poissonDisk({ minDistance: 5, maxPoints: 1 })[0];
        api.place({ position: [point.x, point.z] });
      }
    `, createEmptyMap());
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing placement');
    expect(placement.object.transform?.position?.every(Number.isFinite)).toBe(true);
  });

  it('mirrors authored decoration points across a declared coordinate axis', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      const left = [-7, 4];
      const right = api.mirrorPoint(left, 'x', 0);
      api.place({ name:'左旗', position:left, groupId:'gate', layer:3 });
      api.place({ name:'右旗', position:right, groupId:'gate', layer:3 });
    }`, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements.map((operation) => operation.object.transform?.position)).toEqual([
      [-7, 0, 4],
      [7, 0, 4]
    ]);
    expect(suggestion.codePlan?.functions).toContain('mirrorPoint');
  });

  it('blocks host globals and runaway code', () => {
    expect(() => executeMapCodePlan('function plan(api) { process.cwd(); api.place({ position:[0,0] }); }', createEmptyMap()))
      .toThrow();
    expect(() => executeMapCodePlan('function plan() { while (true) {} }', createEmptyMap(), [], { executionTimeoutMs: 10 }))
      .toThrow();
  });

  it('degrades invented asset ids instead of failing the entire code plan', () => {
    const knownAsset = testAsset('asset-real-sign', 'Neon sign');
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.place({ assetId: 'asset-invented', name: 'Neon sign', position: [0, 0] });
        api.place({ assetId: 'asset-still-missing', name: 'Unknown kiosk', position: [4, 0] });
      }
    `, createEmptyMap(), [knownAsset]);
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements[0].object.assetId).toBe('asset-real-sign');
    expect(placements[1].object.assetId).toBeNull();
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'asset.unplaced', severity: 'warning' })
    ]));
  });

  it('discovers bounded generated asset requirements', () => {
    const code = `
      function plan(api) {
        const pine = api.requireAsset({
          key: 'pine',
          name: 'Tall pine',
          prompt: 'Standalone low-poly tall pine tree, no ground or background',
          tags: ['Tree', 'pine'],
          variants: 3
        });
        for (let index = 0; index < 3; index += 1) {
          api.place({ assetId: api.asset(pine, index), position: [index * 2, 0] });
        }
      }
    `;

    expect(discoverMapCodeAssets(code, createEmptyMap(), [], 3)).toEqual([{
      key: 'pine',
      name: 'Tall pine',
      prompt: 'Standalone low-poly tall pine tree, no ground or background',
      tags: ['tree', 'pine'],
      variants: 3
    }]);
    expect(discoverMapCodeAssets(code, createEmptyMap(), [], 1)).toHaveLength(1);
    expect(() => discoverMapCodeAssets(code.replace('const pine =', "api.requireAsset({ key: 'rock', name: 'Rock', prompt: 'Rock' }); const pine ="), createEmptyMap(), [], 1))
      .toThrow('map_code_asset_requirement_limit');
  });

  it('keeps joining details at the end of an asset prompt and rejects overlong descriptions', () => {
    const prompt = `${'Stone nave with structural bays. '.repeat(18)}Front at Z+ is a flat joining face for the west facade.`;
    const code = (description: string) => `function plan(api) {
      const nave = api.requireAsset({key:'nave',name:'Nave',prompt:${JSON.stringify(description)},role:'structure'});
      api.place({assetId:api.asset(nave),position:[0,0],role:'structure'});
    }`;

    expect(prompt.length).toBeGreaterThan(500);
    expect(discoverMapCodeAssets(code(prompt), createEmptyMap())[0]?.prompt).toBe(prompt);
    expect(() => discoverMapCodeAssets(code('x'.repeat(1201)), createEmptyMap()))
      .toThrow('map_code_asset_prompt_too_long');
  });

  it('prunes unused trailing variants instead of requesting a full code rewrite', () => {
    expect(discoverMapCodeAssets(`
      function plan(api) {
        const wall = api.requireAsset({ key: 'wall', name: 'Wall', prompt: 'Wall', variants: 3 });
        api.place({ assetId: api.asset(wall, 0), position: [0, 0] });
        api.place({ assetId: api.asset(wall, 1), position: [4, 0] });
      }
    `, createEmptyMap(), [], 3)).toEqual([
      expect.objectContaining({ key: 'wall', variants: 3, generatedVariants: 2 })
    ]);
  });

  it('normalizes non-ASCII internal asset keys without rewriting user-facing names', () => {
    const requirements = discoverMapCodeAssets(`function plan(api) {
      const wing=api.requireAsset({key:'翼楼',name:'神殿翼楼',prompt:'Standalone temple wing',role:'structure'});
      api.place({assetId:api.asset(wing,0),position:[0,0],role:'structure'});
    }`, createEmptyMap(), [], 2);

    expect(requirements).toEqual([
      expect.objectContaining({ key: expect.stringMatching(/^asset-[a-z0-9]+$/), name: '神殿翼楼' })
    ]);
  });

  it('accepts an explicit no-change result during refinement without repair retries', async () => {
    const code = `function plan(api) {
      api.noChange('当前构图已经满足调整要求');
    }`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('检查当前构图是否需要调整', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', minNewAssets: 0, maxNewAssets: 0
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations).toEqual([]);
    expect(suggestion.summary).toBe('无需调整：当前构图已经满足调整要求');
    expect(suggestion.codePlan?.functions).toContain('noChange');
    expect(suggestion.codePlan?.repairAttempts).toBe(0);
  });

  it('generates only the contiguous asset variants used by the plan', async () => {
    const code = `function plan(api) {
      const tree = api.requireAsset({
        key:'tree', name:'树', prompt:'树', variants:3, role:'environment', optional:true
      });
      api.place({ assetId:api.asset(tree,0), position:[-4,0], role:'environment' });
      api.place({ assetId:api.asset(tree,1), position:[4,0], role:'environment' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async (request) => testAsset(`asset-${request.name}`, request.name));

    const suggestion = await generateMapCodeSuggestion('生成两棵树', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 3, createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(2);
    expect(suggestion.codePlan?.assetRequirements).toEqual([
      expect.objectContaining({ key: 'tree', variants: 2 })
    ]);
  });

  it('generates variants concurrently and replays code with real asset ids', async () => {
    const code = `
      function plan(api) {
        const pine = api.requireAsset({
          key: 'pine', name: 'Pine', prompt: 'Standalone pine tree', tags: ['tree'], variants: 3,
          dimensions: [2, 4, 2], role: 'environment'
        });
        for (let index = 0; index < 6; index += 1) {
          api.place({ assetId: api.asset(pine, index), position: [index * 2, 0] });
        }
      }
    `;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    let active = 0;
    let peak = 0;
    const createAsset = vi.fn(async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return testAsset(`asset-${request.name}`, request.name);
    });

    const suggestion = await generateMapCodeSuggestion('make a pine grove', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      maxNewAssets: 3,
      createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(3);
    expect(createAsset.mock.calls[0][0].prompt).toContain('local Z+ is the front');
    expect(createAsset.mock.calls[0][0].prompt).toContain('width=2, height=4, depth=2 world units');
    expect(createAsset.mock.calls.map(([request]) => ({
      seedFamilyKey: request.seedFamilyKey,
      variantIndex: request.variantIndex,
      variantCount: request.variantCount
    }))).toEqual([
      { seedFamilyKey: 'pine', variantIndex: 0, variantCount: 3 },
      { seedFamilyKey: 'pine', variantIndex: 1, variantCount: 3 },
      { seedFamilyKey: 'pine', variantIndex: 2, variantCount: 3 }
    ]);
    expect(peak).toBe(3);
    expect(suggestion.generatedAssets).toHaveLength(3);
    const assetIds = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object.assetId);
    expect(new Set(assetIds).size).toBe(3);
    expect(assetIds.slice(0, 3)).toEqual(assetIds.slice(3, 6));
    expect(() => applyMapOperations(createEmptyMap(), suggestion.operations)).not.toThrow();
  });

  it('reuses the environment state across bounded keepDry placement loops', () => {
    const routes = Array.from({ length: 17 }, (_, index) => `
      api.route({
        id:'route-${index}', points:[[-40,${index - 8}],[40,${index - 8}]],
        width:2, surface:'paving'
      });
    `).join('');
    expect(() => discoverMapCodeAssets(`function plan(api) {
      api.terrain({ preset:'plain', amplitude:0.2 });
      api.water('pond', {
        type:'lake', points:[[-10,-10],[10,-10],[10,10],[-10,10]], level:0, depth:1
      });
      ${routes}
      for (let index = 0; index < 160; index += 1) {
        api.place({
          name:'岸边石', role:'environment',
          position:api.keepDry([25, index * 0.05])
        });
      }
    }`, createEmptyMap('Dry cache', 'dry-cache', [96, 16, 96]), [], 0)).not.toThrow();
  });

  it('reuses successful seeded variants when one replay fails', async () => {
    const code = `function plan(api) {
      const pine = api.requireAsset({
        key: 'pine', name: 'Pine', prompt: 'Standalone pine tree', tags: ['tree'],
        variants: 3, role: 'environment'
      });
      for (let index = 0; index < 6; index += 1) {
        api.place({ assetId: api.asset(pine, index), position: [index * 2, 0], role: 'environment' });
      }
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async (request: { name: string; variantIndex?: number }) => {
      if (request.variantIndex === 1) throw new Error(`map_asset_generation_failed:${request.name}:replay_exec_failed`);
      return testAsset(`asset-${request.variantIndex}`, request.name);
    });

    const suggestion = await generateMapCodeSuggestion('make a pine grove', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, maxNewAssets: 3, createAsset
    });
    const assetIds = suggestion.operations.flatMap((operation) => (
      operation.type === 'object.add' && operation.object.assetId ? [operation.object.assetId] : []
    ));

    expect(assetIds).toHaveLength(6);
    expect(new Set(assetIds)).toEqual(new Set(['asset-0', 'asset-2']));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'asset.generation-degraded', severity: 'warning' })
    ]));
  });

  it('streams the discovered layout and each finished asset for live viewport preview', async () => {
    const code = `function plan(api) {
      api.terrain('plain');
      const desk = api.requireAsset({
        key: 'desk', name: '书桌', prompt: 'wooden desk', tags: ['furniture'],
        variants: 2, dimensions: [1.6, 0.75, 0.8]
      });
      api.place({ assetId: api.asset(desk, 0), position: [1.5, 0], dimensions: [1.6, 0.75, 0.8] });
      api.place({ assetId: api.asset(desk, 1), position: [-1.5, 0] });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const plans: CodePlanPreviewPayload[] = [];
    const assetsReady: CodePlanAssetReadyPayload[] = [];
    const createAsset = vi.fn(async (request: { name: string }) => testAsset(`asset-${request.name}`, request.name));

    await generateMapCodeSuggestion('make a two-desk study', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      maxNewAssets: 2,
      onPlanPreview: (plan) => plans.push(plan),
      onAssetReady: (event) => assetsReady.push(event),
      createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(2);
    expect(plans).toHaveLength(2);
    const [draft, validated] = plans;
    expect(draft.summary).toContain('代码已执行');
    expect(draft.placements).toHaveLength(2);
    expect(draft.placements.every((placement) => placement.pending && placement.assetId?.startsWith('code-asset://desk/'))).toBe(true);
    expect(draft.placements.map((placement) => placement.size)).toEqual([[1.6, 0.75, 0.8], [1, 1, 1]]);
    expect(draft.placements.map((placement) => placement.placeholderSize)).toEqual([undefined, [1.6, 0.75, 0.8]]);
    expect(draft.placements.map((placement) => placement.fitToDimensions)).toEqual([true, undefined]);
    expect(draft.sceneOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' })
    ]));
    expect(validated.placements).toHaveLength(2);
    expect(validated.placements.every((placement) => placement.pending && placement.assetId?.startsWith('code-asset://desk/'))).toBe(true);
    expect(validated.placements.every((placement) => placement.heightMode === 'terrain')).toBe(true);
    expect(validated.placements.map((placement) => placement.size)).toEqual([[1.6, 0.75, 0.8], [1, 1, 1]]);
    expect(validated.placements.map((placement) => placement.placeholderSize)).toEqual([undefined, [1.6, 0.75, 0.8]]);
    expect(validated.placements.map((placement) => placement.fitToDimensions)).toEqual([true, undefined]);
    expect(validated.sceneOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' })
    ]));
    expect(validated.requirements).toEqual([{ key: 'desk', name: '书桌', variants: 2 }]);
    expect(assetsReady.map((event) => `${event.key}/${event.variantIndex}`).sort()).toEqual(['desk/0', 'desk/1']);
    expect(assetsReady.every((event) => event.asset.id.startsWith('asset-'))).toBe(true);
  });

  it('streams the plan preview before returning a discovery-only suggestion', async () => {
    const map = createEmptyMap('Study', 'indoor-plan-only', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const code = `function plan(api) {
      const shelf = api.requireAsset({
        key: 'shelf', name: '书架', prompt: 'tall bookshelf', tags: ['furniture'],
        variants: 1, dimensions: [1.2, 2.2, 0.4], role: 'functional'
      });
      api.place({ assetId: api.asset(shelf, 0), position: api.roomPoint(-3, 2, 0), role: 'functional' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const plans: CodePlanPreviewPayload[] = [];

    const suggestion = await generateMapCodeSuggestion('indoor study wall', map, [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      scope: 'scene',
      discoveryOnly: true,
      onPlanPreview: (plan) => plans.push(plan)
    });

    expect(suggestion.codePlan?.assetRequirements).toEqual([expect.objectContaining({ key: 'shelf', variants: 1 })]);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.placements).toHaveLength(1);
      expect(plan.placements[0]).toEqual(expect.objectContaining({
        pending: true,
        assetId: 'code-asset://shelf/0',
        size: [1, 1, 1],
        placeholderSize: [1.2, 2.2, 0.4],
        role: 'functional'
      }));
      expect(plan.requirements[0]).toEqual(expect.objectContaining({ key: 'shelf', role: 'functional' }));
    }
  });

  it('does not execute unchanged code again after a repair response is rejected', async () => {
    const code = `function plan(api) {
      api.terrain('plain');
      const hut = api.requireAsset({
        key: 'hut', name: '小屋', prompt: 'small hut', tags: ['building'],
        variants: 1, dimensions: [4, 3, 4], role: 'structure'
      });
      api.place({ assetId: api.asset(hut, 0), position: [2, 0], role: 'structure' });
      crashHere.x = 1;
    }`;
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const plans: CodePlanPreviewPayload[] = [];

    await expect(generateMapCodeSuggestion('make a hut', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      onPlanPreview: (plan) => plans.push(plan)
    })).rejects.toThrow('map_code_execution_failed');

    // Both invalid repair responses are rejected without rerunning the same program.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(plans).toHaveLength(1);
    for (const plan of plans) {
      expect(plan.summary).toContain('执行中断');
      expect(plan.placements).toHaveLength(1);
      expect(plan.placements[0]).toEqual(expect.objectContaining({
        pending: true,
        assetId: 'code-asset://hut/0',
        size: [1, 1, 1],
        placeholderSize: [4, 3, 4],
        role: 'structure'
      }));
      expect(plan.sceneOperations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'terrain.generate' })
      ]));
    }
  });

  it('keeps the usable scene when a required generated asset fails and reports a repairable warning', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: 'A designed garden' });
      api.terrain('plain');
      const corridor = api.requireAsset({
        key: 'corridor', name: '游廊', prompt: 'Chinese garden covered corridor',
        tags: ['garden', 'corridor'], variants: 1, role: 'structure'
      });
      const willow = api.requireAsset({
        key: 'willow', name: '水柳', prompt: 'Willow tree',
        tags: ['tree', 'willow'], variants: 1, role: 'environment'
      });
      api.place({ assetId: api.asset(corridor, 0), name: '游廊', position: [-5, 0], role: 'structure' });
      api.place({ assetId: api.asset(willow, 0), name: '水柳', position: [5, 0], role: 'environment' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async (request: { name: string }) => {
      if (request.name === '游廊') throw new Error('map_asset_generation_failed:游廊:gpt: HTTP 500');
      return testAsset('asset-willow', request.name);
    });

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
      scope: 'scene', minNewAssets: 2, maxNewAssets: 2
    });

    expect(suggestion.generatedAssets).toEqual([{ id: 'asset-willow', name: '水柳' }]);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' }),
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: 'asset-willow' }) })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'asset.generation-degraded',
        severity: 'warning',
        repaired: false,
        message: expect.stringContaining('游廊')
      })
    ]));
  });

  it('asks the AI to repair non-finite code once before failing the plan', async () => {
    const brokenCode = `
      function plan(api) {
        const points = [];
        for (let i = 0; i <= 4; i++) {
          const t = i / 4;
          points.push([-5 + 10 * t, 3 * Math.sin(t * Math.PI)]);
        }
        for (let index = 0; index < points.length; index += 1) {
          api.place({ position: [points[index][0], points[index + 1][1]] });
        }
      }
    `;
    const repairedCode = JSON.stringify({ edits: [{
      old: 'api.place({ position: [points[index][0], points[index + 1][1]] });',
      new: 'api.place({ position: points[index] });'
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(brokenCode))
      .mockResolvedValueOnce(response(repairedCode));

    const suggestion = await generateMapCodeSuggestion('make a curved trail', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.codePlan?.code).toContain('position: points[index]');
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(5);
  });

  it('gives timeout-specific guidance when repairing an oversized map loop', async () => {
    const brokenCode = `
      function plan(api) {
        let total = 0;
        for (let index = 0; index < 1_000_000_000; index += 1) total += index % 2;
        api.place({ name: 'marker', position: [total, 0] });
      }
    `;
    const repairedCode = JSON.stringify({ edits: [{
      old: 'let total = 0;\n        for (let index = 0; index < 1_000_000_000; index += 1) total += index % 2;\n        api.place({ name: \'marker\', position: [total, 0] });',
      new: 'for (let i = 0; i < 16; i++) {\n          api.place({ name: \'marker\', position: [(i % 4) * 6 - 9, Math.floor(i / 4) * 6 - 9] });\n        }'
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(brokenCode))
      .mockResolvedValueOnce(response(repairedCode));

    const suggestion = await generateMapCodeSuggestion('make a large plaza', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      discoveryExecutionTimeoutMs: 10
    });

    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages.at(-1).content).toContain('Do not scale loop counts from map width, map area, or fine coordinate steps');
    expect(repairRequest.messages.at(-1).content).not.toMatch(/api\.(streetGrid|placeStreetFrontage|grassField)\b/);
    expect(repairRequest).toMatchObject({ maxTokens: 8_000, thinking: false });
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(16);
  });

  it('gives validated final replay more time than discovery after real asset binding', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'性能回归测试' });
      const house = api.asset(api.requireAsset({
        key:'house', name:'民居', prompt:'compact town house', tags:['building'],
        variants:1, dimensions:[8,5,8], role:'structure'
      }));
      if (!house.startsWith('code-asset://')) {
        let checksum = 0;
        for (let index = 0; index < 350000000; index += 1) checksum += index % 7;
        if (checksum < 0) throw new Error('unreachable');
      }
      api.place({ assetId:house, name:'民居', position:[0,0], dimensions:[8,5,8], role:'structure' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async () => testAsset('asset-house', '民居'));

    const suggestion = await generateMapCodeSuggestion('生成紧凑小镇', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 1, maxNewAssets: 1, scope: 'scene', createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(suggestion.generatedAssets).toEqual([{ id: 'asset-house', name: '民居' }]);
  });

  it('replays a timed-out final layout with saved asset bindings instead of regenerating assets', async () => {
    const map = createEmptyMap('Replay town', 'replay-town');
    const code = `function plan(api) {
      api.sceneIntent({ kind:'authored', reason:'重放恢复测试' });
      const house = api.asset(api.requireAsset({
        key:'house', name:'民居', prompt:'compact town house', tags:['building'],
        variants:1, dimensions:[8,5,8], role:'structure'
      }));
      if (house === 'asset-replay-house') {
        const samples = [];
        for (let index = 0; index < 500000; index += 1) samples.push(api.random());
        if (samples.length < 0) throw new Error('unreachable');
      }
      api.place({ assetId:house, name:'民居', position:[0,0], dimensions:[8,5,8], role:'structure' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async () => testAsset('asset-replay-house', '民居'));
    let replayToken = '';
    let replayError = '';

    try {
      await generateMapCodeSuggestion('生成紧凑小镇', map, [], {
        apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
        minNewAssets: 1, maxNewAssets: 1, scope: 'scene', createAsset,
        finalExecutionTimeoutMs: 1
      });
    } catch (error) {
      replayError = error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error ?? '');
      replayToken = replayError
        .match(/^map_code_final_replay_timed_out:(code-replay-[a-z0-9-]+)$/i)?.[1] ?? '';
    }

    expect(replayToken, replayError).not.toBe('');
    const replayed = replayGeneratedMapCode(replayToken, map);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(replayed.generatedAssets).toEqual([{ id: 'asset-replay-house', name: '民居' }]);
    expect(replayed.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: 'asset-replay-house' }) })
    ]));
    expect(() => replayGeneratedMapCode(replayToken, map)).toThrow('map_code_replay_expired');
  });

  it('replans when the code declares fewer than the requested new assets', async () => {
    const reusedOnlyCode = `
      function plan(api) {
        api.place({ name: 'proxy', position: [0, 0] });
      }
    `;
    const generatedAssetCode = JSON.stringify({ edits: [{
      old: "api.place({ name: 'proxy', position: [0, 0] });",
      new: "api.place({ name: 'proxy', position: [0, 0] });\n        const signs = api.requireAsset({ key: 'neon-sign', name: 'Neon sign', prompt: 'Standalone cyberpunk neon sign', variants: 1 });\n        const lamps = api.requireAsset({ key: 'street-lamp', name: 'Street lamp', prompt: 'Standalone cyberpunk street lamp', variants: 1 });\n        api.place({ assetId: api.asset(signs, 0), position: [-2, 0] });\n        api.place({ assetId: api.asset(lamps, 0), position: [2, 0] });"
    }] });
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(reusedOnlyCode))
      .mockResolvedValueOnce(response(generatedAssetCode));
    const createAsset = vi.fn(async (request) => testAsset(`asset-${request.name}`, request.name));

    const suggestion = await generateMapCodeSuggestion('make a cyberpunk street', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      minNewAssets: 2,
      maxNewAssets: 4,
      createAsset
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(createAsset).toHaveBeenCalledTimes(2);
    expect(suggestion.generatedAssets).toHaveLength(2);
  });
});

function testAsset(id: string, name: string): MapAsset {
  return {
    id,
    name,
    prompt: name,
    tags: ['tree'],
    modelJson: {},
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    mode: 'voxel',
    createdAt: 1,
    updatedAt: 1
  };
}

function horizontalSpanEndpoint(
  object: Extract<ReturnType<typeof executeMapCodePlan>['operations'][number], { type: 'object.add' }>['object'],
  asset: MapAsset,
  direction: -1 | 1
): [number, number] {
  const transform = object.transform;
  if (!transform?.scale || !transform.size || !transform.rotation || !transform.position) {
    throw new Error('missing object transform');
  }
  const localWidth = Number((asset.modelJson as { nodes: Array<{ mesh: { params: { width: number } } }> }).nodes[0].mesh.params.width);
  const halfLength = localWidth * transform.scale[0] * transform.size[0] / 2;
  const yaw = transform.rotation[1];
  return [
    transform.position[0] + Math.cos(yaw) * halfLength * direction,
    transform.position[2] - Math.sin(yaw) * halfLength * direction
  ];
}
