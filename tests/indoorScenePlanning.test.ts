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

  it('adds lived-in residential layers and explicit tabletop support relations', () => {
    const map = createEmptyMap('Small home', 'small-home', [12, 3.2, 9], 'voxel', 'indoor', [12, 3.2, 9]);
    const plan = completeIndoorScenePlan(
      normalizeSceneCompositionPlan(planInput('small apartment living room and kitchen', []), map),
      map,
      '漂亮的小户型客厅和开放式厨房',
      4,
      16
    );
    const familyByTag = (tag: string) => plan.assetFamilies.find((family) => family.tags.includes(tag))!;
    const layers = new Map(plan.zones[0].layers.map((layer) => [layer.familyId, layer]));

    expect(plan.assetFamilies).toHaveLength(16);
    expect(familyByTag('sofa')).toBeDefined();
    expect(familyByTag('refrigerator')).toBeDefined();
    expect(familyByTag('tabletop-decor')).toBeDefined();
    expect(layers.get(familyByTag('television').id)?.placement).toMatchObject({
      intent: 'supported', targetFamilyId: familyByTag('media-console').id, maxPerGroup: 1
    });
  });

  it('binds one complete computer station to each internet-cafe desk', () => {
    const map = createEmptyMap('Internet cafe', 'internet-cafe', [18, 3.4, 12], 'voxel', 'indoor', [18, 3.4, 12]);
    const plan = completeIndoorScenePlan(
      normalizeSceneCompositionPlan(planInput('internet cafe', []), map),
      map,
      '网吧，整齐的电脑桌和电脑',
      4,
      16
    );
    const desk = plan.assetFamilies.find((family) => family.tags.includes('gaming-desk'))!;
    const computer = plan.assetFamilies.find((family) => family.tags.includes('desktop-computer'))!;
    const layer = plan.zones[0].layers.find((item) => item.familyId === computer.id)!;

    expect(layer.placement).toMatchObject({
      mode: 'attached', intent: 'supported', targetFamilyId: desk.id, maxPerGroup: 1
    });
  });

  it('adds every model-authored indoor family to a zone layer even when it is outside the built-in demand tree', () => {
    const map = createEmptyMap('Cafe', 'cafe-layer-coverage', [20, 4, 12], 'voxel', 'indoor', [20, 4, 12]);
    const families = [{
      id: 'two-person-cafe-table', label: '双人咖啡桌', role: '多组双人桌的重复锚点',
      tags: ['table', 'cafe', 'two-person-table', 'furniture'], sizeClass: 'medium' as const,
      desiredVariants: 1, priority: 1, generationBrief: '一张可复用的双人咖啡桌'
    }, {
      id: 'cafe-chair', label: '咖啡馆椅', role: '每张双人桌配套的座椅',
      tags: ['chair', 'cafe', 'furniture'], sizeClass: 'medium' as const,
      desiredVariants: 1, priority: 1, generationBrief: '一把可复用的咖啡馆椅'
    }, {
      id: 'espresso-machine', label: '咖啡机', role: '吧台上的服务设备',
      tags: ['espresso', 'machine', 'cafe-service'], sizeClass: 'medium' as const,
      desiredVariants: 1, priority: 0.7, generationBrief: '一台咖啡机'
    }];
    const input = planInput('cafe', families) as {
      zones: Array<{ layers: unknown[] }>;
    };
    input.zones[0].layers = [];

    const completed = completeIndoorScenePlan(
      normalizeSceneCompositionPlan(input, map),
      map,
      '小型咖啡馆，多组双人桌椅整齐排列，吧台靠墙',
      3,
      3
    );
    const plan = enforcePromptSceneIntent(completed, '小型咖啡馆，多组双人桌椅整齐排列，吧台靠墙', map);
    const layers = new Map(plan.zones.flatMap((zone) => zone.layers).map((layer) => [layer.familyId, layer]));

    expect([...layers.keys()]).toEqual(expect.arrayContaining(families.map((family) => family.id)));
    expect(layers.get('two-person-cafe-table')?.placement).toMatchObject({ intent: 'functional-group', pattern: 'grid' });
    expect(layers.get('cafe-chair')?.placement).toMatchObject({
      intent: 'social', targetFamilyId: 'two-person-cafe-table', maxPerGroup: 2
    });
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
