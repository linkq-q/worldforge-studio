import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { WORLD_AGENT_MAX_TOOL_CALLS, WorldAgentRunManager } from '../src/server/worldAgentRuns';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('world Agent draft runs', () => {
  it('previews consecutive tool calls and commits them as one approved transaction', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: 'Agent town', size: [72, 12, 72] });
    const manager = new WorldAgentRunManager(store);
    const run = await manager.create(map.id);
    const streets = manager.execute(run.id, 'settlement.create-street-grid', townInput());
    const routeId = streets.map.guides[0].id;
    const preview = manager.execute(run.id, 'roadside.decorate-route', {
      routeId,
      name: '路灯',
      spacing: 8,
      offset: 2,
      side: 'both'
    });

    expect(preview.run.toolCallCount).toBe(2);
    expect(preview.run.operationCount).toBeGreaterThan(2);
    expect(preview.map.objects.every((object) => object.sourceGuideId === routeId)).toBe(true);
    await expect(manager.commit(run.id, false)).rejects.toThrow('world_agent_approval_required');

    const committed = await manager.commit(run.id, true, 'Build compact town skeleton');
    const persisted = await store.loadMap(map.id);

    expect(committed.transaction.source).toBe('agent');
    expect(committed.transaction.operationCount).toBe(preview.operations.length);
    expect(persisted.guides.length).toBe(preview.map.guides.length);
    expect(persisted.objects.every((object) => object.sourceGuideId === routeId)).toBe(true);
    expect(() => manager.get(run.id)).toThrow('unknown_world_agent_run');
  });

  it('rejects a stale draft atomically when the base map changed', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: 'Base', size: [72, 12, 72] });
    const manager = new WorldAgentRunManager(store);
    const run = await manager.create(map.id);
    manager.execute(run.id, 'topology.create-route-network', routeNetworkInput('route-a'));
    await store.replaceMap(map.id, { ...map, name: 'Manual edit' });

    await expect(manager.commit(run.id, true)).rejects.toThrow('world_agent_run_stale');
    expect((await store.loadMap(map.id)).guides).toHaveLength(0);
  });

  it('enforces the bounded tool-call budget', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: 'Bounded', size: [72, 12, 72] });
    const manager = new WorldAgentRunManager(store);
    const run = await manager.create(map.id);
    for (let index = 0; index < WORLD_AGENT_MAX_TOOL_CALLS; index += 1) {
      manager.execute(run.id, 'topology.create-route-network', routeNetworkInput(`route-${index}`));
    }

    expect(() => manager.execute(run.id, 'topology.create-route-network', routeNetworkInput('overflow')))
      .toThrow('world_agent_tool_limit');
  });
});

function townInput() {
  return {
    id: 'town',
    region: [[-26, -24], [26, -24], [26, 24], [-26, 24]],
    direction: 0,
    blockWidth: 12,
    blockDepth: 10,
    roadWidth: 3,
    surface: 'paving'
  };
}

function routeNetworkInput(id: string) {
  return {
    id,
    nodes: [{ id: 'a', point: [-10, 0] }, { id: 'b', point: [10, 0] }],
    edges: [{ id: `${id}-edge`, from: 'a', to: 'b' }]
  };
}

async function createStore(): Promise<MapStore> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-agent-runs-'));
  tempDirs.push(rootDir);
  return new MapStore({ rootDir });
}
