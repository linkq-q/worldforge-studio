import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { completeIndoorScenePlan, indoorAssetTargetCount } from '../src/shared/indoorScenePlanning';
import { enforcePromptSceneIntent, normalizeSceneCompositionPlan } from '../src/shared/sceneComposition';
import { fitSceneAssetVariantBudget } from '../src/shared/sceneCompositionAssets';

describe('indoor scene planning', () => {
  it('expands a sparse classroom inventory toward room-size variety with doors and windows', () => {
    const map = createEmptyMap('Classroom', 'classroom-inventory', [16, 3.2, 12], 'voxel', 'indoor', [16, 3.2, 12]);
    const plan = completeIndoorScenePlan(
      normalizeSceneCompositionPlan(planInput('classroom', [{
        id: 'chairs', label: 'Student chairs', role: 'student seating', tags: ['student-chair', 'furniture'],
        sizeClass: 'medium', desiredVariants: 1, priority: 0.8, generationBrief: 'one chair'
      }]), map),
      map,
      '80年代教室，课桌椅整齐排列',
      4,
      16
    );

    expect(indoorAssetTargetCount(map, 4, 16)).toBeGreaterThan(4);
    expect(plan.assetFamilies.length).toBe(indoorAssetTargetCount(map, 4, 16));
    expect(plan.assetFamilies.some((family) => family.tags.includes('door'))).toBe(true);
    expect(plan.assetFamilies.some((family) => family.tags.includes('window'))).toBe(true);
    expect(plan.assetFamilies.some((family) => family.tags.includes('blackboard'))).toBe(true);
    expect(plan.assetFamilies.some((family) => family.tags.includes('student-desk'))).toBe(true);
  });

  it('turns restaurant tables into repeated group anchors and attaches chairs to every group', () => {
    const map = createEmptyMap('Restaurant', 'restaurant-relations', [18, 3.2, 14], 'voxel', 'indoor', [18, 3.2, 14]);
    const prompt = '一间小餐厅';
    const completed = completeIndoorScenePlan(
      normalizeSceneCompositionPlan(planInput('restaurant', []), map),
      map,
      prompt,
      4,
      16
    );
    const plan = enforcePromptSceneIntent(completed, prompt, map);
    const table = plan.assetFamilies.find((family) => family.tags.includes('dining-table'))!;
    const chair = plan.assetFamilies.find((family) => family.tags.includes('dining-chair'))!;
    const tableLayer = plan.zones[0].layers.find((layer) => layer.familyId === table.id)!;
    const chairLayer = plan.zones[0].layers.find((layer) => layer.familyId === chair.id)!;

    expect(tableLayer.placement).toMatchObject({ mode: 'layout', pattern: 'grid', intent: 'functional-group' });
    expect(tableLayer.density).toBeGreaterThan(0.04);
    expect(chairLayer.placement).toMatchObject({ mode: 'attached', intent: 'social', targetFamilyId: table.id });
  });

  it('converges an overfull or underfilled asset budget locally instead of throwing', () => {
    const map = createEmptyMap('Room', 'room-budget', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const families = Array.from({ length: 8 }, (_, index) => ({
      id: `family-${index}`, label: `Family ${index}`, role: 'room object', tags: [`object-${index}`],
      sizeClass: 'medium', desiredVariants: 1, priority: index / 10, generationBrief: 'one object'
    }));
    const plan = normalizeSceneCompositionPlan(planInput('room', families), map);

    const fitted = fitSceneAssetVariantBudget(plan, 4, 4);

    expect(fitted.assetFamilies).toHaveLength(4);
    expect(fitted.assetFamilies.reduce((sum, family) => sum + family.desiredVariants, 0)).toBe(4);
    expect(fitted.zones[0].layers.every((layer) => fitted.assetFamilies.some((family) => family.id === layer.familyId))).toBe(true);
  });
});

function planInput(label: string, assetFamilies: unknown[]): unknown {
  return {
    version: 1,
    summary: label,
    globalBrief: {
      spatialTheme: label,
      visualHierarchy: 'functional room',
      assetArtDirection: 'stocky cartoon voxel proportions',
      focalZoneId: 'room',
      terrainBase: { preset: 'plain', seed: 17, amplitude: 0, roughness: 0 }
    },
    intentRequirements: [],
    zones: [{
      id: 'room', label, role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 1.1 },
      brief: { atmosphere: label, hierarchy: 'functional groups', openness: 0.45, transitionIntent: 'clear circulation' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: assetFamilies.map((family) => ({
        familyId: (family as { id: string }).id,
        density: 0.04,
        scaleRange: [1, 1],
        distribution: 'even',
        edgeFalloff: 0.1
      })),
      grassLayers: [],
      excludeZoneIds: []
    }],
    transitions: [],
    assetFamilies,
    grassFamilies: [],
    consultations: [],
    renderPromptSuggestions: []
  };
}
