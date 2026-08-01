import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { lintMap } from '../src/shared/mapLint';
import { validateMapSuggestion } from '../src/server/mapSuggestionValidation';
import { buildModelColliderPlan, MAP_ASSET_COLLIDER_PROFILE } from '../src/shared/modelBounds';

const asset = {
  id: 'asset-tree',
  name: 'Tree',
  prompt: 'tree',
  tags: ['tree', 'vegetation'],
  modelJson: { nodes: [] },
  colliderPlan: buildModelColliderPlan({ nodes: [] }, MAP_ASSET_COLLIDER_PROFILE),
  footprintRadius: 0.5,
  sizeClass: 'small',
  mode: 'voxel',
  createdAt: 1,
  updatedAt: 1
} satisfies MapAsset;

describe('map lint and deterministic repair', () => {
  it('repairs off-ground/out-of-bounds objects and removes exact duplicates', () => {
    const map = createEmptyMap('lint', 'map-lint');
    map.assets = [asset];
    const first = createMapObject('Tree A', asset.id);
    first.id = 'tree-a';
    first.transform.position = [100, 12, 100];
    const duplicate = createMapObject('Tree B', asset.id);
    duplicate.id = 'tree-b';
    duplicate.transform.position = [...first.transform.position];
    map.objects = [first, duplicate];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(lint.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'object.duplicate',
      'object.out-of-bounds',
      'object.off-ground'
    ]));
    expect(repaired.objects).toHaveLength(1);
    expect(repaired.objects[0].transform.position[0]).toBeLessThan(map.box.size[0] / 2);
    expect(repaired.objects[0].transform.position[1]).toBe(0);
  });

  it('re-carves an exposed lake and keeps repairs in the same suggestion transaction', () => {
    const map = createEmptyMap('lake lint', 'map-lake-lint');
    map.waterBodies = [{
      id: 'lake-1', name: 'Lake', type: 'lake', level: 0.2, depth: 1.5, width: 1.2,
      points: [[-4, -4], [4, -4], [4, 4], [-4, 4]]
    }];
    map.terrain.heights.fill(1);

    const validated = validateMapSuggestion(map, {
      summary: 'move sun',
      operations: [{ type: 'sun.set', point: [3, 8, 4] }],
      renderPromptSuggestions: [],
      generatedAssets: []
    });

    expect(validated.repairCount).toBeGreaterThan(0);
    expect(validated.suggestion.operations).toEqual(expect.arrayContaining([
      { type: 'water.update', waterId: 'lake-1', patch: {} }
    ]));
    expect(validated.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'water.exposed-terrain', repaired: true })
    ]));
  });
});
