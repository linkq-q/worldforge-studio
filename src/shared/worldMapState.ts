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
/** Persist intent and the pending whitebox review; render/collision chunks are derived. */
export interface WorldMapState { bundle: WorldBundle; assets: WorldAssetBinding[]; review?: WorldGenerationReview }

export function worldBuildingRole(building: Pick<TownBuilding, 'use'>): WorldAssetBinding['role'] {
  if (/landmark|castle|cathedral|palace|hall|驿|堡|宫|教堂|地标/i.test(building.use)) return 'landmark';
  if (/工|仓|农具|workshop|factory/i.test(building.use)) return 'workshop';
  if (/商|店|客|shop|market|inn/i.test(building.use)) return 'shop';
  return 'house';
}

export function validateWorldMapState(input: unknown): WorldMapState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_world_map');
  const value = input as WorldMapState;
  if (Object.keys(value).some(key => !['bundle', 'assets', 'review'].includes(key))
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
  return {bundle, assets, ...(review ? {review} : {})};
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
