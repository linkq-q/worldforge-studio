import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { createBrowserMapDraft, isBrowserMapPlanCurrent, recoverBrowserMapDraft, type BrowserMapPlan } from '../src/client/mapDraftStore';

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

  it('restores a saved plan only against its unchanged source map', () => {
    const map = createEmptyMap('park', 'park-map');
    const plan: BrowserMapPlan = {
      mapId: map.id, baseUpdatedAt: map.updatedAt, updatedAt: 1, prompt: 'a park',
      suggestion: {
        summary: 'park plan', operations: [], renderPromptSuggestions: [], generatedAssets: [],
        codePlan: { code: 'api.asset({ key: "tree" });', placementCount: 1, functions: ['asset'] }
      },
      preview: null,
      options: { focusPrompt: '', minNewAssets: 1, maxNewAssets: 20, reuseExistingAssets: false, assetLibraryId: '', paletteId: '' }
    };

    expect(isBrowserMapPlanCurrent(map, plan)).toBe(true);
    expect(isBrowserMapPlanCurrent({ ...map, updatedAt: map.updatedAt + 1 }, plan)).toBe(false);
    expect(isBrowserMapPlanCurrent({ ...map, id: 'other' }, plan)).toBe(false);
  });
});
