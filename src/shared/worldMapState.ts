import { createPlannedWorldTerrainContext, validateWorldBundle, type TownBuilding, type WorldBundle } from './worldPlanning';
import type { WorldSampler, WorldTerrainContext } from './worldTerrain';
import type { EcologyInstance, EcologyKind } from './worldEcology';

export interface WorldAssetBinding {
  key: string;
  assetId: string;
  role: 'house' | 'shop' | 'workshop' | 'tree' | 'landmark';
  ecologyKind?: EcologyKind;
  ecologyRuleId?: string;
}
export interface WorldAssetProposal {
  key: string;
  name: string;
  role: WorldAssetBinding['role'];
  prompt: string;
  dimensions?: [number, number, number];
  enterable?: boolean;
  strategy?: 'single' | 'assembly';
  existingAssetId?: string;
  ecologyKind?: EcologyKind;
  ecologyRuleId?: string;
}
export interface WorldBuildingReview {
  townId: string;
  id: string;
  use: string;
  width: number;
  depth: number;
  height: number;
  siting?: 'central' | 'waterfront' | 'gateway' | 'high-ground';
  placed: boolean;
}
export interface WorldGenerationReview {
  draftAssets: WorldAssetProposal[];
  plannedBuildings: WorldBuildingReview[];
  paidCallCount: number;
  diagnostics: string[];
  complete: boolean;
}
export const WORLD_ENTITY_KINDS = ['world', 'water', 'road', 'town', 'terrain-brush', 'biome-patch', 'ecology',
  'region', 'path', 'anchor', 'settlement', 'mobility-route', 'poi', 'intentional-empty'] as const;
export type WorldEntityKind = typeof WORLD_ENTITY_KINDS[number];
/** A semantic key identifies an entity; its display name can change independently. */
export interface WorldEntityReference { kind: WorldEntityKind; key: string; id: string; name: string }
export interface WorldEntityRow { kind: WorldEntityKind; id: string; ref: string; key: string | null; name: string }
/** Persist intent and the pending whitebox review; render/collision chunks are derived. */
export interface WorldMapState {
  bundle: WorldBundle; assets: WorldAssetBinding[]; review?: WorldGenerationReview; references?: WorldEntityReference[];
}

export function validateWorldEntityReferences(input: unknown): WorldEntityReference[] {
  if (!Array.isArray(input) || input.length > 2048) throw new Error('invalid_world_references');
  const semanticKeys = new Set<string>(), targetKeys = new Set<string>();
  return input.map((item: WorldEntityReference) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['kind', 'key', 'id', 'name'].includes(key))
      || !WORLD_ENTITY_KINDS.includes(item.kind)
      || typeof item.key !== 'string' || !item.key.trim() || item.key.length > 160
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160
      || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(item.id)) {
      throw new Error('invalid_world_reference');
    }
    const key = item.key.trim(), name = item.name.trim(), semanticKey = `${item.kind}\0${key}`;
    const targetKey = `${item.kind}\0${item.id}`;
    if (semanticKeys.has(semanticKey) || targetKeys.has(targetKey)) throw new Error('world_reference_identity_conflict');
    semanticKeys.add(semanticKey); targetKeys.add(targetKey);
    return {kind: item.kind, key, id: item.id, name};
  });
}

/** Enumerate authored entities, never unused declarations or guessed name aliases. */
export function worldEntityRows(world: WorldMapState): WorldEntityRow[] {
  const plan = world.bundle.plan;
  const groups: Array<[WorldEntityKind, Array<{id: string; name?: string}>]> = [
    ['world', [plan]], ['water', plan.recipe.waterBodies ?? []], ['road', plan.roads], ['town', plan.towns],
    ['terrain-brush', plan.recipe.terrainBrushes ?? []], ['biome-patch', plan.recipe.biomePatches ?? []],
    ['ecology', plan.ecology], ['region', plan.featureGraph?.regions ?? []], ['path', plan.featureGraph?.paths ?? []],
    ['anchor', plan.featureGraph?.anchors ?? []], ['settlement', plan.settlementPlan?.settlements ?? []],
    ['mobility-route', plan.mobilityPlan?.routes ?? []], ['poi', plan.explorationPlan?.pointsOfInterest ?? []],
    ['intentional-empty', plan.intentionalEmptyAreas ?? []]
  ];
  return groups.flatMap(([kind, entities]) => entities.map(entity => {
    const reference = world.references?.find(item => item.kind === kind && item.id === entity.id);
    return {kind, id: entity.id, ref: entity.id, key: reference?.key ?? null,
      name: entity.name ?? reference?.name ?? entity.id};
  }));
}

