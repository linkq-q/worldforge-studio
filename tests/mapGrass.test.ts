import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import { createEmptyMap, normalizeMap } from '../src/shared/map';
import { combinedGrassDensity, inferGrassPreset, normalizeGrassLayers, sampleGrassDensity } from '../src/shared/mapGrass';
import { applyMapOperations } from '../src/shared/mapOperations';
import { buildMapGrassField, deriveContactAwareGrassMap } from '../src/client/mapGrassRenderer';
import { isNormalDepthPrePassMesh } from '../src/client/renderPrePassPolicy';

describe('map grass layers', () => {
  it('keeps grass cards out of the normal/depth pre-pass', () => {
    const map = applyMapOperations(createEmptyMap('pre-pass grass', 'pre-pass-grass'), [
      { type: 'grass.layer.add', layer: { id: 'meadow' } },
      { type: 'grass.fill', layerId: 'meadow', density: 1 }
    ]);
    const field = buildMapGrassField(map)!;
    const grassMesh = field.group.children.find(
      (object): object is Mesh => (object as Mesh).isMesh === true
    );

    expect(grassMesh).toBeDefined();
    expect(isNormalDepthPrePassMesh(grassMesh!)).toBe(false);
    field.dispose();
  });

  it('maps distinct natural and fantasy forms to bounded grass presets', () => {
    expect([
      inferGrassPreset('ordinary meadow'),
      inferGrassPreset('dune desert grass'),
      inferGrassPreset('shore reeds'),
      inferGrassPreset('wheat crop field'),
      inferGrassPreset('enchanted glowing grass'),
      inferGrassPreset('高山苔藓')
    ]).toEqual(['meadow', 'sand', 'wetland', 'farm', 'magic', 'alpine-moss']);
  });

  it('derives contact clearance without mutating authored grass densities', () => {
    const map = createEmptyMap('contact grass', 'map-contact-grass');
    const layer = {
      id: 'meadow', name: 'Meadow', visible: true, seed: 1,
      preset: 'meadow' as const, height: 1,
      resolutionX: map.terrain.resolutionX,
      resolutionZ: map.terrain.resolutionZ,
      densities: Array(map.terrain.resolutionX * map.terrain.resolutionZ).fill(1),
      mix: { short: 0.8, tall: 0.18, flowers: 0.02 }
    };
    map.grassLayers = [layer];
    map.waterBodies = [{
      id: 'pond', name: 'Pond', type: 'lake', level: 0.2, depth: 1.5, width: 1,
      points: [[-2, -2], [2, -2], [2, 2], [-2, 2]]
    }];
    const before = [...layer.densities];

    const derived = deriveContactAwareGrassMap(map);
    const center = Math.floor(layer.resolutionZ / 2) * layer.resolutionX + Math.floor(layer.resolutionX / 2);

    expect(derived.grassLayers[0].densities[center]).toBe(0);
    expect(map.grassLayers[0].densities).toEqual(before);
  });

  it('hides authored grass inside semantic sand or paving without changing saved densities', () => {
    const map = createEmptyMap('desert grass mask', 'map-desert-grass-mask');
    const layer = {
      id: 'meadow', name: 'Meadow', visible: true, seed: 1,
      preset: 'meadow' as const, height: 1,
      resolutionX: map.terrain.resolutionX,
      resolutionZ: map.terrain.resolutionZ,
      densities: Array(map.terrain.resolutionX * map.terrain.resolutionZ).fill(1),
      mix: { short: 0.8, tall: 0.18, flowers: 0.02 }
    };
    map.grassLayers = [layer];
    const desert = applyMapOperations(map, [{
      type: 'terrain.surface', surface: 'sand',
      region: { kind: 'circle', x: 0, z: 0, radius: 12 }, zoneId: 'sand-center'
    }]);

    const derived = deriveContactAwareGrassMap(desert);
    expect(combinedGrassDensity(derived, 0, 0)).toBe(0);
    expect(combinedGrassDensity(desert, 0, 0)).toBe(1);

    const paved = applyMapOperations(map, [{
      type: 'terrain.surface', surface: 'paving',
      region: { kind: 'circle', x: 0, z: 0, radius: 12 }, zoneId: 'paved-center'
    }]);
    expect(combinedGrassDensity(deriveContactAwareGrassMap(paved), 0, 0)).toBe(0);
    expect(combinedGrassDensity(paved, 0, 0)).toBe(1);
  });

  it('normalizes multiple density layers and variant ratios at terrain resolution', () => {
    const map = normalizeMap({
      grassLayers: [
        {
          id: 'meadow',
          visible: true,
          seed: 1,
          name: '林间草地',
          preset: 'meadow',
          height: 1,
          resolutionX: 2,
          resolutionZ: 2,
          densities: [0, 1, 1, 0],
          mix: { short: 7, tall: 2, flowers: 1 }
        },
        {
          id: 'shore',
          visible: true,
          seed: 2,
          name: '水边草地',
          preset: 'wetland',
          height: 1.65,
          resolutionX: 2,
          resolutionZ: 2,
          densities: [0.4, 0.4, 0.4, 0.4],
          mix: { short: 1, tall: 3, flowers: 1 }
        }
      ]
    });

    expect(map.grassLayers).toHaveLength(2);
    expect(map.grassLayers[0].resolutionX).toBe(map.terrain.resolutionX);
    expect(map.grassLayers[0].mix).toEqual({ short: 0.7, tall: 0.2, flowers: 0.1 });
    expect(map.grassLayers[0]).toMatchObject({ preset: 'meadow', height: 1 });
    expect(map.grassLayers[1]).toMatchObject({ preset: 'wetland', height: 1.65 });
    expect(sampleGrassDensity(map.grassLayers[1], map, 0, 0)).toBeCloseTo(0.4, 3);
    expect(combinedGrassDensity(map, 0, 0)).toBeGreaterThan(0.4);
  });

  it('upgrades legacy grass layers to the classic meadow without changing density data', () => {
    const [legacy] = normalizeGrassLayers([{
      id: 'legacy', name: 'Legacy grass', visible: true, seed: 1,
      resolutionX: 2, resolutionZ: 2, densities: [0, 1, 1, 0],
      mix: { short: 0.7, tall: 0.2, flowers: 0.1 }
    }], 2, 2);

    expect(legacy).toMatchObject({ preset: 'meadow', height: 1 });
    expect(legacy.densities).toEqual([0, 1, 1, 0]);
  });

  it('keeps terrain-specific grass on its intended surface while ordinary grass retreats', () => {
    const base = createEmptyMap('terrain grass', 'terrain-grass');
    const meadow = {
      id: 'meadow', name: 'Meadow', visible: true, seed: 1, preset: 'meadow' as const, height: 1,
      resolutionX: base.terrain.resolutionX, resolutionZ: base.terrain.resolutionZ,
      densities: Array(base.terrain.resolutionX * base.terrain.resolutionZ).fill(1),
      mix: { short: 0.8, tall: 0.18, flowers: 0.02 }
    };
    base.grassLayers = [
      meadow,
      { ...meadow, id: 'sand-grass', preset: 'sand' as const },
      { ...meadow, id: 'moss', preset: 'alpine-moss' as const }
    ];
    const sand = applyMapOperations(base, [{
      type: 'terrain.surface', surface: 'sand',
      region: { kind: 'circle', x: 0, z: 0, radius: 12 }, zoneId: 'sand-center'
    }]);
    sand.visualSemantics.zones.push({ id: 'rock-edge', tags: ['rocky'], center: [16, 0], radius: 4, intensity: 1 });

    const derived = deriveContactAwareGrassMap(sand);
    const byId = (id: string) => derived.grassLayers.find((layer) => layer.id === id)!;

    expect(sampleGrassDensity(byId('meadow'), derived, 0, 0)).toBe(0);
    expect(sampleGrassDensity(byId('sand-grass'), derived, 0, 0)).toBeGreaterThan(0.8);
    expect(sampleGrassDensity(byId('moss'), derived, 16, 0)).toBeGreaterThan(0.1);
    expect(sampleGrassDensity(byId('moss'), derived, 16, 0)).toBeLessThan(0.35);
  });

  it('applies layer, fill, brush, update and remove operations atomically', () => {
    const map = createEmptyMap('grass operations', 'grass-ops');
    const filled = applyMapOperations(map, [
      {
        type: 'grass.layer.add',
        layer: { id: 'meadow', name: '草甸', mix: { short: 0.6, tall: 0.3, flowers: 0.1 } }
      },
      { type: 'grass.fill', layerId: 'meadow', density: 0.25 },
      { type: 'grass.brush', layerId: 'meadow', mode: 'add', point: [0, 0], size: 4, strength: 0.7 },
      { type: 'grass.layer.update', layerId: 'meadow', patch: { name: '花草甸', visible: false } }
    ]);

    expect(filled.grassLayers).toHaveLength(1);
    expect(filled.grassLayers[0].name).toBe('花草甸');
    expect(filled.grassLayers[0].visible).toBe(false);
    expect(filled.grassLayers[0].densities.some((density) => density > 0.25)).toBe(true);
    expect(map.grassLayers).toEqual([]);

    const removed = applyMapOperations(filled, [{ type: 'grass.layer.remove', layerId: 'meadow' }]);
    expect(removed.grassLayers).toEqual([]);
  });

  it('generates deterministic soft regions, fades on slopes, and does not exclude underwater terrain', () => {
    const base = createEmptyMap('grass generation', 'grass-generation');
    base.terrain.heights.fill(-1.5);
    const withLayer = applyMapOperations(base, [{ type: 'grass.layer.add', layer: { id: 'mixed', seed: 77 } }]);
    const operation = {
      type: 'grass.generate' as const,
      layerId: 'mixed',
      region: { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 12 },
      density: 0.8,
      variation: 0.2,
      softness: 0.25,
      seed: 123
    };
    const first = applyMapOperations(withLayer, [operation]);
    const second = applyMapOperations(withLayer, [operation]);

    expect(first.grassLayers[0].densities).toEqual(second.grassLayers[0].densities);
    expect(sampleGrassDensity(first.grassLayers[0], first, 0, 0)).toBeGreaterThan(0.5);
    expect(sampleGrassDensity(first.grassLayers[0], first, 20, 20)).toBe(0);

    const steep = createEmptyMap('steep grass', 'steep-grass');
    const middle = Math.floor(steep.terrain.resolutionX / 2);
    for (let z = 0; z < steep.terrain.resolutionZ; z += 1) {
      for (let x = middle; x < steep.terrain.resolutionX; x += 1) {
        steep.terrain.heights[z * steep.terrain.resolutionX + x] = 10;
      }
    }
    const steepLayer = applyMapOperations(steep, [
      { type: 'grass.layer.add', layer: { id: 'slope' } },
      { type: 'grass.generate', layerId: 'slope', region: { kind: 'circle', center: [0, 0], radius: 20 }, density: 1, variation: 0 }
    ]);
    const centerIndex = Math.floor(steepLayer.terrain.resolutionZ / 2) * steepLayer.terrain.resolutionX + middle;
    expect(steepLayer.grassLayers[0].densities[centerIndex]).toBe(0);
  });

  it('smooths a hard density boundary without changing unrelated cells', () => {
    const map = applyMapOperations(createEmptyMap(), [
      { type: 'grass.layer.add', layer: { id: 'smooth' } },
      { type: 'grass.brush', layerId: 'smooth', mode: 'add', point: [0, 0], size: 1, strength: 1 }
    ]);
    const beforeFar = sampleGrassDensity(map.grassLayers[0], map, 15, 15);
    const smoothed = applyMapOperations(map, [
      { type: 'grass.brush', layerId: 'smooth', mode: 'smooth', point: [0, 0], size: 3, strength: 1 }
    ]);

    expect(sampleGrassDensity(smoothed.grassLayers[0], smoothed, 0, 0)).toBeLessThan(sampleGrassDensity(map.grassLayers[0], map, 0, 0));
    expect(sampleGrassDensity(smoothed.grassLayers[0], smoothed, 15, 15)).toBe(beforeFar);
  });
});
