import type { EditableMap, MapAsset } from './map';
import { inspectModelSpace } from './modelBounds';
import { worldEntityRows } from './worldMapState';

const TEXT_CHUNK_SIZE = 2000;
const PAGE_CHAR_BUDGET = 24_000;
type RecordValue = Record<string, unknown>;

/** A detail page preserves whole records; nextOffset includes records omitted by the character budget. */
function page<T>(records: T[], offset: number, limit: number) {
  const items: T[] = [];
  let characters = 0;
  for (const item of records.slice(offset, offset + limit)) {
    const size = JSON.stringify(item).length;
    if (characters + size > PAGE_CHAR_BUDGET) {
      if (!items.length) throw new Error('observation_record_out_of_budget');
      break;
    }
    characters += size;
    items.push(item);
  }
  return { total: records.length, offset, limit, items,
    nextOffset: offset + items.length < records.length ? offset + items.length : null,
    truncated: offset + items.length < records.length, characterBudget: PAGE_CHAR_BUDGET };
}

function section(value: unknown, allowed: string[], fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('invalid_observation_section');
  return value;
}

function textChunks(text: string) {
  return Array.from({ length: Math.ceil(text.length / TEXT_CHUNK_SIZE) }, (_, index) => ({
    characterOffset: index * TEXT_CHUNK_SIZE, totalCharacters: text.length,
    text: text.slice(index * TEXT_CHUNK_SIZE, (index + 1) * TEXT_CHUNK_SIZE)
  }));
}

const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : undefined;

export function observeMapDesignDetails(map: EditableMap, kind: string, query: RecordValue, offset: number, limit: number) {
  if (kind === 'assets') return observeAssets(map, query, offset, limit);
  if (kind === 'world') return observeWorld(map, query, offset, limit);
  return observeTerrain(map, query, offset, limit);
}

function observeAssets(map: EditableMap, query: RecordValue, offset: number, limit: number) {
  const selectedSection = section(query.section, ['summary', 'parts', 'supports', 'materials', 'semantic'], 'summary');
  const ids = query.ids;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 64
    || ids.some(id => typeof id !== 'string' || !id || id.length > 256))) throw new Error('invalid_observation_ids');
  const available = map.assets ?? [];
  if (Array.isArray(ids) && ids.some(id => !available.some(asset => asset.id === id))) throw new Error('unknown_observation_asset');
  const assets = available.filter(asset => !Array.isArray(ids) || ids.includes(asset.id));
  const records: unknown[] = [];
  for (const asset of assets) {
    const identity = { assetId: asset.id, assetUpdatedAt: asset.updatedAt, generationMode:asset.mode, provider:asset.provider ?? null };
    const meta = record(record(asset.modelJson)?._meta);
    if (selectedSection === 'semantic') {
      const snapshot = record(meta?.semanticSnapshot), text = typeof snapshot?.text === 'string' ? snapshot.text : '';
      records.push(...textChunks(text).map(chunk => ({ ...identity, ...chunk, source: 'stored-asset-semantic-snapshot',
        coordinateSpace: 'model-local', evidence: 'generator-authored-description; not independent geometry measurement' })));
      continue;
    }
    if (selectedSection === 'materials') {
      records.push(...materialFacts(asset).map(item => ({ ...identity, ...item })));
      continue;
    }
    const space = inspectModelSpace(asset.modelJson);
    if (selectedSection === 'parts' || selectedSection === 'supports') {
      records.push(...(selectedSection === 'parts' ? space.parts : space.supportSurfaces).map(item => ({ ...identity, ...item,
        source: selectedSection === 'parts' ? 'stored-model-geometry' : 'geometry-flat-box-top-candidate', coordinateSpace: 'model-local' })));
      continue;
    }
    const palette = record(meta?.colorPalette), snapshot = record(meta?.semanticSnapshot);
    records.push({ ...identity, name: asset.name, tags: asset.tags ?? [], source: 'stored-asset',
      geometry: { evidence: space.evidence, interior: space.interior, localBounds: space.localBounds,
        size: space.localBounds ? space.localBounds.max.map((value, axis) => value - space.localBounds!.min[axis]) : null,
        coordinateSpace: 'centered-XZ, floor-aligned model-local; before instance transform',
        primitiveCounts: Object.fromEntries((Array.isArray(record(asset.modelJson)?.nodes) ? record(asset.modelJson)!.nodes as unknown[] : []).reduce((counts: Map<string,number>, node) => {
          const type = record(record(node)?.mesh)?.type;
          if (typeof type === 'string') counts.set(type, (counts.get(type) ?? 0) + 1);
          return counts;
        }, new Map<string,number>())),
        partCount: space.parts.length, supportCandidateCount: space.supportSurfaces.length },
      semantic: { available: typeof snapshot?.text === 'string',
        totalCharacters: typeof snapshot?.text === 'string' ? snapshot.text.length : 0 },
      materialColorCount: materialFacts(asset).length,
      palette: palette ? { id: palette.id, name: palette.name, version: palette.version,
        colorCount: Array.isArray(palette.colors) ? palette.colors.length : 0 } : null });
  }
  return { section: selectedSection, ...page(records, offset, limit), availableAssetCount: available.length,
    limits: ['Stored material colors are not rendered pixel colors. Lighting, textures and the active render scheme are not evaluated.',
      'Material roles are explicit palette tags, including their declaring node; no role is inferred from a name.',
      'Raw color means the current stored model value. Pre-palette colors are unknown after destructive palette snapping.',
      'Support surfaces are flat box-top candidates, not verified free or load-bearing surfaces. Interior and doorways remain unknown.',
      'Semantic descriptions are stored generator claims and may disagree with measured geometry. Empty sections contain no stored evidence.'] };
}

