import { describe, expect, it } from 'vitest';
import type { TownPatch, WorldPlan } from '../src/shared/worldPlanning';
import {
  selectUsedWorldAssetRequests,
  type SchedulableWorldAssetRequest
} from '../src/server/worldAssetScheduling';

const asset = (
  key: string,
  role: SchedulableWorldAssetRequest['role'],
  ecologyRuleId?: string
): SchedulableWorldAssetRequest => ({ key, role, ...(ecologyRuleId ? { ecologyRuleId } : {}) });

const patch = (...buildings: Array<{ id: string; use: string; assetKey?: string }>) => ({
  buildings
} as Pick<TownPatch, 'buildings'>);

describe('world asset scheduling', () => {
  it('schedules used landmarks without paying for unrealized requests', () => {
    const requests = [
      asset('civic-service-house', 'landmark'),
      asset('fishing-cooperative', 'landmark')
    ];

    expect(selectUsedWorldAssetRequests(requests, { ecology: [] }, [
      patch({ id: 'clinic', use: 'community clinic', assetKey: 'civic-service-house' })
    ])).toEqual([requests[0]]);
  });

  it('keeps every ordinary family that can serve a realized role fallback', () => {
    const requests = [
      asset('house-a', 'house'),
      asset('house-b', 'house'),
      asset('shop', 'shop'),
      asset('workshop', 'workshop'),
      asset('unused-landmark', 'landmark')
    ];

    expect(selectUsedWorldAssetRequests(requests, { ecology: [] }, [patch(
      { id: 'home', use: 'family home' },
      { id: 'store', use: 'daily shop' },
      { id: 'repair', use: 'fishing workshop' }
    )])).toEqual(requests.slice(0, 4));
  });

  it('keeps ecology consumers even when no buildings were realized', () => {
    const requests = [
      asset('forest-tree', 'tree', 'forest'),
      asset('unused-shrub', 'tree', 'shrubland')
    ];
    const plan = { ecology: [{ id: 'forest' }] } as Pick<WorldPlan, 'ecology'>;

    expect(selectUsedWorldAssetRequests(requests, plan, [])).toEqual([requests[0]]);
  });
});
