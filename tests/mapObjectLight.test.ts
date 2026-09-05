import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeMapLocalLightCandidates } from '../src/client/mapLocalLights';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { createEmptyMap, createMapObject, createMapObjectLight, normalizeMap } from '../src/shared/map';

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null })
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('map object lighting', () => {
  it('normalizes and persists an assetless authored spotlight', () => {
    const object = createMapObject('工作台主光');
    object.light = {
      ...createMapObjectLight('spot', [1, 0.8, -2]),
      role: 'key',
      color: '#ffb76a',
      intensity: 7.5,
      range: 11,
      castShadow: true,
      shadowMapSize: 1024,
      shadowBias: -0.0004,
      shadowNormalBias: 0.04,
      shadowRadius: 3
    };
    const map = createEmptyMap('手调灯光', 'manual-light-map');
    map.objects = [object];

    const normalized = normalizeMap(JSON.parse(JSON.stringify(map)));

    expect(normalized.objects[0].light).toMatchObject({
      kind: 'spot', role: 'key', color: '#ffb76a', intensity: 7.5,
      target: [1, 0.8, -2], castShadow: true, shadowMapSize: 1024,
      shadowBias: -0.0004, shadowNormalBias: 0.04, shadowRadius: 3
    });
    expect(analyzeMapLocalLightCandidates(normalized)[0]).toMatchObject({
      objectId: object.id, kind: 'spot', role: 'key', priority: 5
    });
  });

  it('renders a standalone key light with an absolute target, authored shadow and solo preview', async () => {
    const map = createEmptyMap('炼金工坊灯光', 'alchemy-light-map', [12, 4, 10], 'voxel', 'indoor', [12, 4, 10]);
    map.room!.openings = [{ id: 'window', kind: 'window', wall: 'north', offset: -2, bottom: 1, width: 2, height: 1.5 }];
    const key = createMapObject('工作台主光');
    key.transform.position = [3, 3, 2];
    key.light = {
      ...createMapObjectLight('spot', [0, 0.8, 0]),
      role: 'key', castShadow: true, shadowMapSize: 1024,
      shadowBias: -0.00035, shadowNormalBias: 0.035, shadowRadius: 3
    };
    const fill = createMapObject('货架补光');
    fill.transform.position = [-3, 2, 0];
    fill.light = { ...createMapObjectLight('point'), role: 'fill', intensity: 2 };
    map.objects = [key, fill];

    const rendered = await buildEditableMapGroup(map, { editorHelpers: true });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 4, 9);
    camera.lookAt(0, 1, 0);
    camera.updateProjectionMatrix();
    rendered.setLightingQuality(1);
    rendered.update(0.016, camera, 100);

    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const spot = lightRoot.children.find((child): child is THREE.SpotLight => (child as THREE.SpotLight).isSpotLight)!;
    const point = lightRoot.children.find((child): child is THREE.PointLight => (child as THREE.PointLight).isPointLight)!;
    expect(spot.castShadow).toBe(true);
    expect(spot.shadow.mapSize.width).toBe(1024);
    expect(spot.shadow.bias).toBeCloseTo(-0.00035);
    expect(spot.target.position.clone().normalize().toArray()).toEqual(
      expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)])
    );
    expect(rendered.group.getObjectByName('mapLightEditorHelpers')).toBeDefined();
    expect(rendered.objectGroups.get(key.id)?.children.some((child) => (child as THREE.Mesh).isMesh)).toBe(false);

    rendered.setLightingSoloObjectId(key.id);
    rendered.update(0.016, camera, 100);
    expect(spot.intensity).toBeGreaterThan(0);
    expect(point.intensity).toBe(0);
    expect((lightRoot.getObjectByName('mapWindowLights') as THREE.Group).children.every((child) => !child.visible)).toBe(true);
    expect((lightRoot.getObjectByName('mapInteriorLightProbe') as THREE.LightProbe).visible).toBe(false);
    rendered.dispose();
  });

  it('lets one asset instance override or disable its inherited fixture light', () => {
    const map = createEmptyMap('实例灯光', 'instance-light-map');
    const now = Date.now();
    map.assets = [{
      id: 'fixture', name: '壁灯', prompt: 'wall light',
      light: { kind: 'point', color: '#ffd9a0', intensity: 4, range: 7, offset: [0, 1, 0] },
      modelJson: { nodes: [] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      mode: 'voxel', createdAt: now, updatedAt: now
    }];
    const inherited = createMapObject('继承灯光', 'fixture');
    const overridden = createMapObject('冷色实例', 'fixture');
    overridden.light = { ...createMapObjectLight('point'), color: '#8fcaff', role: 'accent', intensity: 2.5 };
    const disabled = createMapObject('关闭实例', 'fixture');
    disabled.light = null;
    map.objects = [inherited, overridden, disabled];

    const candidates = analyzeMapLocalLightCandidates(map);

    expect(candidates).toHaveLength(2);
    expect(candidates.find((item) => item.objectId === inherited.id)?.color).toBe('#ffd9a0');
    expect(candidates.find((item) => item.objectId === overridden.id)).toMatchObject({ color: '#8fcaff', role: 'accent' });
    expect(candidates.some((item) => item.objectId === disabled.id)).toBe(false);
  });
});