/** Read the same node/material color locations used by the existing palette adapter, without assigning roles. */
function materialFacts(asset: MapAsset) {
  const model = record(asset.modelJson), nodes: RecordValue[] = [], visited = new Set<object>();
  const pending: unknown[] = [model?.nodes, model?.meshes, model?.parts].flatMap(value => Array.isArray(value) ? value : []);
  while (pending.length) {
    const node = record(pending.pop());
    if (!node || visited.has(node)) continue;
    visited.add(node);
    nodes.push(node);
    if (Array.isArray(node.children)) pending.push(...node.children);
  }
  const byId = new Map(nodes.filter(node => typeof node.id === 'string').map(node => [node.id, node]));
  const role = (node: RecordValue) => {
    const seen = new Set<object>();
    let current: RecordValue | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const tag = (Array.isArray(current.tags) ? current.tags : []).map(record).find(tag => tag?.tag === 'palette');
      if (tag && typeof tag.value === 'string') return { value: tag.value, sourceNodeId: current.id ?? null };
      current = typeof current.parent === 'string' ? byId.get(current.parent) : undefined;
    }
    return null;
  };
  const result: RecordValue[] = [];
  for (const node of nodes) {
    const mesh = record(node.mesh), material = record(mesh?.material) ?? record(node.material);
    const add = (value: unknown, location: string) => {
      if (typeof value !== 'string' && typeof value !== 'number' && !Array.isArray(value)) return;
      if (Array.isArray(value) && (value.length > 4 || !value.every(channel => typeof channel === 'number'))) return;
      result.push({ nodeId: node.id ?? null, location, rawColor: value, paletteRole: role(node), source: 'stored-model-material' });
    };
    add(material?.color, mesh?.material ? 'mesh.material.color' : 'material.color');
    add(mesh?.color, 'mesh.color');
    add(node.color, 'color');
    if (Array.isArray(node.vertexColors)) node.vertexColors.forEach((color, index) => add(color, `vertexColors[${index}]`));
    for (const key of ['shapes', 'voxels', 'boxes']) {
      if (Array.isArray(node[key])) node[key].forEach((item, index) => add(record(item)?.color, `${key}[${index}].color`));
    }
  }
  return result;
}

function observeWorld(map: EditableMap, query: RecordValue, offset: number, limit: number) {
  const sections = ['overview', 'designSemantics', 'featureGraph', 'settlementPlan', 'mobilityPlan', 'explorationPlan',
    'intentionalEmptyAreas', 'towns', 'roads', 'ecology', 'assets', 'patches', 'references'];
  const selectedSection = section(query.section, sections, 'overview'), world = map.world, plan = world?.bundle.plan;
  const identity = { worldPlanId: plan?.id ?? null, worldPlanRevision: plan?.revision ?? null,
    experienceMode: map.designSemantics.experienceMode, intent: map.designSemantics.intent,
    source: 'stored-design-declarations-and-current-world-plan' };
  const records: RecordValue[] = [];
  const add = (collection: string, values: unknown[]) => records.push(...values.map(value => ({ collection, value })));
  if (selectedSection === 'references') return {...identity, section: selectedSection,
    ...page(world ? worldEntityRows(world) : [], offset, limit),
    limits: ['ref is the exact storage ID accepted by world relationship fields. key is immutable semantic identity; name is a display label.']};
  if (selectedSection === 'overview') {
    return { ...identity, concept: plan?.concept ?? null, sections,
      counts: { groups: map.designSemantics.groups.length, relations: map.designSemantics.relations.length,
        focuses: map.designSemantics.focuses.length, assemblies: map.designSemantics.assemblies.length,
        regions: plan?.featureGraph?.regions.length ?? 0, anchors: plan?.featureGraph?.anchors.length ?? 0,
        mobilityRoutes: plan?.mobilityPlan?.routes.length ?? 0, pointsOfInterest: plan?.explorationPlan?.pointsOfInterest.length ?? 0,
        assetBindings: world?.assets.length ?? 0, townPatches: world?.bundle.patches.length ?? 0 },
      limits: ['Design roles and intended relationships are declarations, not visual recognition or proof of gameplay completion.'] };
  }
  if (selectedSection === 'designSemantics') {
    for (const key of ['groups', 'assemblies', 'focuses', 'viewpoints', 'relations'] as const) add(key, map.designSemantics[key]);
  } else if (selectedSection === 'featureGraph') {
    for (const key of ['regions', 'paths', 'anchors', 'relations'] as const) add(key, plan?.featureGraph?.[key] ?? []);
  } else if (selectedSection === 'settlementPlan') add('settlements', plan?.settlementPlan?.settlements ?? []);
  else if (selectedSection === 'mobilityPlan') add('routes', plan?.mobilityPlan?.routes ?? []);
  else if (selectedSection === 'explorationPlan') add('pointsOfInterest', plan?.explorationPlan?.pointsOfInterest ?? []);
  else if (selectedSection === 'intentionalEmptyAreas') add('intentionalEmptyAreas', plan?.intentionalEmptyAreas ?? []);
  else if (selectedSection === 'towns') add('towns', plan?.towns ?? []);
  else if (selectedSection === 'roads') add('roads', plan?.roads ?? []);
  else if (selectedSection === 'ecology') add('ecology', plan?.ecology ?? []);
  else if (selectedSection === 'assets') add('bindings', world?.assets ?? []);
  else for (const patch of world?.bundle.patches ?? []) {
    const town = plan!.towns.find(town => town.id === patch.townId);
    for (const key of ['streets', 'buildings'] as const) for (const value of patch[key]) records.push({
      collection: key, townId: patch.townId, worldKey: patch.worldKey, center: town?.center ?? null, coordinateSpace: 'town-local-XZ', value
    });
  }
  return { ...identity, section: selectedSection, ...page(records, offset, limit),
    ...(selectedSection === 'explorationPlan' ? { sequence: plan?.explorationPlan?.sequence ?? [] } : {}),
    limits: ['Relations, destinations and asset-role bindings are stored declarations, not measured visual clarity or reachability.',
      'Patch street and building positions are town-local; add the returned center to obtain world X/Z coordinates.'] };
}

