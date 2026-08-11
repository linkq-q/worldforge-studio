import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  ensureMinimumSceneCoverage,
  estimateSceneZoneCoverage,
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
import { applyMapOperations, type MapOperation } from '../src/shared/mapOperations';
import { isNearWater } from '../src/shared/mapWater';
import { sampleGrassDensity } from '../src/shared/mapGrass';
import { ensureSceneCompositionOutcome } from '../src/shared/sceneCompositionOutcome';

describe('scene composition contract', () => {
  it('compiles director-selected terrain modifiers and surfaces as reusable operations', () => {
    const map = createEmptyMap('Cliff terraces', 'map-cliff-terraces', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as {
      zones: Array<{ terrain: Record<string, unknown> }>;
    };
    input.zones[0].terrain = {
      ...input.zones[0].terrain,
      modifier: 'terrace', surface: 'rock', amplitude: 5, layers: 6, softness: 0.1, access: 'walkable'
    };
    const plan = normalizeSceneCompositionPlan(input, map);
    const compiled = compileSceneComposition(map, plan, []);

    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.modify', modifier: 'terrace', layers: 6, access: 'walkable' }),
      expect.objectContaining({ type: 'terrain.refine', erosion: 0.2, drainage: 0.08 }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'rock', zoneId: 'composition-surface-forest' })
    ]));
  });

  it('routes architecture through an ordered layout instead of vegetation scatter', () => {
    const map = createEmptyMap('Village court', 'map-village-court', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as {
      zones: Array<{ id: string; layers: Array<Record<string, unknown>>; region: { radius: number } }>;
    };
    const camp = input.zones.find((zone) => zone.id === 'camp')!;
    camp.region.radius = 0.32;
    camp.layers = [{
      familyId: 'cabin', density: 0.03, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0,
      placement: {
        mode: 'layout', pattern: 'courtyard', direction: 20, spacing: 4,
        offset: 0, facing: 'inward'
      }
    }];
    const plan = normalizeSceneCompositionPlan(input, map);
    const cabin = asset('cabin-a', 'Cabin', ['cabin', 'structure'], 'large', 'voxel-pro');
    const resolved = resolveSceneFamilies(plan, map, [cabin], 0).families;

    const compiled = compileSceneComposition(map, plan, resolved);
    const cabins = compiled.operations.filter((operation): operation is Extract<MapOperation, { type: 'object.add' }> => (
      operation.type === 'object.add' && operation.object.assetId === cabin.id
    ));

    expect(plan.zones.find((zone) => zone.id === 'camp')?.layers[0].placement?.mode).toBe('layout');
    expect(cabins.length).toBeGreaterThanOrEqual(4);
    const center = sceneZoneWorldRegion(plan.zones.find((zone) => zone.id === 'camp')!, map);
    for (const operation of cabins) {
      const [x, , z] = operation.object.transform?.position ?? [0, 0, 0];
      const yaw = operation.object.transform?.rotation?.[1] ?? 0;
      const distance = Math.hypot(center.x - x, center.z - z);
      const dot = Math.sin(yaw) * (center.x - x) / distance + Math.cos(yaw) * (center.z - z) / distance;
      expect(dot).toBeGreaterThan(0.98);
    }
  });

  it('reserves the object budget for required families before optional layout layers', () => {
    const map = createEmptyMap('Island park', 'map-required-family-budget', [96, 16, 96], 'voxel');
    const plan = normalizeSceneCompositionPlan({
      version: 1,
      summary: 'A tree-filled island park with a paved plaza.',
      globalBrief: {
        spatialTheme: 'open island park', visualHierarchy: 'trees frame the plaza',
        assetArtDirection: 'warm voxel park', focalZoneId: 'park',
        terrainBase: { preset: 'plain', seed: 23, amplitude: 0, roughness: 0 }
      },
      intentRequirements: [{
        id: 'park-trees', kind: 'asset-family', description: 'required park trees',
        targetZoneId: 'park', familyId: 'park-trees', minCount: 1
      }],
      assetFamilies: [
        {
          id: 'pavers', label: 'Pavers', role: 'optional plaza paving', tags: ['paving'],
          sizeClass: 'small', desiredVariants: 1, priority: 0.5, generationBrief: 'small paving stone'
        },
        {
          id: 'park-trees', label: 'Park trees', role: 'park shade trees', tags: ['tree', 'park'],
          sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'large park tree'
        }
      ],
      grassFamilies: [],
      zones: [{
        id: 'park', label: 'Park', role: 'primary', importance: 1,
        region: { kind: 'circle', center: [0, 0], radius: 0.8 },
        brief: { atmosphere: 'open park', hierarchy: 'trees around paving', openness: 0.7, transitionIntent: 'soft edge' },
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        layers: [
          {
            familyId: 'pavers', density: 1, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0,
            placement: { mode: 'layout', pattern: 'grid', spacing: 0.8, offset: 0, direction: 0, facing: 'guide' }
          },
          {
            familyId: 'park-trees', density: 0.03, scaleRange: [0.9, 1.1], distribution: 'clustered', edgeFalloff: 0.2,
            placement: { mode: 'patch' }
          }
        ],
        grassLayers: [], excludeZoneIds: []
      }],
      transitions: [], consultations: [], renderPromptSuggestions: []
    }, map);
    const paver = asset('asset-paver', 'Paver', ['paving'], 'small', 'voxel');
    paver.footprintRadius = 0.1;
    const tree = asset('asset-park-tree', 'Park tree', ['tree', 'park'], 'large', 'voxel');
    tree.footprintRadius = 3.8125;
    const resolved = resolveSceneFamilies(plan, map, [paver, tree], 0).families;

    const compiled = compileSceneComposition(map, plan, resolved);

    expect(compiled.metrics.familyCounts['park-trees']).toBeGreaterThanOrEqual(1);
  });

  it('compiles mixed-locomotion flocks into grounded cores, airborne outliers, and quality metrics', () => {
    const map = createEmptyMap('Seaside flock', 'map-seaside-flock', [96, 20, 96], 'voxel');
    const input = structuredClone(planInput()) as {
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements?: unknown[];
    };
    input.assetFamilies = [{
      id: 'gulls', label: 'Seagulls', role: 'shore wildlife', tags: ['animal', 'bird', 'seagull'],
      sizeClass: 'small', desiredVariants: 1, priority: 1, generationBrief: 'low-poly seagull',
      behavior: {
        kind: 'flock', locomotion: 'mixed', groupCount: 2, coreRatio: 0.7,
        outlierMinDistance: 8, altitudeRange: [4, 8], coreState: 'feed', outlierState: 'fly'
      }
    }];
    input.zones = [{
      id: 'shore', label: 'Shore', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.7 },
      brief: { atmosphere: 'open coast', hierarchy: 'birds cross the shore', openness: 0.9, transitionIntent: 'soft edge' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [{
        familyId: 'gulls', density: 0.004, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1,
        placement: { mode: 'patch' }
      }],
      grassLayers: [], excludeZoneIds: []
    }];
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];
    (input as unknown as { globalBrief: { focalZoneId: string } }).globalBrief.focalZoneId = 'shore';
    const plan = normalizeSceneCompositionPlan(input, map);
    const gull = asset('gull-a', 'Seagull', ['animal', 'bird', 'seagull'], 'small', 'voxel');
    gull.footprintRadius = 0.25;
    const resolved = resolveSceneFamilies(plan, map, [gull], 0).families;

    const compiled = compileSceneComposition(map, plan, resolved);
    const gulls = compiled.operations.filter((operation): operation is Extract<MapOperation, { type: 'object.add' }> => (
      operation.type === 'object.add' && operation.object.assetId === gull.id
    ));
    const cores = gulls.filter((operation) => operation.object.behavior?.groupRole === 'core');
    const outliers = gulls.filter((operation) => operation.object.behavior?.groupRole === 'outlier');

    expect(gulls.length).toBeGreaterThanOrEqual(6);
    expect(new Set(cores.map((operation) => operation.object.behavior?.groupIndex)).size).toBe(2);
    expect(cores.every((operation) => operation.object.heightMode === 'terrain')).toBe(true);
    expect(cores.every((operation) => operation.object.behavior?.animation?.state === 'feed')).toBe(true);
    expect(outliers.length).toBeGreaterThanOrEqual(2);
    expect(outliers.every((operation) => operation.object.heightMode === 'fixed')).toBe(true);
    expect(outliers.every((operation) => (operation.object.transform?.position?.[1] ?? 0) >= 4)).toBe(true);
    expect(outliers.every((operation) => operation.object.behavior?.animation?.state === 'fly')).toBe(true);
    expect(compiled.metrics.behaviorQuality?.gulls?.status).toBe('pass');
  });

  it('adds real editable ground cover when the director leaves most of the map blank', () => {
    const map = createEmptyMap('Sparse valley', 'map-sparse-valley', [96, 16, 96], 'voxel-pro');
    const sparse = structuredClone(planInput()) as {
      grassFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
    };
    sparse.grassFamilies = [];
    sparse.zones = [sparse.zones[3]];
    sparse.transitions = [];
    sparse.consultations = [];
    const camp = sparse.zones[0] as { id: string; region: { center: [number, number]; radius: number }; grassLayers: unknown[] };
    camp.region = { center: [0.38, -0.3], radius: 0.16 };
    camp.grassLayers = [];
    const normalized = normalizeSceneCompositionPlan(sparse, map);

    expect(estimateSceneZoneCoverage(normalized)).toBeLessThan(0.2);

    const covered = ensureMinimumSceneCoverage(normalized);
    const compiled = compileSceneComposition(map, covered, []);

    expect(estimateSceneZoneCoverage(covered)).toBeGreaterThanOrEqual(0.8);
    expect(covered.zones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'ambient-ground-cover',
        grassLayers: [expect.objectContaining({ density: 0.42 })]
      })
    ]));
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'grass.generate' })
    ]));
  });

  it('keeps creative roles free-form while validating references and bounded consultations', () => {
    const map = createEmptyMap('Forest', 'map-composition', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);

    expect(plan.assetFamilies[0].role).toBe('upper-canopy silhouette');
    expect(plan.consultations).toHaveLength(2);
    expect(plan.globalBrief.focalZoneId).toBe('camp');
    expect(isCompositionEmptyMap(map)).toBe(true);
  });

  it('compiles director-selected grass morphology and height into editable layers', () => {
    const map = createEmptyMap('Wet farm', 'map-grass-morphology', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as { grassFamilies: Array<Record<string, unknown>> };
    input.grassFamilies[0] = {
      ...input.grassFamilies[0],
      preset: 'wetland',
      height: 1.7
    };

    const plan = normalizeSceneCompositionPlan(input, map);
    const compiled = compileSceneComposition(map, plan, []);

    expect(plan.grassFamilies[0]).toMatchObject({ preset: 'wetland', height: 1.7 });
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'grass.layer.add',
        layer: expect.objectContaining({ preset: 'wetland', height: 1.7 })
      })
    ]));
  });

  it('repairs an undeclared procedural grass family instead of rejecting the whole scene', () => {
    const map = createEmptyMap('Grass repair', 'map-grass-repair', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as {
      grassFamilies: unknown[];
      zones: Array<{ grassLayers: unknown[] }>;
    };
    input.grassFamilies = [];
    input.zones[0].grassLayers = [{
      grassFamilyId: 'woodland-floor', density: 0.5, variation: 0.2, edgeFalloff: 0.3, residualDensity: 0.08
    }];

    const plan = normalizeSceneCompositionPlan(input, map);
    const compiled = compileSceneComposition(map, plan, []);

    expect(plan.grassFamilies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'woodland-floor' }),
      expect.objectContaining({ id: 'meadow' })
    ]));
    expect(plan.zones[0].grassLayers[0].grassFamilyId).toBe('woodland-floor');
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'grass.layer.add' }),
      expect.objectContaining({ type: 'grass.generate' })
    ]));
  });

  it('resolves reusable assets across generation modes and reports semantic gaps', () => {
    const map = createEmptyMap('Forest', 'map-assets', [96, 16, 96], 'voxel-pro');
    const plan = normalizeSceneCompositionPlan(planInput(), map);
    const assets = [
      asset('tree-a', 'Pine', ['tree', 'conifer'], 'large', 'voxel-pro'),
      asset('tree-wrong-mode', 'Curve Pine', ['tree', 'conifer'], 'large', 'curve'),
      asset('shrub-a', 'Fern', ['fern', 'understory'], 'small', 'voxel-pro')
    ];

    const resolved = resolveSceneFamilies(plan, map, assets, 4);

    expect(resolved.families.find((item) => item.family.id === 'trees')?.assets.map((item) => item.id))
      .toEqual(['tree-a', 'tree-wrong-mode']);
    expect(resolved.gaps.map((gap) => gap.familyId)).toContain('cabin');
    expect(resolved.gaps).toHaveLength(1);
  });

  it('does not let generic category assets impersonate a named family identity', () => {
    const map = createEmptyMap('Named families', 'map-named-assets', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as {
      assetFamilies: Array<{ id: string; tags: string[]; identityTags?: string[] }>;
    };
    const trees = input.assetFamilies.find((family) => family.id === 'trees')!;
    trees.tags = ['tree', 'vegetation', 'maple'];
    trees.identityTags = ['maple'];
    const cabin = input.assetFamilies.find((family) => family.id === 'cabin')!;
    cabin.tags = ['building', 'landmark', 'castle'];
    cabin.identityTags = ['castle'];
    const plan = normalizeSceneCompositionPlan(input, map);
    const assets = [
      asset('generic-tree', 'Generic tree', ['tree', 'vegetation'], 'large', 'voxel-pro'),
      asset('generic-building', 'Generic cabin', ['building', 'structure'], 'large', 'voxel-pro'),
      asset('shrub-a', 'Fern', ['fern', 'understory'], 'small', 'voxel-pro')
    ];

    const resolved = resolveSceneFamilies(plan, map, assets, 4);

    expect(resolved.families.find((item) => item.family.id === 'trees')?.assets).toHaveLength(0);
    expect(resolved.families.find((item) => item.family.id === 'cabin')?.assets).toHaveLength(0);
    expect(resolved.gaps.map((gap) => gap.familyId)).toEqual(expect.arrayContaining(['trees', 'cabin']));
    expect(resolved.gaps.find((gap) => gap.familyId === 'trees')?.tags).toContain('maple');
    expect(resolved.gaps.find((gap) => gap.familyId === 'cabin')?.tags).toContain('castle');
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
    expect(applied.visualSemantics.zones.find((zone) => zone.id === 'forest')?.tags).toEqual(
      expect.arrayContaining(['forest', 'grass'])
    );
    expect(applied.visualSemantics.zones.find((zone) => zone.id === 'pond')?.tags).toEqual(
      expect.arrayContaining(['water', 'lowland'])
    );
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

  it('normalizes natural pond vocabulary into the canonical editable lake basin', () => {
    const map = createEmptyMap('Pond', 'map-pond-vocabulary', [96, 16, 96], 'voxel-pro');
    const input = planInput() as { zones: Array<{ id: string; water?: { type?: string; kind?: string } }> };
    const pond = input.zones.find((zone) => zone.id === 'pond')!;
    pond.water = { type: 'pond' };

    const plan = normalizeSceneCompositionPlan(input, map);

    expect(plan.zones.find((zone) => zone.id === 'pond')?.water).toMatchObject({
      type: 'lake', level: 0.2, depth: 1.5
    });
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

  it('keeps a generated required landmark when its requested zone is too close to the map edge', () => {
    const map = createEmptyMap('Landmark edge guard', 'map-landmark-edge', [96, 16, 96], 'voxel');
    const plan = normalizeSceneCompositionPlan({
      version: 1,
      summary: 'A giant luminous tree anchors the forest edge.',
      globalBrief: {
        spatialTheme: 'edge sanctuary',
        visualHierarchy: 'the luminous tree is the focus',
        assetArtDirection: 'voxel fantasy',
        focalZoneId: 'sanctuary',
        terrainBase: { preset: 'plain', seed: 11, amplitude: 0, roughness: 0 }
      },
      intentRequirements: [{
        id: 'glowing-ancient-tree', kind: 'asset-family', description: 'required landmark',
        targetZoneId: 'sanctuary', familyId: 'glowing-ancient-tree', minCount: 1
      }],
      zones: [{
        id: 'sanctuary', label: 'Sanctuary', role: 'primary', importance: 1,
        region: { kind: 'circle', center: [1, 1], radius: 0.05 },
        brief: { atmosphere: 'luminous', hierarchy: 'single landmark', openness: 0.8, transitionIntent: 'hard edge' },
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        layers: [{
          familyId: 'glowing-ancient-tree', density: 0.01, scaleRange: [1, 1],
          distribution: 'accent', edgeFalloff: 0
        }],
        grassLayers: [], excludeZoneIds: []
      }],
      transitions: [],
      assetFamilies: [{
        id: 'glowing-ancient-tree', label: 'Giant luminous ancient tree', role: 'landmark',
        tags: ['ancient-tree', 'luminous-bark'], sizeClass: 'large', desiredVariants: 1,
        priority: 1, generationBrief: 'one giant luminous tree'
      }],
      grassFamilies: [], consultations: [], renderPromptSuggestions: []
    }, map);
    const landmark = asset(
      'generated-landmark',
      'Giant luminous ancient tree',
      ['ancient-tree', 'luminous-bark'],
      'large',
      'voxel'
    );
    landmark.footprintRadius = 8.15;
    const resolved = resolveSceneFamilies(plan, map, [landmark], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const repeated = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const applied = applyMapOperations(map, outcome.compiled.operations);
    const placed = applied.objects.find((object) => object.assetId === landmark.id);

    expect(repeated).toEqual(outcome);
    expect(placed).toBeDefined();
    expect(Math.abs(placed!.transform.position[0])).toBeLessThanOrEqual(48 - 8.15 * placed!.transform.scale[0]);
    expect(Math.abs(placed!.transform.position[2])).toBeLessThanOrEqual(48 - 8.15 * placed!.transform.scale[2]);
  });

  it('tries a fallback land region when a required asset has no valid point in its water target', () => {
    const map = createEmptyMap('Island park', 'map-water-target-fallback', [96, 16, 96], 'voxel');
    const plan = normalizeSceneCompositionPlan({
      version: 1,
      summary: 'A lighthouse overlooks an island park.',
      globalBrief: {
        spatialTheme: 'small island park beside open water',
        visualHierarchy: 'the lighthouse is the focus',
        assetArtDirection: 'readable voxel silhouettes',
        focalZoneId: 'park',
        terrainBase: { preset: 'plain', seed: 13, amplitude: 0, roughness: 0 }
      },
      intentRequirements: [{
        id: 'lighthouse', kind: 'asset-family', description: 'required lighthouse',
        targetZoneId: 'water', familyId: 'lighthouse', minCount: 1
      }],
      zones: [
        {
          id: 'water', label: 'Water', role: 'secondary', importance: 0.7,
          region: { kind: 'circle', center: [-0.55, 0], radius: 0.05 },
          brief: { atmosphere: 'open sea', hierarchy: 'water foreground', openness: 1, transitionIntent: 'shore' },
          terrain: { elevation: -0.2, roughness: 0, flatness: 1 },
          water: { type: 'lake', level: 0.2, depth: 1.5 },
          layers: [], grassLayers: [], excludeZoneIds: []
        },
        {
          id: 'park', label: 'Park', role: 'primary', importance: 1,
          region: { kind: 'circle', center: [0.45, 0], radius: 0.35 },
          brief: { atmosphere: 'quiet park', hierarchy: 'lighthouse focus', openness: 0.8, transitionIntent: 'open lawn' },
          terrain: { elevation: 0, roughness: 0, flatness: 1 },
          layers: [], grassLayers: [], excludeZoneIds: []
        }
      ],
      assetFamilies: [{
        id: 'lighthouse', label: 'Red roof lighthouse', role: 'landmark', tags: ['lighthouse', 'landmark'],
        sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'one red roof lighthouse'
      }],
      grassFamilies: [], transitions: [], consultations: [], renderPromptSuggestions: []
    }, map);
    const lighthouse = asset('generated-lighthouse', 'Red roof lighthouse', ['lighthouse', 'landmark'], 'large', 'voxel');
    const resolved = resolveSceneFamilies(plan, map, [lighthouse], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const applied = applyMapOperations(map, outcome.compiled.operations);
    const placed = applied.objects.find((object) => object.assetId === lighthouse.id);

    expect(placed).toBeDefined();
    expect(placed!.transform.position[0]).toBeGreaterThan(0);
    expect(isNearWater(applied, placed!.transform.position[0], placed!.transform.position[2], 0.8)).toBe(false);
  });

  it('keeps an island park placeable when the sea surrounds its land zone', () => {
    const map = createEmptyMap('Island park', 'map-island-sea-overlap', [96, 16, 96], 'voxel');
    const plan = normalizeSceneCompositionPlan({
      version: 1,
      summary: 'A wooded park on an island surrounded by sea.',
      globalBrief: {
        spatialTheme: 'island park', visualHierarchy: 'woodland over the shore',
        assetArtDirection: 'readable voxel park', focalZoneId: 'park',
        terrainBase: { preset: 'island', seed: 1098549212, amplitude: 6, roughness: 0.45 }
      },
      intentRequirements: [
        {
          id: 'sea-water', kind: 'water', description: 'required surrounding sea',
          targetZoneId: 'sea', minCount: 1
        },
        {
          id: 'park-trees', kind: 'asset-family', description: 'required park trees',
          targetZoneId: 'park', familyId: 'park-trees', minCount: 1
        }
      ],
      assetFamilies: [{
        id: 'park-trees', label: 'Park trees', role: 'woodland canopy', tags: ['tree', 'park'],
        sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'large coastal park tree'
      }],
      grassFamilies: [],
      zones: [
        {
          id: 'sea', label: 'Sea', role: 'secondary', importance: 0.7,
          region: { kind: 'circle', center: [0, 0], radius: 1.2 },
          brief: { atmosphere: 'open sea', hierarchy: 'surrounding water', openness: 1, transitionIntent: 'shore' },
          terrain: { elevation: -0.4, roughness: 0, flatness: 0 },
          water: { type: 'lake', level: 0.2, depth: 2 },
          layers: [], grassLayers: [], excludeZoneIds: []
        },
        {
          id: 'park', label: 'Island park', role: 'primary', importance: 1,
          region: { kind: 'circle', center: [0, 0], radius: 0.65 },
          brief: { atmosphere: 'wooded park', hierarchy: 'tree canopy', openness: 0.45, transitionIntent: 'sandy shore' },
          terrain: { elevation: 0.3, roughness: 0.15, flatness: 0.55, modifier: 'island', amplitude: 5, access: 'walkable' },
          layers: [{
            familyId: 'park-trees', density: 0.04, scaleRange: [0.9, 1.1],
            distribution: 'clustered', edgeFalloff: 0.2, placement: { mode: 'patch' }
          }],
          grassLayers: [], excludeZoneIds: []
        }
      ],
      transitions: [], consultations: [], renderPromptSuggestions: []
    }, map);
    const tree = asset('asset-park-tree', 'Coastal park tree', ['tree', 'park'], 'large', 'voxel');
    tree.footprintRadius = 4.55;
    const resolved = resolveSceneFamilies(plan, map, [tree], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const applied = applyMapOperations(map, outcome.compiled.operations);

    expect(applied.waterBodies.filter((water) => water.type === 'ocean')).toHaveLength(1);
    expect(applied.waterBodies.some((water) => water.id === 'composition-water-sea')).toBe(false);
    expect(applied.objects.some((object) => object.assetId === tree.id)).toBe(true);
  });

  it('recovers a sparse forest when the director misclassifies repeatable trees as accents', () => {
    const map = createEmptyMap('Sparse forest', 'map-sparse-forest', [96, 16, 96], 'voxel-pro');
    const input = structuredClone(planInput()) as {
      zones: Array<{ id: string; layers: Array<Record<string, unknown>> }>;
    };
    const forest = input.zones.find((zone) => zone.id === 'forest')!;
    forest.layers = [{ ...forest.layers[0], density: 0.0001, distribution: 'accent' }];
    const plan = normalizeSceneCompositionPlan(input, map);
    const assets = [
      asset('tree-a', 'Round canopy tree', ['tree', 'forest'], 'large', 'voxel-pro'),
      asset('cabin-a', 'Cabin', ['cabin'], 'large', 'voxel-pro')
    ];
    const resolved = resolveSceneFamilies(plan, map, assets, 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const first = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const second = ensureSceneCompositionOutcome(map, plan, resolved, compiled);

    expect(second).toEqual(first);
    expect(first.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'scene-population', status: 'repaired' })
    ]));
    expect(first.compiled.metrics.objectCount).toBeGreaterThanOrEqual(10);
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
