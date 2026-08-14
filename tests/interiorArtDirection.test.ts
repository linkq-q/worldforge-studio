import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import { applyMapOperations } from '../src/shared/mapOperations';
import { compileSceneComposition } from '../src/shared/sceneCompositionCompiler';
import type { SceneCompositionPlan } from '../src/shared/sceneComposition';

describe('interior art direction', () => {
  it('normalizes surface recipes and rugs into a deterministic bounded contract', () => {
    const direction = normalizeInteriorArtDirection({
      summary: 'warm geometric lounge',
      palette: ['#112233', '#ddeeff'],
      decorDensity: 9,
      surfaces: {
        floor: { recipe: 'wood.herringbone', scale: 0.01, rotation: 90, palette: ['#112233', '#ddeeff'] }
      } as never,
      rugs: [{
        id: 'seat-rug', shape: 'round', center: [3, -3], size: [2, 0.01], rotation: 90,
        pattern: 'woven', palette: ['#112233', '#ddeeff'], seed: 42
      }]
    }, 123);

    expect(direction).not.toBeNull();
    expect(direction!.decorDensity).toBe(0.9);
    expect(direction!.surfaces.floor).toMatchObject({
      recipe: 'wood.herringbone', scale: 0.08, rotation: 90, seed: 123
    });
    expect(direction!.surfaces.north.recipe).toBe('plaster.soft');
    expect(direction!.rugs[0]).toMatchObject({ center: [1, -1], size: [0.9, 0.12] });
    expect(normalizeInteriorArtDirection(direction, 999)).toEqual(direction);
  });

  it('persists the art direction through one atomic map operation', () => {
    const map = createEmptyMap('room', 'room-art', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const result = applyMapOperations(map, [{
      type: 'interior.art-direction.set',
      artDirection: {
        summary: 'quiet blue room', palette: ['#234567', '#abcdef'], decorDensity: 0.5,
        surfaces: { floor: { recipe: 'tile.ceramic' } } as never
      }
    }]);

    expect(result.interiorArtDirection?.summary).toBe('quiet blue room');
    expect(result.interiorArtDirection?.surfaces.floor.recipe).toBe('tile.ceramic');
    expect(normalizeMap(result).interiorArtDirection).toEqual(result.interiorArtDirection);
    expect(() => applyMapOperations(createEmptyMap(), [{
      type: 'interior.art-direction.set', artDirection: { summary: 'invalid outdoors' }
    }])).toThrow('interior_art_direction_requires_indoor_map');
  });

  it('covers all interior walls with wallpaper by default and gives glass rooms a skylight', () => {
    const direction = normalizeInteriorArtDirection({
      summary: 'bright glass plant room with continuous wallpaper',
      styleKeywords: ['conservatory'], palette: ['#dbe7da', '#70906c'], decorDensity: 0.6,
      surfaces: {
        north: { recipe: 'wallpaper.stripe', palette: ['#dbe7da', '#70906c'] },
        south: { recipe: 'plaster.soft' }, east: { recipe: 'paint.solid' }, west: { recipe: 'plaster.soft' }
      } as never
    }, 8)!;

    expect(['north', 'south', 'east', 'west'].map((wall) => direction.surfaces[wall as 'north'].recipe))
      .toEqual(['wallpaper.stripe', 'wallpaper.stripe', 'wallpaper.stripe', 'wallpaper.stripe']);
    expect(direction.surfaces.ceiling.recipe).toBe('glass.panel');
  });

  it('compiles the AI-authored direction into the same map transaction', () => {
    const map = createEmptyMap('room', 'room-compile-art', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const plan: SceneCompositionPlan = {
      version: 1,
      summary: 'room',
      globalBrief: {
        spatialTheme: 'room', visualHierarchy: 'one focus', assetArtDirection: 'rounded voxel', focalZoneId: 'main',
        terrainBase: { preset: 'plain', seed: map.seed, amplitude: 0, roughness: 0 },
        interiorArtDirection: normalizeInteriorArtDirection({
          summary: 'coherent room', palette: ['#334455', '#ddeeff'], decorDensity: 0.6,
          surfaces: { floor: { recipe: 'wood.plank' } } as never
        }, map.seed)!
      },
      intentRequirements: [],
      zones: [{
        id: 'main', label: 'main', role: 'primary', importance: 1,
        region: { kind: 'circle', center: [0, 0], radius: 1 },
        brief: { atmosphere: 'calm', hierarchy: 'focus', openness: 0.4, transitionIntent: '' },
        terrain: { elevation: 0, roughness: 0, flatness: 1 }, layers: [], grassLayers: [], excludeZoneIds: []
      }],
      transitions: [], assetFamilies: [], grassFamilies: [], consultations: [], renderPromptSuggestions: []
    };

    const compiled = compileSceneComposition(map, plan, []);
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'interior.art-direction.set' })
    ]));
  });
});
