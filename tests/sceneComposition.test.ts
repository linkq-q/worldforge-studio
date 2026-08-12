import { describe, expect, it } from 'vitest';
import { createEmptyMap, getMapObjectAabbs, sampleTerrainHeight, type MapAsset } from '../src/shared/map';
import {
  ensureMinimumSceneCoverage,
  estimateSceneZoneCoverage,
  enforceScenePlacementContracts,
  isCompositionEmptyMap,
  normalizeSceneCompositionPlan,
  enforcePromptSceneIntent,
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

  it('does not inflate rocks and boundary stones through vegetation population repair', () => {
    const map = createEmptyMap('Rock field', 'map-rock-population', [96, 16, 96], 'voxel');
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements?: unknown[];
    };
    input.assetFamilies = [{
      id: 'rocks', label: 'Boundary stones', role: 'field boundary markers', tags: ['rock', 'stone', 'boundary'],
      sizeClass: 'small', desiredVariants: 1, priority: 0.5, generationBrief: 'small boundary stone'
    }];
    input.zones = [{
      id: 'rock-field', label: 'Rock field', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.8 },
      brief: { atmosphere: 'open', hierarchy: 'sparse stones', openness: 0.9, transitionIntent: 'soft edge' },
      terrain: { elevation: 0, roughness: 0.2, flatness: 0.7 },
      layers: [{ familyId: 'rocks', density: 0.0001, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.2 }],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'rock-field';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];
    const plan = normalizeSceneCompositionPlan(input, map);
    const rock = asset('rock-a', 'Boundary stone', ['rock', 'stone', 'boundary'], 'small', 'voxel');
    const resolved = resolveSceneFamilies(plan, map, [rock], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);

    expect(outcome.checks.some((check) => check.requirementId === 'scene-population')).toBe(false);
    expect(outcome.compiled.metrics.objectCount).toBeLessThan(10);
  });

  it('classifies furniture intent and replaces unsafe cult-ring defaults before compilation', () => {
    const map = createEmptyMap('Furniture park', 'map-furniture-contract', [96, 16, 96], 'voxel');
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements?: unknown[];
    };
    input.assetFamilies = [
      { id: 'benches', label: 'Park benches', role: 'public seating facing the sea', tags: ['bench', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 0.7, generationBrief: 'wood bench' },
      { id: 'swings', label: 'Playground swings', role: 'children playground facility', tags: ['swing', 'playground'], sizeClass: 'large', desiredVariants: 1, priority: 0.8, generationBrief: 'swing set' },
      { id: 'pews', label: 'Church pews', role: 'audience seating facing altar', tags: ['pew', 'church', 'chair'], sizeClass: 'medium', desiredVariants: 1, priority: 0.7, generationBrief: 'church pew' },
      { id: 'path-benches', label: 'Path benches', role: 'seating along a curved park path', tags: ['bench', 'path'], sizeClass: 'medium', desiredVariants: 1, priority: 0.6, generationBrief: 'path bench' }
    ];
    input.zones = [{
      id: 'park', label: 'Park plaza', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.85 },
      brief: { atmosphere: 'public park', hierarchy: 'open activity field', openness: 0.8, transitionIntent: 'soft' },
      terrain: { elevation: 0, roughness: 0.1, flatness: 0.9 },
      layers: [
        { familyId: 'benches', density: 0.2, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1, placement: { mode: 'layout', pattern: 'courtyard', direction: 0, offset: 0, facing: 'inward' } },
        { familyId: 'swings', density: 0.2, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1, placement: { mode: 'layout', pattern: 'courtyard', direction: 0, offset: 0, facing: 'inward' } },
        { familyId: 'pews', density: 0.2, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0.1, placement: { mode: 'layout', direction: 0, offset: 0, facing: 'inward' } },
        { familyId: 'path-benches', density: 0.1, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0.1, placement: { mode: 'linear', intent: 'street-edge', guidePoints: [[-0.8, -0.4], [0, -0.4], [0.6, 0.5]], maxPerGroup: 3, direction: 0, offset: 2, facing: 'guide' } }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'park';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];

    const safe = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map);
    const layers = Object.fromEntries(safe.zones[0].layers.map((layer) => [layer.familyId, layer]));
    expect(layers.benches.placement).toMatchObject({ mode: 'layout', pattern: 'arc', intent: 'viewpoint', maxPerGroup: 5 });
    expect(layers.swings.placement).toMatchObject({ mode: 'layout', pattern: 'arc', intent: 'playground', maxPerGroup: 2 });
    expect(layers.pews.placement).toMatchObject({ mode: 'layout', pattern: 'grid', intent: 'audience' });
    expect(layers['path-benches'].placement).toMatchObject({ mode: 'linear', intent: 'street-edge', maxPerGroup: 3 });
    expect(layers['path-benches'].placement?.guidePoints).toEqual([[-0.8, -0.4], [0, -0.4], [0.6, 0.5]]);
  });

  it('drops incomplete optional guide points instead of rejecting the whole scene plan', () => {
    const map = createEmptyMap('Optional guide', 'map-optional-guide', [72, 12, 72], 'voxel');
    const input = structuredClone(planInput()) as {
      zones: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    input.zones[0].layers[0].placement = {
      mode: 'linear', intent: 'street-edge', direction: 0, offset: 1.5, facing: 'guide', guidePoints: []
    };

    const plan = normalizeSceneCompositionPlan(input, map);

    expect(plan.zones[0].layers[0].placement?.guidePoints).toBeUndefined();
  });

  it('uses chapel context to turn generic benches into audience rows facing the chapel focus', () => {
    const map = createEmptyMap('Chapel', 'map-chapel-seating', [72, 12, 72], 'voxel');
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'chapel', label: 'Small chapel', role: 'architectural focus', tags: ['church', 'building'], sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'small chapel' },
      { id: 'benches', label: 'Wood benches', role: 'seating', tags: ['bench', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 0.8, generationBrief: 'simple wood bench' }
    ];
    input.zones = [{
      id: 'chapel-zone', label: 'Quiet interior', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.7 },
      brief: { atmosphere: 'quiet', hierarchy: 'seating faces the focal structure', openness: 0.5, transitionIntent: 'none' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [
        { familyId: 'chapel', density: 0.01, scaleRange: [1, 1], distribution: 'accent', edgeFalloff: 0.1, placement: { mode: 'anchor', direction: 0, offset: 0, facing: 'guide' } },
        { familyId: 'benches', density: 0.1, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1 }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'chapel-zone';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];

    const plan = enforcePromptSceneIntent(
      normalizeSceneCompositionPlan(input, map),
      'A small chapel interior with orderly wood benches, a center aisle, and all seats facing the altar.',
      map
    );
    const benches = plan.zones[0].layers.find((layer) => layer.familyId === 'benches')!;

    expect(benches.placement).toMatchObject({
      mode: 'layout', pattern: 'grid', intent: 'audience', focusFamilyId: 'chapel', aisleEvery: 4
    });
  });

  it('faces symmetric classroom furniture toward the blackboard and mounts a hyphenated wall clock', () => {
    const map = createEmptyMap('Classroom', 'map-classroom-focus', [15, 4, 10], 'voxel', 'indoor', [15, 4, 10]);
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'blackboard', label: 'Front blackboard', role: 'classroom teaching focus', tags: ['wall-mounted', 'blackboard'], sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'front wall blackboard' },
      { id: 'desks', label: 'Student desks', role: 'repeated classroom desks', tags: ['school-desk', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 0.9, generationBrief: 'one reusable student desk' },
      { id: 'chairs', label: 'Student chairs', role: 'one chair paired to each student desk', tags: ['school-chair', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 0.9, generationBrief: 'one reusable student chair' },
      { id: 'clock', label: 'Classroom wall-clock', role: 'wall timepiece', tags: ['wall-clock', 'timepiece'], sizeClass: 'small', desiredVariants: 1, priority: 0.5, generationBrief: 'round classroom wall-clock' }
    ];
    input.zones = [{
      id: 'classroom', label: 'Classroom seating', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.85 },
      brief: { atmosphere: 'orderly classroom', hierarchy: 'students face the front blackboard', openness: 0.45, transitionIntent: 'central aisle' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [
        { familyId: 'blackboard', density: 0.01, scaleRange: [1, 1], distribution: 'accent', edgeFalloff: 0, placement: { mode: 'anchor', direction: 180, offset: 0.1, facing: 'guide' } },
        { familyId: 'desks', density: 0.08, scaleRange: [0.6, 0.6], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'guide' } },
        { familyId: 'chairs', density: 0.08, scaleRange: [0.45, 0.45], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'guide' } },
        { familyId: 'clock', density: 0.01, scaleRange: [1, 1], distribution: 'accent', edgeFalloff: 0, placement: { mode: 'anchor', direction: 180, offset: 0.1, facing: 'guide' } }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'classroom';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, 'ordinary classroom');
    const asymmetricInput = structuredClone(input);
    (asymmetricInput.zones[0] as Record<string, unknown>).symmetry = 'asymmetric';
    const layers = Object.fromEntries(plan.zones[0].layers.map((layer) => [layer.familyId, layer]));
    expect(plan.zones[0].symmetry).toBe('symmetric');
    expect(plan.zones[0].symmetryAxis).toBe('x');
    expect(normalizeSceneCompositionPlan(asymmetricInput, map).zones[0].symmetry).toBe('asymmetric');
    expect(layers.blackboard.placement).toMatchObject({ mode: 'linear', intent: 'wall' });
    expect(layers.clock.placement).toMatchObject({ mode: 'linear', intent: 'wall' });
    expect(layers.desks.placement).toMatchObject({ intent: 'functional-group', facing: 'inward', focusFamilyId: 'blackboard' });
    expect(layers.chairs.placement).toMatchObject({ intent: 'paired', facing: 'inward', focusFamilyId: 'blackboard' });

    const assets = [
      asset('asset-blackboard', 'Front blackboard', ['wall-mounted', 'blackboard'], 'large', 'voxel'),
      asset('asset-desks', 'Student desk', ['school-desk', 'furniture'], 'medium', 'voxel'),
      asset('asset-chairs', 'Student chair', ['school-chair', 'furniture'], 'medium', 'voxel'),
      asset('asset-clock', 'Classroom wall-clock', ['wall-clock', 'timepiece'], 'small', 'voxel')
    ];
    const resolved = plan.assetFamilies.map((family, index) => ({ family, assets: [assets[index]], missingCount: 0 }));
    const compiled = compileSceneComposition(map, plan, resolved);
    compiled.operations = compiled.operations.flatMap((operation): MapOperation[] => {
      if (operation.type !== 'object.add') return [operation];
      if (operation.object.assetId === 'asset-blackboard') return [];
      if (operation.object.assetId !== 'asset-desks' && operation.object.assetId !== 'asset-chairs') return [operation];
      const rotation = operation.object.transform?.rotation ?? [0, 0, 0];
      return [{
        ...operation,
        object: { ...operation.object, transform: { ...operation.object.transform, rotation: [rotation[0], Math.PI / 2, rotation[2]] } }
      }];
    });
    compiled.metrics.familyCounts.blackboard = 0;
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const generated = applyMapOperations({ ...map, assets }, outcome.compiled.operations);
    const blackboard = generated.objects.find((object) => object.assetId === 'asset-blackboard')!;
    const clock = generated.objects.find((object) => object.assetId === 'asset-clock')!;
    const students = generated.objects.filter((object) => object.assetId === 'asset-desks' || object.assetId === 'asset-chairs');
    expect(students.length).toBeGreaterThan(2);
    expect(students.every((object) => {
      const dx = blackboard.transform.position[0] - object.transform.position[0];
      const dz = blackboard.transform.position[2] - object.transform.position[2];
      const length = Math.hypot(dx, dz);
      return (Math.sin(object.transform.rotation[1]) * dx + Math.cos(object.transform.rotation[1]) * dz) / length > 0.98;
    })).toBe(true);
    expect(outcome.compiled.operations.some((operation) => operation.type === 'object.update')).toBe(true);
    const clockBounds = getMapObjectAabbs(generated).find((bounds) => bounds.objectId === clock.id)!;
    expect(Math.min(
      Math.abs(Math.abs(clockBounds.min[0]) - map.room!.size[0] / 2),
      Math.abs(Math.abs(clockBounds.max[0]) - map.room!.size[0] / 2),
      Math.abs(Math.abs(clockBounds.min[2]) - map.room!.size[2] / 2),
      Math.abs(Math.abs(clockBounds.max[2]) - map.room!.size[2] / 2)
    )).toBeLessThan(0.2);
  });

  it('places one computer on each internet-cafe desk through parent support hierarchy', () => {
    const map = createEmptyMap('Internet cafe', 'map-internet-cafe-support', [14, 3.4, 10], 'voxel', 'indoor', [14, 3.4, 10]);
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'desks', label: 'Gaming desks', role: 'repeated internet cafe workstations', tags: ['gaming-desk', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 1, generationBrief: 'one reusable gaming desk' },
      { id: 'computers', label: 'Desktop computers', role: 'one complete computer station per desk', tags: ['desktop-computer', 'monitor'], sizeClass: 'medium', desiredVariants: 1, priority: 1, generationBrief: 'monitor keyboard mouse and tower, no desk' }
    ];
    input.zones = [{
      id: 'workstations', label: 'Internet cafe workstations', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.8 },
      brief: { atmosphere: 'busy internet cafe', hierarchy: 'aligned desks and computers', openness: 0.45, transitionIntent: 'central aisle' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [
        { familyId: 'desks', density: 0.08, scaleRange: [0.75, 0.75], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', intent: 'functional-group', direction: 0, offset: 0, facing: 'guide' } },
        { familyId: 'computers', density: 0.08, scaleRange: [0.45, 0.45], distribution: 'clustered', edgeFalloff: 0, placement: { mode: 'attached', intent: 'supported', targetFamilyId: 'desks', direction: 0, offset: 0, facing: 'guide', maxPerGroup: 1 } }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'workstations';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [{ id: 'four-desks', kind: 'asset-family', description: 'four desks', targetZoneId: 'workstations', familyId: 'desks', minCount: 4 }];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, 'internet cafe');
    const deskAsset = asset('asset-gaming-desk', 'Gaming desk', ['gaming-desk', 'furniture'], 'medium', 'voxel');
    const computerAsset = asset('asset-desktop-computer', 'Desktop computer', ['desktop-computer', 'monitor'], 'medium', 'voxel');
    const resolved = [
      { family: plan.assetFamilies[0], assets: [deskAsset], missingCount: 0 },
      { family: plan.assetFamilies[1], assets: [computerAsset], missingCount: 0 }
    ];

    const generated = applyMapOperations(map, compileSceneComposition(map, plan, resolved).operations);
    const desks = generated.objects.filter((object) => object.assetId === deskAsset.id);
    const computers = generated.objects.filter((object) => object.assetId === computerAsset.id);

    expect(desks.length).toBeGreaterThan(0);
    expect(computers).toHaveLength(desks.length);
    expect(new Set(computers.map((computer) => computer.parentId))).toEqual(new Set(desks.map((desk) => desk.id)));
    expect(computers.every((computer) => computer.transform.position[1] > 0)).toBe(true);
  });

  it('repairs a restaurant as symmetric table groups with four chairs and a complete ceiling grid', () => {
    const map = createEmptyMap('Restaurant', 'map-restaurant-groups', [20, 5, 15], 'voxel', 'indoor', [20, 5, 15]);
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'tables', label: 'Four-seat dining tables', role: 'repeated restaurant dining tables', tags: ['furniture', 'dining', 'table', 'four-seat'], sizeClass: 'medium', desiredVariants: 1, priority: 1, generationBrief: 'one four-seat table' },
      { id: 'chairs', label: 'Dining chairs', role: 'chairs around each dining table', tags: ['furniture', 'dining', 'chair'], sizeClass: 'small', desiredVariants: 1, priority: 1, generationBrief: 'one dining chair' },
      { id: 'lights', label: 'Pendant lights', role: 'regular restaurant ceiling illumination', tags: ['lighting', 'ceiling-light', 'pendant-light'], sizeClass: 'small', desiredVariants: 1, priority: 0.7, generationBrief: 'one pendant light' }
    ];
    input.zones = [{
      id: 'dining', label: 'Main restaurant dining room', role: 'primary', importance: 1,
      symmetry: 'symmetric', symmetryAxis: 'x',
      region: { kind: 'circle', center: [0, 0], radius: 0.86 },
      brief: { atmosphere: 'orderly diner', hierarchy: 'repeated dining groups', openness: 0.45, transitionIntent: 'clear central circulation' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [
        { familyId: 'tables', density: 0.08, scaleRange: [0.8, 0.8], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'guide', maxPerGroup: 1 } },
        { familyId: 'chairs', density: 0.2, scaleRange: [0.55, 0.55], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'random', targetFamilyId: 'tables' } },
        { familyId: 'lights', density: 0.2, scaleRange: [0.7, 0.7], distribution: 'even', edgeFalloff: 0, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'guide' } }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'dining';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [
      { id: 'required-tables', kind: 'asset-family', description: 'four dining tables', targetZoneId: 'dining', familyId: 'tables', minCount: 4 },
      { id: 'required-chairs', kind: 'asset-family', description: 'four chairs per table', targetZoneId: 'dining', familyId: 'chairs', minCount: 16 }
    ];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, 'orderly restaurant');
    const layers = Object.fromEntries(plan.zones[0].layers.map((layer) => [layer.familyId, layer]));
    expect(plan.assetFamilies.find((family) => family.id === 'lights')?.tags).toContain('ceiling-mounted');
    expect(layers.chairs.placement).toMatchObject({ mode: 'attached', intent: 'social', targetFamilyId: 'tables', maxPerGroup: 4 });
    expect(layers.lights.placement).toMatchObject({ mode: 'layout', pattern: 'grid', maxPerGroup: 12 });

    const assets = [
      { ...asset('asset-table', 'Four-seat dining table', ['furniture', 'dining', 'table'], 'medium', 'voxel'), footprintRadius: 0.74 },
      { ...asset('asset-chair', 'Dining chair', ['furniture', 'dining', 'chair'], 'small', 'voxel'), footprintRadius: 0.25 },
      {
        ...asset('asset-light', 'Pendant light', ['lighting', 'ceiling-light', 'pendant-light'], 'small', 'voxel'),
        footprintRadius: 0.45,
        modelJson: { nodes: [{ id: 'light', transform: { pos: [0, 0.2, 0] }, mesh: { type: 'box', params: { width: 0.9, height: 0.4, depth: 0.4 } } }] },
        colliderPlan: {
          version: 1 as const,
          boxes: [{ min: [-0.45, 0, -0.2] as [number, number, number], max: [0.45, 0.4, 0.2] as [number, number, number] }],
          sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false
        }
      }
    ];
    const resolved = plan.assetFamilies.map((family, index) => ({ family, assets: [assets[index]], missingCount: 0 }));
    const compiled = compileSceneComposition(map, plan, resolved);
    expect(layers.tables.placement).toMatchObject({ mode: 'layout', intent: 'functional-group' });
    expect(compiled.metrics.familyCounts.tables).toBeGreaterThan(1);
    const tableOperations: MapOperation[] = [
      [-2, -2], [2, -2], [-2, 2], [2, 2]
    ].map(([x, z], index) => ({
      type: 'object.add',
      object: {
        id: `restaurant-table-${index + 1}`, name: 'Dining table', assetId: 'asset-table', heightMode: 'fixed',
        transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [0.8, 0.8, 0.8] }
      }
    }));
    const missingGroups = {
      ...compiled,
      operations: [
        ...compiled.operations.filter((operation) => operation.type !== 'object.add'
          || operation.object.assetId === 'asset-light'),
        ...tableOperations
      ],
      metrics: {
        ...compiled.metrics,
        familyCounts: { ...compiled.metrics.familyCounts, tables: 4, chairs: 0 }
      }
    };
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, missingGroups);
    const generated = applyMapOperations({ ...map, assets }, outcome.compiled.operations);
    const tables = generated.objects.filter((object) => object.assetId === 'asset-table');
    const chairs = generated.objects.filter((object) => object.assetId === 'asset-chair');
    const lights = generated.objects.filter((object) => object.assetId === 'asset-light');

    expect(tables).toHaveLength(4);
    expect(chairs).toHaveLength(16);
    expect(lights.length).toBeGreaterThanOrEqual(4);
    for (const table of tables) {
      expect(tables.some((other) => Math.abs(other.transform.position[0] + table.transform.position[0]) < 0.001
        && Math.abs(other.transform.position[2] - table.transform.position[2]) < 0.001)).toBe(true);
      const groupedChairs = chairs.filter((chair) => Math.hypot(
        chair.transform.position[0] - table.transform.position[0],
        chair.transform.position[2] - table.transform.position[2]
      ) < 2);
      expect(groupedChairs).toHaveLength(4);
      expect(groupedChairs.every((chair) => {
        const dx = table.transform.position[0] - chair.transform.position[0];
        const dz = table.transform.position[2] - chair.transform.position[2];
        const length = Math.hypot(dx, dz);
        return (Math.sin(chair.transform.rotation[1]) * dx + Math.cos(chair.transform.rotation[1]) * dz) / length > 0.98;
      })).toBe(true);
    }
    const lightXs = new Set(lights.map((light) => light.transform.position[0].toFixed(3)));
    const lightZs = new Set(lights.map((light) => light.transform.position[2].toFixed(3)));
    expect(lightXs.size * lightZs.size).toBe(lights.length);
    expect(Math.min(lightXs.size, lightZs.size)).toBeGreaterThanOrEqual(2);
    const lightBounds = getMapObjectAabbs(generated).filter((bounds) => lights.some((light) => light.id === bounds.objectId));
    expect(lightBounds.every((bounds) => Math.abs(bounds.max[1] - (map.room!.size[1] - map.room!.wallThickness)) < 0.001)).toBe(true);
  });

  it('reflows an incomplete office workstation relationship as one coherent desk-chair group', () => {
    const map = createEmptyMap('Office', 'map-office-reflow', [15, 5, 10], 'voxel', 'indoor', [15, 5, 10]);
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'desks', label: 'Office desks', role: 'four desks in two workstation groups', tags: ['office-desk', 'workstation', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 1, generationBrief: 'one reusable office desk' },
      { id: 'chairs', label: 'Office chairs', role: 'one chair paired with every desk', tags: ['office-chair', 'furniture'], sizeClass: 'medium', desiredVariants: 1, priority: 1, generationBrief: 'one reusable office chair' }
    ];
    input.zones = [{
      id: 'workstations', label: 'Office workstation bay', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.82 },
      brief: { atmosphere: 'orderly office', hierarchy: 'four desks form two groups', openness: 0.5, transitionIntent: 'clear circulation around workstations' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [
        { familyId: 'desks', density: 0.05, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0.1, placement: { mode: 'layout', pattern: 'grid', direction: 0, offset: 0, facing: 'guide' } },
        { familyId: 'chairs', density: 0.05, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1, placement: { mode: 'attached', direction: 0, offset: 0, facing: 'guide', targetFamilyId: 'desks' } }
      ],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'workstations';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [
      { id: 'four-desks', kind: 'asset-family', description: 'four office desks', targetZoneId: 'workstations', familyId: 'desks', minCount: 4 },
      { id: 'chair-per-desk', kind: 'asset-family', description: 'one chair per desk', targetZoneId: 'workstations', familyId: 'chairs', minCount: 4 }
    ];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, '办公室，四个办公桌组成两组工位，每张桌子配一把椅子');
    const assets = [
      { ...asset('asset-office-desk', 'Office desk', ['office-desk', 'workstation', 'furniture'], 'medium', 'voxel'), footprintRadius: 0.7 },
      { ...asset('asset-office-chair', 'Office chair', ['office-chair', 'furniture'], 'medium', 'voxel'), footprintRadius: 0.5 }
    ];
    const resolved = plan.assetFamilies.map((family, index) => ({ family, assets: [assets[index]], missingCount: 0 }));
    const deskPositions = [[0, 0], [0, -2.2], [0, 2.2], [-2.2, -2.2]];
    const brokenOperations: MapOperation[] = [
      ...deskPositions.map(([x, z], index): MapOperation => ({
        type: 'object.add', object: {
          id: `broken-desk-${index + 1}`, name: 'Office desk', assetId: assets[0].id, heightMode: 'fixed',
          transform: { position: [x, 0, z], rotation: [0, Math.PI, 0], scale: [1.5, 1.5, 1.5] }
        }
      })),
      {
        type: 'object.add', object: {
          id: 'broken-chair-1', name: 'Office chair', assetId: assets[1].id, heightMode: 'fixed',
          transform: { position: [0, 0, 4], rotation: [0, Math.PI, 0], scale: [1.2, 1.2, 1.2] }
        }
      }
    ];
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, {
      operations: brokenOperations,
      metrics: {
        zoneCoverage: 0.8, zoneCount: 1, objectCount: 5, waterCount: 0,
        familyCounts: { desks: 4, chairs: 1 }, zoneCounts: { workstations: 5 }, unresolvedFamilyIds: []
      }
    });
    const generated = applyMapOperations({ ...map, assets }, outcome.compiled.operations);
    const desks = generated.objects.filter((object) => object.assetId === assets[0].id);
    const chairs = generated.objects.filter((object) => object.assetId === assets[1].id);
    expect(desks).toHaveLength(4);
    expect(chairs).toHaveLength(4);
    expect(generated.objects.some((object) => object.id.startsWith('broken-'))).toBe(false);
    expect(outcome.compiled.metrics.initialObjectCount).toBe(5);
    const pairedChairIds = new Set<string>();
    for (const desk of desks) {
      const nearest = chairs.map((chair) => ({
        chair,
        distance: Math.hypot(
          chair.transform.position[0] - desk.transform.position[0],
          chair.transform.position[2] - desk.transform.position[2]
        )
      })).sort((left, right) => left.distance - right.distance)[0];
      expect(nearest.distance).toBeLessThan(3);
      pairedChairIds.add(nearest.chair.id);
    }
    expect(pairedChairIds.size).toBe(4);
  });

  it('mirrors a missing repeated window across the declared indoor symmetry axis', () => {
    const map = createEmptyMap('Restaurant windows', 'map-window-mirror', [20, 5, 15], 'voxel', 'indoor', [20, 5, 15]);
    const windowAsset = {
      ...asset('asset-window', 'Restaurant glass window', ['window', 'wall-mounted', 'glass'], 'medium', 'voxel'),
      footprintRadius: 1.2,
      modelJson: { nodes: [{ id: 'window', transform: { pos: [0, 0.8, 0] }, mesh: { type: 'box', params: { width: 2.4, height: 1.6, depth: 0.15 } } }] }
    };
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [{
      id: 'windows', label: 'Restaurant windows', role: 'repeated wall daylight windows',
      tags: ['window', 'wall-mounted'], sizeClass: 'medium', desiredVariants: 1, priority: 1,
      generationBrief: 'one reusable glass window'
    }];
    input.zones = [{
      id: 'dining', label: 'Dining room', role: 'primary', importance: 1,
      symmetry: 'symmetric', symmetryAxis: 'x',
      region: { kind: 'circle', center: [0, 0], radius: 0.9 },
      brief: { atmosphere: 'balanced', hierarchy: 'paired windows', openness: 0.5, transitionIntent: 'clear center' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [{ familyId: 'windows', density: 0.01, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0, placement: { mode: 'linear', pattern: 'row', intent: 'wall', direction: 0, offset: 0, facing: 'inward' } }],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'dining';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [{ id: 'two-windows', kind: 'asset-family', description: 'two symmetric windows', targetZoneId: 'dining', familyId: 'windows', minCount: 2 }];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, 'symmetric restaurant windows');
    const resolved = [{ family: plan.assetFamilies[0], assets: [windowAsset], missingCount: 0 }];
    const initialWindow: MapOperation = {
      type: 'object.add',
      object: {
        id: 'window-right', name: 'Window', assetId: windowAsset.id, heightMode: 'fixed',
        transform: { position: [3, 1.6, -7.34], rotation: [0, 0, 0], scale: [1, 1, 1] }
      }
    };
    const compiled = {
      operations: [initialWindow],
      metrics: {
        zoneCoverage: 0.5, zoneCount: 1, objectCount: 1, waterCount: 0,
        familyCounts: { windows: 1 }, zoneCounts: { dining: 1 }, unresolvedFamilyIds: [], behaviorQuality: {}
      }
    };
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const generated = applyMapOperations({ ...map, assets: [windowAsset] }, outcome.compiled.operations);
    const windows = generated.objects.filter((object) => object.assetId === windowAsset.id);

    expect(windows).toHaveLength(2);
    expect(windows[0].transform.position[0] + windows[1].transform.position[0]).toBeCloseTo(0, 4);
    expect(generated.room?.openings.filter((opening) => opening.kind === 'window')).toHaveLength(1);
  });

  it('places two sparse instances of each playground facility family', () => {
    const map = createEmptyMap('Playground', 'map-playground-layout', [72, 12, 72], 'voxel');
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [
      { id: 'swings', label: 'Playground swings', role: 'play facility', tags: ['swing', 'playground'], sizeClass: 'medium', desiredVariants: 1, priority: 0.8, generationBrief: 'swing set' },
      { id: 'slides', label: 'Playground slides', role: 'play facility', tags: ['slide', 'playground'], sizeClass: 'medium', desiredVariants: 1, priority: 0.8, generationBrief: 'small slide' }
    ];
    input.zones = [{
      id: 'play-zone', label: 'Playground', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.85 },
      brief: { atmosphere: 'active', hierarchy: 'sparse facilities around open play space', openness: 0.75, transitionIntent: 'soft' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: input.assetFamilies.map((family) => ({
        familyId: family.id, density: 0.08, scaleRange: [0.7, 0.7], distribution: 'clustered', edgeFalloff: 0.1
      })),
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'play-zone';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];
    const plan = enforcePromptSceneIntent(normalizeSceneCompositionPlan(input, map), 'A small public playground.', map);
    const assets = [
      asset('swing-a', 'Swing', ['swing', 'playground'], 'medium', 'voxel'),
      asset('slide-a', 'Slide', ['slide', 'playground'], 'medium', 'voxel')
    ];
    const resolved = resolveSceneFamilies(plan, map, assets, 0).families;

    const compiled = compileSceneComposition(map, plan, resolved);

    expect(compiled.metrics.familyCounts.swings).toBe(2);
    expect(compiled.metrics.familyCounts.slides).toBe(2);

    const missingFacilities = {
      ...compiled,
      operations: compiled.operations.filter((operation) => operation.type !== 'object.add'),
      metrics: { ...compiled.metrics, objectCount: 0, familyCounts: {}, zoneCounts: { 'play-zone': 0 } }
    };
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, missingFacilities);
    expect(outcome.compiled.metrics.familyCounts.swings).toBe(2);
    expect(outcome.compiled.metrics.familyCounts.slides).toBe(2);
    expect(outcome.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'family-presence-swings', status: 'repaired' }),
      expect.objectContaining({ requirementId: 'family-presence-slides', status: 'repaired' })
    ]));
  });

  it('keeps every generated warehouse asset, separates floor inventory, and binds doors and windows to openings', () => {
    const map = createEmptyMap('Warehouse', 'map-warehouse-golden', [15, 4, 10], 'voxel', 'indoor', [15, 4, 10]);
    const inventory = [
      ['rack', 'Warehouse storage rack', ['warehouse', 'storage rack'], 'large'],
      ['door', 'Warehouse loading door', ['warehouse', 'loading door'], 'large'],
      ['transport-box', 'Transport box', ['warehouse', 'transport box'], 'small'],
      ['light', 'Industrial ceiling light', ['warehouse', 'industrial light', 'ceiling-mounted'], 'small'],
      ['crate', 'Storage crate', ['warehouse', 'storage crate'], 'medium'],
      ['pallet', 'Wood pallet', ['warehouse', 'wood pallet'], 'small'],
      ['window', 'High warehouse window', ['warehouse', 'window', 'wall-prop'], 'medium'],
      ['jack', 'Pallet jack', ['warehouse', 'pallet jack'], 'medium'],
      ['marker', 'Aisle marker post', ['warehouse', 'aisle marker'], 'small'],
      ['sign', 'Warehouse safety sign', ['warehouse', 'safety sign', 'wall-prop'], 'small'],
      ['extinguisher', 'Fire extinguisher', ['warehouse', 'fire extinguisher', 'wall-prop'], 'small']
    ] as const;
    const assets = inventory.map(([id, name, tags, sizeClass]) => ({
      ...asset(`asset-${id}`, name, [...tags], sizeClass, 'voxel'),
      footprintRadius: Math.SQRT1_2,
      colliderPlan: {
        version: 1 as const,
        boxes: [{ min: [-0.5, 0, -0.5] as [number, number, number], max: [0.5, 1, 0.5] as [number, number, number] }],
        sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false
      }
    }));
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = inventory.map(([id, label, tags, sizeClass]) => ({
      id, label, role: label, tags: [...tags], identityTags: [id], sizeClass,
      desiredVariants: 1, priority: 0.8, generationBrief: label
    }));
    input.zones = [{
      id: 'warehouse-floor', label: 'Warehouse floor', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, 0], radius: 0.9 },
      brief: {
        atmosphere: 'orderly working warehouse', hierarchy: 'rack rows and staging bays',
        openness: 0.45, transitionIntent: 'clear loading and circulation spine'
      },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: inventory.map(([id]) => ({
        familyId: id, density: 0.012, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0
      })),
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'warehouse-floor';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [];
    const plan = enforceScenePlacementContracts(normalizeSceneCompositionPlan(input, map), map, 'orderly warehouse');
    expect(plan.assetFamilies.map((family) => family.id)).toEqual(inventory.map(([id]) => id));
    const resolved = plan.assetFamilies.map((family, index) => ({ family, assets: [assets[index]], missingCount: 0 }));
    const compiled = compileSceneComposition(map, plan, resolved);
    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);
    const generated = applyMapOperations({ ...map, assets }, outcome.compiled.operations);

    expect(outcome.checks.filter((check) => check.status === 'warning')).toEqual([]);
    expect(new Set(generated.objects.map((object) => object.assetId))).toEqual(new Set(assets.map((item) => item.id)));
    expect(generated.room?.openings.map((opening) => opening.kind).sort()).toEqual(['door', 'window']);
    expect(generated.objects.filter((object) => object.roomOpeningId)).toHaveLength(2);
    const floorIds = new Set(['asset-rack', 'asset-transport-box', 'asset-crate', 'asset-pallet', 'asset-jack', 'asset-marker']);
    const floorObjects = generated.objects.filter((object) => floorIds.has(object.assetId ?? ''));
    const visualBounds = new Map(getMapObjectAabbs(generated).map((bounds) => [bounds.objectId, bounds]));
    for (let leftIndex = 0; leftIndex < floorObjects.length; leftIndex += 1) {
      const left = visualBounds.get(floorObjects[leftIndex].id)!;
      for (let rightIndex = leftIndex + 1; rightIndex < floorObjects.length; rightIndex += 1) {
        const right = visualBounds.get(floorObjects[rightIndex].id)!;
        expect(
          left.max[0] <= right.min[0] || right.max[0] <= left.min[0]
            || left.max[2] <= right.min[2] || right.max[2] <= left.min[2],
          `${floorObjects[leftIndex].name} ${JSON.stringify(left)} overlaps ${floorObjects[rightIndex].name} ${JSON.stringify(right)}`
        ).toBe(true);
      }
    }
    const light = generated.objects.find((object) => object.assetId === 'asset-light')!;
    expect(light.transform.position[1]).toBeGreaterThan(3);
  });

  it('turns an explicit high-mountain prompt into a scenic rocky massif and slope habitat', () => {
    const map = createEmptyMap('High mountain', 'map-high-mountain-intent', [96, 16, 96], 'voxel');
    const input = structuredClone(planInput()) as {
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<{ id: string; layers: Array<Record<string, unknown>> }>;
    };
    input.assetFamilies.push({
      id: 'mountain-rocks', label: 'Bare ridge rocks', role: 'natural mountain outcrops', tags: ['rock', 'stone', 'mountain'],
      sizeClass: 'medium', desiredVariants: 1, priority: 0.8, generationBrief: 'angular bare mountain rock'
    });
    input.zones[0].layers.push({
      familyId: 'mountain-rocks', density: 0.018, scaleRange: [0.8, 1.3], distribution: 'clustered', edgeFalloff: 0.2
    });
    const normalized = normalizeSceneCompositionPlan(input, map);

    const plan = enforcePromptSceneIntent(normalized, '一座岩石裸露的高山，缓坡覆盖苔藓，山脊只有裸岩。', map);
    const mountain = plan.zones.find((zone) => zone.layers.some((layer) => layer.familyId === 'mountain-rocks'))!;
    const rocks = mountain.layers.find((layer) => layer.familyId === 'mountain-rocks')!;

    expect(mountain.region.radius).toBeGreaterThanOrEqual(0.62);
    expect(mountain.terrain).toMatchObject({ modifier: 'mountain', access: 'scenic', surface: 'rock' });
    expect(mountain.terrain.amplitude).toBeGreaterThanOrEqual(7.5);
    expect(rocks.placement?.habitat?.height?.[1]).toBeGreaterThan(3);
    expect(rocks.placement?.habitat?.slope?.[2]).toBeGreaterThan(45);
    expect(plan.assetFamilies.find((family) => family.id === 'mountain-rocks')).toMatchObject({
      desiredVariants: 2
    });
    expect(plan.assetFamilies.find((family) => family.id === 'mountain-rocks')?.generationBrief).toContain('no stacked monument');

    const rockAsset = asset('mountain-rock-a', 'Bare ridge rocks', ['rock', 'stone', 'mountain'], 'medium', 'voxel');
    const resolved = resolveSceneFamilies(plan, map, [rockAsset], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);
    const rockPlacements = compiled.operations.filter((operation) => (
      operation.type === 'object.add' && operation.object.assetId === rockAsset.id
    ));
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'terrain.modify', modifier: 'mountain',
        region: expect.objectContaining({ kind: 'path' })
      })
    ]));
    expect(rockPlacements.length).toBeGreaterThan(0);
    expect(rockPlacements.length).toBeLessThanOrEqual(6);
    expect(rockPlacements.some((operation) => (
      operation.type === 'object.add' && (operation.object.transform?.position?.[1] ?? -Infinity) > 3
    ))).toBe(true);
    const generated = applyMapOperations(map, compiled.operations);
    const generatedRocks = generated.objects.filter((object) => object.assetId === rockAsset.id);
    expect(generatedRocks.every((object) => object.heightMode === 'fixed')).toBe(true);
    expect(generatedRocks.every((object) => object.transform.scale[1] < object.transform.scale[0])).toBe(true);
    expect(generatedRocks.some((object) => (
      Math.abs(object.transform.rotation[0]) > 0.01 || Math.abs(object.transform.rotation[2]) > 0.01
    ))).toBe(true);
    expect(generatedRocks.every((object) => (
      object.transform.position[1] < sampleTerrainHeight(
        generated,
        object.transform.position[0],
        object.transform.position[2]
      )
    ))).toBe(true);
  });

  it('reports unsafe furniture rings in the outcome audit', () => {
    const map = createEmptyMap('Unsafe park furniture', 'map-furniture-audit', [72, 12, 72], 'voxel');
    const input = structuredClone(planInput()) as {
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<{ layers: Array<Record<string, unknown>> }>;
      intentRequirements: unknown[];
    };
    input.intentRequirements = [];
    input.assetFamilies.push({
      id: 'benches', label: 'Park benches', role: 'public seating', tags: ['bench', 'furniture'],
      sizeClass: 'medium', desiredVariants: 1, priority: 0.7, generationBrief: 'wood park bench'
    });
    input.zones[0].layers.push({
      familyId: 'benches', density: 0.2, scaleRange: [1, 1], distribution: 'clustered', edgeFalloff: 0.1,
      placement: { mode: 'layout', pattern: 'courtyard', direction: 0, offset: 0, facing: 'inward' }
    });
    const plan = normalizeSceneCompositionPlan(input, map);
    const bench = asset('bench-a', 'Park bench', ['bench', 'furniture'], 'medium', 'voxel');
    const resolved = resolveSceneFamilies(plan, map, [bench], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);

    expect(outcome.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: 'furniture-benches', kind: 'furniture', status: 'warning' })
    ]));
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

  it('keeps the generated scene and reports a downgrade when a required asset cannot physically fit', () => {
    const map = createEmptyMap('Tiny classroom', 'map-unplaceable-blackboard', [6, 3, 6], 'voxel', 'indoor', [6, 3, 6]);
    const input = structuredClone(planInput()) as {
      globalBrief: { focalZoneId: string };
      assetFamilies: Array<Record<string, unknown>>;
      zones: Array<Record<string, unknown>>;
      transitions: unknown[];
      consultations: unknown[];
      intentRequirements: unknown[];
    };
    input.assetFamilies = [{
      id: 'front-blackboard', label: 'Front blackboard', role: 'classroom focus', tags: ['blackboard', 'wall-prop'],
      sizeClass: 'large', desiredVariants: 1, priority: 1, generationBrief: 'wide classroom blackboard'
    }];
    input.zones = [{
      id: 'front', label: 'Classroom front', role: 'primary', importance: 1,
      region: { kind: 'circle', center: [0, -0.7], radius: 0.2 },
      brief: { atmosphere: 'classroom', hierarchy: 'blackboard focus', openness: 0.4, transitionIntent: 'front wall' },
      terrain: { elevation: 0, roughness: 0, flatness: 1 },
      layers: [{
        familyId: 'front-blackboard', density: 0.01, scaleRange: [1, 1], distribution: 'accent', edgeFalloff: 0,
        placement: { mode: 'linear', intent: 'wall', pattern: 'row', direction: 0, offset: 0.2, facing: 'inward', maxPerGroup: 1 }
      }],
      grassLayers: [], excludeZoneIds: []
    }];
    input.globalBrief.focalZoneId = 'front';
    input.transitions = [];
    input.consultations = [];
    input.intentRequirements = [{
      id: 'front-blackboard', kind: 'asset-family', description: 'required front blackboard',
      targetZoneId: 'front', familyId: 'front-blackboard', minCount: 1
    }];
    const plan = normalizeSceneCompositionPlan(input, map);
    const blackboard = asset('asset-huge-blackboard', 'Huge blackboard', ['blackboard', 'wall-prop'], 'large', 'voxel');
    blackboard.footprintRadius = 100;
    blackboard.colliderPlan.boxes = [{ min: [-100, 0, -0.2], max: [100, 2, 0.2] }];
    blackboard.colliderPlan.fallbackUsed = false;
    blackboard.colliderPlan.sourceMeshCount = 1;
    const resolved = resolveSceneFamilies(plan, map, [blackboard], 0).families;
    const compiled = compileSceneComposition(map, plan, resolved);

    const outcome = ensureSceneCompositionOutcome(map, plan, resolved, compiled);

    expect(outcome.checks).toEqual(expect.arrayContaining([expect.objectContaining({
      requirementId: 'front-blackboard', status: 'warning'
    })]));
    expect(outcome.compiled.operations.length).toBeGreaterThan(0);

    const fittingBlackboard = asset('asset-fitting-blackboard', 'Fitting blackboard', ['blackboard', 'wall-prop'], 'large', 'voxel');
    fittingBlackboard.footprintRadius = 4;
    fittingBlackboard.colliderPlan = {
      version: 1, boxes: [{ min: [-4, 0, -0.1], max: [4, 1.8, 0.1] }],
      sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false
    };
    fittingBlackboard.modelJson = {
      nodes: [{ id: 'board', transform: { pos: [0, 0.9, 0] }, mesh: { type: 'box', params: { width: 8, height: 1.8, depth: 0.2 } } }]
    };
    const fittingMap = createEmptyMap('Classroom', 'map-fitting-blackboard', [12, 3, 8], 'voxel', 'indoor', [12, 3, 8]);
    const fittingResolved = resolveSceneFamilies(plan, fittingMap, [fittingBlackboard], 0).families;
    const fittingCompiled = compileSceneComposition(fittingMap, plan, fittingResolved);
    const missingBlackboard = {
      ...fittingCompiled,
      operations: fittingCompiled.operations.filter((operation) => operation.type !== 'object.add'),
      metrics: {
        ...fittingCompiled.metrics,
        objectCount: 0,
        familyCounts: {},
        zoneCounts: { front: 0 }
      }
    };
    const fittingOutcome = ensureSceneCompositionOutcome(
      fittingMap, plan, fittingResolved, missingBlackboard
    );
    const placed = fittingOutcome.compiled.operations.find((operation): operation is Extract<MapOperation, { type: 'object.add' }> => (
      operation.type === 'object.add' && operation.object.assetId === fittingBlackboard.id
    ));
    expect(placed).toBeDefined();
    expect(placed?.object.transform?.scale?.[0]).toBeGreaterThan(0.6);
    expect(placed?.object.transform?.position?.[1]).toBeGreaterThan(0.5);
    expect(placed?.object.transform?.position?.[2]).toBeLessThan(-3.5);
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
