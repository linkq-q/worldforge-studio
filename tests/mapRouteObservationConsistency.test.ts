import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { mapGuidePolyline } from '../src/shared/mapGuide';
import { observeMapDesign } from '../src/shared/mapDesignObservation';
import { visualZoneWeight } from '../src/shared/visualDirection';
import { deriveContactAwareGrassMap } from '../src/client/mapGrassRenderer';

describe('authored route geometry consistency', () => {
  it.each([false, true])('uses the actual curved guide for paving and natural-cover exclusion (closed=%s)', closed => {
    const map = createEmptyMap('curve', 'curve', [120, 24, 120]);
    const result = executeMapCodePlan(`function plan(api) {
      api.route({id:'bend',points:[[-40,-20],[0,35],[40,-20]],curve:'catmull-rom',closed:${closed},width:3,surface:'paving'});
    }`, map, [], { scope: 'scene', legacyApis: false, spatialPolicy: 'diagnose' });
    const draft = applyMapOperations(map, result.operations), guide = draft.guides.find(item => item.id === 'bend')!;
    const canonical = mapGuidePolyline(guide);
    const paving = draft.visualSemantics.zones.find(zone => zone.tags.includes('paving'))!;
    expect(paving.region).toMatchObject({ kind: 'path', points: canonical, width: 3 });
    const middle = canonical[Math.floor(canonical.length / 4)];
    expect(visualZoneWeight(paving, ...middle)).toBeGreaterThan(0.9);
    expect(observeMapDesign(draft, { kind: 'points', points: [middle], guideIds: ['bend'] }, 1).data.samples[0].guideDistance).toBe(0);
    const surface = result.operations.find(operation => operation.type === 'terrain.surface');
    expect(surface).toMatchObject({ clearNatural: true });
    const rawControlPaving = { ...paving, region: { kind: 'path' as const, points: guide.points, width: 3 } };
    // This is the old failure: the same location was on the guide but outside the painted/control-point corridor.
    if (!closed) expect(visualZoneWeight(rawControlPaving, ...middle)).toBeLessThan(0.1);
    draft.grassLayers = [{ id: 'grass', name: 'Grass', visible: true, seed: 1, preset: 'meadow', height: 1,
      resolutionX: 65, resolutionZ: 65, densities: Array(65 * 65).fill(1), mix: { short: 1, tall: 0, flowers: 0 } }];
    const renderedGrass = deriveContactAwareGrassMap(draft).grassLayers[0];
    const curvedOnlyCells = renderedGrass.densities.flatMap((density, index) => {
      const x = index % 65 * 120 / 64 - 60, z = Math.floor(index / 65) * 120 / 64 - 60;
      return visualZoneWeight(paving, x, z) > 0.9 && visualZoneWeight(rawControlPaving, x, z) < 0.01 ? [density] : [];
    });
    expect(curvedOnlyCells.length).toBeGreaterThan(0);
    expect(curvedOnlyCells.every(density => density === 0)).toBe(true);
    expect(draft.grassLayers[0].densities.every(density => density === 1)).toBe(true);
  });
});
