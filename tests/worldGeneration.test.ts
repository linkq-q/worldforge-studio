import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Euler, Quaternion } from 'three';
import { createEmptyMap, createMapObject, getObjectWorldTransforms, type MapAsset } from '../src/shared/map';
import { createWorldSampler } from '../src/shared/worldTerrain';
import {
  assembleWorldModel, auditWorldCandidatePacking, auditWorldIslandBoundary, auditWorldIslandLandmass, auditWorldSettlementAcceptance, auditWorldSettlementCoverage, compileWorldDraft, createWorldSitingEvidence, generateWorld, generateWorldAssets,
  materializeWorldIntent, parseWorldIntentDraft, validateWorldGenerationRequest, worldAssetStrategy,
  WORLD_GENERATION_PROMPT, type WorldAssetRequest, type WorldGenerationRequest
} from '../src/server/worldGeneration';
import type { MapStore } from '../src/server/mapStore';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), generateModel: vi.fn(), recordGenerationTrace: vi.fn() }));
vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(),
  llmChat: mocks.llmChat,
  generateModel: mocks.generateModel
}));
vi.mock('../src/server/generationTrace', () => ({ recordGenerationTrace: mocks.recordGenerationTrace }));

const request: WorldGenerationRequest = { prompt: 'A compact grassland town', seed: 2309, size: 1600, generateAssets: false };

it('accepts three bounded intent repairs but rejects larger retry counts',()=>{
  expect(validateWorldGenerationRequest({...request,repairAttempts:3}).repairAttempts).toBe(3);
  expect(()=>validateWorldGenerationRequest({...request,repairAttempts:4})).toThrow('invalid_world_generation_request');
});

it('reports when every candidate pair overlaps connected town cores',()=>{
  const towns=[{id:'bay',radius:110},{id:'farm',radius:58}],roads=[{id:'farm-road',fromTownId:'bay',toTownId:'farm'}];
  const candidates=[{id:'bay',candidates:[{center:[2.5,48.7] as [number,number]}]},
    {id:'farm',candidates:[{center:[-98.5,-2.5] as [number,number]},{center:[-66.5,-98.5] as [number,number]}]}];
  expect(auditWorldCandidatePacking(towns,roads,candidates)).toEqual({roadId:'farm-road',fromTownId:'bay',toTownId:'farm',
    requiredSeparation:168,bestAxisSeparation:147.2});
  candidates[1].candidates.push({center:[-170,48.7]});
  expect(auditWorldCandidatePacking(towns,roads,candidates)).toBeNull();
});

function validDraft() {
  const recipe = {
    version: 1 as const, seed: request.seed, size: request.size, heightScale: 0.1,
    constraints: [{ region: 'center' as const, biome: 'grassland' as const }]
  };
  const sample = createWorldSampler(recipe);
  return {
    plan: {
      version: 1 as const, id: 'generated-world', revision: 1, prompt: request.prompt, recipe,
      ecology: [], roads: [], towns: [{
        id: 'market-town', name: 'Market Town', prompt: 'A compact market town', center: [0, 0] as [number, number],
        radius: 100, blend: 64, foundation: sample(0, 0).height, terrainMode: 'conform' as const, ports: []
      }]
    },
    settlements: [{ townId: 'market-town', options: { kind: 'city' as const, pattern: 'organic' as const, seed: 9, density: 0.8 } }],
    assets: []
  };
}

function rawSeedIntent() {
  return { plan: {
    version: 1, id: 'dune-spring-coast', revision: 1,
    prompt: 'Desert spring town linked to a coastal fishing village',
    recipe: {
      version: 1, seed: 9012901, size: 2000, heightScale: 0.11,
      constraints: [
        {region:'west',biome:'ocean'},{region:'northwest',biome:'ocean'},{region:'southwest',biome:'ocean'},
        {region:'center',biome:'desert'},{region:'east',biome:'desert'},{region:'northeast',biome:'desert'},{region:'south',biome:'desert'}
      ],
      waterBodies: [{id:'fresh-spring',type:'lake',region:{kind:'circle',center:[160,-140],radius:58},levels:[9],depth:3}]
    },
    ecology: [],
    towns: [
      {id:'spring-town',name:'Spring Town',prompt:'A compact caravan town beside the spring',radius:130,blend:80,terrainMode:'conform',region:'center',kind:'city',pattern:'organic',density:.45,waterfrontBias:.7,targetWaterBodyId:'fresh-spring',
        publicBuildings:[{id:'market',use:'public market',width:12,depth:10,height:6,assetKey:'market',enterable:true}]},
      {id:'fishing-village',name:'Fishing Village',prompt:'A small fishing village on the landward side of the coast',radius:100,blend:80,terrainMode:'conform',region:'west',kind:'village',pattern:'organic',density:.4,waterfrontBias:.85,targetWaterBodyId:'sea',publicBuildings:[]}
    ],
    roads: [{id:'trade-road',name:'Fish and caravan road',fromTownId:'fishing-village',toTownId:'spring-town',width:4,tags:['trade-route']}]
  }};
}

function rawSoloIntent(input:WorldGenerationRequest=request) {
  return {plan:{version:1,id:'generated-world',revision:1,prompt:input.prompt,
    recipe:{version:1,seed:input.seed,size:input.size,heightScale:.1,constraints:[{region:'center',biome:'grassland'}]},
    ecology:[],roads:[],towns:[{id:'market-town',name:'Market Town',prompt:'A compact market town',radius:100,
      blend:64,terrainMode:'conform',region:'center',kind:'city',pattern:'organic',density:.8,publicBuildings:[]}]}};
}

function rawHarborIntent(input:WorldGenerationRequest) {
  return {plan:{version:1,id:'harbor-bank',revision:1,prompt:input.prompt,recipe:{version:1,seed:input.seed,
    size:input.size,heightScale:.035,constraints:[{region:'center',biome:'grassland'},{region:'east',biome:'grassland'},
      {region:'northeast',biome:'forest'},{region:'northwest',biome:'ocean'},{region:'southeast',biome:'grassland'},
      {region:'southwest',biome:'ocean'},{region:'west',biome:'ocean'}],
    landforms:[{center:[140,-170],radius:[75,65],height:8}],
    biomePatches:[{id:'northern-woodland',region:{kind:'circle',center:[135,-175],radius:65},biome:'forest',feather:32}]},
    ecology:[],roads:[],towns:[{id:'bay-town',name:'Bay Town',prompt:'A compact fishing town on a dry bank',radius:100,
      blend:25,terrainMode:'conform',region:'center',kind:'city',pattern:'organic',density:.83,waterfrontBias:.9,
      targetWaterBodyId:'sea',publicBuildings:[]}]}};
}

function soloLayout(input:WorldGenerationRequest=request) {
  const intent=parseWorldIntentDraft(rawSoloIntent(input),input),evidence=createWorldSitingEvidence(intent);
  return {intent,evidence,layout:{towns:[{townId:'market-town',candidateId:evidence.towns[0].candidates[0].id}],
    settlements:[{townId:'market-town',options:{kind:'city',pattern:'organic',density:.8}}],assets:[]}};
}

function reusableAsset(id = 'asset-existing'): MapAsset {
  return {
    id, name: 'Existing house', prompt: 'A reusable stone house', tags: ['house'],
    modelJson: { format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: { width: 8, height: 7, depth: 9 } } }] },
    mode: 'voxel-pro', createdAt: 1, updatedAt: 1,
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false }
  };
}

