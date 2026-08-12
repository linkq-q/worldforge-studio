import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, getMapObjectAabbs, type MapAsset } from '../src/shared/map';
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

  it('scales tall visible furniture below the ceiling and keeps its visible bottom grounded', () => {
    const roomAsset = {
      ...asset,
      id: 'asset-chair',
      name: 'Chair',
      tags: ['chair', 'furniture'],
      modelJson: {
        nodes: [{ id: 'chair', transform: { pos: [0, 2.5, 0] }, mesh: { type: 'box', params: { width: 0.8, height: 5, depth: 0.8 } } }]
      },
      colliderPlan: {
        version: 1 as const,
        boxes: [{ min: [-0.4, -0.5, -0.4] as [number, number, number], max: [0.4, 4.5, 0.4] as [number, number, number] }],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      }
    } satisfies MapAsset;
    const map = createEmptyMap('room', 'lint-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [roomAsset];
    const chair = createMapObject('Chair', roomAsset.id);
    chair.id = 'chair-a';
    chair.heightMode = 'fixed';
    chair.transform.position = [0, 0, 0];
    map.objects = [chair];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);
    const repairedChair = repaired.objects[0];
    const bottom = repairedChair.transform.position[1];
    const top = repairedChair.transform.position[1] + 5 * repairedChair.transform.scale[1];

    expect(bottom).toBeCloseTo(0, 4);
    expect(top).toBeLessThanOrEqual(3);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.above-ceiling', repaired: true })
    ]));
  });

  it('grounds indoor furniture by its visible feet instead of its simplified collider', () => {
    const chairModel = {
      nodes: [
        { id: 'seat', transform: { pos: [0, 1, 0] }, mesh: { type: 'box', params: { width: 1, height: 0.4, depth: 1 } } },
        { id: 'leg', transform: { pos: [0, 0.4, 0] }, mesh: { type: 'box', params: { width: 0.05, height: 0.8, depth: 0.05 } } }
      ]
    };
    const chairAsset = {
      ...asset,
      id: 'asset-visual-chair',
      name: 'Wooden chair',
      tags: ['chair', 'furniture'],
      modelJson: chairModel,
      colliderPlan: buildModelColliderPlan(chairModel, MAP_ASSET_COLLIDER_PROFILE)
    } satisfies MapAsset;
    const map = createEmptyMap('room', 'visual-ground-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [chairAsset];
    const chair = createMapObject('Chair', chairAsset.id);
    chair.id = 'visual-chair';
    chair.transform.position = [0, -0.8, 0];
    map.objects = [chair];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects[0].transform.position[1]).toBeCloseTo(0, 5);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.off-ground', repaired: true })
    ]));
  });

  it('tags and snaps hyphenated ceiling lights to the ceiling underside', () => {
    const lightModel = {
      nodes: [{ id: 'light', transform: { pos: [0, 0.2, 0] }, mesh: { type: 'box', params: { width: 1, height: 0.4, depth: 0.4 } } }]
    };
    const lightAsset = {
      ...asset,
      id: 'ceiling-light',
      name: 'Grid light',
      prompt: 'rectangular grid light',
      tags: ['indoor', 'ceiling-light'],
      modelJson: lightModel,
      colliderPlan: buildModelColliderPlan(lightModel)
    } satisfies MapAsset;
    const map = createEmptyMap('room', 'ceiling-light-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [lightAsset];
    const light = createMapObject('Grid light', lightAsset.id);
    light.id = 'grid-light';
    light.transform.position = [0, 0, 0];
    map.objects = [light];

    const repaired = applyMapOperations(map, lintMap(map).repairOperations);
    const bounds = getMapObjectAabbs(repaired).find((item) => item.objectId === light.id)!;

    expect(bounds.max[1]).toBeCloseTo(map.room!.size[1] - map.room!.wallThickness, 5);
  });

  it('normalizes recognizable indoor furniture to character-relative semantic heights', () => {
    const tallChairModel = {
      nodes: [{ id: 'chair', transform: { pos: [0, 1.5, 0] }, mesh: { type: 'box', params: { width: 1, height: 3, depth: 1 } } }]
    };
    const shortLecternModel = {
      nodes: [{ id: 'lectern', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }]
    };
    const chairAsset = { ...asset, id: 'chair', name: 'Chair', tags: ['chair'], modelJson: tallChairModel, colliderPlan: buildModelColliderPlan(tallChairModel) } satisfies MapAsset;
    const lecternAsset = { ...asset, id: 'lectern', name: 'Lectern', prompt: 'standing lectern that does not include a wall', tags: ['lectern'], modelJson: shortLecternModel, colliderPlan: buildModelColliderPlan(shortLecternModel) } satisfies MapAsset;
    const map = createEmptyMap('room', 'relative-scale-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.playerHeight = 1.6;
    map.assets = [chairAsset, lecternAsset];
    const chair = createMapObject('Chair', chairAsset.id);
    chair.id = 'chair';
    const lectern = createMapObject('Lectern', lecternAsset.id);
    lectern.id = 'lectern';
    map.objects = [chair, lectern];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);
    const repairedChair = repaired.objects.find((object) => object.id === 'chair')!;
    const repairedLectern = repaired.objects.find((object) => object.id === 'lectern')!;

    expect(3 * repairedChair.transform.scale[1]).toBeCloseTo(1.6 * 0.64 * 1.2, 2);
    expect(repairedLectern.transform.scale[1]).toBeCloseTo(1.6 * 0.88 * 1.2, 2);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.scale-mismatch', repaired: true })
    ]));
  });

  it('widens implausibly thin cartoon storage without pushing its top through the ceiling', () => {
    const narrowBookcaseModel = {
      nodes: [{ id: 'bookcase', transform: { pos: [0, 0.9, 0] }, mesh: { type: 'box', params: { width: 0.3, height: 1.8, depth: 0.3 } } }]
    };
    const bookcaseAsset = {
      ...asset,
      id: 'bookcase',
      name: 'Classroom bookcase',
      tags: ['bookcase', 'furniture'],
      modelJson: narrowBookcaseModel,
      colliderPlan: buildModelColliderPlan(narrowBookcaseModel)
    } satisfies MapAsset;
    const map = createEmptyMap('room', 'stocky-bookcase-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [bookcaseAsset];
    const bookcase = createMapObject('Bookcase', bookcaseAsset.id);
    bookcase.id = 'bookcase';
    map.objects = [bookcase];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);
    const object = repaired.objects[0];

    expect(0.3 * object.transform.scale[0]).toBeGreaterThan(0.9);
    expect(1.8 * object.transform.scale[1]).toBeLessThanOrEqual(2.98);
    expect(object.transform.scale[0]).toBeGreaterThan(object.transform.scale[1]);
  });

  it('keeps a wide rotated wall menu board in contact with its wall', () => {
    const menuAsset = {
      ...asset,
      id: 'wall-menu',
      name: 'Wall-mounted menu board',
      tags: ['menu-board', 'wall-mounted'],
      footprintRadius: 2.69,
      modelJson: {
        nodes: [{ id: 'menu', transform: { pos: [0, 1.2, 0] }, mesh: { type: 'box', params: { width: 5.2, height: 2.4, depth: 0.2 } } }]
      },
      colliderPlan: {
        version: 1 as const,
        boxes: [{
          min: [-2.6, 0, -0.1] as [number, number, number],
          max: [2.6, 2.4, 0.1] as [number, number, number]
        }],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      }
    } satisfies MapAsset;
    const map = createEmptyMap('restaurant', 'wall-menu-room', [20, 5, 15], 'voxel', 'indoor', [20, 5, 15]);
    map.assets = [menuAsset];
    const menu = createMapObject('Menu', menuAsset.id);
    menu.id = 'wall-menu-object';
    menu.heightMode = 'fixed';
    menu.transform.position = [9.74, 1.3, 0];
    menu.transform.rotation = [0, -Math.PI / 2, 0];
    map.objects = [menu];

    const lint = lintMap(map);
    const repaired = lint.repairOperations.length > 0 ? applyMapOperations(map, lint.repairOperations) : map;
    const bounds = getMapObjectAabbs(repaired)[0];

    expect(bounds.max[0]).toBeGreaterThan(9.7);
  });

  it('repairs a generated tree that is tiny relative to the configured character', () => {
    const map = createEmptyMap('tree scale', 'tree-scale');
    map.assets = [asset];
    const tree = createMapObject('Tree', asset.id);
    tree.id = 'tiny-tree';
    tree.transform.scale = [0.1, 0.1, 0.1];
    map.objects = [tree];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects[0].transform.scale[0]).toBeGreaterThan(3.4);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.too-small', repaired: true })
    ]));
  });
});
