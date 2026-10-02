import { describe, expect, it } from 'vitest';
import { createWorldEnvironmentEvidence } from '../src/shared/worldEnvironmentEvidence';
import type { WorldPlan } from '../src/shared/worldPlanning';
import type { WorldRecipe } from '../src/shared/worldTerrain';

function plan(recipe: WorldRecipe, positions: Array<[string, [number, number]]>, withRoute = false): WorldPlan {
  const anchors = positions.map(([id, position]) => ({ id, kind: 'site', position, regionId: `${id}-region` }));
  return {
    version: 1, id: 'environment-evidence', revision: 1, prompt: 'Sample the authored plan', recipe,
    ecology: [], towns: [], roads: [],
    featureGraph: {
      regions: anchors.map(anchor => ({ id: anchor.regionId, kind: 'site', name: anchor.id,
        center: anchor.position, radius: 12 })),
      anchors, relations: [],
      paths: withRoute ? [{ id: 'access-path', kind: 'road', name: 'Access path',
        points: [[-80, 0], [80, 0]], width: 4 }] : []
    },
    mobilityPlan: { routes: withRoute
      ? [{ id: 'access-route', pathId: 'access-path', mode: 'walk', connects: [anchors[0].id] }]
      : [] }
  };
}

const baseRecipe = (): WorldRecipe => ({
  version: 1, seed: 17, size: 500, reliefProfile: 'compact', heightScale: 0.02,
  constraints: [{ region: 'center', biome: 'grassland' }]
});
const waterCases: Array<['sea' | 'lake' | 'river', WorldRecipe]> = [
  ['sea', { ...baseRecipe(), terrainBrushes: [{ id: 'sea-bed', mode: 'flatten',
    region: { kind: 'circle', center: [0, 0], radius: 40 }, height: -5 }] }],
  ['lake', { ...baseRecipe(), terrainBrushes: [{ id: 'lake-bed', mode: 'flatten',
    region: { kind: 'circle', center: [0, 0], radius: 40 }, height: 8 }],
    waterBodies: [{ id: 'still-water', type: 'lake',
      region: { kind: 'circle', center: [0, 0], radius: 20 }, levels: [10], depth: 3 }] }],
  ['river', { ...baseRecipe(), terrainBrushes: [{ id: 'river-bed', mode: 'flatten',
    region: { kind: 'circle', center: [0, 0], radius: 40 }, height: 8 }],
    waterBodies: [{ id: 'moving-water', type: 'river',
      region: { kind: 'path', points: [[-20, 0], [20, 0]], width: 8 }, levels: [10, 10], depth: 3 }] }]
];

describe('world environment evidence', () => {
  it('samples bounded anchor terrain and authored access without turning evidence into a gate', () => {
    const evidence = createWorldEnvironmentEvidence(plan(baseRecipe(), [
      ['connected', [0, 5]], ['nearby', [0, 20]]
    ], true));

    expect(evidence).toMatchObject({ version: 1, anchors: [
      { id: 'connected', position: [0, 5], water: null,
        access: { routeId: 'access-route', pathId: 'access-path', distanceMeters: 3, declaredConnection: true } },
      { id: 'nearby', position: [0, 20], water: null,
        access: { routeId: 'access-route', pathId: 'access-path', distanceMeters: 18, declaredConnection: false } }
    ] });
    for (const anchor of evidence.anchors) {
      expect(Number.isFinite(anchor.groundHeight)).toBe(true);
      expect(Number.isFinite(anchor.slopeDegrees)).toBe(true);
      expect(['ocean', 'grassland', 'forest', 'desert', 'mountains', 'snow']).toContain(anchor.biome);
    }
  });

  it.each(waterCases)('distinguishes %s surface height from sampled ground height', (kind, recipe) => {
    const anchor = createWorldEnvironmentEvidence(plan(recipe, [['wet', [0, 0]]])).anchors[0];
    expect(anchor.water).toMatchObject({ kind, surfaceHeight: kind === 'sea' ? 0 : 10 });
    expect(anchor.water!.surfaceHeight).toBeGreaterThan(anchor.groundHeight);
    expect(anchor.water!.depthMeters).toBeCloseTo(anchor.water!.surfaceHeight - anchor.groundHeight, 3);
  });

  it('returns an empty bounded collection when the plan has no semantic anchors', () => {
    const empty = { ...plan(baseRecipe(), []), featureGraph: undefined, mobilityPlan: undefined };
    expect(createWorldEnvironmentEvidence(empty)).toEqual({ version: 1, anchors: [] });
  });
});
