import { describe, expect, it } from 'vitest';
import { terrainSemanticSurfaceWeight, terrainVertexColor } from '../src/client/terrainAppearance';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';

describe('terrain semantic appearance', () => {
  it('renders a sand surface as sand instead of the green floor palette', () => {
    const baseline = terrainVertexColor(createEmptyMap('green baseline'), 0, 0, 0);
    const map = applyMapOperations(createEmptyMap('sand appearance'), [{
      type: 'terrain.surface',
      surface: 'sand',
      region: { kind: 'circle', x: 0, z: 0, radius: 12 },
      zoneId: 'sand-center'
    }]);

    const [red, green, blue] = terrainVertexColor(map, 0, 0, 0);
    expect(red).toBeGreaterThan(baseline[0] + 0.4);
    expect(green).toBeGreaterThan(baseline[1] + 0.25);
    expect(red - blue).toBeGreaterThan(baseline[0] - baseline[2] + 0.35);
  });

  it('keeps path and polygon surface semantics inside their real shapes', () => {
    const map = applyMapOperations(createEmptyMap('shaped surfaces'), [
      {
        type: 'terrain.surface',
        surface: 'sand',
        region: { kind: 'path', points: [[-12, 0], [12, 0]], width: 2 },
        zoneId: 'sand-path'
      },
      {
        type: 'terrain.surface',
        surface: 'rock',
        region: { kind: 'polygon', points: [[-8, -8], [-2, -8], [-2, -2], [-8, -2]] },
        zoneId: 'rock-plot'
      }
    ]);

    expect(terrainSemanticSurfaceWeight(map, 0, 0, ['sand'])).toBeGreaterThan(0.9);
    expect(terrainSemanticSurfaceWeight(map, 0, 7, ['sand'])).toBe(0);
    expect(terrainSemanticSurfaceWeight(map, -5, -5, ['rocky'])).toBeGreaterThan(0.9);
    expect(terrainSemanticSurfaceWeight(map, 5, -5, ['rocky'])).toBe(0);
  });

  it('keeps enough semantic zones for a planned road or farm network', () => {
    const operations = Array.from({ length: 30 }, (_, index) => ({
      type: 'terrain.surface' as const,
      surface: 'paving' as const,
      region: { kind: 'circle' as const, x: index % 10 - 5, z: Math.floor(index / 10) - 1, radius: 0.5 },
      zoneId: `network-${index}`
    }));
    const map = applyMapOperations(createEmptyMap('semantic network'), operations);
    expect(map.visualSemantics.zones).toHaveLength(30);
    expect(map.visualSemantics.zones[0].tags).toEqual(['paving', 'settlement']);
  });
});
