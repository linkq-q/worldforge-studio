import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWorld, type WorldAssetRequest } from '../src/server/worldGeneration';
import { executeWorldWhitebox, generateWorldWhitebox,
  materializeWorldWhiteboxConstruction, parseWorldWhiteboxInitialPlan,
  validateWorldWhiteboxConstructionRequest, validateWorldWhiteboxRequest } from '../src/server/worldWhiteboxGeneration';
import type { MapStore } from '../src/server/mapStore';
import { validateWorldPlan, type WorldPlan } from '../src/shared/worldPlanning';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), generateModel: vi.fn(), recordGenerationTrace: vi.fn() }));
vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(), llmChat: mocks.llmChat, generateModel: mocks.generateModel
}));
vi.mock('../src/server/generationTrace', () => ({ recordGenerationTrace: mocks.recordGenerationTrace }));

const prompt = 'A volcanic bay with a harbor town, bridge, ruins, farms, and a quiet crater trail';
const request = { mode: 'whitebox' as const, prompt, seed: 74, size: 500 as const, generateAssets: false as const };

function originalPlan(): WorldPlan {
  return {
    version: 1 as const, id: 'volcanic-bay', revision: 1, prompt, whitebox: true as const,
    recipe: { version: 1 as const, seed: 74, size: 500, reliefProfile: 'compact' as const,
      constraints: [{ region: 'center' as const, biome: 'grassland' as const },
        { region: 'west' as const, biome: 'ocean' as const },
        { region: 'north' as const, biome: 'mountains' as const }],
      landforms: [{ center: [0, -125], radius: [65, 70], height: 42 }] },
    ecology: [], towns: [], roads: [],
    concept: { premise: 'A working volcanic bay', themes: ['trade', 'ruins'], experience: 'Cross the estuary, climb to the crater' },
    featureGraph: {
      regions: [
        { id: 'bay', kind: 'coast', name: 'Bay', center: [0, 60], radius: 100 },
        { id: 'crater', kind: 'volcano', name: 'Crater', center: [0, -125], radius: 70 },
        { id: 'hinterland', kind: 'farmland', name: 'Fields', center: [130, 80], radius: 65 }
      ],
      paths: [
        { id: 'harbor-road', kind: 'road', name: 'Harbor road', points: [[-70, 60], [0, 50], [130, 80]], width: 5 },
        { id: 'crater-trail', kind: 'trail', name: 'Crater trail', points: [[0, 50], [0, -125]], width: 2 }
      ],
      anchors: [
        { id: 'harbor', kind: 'settlement', position: [-70, 60], regionId: 'bay' },
        { id: 'bridge', kind: 'crossing', position: [0, 50], regionId: 'bay' },
        { id: 'farm', kind: 'settlement', position: [130, 80], regionId: 'hinterland' },
        { id: 'ruins', kind: 'ruins', position: [0, -125], regionId: 'crater' }
      ],
      relations: [{ fromId: 'harbor', toId: 'bridge', kind: 'trade access' },
        { fromId: 'bridge', toId: 'farm', kind: 'food route' }]
    },
    settlementPlan: { settlements: [{ id: 'port-town', anchorId: 'harbor', role: 'dense waterfront, civic core, looser uphill homes' },
      { id: 'farm-hamlet', anchorId: 'farm', role: 'sparse working farms' }] },
    mobilityPlan: { routes: [{ id: 'trade', pathId: 'harbor-road', mode: 'cart road and bridge', connects: ['harbor', 'bridge', 'farm'] },
      { id: 'ascent', pathId: 'crater-trail', mode: 'foot trail', connects: ['bridge', 'ruins'] }] },
    explorationPlan: { pointsOfInterest: [{ id: 'port', anchorId: 'harbor', purpose: 'Start and trade' },
      { id: 'crossing', anchorId: 'bridge', purpose: 'Cross estuary' },
      { id: 'old-city', anchorId: 'ruins', purpose: 'Explore ruins' }],
      sequence: ['port', 'crossing', 'old-city'] },
    intentionalEmptyAreas: [{ id: 'quiet-crater', regionId: 'crater', purpose: 'A quiet volcanic ascent before the ruins' }]
  };
}

