import { getMapObjectAabbs, getMapObjectVisualAabbs, sampleTerrainHeight, type EditableMap } from './map';
import { mapGuidePolyline, type MapGuide } from './mapGuide';
import { combinedGrassDensity } from './mapGrass';
import { createMapEnvironmentSampler, mapEnvironmentGuides, type MapEnvironmentGuide } from './mapTerrainAnalysis';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';
import { worldMapSampler } from './worldMapState';
import { WORLD_BIOMES, worldRegionWeight } from './worldTerrain';
import { visualZoneWeight } from './visualDirection';
import { observeMapDesignDetails } from './mapDesignDetails';

type Point = [number, number];
type Bounds = [number, number, number, number];
type Query = Record<string, unknown>;
type Footprint = { reference: string; id: string; source: string; name: string; assetId: string | null;
  geometry: string; polygon: Point[]; bottom: number | null; top: number | null; entrance: null };

export const MAP_DESIGN_OBSERVATION_HELP = `observe reads the CURRENT complete draft without changing it. Query JSON:
{kind:'summary',offset?:0,limit?:32} lists paged regions, ecology rules, biome patches, grass-layer styles and density resolution/spacing, routes, settlements (including town-local ports and district offsets), groups and declared entrances; totals are unpaged.
{kind:'points',points:[[x,z],...],guideIds?:['id'],waterId?:'sea|existing-water-id'}: 1..128 samples.
{kind:'coverage',grid?:17,offset?:0,limit?:16}: reads the ENTIRE map in 16 spatial sectors with physical footprint counts, sample coverage and ecology masks. Semantic names and intentional open-area claims remain separate from actual contents.
{kind:'region',bounds:[minX,minZ,maxX,maxZ],grid?:9,offset?:0,limit?:64}: grid 2..17; sampled coverage, biome/forest-mask relationships and paged grid cells. Bounds must lie inside the map.
{kind:'path',pathId:'reference from summary OR unique route id',spacing?:4,maxGrade?:0.15,offset?:0,limit?:64}; alternatively supply points:[[x,z],...],curve?:'polyline'|'catmull-rom',closed?:false,width?:2 instead of pathId. At most 512 profile samples; actual spacing is reported. maxGrade is an optional designer-selected rise/run threshold, not a walkability rule. Reports terrain longitudinal grades, water transitions, threshold crossings, corridor endpoint gaps and declared access distances; it does NOT sample a bridge deck or prove controller traversal.
{kind:'objects',ids?:['exact reference OR id'],bounds?:[minX,minZ,maxX,maxZ],offset?:0,limit?:32}: object visual AABB footprints and town building planned oriented footprints, sampled ground relief/support and route gaps; full footprints, not center-only tests. Missing actual doorway data stays unknown.
{kind:'assets',ids?:['asset-id'],section?:'summary'|'parts'|'supports'|'materials'|'semantic',offset?:0,limit?:32}: actual stored asset geometry, candidate supports, authored material colors/explicit palette roles and generator semantic text. Semantic text is split into 2000-character chunks. Colors are model values, not rendered pixels; missing geometry remains unknown.
{kind:'world',section?:'overview'|'designSemantics'|'featureGraph'|'settlementPlan'|'mobilityPlan'|'explorationPlan'|'intentionalEmptyAreas'|'towns'|'roads'|'ecology'|'assets'|'patches',offset?:0,limit?:32}: shared design relationships, functional destinations, route intent, exact authored curves/ecology masks, asset bindings and town-local authored geometry. Declarations do not prove visual clarity or playability.
{kind:'terrain',section?:'overview'|'recipe'|'source'|'inspections',offset?:0,limit?:32}: actual storage resolution/spacing, paged recipe parameters, explicitly requested source chunks, or historical compiler observations. Source offsets count 2000-character chunks, not characters. No default height-array dump; use points/region to measure the current field. New detail pages may stop at a 24000-character record budget; continue at nextOffset.
All pages accept limit 1..64, offset 0..1000000. Results include mapVersion, draftRevision, units and precision. null distance means no match in the documented search range, NOT zero. Biome/ecology/grass fields are authoring/sample facts, not rendered instance counts or visibility. Reread after changing the draft; old observations retain their old revision.`;