describe('world generation compiler', () => {
  beforeEach(() => {
    mocks.llmChat.mockReset();
    mocks.generateModel.mockReset();
    mocks.recordGenerationTrace.mockReset();
  });

  it('preserves a public building siting purpose and rejects unsupported purposes', () => {
    const intent = rawSeedIntent();
    const publicBuilding = intent.plan.towns[0].publicBuildings[0] as typeof intent.plan.towns[0]['publicBuildings'][number] & { siting?: string };
    publicBuilding.siting = 'waterfront';
    expect(parseWorldIntentDraft(intent, { prompt: intent.plan.prompt, seed: 9012901, size: 2000 })
      .plan.towns[0].publicBuildings[0]).toEqual(expect.objectContaining({ id: 'market', siting: 'waterfront' }));
    publicBuilding.siting = 'floating';
    expect(() => parseWorldIntentDraft(intent, { prompt: intent.plan.prompt, seed: 9012901, size: 2000 }))
      .toThrow('invalid_world_public_building_siting');
  });

  it('uses compact relief for new GPT worlds without changing older stored recipes', () => {
    const intent = rawSeedIntent();
    const parsed = parseWorldIntentDraft(intent, { prompt: intent.plan.prompt, seed: 9012901, size: 2000 });
    expect(parsed.plan.recipe.reliefProfile).toBe('compact');
    expect(intent.plan.recipe).not.toHaveProperty('reliefProfile');
  });

  it('accepts an omitted model prompt and preserves the server-owned request prompt', () => {
    const intent=rawSoloIntent() as any;
    delete intent.plan.prompt;
    expect(parseWorldIntentDraft(intent,request).plan.prompt).toBe(request.prompt);
  });

  it('keeps a circular landform and treats a one-town loop as a local street request', () => {
    const intent=rawSoloIntent() as any;
    intent.plan.recipe.landforms=[{center:[0,0],radius:90,height:8}];
    intent.plan.roads=[{id:'farm-lane',name:'Farm lane',fromTownId:'market-town',toTownId:'market-town',width:3,tags:['farm']}];
    const parsed=parseWorldIntentDraft(intent,request);
    expect(parsed.plan.recipe.landforms?.[0].radius).toEqual([90,90]);
    expect(parsed.plan.roads).toEqual([]);
    expect(intent.plan.recipe.landforms[0].radius).toBe(90);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.intent-local-road-ignored',
      {id:'farm-lane',townId:'market-town'});
  });

  it('keeps intent fields when GPT places ecology, towns, and roads beside plan', () => {
    const source = rawSoloIntent();
    const { ecology, towns, roads, ...plan } = source.plan;
    const parsed = parseWorldIntentDraft({ plan, ecology, towns, roads }, request);
    expect(parsed.plan.ecology).toEqual(ecology);
    expect(parsed.plan.towns.map(town => town.id)).toEqual(['market-town']);
    expect(parsed.plan.roads).toEqual([]);
    expect(() => parseWorldIntentDraft({ plan, ecology, towns, roads, extra: true }, request))
      .toThrow('world_unknown_intent_field:extra');
  });

  it('ignores redundant sibling intent fields but rejects conflicting duplicates', () => {
    const source = rawSoloIntent();
    for (const field of ['ecology', 'towns', 'roads'] as const) {
      expect(parseWorldIntentDraft({ ...source, [field]: structuredClone(source.plan[field]) }, request).plan[field])
        .toEqual(source.plan[field]);
    }
    expect(parseWorldIntentDraft({ ...source, ecology: [] }, request).plan.ecology).toEqual(source.plan.ecology);
    expect(() => parseWorldIntentDraft({ ...source, ecology: [{ id: 'different-ecology' }] }, request))
      .toThrow('world_unknown_intent_field:ecology');
    expect(() => parseWorldIntentDraft({ ...source, towns: [{ ...source.plan.towns[0], id: 'different-town' }] }, request))
      .toThrow('world_unknown_intent_field:towns');
  });

  it('accepts one surplus closing brace only when the remaining JSON is complete', async () => {
    const { layout } = soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent()) + '}')
      .mockResolvedValueOnce(JSON.stringify(layout));
    const result = await generateWorld(request, {} as MapStore);
    expect(result.bundle.plan.towns).toHaveLength(1);
  });

  it('offers the shared crater brush to direct world planning', async () => {
    const { layout } = soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent()))
      .mockResolvedValueOnce(JSON.stringify(layout));
    await generateWorld(request, {} as MapStore);
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toContain("mode:'crater',region:CIRCLE,depth,rimHeight");
    expect(systemPrompt).toContain('depth lowers the central floor below the pre-brush sampled rim height');
  });

  it('accepts one missing final brace only when the remaining JSON is complete', async () => {
    const { layout } = soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent()).slice(0, -1))
      .mockResolvedValueOnce(JSON.stringify(layout));
    const result = await generateWorld(request, {} as MapStore);
    expect(result.bundle.plan.towns).toHaveLength(1);
  });

  it('rejects semantic fields that would otherwise be silently overwritten or ignored', () => {
    const extra = { ...validDraft(), topology: 'keep me' };
    expect(() => compileWorldDraft(extra, request)).toThrow('world_unknown_draft_field:topology');

    const wrongRecipe = validDraft();
    wrongRecipe.plan.recipe.size = 1200;
    expect(() => compileWorldDraft(wrongRecipe, request)).toThrow('world_recipe_request_mismatch');

    const wrongPrompt = validDraft();
    wrongPrompt.plan.prompt = 'A different world';
    expect(compileWorldDraft(wrongPrompt, request).bundle.plan.prompt).toBe(request.prompt);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.request-echo-mismatch', {
      stage: 'draft', field: 'prompt', expected: request.prompt, received: 'A different world'
    });

    const unknownOption = validDraft() as any;
    unknownOption.settlements = [{ townId: 'market-town', options: { kind: 'city', boulevardCount: 12 } }];
    expect(() => compileWorldDraft(unknownOption, request)).toThrow('world_unknown_settlement_option:boulevardCount');
  });

  it('requires conforming terrain and rejects contradictory single-model architecture', () => {
    const platform = validDraft();
    platform.plan.towns[0].terrainMode = 'platform' as never;
    expect(() => compileWorldDraft(platform, request)).toThrow('world_town_requires_conform');

    const enterable = validDraft();
    enterable.assets.push({
      key: 'workshop', name: 'Workshop', role: 'workshop', prompt: 'Enterable workshop',
      dimensions: [12, 7, 10], enterable: true, strategy: 'single'
    } as never);
    expect(() => compileWorldDraft(enterable, request)).toThrow('world_asset_strategy_conflict:workshop');

    const cathedral = validDraft();
    cathedral.assets.push({
      key: 'cathedral', name: 'Cathedral', role: 'landmark', prompt: 'Large cathedral with aisles',
      dimensions: [30, 24, 48], strategy: 'single'
    } as never);
    expect(() => compileWorldDraft(cathedral, request)).toThrow('world_asset_strategy_conflict:cathedral');
  });

  it('allows only explicitly offered reusable asset ids', () => {
    const draft = validDraft() as any;
    draft.assets.push({
      key: 'stone-house', name: 'Stone house', role: 'house', prompt: 'Reuse the existing stone house',
      dimensions: [8, 7, 9], strategy: 'single', existingAssetId: 'asset-existing'
    });
    expect(() => compileWorldDraft(draft, request)).toThrow('invalid_world_asset_request');
    expect(compileWorldDraft(draft, { ...request, reusableAssetIds: ['asset-existing'] }).draft.assets[0].existingAssetId)
      .toBe('asset-existing');
    expect(() => validateWorldGenerationRequest({ ...request, reusableAssetIds: Array.from({length:65},(_,i)=>'asset-'+i) }))
      .toThrow('invalid_world_generation_request');
  });

  it('requires generated ecology assets to bind one exact rule and matching kind', () => {
    const draft = validDraft() as any;
    draft.plan.ecology = [{id:'harbor-forest',kind:'broadleaf',biome:'forest',density:.7,spacing:18,maxSlope:25,scale:[.8,1.2]}];
    draft.assets.push({key:'oak',name:'Harbor oak',role:'tree',prompt:'A broadleaf harbor oak'});
    expect(() => compileWorldDraft(draft, request)).toThrow('invalid_world_asset_request');
    draft.assets[0].ecologyKind = 'broadleaf';
    draft.assets[0].ecologyRuleId = 'harbor-forest';
    expect(compileWorldDraft(draft, request).draft.assets[0]).toMatchObject({
      ecologyKind: 'broadleaf', ecologyRuleId: 'harbor-forest'
    });
    draft.assets[0].ecologyKind = 'pine';
    expect(() => compileWorldDraft(draft, request)).toThrow('invalid_world_asset_request');
  });

  it('requires complete ordinary-building and ecology bindings only when generating assets', () => {
    const draft = validDraft() as any;
    draft.plan.ecology = [{id:'harbor-forest',kind:'broadleaf',biome:'forest',density:.7,spacing:18,maxSlope:25,scale:[.8,1.2]}];
    const generatedRequest={...request,generateAssets:true};
    expect(() => compileWorldDraft(draft, generatedRequest)).toThrow(/^world_missing_asset_roles:.*house/);
    draft.assets.push(
      {key:'house',name:'House',role:'house',prompt:'A compact local house'},
      {key:'shop',name:'Shop',role:'shop',prompt:'A compact local shop'},
      {key:'workshop',name:'Workshop',role:'workshop',prompt:'A compact local workshop'}
    );
    expect(() => compileWorldDraft(draft, generatedRequest)).toThrow('world_missing_ecology_assets:harbor-forest');
    draft.assets.push({key:'oak',name:'Harbor oak',role:'tree',prompt:'A broadleaf harbor oak',
      ecologyKind:'broadleaf',ecologyRuleId:'harbor-forest'});
    expect(() => compileWorldDraft(draft, generatedRequest)).not.toThrow();
    expect(() => compileWorldDraft({...draft,assets:[]}, {...generatedRequest,generateAssets:false})).not.toThrow();
  });

  it('allows enough asset families for civic buildings, ordinary roles and ecology', () => {
    const draft = validDraft() as any;
    draft.assets = Array.from({length: 13}, (_, index) => ({
      key: `family-${index}`, name: `Family ${index}`, role: 'house' as const,
      prompt: `A local building family ${index}`
    }));
    expect(() => compileWorldDraft(draft, request)).not.toThrow();
    draft.assets.push(...Array.from({length: 4}, (_, index) => ({
      key: `extra-${index}`, name: `Extra ${index}`, role: 'house' as const,
      prompt: `Another building family ${index}`
    })));
    expect(() => compileWorldDraft(draft, request)).toThrow('invalid_world_draft');
  });

  it('repairs only missing asset coverage while preserving the first layout trace and spatial choices', async () => {
    const input={...request,generateAssets:true,reusableAssetIds:['asset-existing']};
    const intent=parseWorldIntentDraft(rawSoloIntent(input),input),evidence=createWorldSitingEvidence(intent);
    const layout={towns:[{townId:'market-town',candidateId:evidence.towns[0].candidates[0].id}],
      settlements:[{townId:'market-town',options:{kind:'city',pattern:'organic',density:.8}}],assets:[]};
    const repaired={...layout,assets:[
      {key:'house',name:'House',role:'house',prompt:'A compact local house',existingAssetId:'asset-existing'},
      {key:'shop',name:'Shop',role:'shop',prompt:'A compact local shop',existingAssetId:'asset-existing'},
      {key:'workshop',name:'Workshop',role:'workshop',prompt:'A compact local workshop',existingAssetId:'asset-existing'}
    ]};
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent(input)))
      .mockResolvedValueOnce(JSON.stringify(layout)).mockResolvedValueOnce(JSON.stringify(repaired));
    const store={loadAsset:vi.fn().mockResolvedValue(reusableAsset())} as unknown as MapStore;
    const result=await generateWorld({...input,repairAttempts:1},store);
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    expect(result.draft.assets.map(asset=>asset.role)).toEqual(['house','shop','workshop']);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.layout.raw',{layout});
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.rejected',expect.objectContaining({
      stage:'layout',error:expect.stringMatching(/^world_missing_asset_roles:/)
    }));
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.layout.repair.raw',{layout:repaired});
    const repairPrompt=JSON.parse((mocks.llmChat.mock.calls[2][0] as Array<{role:string;content:string}>).at(-1)!.content);
    expect(repairPrompt.instruction).toContain('Copy towns and settlements exactly');
  });

  it('repairs layout-only terrain overrides without changing sampled site or asset choices', async () => {
    const {intent,evidence,layout}=soloLayout();
    const invalid=structuredClone(layout) as any;
    invalid.settlements[0].options.waterSetback=48;
    expect(() => materializeWorldIntent(intent,evidence,invalid,request))
      .toThrow('world_layout_unsupported_option:market-town:waterSetback');
    invalid.settlements[0].options.waterfrontBias=.9;
    delete invalid.settlements[0].options.waterSetback;
    expect(() => materializeWorldIntent(intent,evidence,invalid,request))
      .toThrow('world_layout_settlement_intent_mismatch:market-town');

    invalid.settlements[0].options.waterSetback=48;
    delete invalid.settlements[0].options.waterfrontBias;
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent()))
      .mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(layout));
    const result=await generateWorld({...request,repairAttempts:1},{} as MapStore);
    expect(result.bundle.plan.towns).toHaveLength(1);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.layout.raw',{layout:invalid});
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.layout.repair.raw',{layout});
    const repairPrompt=JSON.parse((mocks.llmChat.mock.calls[2][0] as Array<{role:string;content:string}>).at(-1)!.content);
    expect(repairPrompt.instruction).toContain('Copy towns and assets exactly');
  });

  it('does not repair a Stage 2 schema failure when repairs are disabled', async () => {
    const {layout}=soloLayout();
    const invalid=structuredClone(layout) as any;
    invalid.settlements[0].options.waterSetback=48;
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent())).mockResolvedValueOnce(JSON.stringify(invalid));

    await expect(generateWorld({...request,repairAttempts:0},{} as MapStore))
      .rejects.toThrow('world_layout_unsupported_option:market-town:waterSetback');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.llmChat.mock.calls.map(call=>(call[1] as {traceStage:string}).traceStage))
      .toEqual(['world.intent','world.layout']);
    expect(mocks.llmChat.mock.calls.map(call=>(call[1] as {maxAttempts:number}).maxAttempts))
      .toEqual([1,1]);
  });

  it('repairs an invalid GPT intent once and returns geometry audits', async () => {
    const {intent,layout}=soloLayout();
    mocks.llmChat
      .mockResolvedValueOnce(JSON.stringify({ ...rawSoloIntent(), accidentalTopology: true }))
      .mockImplementationOnce(async (messages:Array<{role:string;content:string}>) => {
        const repair=JSON.parse(messages.at(-1)!.content);
        const repaired=rawSoloIntent();
        repaired.plan.prompt=repair.instruction;
        return JSON.stringify(repaired);
      })
      .mockResolvedValueOnce(JSON.stringify(layout));

    const result = await generateWorld({...request,repairAttempts:1}, {} as MapStore);
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    const repairMessages = mocks.llmChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(JSON.parse(repairMessages.at(-1)!.content).error).toBe('world_unknown_intent_field:accidentalTopology');
    expect(JSON.parse(repairMessages.at(-1)!.content).instruction).toContain('only a plan key');
    expect(JSON.parse(repairMessages.at(-1)!.content).request).toEqual({
      prompt:request.prompt,seed:request.seed,size:request.size
    });
    expect(result.bundle.plan.prompt).toBe(request.prompt);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.request-echo-mismatch', expect.objectContaining({
      stage:'intent',field:'prompt',expected:request.prompt,received:expect.stringContaining('only a plan key')
    }));
    expect(result.bundle.plan.id).toBe(intent.plan.id);
    expect(result.bundle.plan.recipe.heightScale).toBe(0.1);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      townId: 'market-town', buildingCount: expect.any(Number), roadSurfaceArea: expect.any(Number),
      builtFootprintArea: expect.any(Number), roadWidthRange: expect.any(Array), maxRoadSlope: expect.any(Number),
      publicBuildings: 0, recommendedPublicBuildings: expect.any(Array),
      planningIssues: expect.arrayContaining(['missing_public_function', 'missing_external_connection'])
    }));
  });

  it('tells an intent repair exactly which path region is missing width', async () => {
    const invalid=rawSoloIntent() as any;
    invalid.plan.recipe.terrainBrushes=[{id:'shore-working-grade',mode:'grade',
      region:{kind:'path',points:[[-60,0],[60,0]]},heights:[3,3]}];
    invalid.plan.recipe.waterBodies=[{id:'trade-river',type:'river',
      region:{kind:'path',points:[[-80,-80],[80,80]]},levels:[0,0],depth:3}];
    const repaired=structuredClone(invalid);
    repaired.plan.recipe.terrainBrushes[0].region.width=12;
    repaired.plan.recipe.waterBodies[0].region.width=18;
    const parsed=parseWorldIntentDraft(repaired,request),evidence=createWorldSitingEvidence(parsed);
    const layout={towns:[{townId:'market-town',candidateId:evidence.towns[0].candidates[0].id}],
      settlements:[{townId:'market-town',options:{kind:'city',pattern:'organic',density:.8}}],assets:[]};
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(repaired))
      .mockResolvedValueOnce(JSON.stringify(layout));

    await generateWorld({...request,repairAttempts:1},{} as MapStore);

    const initialPrompt=(mocks.llmChat.mock.calls[0][0] as Array<{role:string;content:string}>)[0].content;
    const repairPrompt=JSON.parse((mocks.llmChat.mock.calls[1][0] as Array<{role:string;content:string}>).at(-1)!.content);
    expect(initialPrompt).toContain('Every path region requires numeric width 1..1000, including grade brushes, rivers');
    expect(repairPrompt.error).toBe('invalid_world_terrain_region:plan.recipe.terrainBrushes[0].region.width:required_numeric_width_1_to_1000');
    expect(parseWorldIntentDraft(repaired,request).plan.recipe.waterBodies?.[0].region).toEqual(
      expect.objectContaining({kind:'path',width:18}));
  },10_000);

  it('uses its one allowed intent repair when sampled siting cannot support the proposed town', async () => {
    const {layout}=soloLayout();
    const impossible=rawSoloIntent() as any;
    impossible.plan.towns[0].targetWaterBodyId='sea';
    impossible.plan.towns[0].waterfrontBias=.9;
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(impossible))
      .mockResolvedValueOnce(JSON.stringify(rawSoloIntent()))
      .mockResolvedValueOnce(JSON.stringify(layout));
    const result=await generateWorld({...request,repairAttempts:1},{} as MapStore);
    expect(result.bundle.plan.towns).toHaveLength(1);
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    const repairMessages=mocks.llmChat.mock.calls[1][0] as Array<{role:string;content:string}>;
    expect(JSON.parse(repairMessages.at(-1)!.content)).toMatchObject({
      error:expect.stringContaining('world_no_site_candidates'),
      instruction:expect.stringContaining('create separated dry centers'),
      siteHints:expect.arrayContaining([expect.objectContaining({townId:'market-town',candidates:expect.any(Array)})]),
      terrainHint:expect.objectContaining({sampledCells:81,seaCells:expect.any(Number),dryCells:expect.any(Number)})
    });
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.rejected',expect.objectContaining({attempt:0}));
    expect(JSON.parse(repairMessages.at(-1)!.content).instruction).toContain('non-ocean corner constraints');
  });

  it('tells GPT when every sampled town candidate lacks a buildable network', async () => {
    const input={...request,seed:19};
    const mountain=rawSoloIntent(input) as any;
    mountain.plan.recipe.heightScale=.4;
    mountain.plan.recipe.constraints=[{region:'center',biome:'mountains'}];
    const {layout}=soloLayout(input);
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(mountain))
      .mockResolvedValueOnce(JSON.stringify(rawSoloIntent(input)))
      .mockResolvedValueOnce(JSON.stringify(layout));

    await generateWorld({...input,repairAttempts:1},{} as MapStore);

    const repairPrompt=JSON.parse((mocks.llmChat.mock.calls[1][0] as Array<{role:string;content:string}>).at(-1)!.content);
    expect(repairPrompt.siteHints).toEqual([expect.objectContaining({
      townId:'market-town',candidateUsability:expect.objectContaining({
        total:3,usable:0,rejected:3,
        issueCounts:{world_settlement_no_buildable_network:3},
        allCandidatesLackBuildableNetwork:true
      })
    })]);
    expect(repairPrompt.instruction).toContain('move that town region away from steep mountain terrain');
    expect(repairPrompt.instruction).toContain('shape a broad, low, gently sloped buildable terrace');
    expect(repairPrompt.instruction).toContain('world_settlement_no_landmark_site');
    expect(repairPrompt.instruction).toContain('do not relax settlement or route quality');
  },20_000);

  it('reports a tiny inland knot and missing sea landing in a large harbor town', () => {
    const building=(id:string,x:number,z:number)=>({id,x,z,width:8,depth:8,height:6,use:'home'});
    const small={buildings:Array.from({length:11},(_,index)=>building('b'+index,(index%4)*4,Math.floor(index/4)*4)),
      streets:[{id:'shore',name:'shore',points:[[0,0],[20,0]] as [number,number][],curve:'polyline' as const,
        closed:false,width:4,tags:['waterfront']}]} ;
    const town={radius:105,targetWaterBodyId:'sea'};
    const settings={kind:'village' as const,density:.48,waterfrontBias:.85};
    expect(auditWorldSettlementCoverage(town,small,settings,8).planningIssues).toEqual([
      'underbuilt_settlement','clustered_settlement','missing_sea_landing']);
    const taggedStub={...small,streets:[{...small.streets[0],width:6.4,points:[[0,0],[3.03,0]] as [number,number][],
      tags:['waterfront','sea-landing','harbor-quay']}]};
    expect(auditWorldSettlementCoverage(town,taggedStub,settings,32).planningIssues).toContain('missing_sea_landing');
    const grown={buildings:[building('west',-75,-40),building('east',75,40)],
      streets:[{...small.streets[0],tags:['waterfront','sea-landing']}]};
    expect(auditWorldSettlementCoverage(town,grown,settings,32)).toMatchObject({
      builtExtent:expect.any(Number),planningIssues:[]});
  });

  it('rejects the traced underbuilt settlement proportions before asset generation', () => {
    const building=(id:string,x:number,z:number)=>({id,x,z,width:8,depth:8,height:6,use:'home'});
    const patch={
      buildings:[
        ...Array.from({length:18},(_,index)=>building('home-'+index,(index%6)*15.5,Math.floor(index/6)*7)),
        ...Array.from({length:4},(_,index)=>building('public-'+index,150+index*5,5))
      ],
      streets:[{id:'quay',name:'quay',points:[[0,0],[40,0]] as [number,number][],curve:'polyline' as const,
        closed:false,width:5,tags:['waterfront','sea-landing']}]
    };
    const town={id:'harbor-town',radius:105,targetWaterBodyId:'sea',publicBuildings:Array.from({length:4},(_,index)=>({
      id:'public-'+index,use:'public service',width:8,depth:8,height:6,assetKey:'public-'+index
    }))};
    const harbor=auditWorldSettlementAcceptance(town,patch,{kind:'city',density:.8,waterfrontBias:.85});
    expect(harbor).toMatchObject({
      publicBuildings:4,
      ordinaryBuildings:18,
      planningIssues:['underbuilt_settlement','clustered_settlement','public_program_overconcentrated']
    });
    expect(harbor.builtExtent).toBeCloseTo(.37,2);
    const farmPatch={...patch,buildings:[building('home-a',0,0),building('home-b',31.9,0),
      building('public-a',10,0),building('public-b',20,0)]};
    expect(auditWorldSettlementAcceptance({
      id:'farmstead',radius:55,publicBuildings:[
        {id:'public-a',use:'mill',width:8,depth:8,height:6,assetKey:'mill'},
        {id:'public-b',use:'granary',width:8,depth:8,height:6,assetKey:'granary'}
      ]
    },farmPatch,{kind:'village',density:.3,waterfrontBias:0})).toMatchObject({
      publicBuildings:2,ordinaryBuildings:2,builtExtent:.29,
      planningIssues:['underbuilt_settlement','clustered_settlement','public_program_overconcentrated']
    });
    const spreadHamlet={buildings:Array.from({length:8},(_,index)=>building('farm-home-'+index,
      (index%4)*18-27,Math.floor(index/4)*25-12.5)),streets:[]};
    expect(auditWorldSettlementCoverage({radius:50},spreadHamlet,
      {kind:'village',density:.48,waterfrontBias:0},8)).toMatchObject({planningIssues:[]});
  });

  it('returns raw aesthetic diagnostics with exactly one intent and one layout call', async () => {
    const input={...request,prompt:'A complete island town',generateAssets:false,repairAttempts:0 as const};
    const intent=rawSoloIntent(input);
    const parsed=parseWorldIntentDraft(intent,input),evidence=createWorldSitingEvidence(parsed);
    const layout={towns:[{townId:'market-town',candidateId:evidence.towns[0].candidates[0].id}],
      settlements:[{townId:'market-town',options:{kind:'city',pattern:'organic',density:.8}}],assets:[]};
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(intent)).mockResolvedValueOnce(JSON.stringify(layout));
    const result=await generateWorld(input,{} as MapStore);
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.llmChat.mock.calls.map(call=>(call[1] as {traceStage:string}).traceStage))
      .toEqual(['world.intent','world.layout']);
    expect(result.diagnostics[0].planningIssues).toContain('island_boundary_open');
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('rejects a named island whose dry terrain is clipped by the world boundary', () => {
    const recipe={version:1 as const,seed:7,size:500,heightScale:.1,
      constraints:[{region:'center' as const,biome:'grassland' as const}]};
    expect(auditWorldIslandBoundary('A complete island town',recipe)).toMatchObject({dryRatio:1});
    expect(auditWorldIslandBoundary('A coastal town',recipe)).toBeNull();
  });

  it('diagnoses an inhabited island whose connected dry interior cannot hold its town cores', () => {
    const recipe={version:1 as const,seed:17,size:500,heightScale:.1,
      constraints:[
        {region:'north' as const,biome:'ocean' as const},{region:'south' as const,biome:'ocean' as const},
        {region:'east' as const,biome:'ocean' as const},{region:'west' as const,biome:'ocean' as const},
        {region:'northeast' as const,biome:'ocean' as const},{region:'northwest' as const,biome:'ocean' as const},
        {region:'southeast' as const,biome:'ocean' as const},{region:'southwest' as const,biome:'ocean' as const},
        {region:'center' as const,biome:'grassland' as const}
      ],landforms:[{center:[0,0] as [number,number],radius:[70,60] as [number,number],height:7}]};
    const audit=auditWorldIslandLandmass('An inhabited island port',recipe,[{radius:145}]);
    expect(audit).toMatchObject({adequate:false,requiredSpan:290});
    expect(audit!.largestDryComponentSamples).toBeLessThan(audit!.requiredDrySamples);
    const broadDryCore=((x:number,z:number)=>({height:Math.abs(x)<=160&&Math.abs(z)<=160?8:-4,
      waterLevel:Math.abs(x)<=160&&Math.abs(z)<=160?null:0,waterBodyId:null})) as ReturnType<typeof createWorldSampler>;
    expect(auditWorldIslandLandmass('An inhabited island port',recipe,[{radius:145}],broadDryCore))
      .toMatchObject({adequate:true,requiredSpan:290});
  });

  it('prompts for a settlement-specific economy and civic program before street layout', () => {
    expect(WORLD_GENERATION_PROMPT).toContain('livelihood, population scale, external logistics, public services');
    expect(WORLD_GENERATION_PROMPT).toContain('one public or landmark building per 10..20 ordinary buildings');
    expect(WORLD_GENERATION_PROMPT).toContain('Do not copy one civic checklist into every settlement');
  });

  it('preserves an explicit resident count as deterministic settlement capacity', () => {
    const raw=rawSoloIntent() as any;
    raw.plan.towns[0].population=250;
    expect(parseWorldIntentDraft(raw,request).plan.towns[0].population).toBe(250);
    raw.plan.towns[0].population=250.5;
    expect(()=>parseWorldIntentDraft(raw,request)).toThrow('invalid_world_intent_town');
  });

  it('shows GPT only the requested reusable catalog without model payloads', async () => {
    const {layout}=soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent())).mockResolvedValueOnce(JSON.stringify(layout));
    const asset = reusableAsset();
    const store = { loadAsset: vi.fn().mockResolvedValue(asset) } as unknown as MapStore;
    await generateWorld({ ...request, reusableAssetIds: [asset.id] }, store);
    const messages = mocks.llmChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('Copy request.prompt byte-for-byte into plan.prompt');
    expect(messages[0].content).toContain('The root has only plan; recipe, ecology, towns and roads are children of plan');
    expect(messages[0].content).toContain('for size 500: -250..250');
    expect(messages[0].content).toContain('every map edge must sample as ocean');
    expect(messages[0].content).toContain('Do not assign non-ocean corner constraints on a sea island');
    expect(messages[0].content).toContain('combined 2*radius by 2*radius cores');
    expect(messages[0].content).toContain('Assign at most one biome constraint to each broad region');
    expect(messages[0].content).toContain('heightScale around 0.02..0.04');
    expect(messages[0].content).toContain('Ecology region is a circle/path object');
    expect(messages[0].content).toContain('exactly four ascending metre values');
    expect(messages[0].content).toContain("reliefProfile:'compact'");
    expect(messages[0].content).toContain('for size 500 these minima are 50m and 20m');
    expect(messages[0].content).toContain('one useful public or landmark building per 10..20 ordinary buildings');
    expect(messages[0].content).toContain('add population as an integer approximate resident count');
    expect(messages[0].content).toContain('about eight ordinary houses gets at most one public landmark');
    expect(messages[0].content).toContain('Size and distribute inhabited districts against the usable land');
    expect(messages[0].content).toContain('one ordinary dwelling per four to six residents');
    expect(messages[0].content).toContain('Roads connect two different town IDs only');
    expect(messages[0].content).toContain("Rocky terrain uses mountains, not a 'rock' biome");
    expect(messages[0].content).toContain('budget the whole public-building program simultaneously');
    expect(messages[0].content).toContain('combined waterfront footprints plus gaps and access');
    expect(messages[0].content).toContain('reserve a separate inland civic block for schools and services');
    expect(messages[0].content).toContain('keep ridges, gullies and bay cuts away from both reserves');
    expect(messages[0].content).toContain('use only one or two waterfront work buildings');
    expect(messages[0].content).toContain('Use 3..5m for rural walking/cart roads');
    expect(messages[0].content).toContain("siting?:'central'|'waterfront'|'gateway'|'high-ground'");
    const planningInput = JSON.parse(messages[1].content);
    expect(planningInput.reusableAssets).toEqual([expect.objectContaining({ id: asset.id, name: asset.name })]);
    expect(planningInput.reusableAssets[0].visualSize).toEqual([8,7,9]);
    expect(planningInput.reusableAssets[0]).not.toHaveProperty('modelJson');
    const layoutMessages = mocks.llmChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(layoutMessages[0].content).toContain("strategy:'single' is invalid for every enterable asset");
    expect(layoutMessages[0].content).toContain('market stalls alone do not constitute a port');
    expect(layoutMessages[0].content).toContain('match its assetKey and authored [width,height,depth] exactly');
  });

  it('reuses an offered asset when Stage 2 repeats its id as the asset key', async () => {
    const asset = reusableAsset();
    const { layout } = soloLayout();
    (layout.assets as WorldAssetRequest[]) = [{
      key: asset.id, name: 'Existing house', role: 'house', prompt: 'Reuse the existing house',
      dimensions: [8, 7, 9], strategy: 'assembly'
    }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent())).mockResolvedValueOnce(JSON.stringify(layout));
    const store = { loadAsset: vi.fn().mockResolvedValue(asset), saveAsset: vi.fn() } as unknown as MapStore;

    const result = await generateWorld({ ...request, reusableAssetIds: [asset.id] }, store);

    expect(result.draft.assets[0].existingAssetId).toBe(asset.id);
    expect(result.assetSources).toBeUndefined();
    expect(store.saveAsset).not.toHaveBeenCalled();
  });

  it('reuses a model when its visual bounds differ slightly from nominal dimensions', async () => {
    const asset = reusableAsset();
    const { layout } = soloLayout();
    (layout.assets as WorldAssetRequest[]) = [{
      key: asset.id, name: 'Existing house', role: 'house', prompt: 'Reuse the existing house',
      dimensions: [8.6, 7, 9.4], strategy: 'single'
    }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent())).mockResolvedValueOnce(JSON.stringify(layout));
    const store = { loadAsset: vi.fn().mockResolvedValue(asset), saveAsset: vi.fn() } as unknown as MapStore;

    const result = await generateWorld({ ...request, reusableAssetIds: [asset.id] }, store);

    expect(result.draft.assets[0].existingAssetId).toBe(asset.id);
    expect(store.saveAsset).not.toHaveBeenCalled();
  });

  it('rejects an incompatible exact reusable id before paid asset generation', async () => {
    const asset = reusableAsset();
    const { layout } = soloLayout();
    (layout.assets as WorldAssetRequest[]) = [{
      key: asset.id, name: 'Oversized house', role: 'house', prompt: 'A much larger house',
      dimensions: [18, 7, 19], strategy: 'assembly'
    }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent())).mockResolvedValueOnce(JSON.stringify(layout));
    const store = { loadAsset: vi.fn().mockResolvedValue(asset), saveAsset: vi.fn() } as unknown as MapStore;

    await expect(generateWorld({ ...request, reusableAssetIds: [asset.id] }, store))
      .rejects.toThrow(`world_reusable_asset_conflict:${asset.id}:dimensions`);
    expect(store.saveAsset).not.toHaveBeenCalled();
  });

  it('allows a terrain-only intent without inventing a town', () => {
    const input:WorldGenerationRequest={prompt:'A remote volcanic snowfield',seed:17,size:1400,generateAssets:false};
    const intent={plan:{version:1,id:'terrain-only',revision:1,prompt:input.prompt,
      recipe:{version:1,seed:17,size:1400,constraints:[{region:'center',biome:'mountains'}]},
      ecology:[],towns:[],roads:[]}};
    const parsed=parseWorldIntentDraft(intent,input),evidence=createWorldSitingEvidence(parsed);
    expect(evidence).toEqual({towns:[],connections:[],landmarkLayouts:[]});
    const result=materializeWorldIntent(parsed,evidence,{towns:[],settlements:[],assets:[]},input);
    expect(result.bundle.plan.towns).toEqual([]);
    expect(result.bundle.patches).toEqual([]);
  });

  it('normalizes a pre-pattern Stage1 town to organic before enforcing the layout choice', () => {
    const raw=rawSoloIntent() as any;
    delete raw.plan.towns[0].pattern;
    const intent=parseWorldIntentDraft(raw,request);
    expect(intent.plan.towns[0].pattern).toBe('organic');
  });

  it('offers sampled public-building layouts for a town without external roads', () => {
    const input:WorldGenerationRequest={prompt:'A self-contained hill market',seed:2309,size:1600,generateAssets:false};
    const raw={plan:{version:1,id:'solo-market',revision:1,prompt:input.prompt,
      recipe:{version:1,seed:input.seed,size:input.size,heightScale:.1,constraints:[{region:'center',biome:'grassland'}]},
      ecology:[],roads:[],towns:[{id:'market-town',name:'Market Town',prompt:'A compact inland market town',
        radius:100,blend:64,terrainMode:'conform',region:'center',kind:'city',pattern:'organic',density:.65,publicBuildings:[
          {id:'market',use:'covered public market',width:12,depth:10,height:6,assetKey:'market',enterable:true}
        ]}]}};
    const intent=parseWorldIntentDraft(raw,input),evidence=createWorldSitingEvidence(intent);
    expect(evidence.connections).toEqual([]);
    expect(evidence.towns[0].candidates.length).toBeGreaterThan(0);
    const layout=evidence.landmarkLayouts.find(item=>item.townId==='market-town'&&item.pattern==='organic');
    expect(layout).toBeDefined();
    const chosen=evidence.towns[0].candidates.find(candidate=>candidate.id===layout!.candidateId)!;
    expect(()=>materializeWorldIntent(intent,evidence,{towns:[{townId:'market-town',candidateId:chosen.id,
      landmarkLayoutId:layout!.id}],settlements:[{townId:'market-town',options:{kind:'city',pattern:'organic',density:.65}}],
      assets:[{key:'market',name:'Market',role:'landmark',prompt:'A covered public market',dimensions:[12,6,10],enterable:true,strategy:'assembly'}]},input)).not.toThrow();
  },15_000);

  it('preserves every candidate failure when no settlement layout is viable', () => {
    const input:WorldGenerationRequest={prompt:'A 500 metre warm island harbor',seed:314159,size:500,generateAssets:false};
    const raw={plan:{version:1,id:'warm-island-harbor-314159',revision:1,prompt:input.prompt,
      recipe:{version:1,seed:input.seed,size:input.size,reliefProfile:'compact',heightScale:.03,constraints:[
        {region:'west',biome:'ocean'},{region:'east',biome:'ocean'},{region:'north',biome:'ocean'},
        {region:'south',biome:'ocean'},{region:'center',biome:'grassland'}],landforms:[
        {center:[0,0],radius:[183,165],height:18},{center:[-65,35],radius:[105,105],height:10},
        {center:[55,30],radius:[108,100],height:9},{center:[-55,95],radius:[78,76],height:5},
        {center:[-35,-105],radius:[110,65],height:24},{center:[35,-112],radius:[85,57],height:16},
        {center:[-112,-119],radius:[34,27],height:10},{center:[118,-40],radius:[29,39],height:8}],terrainBrushes:[
        {id:'north-ridge-gully-west',mode:'lower',region:{kind:'path',points:[[-71,-129],[-60,-109],[-67,-89]],width:9},amount:8,feather:8},
        {id:'north-ridge-gully-east',mode:'lower',region:{kind:'path',points:[[4,-139],[19,-117],[31,-99]],width:8},amount:7,feather:8},
        {id:'southwest-bay-inlet',mode:'lower',region:{kind:'path',points:[[-190,114],[-169,97],[-153,88]],width:18},amount:5,feather:14},
        {id:'east-farm-soft-ground',mode:'flatten',region:{kind:'circle',center:[93,47],radius:44},height:8,strength:.35,feather:16}]},
      ecology:[],roads:[],towns:[{id:'southwest-port',name:'Southwest Port',prompt:'A continuous harbor town',population:250,
        radius:95,blend:28,terrainMode:'conform',region:'center',kind:'city',pattern:'organic',density:.62,
        waterfrontBias:.8,targetWaterBodyId:'sea',publicBuildings:[
          {id:'fish-market',use:'waterfront fish market',width:15,depth:11,height:6,assetKey:'market',siting:'waterfront'},
          {id:'port-warehouse',use:'port warehouse',width:14,depth:10,height:6,assetKey:'warehouse',siting:'waterfront'},
          {id:'courtyard-school',use:'courtyard school',width:100,depth:100,height:8,assetKey:'school',siting:'central'}]}]}};
    const intent=parseWorldIntentDraft(raw,input);
    let message='';
    try {createWorldSitingEvidence(intent);} catch(error) {message=error instanceof Error?error.message:String(error);}
    const prefix='world_no_settlement_candidates:southwest-port:';
    expect(message.startsWith(prefix)).toBe(true);
    const failures=JSON.parse(message.slice(prefix.length)) as Array<{candidateId:string;reason:string}>;
    expect(failures.map(failure=>failure.candidateId))
      .toEqual(Array.from({length:7},(_,index)=>`southwest-port-site-${index+1}`));
    expect(failures.find(failure=>failure.candidateId==='southwest-port-site-6')?.reason)
      .toContain('world_settlement_no_landmark_site:courtyard-school:');
    expect(failures.find(failure=>failure.candidateId==='southwest-port-site-7')?.reason)
      .toContain('world_settlement_no_waterfront_site:fish-market');
  },15_000);

  it('keeps one shared candidate graph for a three-town chain at 500 metres', () => {
    const input:WorldGenerationRequest={prompt:'Three close grassland settlements linked in a chain',seed:91,size:500,generateAssets:false};
    const makeTown=(id:string,region:'west'|'center'|'east',publicBuildings:unknown[]=[])=>({id,name:id,prompt:id,
      radius:50,blend:50,terrainMode:'conform',region,kind:'village',pattern:'organic',density:.3,publicBuildings});
    const raw={plan:{version:1,id:'three-town-chain',revision:1,prompt:input.prompt,
      recipe:{version:1,seed:input.seed,size:input.size,heightScale:.02,constraints:[
        {region:'west',biome:'grassland'},{region:'center',biome:'grassland'},{region:'east',biome:'grassland'}]},
      ecology:[],towns:[makeTown('a','west'),makeTown('b','center',[
        {id:'well',use:'public well',width:6,depth:6,height:4,assetKey:'well'}]),makeTown('c','east')],roads:[
        {id:'ab',name:'A to B',fromTownId:'a',toTownId:'b',width:3,tags:['path']},
        {id:'bc',name:'B to C',fromTownId:'b',toTownId:'c',width:3,tags:['path']}
      ]}};
    const intent=parseWorldIntentDraft(raw,input),evidence=createWorldSitingEvidence(intent);
    expect(evidence.connections).toHaveLength(2);
    expect(evidence.connections.every(connection=>connection.available)).toBe(true);
    expect(evidence.connections.find(connection=>connection.roadId==='ab')!.toCandidateId)
      .toBe(evidence.connections.find(connection=>connection.roadId==='bc')!.fromCandidateId);
    expect(evidence.towns.every(town=>town.candidates.length===1)).toBe(true);
    const landmarkLayout=evidence.landmarkLayouts.find(item=>item.townId==='b'&&item.pattern==='organic')!;
    expect(landmarkLayout.landmarks).toEqual([expect.objectContaining({id:'well',assetKey:'well'})]);
    const choices=evidence.towns.map(town=>({townId:town.id,candidateId:town.candidates[0].id,
      ...(town.id==='b'?{landmarkLayoutId:landmarkLayout.id}:{})}));
    const layout={towns:choices,settlements:intent.plan.towns.map(town=>({townId:town.id,
      options:{kind:'village',pattern:'organic',density:.3}})),assets:[{key:'well',name:'Well',role:'landmark',
        prompt:'A small public well',dimensions:[6,4,6],strategy:'single'}]};
    expect(()=>materializeWorldIntent(intent,evidence,layout,input)).not.toThrow();
    const changed=structuredClone(layout);
    changed.settlements[0].options.density=.9;
    expect(()=>materializeWorldIntent(intent,evidence,changed,input)).toThrow('world_layout_settlement_intent_mismatch:a');
  },15_000);

  it('validates a no-public grid town and rejects a Stage2 pattern change', () => {
    const raw=rawSoloIntent() as any;
    raw.plan.towns[0].pattern='grid';
    const intent=parseWorldIntentDraft(raw,request),evidence=createWorldSitingEvidence(intent),candidate=evidence.towns[0].candidates[0];
    const layout={towns:[{townId:'market-town',candidateId:candidate.id}],settlements:[{townId:'market-town',
      options:{kind:'city',pattern:'grid',density:.8}}],assets:[]};
    expect(()=>materializeWorldIntent(intent,evidence,layout,request)).not.toThrow();
    layout.settlements[0].options.pattern='organic';
    expect(()=>materializeWorldIntent(intent,evidence,layout,request)).toThrow('world_layout_settlement_intent_mismatch:market-town');
  },15_000);

  it('keeps waterfront quality as diagnostics instead of rejecting a renderable patch', () => {
    const input:WorldGenerationRequest={prompt:'A compact fishing town on a warm bay',seed:9012903,size:500,generateAssets:false};
    const intent=parseWorldIntentDraft(rawHarborIntent(input),input),evidence=createWorldSitingEvidence(intent);
    const candidate=evidence.towns[0].candidates[0],layout={towns:[{townId:'bay-town',candidateId:candidate.id}],
      settlements:[{townId:'bay-town',options:{kind:'city',pattern:'organic',density:.83,waterfrontBias:.9}}],assets:[]};
    const compiled=materializeWorldIntent(intent,evidence,layout,input),patch=compiled.bundle.patches[0];
    expect(compiled.bundle.plan.towns[0].targetWaterBodyId).toBe('sea');
    expect(patch.streets.some(street=>street.tags.includes('waterfront'))).toBe(true);
    expect(patch.buildings.length).toBeGreaterThan(0);

    const sample=createWorldSampler(intent.plan.recipe),inland={...candidate,id:'forced-inland',center:[112,112] as [number,number],
      foundation:sample(112,112).height};
    const forged={...evidence,towns:[{id:'bay-town',candidates:[inland]}],landmarkLayouts:[]};
    expect(()=>materializeWorldIntent(intent,forged,{...layout,towns:[{townId:'bay-town',candidateId:inland.id}]},input))
      .not.toThrow();
  },15_000);

  it('keeps the server-owned prompt when every model response changes its echo', async () => {
    const intent = rawSoloIntent();
    intent.plan.prompt = 'Silently changed destination';
    const {layout}=soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(intent)).mockResolvedValueOnce(JSON.stringify(layout));
    const result=await generateWorld({...request,repairAttempts:1}, {} as MapStore);
    expect(result.bundle.plan.prompt).toBe(request.prompt);
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
  });

  it('rejects a legacy-shaped live response instead of bypassing sampled siting', async () => {
    mocks.llmChat.mockResolvedValue(JSON.stringify(validDraft()));
    await expect(generateWorld(request, {} as MapStore)).rejects.toThrow('world_unknown_intent_field:settlements');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.rejected',expect.objectContaining({attempt:0}));
  });

  it('uses sampled candidates instead of guessed town centers for seed 9012901', async () => {
    const input: WorldGenerationRequest = {prompt:'Desert spring town linked to a coastal fishing village',seed:9012901,size:2000,generateAssets:false};
    const intent=rawSeedIntent(),parsed=parseWorldIntentDraft(intent,input),evidence=createWorldSitingEvidence(parsed);
    const connections=evidence.connections.filter(item=>item.available);
    expect(connections.length).toBeGreaterThan(0);
    expect(evidence.towns.find(town=>town.id==='fishing-village')!.candidates[0]).toEqual(expect.objectContaining({
      dryRatio:expect.any(Number),passableDirections:expect.any(Number),water:expect.objectContaining({type:'sea'})
    }));
    const settlements=[
      {townId:'spring-town',options:{kind:'city' as const,pattern:'organic' as const,density:.45,waterfrontBias:.7}},
      {townId:'fishing-village',options:{kind:'village' as const,pattern:'organic' as const,density:.4,waterfrontBias:.85}}
    ];
    const connection=connections[0];
    const landmarkLayout=evidence.landmarkLayouts.find(item=>item.townId==='spring-town'&&item.candidateId===connection.toCandidateId&&item.pattern==='organic')!;
    expect(landmarkLayout.landmarks[0]).toEqual(expect.objectContaining({id:'market',assetKey:'market'}));
    const layout={towns:[{townId:'fishing-village',candidateId:connection.fromCandidateId},
      {townId:'spring-town',candidateId:connection.toCandidateId,landmarkLayoutId:landmarkLayout.id}],settlements,
      assets:[{key:'market',name:'Market',role:'landmark',prompt:'A small open public market',dimensions:[12,6,10],enterable:true,strategy:'assembly'}]};
    expect(()=>materializeWorldIntent(parsed,evidence,layout,input)).not.toThrow();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(intent)).mockResolvedValueOnce(JSON.stringify(layout));
    const result=await generateWorld(input,{} as MapStore);
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    const intentPrompt=(mocks.llmChat.mock.calls[0][0] as Array<{role:string;content:string}>)[0].content;
    const layoutPrompt=(mocks.llmChat.mock.calls[1][0] as Array<{role:string;content:string}>)[0].content;
    expect(intentPrompt).toContain('Biomes: ocean/grassland/forest/desert/mountains/snow');
    expect(intentPrompt).toContain("mode:'raise'|'lower'");
    expect(intentPrompt).toContain("mode:'grade'");
    expect(intentPrompt).toContain('prefer heightScale around 0.08..0.15');
    expect(intentPrompt).toContain("shorelineProfile?:'steep'|'gentle'");
    expect(layoutPrompt).toContain('Omit existingAssetId when requesting a new asset');
    expect(layoutPrompt).toContain('visualSize is its authoritative measured');
    expect(result.bundle.plan.towns.find(town=>town.id==='fishing-village')!.center).not.toEqual([-450,250]);
    expect(result.bundle.plan.roads[0].points.length).toBeGreaterThanOrEqual(2);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.siting',expect.objectContaining({evidence:expect.any(Object)}));
  },15_000);
});

