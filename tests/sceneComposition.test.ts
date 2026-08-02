import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  isCompositionEmptyMap,
  normalizeSceneCompositionPlan,
  sceneZoneWorldRegion
} from '../src/shared/sceneComposition';
import {
  applySceneAdvice,
  normalizeScenePlanAdvice,
  normalizeSceneReview
} from '../src/shared/sceneCompositionAdvice';
import { resolveSceneFamilies } from '../src/shared/sceneCompositionAssets';
import { compileSceneComposition } from '../src/shared/sceneCompositionCompiler';
import { applyMapOperations } from '../src/shared/mapOperations';
import { isNearWater } from '../src/shared/mapWater';
import { sampleGrassDensity } from '../src/shared/mapGrass';
import { ensureSceneCompositionOutcome } from '../src/shared/sceneCompositionOutcome';

describe('scene composition contract', () => {
  it('keeps creative roles free-form while validating references and bounded consultations', () => {
    const map = createEmptyMap('Forest', 'map-composition', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);

    expect(plan.assetFamilies[0].role).toBe('upper-canopy silhouette');
    expect(plan.consultations).toHaveLength(2);
    expect(plan.globalBrief.focalZoneId).toBe('camp');
    expect(isCompositionEmptyMap(map)).toBe(true);
  });

  it('resolves only assets from the map generation mode and reports semantic gaps', () => {
    const map = createEmptyMap('Forest', 'map-assets', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);
    const assets = [
      asset('tree-a', 'Pine', ['tree', 'conifer'], 'large', 'voxel-pro'),
      asset('tree-wrong-mode', 'Curve Pine', ['tree', 'conifer'], 'large', 'curve'),
      asset('shrub-a', 'Fern', ['fern', 'understory'], 'small', 'voxel-pro')
    ];

    const resolved = resolveSceneFamilies(plan, map, assets, 4);

    expect(resolved.families.find((item) => item.family.id === 'trees')?.assets.map((item) => item.id))
      .toEqual(['tree-a']);
    expect(resolved.gaps.map((gap) => gap.familyId)).toContain('cabin');
    expect(resolved.gaps).toHaveLength(2);
  });

  it('passes the medium Animal-Crossing-like forest golden composition deterministically', () => {
    const map = createEmptyMap('Forest', 'map-compile', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);
    const assets = [
      asset('tree-a', 'Pine', ['tree', 'conifer'], 'large', 'voxel-pro'),
      asset('tree-b', 'Birch', ['tree', 'deciduous'], 'large', 'voxel-pro'),
      asset('shrub-a', 'Fern', ['fern', 'understory'], 'small', 'voxel-pro'),
      asset('cabin-a', 'Cabin', ['cabin', 'structure'], 'large', 'voxel-pro')
    ];
    const resolved = resolveSceneFamilies(plan, map, assets, 0).families;

    const first = compileSceneComposition(map, plan, resolved);
    const second = compileSceneComposition(map, plan, resolved);

    expect(second).toEqual(first);
    expect(first.metrics.zoneCount).toBe(4);
    expect(first.metrics.zoneCoverage).toBeGreaterThan(0.55);
    expect(first.metrics.objectCount).toBeGreaterThan(20);
    expect(first.metrics.waterCount).toBe(1);
    expect(first.operations.some((operation) => operation.type === 'terrain.generate')).toBe(true);
    expect(first.operations.some((operation) => operation.type === 'water.add')).toBe(true);
    expect(first.operations.some((operation) => operation.type === 'grass.layer.add')).toBe(true);
    expect(first.operations.some((operation) => operation.type === 'grass.generate')).toBe(true);
    expect(first.operations.some((operation) => operation.type === 'reference.set')).toBe(false);
    const clearing = sceneZoneWorldRegion(plan.zones.find((zone) => zone.id === 'clearing')!, map);
    const objects = first.operations.filter((operation) => operation.type === 'object.add');
    expect(objects.every((operation) => {
      const [x, , z] = operation.object.transform?.position ?? [0, 0, 0];
      return Math.hypot(x - clearing.x, z - clearing.z) > clearing.r;
    })).toBe(true);
    const applied = applyMapOperations(map, first.operations);
    expect(applied.objects).toHaveLength(first.metrics.objectCount);
    expect(applied.waterBodies).toHaveLength(1);
    expect(applied.grassLayers).toHaveLength(1);
    expect(sampleGrassDensity(applied.grassLayers[0], applied, clearing.x, clearing.z)).toBeGreaterThan(0.45);
    expect(applied.renderPromptSuggestions).toEqual(['soft morning haze', 'warm low-contrast light']);
    expect(applied.objects.every((object) => !isNearWater(applied, object.transform.position[0], object.transform.position[2], 0.5)))
      .toBe(true);
  });

  it('accepts bounded specialist advice and keeps review patches inside the same plan contract', () => {
    const map = createEmptyMap('Forest', 'map-review', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);
    const advice = normalizeScenePlanAdvice({
      summary: 'Open the clearing and strengthen the focal cabin.',
      findings: [{ code: 'focus.weak', severity: 'warning', message: 'Cabin lacks emphasis.' }],
      patches: [
        { type: 'zone.update', zoneId: 'clearing', radius: 0.24, brief: { openness: 0.95 } },
        { type: 'layer.update', zoneId: 'camp', familyId: 'cabin', scaleRange: [1.15, 1.25] }
      ]
    }, plan, map);
    const revised = applySceneAdvice(plan, advice, map);
    const review = normalizeSceneReview({
      status: 'pass',
      summary: 'Composition is coherent.',
      findings: [],
      patches: [{ type: 'water.remove', zoneId: 'pond' }]
    }, revised, map);

    expect(revised.zones.find((zone) => zone.id === 'clearing')?.region.radius).toBe(0.24);
    expect(revised.zones.find((zone) => zone.id === 'camp')?.layers[0].scaleRange).toEqual([1.15, 1.25]);
    expect(review.patches).toEqual([]);
  });

  it('rejects advisor attempts to escape into asset generation or low-level operations', () => {
    const map = createEmptyMap('Forest', 'map-guardrail', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);

    expect(() => normalizeSceneReview({
      status: 'revise',
      summary: 'Generate another hero asset.',
      findings: [],
      patches: [],
      assetRequests: [{ prompt: 'new building' }]
    }, plan, map)).toThrow('forbidden_scene_advice_capability');
  });

  it('repairs missing physical outcomes without asking the model for coordinates', () => {
    const map = createEmptyMap('Outcome guard', 'map-outcome', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan({
      version: 1,
      summary: 'A cabin on deliberately shaped ground.',
      globalBrief: {
        spatialTheme: 'single focal clearing',
        visualHierarchy: 'the cabin is the focus',
        assetArtDirection: 'rounded voxel forms',
        focalZoneId: 'focus',
        terrainBase: { preset: 'plain', seed: 7, amplitude: 0, roughness: 0 }
      },
      intentRequirements: [
        { id: 'terrain', kind: 'terrain', description: 'visible ground shape', targetZoneId: 'focus', minCount: 1 },
        { id: 'cabin', kind: 'asset-family', description: 'the requested cabin', targetZoneId: 'focus', familyId: 'cabin', minCount: 1 }
      ],
      zones: [{
        id: 'focus', label: 'Focus', role: 'primary', importance: 1,
        region: { kind: 'circle', center: [0, 0], radius: 0.3 },
        brief: { atmosphere: 'quiet', hierarchy: 'single focus', openness: 0.8, transitionIntent: 'soft edge' },
        terrain: { elevation: 0, roughness: 0, flatness: 0 },
        layers: [], grassLayers: [], excludeZoneIds: []
      }],
      transitions: [],
      assetFamilies: [{
        id: 'cabin', label: 'Cabin', role: 'focal structure', tags: ['cabin', 'structure'],
        sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'one cabin'
      }],
      grassFamilies: [], consultations: [], renderPromptSuggestions: []
    }, map);
    const cabin = asset('cabin-a', 'Cabin', ['cabin', 'structure'], 'large', 'voxel-pro');
    const resolved = resolveSceneFamilies(plan, map, [cabin], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);
    expect(compiled.metrics.terrainChangedCells).toBe(0);
    expect(compiled.metrics.familyCounts.cabin ?? 0).toBe(0);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const applied = applyMapOperations(map, outcome.compiled.operations);
    expect(outcome.repairCount).toBe(2);
    expect(outcome.checks.every((check) => check.status === 'repaired')).toBe(true);
    expect(outcome.compiled.metrics.terrainChangedCells).toBeGreaterThan(8);
    expect(applied.objects.some((object) => object.assetId === cabin.id)).toBe(true);
  });

  it('restores a required structured pond if it disappears from compiled operations', () => {
    const map = createEmptyMap('Forest', 'map-water-outcome', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);
    const assets = [
      asset('tree-a', 'Pine', ['tree'], 'large', 'voxel-pro'),
      asset('shrub-a', 'Fern', ['fern'], 'small', 'voxel-pro'),
      asset('cabin-a', 'Cabin', ['cabin'], 'large', 'voxel-pro')
    ];
    const resolved = resolveSceneFamilies(plan, map, assets, 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);
    compiled.operations = compiled.operations.filter((operation) => operation.type !== 'water.add');
    compiled.metrics.waterCount = 0;

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const applied = applyMapOperations(map, outcome.compiled.operations);
    expect(applied.waterBodies.map((water) => water.id)).toContain('composition-water-pond');
    expect(outcome.checks.find((check) => check.requirementId === 'water-pond')?.status).toBe('repaired');
  });
});

function planInput(): unknown {
  return {
    version: 1,
    summary: 'A layered, cozy forest scene.',
    globalBrief: {
      spatialTheme: 'A dense forest opens toward a pond and a small camp.',
      visualHierarchy: 'The cabin is the focal point, framed by forest and reflected by the pond.',
      assetArtDirection: 'Rounded voxel forms, warm natural palette, consistent proportions.',
      focalZoneId: 'camp',
      terrainBase: { preset: 'hills', seed: 410, amplitude: 4, roughness: 0.45 }
    },
    assetFamilies: [
      {
        id: 'trees', label: 'Forest trees', role: 'upper-canopy silhouette', tags: ['tree'],
        sizeClass: 'large', desiredVariants: 2, priority: 1,
        generationBrief: 'Two readable forest tree variants with different crowns.'
      },
      {
        id: 'shrubs', label: 'Forest understory', role: 'low ecological transition', tags: ['fern', 'understory'],
        sizeClass: 'small', desiredVariants: 1, priority: 0.7,
        generationBrief: 'Low fern or shrub cluster.'
      },
      {
        id: 'cabin', label: 'Small forest cabin', role: 'primary architectural focus', tags: ['cabin', 'structure'],
        sizeClass: 'large', desiredVariants: 1, priority: 0.95,
        generationBrief: 'One reusable cozy forest cabin.'
      }
    ],
    grassFamilies: [
      { id: 'meadow', label: 'Forest meadow', mix: { short: 0.7, tall: 0.2, flowers: 0.1 } }
    ],
    zones: [
      {
        id: 'forest', label: 'Main forest', role: 'primary', importance: 0.9,
        region: { kind: 'circle', center: [-0.12, 0.04], radius: 0.9 },
        brief: { atmosphere: 'Layered and sheltered', hierarchy: 'Tall trees above low understory', openness: 0.2, transitionIntent: 'Thin toward the clearing and pond' },
        terrain: { elevation: 0.15, roughness: 0.7, flatness: 0.05 },
        layers: [
          { familyId: 'trees', density: 0.045, scaleRange: [0.85, 1.3], distribution: 'clustered', edgeFalloff: 0.25 },
          { familyId: 'shrubs', density: 0.08, scaleRange: [0.7, 1.15], distribution: 'clustered', edgeFalloff: 0.35 }
        ],
        grassLayers: [{ grassFamilyId: 'meadow', density: 0.35, variation: 0.25, edgeFalloff: 0.3, residualDensity: 0.12 }],
        excludeZoneIds: ['pond', 'clearing', 'camp']
      },
      {
        id: 'pond', label: 'Pond', role: 'secondary', importance: 0.65,
        region: { kind: 'circle', center: [0.35, 0.24], radius: 0.24 },
        brief: { atmosphere: 'Quiet reflective water', hierarchy: 'Open water with a soft planted shore', openness: 0.9, transitionIntent: 'Feather vegetation at the shore' },
        terrain: { elevation: -0.25, roughness: 0.25, flatness: 0.8 },
        water: { type: 'lake', level: 0.35, depth: 1.8 },
        layers: [],
        grassLayers: [{ grassFamilyId: 'meadow', density: 0.62, variation: 0.3, edgeFalloff: 0.18, residualDensity: 0.1 }],
        excludeZoneIds: []
      },
      {
        id: 'clearing', label: 'Forest clearing', role: 'negative-space', importance: 0.55,
        region: { kind: 'circle', center: [0.03, -0.22], radius: 0.19 },
        brief: { atmosphere: 'Breathing room', hierarchy: 'Low ground cover only', openness: 0.9, transitionIntent: 'Tree density fades toward center' },
        terrain: { elevation: 0, roughness: 0.15, flatness: 0.75 },
        layers: [],
        grassLayers: [{ grassFamilyId: 'meadow', density: 0.82, variation: 0.14, edgeFalloff: 0.22, residualDensity: 0.04 }],
        excludeZoneIds: []
      },
      {
        id: 'camp', label: 'Cabin camp', role: 'secondary', importance: 1,
        region: { kind: 'circle', center: [0.38, -0.3], radius: 0.16 },
        brief: { atmosphere: 'Warm and lived-in', hierarchy: 'Cabin anchors the scene', openness: 0.7, transitionIntent: 'A sparse buffer separates cabin from forest' },
        terrain: { elevation: 0.02, roughness: 0.1, flatness: 0.9 },
        layers: [{ familyId: 'cabin', density: 0.01, scaleRange: [1, 1.1], distribution: 'accent', edgeFalloff: 0 }],
        grassLayers: [{ grassFamilyId: 'meadow', density: 0.5, variation: 0.2, edgeFalloff: 0.2, residualDensity: 0.14 }],
        excludeZoneIds: []
      }
    ],
    transitions: [
      { fromZoneId: 'forest', toZoneId: 'clearing', kind: 'soft', width: 0.18 },
      { fromZoneId: 'forest', toZoneId: 'pond', kind: 'shore', width: 0.12 }
    ],
    consultations: [
      { id: 'shore-review', discipline: 'natural shoreline design', targetZoneIds: ['pond', 'forest'], question: 'How should the pond and forest meet naturally?', priority: 0.8 },
      { id: 'focus-review', discipline: 'environment composition', targetZoneIds: ['camp', 'clearing'], question: 'How can the cabin remain visible without making the scene empty?', priority: 0.7 },
      { id: 'ignored-third', discipline: 'extra', targetZoneIds: [], question: 'Should not run in this budget.', priority: 0.1 }
    ],
    renderPromptSuggestions: ['soft morning haze', 'warm low-contrast light']
  };
}

function asset(
  id: string,
  name: string,
  tags: string[],
  sizeClass: 'small' | 'medium' | 'large',
  mode: string
): MapAsset {
  return {
    id,
    name,
    prompt: name,
    tags,
    sizeClass,
    footprintRadius: sizeClass === 'large' ? 1.2 : 0.45,
    modelJson: {},
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    mode,
    createdAt: 1,
    updatedAt: 1
  };
}
