import { describe, expect, it } from 'vitest';
import { terrainVertexColor } from '../src/client/terrainAppearance';
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
});
