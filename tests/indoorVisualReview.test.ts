import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import {
  mapVisualReviewAction,
  normalizeIndoorVisualReview,
  normalizeMapVisualReview
} from '../src/shared/indoorVisualReview';
import { reviewIndoorMapVisual, reviewMapVisual } from '../src/server/indoorVisualReview';

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

  it('reviews outdoor continuity and returns one no-new-asset repair prompt', async () => {
    const map = createEmptyMap('Arena', 'arena-review');
    const wall = createMapObject('Arena wall', null); wall.id = 'wall-1';
    map.objects = [wall];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
      expect(String(body.messages[0].content)).toContain('outdoor-environment final inspector');
      expect(String(body.messages[0].content)).toContain('disconnected architecture');
      return new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: 'The arena modules are too disconnected.',
          findings: [{ code: 'sparse', severity: 'major', message: 'Reconnect the outer wall rhythm.', objectIds: ['wall-1'] }]
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const review = await reviewMapVisual(map, 'data:image/jpeg;base64,AA==', { fetchImpl });

    expect(review.status).toBe('revise');
    expect(mapVisualReviewAction(review)).toBe('repair');
    expect(review.repairPrompt).toContain('不生成新资产');
    expect(review.repairPrompt).toContain('保留连贯建筑组');
    expect(normalizeMapVisualReview({ findings: [] }, new Set(), 'outdoor').status).toBe('pass');
  });
});