function buildablePlan(): WorldPlan {
  return {
    version: 1, id: 'buildable-whitebox', revision: 1, prompt: 'A compact woodland market village', whitebox: true,
    recipe: { version: 1, seed: 91, size: 500, reliefProfile: 'compact', heightScale: 0.02,
      constraints: [{ region: 'center', biome: 'grassland' }],
      landforms: [{ center: [0, 0], radius: [180, 180], height: 12 }] },
    ecology: [], towns: [], roads: [],
    concept: { premise: 'A market in a woodland clearing', themes: ['trade'], experience: 'Arrive through the grove' },
    featureGraph: {
      regions: [{ id: 'village-region', kind: 'settlement', name: 'Market clearing', center: [0, 0], radius: 80 }],
      paths: [{ id: 'arrival-path', kind: 'road', name: 'Arrival road', points: [[-120, 0], [0, 0], [120, 0]], width: 5 }],
      anchors: [{ id: 'village-anchor', kind: 'settlement', position: [0, 0], regionId: 'village-region' }],
      relations: []
    },
    settlementPlan: { settlements: [{ id: 'market-village', anchorId: 'village-anchor', role: 'homes around a working market' }] },
    mobilityPlan: { routes: [{ id: 'arrival-route', pathId: 'arrival-path', mode: 'cart road', connects: ['village-anchor'] }] },
    explorationPlan: { pointsOfInterest: [{ id: 'market', anchorId: 'village-anchor', purpose: 'trade' }], sequence: ['market'] },
    intentionalEmptyAreas: []
  };
}

function harborPlan(): WorldPlan {
  const plan = buildablePlan();
  plan.id = 'coastal-harbor';
  plan.prompt = 'A compact harbor town built out from the coast';
  plan.recipe = { version: 1, seed: 74, size: 500, reliefProfile: 'compact', heightScale: 0.02,
    constraints: [{ region: 'center', biome: 'grassland' }, { region: 'west', biome: 'ocean' }] };
  plan.featureGraph!.regions[0] = { id: 'harbor-region', kind: 'coast', name: 'Harbor coast', center: [-70, 60], radius: 80 };
  plan.featureGraph!.paths[0] = { id: 'harbor-road', kind: 'road', name: 'Harbor road', points: [[-70, 60], [100, 60]], width: 5 };
  plan.featureGraph!.anchors[0] = { id: 'dock-anchor', kind: 'harbor', position: [-70, 60], regionId: 'harbor-region' };
  plan.settlementPlan!.settlements[0] = { id: 'port-town', anchorId: 'dock-anchor', role: 'port-quays and uphill homes' };
  plan.mobilityPlan!.routes[0] = { id: 'harbor-route', pathId: 'harbor-road', mode: 'cart road', connects: ['dock-anchor'] };
  plan.explorationPlan = { pointsOfInterest: [{ id: 'port', anchorId: 'dock-anchor', purpose: 'trade' }], sequence: ['port'] };
  return plan;
}

function constructionExpansion(assetCount = 0) {
  const assets: WorldAssetRequest[] = Array.from({ length: assetCount }, (_, index) => ({
    key: `asset-${index + 1}`, name: `Asset ${index + 1}`, role: index === 1 ? 'tree' : 'house',
    prompt: `Direct visible model ${index + 1}`, strategy: 'single',
    ...(index === 1 ? { ecologyKind: 'broadleaf', ecologyRuleId: 'grove' } : {})
  }));
  return {
    towns: [{ id: 'market-village', name: 'Market Village', kind: 'village', pattern: 'organic', density: 0.45,
      publicBuildings: [] as Array<{ id: string; use: string; width: number; depth: number; height: number;
        assetKey: string; siting?: 'central' | 'waterfront' | 'gateway' | 'high-ground' }> }],
    ecology: [{ id: 'grove', kind: 'broadleaf', biome: 'grassland', density: 0.2, spacing: 14,
      maxSlope: 35, scale: [0.8, 1.2] }],
    assets
  };
}

