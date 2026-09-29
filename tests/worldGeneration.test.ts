import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Euler, Quaternion } from 'three';
import { createEmptyMap, createMapObject, getObjectWorldTransforms, type MapAsset } from '../src/shared/map';
import { createWorldSampler } from '../src/shared/worldTerrain';
import {
  assembleWorldModel, auditWorldSettlementCoverage, compileWorldDraft, createWorldSitingEvidence, generateWorld, generateWorldAssets,
  materializeWorldIntent, parseWorldIntentDraft, validateWorldGenerationRequest, worldAssetStrategy,
  WORLD_GENERATION_PROMPT, type WorldAssetRequest, type WorldGenerationRequest
} from '../src/server/worldGeneration';
import type { MapStore } from '../src/server/mapStore';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), recordGenerationTrace: vi.fn() }));
vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(),
  llmChat: mocks.llmChat
}));
vi.mock('../src/server/generationTrace', () => ({ recordGenerationTrace: mocks.recordGenerationTrace }));

const request: WorldGenerationRequest = { prompt: 'A compact grassland town', seed: 2309, size: 1600, generateAssets: false };

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

  it('keeps all intent fields when GPT places towns and roads beside plan', () => {
    const source = rawSoloIntent();
    const { towns, roads, ...plan } = source.plan;
    const parsed = parseWorldIntentDraft({ plan, towns, roads }, request);
    expect(parsed.plan.towns.map(town => town.id)).toEqual(['market-town']);
    expect(parsed.plan.roads).toEqual([]);
    expect(() => parseWorldIntentDraft({ plan, towns, roads, extra: true }, request))
      .toThrow('world_unknown_intent_field:towns');
  });

  it('accepts one surplus closing brace only when the remaining JSON is complete', async () => {
    const { layout } = soloLayout();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(rawSoloIntent()) + '}')
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
    expect(() => compileWorldDraft(wrongPrompt, request)).toThrow('world_prompt_request_mismatch');

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

  it('repairs an invalid GPT intent once and returns geometry audits', async () => {
    const {intent,layout}=soloLayout();
    mocks.llmChat
      .mockResolvedValueOnce(JSON.stringify({ ...rawSoloIntent(), accidentalTopology: true }))
      .mockResolvedValueOnce(JSON.stringify(rawSoloIntent()))
      .mockResolvedValueOnce(JSON.stringify(layout));

    const result = await generateWorld({...request,repairAttempts:1}, {} as MapStore);
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    const repairMessages = mocks.llmChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(JSON.parse(repairMessages.at(-1)!.content).error).toBe('world_unknown_intent_field:accidentalTopology');
    expect(JSON.parse(repairMessages.at(-1)!.content).instruction).toContain('only a plan key');
    expect(result.bundle.plan.id).toBe(intent.plan.id);
    expect(result.bundle.plan.recipe.heightScale).toBe(0.1);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      townId: 'market-town', buildingCount: expect.any(Number), roadSurfaceArea: expect.any(Number),
      builtFootprintArea: expect.any(Number), roadWidthRange: expect.any(Array), maxRoadSlope: expect.any(Number),
      publicBuildings: 0, recommendedPublicBuildings: expect.any(Array),
      planningIssues: expect.arrayContaining(['missing_public_function', 'missing_external_connection'])
    }));
  });

  it('reports a tiny inland knot and missing sea landing in a large harbor town', () => {
    const building=(id:string,x:number,z:number)=>({id,x,z,width:8,depth:8,height:6,use:'home'});
    const small={buildings:Array.from({length:11},(_,index)=>building('b'+index,(index%4)*4,Math.floor(index/4)*4)),
      streets:[{id:'shore',name:'shore',points:[[0,0],[20,0]] as [number,number][],curve:'polyline' as const,
        closed:false,width:4,tags:['waterfront']}]} ;
    const town={radius:105,targetWaterBodyId:'sea'};
    const settings={kind:'village' as const,density:.48,waterfrontBias:.85};
    expect(auditWorldSettlementCoverage(town,small,settings,8).planningIssues).toEqual([
      'underbuilt_settlement','clustered_settlement','missing_sea_landing']);
    const grown={buildings:[building('west',-75,-40),building('east',75,40)],
      streets:[{...small.streets[0],tags:['waterfront','sea-landing']}]};
    expect(auditWorldSettlementCoverage(town,grown,settings,32)).toMatchObject({
      builtExtent:expect.any(Number),planningIssues:[]});
  });

  it('prompts for a settlement-specific economy and civic program before street layout', () => {
    expect(WORLD_GENERATION_PROMPT).toContain('livelihood, population scale, external logistics, public services');
    expect(WORLD_GENERATION_PROMPT).toContain('one public or landmark building per 10..20 ordinary buildings');
    expect(WORLD_GENERATION_PROMPT).toContain('Do not copy one civic checklist into every settlement');
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
    expect(messages[0].content).toContain('Ecology region is a circle/path object');
    expect(messages[0].content).toContain('exactly four ascending metre values');
    expect(messages[0].content).toContain("reliefProfile:'compact'");
    expect(messages[0].content).toContain('for size 500 these minima are 50m and 20m');
    expect(messages[0].content).toContain('one useful public or landmark building per 10..20 ordinary buildings');
    expect(messages[0].content).toContain('Size and distribute inhabited districts against the usable land');
    expect(messages[0].content).toContain('one ordinary dwelling per four to six residents');
    expect(messages[0].content).toContain('Roads connect two different town IDs only');
    expect(messages[0].content).toContain("Rocky terrain uses mountains, not a 'rock' biome");
    expect(messages[0].content).toContain('reserve only one or two waterfront work buildings');
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

  it('accepts only a final harbor patch with homes and an actual waterfront street', () => {
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
      .toThrow('world_settlement_waterfront_unreachable:bay-town');
  },15_000);

  it('fails after the single repair instead of accepting changed request semantics', async () => {
    const intent = rawSoloIntent();
    intent.plan.prompt = 'Silently changed destination';
    mocks.llmChat.mockResolvedValue(JSON.stringify(intent));
    await expect(generateWorld({...request,repairAttempts:1}, {} as MapStore)).rejects.toThrow('world_prompt_request_mismatch');
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
