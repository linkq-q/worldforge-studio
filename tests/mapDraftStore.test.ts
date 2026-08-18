import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { createBrowserMapDraft, recoverBrowserMapDraft } from '../src/client/mapDraftStore';

describe('browser map draft', () => {
  it('stores map edits without duplicating hydrated asset payloads', () => {
    const map = createEmptyMap('draft', 'draft-map');
    map.assets = [{
      id: 'asset-a', name: 'Tree', prompt: 'tree', tags: ['tree'], modelJson: { large: true },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      footprintRadius: 1, mode: 'asset', createdAt: 1, updatedAt: 1
    }];
    map.objects.push({
      id: 'tree-a', name: 'Tree', assetId: 'asset-a', parentId: null, visible: true, locked: false,
      transform: { position: [2, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] }
    });

    const draft = createBrowserMapDraft(map, 123);

    expect(draft.updatedAt).toBe(123);
    expect(draft.map.assets).toBeUndefined();
    expect(draft.map.objects[0].assetId).toBe('asset-a');
  });

  it('recovers draft content with assets from the current saved map', () => {
    const saved = createEmptyMap('saved', 'draft-map');
    saved.assets = [{
      id: 'asset-a', name: 'Tree', prompt: 'tree', tags: ['tree'], modelJson: {},
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      footprintRadius: 1, mode: 'asset', createdAt: 1, updatedAt: 1
    }];
    const edited = structuredClone(saved);
    edited.name = 'recovered';

    const recovered = recoverBrowserMapDraft(saved, createBrowserMapDraft(edited));

    expect(recovered.name).toBe('recovered');
    expect(recovered.assets?.[0].id).toBe('asset-a');
  });
});
