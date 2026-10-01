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
/** Persist intent and reusable assets; render/collision chunks are derived, never saved. */
export interface WorldMapState { bundle: WorldBundle; assets: WorldAssetBinding[] }

export function worldBuildingRole(building: Pick<TownBuilding, 'use'>): WorldAssetBinding['role'] {
  if (/landmark|castle|cathedral|palace|hall|驿|堡|宫|教堂|地标/i.test(building.use)) return 'landmark';
  if (/工|仓|农具|workshop|factory/i.test(building.use)) return 'workshop';
  if (/商|店|客|shop|market|inn/i.test(building.use)) return 'shop';
  return 'house';
}

export function validateWorldMapState(input: unknown): WorldMapState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_world_map');
  const value = input as WorldMapState;
  if (Object.keys(value).some(key => !['bundle', 'assets'].includes(key))
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
  return {bundle, assets};
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
