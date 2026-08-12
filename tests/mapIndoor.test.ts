import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROOM_SURFACES,
  buildRoomShellSegments,
  createEmptyMap,
  getMapPlayerMetrics,
  getRoomShellAabbs,
  normalizeMap,
  type MapAsset
} from '../src/shared/map';
import { lintMap } from '../src/shared/mapLint';
import { applyMapOperations } from '../src/shared/mapOperations';
import { normalizeMapSuggestion } from '../src/server/mapAi';
import { buildEditableMapGroup } from '../src/client/mapRenderer';

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => null
    })
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('indoor map contract', () => {
  it('keeps legacy maps outdoor and creates a bounded parameterized room on demand', () => {
    const legacy = normalizeMap({ id: 'legacy-map' });
    const indoor = createEmptyMap('Classroom', 'classroom', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);

    expect(legacy.sceneMode).toBe('outdoor');
    expect(legacy.room).toBeNull();
    expect(indoor.sceneMode).toBe('indoor');
    expect(indoor.room).toMatchObject({
      position: [0, 0, 0],
      size: [10, 3, 8],
      wallThickness: 0.16,
      openings: []
    });
    expect(getMapPlayerMetrics(legacy)).toMatchObject({ height: 2.7, radius: 0.45 });
    expect(getMapPlayerMetrics(indoor)).toMatchObject({ height: 1.6, radius: 0.38 });
    expect(indoor.worldScaleProfile).toBe('balanced');
  });

  it('splits modular walls around door and window reservations without CSG', () => {
    const map = applyMapOperations(
      createEmptyMap('Room', 'room-shell', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [{
        type: 'room.set',
        room: {
          position: [0, 0, 0],
          size: [10, 3, 8],
          wallThickness: 0.16,
          openings: [
            { id: 'door-main', kind: 'door', wall: 'north', offset: 0, bottom: 0, width: 1.4, height: 2.2 },
            { id: 'window-east', kind: 'window', wall: 'east', offset: 0.8, bottom: 1, width: 2, height: 1.2 }
          ]
        }
      }]
    );

    const segments = buildRoomShellSegments(map);
    expect(new Set(segments.map((segment) => segment.surface))).toEqual(new Set(ROOM_SURFACES));
    expect(segments.some((segment) => segment.surface === 'north'
      && segment.uMin < 0 && segment.uMax > 0
      && segment.yMin < 1 && segment.yMax > 1)).toBe(false);
    expect(segments.some((segment) => segment.surface === 'east'
      && segment.uMin < 0.8 && segment.uMax > 0.8
      && segment.yMin < 1.4 && segment.yMax > 1.4)).toBe(false);

    const collision = getRoomShellAabbs(map);
    const northZ = -map.room!.size[2] / 2 + map.room!.wallThickness / 2;
    expect(collision.some((box) => box.min[0] < 0 && box.max[0] > 0
      && box.min[2] <= northZ && box.max[2] >= northZ
      && box.min[1] < 1 && box.max[1] > 1)).toBe(false);
    expect(collision.some((box) => box.min[0] < -3 && box.max[0] > -3
      && box.min[2] <= northZ && box.max[2] >= northZ)).toBe(true);

    const patched = applyMapOperations(map, [{ type: 'room.set', room: { wallThickness: 0.2 } }]);
    expect(patched.room?.openings).toHaveLength(2);
  });

  it('keeps a linked door object snapped to its opening in the same atomic transaction', () => {
    const map = createEmptyMap('Room', 'room-door', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const result = applyMapOperations(map, [
      {
        type: 'room.set',
        room: {
          position: [0, 0, 0], size: [10, 3, 8], wallThickness: 0.16,
          openings: [{ id: 'door-main', kind: 'door', wall: 'north', offset: 1.5, bottom: 0, width: 1.2, height: 2.1 }]
        }
      },
      {
        type: 'object.add',
        object: {
          id: 'door-object', name: 'Door', roomOpeningId: 'door-main', heightMode: 'fixed',
          transform: { position: [99, 7, 99] }
        }
      }
    ]);

    expect(result.objects[0]).toMatchObject({ roomOpeningId: 'door-main', heightMode: 'fixed' });
    expect(result.objects[0].transform.position).toEqual([1.5, 0, -3.84]);
    expect(result.objects[0].transform.rotation[1]).toBe(0);
  });

  it('normalizes an indoor AI plan without leaking terrain or water operations', () => {
    const map = createEmptyMap('Classroom', 'room-ai', [12, 3.2, 9], 'voxel', 'indoor', [12, 3.2, 9]);
    const door = asset('asset-door', ['door', 'interior']);
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: '1980s classroom',
      room: {
        position: [0, 0, 0], size: [12, 3.2, 9], wallThickness: 0.18,
        openings: [{ id: 'door-main', kind: 'door', wall: 'south', offset: -3.5, bottom: 0, width: 1.2, height: 2.2 }]
      },
      terrainGeneration: { preset: 'hills', amplitude: 5 },
      waters: [{ type: 'lake', points: [[-1, -1], [1, -1], [1, 1]] }],
      objects: [{ assetId: door.id, name: 'Door', x: 0, y: 0, z: 0, roomOpeningId: 'door-main' }],
      spawn: { x: 0, z: 0 }
    }), map, [door]);

    expect(suggestion.operations.map((operation) => operation.type)).toEqual([
      'room.set', 'object.add', 'reference.set'
    ]);
    const applied = applyMapOperations({ ...map, assets: [door] }, suggestion.operations);
    expect(applied.objects[0].roomOpeningId).toBe('door-main');
    expect(applied.objects[0].transform.position[2]).toBeCloseTo(4.32);
  });

  it('reports a blocked indoor route from spawn to a door', () => {
    const map = applyMapOperations(
      createEmptyMap('Blocked room', 'blocked-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [
        {
          type: 'room.set',
          room: {
            position: [0, 0, 0], size: [10, 3, 8], wallThickness: 0.16,
            openings: [{ id: 'door-main', kind: 'door', wall: 'north', offset: 0, bottom: 0, width: 1.2, height: 2.1 }]
          }
        },
        {
          type: 'object.add',
          object: {
            id: 'blocker', name: 'Blocker', heightMode: 'fixed',
            transform: { position: [0, 0, -2], size: [9.8, 2, 0.8] }
          }
        }
      ]
    );

    expect(lintMap(map).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'room.path-blocked', repaired: false })
    ]));
  });

  it('renders selectable room surfaces and switches full, cutaway, half and hidden views', async () => {
    const map = createEmptyMap('Room', 'room-render', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const rendered = await buildEditableMapGroup(map, { editorHelpers: true });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 5, 12);

    for (const surface of ROOM_SURFACES) {
      expect(rendered.group.getObjectByName(`room:${surface}`)).toBeDefined();
    }
    expect(rendered.group.getObjectByName('terrain')?.visible).toBe(false);

    rendered.setRoomWallDisplayMode('cutaway', camera);
    expect(rendered.group.getObjectByName('room:ceiling')?.visible).toBe(false);
    expect(rendered.group.getObjectByName('room:south')?.visible).toBe(false);
    expect(rendered.group.getObjectByName('room:north')?.visible).toBe(true);

    rendered.setRoomWallDisplayMode('half', camera);
    const northMeshes: THREE.Mesh[] = [];
    rendered.group.getObjectByName('room:north')?.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && object.visible) northMeshes.push(object as THREE.Mesh);
    });
    expect(northMeshes.every((mesh) => mesh.scale.y <= map.room!.size[1] / 2)).toBe(true);

    rendered.setRoomWallDisplayMode('hidden', camera);
    expect(rendered.group.getObjectByName('room:north')?.visible).toBe(false);
    expect(rendered.group.getObjectByName('room:floor')?.visible).toBe(true);

    rendered.setRoomWallDisplayMode('full', camera);
    expect(rendered.group.getObjectByName('room:ceiling')?.visible).toBe(true);
    rendered.dispose();
  });
});

function asset(id: string, tags: string[]): MapAsset {
  const now = Date.now();
  return {
    id,
    name: id,
    prompt: id,
    tags,
    modelJson: {},
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    mode: 'voxel',
    createdAt: now,
    updatedAt: now
  };
}
