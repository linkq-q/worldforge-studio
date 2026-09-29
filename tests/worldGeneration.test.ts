import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Euler, Quaternion } from 'three';
import { createEmptyMap, createMapObject, getObjectWorldTransforms, type MapAsset } from '../src/shared/map';
import { createWorldSampler } from '../src/shared/worldTerrain';
import {
  assembleWorldModel, compileWorldDraft, generateWorld, worldAssetStrategy,
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

describe('world generation compiler', () => {
  beforeEach(() => {
    mocks.llmChat.mockReset();
    mocks.recordGenerationTrace.mockReset();
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

  it('repairs an invalid GPT draft once and returns geometry audits', async () => {
    const draft = validDraft();
    mocks.llmChat
      .mockResolvedValueOnce(JSON.stringify({ ...draft, accidentalTopology: true }))
      .mockResolvedValueOnce(JSON.stringify(draft));

    const result = await generateWorld(request, {} as MapStore);
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
    const repairMessages = mocks.llmChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(JSON.parse(repairMessages.at(-1)!.content).error).toBe('world_unknown_draft_field:accidentalTopology');
    expect(result.bundle.plan.recipe.heightScale).toBe(0.1);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      townId: 'market-town', buildingCount: expect.any(Number), roadSurfaceArea: expect.any(Number),
      builtFootprintArea: expect.any(Number), roadWidthRange: expect.any(Array), maxRoadSlope: expect.any(Number),
      publicBuildings: 0, recommendedPublicBuildings: expect.any(Array),
      planningIssues: expect.arrayContaining(['missing_public_function', 'missing_external_connection'])
    }));
  });

  it('prompts for a settlement-specific economy and civic program before street layout', () => {
    expect(WORLD_GENERATION_PROMPT).toContain('livelihood, population scale, external logistics, public services');
    expect(WORLD_GENERATION_PROMPT).toContain('one public or landmark building per 10..20 ordinary buildings');
    expect(WORLD_GENERATION_PROMPT).toContain('Do not copy one civic checklist into every settlement');
  });

  it('fails after the single repair instead of accepting changed request semantics', async () => {
    const draft = validDraft();
    draft.plan.prompt = 'Silently changed destination';
    mocks.llmChat.mockResolvedValue(JSON.stringify(draft));
    await expect(generateWorld(request, {} as MapStore)).rejects.toThrow('world_prompt_request_mismatch');
    expect(mocks.llmChat).toHaveBeenCalledTimes(2);
  });
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
});