describe('whitebox world generation', () => {
  beforeEach(() => { mocks.llmChat.mockReset(); mocks.generateModel.mockReset(); mocks.recordGenerationTrace.mockReset(); });

  it('keeps the whitebox request small and rejects asset generation or retries', () => {
    expect(validateWorldWhiteboxRequest(request)).toMatchObject({ size: 500, generateAssets: false, repairAttempts: 0 });
    expect(() => validateWorldWhiteboxRequest({ ...request, generateAssets: true })).toThrow();
    expect(() => validateWorldWhiteboxRequest({ ...request, repairAttempts: 1 })).toThrow();
  });

  it('uses one GPT call and preserves the raw first plan through observation and final output', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    const result = await generateWorld(request, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'whitebox') throw new Error('expected_whitebox_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.initial-plan']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt')).toBe(true);
    expect(mocks.llmChat.mock.calls[0][1].maxAttempts).toBe(1);
    expect(result.paidCallCount).toBe(1);
    expect(result.mode).toBe('whitebox');
    expect(result.bundle.patches).toEqual([]);
    expect(result.assetSources).toEqual([]);
    expect(result.initialPlan).toEqual(result.finalPlan);
    expect(result.observation.scope).toBe('executed');
    expect(result.observation.pointsOfInterest.realizedCount).toBe(3);
    expect(result.adjustment).toEqual({
      decision: 'keep', applied: false, skipped: true, reason: 'raw_first_call_preserved'
    });
  });

  it('completes one 500m prompt in two first-pass GPT stages and at most three direct DeepSeek calls', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(3)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `complete-${++id}` })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, repairAttempts: 0 }, store);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.initial-plan', 'world.whitebox.construction']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt' && options.maxAttempts === 1)).toBe(true);
    expect(mocks.llmChat.mock.calls[1][0][0].content).toContain('do not rename a biome-specific asset');
    expect(JSON.parse(mocks.llmChat.mock.calls[1][0][1].content).whiteboxPlan).toEqual(result.initialPlan);
    expect(mocks.generateModel).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel.mock.calls.every(([, options]) => options.providers?.join() === 'deepseek')).toBe(true);
    expect(result.paidCallCount).toBe(5);
    expect(result.initialPlan).toEqual(result.finalPlan);
    expect(result.adjustment).toEqual({ decision: 'keep', applied: false, skipped: true,
      reason: 'raw_first_call_preserved' });
  });

  it('honours disabled asset generation in the complete flow', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion()));

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: false, repairAttempts: 0 }, {} as MapStore);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.generateModel).not.toHaveBeenCalled();
    expect(result.paidCallCount).toBe(2);
  });

  it('honours a smaller complete-flow DeepSeek budget without a repair pass', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(2)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `capped-${++id}` })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, assetGenerationLimit: 2, repairAttempts: 0 }, store);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.generateModel).toHaveBeenCalledTimes(2);
    expect(result.paidCallCount).toBe(4);
  });

  it('rejects a fourth complete-flow asset before any DeepSeek call', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(4)));

    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, repairAttempts: 0 }, {} as MapStore))
      .rejects.toThrow('world_whitebox_asset_generation_limit');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('keeps complete generation fixed at 500m with zero repair attempts', async () => {
    const plan = buildablePlan();
    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 600, generateAssets: false, repairAttempts: 0 }, {} as MapStore))
      .rejects.toThrow('invalid_complete_world_generation_request');
    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: false, repairAttempts: 1 }, {} as MapStore))
      .rejects.toThrow('invalid_complete_world_generation_request');
    expect(mocks.llmChat).not.toHaveBeenCalled();
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('loads a first-call prose siting as a visible technical normalization without retrying', () => {
    const expansion = JSON.parse(JSON.stringify(constructionExpansion()));
    expansion.towns[0].publicBuildings = [
      { id: 'market', use: 'town meeting hall', width: 10, depth: 8, height: 6,
        assetKey: 'market', siting: 'Front onto the shared gathering space near the quay-lane junction.' },
      { id: 'fish-hall', use: 'fish exchange', width: 9, depth: 7, height: 5,
        assetKey: 'fish-hall', siting: 'Place on the dry inner-shore terrace beside the route.' }
    ];
    expansion.assets.push(
      { key: 'market', name: 'Market hall', role: 'landmark', prompt: 'Market hall', strategy: 'single' },
      { key: 'fish-hall', name: 'Fish hall', role: 'landmark', prompt: 'Fish hall', strategy: 'single' }
    );
    const raw = JSON.stringify(expansion);
    const result = materializeWorldWhiteboxConstruction(raw, {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(buildablePlan()),
      generateAssets: true, assetGenerationLimit: 2, repairAttempts: 0
    });
    expect(result.towns[0].publicBuildings.map(building => building.siting)).toEqual(['central', 'waterfront']);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toEqual(expect.arrayContaining([
      'siting_prose_normalized:market:central', 'siting_prose_normalized:fish-hall:waterfront'
    ]));
    expect(JSON.stringify(expansion)).toBe(raw);
  });

  it('asks the first call to co-design playable 500m terrain, coast, anchors and routes with valid schema', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    await generateWorldWhitebox(request);
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('terrain, coastline, buildable settlement anchors and routes together');
    expect(systemPrompt).toContain('heightScale around 0.08..0.15');
    expect(systemPrompt).toContain('strong ocean constraints may use about 0.02..0.04');
    expect(systemPrompt).toContain('Ocean is terrain below 0');
    expect(systemPrompt).toContain("mode:'crater'");
    expect(systemPrompt).toContain('Use crater, not a circular lower brush, for a volcanic crater on a mound');
    expect(systemPrompt).toContain('depth lowers central floor below pre-brush sampled rim');
    expect(systemPrompt).toContain('north is negative Z');
    expect(systemPrompt).toContain('do not fake a bay or harbour with a round lake');
    expect(systemPrompt).toContain('every patch needs a unique id and a bounded shape');
    expect(systemPrompt).toContain('Biome-patch feather is a transition distance in world metres, not a 0..1 softness ratio');
    expect(systemPrompt).toContain('every river must include its complete region, levels and depth');
    expect(systemPrompt).toContain('Trace river centerlines through plausible low ground');
    expect(systemPrompt).toContain('long straight chord across hills reads like a canal');
    expect(systemPrompt).toContain('lateral swings of roughly several channel widths');
    expect(systemPrompt).toContain('artificial canals and steep mountain streams may be straighter exceptions');
    expect(systemPrompt).toContain('gentle downstream slope');
    expect(systemPrompt).toContain('compatible levels at confluences');
    expect(systemPrompt).toContain('never underwater');
    expect(systemPrompt).toContain('without an intentionally authored crossing');
    expect(systemPrompt).toContain('Show the whole inhabited footprint of a requested town');
    expect(systemPrompt).toContain('A settlement is one distinct inhabited destination, never one district');
    expect(systemPrompt).toContain('if the user asks for one town, return exactly one settlement');
    expect(systemPrompt).toContain('Reserve extra settlements for genuinely separate destinations');
    expect(systemPrompt).toContain('do not promote them to separate settlementPlan entries');
    expect(systemPrompt).toContain('Leave contiguous dry plots beside, rather than inside, road junctions');
    expect(systemPrompt).toContain('Keep ordinary routes human-scale relative to nearby buildings');
    expect(systemPrompt).toContain('ecology, towns and roads must be empty arrays');
  });

  it('preserves a model prompt echo in the raw plan while using the request-owned prompt for loading', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: { ...originalPlan(), prompt: 'shortened echo' } }));
    const result = await generateWorldWhitebox(request);
    expect((result.originalPlan as {prompt: string}).prompt).toBe('shortened echo');
    expect(result.initialPlan.prompt).toBe(prompt);
    expect(result.observation.technicalNormalizations).toEqual(['request_prompt_echo']);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.request-echo-normalized',
      { received: 'shortened echo', expected: prompt });
  });

  it('preserves detailed settlement roles and intentional return visits in a first-call journey', async () => {
    const plan = originalPlan();
    const role = 'A working harbor district with dry access to the quay, civic terrace and upper homes. '.repeat(4);
    plan.settlementPlan!.settlements[0].role = role;
    plan.explorationPlan!.sequence = ['port', 'crossing', 'port', 'old-city'];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }));
    const result = await generateWorldWhitebox(request);
    expect(result.finalPlan.settlementPlan!.settlements.find(item => item.id === 'port-town')?.role).toBe(role);
    expect(result.finalPlan.explorationPlan!.sequence).toEqual(['port', 'crossing', 'port', 'old-city']);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });

  it('loads a raw first-call whitebox with 0.6 shoreline variation and schema aliases without changing its semantic layout', () => {
    const source = originalPlan();
    const riverPath = { kind: 'path', points: [[0, 0], [30, 30]], width: 8 };
    const raw = { ...source, recipe: { ...source.recipe,
      waterBodies: [
        { id: 'bay', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 },
          levels: [0], depth: 8, shorelineIrregularity: 0.6 },
        { id: 'river', type: 'river', path: riverPath, levels: [5, 0] }
      ],
      biomePatches: [{ region: 'north', biome: 'mountains' }, { region: 'northeast', biome: 'scree' }]
    },
    towns: [{ id: 'port', anchorId: 'harbor', role: 'working harbor' }],
    roads: [{ id: 'road', pathId: 'harbor-road', character: 'busy quay' }],
    ecology: [{ id: 'grove', regionId: 'bay', character: 'wind-shaped trees' }] };
    const result = parseWorldWhiteboxInitialPlan(JSON.stringify({ plan: raw }), request);
    expect(result.rawPlan).toEqual(raw);
    expect(result.plan.recipe.waterBodies?.[0].shorelineIrregularity).toBe(0.6);
    expect(result.plan.recipe.waterBodies?.[1]).toMatchObject({ region: riverPath, depth: 1.5 });
    expect(result.plan.recipe.constraints).toContainEqual({ region: 'northeast', biome: 'mountains' });
    expect(result.plan.featureGraph?.anchors.map(anchor => anchor.id).sort())
      .toEqual(source.featureGraph!.anchors.map(anchor => anchor.id).sort());
    expect(result.plan.towns).toEqual([]);
    expect(result.technicalNormalizations).toContain('towns_semantic_notes_only');
  });

  it('samples creative terrain without applying density or realism gates', () => {
    const plan = originalPlan();
    plan.featureGraph!.paths[0].curve = 'catmull-rom';
    plan.explorationPlan!.pointsOfInterest = [];
    plan.explorationPlan!.sequence = [];
    const result = executeWorldWhitebox(plan);
    expect(result.execution.pointsOfInterest).toEqual([]);
    expect(result.execution.paths?.find(path => path.id === 'harbor-road')?.curve).toBe('catmull-rom');
    expect(result.surfaceFacts.heightRange.every(Number.isFinite)).toBe(true);
  });

  it('accepts a bounded no-repair construction asset budget', () => {
    const valid = { mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 };
    expect(validateWorldWhiteboxConstructionRequest(valid)).toMatchObject({
      mode: 'construct-whitebox', generateAssets: true, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 2 }).assetGenerationLimit).toBe(2);
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: -1 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 1.5 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 4 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, repairAttempts: 1 })).toThrow('invalid_world_whitebox_construction_request');
  });

  it('derives town ports only where a connected whitebox route reaches the dry town boundary', () => {
    const whiteboxPlan = validateWorldPlan(buildablePlan());
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].ports).toEqual([
      { id: 'whitebox-port-1-1-1', guideId: 'whitebox-access-1-1-1', position: [-80, 0], width: 5 },
      { id: 'whitebox-port-1-1-2', guideId: 'whitebox-access-1-1-2', position: [80, 0], width: 5 }
    ]);
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.points)
      .toEqual(whiteboxPlan.featureGraph!.paths[0].points);
    for (const port of result.plan.towns[0].ports) {
      const road = result.plan.roads.find(candidate => candidate.id === port.guideId)!;
      expect([road.points[0], road.points.at(-1)]).toContainEqual(port.position);
    }
    expect(result.plan.featureGraph).toEqual(whiteboxPlan.featureGraph);
    expect(result.plan.recipe).toEqual(whiteboxPlan.recipe);
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.curve).toBe('polyline');
  });

  it('preserves an explicitly authored curved whitebox route through construction', () => {
    const source = buildablePlan();
    source.featureGraph!.paths[0].curve = 'catmull-rom';
    const whiteboxPlan = validateWorldPlan(source);
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });

    expect(result.plan.featureGraph!.paths[0].curve).toBe('catmull-rom');
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.curve).toBe('catmull-rom');
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.points)
      .toEqual(whiteboxPlan.featureGraph!.paths[0].points);
  });

  it('diagnoses disconnected and wet route approaches instead of inventing town ports', () => {
    const disconnected = buildablePlan();
    disconnected.featureGraph!.paths[0].points = [[120, 120], [180, 180]];
    const disconnectedPlan = validateWorldPlan(disconnected);
    const absent = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: disconnectedPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(absent.plan.towns[0].ports).toEqual([]);
    expect(absent.diagnostics.flatMap(item => item.planningIssues))
      .toContain('route_settlement_disconnected:arrival-route:market-village');

    const wet = buildablePlan();
    wet.recipe.waterBodies = [{ id: 'east-gate-water', type: 'lake',
      region: { kind: 'circle', center: [80, 0], radius: 8 }, levels: [20], depth: 3 }];
    const wetPlan = validateWorldPlan(wet);
    const dryOnly = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: wetPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(dryOnly.plan.towns[0].ports).toEqual([
      { id: 'whitebox-port-1-1-1', guideId: 'whitebox-access-1-1-1', position: [-80, 0], width: 5 }
    ]);
    expect(dryOnly.diagnostics.flatMap(item => item.planningIssues))
      .toContain('route_settlement_port_on_water:arrival-route:market-village');
  });

  it('targets the sea when a planned harbor can reach sampled ocean shoreline', () => {
    const whiteboxPlan = validateWorldPlan(harborPlan());
    const expansion = constructionExpansion();
    expansion.towns[0].id = 'port-town';
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBe('sea');
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .not.toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('keeps an inland river port from pretending it has a sea landing', () => {
    const inland = buildablePlan();
    inland.featureGraph!.anchors[0].kind = 'harbor';
    inland.settlementPlan!.settlements[0].role = 'river port-quays and market homes';
    inland.recipe.waterBodies = [{ id: 'market-river', type: 'river',
      region: { kind: 'path', points: [[-160, 30], [160, 30]], width: 12 },
      levels: [5, 5], depth: 3 }];
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(inland), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBeUndefined();
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .not.toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('diagnoses a planned maritime harbor when no ocean shore is reachable', () => {
    const inland = buildablePlan();
    inland.featureGraph!.anchors[0].kind = '海港';
    inland.settlementPlan!.settlements[0].role = '码头、集市与居民区';
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(inland), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBeUndefined();
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('constructs the saved whitebox with one non-retrying GPT call and preserves every semantic coordinate', async () => {
    const whiteboxPlan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion()));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan, generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls[0][1]).toMatchObject({ provider: 'gpt', maxAttempts: 1,
      traceStage: 'world.whitebox.construction' });
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toContain("siting?:'central'|'waterfront'|'gateway'|'high-ground'");
    expect(systemPrompt).toContain("role:'house'|'shop'|'workshop'|'tree'|'landmark'");
    expect(systemPrompt).toContain('Do not put width, depth, height or use directly on an asset object.');
    expect(mocks.generateModel).not.toHaveBeenCalled();
    expect(result.paidCallCount).toBe(1);
    expect(result.originalPlan).toEqual(whiteboxPlan);
    expect(result.bundle.plan.recipe).toEqual(whiteboxPlan.recipe);
    expect(result.bundle.plan.featureGraph).toEqual(whiteboxPlan.featureGraph);
    expect(result.bundle.plan.mobilityPlan).toEqual(whiteboxPlan.mobilityPlan);
    expect(result.bundle.plan.roads[0].points).toEqual(whiteboxPlan.featureGraph!.paths[0].points);
    expect(result.bundle.plan.towns[0].center).toEqual(whiteboxPlan.featureGraph!.anchors[0].position);
    expect(result.bundle.patches[0].buildings.length).toBeGreaterThan(0);
    expect(result.bundle.patches[0].streets.some(street => street.tags.includes('port'))).toBe(true);
  });

  it('hard-rejects construction output that tries to rewrite the saved whitebox', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ ...constructionExpansion(), recipe: { size: 1000 } }));
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore)).rejects.toThrow('world_unknown_whitebox_construction_field');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('omits a named public building when GPT did not bind its explicit asset key', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'school', siting: 'central' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.bundle.patches.flatMap(patch => patch.buildings).some(building => building.assetKey === 'school')).toBe(false);
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('explicit_asset_unbound:school:school');
  });

  it('caps construction at three direct DeepSeek assets and reports the paid attempts', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion(3)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `saved-${++id}` })) } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.generateModel).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel.mock.calls.every(([, options]) => options.providers?.join() === 'deepseek')).toBe(true);
    expect(result.assetSources).toHaveLength(3);
    expect(result.paidCallCount).toBe(4);

    mocks.llmChat.mockReset().mockResolvedValueOnce(JSON.stringify(constructionExpansion(4)));
    mocks.generateModel.mockReset();
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store)).rejects.toThrow('world_whitebox_asset_generation_limit');
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('does not pay for a requested landmark when its town has no realized building', async () => {
    const expansion = constructionExpansion(1);
    expansion.assets.push({ key: 'unused-cooperative', name: 'Fishing Cooperative', role: 'landmark',
      prompt: 'A coastal cooperative for an unbuilt harbor', strategy: 'single' });
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-house' })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 2, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
    expect(result.paidCallCount).toBe(2);
    expect(result.draft.assets.map(asset => asset.key)).toEqual(['asset-1', 'unused-cooperative']);
    expect(result.assetSources?.map(asset => asset.id)).toEqual(['asset-1']);
  });

  it('rejects assembly requests before any paid asset generation', async () => {
    const expansion = constructionExpansion(1);
    expansion.assets[0].strategy = 'assembly';
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore)).rejects.toThrow('world_whitebox_direct_asset_required');
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('reuses supplied assets without spending the three-call DeepSeek budget', async () => {
    const expansion = constructionExpansion();
    expansion.assets = [{ key: 'house', name: 'Existing house', role: 'house', prompt: 'Reuse it',
      strategy: 'single', existingAssetId: 'existing-house' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const asset = { id: 'existing-house', name: 'Existing house', prompt: 'A market house', tags: ['house'],
      mode: 'voxel-pro', modelJson: { format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {
        width: 8, height: 7, depth: 9 } } }] } };
    const store = { loadAsset: vi.fn().mockResolvedValue(asset), saveAsset: vi.fn() } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0, reusableAssetIds: ['existing-house'] }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(1);
    expect(result.assetSources).toEqual([expect.objectContaining({ assetId: 'existing-house', provider: 'existing' })]);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('counts a failed DeepSeek request and returns the raw construction with diagnostics instead of repairing it', async () => {
    const expansion = constructionExpansion(1);
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'asset-1', siting: 'central' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    mocks.generateModel.mockRejectedValueOnce(new Error('deepseek_unavailable'));
    const store = { saveAsset: vi.fn() } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(2);
    expect(result.assetSources).toEqual([]);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toContain('asset_generation_failed:deepseek_unavailable');
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('explicit_asset_unbound:school:asset-1');
    expect(result.bundle.patches.flatMap(patch => patch.buildings).some(building => building.assetKey === 'asset-1')).toBe(false);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
  });

  it('keeps the first generated asset visible when a later paid asset request fails', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion(2)));
    mocks.generateModel.mockResolvedValueOnce({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] })
      .mockRejectedValueOnce(new Error('second_asset_failed'));
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-first' })) } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(3);
    expect(result.assetSources).toEqual([expect.objectContaining({ assetId: 'saved-first' })]);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toContain('asset_generation_failed:second_asset_failed');
    expect(mocks.generateModel).toHaveBeenCalledTimes(2);
  });
});
