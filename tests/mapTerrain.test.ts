import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUN_POSITION,
  MAP_SIZE_PRESETS,
  bakeMapCollisions,
  createMapObject,
  getPlayerSupportHeightForMap,
  getPlayerSpawnYaw,
  getSpawnPoints,
  getSunPosition,
  applyTerrainBrush,
  createEmptyMap,
  movePlayerPositionForMap,
  normalizeMap,
  sampleTerrainHeight,
  superMapSizeFromMediumCount,
  stepPlayerVerticalMotionForMap,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  type MapObjectAabb
} from '../src/shared/map';
import { MAP_ASSET_COLLIDER_PROFILE, buildModelColliderPlan } from '../src/shared/modelBounds';
import { movementDelta, stepVerticalMotion } from '../src/shared/math';
import {
  DEFAULT_INPUT,
  PLAYER_GRAVITY,
  PLAYER_JUMP_HEIGHT_MULTIPLIER,
  PLAYER_JUMP_SPEED
} from '../src/shared/protocol';

describe('map terrain editing', () => {
  it('expresses a super map as a bounded number of medium-map areas', () => {
    expect(superMapSizeFromMediumCount(4)).toEqual([192, 32, 192]);
    expect(superMapSizeFromMediumCount(16)).toEqual([384, 32, 384]);
    expect(superMapSizeFromMediumCount(999)).toEqual([768, 32, 768]);
  });

  it('creates each map size preset with its matching terrain resolution', () => {
    for (const preset of MAP_SIZE_PRESETS) {
      const map = createEmptyMap(preset.label, `map-${preset.key}`, [...preset.size]);
      expect(map.box.size).toEqual(preset.size);
      expect(map.terrain.resolutionX).toBe(preset.terrain);
      expect(map.terrain.resolutionZ).toBe(preset.terrain);
    }
  });

  it('upgrades older low resolution terrain by resampling heights', () => {
    const map = normalizeMap({
      terrain: {
        resolutionX: 3,
        resolutionZ: 3,
        heights: [
          0, 0, 0,
          0, 4, 0,
          0, 0, 0
        ]
      }
    });

    expect(map.terrain.resolutionX).toBe(MAP_SIZE_PRESETS[0].terrain);
    expect(map.terrain.resolutionZ).toBe(MAP_SIZE_PRESETS[0].terrain);
    expect(sampleTerrainHeight(map, 0, 0)).toBeCloseTo(4, 4);
    expect(sampleTerrainHeight(map, 24, 24)).toBeCloseTo(0, 4);
  });

  it('raises smooth radial terrain from arbitrary world positions', () => {
    const map = applyTerrainBrush(createEmptyMap(), 'raise', [0.37, 0, -0.22], 3, 1.2);

    const center = sampleTerrainHeight(map, 0.37, -0.22);
    const shoulder = sampleTerrainHeight(map, 1.37, -0.22);
    const edge = sampleTerrainHeight(map, 2.85, -0.22);
    const outside = sampleTerrainHeight(map, 5, -0.22);

    expect(center).toBeGreaterThan(shoulder);
    expect(shoulder).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
    expect(outside).toBeCloseTo(0, 4);
  });

  it('keeps the stored resolution of an existing 32 metre map', () => {
    const existingResolution = 65;
    const legacy = createEmptyMap();
    legacy.box.size = [32, 8, 32];
    legacy.terrain = {
      resolutionX: existingResolution,
      resolutionZ: existingResolution,
      heights: Array(existingResolution * existingResolution).fill(0)
    };
    const map = normalizeMap(legacy);

    expect(map.terrain.resolutionX).toBe(existingResolution);
    expect(map.terrain.resolutionZ).toBe(existingResolution);
  });

  it('flattens terrain toward a locked target height with brush strength', () => {
    const raised = applyTerrainBrush(createEmptyMap(), 'raise', [0, 0, 0], 3, 2);
    const before = sampleTerrainHeight(raised, 0, 0);
    const flattened = applyTerrainBrush(raised, 'flatten', [0, before, 0], 2, 0.5, 1);
    const after = sampleTerrainHeight(flattened, 0, 0);

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(1);
  });

  it('normalizes maps to one player spawn point', () => {
    const map = normalizeMap({
      spawnPoints: [
        [3, 1, -2],
        [8, 0, 8]
      ]
    });

    expect(map.spawnPoints).toEqual([[3, 1, -2]]);
    expect(getSpawnPoints(map)).toEqual([[3, 1, -2]]);
  });

  it('normalizes a configurable player spawn yaw while keeping legacy maps facing forward', () => {
    expect(getPlayerSpawnYaw(normalizeMap({}))).toBe(0);

    const map = normalizeMap({ spawnYaw: Math.PI * 2.5 });
    expect(map.spawnYaw).toBeCloseTo(Math.PI / 2, 5);
    expect(getPlayerSpawnYaw(map)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('normalizes map lighting with a configurable sun position', () => {
    const fallback = normalizeMap({});
    expect(getSunPosition(fallback)).toEqual(DEFAULT_SUN_POSITION);

    const custom = normalizeMap({
      lighting: {
        sunPosition: [9, 18, -7]
      }
    });
    expect(custom.lighting.sunPosition).toEqual([9, 18, -7]);
    expect(getSunPosition(custom)).toEqual([9, 18, -7]);
  });

  it('sweeps through long movement without tunneling through thin colliders', () => {
    const map = createEmptyMap('Collision sweep');
    const obstacles: MapObjectAabb[] = [{
      objectId: 'thin-wall',
      min: [2, 0, -1],
      max: [2.1, 2, 1]
    }];

    const moved = movePlayerPositionForMap([-4, 0, 0], [10, 0, 0], map, obstacles);

    expect(moved[0]).toBeCloseTo(2 - PLAYER_RADIUS, 5);
    expect(moved[2]).toBeCloseTo(0, 5);
  });

  it('resolves diagonal collision consistently across different simulation step sizes', () => {
    const map = createEmptyMap('Collision determinism');
    const obstacles: MapObjectAabb[] = [{
      objectId: 'box',
      min: [-0.5, 0, -1],
      max: [0.5, 2, 1]
    }];
    const oneStep = movePlayerPositionForMap([-2, 0, -2], [3, 0, 3], map, obstacles);
    let manySteps: [number, number, number] = [-2, 0, -2];
    for (let index = 0; index < 30; index += 1) {
      manySteps = movePlayerPositionForMap(manySteps, [0.1, 0, 0.1], map, obstacles);
    }

    expect(oneStep[0]).toBeCloseTo(manySteps[0], 5);
    expect(oneStep[2]).toBeCloseTo(manySteps[2], 5);
  });

  it('resolves a jump over a collider identically at client and server step sizes', () => {
    const map = createEmptyMap('Jump collision determinism');
    const obstacles: MapObjectAabb[] = [{
      objectId: 'jump-box',
      min: [-1, 0, -0.5],
      max: [1, 1.5, 0.5]
    }];
    const simulate = (
      dt: number,
      obstacleHeight = 1.5,
      startZ = 3.3,
      duration = 1.45
    ): [number, number, number] => {
      obstacles[0].max[1] = obstacleHeight;
      let position: [number, number, number] = [0, 0, startZ];
      let velocity = 0;
      let elapsed = 0;
      let jumpRequested = true;
      while (elapsed < duration - 0.000001) {
        const step = Math.min(dt, duration - elapsed);
        const delta = movementDelta({ ...DEFAULT_INPUT, forward: true }, step);
        const horizontal = movePlayerPositionForMap(
          position,
          [delta[0], 0, delta[2]],
          map,
          obstacles,
          { velocity, duration: step, jumpRequested }
        );
        const vertical = stepPlayerVerticalMotionForMap(
          [horizontal[0], position[1], horizontal[2]],
          velocity,
          step,
          jumpRequested,
          map,
          obstacles
        );
        position = [horizontal[0], vertical.y, horizontal[2]];
        velocity = vertical.velocity;
        jumpRequested = false;
        elapsed += step;
      }
      return position;
    };

    const serverPosition = simulate(0.05);
    const clientPosition = simulate(1 / 60);

    expect(serverPosition[2]).toBeLessThan(-2.7);
    expect(serverPosition[0]).toBeCloseTo(clientPosition[0], 8);
    expect(serverPosition[1]).toBeCloseTo(clientPosition[1], 8);
    expect(serverPosition[2]).toBeCloseTo(clientPosition[2], 8);

    // This marginal-clearance case previously let a 30 FPS client cross while
    // the 50 ms authoritative server remained blocked at the front edge.
    const marginalServerPosition = simulate(0.05, 1.425, 3.7, 1);
    const marginalClientPosition = simulate(1 / 30, 1.425, 3.7, 1);
    expect(marginalServerPosition[2]).toBeCloseTo(0.95, 8);
    expect(marginalClientPosition[2]).toBeCloseTo(marginalServerPosition[2], 8);
  });

  it('uses separate asset collider boxes instead of one aggregate object bound', () => {
    const map = createEmptyMap('Split collider map');
    const modelJson = {
      format: 2,
      nodes: [
        { id: 'left', transform: { pos: [-2, 0.5, 0] }, mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } },
        { id: 'right', transform: { pos: [2, 0.5, 0] }, mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }
      ]
    };
    const colliderPlan = buildModelColliderPlan(modelJson, MAP_ASSET_COLLIDER_PROFILE);
    map.assets = [{
      id: 'split-asset',
      name: 'Split asset',
      prompt: '',
      modelJson,
      colliderPlan,
      mode: 'voxel',
      createdAt: 1,
      updatedAt: 1
    }];
    map.objects = [{
      id: 'split-object',
      name: 'Split object',
      parentId: null,
      assetId: 'split-asset',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] },
      visible: true,
      locked: false
    }];

    const moved = movePlayerPositionForMap([0, 0, 3], [0, 0, -6], map);

    expect(moved[2]).toBeCloseTo(-3, 5);
  });

  it('allows a grounded player to pass below elevated collider boxes', () => {
    const map = createEmptyMap('Vertical collision map');
    const obstacles: MapObjectAabb[] = [{
      objectId: 'canopy',
      min: [-1, 3, -1],
      max: [1, 4, 1]
    }];

    const moved = movePlayerPositionForMap([0, 0, 3], [0, 0, -6], map, obstacles);

    expect(moved[2]).toBeCloseTo(-3, 5);
  });

  it('lands on and remains supported by the top of a low collider', () => {
    const map = createEmptyMap('Vertical support map');
    const obstacles: MapObjectAabb[] = [{
      objectId: 'low-box',
      min: [-1, 0, -1],
      max: [1, 0.75, 1]
    }];
    let y = 2;
    let velocity = -1;
    for (let index = 0; index < 80; index += 1) {
      const resolved = movePlayerPositionForMap([0, y, 0], [0, 0, 0], map, obstacles);
      const vertical = stepVerticalMotion(y, resolved[1], velocity, 0.025, false);
      y = vertical.y;
      velocity = vertical.velocity;
    }

    expect(getPlayerSupportHeightForMap([0, 1, 0], map, obstacles)).toBeCloseTo(0.75, 5);
    expect(getPlayerSupportHeightForMap([0, 0, 0], map, obstacles)).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0.75, 5);
    expect(velocity).toBe(0);
  });

  it('raises the physical jump apex to exactly 1.5 times the previous height', () => {
    const oldApex = 6.5 ** 2 / (2 * PLAYER_GRAVITY);
    const newApex = PLAYER_JUMP_SPEED ** 2 / (2 * PLAYER_GRAVITY);

    expect(PLAYER_JUMP_HEIGHT_MULTIPLIER).toBe(1.5);
    expect(newApex).toBeCloseTo(oldApex * 1.5, 10);
  });

  it('stops upward motion at the underside of an elevated collider', () => {
    const map = createEmptyMap('Ceiling collision map');
    // Keep the underside inside the first jump sweep as the player capsule changes size.
    const ceilingBottom = PLAYER_HEIGHT + 0.3;
    const obstacles: MapObjectAabb[] = [{
      objectId: 'low-ceiling',
      min: [-1, ceilingBottom, -1],
      max: [1, ceilingBottom + 1, 1]
    }];

    const vertical = stepPlayerVerticalMotionForMap([0, 0, 0], 0, 0.1, true, map, obstacles);

    expect(vertical.y).toBeCloseTo(ceilingBottom - PLAYER_HEIGHT, 4);
    expect(vertical.velocity).toBe(0);
    expect(vertical.grounded).toBe(false);
  });

  it('bakes aligned world colliders into one indexed set without sealing gaps', () => {
    const map = createEmptyMap('Baked collision map');
    const left = createMapObject('left');
    left.id = 'left';
    const middle = createMapObject('middle');
    middle.id = 'middle';
    middle.transform.position = [1, 0, 0];
    const separated = createMapObject('separated');
    separated.id = 'separated';
    separated.transform.position = [3, 0, 0];
    map.objects = [left, middle, separated];

    const bake = bakeMapCollisions(map);
    const movedThroughGap = movePlayerPositionForMap([2, 0, 3], [0, 0, -6], map, bake);

    expect(bake.sourceBoxCount).toBe(3);
    expect(bake.boxes).toHaveLength(2);
    expect(Object.keys(bake.cells).length).toBeGreaterThan(0);
    expect(movedThroughGap[2]).toBeCloseTo(-3, 5);
  });
});
