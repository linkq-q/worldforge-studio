import { describe, expect, it } from 'vitest';
import { collectSceneMaterialTagOptions } from '../src/client/materialTagScenePanel';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import {
  filterMaterialTags,
  materialTagSelector,
  normalizeMaterialTagPolicy
} from '../src/shared/materialTagPolicy';

describe('scene material tag policy', () => {
  it('disables only the fur value by default', () => {
    const policy = normalizeMaterialTagPolicy(undefined);

    expect(policy.disabled).toEqual(['base:fur']);
    expect(normalizeMaterialTagPolicy(policy)).toEqual(policy);
    expect(filterMaterialTags([
      { tag: 'base', value: 'fur' },
      { tag: 'base', value: 'wood' },
      { tag: 'vegetation', value: 1 }
    ], policy)).toEqual([
      { tag: 'base', value: 'wood' },
      { tag: 'vegetation', value: 1 }
    ]);
  });

  it('keeps enum material values independently configurable', () => {
    expect(materialTagSelector({ tag: 'base', value: 'fur' })).toBe('base:fur');
    expect(materialTagSelector({ tag: 'base', value: 'wood' })).toBe('base:wood');
    expect(materialTagSelector({ tag: 'mossy', value: 0.7 })).toBe('mossy');
    expect(normalizeMaterialTagPolicy({ disabled: [] }).disabled).toEqual([]);
  });

  it('lists only tags used by visible objects in the current scene', () => {
    const map = createEmptyMap('Tags', 'map-tags');
    map.objects.push(createMapObject('Deer', 'asset-deer'));
    map.objects.push({ ...createMapObject('Hidden', 'asset-hidden'), visible: false });
    const assets = [asset('asset-deer', [
      { tag: 'base', value: 'fur' },
      { tag: 'vegetation', value: 1 }
    ]), asset('asset-hidden', [{ tag: 'base', value: 'stone' }])];

    expect(collectSceneMaterialTagOptions(map, assets)).toEqual([
      expect.objectContaining({ selector: 'base:fur', enabled: false, affectedParts: 1 }),
      expect.objectContaining({ selector: 'vegetation', enabled: true, affectedParts: 1 })
    ]);
  });
});

function asset(id: string, tags: unknown[]): MapAsset {
  return {
    id,
    name: id,
    prompt: id,
    tags: [],
    modelJson: { nodes: [{ id: 'part', mesh: { type: 'box' }, tags }] },
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false },
    mode: 'voxel-pro',
    createdAt: 1,
    updatedAt: 1
  };
}
