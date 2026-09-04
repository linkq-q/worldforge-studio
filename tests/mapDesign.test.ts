import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { normalizeMapDesignSemantics } from '../src/shared/mapDesign';
import { compileMapDesignDensityFill, compileMapDesignPruning, compileMapDesignRelations } from '../src/shared/mapDesignRelations';
import { applyMapOperations } from '../src/shared/mapOperations';

describe('map design semantics', () => {
  it('persists a two-level multi-focus design graph without using physical parent hierarchy', () => {
    const design = normalizeMapDesignSemantics({
      experienceMode: 'mixed',
      intent: 'A library is visible at entry while garden rooms reveal local focuses in sequence.',
      groups: [
        { id: 'scene', name: '整体场景', intent: '平衡建筑与游览', focusIds: ['library'] },
        { id: 'garden', parentId: 'scene', name: '园林分区', intent: '步移景异', focusIds: ['pavilion', 'moon-gate'] }
      ],
      focuses: [
        { id: 'library', groupId: 'scene', name: '图书馆', kind: 'primary', rank: 1, selector: 'library' },
        { id: 'pavilion', groupId: 'garden', name: '湖心亭', kind: 'primary', rank: 1, selector: 'pavilion' },
        { id: 'moon-gate', groupId: 'garden', name: '月洞门', kind: 'secondary', rank: 2, selector: 'moon-gate' }
      ]
    }, [96, 16, 96]);

    const map = applyMapOperations(createEmptyMap('design'), [{ type: 'map.update', designSemantics: design }]);
    expect(map.designSemantics.experienceMode).toBe('mixed');
    expect(map.designSemantics.groups.find((group) => group.id === 'garden')?.parentId).toBe('scene');
    expect(map.designSemantics.focuses.filter((focus) => focus.groupId === 'garden')).toHaveLength(2);
  });

  it('normalizes malformed optional fields instead of rejecting the whole design graph', () => {
    const design = normalizeMapDesignSemantics({
      experienceMode: 'unknown',
      groups: [{ id: 'main', name: '主组', layers: [{ level: 9, density: 'dense' }, { level: 4, density: 'open' }] }],
      focuses: [{ id: 'focus', groupId: 'missing', rank: 99 }],
      relations: [{ id: 'chairs', kind: 'attract', sourceSelector: 'chair', targetSelector: 'table', strength: 'tight' }]
    }, [48, 12, 48]);

    expect(design.experienceMode).toBe('mixed');
    expect(design.groups[0].layers).toEqual([expect.objectContaining({ level: 4, density: 'open' })]);
    expect(design.focuses).toEqual([]);
    expect(design.relations).toEqual([expect.objectContaining({ kind: 'attract', strength: 'tight' })]);
  });

  it('preserves an AI-authored minimum placement commitment for each composition layer', () => {
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'court', name: '庭院', intent: '厅房围合庭院',
        layers: [
          { level: 1, intent: '主厅与两侧厢房', density: 'tight', minCount: 3 },
          { level: 3, intent: '石灯和桌椅', density: 'normal', minCount: 99 }
        ]
      }]
    }, [96, 16, 96]);

    expect(design.groups[0].layers).toEqual([
      expect.objectContaining({ level: 1, minCount: 3 }),
      expect.objectContaining({ level: 3, minCount: 64 })
    ]);
  });

  it('compiles a generic support relation into physical parent placement', () => {
    const table = asset('table', '桌子', [2, 1, 1]);
    const computer = asset('computer', '电脑', [0.5, 0.4, 0.4]);
    const map = createEmptyMap('support');
    map.assets = [table, computer];
    const tableObject = createMapObject('桌子', table.id);
    const computerObject = createMapObject('电脑', computer.id);
    map.objects = [tableObject, computerObject];
    const design = normalizeMapDesignSemantics({
      groups: [{ id: 'desk', name: '桌面组' }],
      relations: [{ id: 'computer-on-table', kind: 'support', sourceSelector: '电脑', targetSelector: '桌子', strength: 'tight' }]
    }, map.box.size);

    const next = applyMapOperations(map, compileMapDesignRelations(map, design));
    const placedComputer = next.objects.find((object) => object.id === computerObject.id);
    expect(placedComputer?.parentId).toBe(tableObject.id);
    expect(placedComputer?.heightMode).toBe('fixed');
    expect(placedComputer?.transform.position[1]).toBeGreaterThan(0.9);
  });

  it('fills a sparse declared natural-detail layer with collision-safe scenery', () => {
    const pine = asset('pine', '造型松', [1.2, 4, 1.2]);
    const map = createEmptyMap('sparse garden', 'sparse-garden', [80, 16, 80]);
    map.assets = [pine];
    for (let index = 0; index < 4; index += 1) {
      const object = createMapObject(`造型松 ${index + 1}`, pine.id);
      object.id = `pine-${index}`;
      object.designGroupId = 'garden';
      object.compositionLayer = 3;
      object.transform.position = [-12 + index * 8, 0, 0];
      map.objects.push(object);
    }
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'garden', name: '园林', region: {
          kind: 'polygon', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]]
        },
        layers: [{ level: 3, density: 'normal', intent: '树木、山石与花木形成丰富背景' }]
      }]
    }, map.box.size);

    const operations = compileMapDesignDensityFill(map, design);
    const next = applyMapOperations(map, operations);
    const added = next.objects.filter((object) => object.id.startsWith('design-fill-'));

    expect(added.length).toBeGreaterThan(4);
    expect(added.every((object) => object.designGroupId === 'garden' && object.compositionLayer === 3)).toBe(true);
    expect(added.every((object) => (
      Math.abs(object.transform.position[0]) <= 30 && Math.abs(object.transform.position[2]) <= 30
    ))).toBe(true);
  });

  it('does not let dense rock decoration consume the vegetation fill target', () => {
    const pine = asset('pine', '造型松', [1.2, 4, 1.2]);
    const rock = asset('rock', '太湖石', [1.4, 2, 1.2]);
    const map = createEmptyMap('balanced garden', 'balanced-garden', [80, 16, 80]);
    map.assets = [pine, rock];
    for (let index = 0; index < 2; index += 1) {
      const object = createMapObject(`造型松 ${index + 1}`, pine.id);
      object.designGroupId = 'garden';
      object.compositionLayer = 3;
      object.transform.position = [-4 + index * 8, 0, 0];
      map.objects.push(object);
    }
    for (let index = 0; index < 20; index += 1) {
      const object = createMapObject(`太湖石 ${index + 1}`, rock.id);
      object.designGroupId = 'garden';
      object.compositionLayer = 3;
      object.transform.position = [-25 + index * 2.5, 0, -24];
      map.objects.push(object);
    }
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'garden', name: '园林', region: {
          kind: 'polygon', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]]
        },
        layers: [{ level: 3, density: 'normal', intent: '树木与太湖石形成疏密有致的近中远景' }]
      }]
    }, map.box.size);
    const next = applyMapOperations(map, compileMapDesignDensityFill(map, design));
    const addedTrees = next.objects.filter((object) => object.id.startsWith('design-fill-') && object.assetId === pine.id);
    const occupiedQuadrants = new Set(addedTrees.map((object) => (
      `${object.transform.position[0] >= 0 ? 1 : -1}:${object.transform.position[2] >= 0 ? 1 : -1}`
    )));

    expect(addedTrees.length).toBeGreaterThan(12);
    expect(occupiedQuadrants.size).toBeGreaterThanOrEqual(3);
  });

  it('does not prune detail layers unless the AI explicitly marks removable objects', () => {
    const pine = asset('pine', '造型松', [1.2, 4, 1.2]);
    const map = createEmptyMap('pruning guard', 'pruning-guard', [80, 16, 80]);
    map.assets = [pine];
    for (let index = 0; index < 6; index += 1) {
      const object = createMapObject(`造型松 ${index + 1}`, pine.id);
      object.id = `pine-${index}`;
      object.designGroupId = 'garden';
      object.compositionLayer = 3;
      object.transform.position = [-15 + index * 6, 0, 0];
      map.objects.push(object);
    }
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'garden', name: '园林', region: {
          kind: 'polygon', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]]
        },
        layers: [{ level: 3, density: 'open', intent: '树木' }]
      }]
    }, map.box.size);

    expect(compileMapDesignPruning(map, design)).toEqual([]);
  });

  it('never backfills natural detail into a declared functional clearing', () => {
    const pine = asset('pine', '造型松', [1.2, 4, 1.2]);
    let map = createEmptyMap('arena garden', 'arena-garden', [80, 16, 80]);
    map.assets = [pine];
    const seedTree = createMapObject('造型松', pine.id);
    seedTree.designGroupId = 'grounds';
    seedTree.compositionLayer = 3;
    seedTree.transform.position = [24, 0, 24];
    map.objects.push(seedTree);
    map = applyMapOperations(map, [{
      type: 'terrain.surface', surface: 'sand', clearNatural: true,
      region: { kind: 'circle', x: 0, z: 0, radius: 15 }, intensity: 1, zoneId: 'arena-floor'
    }]);
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'grounds', name: '外围园林',
        region: { kind: 'polygon', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]] },
        layers: [{ level: 3, density: 'tight', intent: '树木形成外围背景' }]
      }]
    }, map.box.size);
    const next = applyMapOperations(map, compileMapDesignDensityFill(map, design));
    const added = next.objects.filter((object) => object.id.startsWith('design-fill-'));

    expect(added.length).toBeGreaterThan(4);
    expect(added.every((object) => Math.hypot(
      object.transform.position[0], object.transform.position[2]
    ) > 15 + 0.25)).toBe(true);
  });

  it('does not mistake stone bases or guardian lions for a natural scenery layer', () => {
    const lamp = {
      ...asset('lamp', '宫灯柱', [1, 5, 1]),
      prompt: 'Tall palace lantern on a carved stone base',
      tags: ['lantern', 'pillar']
    };
    const pine = asset('pine', '苍松', [1.2, 4, 1.2]);
    const map = createEmptyMap('ceremonial entry', 'ceremonial-entry', [60, 12, 60]);
    map.assets = [lamp, pine];
    const object = createMapObject('仪仗宫灯', lamp.id);
    object.designGroupId = 'arrival';
    object.compositionLayer = 3;
    map.objects.push(object);
    const design = normalizeMapDesignSemantics({
      groups: [{
        id: 'arrival', name: '仪仗入口', intent: '用石狮和主门形成门槛',
        region: { kind: 'circle', x: 0, z: 0, radius: 18 },
        layers: [{ level: 3, density: 'tight', intent: '成对灯柱仪仗节奏' }]
      }]
    }, map.box.size);

    expect(compileMapDesignDensityFill(map, design)).toEqual([]);
  });
});

function asset(id: string, name: string, size: [number, number, number]): MapAsset {
  return {
    id, name, prompt: name, tags: [name], mode: 'voxel', createdAt: 1, updatedAt: 1,
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    modelJson: {
      format: 2,
      nodes: [{
        id: `${id}-node`, transform: { pos: [0, size[1] / 2, 0] },
        mesh: { type: 'box', params: { width: size[0], height: size[1], depth: size[2] } }
      }]
    }
  };
}
