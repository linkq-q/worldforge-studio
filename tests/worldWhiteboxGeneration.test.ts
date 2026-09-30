import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWorld } from '../src/server/worldGeneration';
import { executeWorldWhitebox, generateWorldWhitebox,
  parseWorldWhiteboxInitialPlan, validateWorldWhiteboxRequest } from '../src/server/worldWhiteboxGeneration';
import type { MapStore } from '../src/server/mapStore';
import type { WorldPlan } from '../src/shared/worldPlanning';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), recordGenerationTrace: vi.fn() }));
vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(), llmChat: mocks.llmChat
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

describe('whitebox world generation', () => {
  beforeEach(() => { mocks.llmChat.mockReset(); mocks.recordGenerationTrace.mockReset(); });

  it('keeps the whitebox request small and rejects asset generation or retries', () => {
    expect(validateWorldWhiteboxRequest(request)).toMatchObject({ size: 500, generateAssets: false, repairAttempts: 0 });
    expect(() => validateWorldWhiteboxRequest({ ...request, generateAssets: true })).toThrow();
    expect(() => validateWorldWhiteboxRequest({ ...request, repairAttempts: 1 })).toThrow();
  });

  it('uses one GPT call and preserves the raw first plan through observation and final output', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    const result = await generateWorld(request, {} as MapStore);
    if (!('mode' in result)) throw new Error('expected_whitebox_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.initial-plan']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt')).toBe(true);
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

  it('asks the first call to co-design playable 500m terrain, coast, anchors and routes with valid schema', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    await generateWorldWhitebox(request);
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('terrain, coastline, buildable settlement anchors and routes together');
    expect(systemPrompt).toContain('heightScale around 0.08..0.15');
    expect(systemPrompt).toContain('strong ocean constraints may use about 0.02..0.04');
    expect(systemPrompt).toContain('Ocean is terrain below 0');
    expect(systemPrompt).toContain('north is negative Z');
    expect(systemPrompt).toContain('do not fake a bay or harbour with a round lake');
    expect(systemPrompt).toContain('every patch needs a unique id and a bounded shape');
    expect(systemPrompt).toContain('every river must include its complete region, levels and depth');
    expect(systemPrompt).toContain('never underwater');
    expect(systemPrompt).toContain('without an intentionally authored crossing');
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
    plan.explorationPlan!.pointsOfInterest = [];
    plan.explorationPlan!.sequence = [];
    const result = executeWorldWhitebox(plan);
    expect(result.execution.pointsOfInterest).toEqual([]);
    expect(result.surfaceFacts.heightRange.every(Number.isFinite)).toBe(true);
  });
});
