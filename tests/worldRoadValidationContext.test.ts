import { describe, expect, it } from 'vitest';
import { validateTownPatch, validateWorldPlan, worldPlanKey, type WorldPlan } from '../src/shared/worldPlanning';
import type { MapGuide } from '../src/shared/mapGuide';

function plan(grade = 0.6): WorldPlan {
  const resolution = 65;
  return { version: 1, id: 'road-context', revision: 1, prompt: 'A road on measured terrain', ecology: [], towns: [], roads: [],
    recipe: { version: 1, seed: 7, size: 500, constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
      version: 1, source: 'analytic test field', resolution, observations: [],
      heights: Array.from({ length: resolution ** 2 }, (_, index) => 200 + (index % resolution * 500 / (resolution - 1) - 250) * grade)
    } } };
}
const road = (id: string, points: [number, number][]): MapGuide => ({ id, name: id, points, width: 4, curve: 'polyline', closed: false, tags: [] });
function context(action: () => unknown, code: string) {
  let failure: Error | undefined;
  try { action(); } catch (error) { failure = error as Error; }
  expect(failure?.message.startsWith(code + ':')).toBe(true);
  return JSON.parse(failure!.message.slice(code.length + 1));
}

describe('actionable road validation context', () => {
  it('retains the longitudinal error code and reports the road, sampled segment and measured rise/run', () => {
    const input = plan(); input.roads = [road('ridge-access', [[-100, 0], [100, 0]])];
    const result = context(() => validateWorldPlan(input), 'world_road_slope');
    expect(result).toMatchObject({ roadId: 'ridge-access', segmentIndex: 0, sampleIndex: 1, position: [-98, 0],
      grade: 0.6, maxGrade: 0.5, units: 'rise/run', coordinateSpace: 'world-XZ-metres', sampleSpacing: 2 });
    expect(result.segment).toEqual([[-100, 0], [100, 0]]);
  });

  it('reports transverse grade at the failing cross-section without relaxing the old limit', () => {
    const input = plan(); input.roads = [road('cross-hill', [[0, -20], [0, 20]])];
    expect(context(() => validateWorldPlan(input), 'world_road_cross_slope')).toMatchObject({
      roadId: 'cross-hill', segmentIndex: 0, sampleIndex: 0, position: [0, -20], grade: 0.6, maxGrade: 0.5, width: 4
    });
    const allowed = plan(0.49); allowed.roads = [road('gentle', [[-100, 0], [100, 0]])];
    expect(validateWorldPlan(allowed).roads[0].id).toBe('gentle');
  });

  it('identifies the owning town and translates a failed local street into world coordinates', () => {
    const input = plan();
    input.towns = [{ id: 'town', name: 'Town', prompt: 'Existing town', center: [100, 80], radius: 50,
      blend: 20, foundation: 260, terrainMode: 'conform', ports: [] }];
    const patch = { townId: 'town', worldKey: worldPlanKey(input), summary: 'A local street', buildings: [],
      streets: [road('steep-lane', [[0, 0], [24, 0]])] };
    expect(context(() => validateTownPatch(input, patch), 'world_road_slope')).toMatchObject({
      townId: 'town', roadId: 'steep-lane', segmentIndex: 0, sampleIndex: 1, position: [112, 80],
      segment: [[100, 80], [124, 80]], grade: 0.6, maxGrade: 0.5, sampleSpacing: 12
    });
  });
});
