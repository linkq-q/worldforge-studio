import { describe, expect, it } from 'vitest';
import { terrainSemanticSurfaceWeight, terrainVertexColor } from '../src/client/terrainAppearance';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import * as THREE from 'three';
import { applyGrassGroundColor, terrainRecipeTextureColor, createTerrainColorSampler } from '../src/client/terrainAppearance';
import {compileRuntimeGrassStyle, compileRuntimeTerrainMaterialStyle, DEFAULT_RUNTIME_GRASS_STYLE} from '../src/shared/renderPlan';

describe('terrain semantic appearance', () => {
  it('uses planned grass ground as the base instead of weakening it with roots and floor', () => {
    const style = compileRuntimeGrassStyle({version:1,baseSchemeId:'render-indoor-neutral',modules:[{id:'runtime.grass-style',params:{groundColor:'#819f62',rootColor:'#507c42'}}]});
    const base = new THREE.Color('#3b4741');
    expect(applyGrassGroundColor(base.clone(), style, 0.5, 1).getHexString()).toBe('819f62');
    expect(applyGrassGroundColor(base.clone(), style, 0, 1).getHexString()).toBe('3b4741');
    expect(applyGrassGroundColor(base.clone(), style, 1, 0).getHexString()).toBe('3b4741');
    const legacy = {...DEFAULT_RUNTIME_GRASS_STYLE,groundColor:'#819f62',rootColor:'#507c42'};
    expect(applyGrassGroundColor(base.clone(), legacy, 0.5, 1).getHexString()).toBe('4e6547');
  });
  it('uses planned stone as source color with a neutral recipe texture instead of multiplying old paving', () => {
    const map = applyMapOperations(createEmptyMap(), [{type:'terrain.surface',surface:'paving',material:'garden-stone',region:{kind:'circle',x:0,z:0,radius:12},zoneId:'stone'}]);
    map.box.colors.floor = '#3b4741';
    const style = compileRuntimeTerrainMaterialStyle({version:1,baseSchemeId:'render-indoor-neutral',modules:[{id:'runtime.terrain-materials',params:{gardenStoneColor:'#c1bcaa'}}]});
    const source = new THREE.Color().fromArray(createTerrainColorSampler(map, undefined, true, undefined, style)(0,2,0,2));
    const texture = new THREE.Color('#ffffff').lerp(new THREE.Color(terrainRecipeTextureColor('garden-stone',style)!),0.84);
    expect(source.clone().multiply(texture).getHexString()).toBe('c1bcaa');
    const legacySource = new THREE.Color().fromArray(createTerrainColorSampler(map)(0,2,0,2));
    const legacyTexture = new THREE.Color('#ffffff').lerp(new THREE.Color('#c1bcaa'),0.84);
    expect(legacySource.multiply(legacyTexture).getHexString()).toBe('847d6b');
    expect(terrainRecipeTextureColor('garden-stone',{...style,explicitRoadColors:undefined})).toBe('#c1bcaa');
    expect(createTerrainColorSampler(map)(0,2,0,2)).not.toEqual(source.toArray());
  });
  it('does not shade derived seabed top surfaces as vertical dark skirts', () => {
    const map = createEmptyMap('submerged coast');
    const side = terrainVertexColor(map, 0, -2, 0);
    const seabed = terrainVertexColor(map, 0, -2, 0, undefined, -2);
    expect(seabed.reduce((a, b) => a + b, 0)).toBeGreaterThan(side.reduce((a, b) => a + b, 0));
    expect(terrainVertexColor(map, 0, -2, 0)).toEqual(side);
  });
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

  it('uses sampled grass and forest semantics in the terrain vertex color', () => {
    const map = createEmptyMap('biome appearance');
    const baseline = terrainVertexColor(map, 0, 2, 0, undefined, 2, true, () => 0);
    const grass = terrainVertexColor(map, 0, 2, 0, undefined, 2, true, (_x, _z, tags) => Number(tags.includes('grass')));
    const forest = terrainVertexColor(map, 0, 2, 0, undefined, 2, true, (_x, _z, tags) => Number(tags.includes('forest')));

    expect(grass[1]).toBeGreaterThan(baseline[1]);
    expect(grass[1] - grass[0]).toBeGreaterThan(baseline[1] - baseline[0]);
    expect(forest[1]).toBeGreaterThan(forest[0]);
    expect(forest.reduce((sum, value) => sum + value, 0)).toBeLessThan(grass.reduce((sum, value) => sum + value, 0));
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
