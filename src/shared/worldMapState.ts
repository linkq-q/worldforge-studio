import { createPlannedWorldTerrainContext, validateWorldBundle, type WorldBundle } from './worldPlanning';
import type { WorldSampler, WorldTerrainContext } from './worldTerrain';

export interface WorldAssetBinding {
  key: string;
  assetId: string;
  role: 'house' | 'shop' | 'workshop' | 'tree' | 'landmark';
}
/** Persist intent and reusable assets; render/collision chunks are derived, never saved. */
export interface WorldMapState { bundle: WorldBundle; assets: WorldAssetBinding[] }

export function validateWorldMapState(input: unknown): WorldMapState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_world_map');
  const value = input as WorldMapState;
  if (Object.keys(value).some(key => !['bundle', 'assets'].includes(key))
    || !Array.isArray(value.assets) || value.assets.length > 64) throw new Error('invalid_world_map');
  const keys = new Set<string>();
  const assets = value.assets.map(binding => {
    if (!binding || Object.keys(binding).some(key => !['key', 'assetId', 'role'].includes(key))
      || typeof binding.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(binding.key)
      || keys.has(binding.key) || typeof binding.assetId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(binding.assetId)
      || !['house', 'shop', 'workshop', 'tree', 'landmark'].includes(binding.role)) throw new Error('invalid_world_asset_binding');
    keys.add(binding.key);
    return {key: binding.key, assetId: binding.assetId, role: binding.role};
  });
  const bundle = validateWorldBundle(value.bundle);
  // An empty pack is an explicit greybox preview; a partial pack must not
  // silently lose named architecture.
  if (assets.length) for (const patch of bundle.patches) for (const building of patch.buildings) {
    if (building.assetKey && !keys.has(building.assetKey)) throw new Error('world_missing_asset_binding:' + building.assetKey);
  }
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
