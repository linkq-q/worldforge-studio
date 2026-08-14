import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { normalizeIndoorVisualReview } from '../src/shared/indoorVisualReview';
import { reviewIndoorMapVisual } from '../src/server/indoorVisualReview';

describe('indoor lightweight visual review', () => {
  it('uses one multimodal request and keeps only exact scene object ids', async () => {
    const map = createEmptyMap('Dorm room', 'dorm-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const bed = createMapObject('Bed', null); bed.id = 'bed-1';
    map.objects = [bed];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
      expect(Array.isArray(body.messages[1].content)).toBe(true);
      expect(body.messages[1].content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' })
      ]));
      return new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: 'Beds overlap.',
          findings: [{ code: 'overlap', severity: 'major', message: 'Two beds intersect.', objectIds: ['bed-1', 'invented-id'] }]
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const review = await reviewIndoorMapVisual(map, 'data:image/jpeg;base64,AA==', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(review.status).toBe('revise');
    expect(review.findings[0].objectIds).toEqual(['bed-1']);
    expect(review.repairPrompt).toContain('不生成新资产');
    expect(review.repairPrompt).toContain('bed-1');
  });

  it('does not trigger repair for minor polish findings', () => {
    const review = normalizeIndoorVisualReview({
      summary: 'Small visual imperfection.',
      findings: [{ code: 'composition', severity: 'minor', message: 'One corner feels slightly empty.', objectIds: [] }]
    }, new Set());

    expect(review.status).toBe('pass');
    expect(review.repairPrompt).toBe('');
  });
});
