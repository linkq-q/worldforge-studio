import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { compileAtmosphereFx } from '../src/shared/atmosphereFx';
import { normalizeRenderPlan } from '../src/shared/renderPlan';

describe('semantic atmosphere effects', () => {
  it('activates weak regional effects without inventing unrelated channels', () => {
    const map = createEmptyMap('effects');
    map.visualSemantics.zones = [
      { id: 'forest', tags: ['forest', 'grass'], center: [-8, 0], radius: 12, intensity: 1 },
      { id: 'pond', tags: ['water', 'lowland'], center: [8, 0], radius: 6, intensity: 0.7 }
    ];

    const state = compileAtmosphereFx(map);
    expect(state.channels.pollen).toBeGreaterThan(0);
    expect(state.channels.vapor).toBeGreaterThan(0);
    expect(state.channels.dust).toBe(0);
    expect(state.zones.pollen.map((zone) => zone.id)).toEqual(['forest']);
    expect(state.zones.vapor.map((zone) => zone.id)).toEqual(['pond']);
  });

  it('lets bounded render intent strengthen a semantic baseline', () => {
    const map = createEmptyMap('effects');
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [],
      visualDirection: {
        timeOfDay: 'noon',
        atmosphereFx: { masterStrength: 0.8, windStreaks: 0.25 }
      }
    });

    const state = compileAtmosphereFx(map, plan);
    expect(state.channels.windStreaks).toBeCloseTo(0.2);
  });

  it('uses the developer module as the explicit live override', () => {
    const map = createEmptyMap('effects');
    map.visualSemantics.zones = [
      { id: 'meadow', tags: ['grass'], center: [0, 0], radius: 8, intensity: 1 }
    ];
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.atmosphere-fx',
        params: { masterStrength: 1, semanticStrength: 0, pollen: 0.65 }
      }]
    });

    expect(compileAtmosphereFx(map, plan).channels.pollen).toBeCloseTo(0.65);
  });

  it('only enables regional flying sand after the map is confirmed', () => {
    const map = createEmptyMap('sand');
    map.visualSemantics.zones = [
      { id: 'dunes', tags: ['sand', 'dry'], center: [0, 0], radius: 12, intensity: 1 }
    ];
    expect(compileAtmosphereFx(map).channels.sand).toBe(0);
    map.confirmedAt = Date.now();
    const state = compileAtmosphereFx(map);
    expect(state.channels.sand).toBeGreaterThan(0);
    expect(state.zones.sand.map((zone) => zone.id)).toEqual(['dunes']);
  });
});
