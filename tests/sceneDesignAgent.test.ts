import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { runSceneDesignAgent } from '../src/server/sceneDesignAgent';

const bench: MapAsset = {
  id: 'bench-a', name: 'Park Bench', prompt: 'bench', tags: ['bench'], modelJson: {},
  colliderPlan: { version: 1, boxes: [{ min: [-0.5, 0, -0.3], max: [0.5, 1, 0.3] }], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
  footprintRadius: 0.5, mode: 'asset', createdAt: 1, updatedAt: 1
};

describe('scene design agent', () => {
  it('observes, writes a program, receives execution evidence, and chooses when to finish', async () => {
    const replies = [
      JSON.stringify({
        action: 'write_program', summary: 'Create a curved public park loop',
        program: `scene.terrain("hills", { amplitude: 2.5, roughness: 0.25 }); scene.water("sea", { type: "ocean", points: [[-16,-16],[-13,-16],[-13,16],[-16,16]], level: 0 }); scene.grass("lawn", { kind: "circle", x: 5, z: 0, radius: 10 }, { preset: "meadow", density: 0.6 }); const loop = scene.guide("park-loop", { points: [[-5,0],[0,9],[8,9],[14,0],[7,-8]], curve: "catmull-rom", closed: true, width: 2 }); scene.surface(loop, "sand"); scene.placeAlong("bench", loop, { spacing: 5, offset: 1.8 });`
      }),
      JSON.stringify({ action: 'finish', summary: 'Curved park loop and path-side seating are ready for preview' })
    ];
    const messagesSeen: string[] = [];
    const suggestion = await runSceneDesignAgent('Create a seaside park', createEmptyMap('park', 'agent-park'), [bench], {
      maxNewAssets: 0,
      reuseExistingAssets: true,
      reusableAssetIds: [bench.id],
      createAsset: async () => { throw new Error('not expected'); },
      chat: async (messages) => {
        messagesSeen.push(String(messages.at(-1)?.content));
        return replies.shift()!;
      }
    });

    expect(suggestion.agent?.iterations).toBe(2);
    expect(suggestion.agent?.trace.map((item) => item.action)).toEqual(['write_program', 'finish']);
    expect(suggestion.operations.some((operation) => operation.type === 'guide.upsert')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    expect(messagesSeen[1]).toContain('"ok":true');
  });

  it('can request a missing reusable asset before programming the layout', async () => {
    const replies = [
      JSON.stringify({ action: 'request_assets', summary: 'Need a crop asset', assets: [{ name: 'Corn', prompt: 'low-poly corn plant', tags: ['crop'] }] }),
      JSON.stringify({ action: 'write_program', summary: 'Lay out crop rows', program: `const rows = scene.parallelGuides("field", [[-8,-6],[8,-6],[8,6],[-8,6]], { direction: 0, spacing: 3 }); for (const row of rows) { scene.surface(row, "grass", 0.5); scene.placeAlong("crop", row, { spacing: 2 }); }` }),
      JSON.stringify({ action: 'finish', summary: 'Farm rows are ready' })
    ];
    const suggestion = await runSceneDesignAgent('Create a small farm', createEmptyMap('farm', 'agent-farm'), [], {
      minNewAssets: 1,
      maxNewAssets: 1,
      createAsset: async (request) => ({ ...bench, id: 'crop-a', name: request.name, prompt: request.prompt, tags: request.tags }),
      chat: async () => replies.shift()!
    });

    expect(suggestion.generatedAssets).toEqual([{ id: 'crop-a', name: 'Corn' }]);
    expect(suggestion.agent?.trace.map((item) => item.action)).toEqual(['request_assets', 'write_program', 'finish']);
    expect(suggestion.agent?.guideCount).toBeGreaterThan(2);
  });

  it('asks the model to repair invalid action JSON instead of aborting the run', async () => {
    const replies = [
      'not valid json',
      JSON.stringify({
        action: 'write_program', summary: 'Place a landmark',
        program: 'scene.placeAt("bench", [0,0], { searchRadius: 2 });'
      }),
      JSON.stringify({ action: 'finish', summary: 'Landmark is ready' })
    ];
    const suggestion = await runSceneDesignAgent('Create one landmark', createEmptyMap('landmark', 'agent-landmark'), [bench], {
      maxNewAssets: 0,
      reuseExistingAssets: true,
      reusableAssetIds: [bench.id],
      createAsset: async () => { throw new Error('not expected'); },
      chat: async () => replies.shift()!
    });

    expect(suggestion.agent?.trace.map((item) => item.action)).toEqual(['invalid_response', 'write_program', 'finish']);
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
  });

  it('refuses to finish while a generated asset is unused, then accepts a repaired program', async () => {
    const replies = [
      JSON.stringify({ action: 'request_assets', summary: 'Need crop', assets: [{ name: 'Corn', prompt: 'low-poly corn', tags: ['crop'] }] }),
      JSON.stringify({
        action: 'write_program', summary: 'Draft empty field',
        program: 'const row = scene.guide("field", { points: [[-8,0],[8,0]], width: 1 }); scene.surface(row, "grass");'
      }),
      JSON.stringify({ action: 'finish', summary: 'Draft done' }),
      JSON.stringify({
        action: 'write_program', summary: 'Populate the field',
        program: 'const rows = scene.parallelGuides("field", [[-8,-6],[8,-6],[8,6],[-8,6]], { direction: 0, spacing: 3 }); for (const row of rows) { scene.surface(row, "grass"); scene.placeAlong("crop", row, { spacing: 2 }); }'
      }),
      JSON.stringify({ action: 'finish', summary: 'Field is populated' })
    ];
    const toolMessages: string[] = [];
    const suggestion = await runSceneDesignAgent('Create a farm field', createEmptyMap('farm repair', 'agent-farm-repair'), [], {
      minNewAssets: 1,
      maxNewAssets: 1,
      createAsset: async (request) => ({ ...bench, id: 'crop-a', name: request.name, prompt: request.prompt, tags: request.tags }),
      chat: async (messages) => {
        toolMessages.push(String(messages.at(-1)?.content));
        return replies.shift()!;
      }
    });

    expect(toolMessages.some((message) => message.includes('generated-assets-unplaced:crop-a'))).toBe(true);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add').length).toBeGreaterThan(3);
  });

  it('does not expose global assets unless reuse was explicitly allowed', async () => {
    const replies = [
      JSON.stringify({ action: 'request_assets', summary: 'Need a new marker', assets: [{ name: 'Marker', prompt: 'low-poly landmark marker', tags: ['marker'] }] }),
      JSON.stringify({ action: 'write_program', summary: 'Place marker', program: 'scene.placeAt("marker", [0,0], { searchRadius: 2 });' }),
      JSON.stringify({ action: 'finish', summary: 'Marker is ready' })
    ];
    let initialUserPrompt = '';
    const suggestion = await runSceneDesignAgent('Create one landmark marker', createEmptyMap('permission', 'agent-permission'), [bench], {
      minNewAssets: 1,
      maxNewAssets: 1,
      createAsset: async (request) => ({ ...bench, id: 'marker-a', name: request.name, prompt: request.prompt, tags: request.tags }),
      chat: async (messages) => {
        if (!initialUserPrompt) initialUserPrompt = String(messages[1]?.content);
        return replies.shift()!;
      }
    });

    expect(initialUserPrompt).not.toContain('bench-a');
    expect(suggestion.operations).toContainEqual(expect.objectContaining({
      type: 'object.add', object: expect.objectContaining({ assetId: 'marker-a' })
    }));
  });

  it('rejects a flat ocean scene that leaves no playable land', async () => {
    const flatProgram = 'scene.water("sea", { type: "ocean", points: [[-16,-16],[-12,-16],[-12,16],[-16,16]], level: 0 }); scene.grass("lawn", { kind: "circle", x: 0, z: 0, radius: 10 }, { preset: "meadow" }); const path = scene.guide("coast", { points: [[-8,-8],[8,-8],[8,8],[-8,8]], closed: true, width: 2 }); scene.surface(path, "sand"); scene.placeAlong("bench", path, { spacing: 5 });';
    const repairedProgram = `scene.terrain("hills", { amplitude: 3 }); ${flatProgram}`;
    const replies = [
      JSON.stringify({ action: 'write_program', summary: 'Draft flat coast', program: flatProgram }),
      JSON.stringify({ action: 'finish', summary: 'Draft coast' }),
      JSON.stringify({ action: 'write_program', summary: 'Raise playable land', program: repairedProgram }),
      JSON.stringify({ action: 'finish', summary: 'Playable coast' })
    ];
    const toolMessages: string[] = [];
    await runSceneDesignAgent('Create a seaside park', createEmptyMap('coast repair', 'agent-coast-repair'), [bench], {
      maxNewAssets: 0,
      reuseExistingAssets: true,
      reusableAssetIds: [bench.id],
      createAsset: async () => { throw new Error('not expected'); },
      chat: async (messages) => {
        toolMessages.push(String(messages.at(-1)?.content));
        return replies.shift()!;
      }
    });

    expect(toolMessages.some((message) => message.includes('ocean-scene-needs-playable-land'))).toBe(true);
  });
});