describe('world asset assembly', () => {
  it('routes small reusable models and modular enterable landmarks deliberately', () => {
    const cases: Array<[WorldAssetRequest, 'single' | 'assembly']> = [
      [{ key: 'house', name: 'House', role: 'house', prompt: 'Small plaster house', strategy: 'single' }, 'single'],
      [{ key: 'workshop', name: 'Workshop', role: 'workshop', prompt: 'Open workshop', enterable: true }, 'assembly'],
      [{ key: 'cathedral', name: 'Cathedral', role: 'landmark', prompt: 'Cathedral with nave', dimensions: [32, 28, 48] }, 'assembly'],
      [{ key: 'statue', name: 'Statue', role: 'landmark', prompt: 'Small stone statue', dimensions: [4, 8, 4], strategy: 'single' }, 'single']
    ];
    for (const [asset, expected] of cases) expect(worldAssetStrategy(asset)).toBe(expected);
  });

  it('preserves object world transforms and the renderer centering frame', () => {
    const map = createEmptyMap('Assembly');
    const parent = createMapObject('Parent');
    parent.id = 'parent';
    parent.transform.position = [10, 2, 20];
    parent.transform.rotation = [0, Math.PI / 2, 0];
    parent.transform.scale = [2, 2, 2];
    const child = createMapObject('Module', 'asset-a');
    child.id = 'module';
    child.parentId = parent.id;
    child.transform.position = [1, 3, 0];
    child.transform.rotation = [0, 0.2, 0];
    child.transform.scale = [0.5, 1, 0.5];
    map.objects.push(parent, child);
    const modelJson = { format: 2, nodes: [
      { id: 'body', transform: { pos: [2, 1, 0] }, mesh: { type: 'box', params: { width: 2, height: 2, depth: 2 } } },
      { id: 'detail', parent: 'body', transform: { pos: [0, 1, 0] }, mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }
    ] };
    const asset = {
      id: 'asset-a', name: 'Module', prompt: '', modelJson, mode: 'voxel-pro', createdAt: 1, updatedAt: 1,
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false }
    } as MapAsset;
    const expected = getObjectWorldTransforms(map).get(child.id)!;
    const assembled = assembleWorldModel(map, [asset]) as { format: number; nodes: Array<Record<string, any>> };
    const root = assembled.nodes.find(node => node.id === child.id)!;
    const frame = assembled.nodes.find(node => node.id === child.id + '-frame')!;
    const body = assembled.nodes.find(node => node.id === child.id + '/body')!;
    const detail = assembled.nodes.find(node => node.id === child.id + '/detail')!;
    expect(assembled.format).toBe(2);
    expect(root.transform.pos).toEqual(expected.position);
    expect(root.transform.scale).toEqual(expected.scale);
    const expectedQuat = new Quaternion().setFromEuler(new Euler(...expected.rotation)).toArray();
    expect(root.transform.quat).toHaveLength(4);
    root.transform.quat.forEach((value: number, index: number) => expect(value).toBeCloseTo(expectedQuat[index], 10));
    expect(frame.transform.pos.map((value: number) => value || 0)).toEqual([-2, 0, 0]);
    expect(body.transform.pos).toEqual([2, 1, 0]);
    expect(body.parent).toBe(frame.id);
    expect(detail.parent).toBe(body.id);
  });

  it('loads an explicitly reused asset without generating or saving a duplicate', async () => {
    const asset = reusableAsset();
    const store = {
      loadAsset: vi.fn().mockResolvedValue(asset),
      saveAsset: vi.fn()
    } as unknown as MapStore;
    const [result] = await generateWorldAssets([{
      key: 'stone-house', name: 'Stone house', role: 'house', prompt: 'Reuse it',
      strategy: 'single', existingAssetId: asset.id
    }], store);
    expect(result).toMatchObject({ id: 'stone-house', assetId: asset.id, modelJson: asset.modelJson, provider: 'existing' });
    expect(store.loadAsset).toHaveBeenCalledWith(asset.id);
    expect(store.saveAsset).not.toHaveBeenCalled();
  });
});
