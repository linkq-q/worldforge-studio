import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap } from '../src/shared/map';
import {
  compileRenderPlan,
  compileRuntimeColorGrade,
  compileRuntimeLightRig,
  compileRuntimeMaterialThemes,
  compileRuntimeStyle,
  compileRuntimeWaterStyles,
  normalizeRenderPlan
} from '../src/shared/renderPlan';
import {
  compileVisualDirection,
  normalizeMapVisualSemantics,
  normalizeVisualDirection
} from '../src/shared/visualDirection';
import { completeMapVisualSemantics } from '../src/shared/mapVisualSemantics';
import { patchMapVisualZone } from '../src/shared/mapVisualSemantics';

describe('visual direction contract', () => {
  it('derives a stable water zone for structured water added during refine', () => {
    const map = createEmptyMap('water semantics', 'map-water-semantics');
    map.waterBodies = [{
      id: 'pond', name: 'Pond', type: 'lake', level: 0.2, depth: 1.5, width: 1,
      points: [[-3, -2], [3, -2], [3, 2], [-3, 2]]
    }];

    const first = completeMapVisualSemantics(map);
    const second = completeMapVisualSemantics({ ...map, visualSemantics: first });

    expect(first.zones).toEqual([expect.objectContaining({
      id: 'structured-water:pond',
      tags: ['water', 'lowland'],
      center: [0, 0]
    })]);
    expect(second).toEqual(first);
  });

  it('keeps legacy render plans compatible', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: []
    });

    expect(plan.visualDirection).toBeUndefined();
  });

  it('normalizes AI-facing semantic values before they reach render code', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [],
      visualDirection: {
        version: 99,
        contrastMode: 'dramatic',
        timeOfDay: 'evening',
        temperature: 'warm',
        palette: { sky: '#ABCDEF', fog: 'invalid' },
        atmosphereFx: { masterStrength: 4, pollen: -1, sunShafts: 0.7 }
      }
    }, undefined, undefined, 'ai');

    expect(plan.visualDirection).toMatchObject({
      version: 1,
      contrastMode: 'dramatic',
      timeOfDay: 'evening',
      palette: { sky: '#abcdef', fog: '#a9c8ce' },
      atmosphereFx: { masterStrength: 1, pollen: 0 }
    });
    expect(plan.visualDirection?.atmosphereFx).not.toHaveProperty('sunShafts');
  });

  it('compiles distinct bounded contrast methods', () => {
    const bright = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'bright-cartoon' }));
    const colored = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'colored-shadow' }));
    const dramatic = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'dramatic' }));

    expect(bright.surfaceShadowFloor).toBeGreaterThan(colored.surfaceShadowFloor);
    expect(colored.surfaceShadowFloor).toBeGreaterThan(dramatic.surfaceShadowFloor);
    expect(dramatic.lightRig.recipe).toBe('backlit');
  });

  it('coordinates environment, water, light and tagged materials while explicit values win', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-runtime-cel-day',
      visualDirection: {
        contrastMode: 'bright-cartoon',
        palette: {
          sky: '#88bbdd', keyLight: '#ffe0aa', fillLight: '#bbddff', shadow: '#405070',
          fog: '#99bbcc', waterBias: '#4488aa', accent: '#77bb55'
        }
      },
      modules: [
        { id: 'runtime.surface-style', params: { mode: 'cel' } },
        { id: 'lighting.sun', params: { color: '#ffffff' } },
        { id: 'runtime.water-style', params: { shallowColor: '#abcdef' } },
        {
          id: 'runtime.material-theme',
          scope: { target: 'material-tag', tag: 'foliage' },
          params: { recipe: 'natural' }
        }
      ]
    });

    expect(compileRenderPlan(plan)).toMatchObject({
      background: '#88bbdd',
      hemisphereSkyColor: '#bbddff',
      sunColor: '#ffffff'
    });
    expect(compileRuntimeStyle(plan).cartoon.shadowFloor).toBe(0.42);
    expect(compileRuntimeColorGrade(plan)).toMatchObject({ contrast: 1.08, shadowLift: 0.07 });
    expect(compileRuntimeLightRig(plan)).toMatchObject({ recipe: 'hard-day', shadowSoftness: 0.42 });
    expect(compileRuntimeWaterStyles(plan)[0]).toMatchObject({
      color: '#4488aa',
      shallowColor: '#abcdef'
    });
    expect(compileRuntimeMaterialThemes(plan)[0]).toMatchObject({
      color: '#77bb55',
      strength: 0.1
    });
  });
});

describe('map visual semantics contract', () => {
  it('preserves user-locked fields while AI-derived fields continue to update', () => {
    const semantics = normalizeMapVisualSemantics({
      zones: [{
        id: 'grove', tags: ['forest'], center: [0, 0], radius: 8, intensity: 1,
        locks: { center: true }
      }]
    });

    const patched = normalizeMapVisualSemantics(patchMapVisualZone(semantics, 'grove', {
      center: [12, 4], radius: 18, tags: ['forest', 'grass']
    }));

    expect(patched.zones[0]).toMatchObject({
      center: [0, 0], radius: 18, tags: ['forest', 'grass'], locks: { center: true }
    });
  });

  it('adds a deterministic default wind field to old and new maps', () => {
    expect(createEmptyMap('wind').visualSemantics.wind.speed).toBeGreaterThan(0);
    expect(normalizeMap({ id: 'legacy-map' }).visualSemantics.zones).toEqual([]);
  });

  it('normalizes spatial zones and shared wind without inventing effect recipes', () => {
    const semantics = normalizeMapVisualSemantics({
      zones: [
        { id: 'pond', tags: ['water', 'lowland', 'unknown'], center: [12, -4], radius: 0, intensity: 2 },
        { id: '', tags: ['forest'], center: [0, 0], radius: 12 }
      ],
      wind: { direction: [3, 4], speed: 9, gustStrength: -1, gustFrequency: 0 }
    });

    expect(semantics.zones).toEqual([{
      id: 'pond',
      tags: ['water', 'lowland'],
      center: [12, -4],
      radius: 0.5,
      intensity: 1
    }]);
    expect(semantics.wind.direction[0]).toBeCloseTo(0.6);
    expect(semantics.wind.direction[1]).toBeCloseTo(0.8);
    expect(semantics.wind).toMatchObject({ speed: 2, gustStrength: 0, gustFrequency: 0.01 });
  });
});
