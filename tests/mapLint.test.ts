import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, getMapObjectAabbs, getMapObjectVisualAabbs, type MapAsset } from '../src/shared/map';
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

  it('snaps a locked boat bottom to the containing water surface', () => {
    const boatModel = {
      nodes: [{ id: 'hull', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 1, depth: 5 } } }]
    };
    const boatAsset = {
      ...asset,
      id: 'asset-boat',
      name: '乌篷船',
      prompt: 'traditional wooden boat',
      tags: ['boat', '船'],
      modelJson: boatModel,
      colliderPlan: buildModelColliderPlan(boatModel)
    } satisfies MapAsset;
    const map = createEmptyMap('boat lint', 'boat-lint', [64, 12, 64]);
    map.waterBodies = [{
      id: 'river', name: 'River', type: 'river', level: 0.2, depth: 1.5, width: 12,
      points: [[0, -20], [0, 20]]
    }];
    map.assets = [boatAsset];
    const boat = createMapObject('乌篷船', boatAsset.id);
    boat.id = 'boat';
    boat.locked = true;
    boat.heightMode = 'fixed';
    boat.transform.position = [0, -0.2, 0];
    map.objects = [boat];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects[0].transform.position[1]).toBeCloseTo(0.2);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.waterline', repaired: true })
    ]));
  });

  it('does not float an ordinary locked object that happens to be in water', () => {
    const map = createEmptyMap('water object lint', 'water-object-lint', [64, 12, 64]);
    map.waterBodies = [{
      id: 'river', name: 'River', type: 'river', level: 0.2, depth: 1.5, width: 12,
      points: [[0, -20], [0, 20]]
    }];
    map.assets = [asset];
    const tree = createMapObject('Tree', asset.id);
    tree.id = 'tree';
    tree.locked = true;
    tree.heightMode = 'fixed';
    tree.transform.position = [0, -0.2, 0];
    map.objects = [tree];

    const lint = lintMap(map);

    expect(lint.repairOperations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.update', objectId: tree.id })
    ]));
  });

  it('reports overlapping saved outdoor buildings without moving locked user content', () => {
    const map = createEmptyMap('saved town', 'saved-overlap-town', [64, 12, 64]);
    const first = createMapObject('民居 A', null);
    first.id = 'saved-house-a';
    first.locked = true;
    first.transform.size = [8, 5, 8];
    const second = createMapObject('民居 B', null);
    second.id = 'saved-house-b';
    second.locked = true;
    second.transform.position = [2, 0, 1];
    second.transform.size = [8, 5, 8];
    map.objects = [first, second];

    const lint = lintMap(map);

    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap', repaired: false })
    ]));
    expect(lint.repairOperations.some((operation) => (
      operation.type === 'object.update' && ['saved-house-a', 'saved-house-b'].includes(operation.objectId)
    ))).toBe(false);
  });

  it('aligns a current-preview town building to the nearest settlement street', () => {
    const map = createEmptyMap('street town', 'street-town', [64, 12, 64]);
    map.guides = [{
      id: 'main-street', name: '主街', points: [[-24, 0], [24, 0]], curve: 'polyline',
      closed: false, width: 4, tags: ['street', 'settlement']
    }];
    const house = createMapObject('民居', null);
    house.id = 'preview-house';
    house.locked = true;
    house.transform.position = [0, 0, 7];
    house.transform.rotation = [0, Math.PI / 4, 0];
    house.transform.size = [8, 5, 6];
    map.objects = [house];

    const lint = lintMap(map, { repairableObjectIds: new Set([house.id]) });
    const repaired = applyMapOperations(map, lint.repairOperations).objects[0];

    expect(repaired.sourceGuideId).toBe('main-street');
    expect(repaired.transform.position[2]).toBeGreaterThan(4);
    expect(repaired.transform.position[2]).toBeLessThan(6.5);
    expect(Math.abs(Math.abs(repaired.transform.rotation[1]) - Math.PI)).toBeLessThan(0.001);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'settlement.building-aligned', repaired: true })
    ]));
  });

  it('binds a loose public bench to the nearest street edge without treating every chair as roadside furniture', () => {
    const map = createEmptyMap('bench town', 'bench-town', [64, 12, 64]);
    map.guides = [{
      id: 'main-street', name: '主街', points: [[-24, 0], [24, 0]], curve: 'polyline',
      closed: false, width: 4, tags: ['street', 'settlement']
    }];
    const bench = createMapObject('公共长椅', null);
    bench.id = 'preview-bench';
    bench.transform.position = [5, 0, 9];
    const cafeChair = createMapObject('咖啡店椅子', null);
    cafeChair.id = 'cafe-chair';
    cafeChair.transform.position = [10, 0, 9];
    map.objects = [bench, cafeChair];

    const lint = lintMap(map, { repairableObjectIds: new Set([bench.id, cafeChair.id]) });
    const repaired = applyMapOperations(map, lint.repairOperations);
    const repairedBench = repaired.objects.find((object) => object.id === bench.id)!;
    const repairedChair = repaired.objects.find((object) => object.id === cafeChair.id)!;

    expect(repairedBench.sourceGuideId).toBe('main-street');
    expect(repairedBench.transform.position[2]).toBeCloseTo(3, 1);
    expect(repairedChair.sourceGuideId).toBeUndefined();
    expect(repairedChair.transform.position).toEqual(cafeChair.transform.position);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'roadside.route-bound', repaired: true, objectIds: [bench.id] })
    ]));
  });

  it('repairs even shallow outdoor building intersections', () => {
    const map = createEmptyMap('tight town', 'tight-town', [64, 12, 64]);
    const first = createMapObject('民居 A', null);
    first.id = 'house-a';
    first.locked = true;
    first.transform.size = [8, 5, 8];
    const second = createMapObject('民居 B', null);
    second.id = 'house-b';
    second.locked = true;
    second.transform.position = [7, 0, 0];
    second.transform.size = [8, 5, 8];
    map.objects = [first, second];

    const lint = lintMap(map, { repairableObjectIds: new Set([first.id, second.id]) });

    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap', repaired: true })
    ]));
  });

  it('keeps overlapping street-bound buildings on their street while separating them', () => {
    const map = createEmptyMap('frontage repair', 'frontage-repair', [64, 12, 64]);
    map.guides = [{
      id: 'main-street', name: '主街', points: [[-24, 0], [24, 0]], curve: 'polyline',
      closed: false, width: 4, tags: ['street', 'settlement']
    }];
    const first = createMapObject('民居 A', null);
    first.id = 'frontage-a';
    first.locked = true;
    first.sourceGuideId = 'main-street';
    first.transform.position = [0, 0, 5.8];
    first.transform.rotation = [0, Math.PI, 0];
    first.transform.size = [8, 5, 6];
    const second = createMapObject('民居 B', null);
    second.id = 'frontage-b';
    second.locked = true;
    second.sourceGuideId = 'main-street';
    second.transform.position = [2, 0, 5.8];
    second.transform.rotation = [0, Math.PI, 0];
    second.transform.size = [8, 5, 6];
    map.objects = [first, second];

    const lint = lintMap(map, { repairableObjectIds: new Set([first.id, second.id]) });
    const repaired = applyMapOperations(map, lint.repairOperations);
    const boxes = getMapObjectVisualAabbs(repaired);

    expect(repaired.objects.every((object) => object.sourceGuideId === 'main-street')).toBe(true);
    expect(repaired.objects.every((object) => Math.abs(object.transform.position[2] - 5.8) < 0.001)).toBe(true);
    expect(boxes[0].max[0] <= boxes[1].min[0] || boxes[1].max[0] <= boxes[0].min[0]).toBe(true);
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

  it('mounts named wall art on a wall instead of leaving it on the floor', () => {
    const wallArtModel = {
      nodes: [{ id: 'art', transform: { pos: [0, 0.6, 0] }, mesh: { type: 'box', params: { width: 2, height: 1.2, depth: 0.2 } } }]
    };
    const wallArtAsset = {
      ...asset,
      id: 'wall-art',
      name: '墙面装饰画',
      prompt: 'framed wall art',
      tags: ['wall-art', 'framed-art', 'decor'],
      modelJson: wallArtModel,
      colliderPlan: buildModelColliderPlan(wallArtModel)
    } satisfies MapAsset;
    const map = createEmptyMap('living room', 'wall-art-room', [15, 5, 8], 'voxel', 'indoor', [15, 5, 8]);
    map.assets = [wallArtAsset];
    const art = createMapObject('墙面装饰画', wallArtAsset.id);
    art.id = 'wall-art-object';
    art.heightMode = 'fixed';
    art.transform.position = [-map.room!.size[0] / 2 + map.room!.wallThickness + 1, 0, 0];
    map.objects = [art];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);
    const bounds = getMapObjectAabbs(repaired)[0];
    const room = map.room!;
    const wallDistance = Math.min(
      Math.abs(bounds.min[0] - (-room.size[0] / 2 + room.wallThickness)),
      Math.abs(bounds.max[0] - (room.size[0] / 2 - room.wallThickness)),
      Math.abs(bounds.min[2] - (-room.size[2] / 2 + room.wallThickness)),
      Math.abs(bounds.max[2] - (room.size[2] / 2 - room.wallThickness))
    );

    expect(wallDistance).toBeLessThan(0.05);
    expect(bounds.min[1]).toBeGreaterThan(0.5);
  });

  it('moves a movable fixture away from the spawn route instead of only reporting a blocked path', () => {
    const fridgeModel = {
      nodes: [{ id: 'fridge', transform: { pos: [0, 1, 0] }, mesh: { type: 'box', params: { width: 1.4, height: 2, depth: 1.2 } } }]
    };
    const fridgeAsset = {
      ...asset,
      id: 'fridge',
      name: '冰箱',
      prompt: 'compact refrigerator',
      tags: ['kitchen', 'refrigerator', 'appliance'],
      modelJson: fridgeModel,
      colliderPlan: buildModelColliderPlan(fridgeModel)
    } satisfies MapAsset;
    const map = createEmptyMap('kitchen', 'kitchen-route', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.room!.openings = [{ id: 'door-main', kind: 'door', wall: 'north', offset: -3.2, bottom: 0, width: 1.2, height: 2.1 }];
    map.assets = [fridgeAsset];
    map.spawnPoints = [[0, 0, 0]];
    const fridge = createMapObject('冰箱', fridgeAsset.id);
    fridge.id = 'fridge-object';
    fridge.transform.position = [0, 0, 0];
    map.objects = [fridge];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects[0].transform.position).not.toEqual([0, 0, 0]);
    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'room.path-blocked', repaired: true })
    ]));
    expect(lintMap(repaired).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'room.path-blocked' })
    ]));
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

  it('reports insufficient night lighting coverage for an unlit indoor room', () => {
    const map = createEmptyMap('unlit room', 'unlit-room', [12, 3, 9], 'voxel', 'indoor', [12, 3, 9]);

    expect(lintMap(map).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'interior.light-coverage', repaired: false })
    ]));
  });

  it('repairs surface palettes that drift far outside the global indoor palette', () => {
    const map = applyMapOperations(
      createEmptyMap('styled room', 'styled-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [{ type: 'interior.art-direction.set', artDirection: {
        summary: 'warm red room', palette: ['#7f3028', '#ead2b5'],
        surfaces: { floor: { recipe: 'wood.plank', palette: ['#0000ff', '#1010ee'] } } as never
      } }]
    );

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'interior.style-drift', repaired: true })
    ]));
    expect(repaired.interiorArtDirection?.surfaces.floor.palette).toEqual(repaired.interiorArtDirection?.palette);
  });

  it('shrinks oversized rugs and room signs to semantic room scale', () => {
    const rugModel = { nodes: [{ id: 'rug', transform: { pos: [0, 0.07, 0] }, mesh: { type: 'box', params: { width: 2.4, height: 0.14, depth: 1.6 } } }] };
    const signModel = { nodes: [{ id: 'sign', transform: { pos: [0, 0.17, 0] }, mesh: { type: 'box', params: { width: 0.72, height: 0.34, depth: 0.08 } } }] };
    const rugAsset = { ...asset, id: 'rug', name: 'Reading rug', tags: ['rug', 'floor-textile'], sizeClass: 'medium', modelJson: rugModel, colliderPlan: buildModelColliderPlan(rugModel) } satisfies MapAsset;
    const signAsset = { ...asset, id: 'sign', name: 'Dorm room sign', tags: ['room-number', 'wall'], sizeClass: 'small', modelJson: signModel, colliderPlan: buildModelColliderPlan(signModel) } satisfies MapAsset;
    const map = createEmptyMap('room', 'oversize-room', [15, 5, 8], 'voxel', 'indoor', [15, 5, 8]);
    map.assets = [rugAsset, signAsset];
    const rug = createMapObject('Reading rug', rugAsset.id);
    rug.id = 'rug'; rug.transform.scale = [10, 10, 10];
    const sign = createMapObject('Dorm room sign', signAsset.id);
    sign.id = 'sign'; sign.transform.position = [0, 0, -3.8]; sign.transform.scale = [20, 3, 20];
    map.objects = [rug, sign];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);
    const rugBounds = getMapObjectAabbs(repaired).filter((item) => item.objectId === 'rug');
    const signBounds = getMapObjectAabbs(repaired).filter((item) => item.objectId === 'sign');
    const extent = (boxes: typeof rugBounds, axis: 0 | 1 | 2) => Math.max(...boxes.map((box) => box.max[axis])) - Math.min(...boxes.map((box) => box.min[axis]));

    expect(extent(rugBounds, 0)).toBeLessThanOrEqual(map.room!.size[0] * 0.72 + 0.01);
    expect(extent(rugBounds, 1)).toBeLessThanOrEqual(map.playerHeight * 0.09 + 0.01);
    expect(extent(signBounds, 0)).toBeLessThanOrEqual(map.playerHeight * 0.9 + 0.01);
    expect(lint.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'object.scale-mismatch', repaired: true })]));
  });

  it('removes a second mattress-sized bed assembly supported on a complete bed', () => {
    const bedModel = { nodes: [{ id: 'bed', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 1, depth: 3 } } }] };
    const linenModel = { nodes: [{ id: 'linen', transform: { pos: [0, 0.3, 0] }, mesh: { type: 'box', params: { width: 1.9, height: 0.6, depth: 2.8 } } }] };
    const bedAsset = { ...asset, id: 'bed', name: 'Platform bed', tags: ['bed'], sizeClass: 'large', modelJson: bedModel, colliderPlan: buildModelColliderPlan(bedModel) } satisfies MapAsset;
    const linenAsset = { ...asset, id: 'linen', name: 'Bed linen set', tags: ['bedding', 'bed'], sizeClass: 'medium', modelJson: linenModel, colliderPlan: buildModelColliderPlan(linenModel) } satisfies MapAsset;
    const map = createEmptyMap('bedroom', 'bed-support-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [bedAsset, linenAsset];
    const bed = createMapObject('Bed', bedAsset.id); bed.id = 'bed';
    const linen = createMapObject('Bed linen set', linenAsset.id); linen.id = 'linen'; linen.parentId = bed.id;
    map.objects = [bed, linen];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects.map((object) => object.id)).toEqual(['bed']);
    expect(lint.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'object.invalid-support', repaired: true })]));
  });

  it('moves furniture out of an openable cabinet front clearance', () => {
    const cabinetModel = { nodes: [{ id: 'cabinet', transform: { pos: [0, 1, 0] }, mesh: { type: 'box', params: { width: 1.6, height: 2, depth: 0.6 } } }] };
    const chairModel = { nodes: [{ id: 'chair', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 0.8, height: 1, depth: 0.8 } } }] };
    const cabinetAsset = { ...asset, id: 'cabinet', name: 'Wardrobe', tags: ['wardrobe', 'openable-front'], sizeClass: 'large', modelJson: cabinetModel, colliderPlan: buildModelColliderPlan(cabinetModel) } satisfies MapAsset;
    const chairAsset = { ...asset, id: 'chair-clearance', name: 'Chair', tags: ['chair'], sizeClass: 'medium', modelJson: chairModel, colliderPlan: buildModelColliderPlan(chairModel) } satisfies MapAsset;
    const map = createEmptyMap('bedroom', 'cabinet-clearance-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [cabinetAsset, chairAsset];
    const cabinet = createMapObject('Wardrobe', cabinetAsset.id); cabinet.id = 'cabinet'; cabinet.transform.position = [0, 0, -3.5];
    const chair = createMapObject('Chair', chairAsset.id); chair.id = 'chair'; chair.transform.position = [0, 0, -2.35];
    map.objects = [cabinet, chair];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(repaired.objects.find((object) => object.id === 'chair')?.transform.position).not.toEqual(chair.transform.position);
    expect(lint.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'interior.operational-clearance', repaired: true })]));
  });

  it('moves overlapping indoor floor furniture to a free room-edge position', () => {
    const chairModel = {
      nodes: [{ id: 'chair', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }]
    };
    const chairAsset = {
      ...asset,
      id: 'overlap-chair',
      name: 'Dining chair',
      tags: ['chair', 'furniture'],
      modelJson: chairModel,
      colliderPlan: buildModelColliderPlan(chairModel)
    } satisfies MapAsset;
    const map = createEmptyMap('dining room', 'overlap-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [chairAsset];
    const first = createMapObject('Chair A', chairAsset.id);
    first.id = 'chair-a';
    first.transform.position = [0, 0, 0];
    const second = createMapObject('Chair B', chairAsset.id);
    second.id = 'chair-b';
    second.transform.position = [0.45, 0, 0];
    map.objects = [first, second];

    const lint = lintMap(map);
    const repaired = applyMapOperations(map, lint.repairOperations);

    expect(lint.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap', repaired: true })
    ]));
    expect(repaired.objects.find((object) => object.id === 'chair-b')?.transform.position).not.toEqual(second.transform.position);
    expect(lintMap(repaired).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap' })
    ]));
  });

  it('keeps intentional rug-under-furniture overlap', () => {
    const rugModel = {
      nodes: [{ id: 'rug', transform: { pos: [0, 0.03, 0] }, mesh: { type: 'box', params: { width: 3, height: 0.06, depth: 2 } } }]
    };
    const tableModel = {
      nodes: [{ id: 'table', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 1.4, height: 1, depth: 1 } } }]
    };
    const rugAsset = { ...asset, id: 'floor-rug', name: 'Area rug', tags: ['rug', 'floor-textile'], modelJson: rugModel, colliderPlan: buildModelColliderPlan(rugModel) } satisfies MapAsset;
    const tableAsset = { ...asset, id: 'rug-table', name: 'Coffee table', tags: ['table', 'furniture'], modelJson: tableModel, colliderPlan: buildModelColliderPlan(tableModel) } satisfies MapAsset;
    const map = createEmptyMap('living room', 'rug-overlap-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [rugAsset, tableAsset];
    const rug = createMapObject('Area rug', rugAsset.id); rug.id = 'rug';
    const table = createMapObject('Coffee table', tableAsset.id); table.id = 'table';
    map.objects = [rug, table];

    const lint = lintMap(map);

    expect(lint.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap' })
    ]));
    const rugPositions = lint.repairOperations.flatMap((operation) => (
      operation.type === 'object.update' && operation.objectId === 'rug' && operation.patch.transform?.position
        ? [operation.patch.transform.position]
        : []
    ));
    expect(rugPositions).toEqual([[0, 0, 0]]);
  });

  it('keeps supported child objects on their parent surface', () => {
    const deskModel = {
      nodes: [{ id: 'desk', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 1, depth: 1 } } }]
    };
    const lampModel = {
      nodes: [{ id: 'lamp', transform: { pos: [0, 0.3, 0] }, mesh: { type: 'box', params: { width: 0.4, height: 0.6, depth: 0.4 } } }]
    };
    const deskAsset = { ...asset, id: 'desk', name: 'Desk', tags: ['desk', 'furniture'], modelJson: deskModel, colliderPlan: buildModelColliderPlan(deskModel) } satisfies MapAsset;
    const lampAsset = { ...asset, id: 'desk-lamp', name: 'Desk lamp', tags: ['lamp', 'decor'], modelJson: lampModel, colliderPlan: buildModelColliderPlan(lampModel) } satisfies MapAsset;
    const map = createEmptyMap('study', 'supported-overlap-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.assets = [deskAsset, lampAsset];
    const desk = createMapObject('Desk', deskAsset.id); desk.id = 'desk';
    const lamp = createMapObject('Desk lamp', lampAsset.id); lamp.id = 'lamp'; lamp.parentId = desk.id; lamp.transform.position = [0, 1, 0];
    map.objects = [desk, lamp];

    const lint = lintMap(map);

    expect(lint.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'object.overlap' })
    ]));
  });
});
