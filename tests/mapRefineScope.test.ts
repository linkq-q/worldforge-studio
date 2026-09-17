import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject, getObjectWorldTransforms } from '../src/shared/map';
import { applyMapOperations, type CodePlanPreviewPayload } from '../src/shared/mapOperations';
import { scopeMapRefinement } from '../src/shared/mapRefineScope';
import { runMapAgent } from '../src/server/mapAi';

function scopedMap() {
  const map = createEmptyMap();
  map.visualSemantics.zones = [{ id: 'work', center: [10, 0], radius: 4, tags: [], intensity: 1, locks: {} }];
  const host = createMapObject('host');
  host.id = 'host'; host.transform.position = [10, 0, 0];
  const child = createMapObject('child');
  child.id = 'child'; child.parentId = host.id; child.transform.position = [0, 0, 2];
  map.objects = [host, child];
  return map;
}

describe('scoped Scene Code refinement', () => {
  it('resolves child edits in world space and prevents parent edits from taking children out of scope', () => {
    const map = scopedMap();
    const result = scopeMapRefinement(map, [
      { type: 'object.update', objectId: 'child', patch: { transform: { position: [0, 0, 3] } } },
      { type: 'object.update', objectId: 'host', patch: { transform: { position: [12, 0, 0] } } },
      { type: 'object.update', objectId: 'host', patch: { transform: { position: [13, 0, 0] } } },
      { type: 'object.remove', objectId: 'host' }
    ], { targetVisualZoneId: 'work' });
    expect(result).toHaveLength(2);
    const after = applyMapOperations(map, result);
    expect(getObjectWorldTransforms(after).get('child')?.position).toEqual([12, 0, 3]);
    expect(after.objects.find(object => object.id === 'child')?.parentId).toBe('host');
  });

  it('keeps regional edits as deltas and strips global settings while retaining render intent', () => {
    const map = scopedMap();
    map.layout.regions = [{ id: 'district', name: 'district', prompt: '', groupId: null, color: '#ffffff',
      points: [[6, -4], [14, -4], [14, 4], [6, 4]], contentLocked: false, boundaryLocked: false }];
    map.objects[0].generation = { kind: 'region', id: 'district', generationId: 'old' };
    const result = scopeMapRefinement(map, [
      { type: 'terrain.generate', preset: 'hills' },
      { type: 'map.update', name: 'unrequested', renderPromptSuggestions: ['warm work area'] },
      { type: 'object.update', objectId: 'child', patch: { name: 'new workbench' } }
    ], { targetRegionId: 'district' });
    const after = applyMapOperations(map, result);
    expect(after.name).toBe(map.name);
    expect(after.objects).toHaveLength(2);
    expect(after.renderPromptSuggestions).toEqual(['warm work area']);
    expect(after.objects[1].name).toBe('new workbench');
    expect(result.some(operation => operation.type === 'terrain.generate' || operation.type === 'object.remove')).toBe(false);
  });

  it('applies the boundary to the real agent result and streamed preview without failing valid edits', async () => {
    const map = scopedMap();
    const outside = createMapObject('outside'); outside.id = 'outside'; outside.transform.position = [-12, 0, 0];
    map.objects.push(outside);
    const code = `function plan(api) {
      api.move({objectId:'host',position:[11,0]});
      api.move({objectId:'outside',position:[-10,0]});
      api.place({name:'outside addition',position:[-15,8],dimensions:[1,1,1]});
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code })));
    const previews: CodePlanPreviewPayload[] = [];
    const suggestion = await runMapAgent('局部微调', map, [], {
      mode: 'refine', sceneAgent: true, targetVisualZoneId: 'work', minNewAssets: 0, maxNewAssets: 0,
      fetchImpl, createAsset: vi.fn(), onPlanPreview: preview => previews.push(preview)
    });
    const after = applyMapOperations(map, suggestion.operations);
    expect(after.objects.find(object => object.id === 'host')?.transform.position[0]).toBe(11);
    expect(after.objects.find(object => object.id === 'outside')).toEqual(outside);
    expect(after.objects).toHaveLength(3);
    expect(suggestion.diagnostics).toContainEqual(expect.objectContaining({ code: 'scene.refine-scope' }));
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.flatMap(preview => preview.placements).every(item => item.name !== 'outside addition')).toBe(true);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(request.messages[1].content).toContain('Local refinement boundary:');
  });
});
