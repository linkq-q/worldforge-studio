import { describe, expect, it } from 'vitest';
import {
  createEmptyMap,
  mapOrphanRoadZones,
  mapRoadGuides,
  mapRoadZoneForGuide,
  type EditableMap
} from '../src/shared/map';
import { applyMapOperations, type MapOperation } from '../src/shared/mapOperations';

function roadSetupOperations(guideId: string, zoneId: string, tags: string[] = ['farm']): MapOperation[] {
  const points: Array<[number, number]> = [[-10, -4], [0, 0], [12, 5]];
  return [
    {
      type: 'guide.upsert',
      guide: {
        id: guideId,
        name: 'Farm road',
        points,
        curve: 'polyline',
        closed: false,
        width: 3,
        tags
      }
    },
    {
      type: 'terrain.surface',
      surface: 'paving',
      region: { kind: 'path', points, width: 3 },
      intensity: 1,
      zoneId
    }
  ];
}

function mapWithRoad(guideId: string, zoneId: string, tags?: string[]): EditableMap {
  return applyMapOperations(createEmptyMap('roads', 'map-roads'), roadSetupOperations(guideId, zoneId, tags));
}

describe('road guide and surface zone ownership', () => {
  it('removes the baked road surface when its guide is removed', () => {
    const map = mapWithRoad('farm-road', 'code:route:farm-road');
    expect(map.visualSemantics.zones).toHaveLength(1);

    const result = applyMapOperations(map, [{ type: 'guide.remove', guideId: 'farm-road' }]);

    expect(result.guides).toHaveLength(0);
    expect(result.visualSemantics.zones).toHaveLength(0);
  });

  it('removes a surface zone whose id does not follow the route conventions but matches the guide geometry', () => {
    const map = mapWithRoad('field-lane', 'scene-zone-9');
    expect(mapRoadZoneForGuide(map, 'field-lane')?.id).toBe('scene-zone-9');

    const result = applyMapOperations(map, [{ type: 'guide.remove', guideId: 'field-lane' }]);

    expect(result.visualSemantics.zones).toHaveLength(0);
  });

  it('keeps unrelated surface zones when a guide is removed', () => {
    const map = applyMapOperations(mapWithRoad('farm-road', 'code:route:farm-road'), [{
      type: 'terrain.surface',
      surface: 'sand',
      region: { kind: 'circle', x: 20, z: 20, radius: 6 },
      intensity: 1,
      zoneId: 'beach'
    }]);

    const result = applyMapOperations(map, [{ type: 'guide.remove', guideId: 'farm-road' }]);

    expect(result.visualSemantics.zones.map((zone) => zone.id)).toEqual(['beach']);
  });

  it('removes a surface zone directly and rejects unknown zone ids', () => {
    const map = mapWithRoad('farm-road', 'code:route:farm-road');

    const result = applyMapOperations(map, [{ type: 'terrain.surface.remove', zoneId: 'code:route:farm-road' }]);

    expect(result.visualSemantics.zones).toHaveLength(0);
    expect(result.guides).toHaveLength(1);
    expect(() => applyMapOperations(result, [
      { type: 'terrain.surface.remove', zoneId: 'code:route:farm-road' }
    ])).toThrow('surface_zone_not_found');
  });
});

describe('road classification for manual editing', () => {
  it('treats untagged surfaced guides as roads', () => {
    const map = mapWithRoad('farm-road', 'scene-program:farm-road', ['farm']);

    expect(mapRoadGuides(map).map((guide) => guide.id)).toEqual(['farm-road']);
  });

  it('excludes unsurfaced non-road guides but keeps route-tagged ones', () => {
    const map = applyMapOperations(createEmptyMap('roads', 'map-roads'), [
      {
        type: 'guide.upsert',
        guide: {
          id: 'fence-line',
          name: 'Fence',
          points: [[0, 0], [5, 0]],
          curve: 'polyline',
          closed: false,
          width: 0.6,
          tags: ['fence']
        }
      },
      {
        type: 'guide.upsert',
        guide: {
          id: 'trail',
          name: 'Trail',
          points: [[0, 4], [5, 4]],
          curve: 'polyline',
          closed: false,
          width: 1.2,
          tags: ['route', 'circulation']
        }
      }
    ]);

    expect(mapRoadGuides(map).map((guide) => guide.id)).toEqual(['trail']);
  });

  it('reports path surface zones that have no guide as orphan roads', () => {
    const map = applyMapOperations(createEmptyMap('roads', 'map-roads'), [{
      type: 'terrain.surface',
      surface: 'paving',
      region: { kind: 'path', points: [[-6, 0], [6, 0]], width: 2 },
      intensity: 1,
      zoneId: 'code:stray-strip'
    }]);

    expect(mapRoadGuides(map)).toHaveLength(0);
    expect(mapOrphanRoadZones(map).map((zone) => zone.id)).toEqual(['code:stray-strip']);
  });

  it('does not report zones matched to a guide as orphans', () => {
    const map = mapWithRoad('farm-road', 'custom-zone-id', ['farm']);

    expect(mapOrphanRoadZones(map)).toHaveLength(0);
  });
});