export function worldBuildingRole(building: Pick<TownBuilding, 'use'>): WorldAssetBinding['role'] {
  if (/landmark|castle|cathedral|palace|hall|驿|堡|宫|教堂|地标/i.test(building.use)) return 'landmark';
  if (/工|仓|农具|workshop|factory/i.test(building.use)) return 'workshop';
  if (/商|店|客|shop|market|inn/i.test(building.use)) return 'shop';
  return 'house';
}

export function validateWorldMapState(input: unknown): WorldMapState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_world_map');
  const value = input as WorldMapState;
  if (Object.keys(value).some(key => !['bundle', 'assets', 'review', 'references'].includes(key))
    || !Array.isArray(value.assets) || value.assets.length > 64) throw new Error('invalid_world_map');
  const keys = new Set<string>();
  const assets = value.assets.map(binding => {
    if (!binding || Object.keys(binding).some(key => !['key', 'assetId', 'role', 'ecologyKind', 'ecologyRuleId'].includes(key))
      || typeof binding.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(binding.key)
      || keys.has(binding.key) || typeof binding.assetId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(binding.assetId)
      || !['house', 'shop', 'workshop', 'tree', 'landmark'].includes(binding.role)
      || binding.ecologyKind !== undefined && !['broadleaf', 'pine', 'shrub', 'rock'].includes(binding.ecologyKind)
      || binding.ecologyRuleId !== undefined && (typeof binding.ecologyRuleId !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(binding.ecologyRuleId))
      || binding.role !== 'tree' && (binding.ecologyKind !== undefined || binding.ecologyRuleId !== undefined)) {
      throw new Error('invalid_world_asset_binding');
    }
    keys.add(binding.key);
    return {key: binding.key, assetId: binding.assetId, role: binding.role,
      ...(binding.ecologyKind ? {ecologyKind: binding.ecologyKind} : {}),
      ...(binding.ecologyRuleId ? {ecologyRuleId: binding.ecologyRuleId} : {})};
  });
  const bundle = validateWorldBundle(value.bundle);
  for (const binding of assets) if (binding.ecologyRuleId) {
    const rule = bundle.plan.ecology.find(candidate => candidate.id === binding.ecologyRuleId);
    if (!rule || binding.ecologyKind && binding.ecologyKind !== rule.kind) throw new Error('invalid_world_asset_binding');
  }
  // An unbound explicit building keeps its authored footprint as a greybox.
  const review = value.review === undefined ? undefined : validateWorldGenerationReview(value.review, bundle);
  let references: WorldEntityReference[] | undefined;
  if (value.references !== undefined) {
    references = validateWorldEntityReferences(value.references);
    const targets = new Set(worldEntityRows({bundle, assets}).map(item => `${item.kind}\0${item.id}`));
    if (references.some(item => !targets.has(`${item.kind}\0${item.id}`))) throw new Error('unknown_world_reference_target');
  }
  return {bundle, assets, ...(review ? {review} : {}), ...(references ? {references} : {})};
}

