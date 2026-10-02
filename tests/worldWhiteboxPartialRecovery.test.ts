import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), recordGenerationTrace: vi.fn() }));

vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(),
  llmChat: mocks.llmChat
}));
vi.mock('../src/server/generationTrace', () => ({ recordGenerationTrace: mocks.recordGenerationTrace }));

import { ChatPartialResponseError } from '../src/server/modelApi';
import { continueStagedWorldWhitebox } from '../src/server/worldWhiteboxGeneration';

const request = {
  mode: 'whitebox', prompt: 'A playable atoll with a quiet central lagoon.', seed: 41, size: 500,
  generateAssets: false, repairAttempts: 0
};

const terrainContent = JSON.stringify({ terrain: {
  version: 1, seed: 41, size: 500, reliefProfile: 'compact', heightScale: 0.03,
  constraints: [
    { region: 'center', biome: 'grassland' },
    { region: 'north', biome: 'ocean' },
    { region: 'east', biome: 'ocean' },
    { region: 'south', biome: 'ocean' },
    { region: 'west', biome: 'ocean' }
  ],
  landforms: [{ center: [0, 0], radius: [135, 135], height: 6 }]
} });

function spatialResponse(): string {
  return JSON.stringify({ plan: {
    id: 'atoll-world', terrainRefinements: [], waterBodies: [], ecology: [],
    concept: { premise: 'A compact inhabited atoll.', themes: ['isolation'], experience: 'Cross the ring and rest by the lagoon.' },
    featureGraph: {
      regions: [{ id: 'lagoon-ring', kind: 'atoll', name: 'Lagoon ring', center: [0, 0], radius: 120 }],
      paths: [], anchors: [], relations: []
    },
    settlementPlan: { settlements: [] }, mobilityPlan: { routes: [] },
    explorationPlan: { pointsOfInterest: [], sequence: [] },
    intentionalEmptyAreas: [{ id: 'quiet-lagoon', regionId: 'lagoon-ring', purpose: 'Keep the lagoon quiet.' }]
  } });
}

describe('staged world partial transport recovery', () => {
  beforeEach(() => {
    mocks.llmChat.mockReset();
    mocks.recordGenerationTrace.mockReset();
  });

  it('accepts a terminated atoll response only when missing outer closers recover into a valid Stage2 plan', async () => {
    const complete = spatialResponse();
    const partial = complete.slice(0, -2);
    expect(partial.endsWith(']')).toBe(true);
    mocks.llmChat.mockRejectedValueOnce(new ChatPartialResponseError('terminated', partial));

    const result = await continueStagedWorldWhitebox(request, terrainContent);

    expect(result.finalPlan.id).toBe('atoll-world');
    expect(result.planningDiagnostics.spatial).toContain('transport_partial_recovered');
    expect(result.observation.technicalNormalizations).toContain('transport_partial_recovered');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.spatial-raw', {
      content: partial, partial: true, transportError: 'terminated'
    });
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.spatial-partial-recovered', {
      transportError: 'terminated'
    });
  });

  it.each([
    ['an unfinished string', '{"plan":{"intentionalEmptyAreas":[{"purpose":"unfinished'],
    ['missing semantic fields', JSON.stringify({ plan: {
      id: 'atoll-world', terrainRefinements: [], waterBodies: [], ecology: [],
      concept: { premise: 'Atoll', themes: [], experience: 'Explore' },
      featureGraph: { regions: [], paths: [], anchors: [], relations: [] },
      settlementPlan: { settlements: [] }, mobilityPlan: { routes: [] }, intentionalEmptyAreas: []
    } })]
  ])('rejects %s without another GPT call', async (_label, partial) => {
    const transportError = new ChatPartialResponseError('terminated', partial);
    mocks.llmChat.mockRejectedValueOnce(transportError);

    await expect(continueStagedWorldWhitebox(request, terrainContent)).rejects.toBe(transportError);

    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.spatial-partial-rejected', {
      transportError: 'terminated', error: expect.any(String)
    });
  });
});
