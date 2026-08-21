import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { evaluateSettlementQuality } from '../src/shared/settlementQuality';
import { executeWorldCapability } from '../src/server/worldCapabilityExecutor';

const townInput = {
  id: 'town',
  region: [[-26, -24], [26, -24], [26, 24], [-26, 24]],
  direction: 0,
  blockWidth: 12,
  blockDepth: 10,
  roadWidth: 3,
  surface: 'paving'
};

describe('world capability executor', () => {
  it('executes tools through the existing Map Code compiler and preserves route relationships', () => {
    const base = createEmptyMap('Tool town', 'tool-town', [72, 12, 72]);
    const streets = executeWorldCapability('settlement.create-street-grid', townInput, base);
    const streetMap = applyMapOperations(base, streets.suggestion.operations);
    const routeId = streetMap.guides[0].id;
    const frontage = executeWorldCapability('settlement.place-street-frontage', {
      routeId,
      side: 'left',
      gap: 1,
      items: [
        { name: '商铺', dimensions: [7, 5, 5], role: 'structure' },
        { name: '民居', dimensions: [6, 5, 5], role: 'structure' }
      ]
    }, streetMap);
    const frontagePreview = applyMapOperations(streetMap, frontage.suggestion.operations);
    const roadside = executeWorldCapability('roadside.decorate-route', {
      routeId,
      name: '路灯',
      spacing: 8,
      offset: 2,
      side: 'both'
    }, streetMap);
    const preview = applyMapOperations(streetMap, roadside.suggestion.operations);

    expect(streets.observation.operationsByType['guide.upsert']).toBeGreaterThan(2);
    expect(frontagePreview.objects).toHaveLength(2);
    expect(frontagePreview.objects.every((object) => object.sourceGuideId === routeId)).toBe(true);
    expect(preview.objects.length).toBeGreaterThan(4);
    expect(preview.objects.every((object) => object.sourceGuideId === routeId)).toBe(true);
    expect(evaluateSettlementQuality(preview).metrics.unboundRoadsideCount).toBe(0);
  });

  it('rejects unknown tools, missing required fields and unlisted fields before code execution', () => {
    const map = createEmptyMap();

    expect(() => executeWorldCapability('unknown.tool', {}, map)).toThrow('unknown_world_capability');
    expect(() => executeWorldCapability('settlement.create-street-grid', { id: 'town' }, map))
      .toThrow('world_capability_missing_input:region');
    expect(() => executeWorldCapability('roadside.decorate-route', {
      routeId: 'route', spacing: 4, arbitraryCode: 'api.removeObject("x")'
    }, map)).toThrow('world_capability_unknown_input:arbitraryCode');
  });

  it('reports sparse settlement coverage and a freely scattered roadside lamp', () => {
    const base = createEmptyMap('Sparse town', 'sparse-town', [72, 12, 72]);
    const streets = executeWorldCapability('settlement.create-street-grid', townInput, base);
    const map = applyMapOperations(base, streets.suggestion.operations);
    const lamp = createMapObject('路灯');
    lamp.id = 'free-lamp';
    lamp.transform.position = [28, 0, 28];
    map.objects.push(lamp);

    const report = evaluateSettlementQuality(map);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'settlement.building-coverage-low' }),
      expect.objectContaining({ code: 'settlement.frontage-low' }),
      expect.objectContaining({ code: 'settlement.unassigned-open-space' }),
      expect.objectContaining({ code: 'roadside.route-unbound', objectIds: ['free-lamp'] })
    ]));
  });
});