function validateWorldGenerationReview(input: unknown, bundle: WorldBundle): WorldGenerationReview {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_world_review');
  const value = input as WorldGenerationReview;
  if (Object.keys(value).some(key => !['draftAssets', 'plannedBuildings', 'paidCallCount', 'diagnostics', 'complete'].includes(key))
    || !Array.isArray(value.draftAssets) || value.draftAssets.length > 64
    || !Array.isArray(value.plannedBuildings) || value.plannedBuildings.length > 768
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > 1024
    || value.diagnostics.some(item => typeof item !== 'string' || item.length > 1024)
    || !Number.isInteger(value.paidCallCount) || value.paidCallCount < 0 || value.paidCallCount > 100
    || typeof value.complete !== 'boolean') throw new Error('invalid_world_review');
  const id = (text: unknown) => typeof text === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(text);
  const size = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 300;
  const draftAssets = value.draftAssets.map(asset => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
      || Object.keys(asset).some(key => !['key', 'name', 'role', 'prompt', 'dimensions', 'enterable', 'strategy',
        'existingAssetId', 'ecologyKind', 'ecologyRuleId'].includes(key))
      || !id(asset.key) || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 160
      || !['house', 'shop', 'workshop', 'tree', 'landmark'].includes(asset.role)
      || typeof asset.prompt !== 'string' || !asset.prompt.trim() || asset.prompt.length > 6000
      || asset.dimensions !== undefined && (!Array.isArray(asset.dimensions)
        || asset.dimensions.length !== 3 || !asset.dimensions.every(size))
      || asset.enterable !== undefined && typeof asset.enterable !== 'boolean'
      || asset.strategy !== undefined && !['single', 'assembly'].includes(asset.strategy)
      || asset.existingAssetId !== undefined && !id(asset.existingAssetId)
      || asset.ecologyKind !== undefined && !['broadleaf', 'pine', 'shrub', 'rock'].includes(asset.ecologyKind)
      || asset.ecologyRuleId !== undefined && !id(asset.ecologyRuleId)) throw new Error('invalid_world_review_asset');
    return {...asset};
  });
  if (new Set(draftAssets.map(asset => asset.key)).size !== draftAssets.length
    || draftAssets.filter(asset => !asset.existingAssetId).length > 3) throw new Error('invalid_world_review_asset');
  const townIds = new Set(bundle.plan.towns.map(town => town.id));
  const plannedBuildings = value.plannedBuildings.map(building => {
    if (!building || typeof building !== 'object' || Array.isArray(building)
      || Object.keys(building).some(key => !['townId', 'id', 'use', 'width', 'depth', 'height', 'siting', 'placed'].includes(key))
      || !townIds.has(building.townId) || !id(building.id)
      || typeof building.use !== 'string' || !building.use.trim() || building.use.length > 160
      || !size(building.width) || !size(building.depth) || !size(building.height)
      || building.siting !== undefined && !['central', 'waterfront', 'gateway', 'high-ground'].includes(building.siting)
      || typeof building.placed !== 'boolean') throw new Error('invalid_world_review_building');
    return {...building};
  });
  return {draftAssets, plannedBuildings, paidCallCount: value.paidCallCount,
    diagnostics: [...value.diagnostics], complete: value.complete};
}

const contexts = new WeakMap<WorldMapState, WorldTerrainContext>();
export function worldMapTerrainContext(world: WorldMapState): WorldTerrainContext {
  let context = contexts.get(world);
  if (!context) {
    context = createPlannedWorldTerrainContext(world.bundle.plan, world.bundle.patches);
    contexts.set(world, context);
  }
  return context;
}
export function worldMapSampler(world: WorldMapState): WorldSampler {
  return worldMapTerrainContext(world).sample;
}

export function selectWorldEcologyAsset<T extends Pick<WorldAssetBinding, 'role' | 'ecologyKind' | 'ecologyRuleId'>>(
  assets: readonly T[],
  instance: Pick<EcologyInstance, 'id' | 'ruleId' | 'kind'>
): T | undefined {
  const trees = assets.filter(asset => asset.role === 'tree');
  const exactRule = trees.filter(asset => asset.ecologyRuleId === instance.ruleId);
  if (exactRule.length) return exactRule[stableIndex(instance.id, exactRule.length)];
  const exactKind = trees.filter(asset => !asset.ecologyRuleId && asset.ecologyKind === instance.kind);
  if (exactKind.length) return exactKind[stableIndex(instance.id, exactKind.length)];
  if (instance.kind !== 'broadleaf' && instance.kind !== 'pine') return undefined;
  const legacy = trees.filter(asset => !asset.ecologyRuleId && !asset.ecologyKind);
  return legacy[stableIndex(instance.id, legacy.length)];
}

function stableIndex(id: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return count ? (hash >>> 0) % count : 0;
}
