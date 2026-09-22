import { describe, expect, it } from 'vitest';
import { sanitizeModelJson } from '../src/server/mapStore';

describe('sanitizeModelJson', () => {
  it('replaces non-finite transforms with neutral values', () => {
    const modelJson = {
      nodes: [
        { id: 'a', transform: { pos: [NaN, 1.35, Infinity], quat: [null, 0, 0, NaN] } },
        { id: 'b', transform: { pos: [0, 0, 0], scale: [-Infinity, 2, 3] } }
      ]
    };
    const out = sanitizeModelJson(modelJson) as typeof modelJson;
    expect(out.nodes[0].transform.pos).toEqual([0, 1.35, 0]);
    expect(out.nodes[0].transform.quat).toEqual([0, 0, 0, 1]);
    expect(out.nodes[1].transform.scale).toEqual([1, 2, 3]);
  });

  it('sanitizes mesh params including numeric arrays', () => {
    const modelJson = {
      nodes: [
        { id: 'm0', mesh: { type: 'box', params: { width: 2, height: NaN, depth: [1, Infinity, 3] } } }
      ]
    };
    const out = sanitizeModelJson(modelJson) as typeof modelJson;
    expect(out.nodes[0].mesh!.params).toEqual({ width: 2, height: 0, depth: [1, 0, 3] });
  });

  it('passes clean models and non-node payloads through untouched', () => {
    const clean = { nodes: [{ id: 'a', transform: { pos: [1, 2, 3] } }] };
    expect(sanitizeModelJson(clean)).toBe(clean);
    expect(sanitizeModelJson('not-a-model' as unknown as object)).toBe('not-a-model' as unknown as object);
    expect(sanitizeModelJson(null)).toBe(null);
  });
});
