import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type EditableMap, type MapAsset } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { observeMapDesign } from '../src/shared/mapDesignObservation';
import { mapEnvironmentGuides } from '../src/shared/mapTerrainAnalysis';
import { mapGuidePolyline, type MapGuide } from '../src/shared/mapGuide';
import { worldPlanKey, type WorldPlan } from '../src/shared/worldPlanning';
import { normalizeMapFoundation } from '../src/shared/mapFoundation';

function world(height = (x: number, _z: number) => 100 + x * 0.2): EditableMap {
  const resolution = 65;
  const plan: WorldPlan = { version: 1, id: 'observed-world', revision: 1, prompt: 'Keep the mountain and inspect the village',
    generationPolicy: 'raw-first-call', recipe: { version: 1, seed: 47, size: 500,
      constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
        version: 1, source: 'not sent to the model by observation', resolution, observations: [],
        heights: Array.from({ length: resolution * resolution }, (_, index) => height(
          index % resolution * 500 / (resolution - 1) - 250, Math.floor(index / resolution) * 500 / (resolution - 1) - 250))
      } }, ecology: [], towns: [], roads: [] };
  return applyMapOperations(createEmptyMap(), [{ type: 'world.set', world: { bundle: { plan, patches: [] }, assets: [] } }]);
}
function route(id: string, points: [number, number][], width = 4): MapGuide {
  return { id, name: id, points, width, curve: 'polyline', closed: false, tags: ['route'] };
}