/** Structured facts only: no style score, placement repair, persistent cache or mutation. */
export function observeMapDesign(map: EditableMap, input: unknown, draftRevision: number) {
  if (!Number.isInteger(draftRevision) || draftRevision < 0) throw new Error('invalid_observation_revision');
  const query = record(input), kind = query.kind ?? 'summary';
  const allowed: Record<string, string[]> = {
    summary: ['offset', 'limit'], points: ['points', 'guideIds', 'waterId'],
    region: ['bounds', 'grid', 'offset', 'limit'], coverage: ['grid', 'offset', 'limit'],
    path: ['pathId', 'points', 'curve', 'closed', 'width', 'spacing', 'maxGrade', 'offset', 'limit'],
    objects: ['ids', 'bounds', 'offset', 'limit'], assets: ['ids', 'section', 'offset', 'limit'],
    world: ['section', 'offset', 'limit'], terrain: ['section', 'offset', 'limit']
  };
  if (typeof kind !== 'string' || !Object.hasOwn(allowed, kind)
    || Object.keys(query).some(key => key !== 'kind' && !allowed[kind].includes(key))) throw new Error('invalid_observation_query');
  const offset = integer(query.offset, 0, 1_000_000, 0), limit = integer(query.limit, 1, 64, 32);
  const detailQuery = ['assets', 'world', 'terrain'].includes(kind);
  const paths = detailQuery ? [] : mapEnvironmentGuides(map), world = map.world, plan = world?.bundle.plan;
  const worldSample = world && !detailQuery ? worldMapSampler(world) : undefined;
  const guideIds = query.guideIds === undefined ? undefined : strings(query.guideIds, 64);
  const waterId = query.waterId === undefined ? undefined : id(query.waterId);
  if (guideIds?.some(key => !paths.some(path => path.id === key))) throw new Error('unknown_observation_guide');
  const environment = detailQuery ? undefined : createMapEnvironmentSampler(map, { guideIds, waterId });
  const page = <T>(items: T[]) => ({ total: items.length, offset, limit,
    nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });
  let footprintCache: Footprint[] | undefined;
  const footprints = () => footprintCache ??= observedFootprints(map);
  const sample = (point: Point) => {
    const [x, z] = point, reading = environment!(x, z), surface = worldSample?.(x, z);
    const localWater = map.waterBodies.find(water => isPointInsideWaterBody(water, x, z, map));
    const actualWater = localWater ? { id: localWater.id, surfaceHeight: waterSurfaceLevelAt(localWater, x, z),
      depth: Math.max(0, waterSurfaceLevelAt(localWater, x, z) - reading.height) }
      : surface && surface.waterLevel !== null ? { id: surface.waterBodyId ?? 'sea', surfaceHeight: surface.waterLevel,
        depth: Math.max(0, surface.waterLevel - surface.height) } : null;
    return { ...reading, water: actualWater, ...(waterId ? { requestedWater: reading.water } : {}),
      ...(surface ? { biomeWeights: surface.weights } : {}), grassDensity: combinedGrassDensity(map, x, z) };
  };
  const access = declaredAccess(map);
  const length = (path: MapGuide) => path.points.slice(1).reduce((sum, point, i) => sum + distance(point, path.points[i]), 0);
  const routeBrief = (path: MapEnvironmentGuide) => ({ reference: path.reference, id: path.id, source: path.source,
    name: path.name, width: path.width, length: length(path), endpoints: [path.points[0], path.points.at(-1)], tags: path.tags });
  let data: unknown;
  if (detailQuery) {
    data = observeMapDesignDetails(map, kind, query, offset, limit);
  } else if (kind === 'summary') {
    const all = footprints();
    data = { name: map.name, size: map.box.size, intent: map.designSemantics.intent,
      worldConcept: plan?.concept ?? null, generation: plan?.whitebox ? 'semantic-whitebox' : 'scene',
      counts: { objects: map.objects.length, visibleObjectFootprints: all.filter(item => item.source === 'map-object').length,
        townBuildings: all.filter(item => item.source === 'town-patch').length, paths: paths.length,
        ecologyRules: plan?.ecology.length ?? 0, biomePatches: plan?.recipe.biomePatches?.length ?? 0,
        grassLayers: map.grassLayers.length },
      routes: page(paths.map(routeBrief)), regions: page(plan?.featureGraph?.regions ?? []),
      ecologyRules: page((plan?.ecology ?? []).map(rule => ({ ...rule, region: compactRegion(rule.region),
        exclusions: rule.exclusions?.map(compactRegion),
        boundAssetIds: world!.assets.filter(asset => asset.role === 'tree'
          && (asset.ecologyRuleId === rule.id || !asset.ecologyRuleId && asset.ecologyKind === rule.kind)).map(asset => asset.assetId) }))),
      biomePatches: page((plan?.recipe.biomePatches ?? []).map(patch => ({ ...patch, region: compactRegion(patch.region) }))),
      grassLayers: page(map.grassLayers.map(layer => ({ id: layer.id, visible: layer.visible,
        preset: layer.preset, height: layer.height, mix: layer.mix,
        densityResolution: [layer.resolutionX, layer.resolutionZ],
        densitySpacing: [map.box.size[0] / (layer.resolutionX - 1), map.box.size[2] / (layer.resolutionZ - 1)] }))),
      climateConstraints: page(plan?.recipe.constraints ?? []),
      settlements: page((plan?.towns ?? []).map(town => ({ id: town.id, name: town.name, center: town.center,
        radius: town.radius, population: town.population ?? null, terrainMode: town.terrainMode,
        ports: town.ports, districts: town.districts ?? [],
        buildingCount: world!.bundle.patches.find(patch => patch.townId === town.id)?.buildings.length ?? 0 }))),
      intentionalEmptyAreas: page(plan?.intentionalEmptyAreas ?? []),
      designGroups: page(map.designSemantics.groups.map(group => ({ id: group.id, intent: group.intent, spatialRole: group.spatialRole,
        region: compactRegion(group.region), layers: group.layers, entryGuideIds: group.entryGuideIds, guideIds: group.guideIds }))),
      access: page(access), limits: ['Ecology rules describe candidate distribution, not realized canopy or renderer counts.',
        'Settlement ports.position and districts.offset are town-local; add settlement.center for world coordinates. radius is the square core half-width; district radii are circular.',
        'Semantic destinations and town ports are not measured doorways. Use objects and path queries for local geometry.'] };
  } else if (kind === 'points') {
    data = { samples: points(query.points, map, 128).map(sample) };
  } else if (kind === 'region' || kind === 'coverage') {
    const bounds = queryBounds(kind === 'coverage' ? [-map.box.size[0]/2, -map.box.size[2]/2, map.box.size[0]/2, map.box.size[2]/2] : query.bounds, map), grid = integer(query.grid, 2, 17, kind === 'coverage' ? 17 : 9);
    const all = footprints().filter(item => intersectsBounds(item.polygon, bounds));
    const samples = Array.from({ length: grid * grid }, (_, index) => {
      const point: Point = [bounds[0] + (index % grid) * (bounds[2] - bounds[0]) / (grid - 1),
        bounds[1] + Math.floor(index / grid) * (bounds[3] - bounds[1]) / (grid - 1)];
      const reading = sample(point), occupied = all.filter(item => insidePolygon(point, item.polygon));
      return { ...reading, occupiedFootprintCount: occupied.length, occupiedFootprints: occupied.slice(0, 8).map(item => item.reference),
        authoredSurfaceWeights: Object.fromEntries(['grass', 'rocky', 'soil', 'paving', 'clear', 'snow'].map(tag => [tag,
          Math.max(0, ...map.visualSemantics.zones.filter(zone => zone.tags.includes(tag as never)).map(zone => visualZoneWeight(zone, ...point)))])) };
    });
    const fraction = (predicate: (value: typeof samples[number]) => boolean) => samples.filter(predicate).length / samples.length;
    const sectors = kind === 'coverage' ? Array.from({length:16}, (_, index) => {
      const col=index%4, row=Math.floor(index/4), dx=(bounds[2]-bounds[0])/4, dz=(bounds[3]-bounds[1])/4;
      const box:Bounds=[bounds[0]+col*dx,bounds[1]+row*dz,bounds[0]+(col+1)*dx,bounds[1]+(row+1)*dz];
      const inside = (x:number,z:number) => x>=box[0] && z>=box[1] && (x<box[2] || col===3 && x===box[2]) && (z<box[3] || row===3 && z===box[3]);
      const readings=samples.filter(item=>inside(item.x,item.z));
      const objects=all.filter(item=>intersectsBounds(item.polygon,box));
      const fraction=(test:(reading:typeof samples[number])=>boolean)=>readings.length ? readings.filter(test).length/readings.length : null;
      const rules=(plan?.ecology ?? []).filter(rule=>world!.assets.some(asset=>asset.role==='tree' && (asset.ecologyRuleId===rule.id || !asset.ecologyRuleId && asset.ecologyKind===rule.kind)));
      const regions=(plan?.featureGraph?.regions ?? []).filter(region=>region.center[0]+region.radius>=box[0] && region.center[0]-region.radius<=box[2] && region.center[1]+region.radius>=box[1] && region.center[1]-region.radius<=box[3]);
      return {id:`sector-${col}-${row}`,bounds:box,sampleCount:readings.length,
        height:stats(readings.map(item=>item.height)),slopeDegrees:stats(readings.map(item=>item.slope)),waterFraction:fraction(item=>item.water!==null),
        physicalFootprints:objects.length,assetIds:[...new Set(objects.flatMap(item=>item.assetId ? [item.assetId] : []))],
        footprintSampleFraction:fraction(item=>item.occupiedFootprintCount>0),
        dryWithoutFootprintOrGuideFraction:fraction(item=>item.water===null && !item.occupiedFootprintCount && item.guideDistance>0),
        ecologyPotentialFraction:fraction(item=>item.water===null && rules.some(rule=>rule.density>0 && item.biomeWeights![rule.biome]>0 && item.slope<=rule.maxSlope && (!rule.region || worldRegionWeight(rule.region,item.x,item.z,rule.regionFeather)>0) && !(rule.exclusions ?? []).some(region=>worldRegionWeight(region,item.x,item.z)>0))),
        ecologyExcludedFraction:fraction(item=>rules.some(rule=>(!rule.region || worldRegionWeight(rule.region,item.x,item.z,rule.regionFeather)>0) && (rule.exclusions ?? []).some(region=>worldRegionWeight(region,item.x,item.z)>0))),
        declaredRegions:regions.map(region=>({id:region.id,name:region.name})),
        declaredOpenAreas:(plan?.intentionalEmptyAreas ?? []).filter(area=>regions.some(region=>region.id===area.regionId)),
        inspect:{kind:'region',bounds:box,grid:9}};
    }) : null;
    data = { ...(sectors ? {sectors:page(sectors)} : {}), bounds, grid, spacing: [(bounds[2] - bounds[0]) / (grid - 1), (bounds[3] - bounds[1]) / (grid - 1)],
      sampleCount: samples.length, height: stats(samples.map(item => item.height)), slopeDegrees: stats(samples.map(item => item.slope)),
      sampledCoverage: { waterFraction: fraction(item => item.water !== null), footprintFraction: fraction(item => item.occupiedFootprints.length > 0),
        guideCorridorFraction: fraction(item => item.guideDistance === 0),
        dryOutsideFootprintsAndGuidesFraction: fraction(item => item.water === null && !item.occupiedFootprints.length && item.guideDistance > 0),
        meanGrassDensity: mean(samples.map(item => item.grassDensity)),
        meanBiomeWeights: world ? Object.fromEntries(WORLD_BIOMES.map(biome => [biome, mean(samples.map(item => item.biomeWeights![biome]))])) : null },
      ecologySupport: (plan?.ecology ?? []).map(rule => ({ id: rule.id, kind: rule.kind, density: rule.density, spacing: rule.spacing,
        meanRegionWeight: mean(samples.map(item => rule.region ? worldRegionWeight(rule.region, item.x, item.z, rule.regionFeather) : 1)),
        sampledExcludedFraction: fraction(item => (rule.exclusions ?? []).some(region => worldRegionWeight(region, item.x, item.z, 0) > 0)),
        meanBiomeWeight: mean(samples.map(item => item.biomeWeights![rule.biome])),
        sampledSlopeEligibleFraction: fraction(item => item.slope <= rule.maxSlope),
        region: compactRegion(rule.region), regionFeather: rule.regionFeather ?? 0, scale: rule.scale,
        exclusions: (rule.exclusions ?? []).map(compactRegion),
        waterDistance: rule.waterDistance ?? null, waterSource: rule.waterSource ?? 'fresh' })),
      samples: page(samples),
      limits: ['Coverage is the fraction of grid sample points, not exact area; thin features can fall between cells.',
        'At most eight overlapping footprint references are listed per cell; occupiedFootprintCount is complete.',
        'Guides include semantic paths such as watercourses; corridor coverage is not exclusively built roads.',
        'Unoccupied samples do not prove playable empty space. Streamed ecology instances, overhangs and visibility are not evaluated.',
        'Sector footprints may intersect multiple sectors. Ecology potential means a bound rule has region/biome/slope support, not a rendered canopy count; water-distance habitat and renderer object masks are not evaluated. Region/open-area names are claims, not realized contents. Read inspect bounds for local detail.',
        'Ecology region/biome/slope factors are separate observations, not acceptance probabilities or rendered counts.'] };
  } else if (kind === 'objects') {
    const ids = query.ids === undefined ? undefined : strings(query.ids, 64);
    const bounds = query.bounds === undefined ? undefined : queryBounds(query.bounds, map);
    const all = footprints();
    if (ids?.some(key => !all.some(item => item.reference === key || item.id === key))) throw new Error('unknown_observation_object');
    const matching = all.filter(item => (!ids || ids.includes(item.reference) || ids.includes(item.id))
      && (!bounds || intersectsBounds(item.polygon, bounds)));
    const selection = page(matching);
    data = { ...selection, items: selection.items.map(item => {
      const center = polygonCenter(item.polygon);
      const probes = [center, ...item.polygon, ...item.polygon.map((point, index): Point => {
        const next = item.polygon[(index + 1) % item.polygon.length];
        return [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2];
      })].map(point => ({ position: point, height: sampleTerrainHeight(map, ...point) }));
      const heights = probes.map(probe => probe.height);
      const ground = stats(heights);
      return { ...item, ground: { ...ground, probes, bottomMinusGroundRange: item.bottom === null ? null
        : [item.bottom - ground.max, item.bottom - ground.min] },
        nearestGuideCorridor: nearestRouteToFootprint(item.polygon, paths) };
    }), limits: ['Map objects use projected visual AABBs; they can include empty space and are not collision meshes.',
      'Town patches use planned oriented footprints; generated asset geometry may differ. Guide corridors can include watercourses; inspect source/tags.',
      'Procedural foundations use their conservative collider envelope; their rendered terrain-dependent bottom is not measured.',
      'Support samples are nine terrain probes, not contact/overhang/structural validation. Doorways are unknown unless explicitly authored elsewhere.'] };
  } else {
    const hasId = query.pathId !== undefined;
    if (hasId === (query.points !== undefined)) throw new Error('observation_path_requires_id_or_points');
    let path: MapEnvironmentGuide;
    if (hasId) {
      if (['curve', 'closed', 'width'].some(key => query[key] !== undefined)) throw new Error('observation_existing_path_geometry_override');
      const key = id(query.pathId), matches = paths.filter(item => item.reference === key || item.id === key);
      if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous_observation_path_use_reference' : 'unknown_observation_path');
      path = matches[0];
    } else {
      if (query.curve !== undefined && !['polyline', 'catmull-rom'].includes(String(query.curve))
        || query.closed !== undefined && typeof query.closed !== 'boolean') throw new Error('invalid_observation_path');
      const guide: MapGuide = { id: 'candidate', name: 'Candidate path', points: points(query.points, map, 128, 2),
        curve: query.curve === 'catmull-rom' ? 'catmull-rom' : 'polyline', closed: query.closed === true,
        width: number(query.width, 0.1, 1024, 2), tags: [] };
      path = { ...guide, curve: 'polyline', closed: false, points: mapGuidePolyline(guide), reference: 'candidate', source: 'map-guide' };
    }
    const pathLength = length(path), spacing = number(query.spacing, 0.25, 100, 4);
    if (pathLength <= 1e-6) throw new Error('observation_path_has_no_length');
    const count = Math.min(512, Math.max(2, Math.ceil(pathLength / spacing) + 1));
    const maxGrade = query.maxGrade === undefined ? undefined : number(query.maxGrade, 0.001, 10, 0.15);
    const sampledPoints = samplePolyline(path.points, count), readings = sampledPoints.map(sample);
    const actualSpacing = pathLength / (count - 1);
    const profile = readings.map((reading, index) => ({ ...reading, distance: index * actualSpacing,
      gradeFromPrevious: index > 0 && actualSpacing > 0 ? (reading.height - readings[index - 1].height) / actualSpacing : null }));
    const events = profile.flatMap((reading, index) => {
      if (!index) return [];
      const previous = profile[index - 1], result: Array<{ index: number; position: Point; kind: string; distance: number }> = [];
      if (reading.water?.id !== previous.water?.id) result.push({ index, position: [reading.x, reading.z], kind: 'water-transition', distance: reading.distance });
      if (maxGrade !== undefined && (Math.abs(reading.gradeFromPrevious ?? 0) > maxGrade)
        !== (Math.abs(previous.gradeFromPrevious ?? 0) > maxGrade)) result.push({ index, position: [reading.x, reading.z],
        kind: Math.abs(reading.gradeFromPrevious ?? 0) > maxGrade ? 'grade-threshold-enter' : 'grade-threshold-exit', distance: reading.distance });
      return result;
    });
    const otherPaths = paths.filter(other => other.reference !== path.reference && !sameCenterline(path.points, other.points));
    data = { route: routeBrief(path), requestedSpacing: spacing, actualSpacing, sampleCount: count,
      coarsened: actualSpacing > spacing + 1e-6, maxGrade: maxGrade ?? null,
      absoluteGrade: stats(profile.flatMap(item => item.gradeFromPrevious === null ? [] : [Math.abs(item.gradeFromPrevious)])),
      waterSampleCount: readings.filter(reading => reading.water).length,
      endpoints: [path.points[0], path.points.at(-1)!].map(position => ({ position,
        nearestOtherCorridor: nearestRoute(position, otherPaths, path.width / 2),
        nearestDeclaredAccess: nearestAccess(position, access) })),
      declaredAccess: page(access.map(item => ({ ...item, routeDistance: pathDistance(item.position, path.points, path.width / 2) }))),
      profile: page(profile), events: page(events),
      limits: ['Profile follows sampled ground under the route, not bridge decks, stairs or controller collision.',
        'Endpoint neighbors exclude coincident centerlines within 0.0001m, including reversed semantic copies; summary retains every source.',
        'Threshold events locate sampled intervals, not exact discontinuities. Endpoint proximity is 2D only and does not prove a shared elevation or network traversal.'] };
  }
  return JSON.parse(JSON.stringify({ schemaVersion: 1, mapId: map.id, mapVersion: map.version, draftRevision, kind,
    source: world ? 'continuous-world-plan-and-current-draft' : 'current-map-draft',
    units: { position: 'metres; X/Z horizontal, Y up', slope: 'degrees', grade: 'rise/run', coverage: '0..1 sampled fraction' },
    precision: { height: world ? 'worldMapSampler including planned water and foundations; not rendered LOD triangles'
      : 'stored heightfield bilinear interpolation; rendered triangle and collision surfaces may differ',
      slope: world ? 'central differences with 4m offset' : 'central differences with stored cell spacing',
      waterDistance: world ? 'freshwater boundary plus approximate sea search: 24 rays, 160m range, cached 16m interpolation' : 'authored water boundary',
      grassDensity: 'stored density fields with bilinear interpolation; summary lists each field spacing in metres, not rendered blade spacing or coverage',
      paths: 'shared mapGuidePolyline approximation; 12 subdivisions per Catmull-Rom segment, bounded by guide point limit',
      nullDistances: 'No matching geometry or no water found within bounded search. Not zero.', numericRounding: '4 decimal places' }, data
  }, (_key, value) => typeof value === 'number' ? Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null : value));
}

