import { describe, expect, it } from 'vitest';
import {
  MAP_ASSET_COLLIDER_PROFILE,
  PLAYER_MODEL_COLLIDER_PROFILE,
  buildModelColliderPlan,
  calculateModelVisualBounds,
  modelColliderVisibilityPoints,
  modelColliderWorldAabbs,
  rayModelHitboxIntersection
} from '../src/shared/modelBounds';

const thinLegChair = {
  format: 2,
  nodes: [
    {
      id: 'seat',
      transform: { pos: [0, 1, 0] },
      mesh: { type: 'box', params: { width: 1, height: 0.4, depth: 1 } }
    },
    ...[-0.42, 0.42].flatMap((x) => [-0.42, 0.42].map((z, index) => ({
      id: `leg-${x}-${z}-${index}`,
      transform: { pos: [x, 0.4, z] },
      mesh: { type: 'box', params: { width: 0.05, height: 0.8, depth: 0.05 } }
    })))
  ]
};

const splitModel = {
  format: 2,
  nodes: [
    {
      id: 'left-block',
      transform: { pos: [-2, 0.5, 0] },
      mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } }
    },
    {
      id: 'right-block',
      transform: { pos: [2, 0.5, 0] },
      mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } }
    },
    {
      id: 'tiny-decoration',
      transform: { pos: [0, 1.2, 0] },
      mesh: { type: 'box', params: { width: 0.02, height: 0.02, depth: 0.02 } }
    }
  ]
};

describe('voxel-style model collider plans', () => {
  it('keeps the true visual bottom even when thin furniture legs are omitted from collision', () => {
    const visual = calculateModelVisualBounds(thinLegChair);
    const collider = buildModelColliderPlan(thinLegChair, MAP_ASSET_COLLIDER_PROFILE);

    expect(visual.min[1]).toBe(0);
    expect(visual.max[1]).toBeCloseTo(1.2, 5);
    expect(Math.min(...collider.boxes.map((box) => box.min[1]))).toBeCloseTo(0.8, 5);
  });

  it('filters tiny meshes and keeps separate visible mesh boxes', () => {
    const plan = buildModelColliderPlan(splitModel, MAP_ASSET_COLLIDER_PROFILE);

    expect(plan.sourceMeshCount).toBe(3);
    expect(plan.candidateCount).toBe(2);
    expect(plan.boxes.map((box) => box.sourceNodeId)).toEqual(['left-block', 'right-block']);
    expect(plan.fallbackUsed).toBe(false);
  });

  it('does not turn empty space between model parts into a player hitbox', () => {
    const plan = buildModelColliderPlan(splitModel, PLAYER_MODEL_COLLIDER_PROFILE);

    expect(rayModelHitboxIntersection([0, 0.5, 5], [0, 0, -1], [0, 0, 0], 0, 1, splitModel, plan)).toBeNull();
    expect(rayModelHitboxIntersection([2, 0.5, 5], [0, 0, -1], [0, 0, 0], 0, 1, splitModel, plan)).not.toBeNull();
  });

  it('samples the surfaces of real model parts without sampling empty space between them', () => {
    const plan = buildModelColliderPlan(splitModel, PLAYER_MODEL_COLLIDER_PROFILE);
    const points = modelColliderVisibilityPoints(plan, [0, 0, 0], 0, 1);

    expect(points).toHaveLength(14);
    expect(points.every((point) => Math.abs(point[0]) > 1)).toBe(true);
    expect(points.some((point) => point[0] < -2)).toBe(true);
    expect(points.some((point) => point[0] > 2)).toBe(true);
  });

  it('falls back to normalized asset bounds when no mesh passes the profile', () => {
    const plan = buildModelColliderPlan({ format: 2, nodes: [] }, MAP_ASSET_COLLIDER_PROFILE);

    expect(plan.fallbackUsed).toBe(true);
    expect(plan.boxes).toHaveLength(1);
  });

  it('transforms retained model collider boxes with position, yaw, and scale', () => {
    const plan = {
      version: 1 as const,
      boxes: [{ min: [-1, 0, -0.5] as [number, number, number], max: [1, 1, 0.5] as [number, number, number] }],
      sourceMeshCount: 1,
      candidateCount: 1,
      fallbackUsed: false
    };
    const [box] = modelColliderWorldAabbs(plan, [4, 1, -2], Math.PI / 2, 2);

    expect(box.min[0]).toBeCloseTo(3, 5);
    expect(box.max[0]).toBeCloseTo(5, 5);
    expect(box.min[1]).toBeCloseTo(1, 5);
    expect(box.max[1]).toBeCloseTo(3, 5);
    expect(box.min[2]).toBeCloseTo(-4, 5);
    expect(box.max[2]).toBeCloseTo(0, 5);
  });
});
