import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { compileAtmosphereFx } from '../src/shared/atmosphereFx';
import {
  compileRuntimeColorGrade,
  compileRuntimeLightRig,
  compileRuntimeStyle,
  normalizeRenderPlan
} from '../src/shared/renderPlan';

const GOLDENS = [
  { mode: 'bright-cartoon', time: 'noon', temperature: 'warm', shadowFloor: 0.42, contrast: 1.08 },
  { mode: 'colored-shadow', time: 'evening', temperature: 'warm', shadowFloor: 0.34, contrast: 1.12 },
  { mode: 'dramatic', time: 'morning', temperature: 'cool', shadowFloor: 0.24, contrast: 1.18 }
] as const;

describe('visual direction goldens', () => {
  for (const golden of GOLDENS) {
    it(`${golden.mode} keeps readable shadows and one coordinated direction`, () => {
      const plan = normalizeRenderPlan({
        version: 2,
        baseSchemeId: 'render-runtime-cel-day',
        modules: [{ id: 'runtime.surface-style', params: { mode: 'cel' } }],
        visualDirection: {
          contrastMode: golden.mode,
          timeOfDay: golden.time,
          temperature: golden.temperature
        }
      });
      const style = compileRuntimeStyle(plan);
      const grade = compileRuntimeColorGrade(plan);
      const light = compileRuntimeLightRig(plan);
      expect(style.cartoon.shadowFloor).toBe(golden.shadowFloor);
      expect(grade.contrast).toBe(golden.contrast);
      expect(grade.shadowLift).toBeGreaterThan(0);
      expect(light.strength).toBeGreaterThanOrEqual(1);
    });
  }

  it('the forest pond golden produces regional pollen and shoreline vapor, not dust', () => {
    const map = createEmptyMap('Animal-crossing forest', 'golden-forest-pond', [96, 16, 96]);
    map.visualSemantics.zones = [
      { id: 'forest', tags: ['forest', 'grass'], center: [-14, 0], radius: 30, intensity: 1 },
      { id: 'pond', tags: ['water', 'lowland'], center: [18, 8], radius: 11, intensity: 0.75 },
      { id: 'camp', tags: ['settlement', 'grass'], center: [10, -18], radius: 9, intensity: 0.9 }
    ];
    const state = compileAtmosphereFx(map, normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-runtime-cel-day',
      modules: [],
      visualDirection: { contrastMode: 'bright-cartoon', timeOfDay: 'morning', temperature: 'warm' }
    }));
    expect(state.channels.pollen).toBeGreaterThan(0);
    expect(state.channels.vapor).toBeGreaterThan(0);
    expect(state.channels.dust).toBe(0);
    expect(state.zones.pollen.map((zone) => zone.id)).toEqual(['forest', 'camp']);
    expect(state.zones.vapor.map((zone) => zone.id)).toEqual(['pond']);
  });
});
