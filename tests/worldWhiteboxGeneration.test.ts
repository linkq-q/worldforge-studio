import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWorld } from '../src/server/worldGeneration';
import { applyWorldWhiteboxAdjustment, executeWorldWhitebox, generateWorldWhitebox,
  validateWorldWhiteboxRequest } from '../src/server/worldWhiteboxGeneration';
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

  it('executes the original plan, observes it, and asks the same task once before keeping it', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }))
      .mockResolvedValueOnce(JSON.stringify({ decision: 'keep' }));
    const result = await generateWorld(request, {} as MapStore);
    if (!('mode' in result)) throw new Error('expected_whitebox_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.initial-plan', 'world.whitebox.adjustment']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt')).toBe(true);
    const adjustmentInput = JSON.parse(mocks.llmChat.mock.calls[1][0][1].content);
    expect(adjustmentInput).toHaveProperty('observation.pointsOfInterest.spacing');
    expect(adjustmentInput).toHaveProperty('observation.paths.components');
    expect(adjustmentInput.remainingAdjustmentBudget).toBe(1);
    expect(JSON.stringify(adjustmentInput)).not.toMatch(/image_url|data:image/i);
    expect(result.mode).toBe('whitebox');
    expect(result.bundle.patches).toEqual([]);
    expect(result.assetSources).toEqual([]);
    expect(result.initialPlan).toEqual(result.finalPlan);
    expect(result.observation.scope).toBe('executed');
    expect(result.observation.pointsOfInterest.realizedCount).toBe(3);
    expect(result.adjustment).toEqual({ decision: 'keep', applied: false });
  });

  it('applies one finite creator patch and reports a technically invalid patch without altering the original', async () => {
    const plan = originalPlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }))
      .mockResolvedValueOnce(JSON.stringify({ decision: 'patch', patch: {
        concept: { ...plan.concept, experience: 'Cross the bay, visit the farms, then climb' }
      } }));
    const result = await generateWorldWhitebox(request);
    expect(result.adjustment.applied).toBe(true);
    expect(result.initialPlan.revision).toBe(1);
    expect(result.finalPlan.revision).toBe(2);
    expect(result.finalPlan.concept?.experience).toContain('farms');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    const invalid = applyWorldWhiteboxAdjustment(result.initialPlan, { decision: 'patch', patch: {
      recipe: { ...result.initialPlan.recipe, size: 1000 }
    } });
    expect(invalid.plan).toEqual(result.initialPlan);
    expect(invalid.adjustment.error).toBe('world_whitebox_patch_changed_request');
  });

  it('keeps the visible first whitebox when the one adjustment call fails', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }))
      .mockRejectedValueOnce(new Error('adjustment_api_unavailable'));
    const result = await generateWorldWhitebox(request);
    expect(result.finalPlan).toEqual(result.initialPlan);
    expect(result.adjustment).toEqual({ decision: 'keep', applied: false, error: 'adjustment_api_unavailable' });
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
  });

  it('preserves a model prompt echo in the raw plan while using the request-owned prompt for loading', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: { ...originalPlan(), prompt: 'shortened echo' } }))
      .mockResolvedValueOnce(JSON.stringify({ decision: 'keep' }));
    const result = await generateWorldWhitebox(request);
    expect((result.originalPlan as {prompt: string}).prompt).toBe('shortened echo');
    expect(result.initialPlan.prompt).toBe(prompt);
    expect(result.observation.technicalNormalizations).toEqual(['request_prompt_echo']);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.request-echo-normalized',
      { received: 'shortened echo', expected: prompt });
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