function observeTerrain(map: EditableMap, query: RecordValue, offset: number, limit: number) {
  const selectedSection = section(query.section, ['overview', 'recipe', 'source', 'inspections'], 'overview');
  const recipe = map.world?.bundle.plan.recipe, program = recipe?.terrainProgram;
  const resolution = program ? [program.resolution, program.resolution] : recipe ? null : [map.terrain.resolutionX, map.terrain.resolutionZ];
  const size = recipe ? [recipe.size, recipe.size] : [map.box.size[0], map.box.size[2]];
  const metadata = { representation: program ? 'terrain-program' : recipe ? 'continuous-recipe' : 'stored-heightfield',
    source: { available: Boolean(program), totalCharacters: program?.source.length ?? 0, chunkCharacters: TEXT_CHUNK_SIZE },
    worldPlanRevision: map.world?.bundle.plan.revision ?? null, terrainRevision: program?.terrainRevision ?? null, resolution,
    spacing: resolution ? size.map((value, axis) => value / (resolution[axis] - 1)) : null,
    size, seaLevel: 0, seed: recipe?.seed ?? map.seed, inspectionCount: program?.observations.length ?? 0 };
  const limits = ['Stored field spacing is not renderer LOD or controller collision precision. Continuous recipes have no single stored grid spacing.',
    'Recipe and program source describe construction; points/region queries measure the current field after world water and foundation effects.',
    'Program inspections are historical. Legacy records do not retain sample coordinates or pass revision, so freshness is unknown.',
    'Inspection freshness compares terrain-program revisions only; later world water, brushes and foundations can change the sampled scene. Inspection points outside the stored field are clamped to its boundary.',
    'No persisted erosion flow, sediment or debris layers exist in this representation. Do not infer those fields from height alone.'];
  if (selectedSection === 'overview') return { ...metadata, limits };
  let records: unknown[];
  if (selectedSection === 'source') records = textChunks(program?.source ?? '').map(chunk => ({ ...chunk, source: 'stored-terrain-program-source' }));
  else if (selectedSection === 'inspections') records = (program?.observations ?? []).map(value => ({ ...value,
    points: value.points ?? null, capturedTerrainRevision: value.terrainRevision ?? null,
    freshness: value.terrainRevision === undefined || program?.terrainRevision === undefined ? 'unknown'
      : value.terrainRevision === program.terrainRevision ? 'current-program-field' : 'superseded-program-field',
    source: 'stored-terrain-program-inspection' }));
  else {
    records = recipe ? [{ collection: 'parameters', value: { version: recipe.version, seed: recipe.seed, size: recipe.size,
      reliefProfile: recipe.reliefProfile ?? 'legacy', heightScale: recipe.heightScale ?? 1 } }] : [];
    for (const key of ['constraints', 'landforms', 'terrainBrushes', 'waterBodies', 'biomePatches'] as const) {
      records.push(...(recipe?.[key] ?? []).map(value => ({ collection: key, value })));
    }
  }
  return { ...metadata, section: selectedSection, ...page(records, offset, limit), limits };
}
