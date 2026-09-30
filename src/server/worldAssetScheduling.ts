import { worldBuildingRole, type WorldAssetBinding } from '../shared/worldMapState';
import type { TownPatch, WorldPlan } from '../shared/worldPlanning';

export interface SchedulableWorldAssetRequest {
  key: string;
  role: WorldAssetBinding['role'];
  ecologyRuleId?: string;
}

export function selectUsedWorldAssetRequests<T extends SchedulableWorldAssetRequest>(
  requests: readonly T[],
  plan: Pick<WorldPlan, 'ecology'>,
  patches: readonly Pick<TownPatch, 'buildings'>[]
): T[] {
  const explicitKeys = new Set<string>();
  const fallbackRoles = new Set<WorldAssetBinding['role']>();
  for (const { buildings } of patches) for (const building of buildings) {
    if (building.assetKey) explicitKeys.add(building.assetKey);
    else fallbackRoles.add(worldBuildingRole(building));
  }
  const ecologyRuleIds = new Set(plan.ecology.map(rule => rule.id));
  return requests.filter(request => explicitKeys.has(request.key)
    || fallbackRoles.has(request.role)
    || request.role === 'tree' && !!request.ecologyRuleId && ecologyRuleIds.has(request.ecologyRuleId));
}
