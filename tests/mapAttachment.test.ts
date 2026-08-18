import { describe, expect, it } from 'vitest';
import {
  createEmptyMap,
  createMapObject,
  getObjectWorldTransforms,
  type MapAsset
} from '../src/shared/map';
import {
  MAX_MAP_OBJECT_HIERARCHY_DEPTH,
  planMapObjectAttachment,
  reparentMapObjectInPlace
} from '../src/shared/mapAttachment';

const asset = (id: string, radius: number, height: number): MapAsset => ({
  id,
  name: id,
  prompt: id,
  tags: [id],
  modelJson: {},
  colliderPlan: {
    version: 1,
    boxes: [{ min: [-radius, 0, -radius], max: [radius, height, radius] }],
    sourceMeshCount: 0,
    candidateCount: 1,
    fallbackUsed: true
  },
  footprintRadius: radius,
  sizeClass: height >= 3 ? 'large' : height >= 1.5 ? 'medium' : 'small',
  mode: 'asset',
  createdAt: 1,
  updatedAt: 1
});

describe('map object attachments', () => {
  it('places supported and mounted children in a movable parent hierarchy', () => {
    const baseAsset = asset('base', 2, 3);
    const tierAsset = asset('tier', 1.2, 1.5);
    const lightAsset = asset('light', 0.2, 0.6);
    const map = createEmptyMap('attachments', 'attachments-map');
    map.assets = [baseAsset, tierAsset, lightAsset];
    const base = createMapObject('Base', baseAsset.id);
    base.id = 'base-object';
    base.transform.position = [4, 0, -3];
    map.objects.push(base);

    const tier = planMapObjectAttachment(map, {
      id: 'tier-object', name: 'Tier', parentId: base.id, asset: tierAsset,
      kind: 'supported', scale: 1
    });
    map.objects.push(tier);
    const light = planMapObjectAttachment(map, {
      id: 'light-object', name: 'Light', parentId: tier.id, asset: lightAsset,
      kind: 'mounted', side: 'east', scale: 1, offset: [0, 0.25]
    });
    map.objects.push(light);

    expect(tier.parentId).toBe(base.id);
    expect(tier.heightMode).toBe('fixed');
    expect(light.parentId).toBe(tier.id);
    expect(light.transform.position[0]).toBeGreaterThan(0);
    const before = getObjectWorldTransforms(map).get(light.id)!.position;
    base.transform.position[0] += 6;
    const after = getObjectWorldTransforms(map).get(light.id)!.position;
    expect(after[0] - before[0]).toBeCloseTo(6);
  });

  it('rejects unrelated overlaps and hierarchies deeper than the bounded limit', () => {
    const baseAsset = asset('base', 2, 3);
    const tierAsset = asset('tier', 1, 1);
    const map = createEmptyMap('bounded attachments', 'bounded-attachments-map');
    map.assets = [baseAsset, tierAsset];
    const root = createMapObject('Root', baseAsset.id);
    root.id = 'root';
    map.objects.push(root);
    const first = planMapObjectAttachment(map, {
      id: 'first', name: 'First', parentId: root.id, asset: tierAsset, kind: 'supported'
    });
    map.objects.push(first);

    expect(() => planMapObjectAttachment(map, {
      id: 'overlap', name: 'Overlap', parentId: root.id, asset: tierAsset, kind: 'supported'
    })).toThrow('map_attachment_unrelated_overlap');

    let parentId = first.id;
    for (let depth = 2; depth < MAX_MAP_OBJECT_HIERARCHY_DEPTH; depth += 1) {
      const child = planMapObjectAttachment(map, {
        id: `depth-${depth + 1}`, name: `Depth ${depth + 1}`, parentId, asset: tierAsset,
        kind: 'supported', offset: [depth * 0.25, 0]
      });
      map.objects.push(child);
      parentId = child.id;
    }
    expect(() => planMapObjectAttachment(map, {
      id: 'too-deep', name: 'Too deep', parentId, asset: tierAsset, kind: 'supported'
    })).toThrow('map_attachment_depth_exceeded');
  });

  it('preserves world transforms while reparenting and rejects cycles', () => {
    const map = createEmptyMap('reparent', 'reparent-map');
    const base = createMapObject('Base');
    base.id = 'base';
    base.transform.position = [4, 1, -2];
    base.transform.rotation = [0, Math.PI / 3, 0];
    base.transform.scale = [1.5, 2, 0.75];
    const child = createMapObject('Child');
    child.id = 'child';
    child.transform.position = [7, 3, 5];
    child.transform.rotation = [0, Math.PI / 6, 0];
    child.transform.scale = [0.8, 1.2, 1.1];
    map.objects.push(base, child);
    const before = getObjectWorldTransforms(map).get(child.id)!;

    reparentMapObjectInPlace(map, child.id, base.id);
    const after = getObjectWorldTransforms(map).get(child.id)!;
    expect(after.position).toEqual(before.position.map((value) => expect.closeTo(value)));
    expect(after.rotation).toEqual(before.rotation.map((value) => expect.closeTo(value)));
    expect(after.scale).toEqual(before.scale.map((value) => expect.closeTo(value)));
    expect(() => reparentMapObjectInPlace(map, base.id, child.id)).toThrow('map_object_parent_cycle');
  });
});
