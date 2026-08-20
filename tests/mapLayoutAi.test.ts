import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { createMapEdgeMask } from '../src/shared/mapLayout';
import { generateMapLayoutSuggestion, normalizeMapLayoutSuggestion } from '../src/server/mapLayoutAi';

describe('map layout AI normalization', () => {
  it('preserves the saved global terrain prompt and existing edge mask', () => {
    const map = createEmptyMap('layout', 'map-layout-ai');
    map.layout.globalPrompt = 'shared rolling highlands';
    map.layout.edgeMask = createMapEdgeMask('circle', map.box.size);

    const suggestion = normalizeMapLayoutSuggestion({
      summary: 'two halves',
      globalPrompt: '',
      regions: [{ id: 'left', points: [[-1, -1], [0, -1], [0, 1], [-1, 1]] },
        { id: 'right', points: [[0, -1], [1, -1], [1, 1], [0, 1]] }]
    }, map);

    expect(suggestion.layout.globalPrompt).toBe('shared rolling highlands');
    expect(suggestion.layout.edgeMask.kind).toBe('circle');
  });

  it('rejects even small sampled gaps between AI regions', () => {
    const map = createEmptyMap('layout', 'map-layout-gap');
    expect(() => normalizeMapLayoutSuggestion({
      regions: [{ id: 'left', points: [[-1, -1], [-0.02, -1], [-0.02, 1], [-1, 1]] },
        { id: 'right', points: [[0.02, -1], [1, -1], [1, 1], [0.02, 1]] }]
    }, map)).toThrow('map_layout_incomplete_partition');
  });

  it('reports planning, validation and completion progress', async () => {
    const progress: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        summary: 'one region',
        regions: [{ id: 'all', points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] }]
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await generateMapLayoutSuggestion('one region', createEmptyMap('layout', 'map-layout-progress'), {
      apiBase: 'https://example.test', fetchImpl,
      onProgress: (event) => progress.push(event.phase)
    });

    expect(progress).toEqual(['planning', 'consulting', 'consulting', 'validating', 'complete']);
    const request = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(request.messages[0].content).toContain('one short sentence');
    expect(request.messages[0].content).toContain('Do not ask the player for coordinates');
  });
});
