import { describe, expect, it } from 'vitest';
import { buildWorldAssetLibrary, disposeWorldAssetLibrary, pickWorldEcologyAsset, type WorldAssetSource } from '../src/client/worldAssets';

const modelJson = {
  format: 2,
  nodes: [{ id: 'body', mesh: { type: 'box', params: { width: 1, height: 2, depth: 1 } } }]
};

describe('world ecology asset binding', () => {
  it('prefers rule identity, then generic kind, and keeps legacy trees away from shrubs and rocks', async () => {
    const source = (id: string, ecologyKind?: WorldAssetSource['ecologyKind'], ecologyRuleId?: string): WorldAssetSource => ({
      id, name: id, role: 'tree', modelJson,
      ...(ecologyKind ? { ecologyKind } : {}),
      ...(ecologyRuleId ? { ecologyRuleId } : {})
    });
    const library = await buildWorldAssetLibrary([
      source('legacy-tree'),
      source('broadleaf-tree', 'broadleaf'),
      source('harbor-oak', 'broadleaf', 'harbor-forest'),
      source('shrub', 'shrub')
    ]);
    try {
      expect(pickWorldEcologyAsset(library, {id: 'a', kind: 'broadleaf', ruleId: 'harbor-forest'})?.id).toBe('harbor-oak');
      expect(pickWorldEcologyAsset(library, {id: 'b', kind: 'broadleaf', ruleId: 'other'})?.id).toBe('broadleaf-tree');
      expect(pickWorldEcologyAsset(library, {id: 'c', kind: 'pine', ruleId: 'other'})?.id).toBe('legacy-tree');
      expect(pickWorldEcologyAsset(library, {id: 'd', kind: 'shrub', ruleId: 'other'})?.id).toBe('shrub');
      expect(pickWorldEcologyAsset(library, {id: 'e', kind: 'rock', ruleId: 'other'})).toBeUndefined();
    } finally {
      disposeWorldAssetLibrary(library);
    }
  });
});