function observedFootprints(map: EditableMap): Footprint[] {
  const objects = new Map(map.objects.map(object => [object.id, object]));
  const foundations = map.objects.some(object => object.visible && object.foundation)
    ? getMapObjectAabbs({ ...map, assets: [], objects: map.objects.map(object => object.foundation ? object : { ...object, visible: false }) }) : [];
  const result: Footprint[] = getMapObjectVisualAabbs(map).map(box => {
    const object = objects.get(box.objectId)!;
    const foundation = foundations.filter(item => item.objectId === object.id);
    if (foundation.length) box = { objectId: object.id,
      min: [Math.min(...foundation.map(item => item.min[0])), Math.min(...foundation.map(item => item.min[1])), Math.min(...foundation.map(item => item.min[2]))],
      max: [Math.max(...foundation.map(item => item.max[0])), Math.max(...foundation.map(item => item.max[1])), Math.max(...foundation.map(item => item.max[2]))] };
    return { reference: `object:${object.id}`, id: object.id, source: 'map-object', name: object.name, assetId: object.assetId,
      geometry: object.foundation ? 'procedural-foundation-collider-envelope'
        : object.assetId && !map.assets?.some(asset => asset.id === object.assetId) ? 'fallback-aabb-missing-asset' : 'visual-aabb',
      polygon: [[box.min[0], box.min[2]], [box.max[0], box.min[2]], [box.max[0], box.max[2]], [box.min[0], box.max[2]]],
      bottom: object.foundation ? null : box.min[1], top: object.foundation ? null : box.max[1], entrance: null };
  });
  for (const patch of map.world?.bundle.patches ?? []) {
    const town = map.world!.bundle.plan.towns.find(item => item.id === patch.townId)!;
    for (const building of patch.buildings) {
      const c = Math.cos(building.rotation ?? 0), s = Math.sin(building.rotation ?? 0);
      const polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dz]): Point => {
        const x = dx * building.width / 2, z = dz * building.depth / 2;
        return [town.center[0] + building.x + c * x + s * z, town.center[1] + building.z - s * x + c * z];
      });
      result.push({ reference: `building:${town.id}:${building.id}`, id: building.id, source: 'town-patch', name: building.use,
        assetId: map.world!.assets.find(asset => asset.key === building.assetKey)?.assetId ?? null,
        geometry: 'planned-oriented-footprint', polygon, bottom: null, top: null, entrance: null });
    }
  }
  return result;
}