describe('versioned map design observations', () => {
  it('surveys edge sectors and separates named regions from physically realized content', () => {
    const map=world();
    map.objects.push({...createMapObject('Edge destination'),transform:{position:[220,0,220],rotation:[0,0,0],scale:[1,1,1],size:[6,6,6]}});
    map.world!.bundle.plan.featureGraph={regions:[{id:'empty-orchard',kind:'agriculture',name:'Orchard',center:[-200,-200],radius:20}],anchors:[],paths:[],relations:[]};
    map.world!.bundle.plan.intentionalEmptyAreas=[{id:'claim',regionId:'empty-orchard',purpose:'Claimed orchard clearing'}];
    const before=JSON.stringify(map), observation=observeMapDesign(map,{kind:'coverage'},5);
    expect(observation).toMatchObject({draftRevision:5,kind:'coverage'});
    expect(observation.data.bounds).toEqual([-250,-250,250,250]);
    expect(observation.data.sectors.total).toBe(16);
    expect(observation.data.sectors.items.find((cell:any)=>cell.id==='sector-3-3').physicalFootprints).toBe(1);
    const empty=observation.data.sectors.items.find((cell:any)=>cell.id==='sector-0-0');
    expect(empty).toMatchObject({physicalFootprints:0,declaredRegions:[{id:'empty-orchard',name:'Orchard'}],declaredOpenAreas:[{id:'claim'}]});
    expect(empty.inspect.bounds).toEqual([-250,-250,-125,-125]);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('reports broad exclusion masks despite a bound forest asset, rather than claiming forest coverage', () => {
    const map=world(()=>30);
    map.world!.bundle.plan.ecology=[{id:'forest',kind:'broadleaf',biome:'grassland',density:1,spacing:10,maxSlope:45,scale:[1,1],exclusions:[{kind:'circle',center:[0,0],radius:200}]}];
    map.world!.assets=[{key:'tree',role:'tree',assetId:'tree',ecologyRuleId:'forest'}];
    const result=observeMapDesign(map,{kind:'coverage'},6);
    const center=result.data.sectors.items.find((cell:any)=>cell.id==='sector-2-2');
    expect(center.ecologyExcludedFraction).toBe(1);
    expect(center.ecologyPotentialFraction).toBe(0);
    const ordinary=observeMapDesign(createEmptyMap(),{kind:'coverage',grid:2},0);
    expect(ordinary.data.sectors.items.some((cell:any)=>cell.sampleCount===0 && cell.ecologyPotentialFraction===null)).toBe(true);
  });

  it('pages stored grass style and density precision without arrays or invented rendered coverage', () => {
    const map = applyMapOperations(world(), [
      { type: 'grass.layer.add', layer: { id: 'orchard', preset: 'farm', height: 0.6,
        mix: { short: 0.8, tall: 0.15, flowers: 0.05 } } },
      { type: 'grass.layer.add', layer: { id: 'hidden', preset: 'wetland', visible: false } }
    ]);
    const before = JSON.stringify(map), first = observeMapDesign(map, { kind: 'summary', limit: 1 }, 7);
    expect(map.terrain.resolutionX).toBe(2);
    expect(first.data.counts.grassLayers).toBe(2);
    expect(first.data.grassLayers).toMatchObject({ total: 2, offset: 0, limit: 1, nextOffset: 1,
      items: [{ id: 'orchard', visible: true, preset: 'farm', height: 0.6,
        mix: { short: 0.8, tall: 0.15, flowers: 0.05 }, densityResolution: [257, 257],
        densitySpacing: [1.9531, 1.9531] }] });
    const second = observeMapDesign(map, { kind: 'summary', offset: 1, limit: 1 }, 7);
    expect(second.data.grassLayers).toMatchObject({ nextOffset: null, items: [{ id: 'hidden', visible: false }] });
    expect(JSON.stringify(first.data.grassLayers)).not.toContain('densities');
    expect(JSON.stringify(first.data.grassLayers).length).toBeLessThan(500);
    expect(first.precision.grassDensity).toContain('not rendered');
    expect(JSON.stringify(map)).toBe(before);
    const ordinary = applyMapOperations(createEmptyMap(), [{ type: 'grass.layer.add', layer: { id: 'ordinary' } }]);
    expect(observeMapDesign(ordinary, { kind: 'summary' }, 0).data.grassLayers.items[0].densityResolution)
      .toEqual([ordinary.terrain.resolutionX, ordinary.terrain.resolutionZ]);
  });

  it('returns actual asset geometry, authored material colors and semantic pages without inventing supports', () => {
    const map = createEmptyMap();
    const asset: MapAsset = { id: 'house', name: 'House', prompt: 'house', mode: 'voxel', createdAt: 1, updatedAt: 9,
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      modelJson: { nodes: [{ id: 'roof', tags: [{ tag: 'palette', value: 'secondary' }],
        mesh: { type: 'box', params: { width: 8, height: 3, depth: 6 }, material: { color: '#a06040' } } }],
        _meta: { semanticSnapshot: { text: 'Measured roof and doorway. '.repeat(200) } } } };
    map.assets = [asset, { ...asset, id: 'empty', modelJson: { nodes: [] } }];
    const summary = observeMapDesign(map, { kind: 'assets', ids: ['house'] }, 4);
    expect(summary.data.items[0]).toMatchObject({ assetId: 'house', assetUpdatedAt: 9,
      geometry: { evidence: 'geometry', interior: 'unknown', size: [8, 3, 6] } });
    const materials = observeMapDesign(map, { kind: 'assets', ids: ['house'], section: 'materials' }, 4);
    expect(materials.data.items[0]).toMatchObject({ assetId: 'house', nodeId: 'roof', rawColor: '#a06040',
      paletteRole: { value: 'secondary', sourceNodeId: 'roof' }, source: 'stored-model-material' });
    expect(materials.data.limits.join(' ')).toContain('not rendered');
    const parts = observeMapDesign(map, { kind: 'assets', ids: ['house'], section: 'supports' }, 4);
    expect(parts.data.items[0]).toMatchObject({ assetId: 'house', nodeId: 'roof', min: [-4, 3, -3], max: [4, 3, 3] });
    const first = observeMapDesign(map, { kind: 'assets', ids: ['house'], section: 'semantic', limit: 1 }, 4);
    expect(first.data.nextOffset).toBe(1);
    const second = observeMapDesign(map, { kind: 'assets', ids: ['house'], section: 'semantic', offset: 1, limit: 1 }, 4);
    expect(first.data.items[0].text + second.data.items[0].text).toBe(('Measured roof and doorway. '.repeat(200)).slice(0, 4000));
    expect(observeMapDesign(map, { kind: 'assets', ids: ['empty'] }, 4).data.items[0].geometry)
      .toMatchObject({ evidence: 'unavailable', interior: 'unknown', localBounds: null, size: null });
  });

  it('makes shared design relations and planned destination connections readable without dumping terrain', () => {
    const map = world(), plan = map.world!.bundle.plan;
    map.designSemantics.experienceMode = 'sequential';
    map.designSemantics.relations = [{ id: 'orchard-market', kind: 'attract', sourceSelector: 'orchard', targetSelector: 'market', strength: 'normal' }];
    plan.featureGraph = { regions: [{ id: 'village', name: 'Village', kind: 'district', center: [0, 0], radius: 80 }],
      paths: [{ id: 'orchard-return', name: 'Return lane', kind: 'trail', width: 3, points: [[0, 0], [50, 0]] }],
      anchors: [{ id: 'market', kind: 'civic', position: [0, 0], regionId: 'village' },
        { id: 'orchard', kind: 'working', position: [50, 0], regionId: 'village' }],
      relations: [{ fromId: 'orchard', toId: 'market', kind: 'supplies' }] };
    plan.mobilityPlan = { routes: [{ id: 'return', pathId: 'orchard-return', mode: 'walk', connects: ['market', 'orchard'] }] };
    plan.explorationPlan = { pointsOfInterest: [{ id: 'fruit', anchorId: 'orchard', purpose: 'Find fruit stalls' }], sequence: ['fruit'] };
    const overview = observeMapDesign(map, { kind: 'world' }, 4);
    expect(overview.data).toMatchObject({ worldPlanRevision: 1, experienceMode: 'sequential' });
    const design = observeMapDesign(map, { kind: 'world', section: 'designSemantics' }, 4);
    expect(design.data.items.find((item: { collection: string }) => item.collection === 'relations').value.id).toBe('orchard-market');
    const mobility = observeMapDesign(map, { kind: 'world', section: 'mobilityPlan' }, 4);
    expect(mobility.data.items[0].value.connects).toEqual(['market', 'orchard']);
    const exploration = observeMapDesign(map, { kind: 'world', section: 'explorationPlan' }, 4);
    expect(exploration.data.sequence).toEqual(['fruit']);
    expect(JSON.stringify([overview, design, mobility, exploration])).not.toContain('not sent to the model');
    expect(JSON.stringify([overview, design, mobility, exploration])).not.toContain('heights');
    plan.roads = [{ ...route('actual-road', [[-20, 0], [0, 20], [20, 0]]), curve: 'catmull-rom' }];
    expect(observeMapDesign(map, { kind: 'world', section: 'roads' }, 4).data.items[0].value)
      .toMatchObject({ id: 'actual-road', curve: 'catmull-rom', points: [[-20, 0], [0, 20], [20, 0]] });
  });

  it('distinguishes terrain storage precision, source pages and historical inspections from current observations', () => {
    const map = world(), program = map.world!.bundle.plan.recipe.terrainProgram!;
    program.source = 'function generate(t) {'.padEnd(7000, ' ') + '}';
    program.observations = [{ label: 'earlier-pass', min: 1, max: 9, samples: [1, 9] }];
    const overview = observeMapDesign(map, { kind: 'terrain' }, 6);
    expect(overview.data).toMatchObject({ representation: 'terrain-program', resolution: [65, 65], spacing: [7.8125, 7.8125] });
    expect(overview.data.source).toMatchObject({ available: true, totalCharacters: program.source.length });
    expect(JSON.stringify(overview)).not.toContain('function generate');
    const chunks: string[] = [];
    let offset = 0;
    do {
      const page = observeMapDesign(map, { kind: 'terrain', section: 'source', offset, limit: 1 }, 6).data;
      chunks.push(...page.items.map((item: { text: string }) => item.text));
      offset = page.nextOffset;
    } while (offset !== null);
    expect(chunks.join('')).toBe(program.source);
    const reports = observeMapDesign(map, { kind: 'terrain', section: 'inspections' }, 6);
    expect(reports.data.items[0]).toMatchObject({ label: 'earlier-pass', samples: [1, 9], points: null,
      capturedTerrainRevision: null, source: 'stored-terrain-program-inspection', freshness: 'unknown' });
    expect(reports.data.limits.join(' ')).toContain('historical');
    expect(observeMapDesign(createEmptyMap(), { kind: 'terrain' }, 0).data.representation).toBe('stored-heightfield');
  });

  it('bounds new details, validates sections and preserves the input map', () => {
    const map = world(), before = JSON.stringify(map);
    for (const query of [{ kind: 'assets', ids: ['missing'] }, { kind: 'assets', section: 'modelJson' },
      { kind: 'world', section: 'all' }, { kind: 'terrain', section: 'heights' }, { kind: 'terrain', limit: 1000 }]) {
      expect(() => observeMapDesign(map, query, 0)).toThrow();
    }
    observeMapDesign(map, { kind: 'world', section: 'featureGraph' }, 0);
    observeMapDesign(map, { kind: 'terrain', section: 'recipe' }, 0);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('compares saved inspection revisions against the compiled field without guessing from labels', () => {
    const map = world(), program = map.world!.bundle.plan.recipe.terrainProgram!;
    program.terrainRevision = 4;
    program.observations = [
      { label: 'final', min: 0, max: 1, samples: [1], points: [[3, 5]], terrainRevision: 2 },
      { label: 'before', min: 1, max: 2, samples: [2], points: [[3, 5]], terrainRevision: 4 },
      { label: 'legacy', min: 0, max: 1, samples: [1] }
    ];
    const result = observeMapDesign(map, { kind: 'terrain', section: 'inspections' }, 9);
    expect(result.data.terrainRevision).toBe(4);
    expect(result.data.items).toMatchObject([
      { capturedTerrainRevision: 2, points: [[3, 5]], freshness: 'superseded-program-field' },
      { capturedTerrainRevision: 4, points: [[3, 5]], freshness: 'current-program-field' },
      { capturedTerrainRevision: null, points: null, freshness: 'unknown' }
    ]);
  });

  it('paginates long source text at a character budget without dropping chunks', () => {
    const map = world(), program = map.world!.bundle.plan.recipe.terrainProgram!;
    program.source = 'x'.repeat(58_000);
    const chunks: string[] = [];
    let offset = 0, pages = 0;
    do {
      const result = observeMapDesign(map, { kind: 'terrain', section: 'source', offset, limit: 64 }, 3).data;
      expect(JSON.stringify(result.items).length).toBeLessThan(24_050);
      expect(result.items.length).toBeLessThan(64);
      chunks.push(...result.items.map((item: { text: string }) => item.text));
      offset = result.nextOffset;
      pages++;
    } while (offset !== null);
    expect(pages).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(program.source);
  });

  it('reads the complete current world field, reports precision, and does not expose height arrays or mutate the draft', () => {
    const map = world();
    map.version = 7;
    const before = JSON.stringify(map);
    const result = observeMapDesign(map, { kind: 'points', points: [[0, 0], [10, 0]] }, 3);
    expect(result).toMatchObject({ schemaVersion: 1, mapVersion: 7, draftRevision: 3,
      source: 'continuous-world-plan-and-current-draft', units: { grade: 'rise/run' } });
    expect(result.data.samples.map((item: { height: number }) => item.height)).toEqual([100, 102]);
    expect(result.data.samples[0].slope).toBeCloseTo(Math.atan(0.2) * 180 / Math.PI, 3);
    expect(result.data.samples[0]).toMatchObject({ waterDistance: null, guideDistance: null, water: null });
    expect(result.precision.nullDistances).toContain('Not zero');
    expect(JSON.stringify(result)).not.toContain('not sent to the model');
    expect(JSON.stringify(result)).not.toContain('heights');
    expect(JSON.stringify(map)).toBe(before);
    const changed = structuredClone(map);
    changed.world!.bundle.plan.recipe.terrainProgram!.heights = changed.world!.bundle.plan.recipe.terrainProgram!.heights.map(value => value + 12);
    expect(observeMapDesign(changed, { kind: 'points', points: [[0, 0]] }, 4).data.samples[0].height).toBe(112);
    expect(result.draftRevision).toBe(3);
  });

  it('separates wetness from a requested named water body and keeps sea identity', () => {
    const map = world(() => -4);
    const result = observeMapDesign(map, { kind: 'points', points: [[0, 0]], waterId: 'sea' }, 0);
    expect(result.data.samples[0]).toMatchObject({ water: { id: 'sea', surfaceHeight: 0, depth: 4 },
      requestedWater: { id: 'sea', inside: true }, waterDistance: 0 });
    expect(() => observeMapDesign(map, { kind: 'points', points: [[0, 0]], waterId: 'missing' }, 0)).toThrow('unknown_map_environment_water');
  });

  it('lists the actual biome masks and distribution rules separately, with sample coverage rather than fabricated tree counts', () => {
    const map = world(() => 30), plan = map.world!.bundle.plan;
    plan.recipe.biomePatches = [{ id: 'round-forest', region: { kind: 'circle', center: [0, 0], radius: 20 }, biome: 'forest', feather: 4 }];
    plan.ecology = [{ id: 'path-trees', kind: 'pine', biome: 'forest', density: 0.9, spacing: 8, maxSlope: 30,
      scale: [1, 2], region: { kind: 'path', points: [[-80, 0], [80, 0]], width: 80 }, regionFeather: 8,
      exclusions: [{ kind: 'circle', center: [0, 0], radius: 5 }] }];
    const overview = observeMapDesign(map, { kind: 'summary', limit: 1 }, 0);
    expect(overview.data.biomePatches.items[0].region.kind).toBe('circle');
    expect(overview.data.ecologyRules.items[0].region.kind).toBe('path');
    expect(overview.data.ecologyRules.items[0].exclusions).toEqual([{ kind: 'circle', center: [0, 0], radius: 5 }]);
    expect(overview.data.counts.ecologyRules).toBe(1);
    const region = observeMapDesign(map, { kind: 'region', bounds: [-60, -20, 60, 20], grid: 7, limit: 4 }, 0);
    expect(region.data.samples.total).toBe(49);
    expect(region.data.samples.items).toHaveLength(4);
    expect(region.data.samples.nextOffset).toBe(4);
    expect(region.data.sampledCoverage.dryOutsideFootprintsAndGuidesFraction).toBe(1);
    expect(region.data.ecologySupport[0].meanRegionWeight).toBe(1);
    expect(region.data.ecologySupport[0].meanBiomeWeight).toBeLessThan(0.5);
    expect(region.data.limits.join(' ')).toContain('not acceptance probabilities');
    expect(region.data.sampledCoverage).not.toHaveProperty('treeCount');
    const clearing = observeMapDesign(map, { kind: 'region', bounds: [-20, -20, 20, 20], grid: 3 }, 0);
    expect(clearing.data.ecologySupport[0].sampledExcludedFraction).toBeCloseTo(1 / 9, 4);
  });

  it('reports full translated and rotated footprints even when their centers lie outside the requested bounds', () => {
    const map = world(), object = createMapObject('wide box', 'missing-asset');
    object.id = 'wide'; object.transform.position = [10, 100, 0]; object.transform.size = [20, 5, 10];
    map.objects = [object];
    const result = observeMapDesign(map, { kind: 'objects', bounds: [-1, -1, 1, 1] }, 2);
    expect(result.total).toBeUndefined();
    expect(result.data.total).toBe(1);
    expect(result.data.items[0]).toMatchObject({ reference: 'object:wide', geometry: 'fallback-aabb-missing-asset', entrance: null,
      polygon: [[0, -5], [20, -5], [20, 5], [0, 5]], ground: { min: 100, max: 104, bottomMinusGroundRange: [-4, 0] } });
    const plan = map.world!.bundle.plan;
    plan.towns = [{ id: 'village', name: 'Village', prompt: 'Existing village', center: [100, 80], radius: 50,
      blend: 20, foundation: 100, terrainMode: 'conform', ports: [] }];
    map.world!.bundle.patches = [{ townId: 'village', worldKey: worldPlanKey(plan), summary: 'existing', streets: [],
      buildings: [{ id: 'shop', x: 10, z: 20, width: 12, depth: 4, height: 6, rotation: Math.PI / 2, use: 'shop' }] }];
    const building = observeMapDesign(map, { kind: 'objects', ids: ['building:village:shop'] }, 3).data.items[0];
    expect(building.geometry).toBe('planned-oriented-footprint');
    expect(building.polygon).toEqual([[108, 106], [108, 94], [112, 94], [112, 106]]);
    expect(building.bottom).toBeNull();
    expect(building.entrance).toBeNull();
  });

  it('exposes town-local ports and districts needed to preserve settlement boundary connections', () => {
    const map = world(() => 100), state = map.world!, plan = state.bundle.plan;
    plan.featureGraph = { regions: [{ id: 'east-region', kind: 'district', name: 'East', center: [100, 30], radius: 20 }],
      anchors: [{ id: 'east-anchor', kind: 'district', position: [100, 30], regionId: 'east-region' }], paths: [], relations: [] };
    plan.towns = [{ id: 'town', name: 'Town', prompt: '', center: [20, 30], radius: 50, blend: 20, foundation: 100,
      ports: [{ id: 'east-port', guideId: 'east-road', position: [50, 0], width: 4 }],
      districts: [{ anchorId: 'east-anchor', kind: 'residential', density: 0.5, offset: [80, 0], radius: 20 }] }];
    plan.roads = [route('east-road', [[70, 30], [150, 30]])];
    state.bundle.patches = [{ townId: 'town', worldKey: worldPlanKey(plan), summary: '', buildings: [],
      streets: [route('main-street', [[0, 0], [50, 0]])] }];
    const valid = applyMapOperations(map, [{ type: 'world.set', world: state }]);
    const result = observeMapDesign(valid, { kind: 'summary' }, 2);
    expect(result.data.settlements.items[0]).toMatchObject({ center: [20, 30], radius: 50,
      ports: [{ id: 'east-port', guideId: 'east-road', position: [50, 0], width: 4 }],
      districts: [{ anchorId: 'east-anchor', kind: 'residential', density: 0.5, offset: [80, 0], radius: 20 }] });
    expect(result.data.access.items.find((item: { id: string }) => item.id === 'town:east-port').position).toEqual([70, 30]);
    expect(result.data.limits.join(' ')).toContain('town-local');
  });

  it('measures route gaps against the entire object footprint and detects a corridor crossing it', () => {
    const map = world(), object = createMapObject('shop');
    object.id = 'shop'; object.transform.position = [0, 100, 0]; object.transform.size = [20, 5, 20];
    map.objects = [object];
    map.guides = [route('through', [[-30, 0], [30, 0]])];
    const observation = observeMapDesign(map, { kind: 'objects' }, 0);
    expect(observation.data.items[0].nearestGuideCorridor).toMatchObject({ reference: 'map:through', gap: 0 });
    map.guides = [route('outside', [[-30, 20], [30, 20]])];
    expect(observeMapDesign(map, { kind: 'objects' }, 1).data.items[0].nearestGuideCorridor.gap).toBe(8);
  });

  it('observes the whole procedural foundation instead of mistaking it for a one-metre placeholder', () => {
    const map = world(), object = createMapObject('foundation');
    object.id = 'platform'; object.transform.position = [0, 100, 0];
    object.foundation = normalizeMapFoundation({ shape: 'rounded-rectangle', width: 20, depth: 10, cornerRadius: 0 });
    map.objects = [object];
    const reading = observeMapDesign(map, { kind: 'objects', bounds: [8, -2, 12, 2] }, 0).data.items[0];
    expect(reading.geometry).toBe('procedural-foundation-collider-envelope');
    expect(reading.polygon).toEqual([[-10, -5], [10, -5], [10, 5], [-10, 5]]);
    expect(reading.bottom).toBeNull();
  });

  it('returns longitudinal grades, designer-selected threshold intervals, and geometric endpoint gaps without claiming traversal', () => {
    const map = world();
    map.guides = [route('main', [[-100, 0], [100, 0]]), route('separate', [[120, 0], [160, 0]])];
    map.designSemantics.viewpoints = [{ id: 'entry', role: 'entry', point: [110, 0] }];
    const result = observeMapDesign(map, { kind: 'path', pathId: 'map:main', spacing: 20, maxGrade: 0.15 }, 0);
    expect(result.data.route.width).toBe(4);
    expect(result.data.absoluteGrade).toEqual({ min: 0.2, max: 0.2, mean: 0.2 });
    expect(result.data.events.items[0]).toEqual({ index: 1, position: [-80, 0], kind: 'grade-threshold-enter', distance: 20 });
    expect(result.data.endpoints[1]).toMatchObject({ nearestOtherCorridor: { reference: 'map:separate', gap: 16 },
      nearestDeclaredAccess: { id: 'entry', distance: 10 } });
    expect(result.data).not.toHaveProperty('walkable');
    expect(result.data.limits.join(' ')).toContain('not bridge decks');
  });

  it.each([false, true])('ignores a semantic mirror of the same curve when measuring adjacent corridors (reversed=%s)', reversed => {
    const map = world(), plan = map.world!.bundle.plan;
    const main = { ...route('orchard-return', [[-30, 0], [0, 20], [30, 0]]), curve: 'catmull-rom' as const };
    plan.roads = [main, route('neighbor', [[40, 0], [80, 0]])];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [{
      id: main.id, name: 'Semantic orchard path', kind: 'trail', width: main.width, curve: main.curve,
      points: (reversed ? [...main.points].reverse() : main.points).map(([x, z]) => [x + 0.000001, z])
    }] };
    const result = observeMapDesign(map, { kind: 'path', pathId: 'world:orchard-return' }, 0);
    expect(result.data.endpoints[1].nearestOtherCorridor).toMatchObject({ reference: 'world:neighbor', gap: 6 });
    const summary = observeMapDesign(map, { kind: 'summary' }, 0);
    expect(summary.data.routes.items.map((item: { reference: string }) => item.reference)).toEqual([
      'world:orchard-return', 'world:neighbor', 'feature:orchard-return'
    ]);
    plan.roads.pop();
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:orchard-return' }, 1).data.endpoints
      .every((endpoint: { nearestOtherCorridor: unknown }) => endpoint.nearestOtherCorridor === null)).toBe(true);
  });

  it('compares geometry rather than IDs, including extra collinear points in a semantic copy', () => {
    const map = world(), plan = map.world!.bundle.plan;
    plan.roads = [route('main', [[-30, 0], [30, 0]])];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [
      { id: 'mirror-with-another-id', name: 'Mirror', kind: 'trail', width: 4, points: [[30, 0], [0, 0], [-30, 0]] },
      { id: 'main', name: 'Distinct route with the same ID', kind: 'trail', width: 4, points: [[40, 0], [80, 0]] }
    ] };
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:main' }, 0).data.endpoints[1].nearestOtherCorridor)
      .toMatchObject({ reference: 'feature:main', gap: 6 });
    plan.featureGraph.paths[1].points = [[-30, 0], [0, 40], [30, 0]];
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:main' }, 1).data.endpoints[1].nearestOtherCorridor)
      .toMatchObject({ reference: 'feature:main', gap: 0 });
  });

  it('reports sampled water boundaries and coarsens a requested profile before allocation', () => {
    const map = world(x => x * 0.1);
    const result = observeMapDesign(map, { kind: 'path', points: [[-250, 0], [250, 0]], spacing: 0.25, limit: 8 }, 0);
    expect(result.data.sampleCount).toBe(512);
    expect(result.data.coarsened).toBe(true);
    expect(result.data.profile.items).toHaveLength(8);
    expect(result.data.events.items.some((event: { kind: string }) => event.kind === 'water-transition')).toBe(true);
    expect(result.data.waterSampleCount).toBe(256);
  });

  it('uses one canonical curve and town street coordinates and requires a source reference for ambiguous IDs', () => {
    const map = world(), plan = map.world!.bundle.plan;
    map.guides = [{ ...route('bend', [[-40, 0], [0, 30], [40, 0]]), curve: 'catmull-rom' }];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [{ id: 'bend', name: 'other', kind: 'trail', points: [[-10, -80], [10, -80]], width: 2 }] };
    const canonical = mapEnvironmentGuides(map)[0];
    expect(canonical.points).toEqual(mapGuidePolyline(map.guides[0]));
    expect(canonical.curve).toBe('polyline');
    expect(() => observeMapDesign(map, { kind: 'path', pathId: 'bend' }, 0)).toThrow('ambiguous_observation_path');
    expect(observeMapDesign(map, { kind: 'path', pathId: 'map:bend' }, 0).data.route.reference).toBe('map:bend');
    plan.towns = [{ id: 'town', name: 'Town', prompt: 'Town', center: [100, 80], radius: 50, blend: 20, foundation: 100, ports: [] }];
    map.world!.bundle.patches = [{ townId: 'town', worldKey: worldPlanKey(plan), summary: '', buildings: [], streets: [route('local', [[-10, 0], [10, 0]])] }];
    expect(mapEnvironmentGuides(map).find(path => path.reference === 'town:town:local')!.points).toEqual([[90, 80], [110, 80]]);
  });

  it('bounds and validates hostile queries rather than quietly truncating or sampling outside the map', () => {
    const map = world();
    for (const query of [
      { kind: 'points', points: [[undefined, 0]] }, { kind: 'points', points: [[NaN, 0]] },
      { kind: 'points', points: [[251, 0]] }, { kind: 'points', points: Array(129).fill([0, 0]) },
      { kind: 'region', bounds: [-10, -10, 10, 10], grid: 18 },
      { kind: 'summary', limit: 100000 }, { kind: 'summary', offset: -1 }, { kind: 'summary', secret: true },
      { kind: 'path', points: [[0, 0], [0, 0]] }, { kind: 'path', points: [[0, 0], [1, 0]], width: Infinity },
      { kind: 'objects', ids: ['missing'] }
    ]) expect(() => observeMapDesign(map, query, 0), JSON.stringify(query)).toThrow();
    expect(() => observeMapDesign(map, { kind: 'summary' }, -1)).toThrow('invalid_observation_revision');
  });
});
