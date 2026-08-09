import { describe, expect, it } from 'vitest';
import { inspectMapDerivedResults } from '../src/client/mapDerivedInspection';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { createGrassLayer, fillGrassLayerInPlace } from '../src/shared/mapGrass';

describe('map derived-results inspection', () => {
  it('reports semantic, shore and render-only grass retreat without mutating density', () => {
    const map = createEmptyMap('derived', 'map-derived');
    map.visualSemantics.zones = [{ id: 'pond', tags: ['water'], center: [0, 0], radius: 5, intensity: 1 }];
    map.waterBodies = [{
      id: 'pond', name: 'Pond', type: 'lake', level: 0.2, depth: 1.5, width: 1,
      points: [[-2, -2], [2, -2], [2, 2], [-2, 2]]
    }];
    const layer = createGrassLayer({ name: 'Meadow' }, map.terrain.resolutionX, map.terrain.resolutionZ, map.seed);
    map.grassLayers = [layer];
    fillGrassLayerInPlace(map, layer.id, 0.8);
    const object = createMapObject('Rock');
    object.transform.position = [4, 0, 0];
    map.objects = [object];
    const before = [...layer.densities];

    const result = inspectMapDerivedResults(map);

    expect(result).toMatchObject({ semanticZoneCount: 1, wetShoreCount: 1, localLightVisibleLimit: 8 });
    expect(result.grassRetreatedCells).toBeGreaterThan(0);
    expect(layer.densities).toEqual(before);
  });
});