function declaredAccess(map: EditableMap) {
  return [
    ...map.designSemantics.viewpoints.filter(item => item.role === 'entry').map(item => ({ id: item.id,
      source: 'declared-entry-viewpoint', position: item.point, routeId: null as string | null })),
    ...(map.world?.bundle.plan.featureGraph?.anchors ?? []).map(item => ({ id: item.id,
      source: 'semantic-anchor-not-doorway', position: item.position, routeId: null as string | null })),
    ...(map.world?.bundle.plan.towns ?? []).flatMap(town => town.ports.map(port => ({ id: `${town.id}:${port.id}`,
      source: 'town-port-not-doorway', position: [town.center[0] + port.position[0], town.center[1] + port.position[1]] as Point, routeId: port.guideId })))
  ];
}
function nearestAccess(point: Point, access: ReturnType<typeof declaredAccess>) {
  const sorted = access.map(item => ({ ...item, distance: distance(point, item.position) })).sort((a, b) => a.distance - b.distance);
  return sorted[0] ?? null;
}
function nearestRoute(point: Point, paths: MapEnvironmentGuide[], extraWidth = 0) {
  let nearest: ReturnType<typeof corridorReading> | null = null;
  for (const path of paths) {
    const gap = pathDistance(point, path.points, path.width / 2 + extraWidth);
    if (!nearest || gap < nearest.gap) nearest = corridorReading(path, gap);
  }
  return nearest;
}
function nearestRouteToFootprint(polygon: Point[], paths: MapEnvironmentGuide[]) {
  let nearest: ReturnType<typeof corridorReading> | null = null;
  for (const path of paths) {
    let gap = Math.min(...polygon.map(point => pathDistance(point, path.points, path.width / 2)));
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i];
      if (insidePolygon(a, polygon) || insidePolygon(b, polygon)) gap = 0;
      for (let j = 0; j < polygon.length; j++) {
        const c = polygon[j], d = polygon[(j + 1) % polygon.length];
        if (segmentsIntersect(a, b, c, d)) gap = 0;
        gap = Math.min(gap, Math.max(0, segmentDistance(a, c, d) - path.width / 2), Math.max(0, segmentDistance(b, c, d) - path.width / 2));
      }
    }
    if (!nearest || gap < nearest.gap) nearest = corridorReading(path, gap);
  }
  return nearest;
}
function corridorReading(path: MapEnvironmentGuide, gap: number) {
  return { reference: path.reference, name: path.name, source: path.source, tags: path.tags, gap };
}
/** Compare sampled geometry, not IDs or widths; collinear subdivisions do not create another corridor. */
function sameCenterline(a: Point[], b: Point[]): boolean {
  const tolerance = 0.0001;
  const compact = (points: Point[]) => {
    const result: Point[] = [];
    for (const point of points) {
      if (result.length && distance(result.at(-1)!, point) <= tolerance) continue;
      while (result.length > 1 && segmentDistance(result.at(-1)!, result.at(-2)!, point) <= tolerance) result.pop();
      result.push(point);
    }
    return result;
  };
  const left = compact(a), right = compact(b);
  return left.length === right.length && (left.every((point, index) => distance(point, right[index]) <= tolerance)
    || left.every((point, index) => distance(point, right[right.length - 1 - index]) <= tolerance));
}
function samplePolyline(points: Point[], count: number): Point[] {
  const lengths = points.slice(1).map((point, i) => distance(point, points[i]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let segment = 0, traversed = 0;
  return Array.from({ length: count }, (_, index) => {
    const distance = total * index / (count - 1);
    while (segment < lengths.length - 1 && traversed + lengths[segment] < distance) traversed += lengths[segment++];
    const a = points[segment], b = points[segment + 1] ?? a, t = lengths[segment] ? (distance - traversed) / lengths[segment] : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}
function pathDistance(point: Point, points: Point[], halfWidth: number) {
  let nearest = Infinity;
  for (let i = 1; i < points.length; i++) nearest = Math.min(nearest, segmentDistance(point, points[i - 1], points[i]));
  return Math.max(0, nearest - halfWidth);
}
function segmentDistance(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dz = b[1] - a[1], squared = dx * dx + dz * dz;
  const t = squared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / squared)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0
    && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
}
function insidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (segmentDistance(point, a, b) < 1e-8) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function intersectsBounds(polygon: Point[], bounds: Bounds) {
  const rectangle: Point[] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
  return polygon.some(point => insidePolygon(point, rectangle)) || rectangle.some(point => insidePolygon(point, polygon))
    || polygon.some((a, i) => rectangle.some((c, j) => segmentsIntersect(a, polygon[(i + 1) % polygon.length], c, rectangle[(j + 1) % rectangle.length])));
}
function polygonCenter(polygon: Point[]): Point { return [mean(polygon.map(p => p[0])), mean(polygon.map(p => p[1]))]; }
function distance(a: Point, b: Point) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stats(values: number[]) { return values.length ? { min: Math.min(...values), max: Math.max(...values), mean: mean(values) } : { min: 0, max: 0, mean: 0 }; }
function compactRegion(region: unknown) {
  if (!region || typeof region !== 'object') return region ?? null;
  const value = region as Record<string, unknown>;
  if (!Array.isArray(value.points) || value.points.length <= 16) return region;
  return { ...value, points: value.points.slice(0, 16), pointCount: value.points.length, pointsTruncated: true };
}
function record(input: unknown): Query {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_observation_query');
  return input as Query;
}
function number(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('invalid_observation_number');
  return value;
}
function integer(value: unknown, min: number, max: number, fallback: number) {
  const result = number(value, min, max, fallback);
  if (!Number.isInteger(result)) throw new Error('invalid_observation_integer');
  return result;
}
function id(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('invalid_observation_id');
  return value;
}
function strings(value: unknown, max: number) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error('invalid_observation_ids');
  return value.map(id);
}
function point(value: unknown, map: EditableMap): Point {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('invalid_observation_point');
  return [number(value[0], -map.box.size[0] / 2, map.box.size[0] / 2, NaN), number(value[1], -map.box.size[2] / 2, map.box.size[2] / 2, NaN)];
}
function points(value: unknown, map: EditableMap, max: number, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('invalid_observation_points');
  return value.map(item => point(item, map));
}
function queryBounds(value: unknown, map: EditableMap): Bounds {
  if (!Array.isArray(value) || value.length !== 4) throw new Error('invalid_observation_bounds');
  const a = point(value.slice(0, 2), map), b = point(value.slice(2), map);
  if (b[0] <= a[0] || b[1] <= a[1]) throw new Error('invalid_observation_bounds');
  return [...a, ...b];
}
