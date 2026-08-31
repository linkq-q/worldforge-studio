import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEditableMapGroup,
  buildStructuredWaterGroup,
  terrainNormalPixelsFromHeight
} from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import type { MapAsset } from '../src/shared/map';
import { createGrassLayer, fillGrassLayerInPlace } from '../src/shared/mapGrass';
import { DEFAULT_RUNTIME_GRASS_STYLE } from '../src/shared/renderPlan';
import { MAX_VISIBLE_MAP_LOCAL_LIGHTS, MAX_VISIBLE_MAP_POINT_LIGHTS } from '../src/client/mapLocalLights';

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

describe('terrain normal generation', () => {
  it('converts height changes into a non-flat tangent-space normal', () => {
    const heightPixels = new Uint8ClampedArray(3 * 3 * 4);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const offset = (y * 3 + x) * 4;
        heightPixels[offset] = x * 100;
        heightPixels[offset + 1] = x * 100;
        heightPixels[offset + 2] = x * 100;
        heightPixels[offset + 3] = 255;
      }
    }

    const normals = terrainNormalPixelsFromHeight(heightPixels, 3, 3, 4);
    const center = (1 * 3 + 1) * 4;
    expect(normals[center]).toBeLessThan(128);
    expect(normals[center + 1]).toBe(128);
    expect(normals[center + 2]).toBeGreaterThan(128);
    expect(normals[center + 3]).toBe(255);
  });
});

describe('procedural foundation rendering', () => {
  it('builds one selectable closed mesh whose lower rim follows terrain', async () => {
    const source = createEmptyMap('foundation render', 'foundation-render');
    source.terrain.heights = source.terrain.heights.map((_, index) => index % 5 * 0.12);
    const map = applyMapOperations(source, [{
      type: 'object.add', object: {
        id: 'foundation-a', name: '地基', heightMode: 'fixed',
        transform: { position: [0, 1, 0] },
        foundation: {
          shape: 'capsule', top: 'level', width: 7, depth: 4, thickness: 0.35,
          maxThickness: 3, cornerRadius: 2, points: [], curve: 'polyline', closed: true,
          slope: 0, slopeDirection: 0, stepHeight: 0.2, stepCount: 3,
          material: 'stone', linkedObjectIds: []
        }
      }
    }]);
    const rendered = await buildEditableMapGroup(map);
    const mesh = rendered.group.getObjectByName('foundation-mesh:foundation-a') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    const ys = Array.from({ length: positions.count }, (_, index) => positions.getY(index));

    expect(mesh.userData.mapObjectId).toBe('foundation-a');
    expect(mesh.geometry.index?.count).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(-0.35);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x7f8179);
    expect(rendered.pickables).toContain(mesh);
    rendered.dispose();
  });

  it('renders stepped tops as horizontal treads with vertical risers', async () => {
    const map = applyMapOperations(createEmptyMap('stepped foundation', 'stepped-foundation-render'), [{
      type: 'object.add', object: {
        id: 'foundation-steps', name: '阶梯地基', heightMode: 'fixed',
        transform: { position: [0, 1, 0] },
        foundation: {
          shape: 'rounded-rectangle', top: 'steps', width: 8, depth: 6, thickness: 0.35,
          maxThickness: 4, cornerRadius: 1, points: [], curve: 'polyline', closed: true,
          slope: 0, slopeDirection: 0, stepHeight: 0.3, stepCount: 4,
          material: 'concrete', linkedObjectIds: []
        }
      }
    }]);
    const rendered = await buildEditableMapGroup(map);
    const mesh = rendered.group.getObjectByName('foundation-mesh:foundation-steps') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index!;
    const upwardTriangles: number[][] = [];
    for (let offset = 0; offset < index.count; offset += 3) {
      const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
      const a = new THREE.Vector3().fromBufferAttribute(positions, ids[0]);
      const b = new THREE.Vector3().fromBufferAttribute(positions, ids[1]);
      const c = new THREE.Vector3().fromBufferAttribute(positions, ids[2]);
      const normalY = b.clone().sub(a).cross(c.clone().sub(a)).y;
      if (normalY > 1e-6) upwardTriangles.push(ids.map((id) => positions.getY(id)));
    }

    expect(upwardTriangles.length).toBeGreaterThan(4);
    expect(upwardTriangles.every((ys) => Math.max(...ys) - Math.min(...ys) < 1e-6)).toBe(true);
    rendered.dispose();
  });

  it('extrudes a curved path in local segments without long cross-bend triangles', async () => {
    const map = applyMapOperations(createEmptyMap('path foundation', 'path-foundation-render'), [{
      type: 'object.add', object: {
        id: 'foundation-path', name: '曲线地基', heightMode: 'fixed',
        transform: { position: [0, 1, 0] },
        foundation: {
          shape: 'path', top: 'steps', width: 1.5, depth: 12, thickness: 0.35,
          maxThickness: 4, cornerRadius: 0,
          points: [[-8, -6], [-8, 6], [0, 6], [0, -6], [8, -6]],
          curve: 'polyline', closed: false, slope: 0, slopeDirection: 0,
          stepHeight: 0.25, stepCount: 4, material: 'concrete', linkedObjectIds: []
        }
      }
    }]);
    const rendered = await buildEditableMapGroup(map);
    const mesh = rendered.group.getObjectByName('foundation-mesh:foundation-path') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index!;
    let longestHorizontalTopEdge = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
      const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
      const points = ids.map((id) => new THREE.Vector3().fromBufferAttribute(positions, id));
      const normalY = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).y;
      if (normalY <= 1e-6 || Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)) > 1e-6) continue;
      for (let edge = 0; edge < 3; edge += 1) {
        longestHorizontalTopEdge = Math.max(longestHorizontalTopEdge, points[edge].distanceTo(points[(edge + 1) % 3]));
      }
    }

    expect(longestHorizontalTopEdge).toBeLessThan(13);
    rendered.dispose();
  });
});

describe('structured map water rendering', () => {
  it('renders the map as an open terrain plane without enclosure faces', async () => {
    const rendered = await buildEditableMapGroup(createEmptyMap('open-map', 'map-open-plane'));
    const surfaces: string[] = [];
    rendered.group.traverse((object) => {
      if (typeof object.userData.surface === 'string') surfaces.push(object.userData.surface);
    });

    expect(surfaces).toEqual(['terrain']);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const material = terrain.material as THREE.MeshStandardMaterial;
    expect(terrain.castShadow).toBe(true);
    expect(terrain.receiveShadow).toBe(true);
    expect(material.emissive.getHex()).toBe(0x000000);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.vertexColors).toBe(true);
    expect(material.roughness).toBe(1);
    expect((material.map?.image as { width: number }).width).toBe(1536);
    expect(material.roughnessMap).toBeInstanceOf(THREE.CanvasTexture);
    expect(material.bumpMap).toBeInstanceOf(THREE.CanvasTexture);
    expect(material.normalMap).toBeInstanceOf(THREE.CanvasTexture);
    expect((material.roughnessMap?.image as { width: number }).width).toBe(1536);
    expect((material.bumpMap?.image as { width: number }).width).toBe(1536);
    expect((material.normalMap?.image as { width: number }).width).toBe(1536);
    expect(material.bumpScale).toBeGreaterThanOrEqual(0.1);
    expect(material.normalMapType).toBe(THREE.TangentSpaceNormalMap);
    expect(material.normalScale.x).toBeGreaterThan(1);
    expect(material.normalScale.y).toBeGreaterThan(1);
    expect(terrain.userData.terrainTextureChannels).toContain('normal');
    expect(terrain.geometry.getAttribute('color').count).toBe(terrain.geometry.getAttribute('position').count);
    rendered.dispose();
  });

  it('builds tagged lake and river geometry under the model root', async () => {
    const map = createEmptyMap('waters', 'map-render-water');
    map.waterBodies = [
      {
        id: 'lake-1',
        name: '湖泊',
        type: 'lake',
        level: 0.4,
        depth: 1.5,
        width: 1.2,
        points: [[-4, -3], [4, -3], [4, 3], [-4, 3]]
      },
      {
        id: 'river-1',
        name: '河流',
        type: 'river',
        level: 0.5,
        depth: 1.5,
        width: 1.2,
        points: [[-6, -5], [-1, 0], [6, 5]],
        levels: [1.1, 0.8, 0.5],
        shorelineSmoothness: 0.8
      }
    ];

    const waterRoot = buildStructuredWaterGroup(map);
    const lake = waterRoot.getObjectByName('water:lake-1') as THREE.Mesh;
    const river = waterRoot.getObjectByName('water:river-1') as THREE.Mesh;

    expect(lake?.isMesh).toBe(true);
    expect(river?.isMesh).toBe(true);
    expect(lake.position.y).toBeCloseTo(0.4);
    expect(river.position.y).toBeCloseTo(0.5);
    expect(lake.userData.materialTags).toEqual(expect.arrayContaining(['water', 'lake', 'lake-1']));
    expect(river.userData.materialTags).toEqual(expect.arrayContaining(['water', 'river', 'river-1']));
    expect(lake.userData.excludeFromPlanarReflection).toBe(true);
    expect(river.userData.excludeFromPlanarReflection).toBe(true);
    expect(lake.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(3);
    expect(river.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(6);
    const riverHeights = Array.from(river.geometry.getAttribute('position').array as Float32Array)
      .filter((_, index) => index % 3 === 1);
    expect(Math.max(...riverHeights) - Math.min(...riverHeights)).toBeGreaterThan(0.5);
    for (const water of [lake, river]) {
      const shore = water.userData.waterShore as {
        texture: THREE.DataTexture;
        center: [number, number];
        size: number;
      };
      const pixels = shore.texture.image.data as Uint8Array;
      expect(shore.texture.isDataTexture).toBe(true);
      expect(shore.size).toBeGreaterThan(0);
      expect(pixels).toContain(0);
      expect(Math.max(...pixels)).toBe(255);
    }

    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
      (mesh.userData.waterShore?.texture as THREE.Texture | undefined)?.dispose();
    });
  });

  it('builds ocean shore distance from the terrain coastline', () => {
    const map = applyMapOperations(createEmptyMap('island-ocean', 'map-island-ocean'), [{
      type: 'terrain.generate', preset: 'island', seed: 7, amplitude: 6, roughness: 0.5
    }]);

    const waterRoot = buildStructuredWaterGroup(map);
    const ocean = waterRoot.getObjectByName('water:terrain-ocean') as THREE.Mesh;
    const image = (ocean.userData.waterShore.texture as THREE.DataTexture).image as {
      data: Uint8Array;
      width: number;
      height: number;
    };
    const center = Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2);

    expect(image.data[center]).toBe(0);
    expect(Math.max(...image.data)).toBe(255);

    ocean.geometry.dispose();
    (ocean.material as THREE.Material).dispose();
    (ocean.userData.waterShore.texture as THREE.Texture).dispose();
  });

  it('renders overlapping same-level water blocks as one clipped surface', () => {
    const map = createEmptyMap('joined-water', 'map-joined-water');
    map.waterBodies = [
      {
        id: 'left-water', name: '左侧水块', type: 'lake', level: 0.35, depth: 1.8, width: 1.2,
        points: [[-6, -4], [2, -4], [2, 4], [-6, 4]]
      },
      {
        id: 'right-water', name: '右侧水块', type: 'lake', level: 0.35, depth: 1.8, width: 1.2,
        points: [[-2, -4], [6, -4], [6, 4], [-2, 4]]
      },
      {
        id: 'separate-pond', name: '独立池塘', type: 'lake', level: 0.35, depth: 1.2, width: 1.2,
        points: [[20, -2], [24, -2], [24, 2], [20, 2]]
      }
    ];

    const waterRoot = buildStructuredWaterGroup(map);
    const left = waterRoot.getObjectByName('water:left-water') as THREE.Mesh;
    const separate = waterRoot.getObjectByName('water:separate-pond') as THREE.Mesh;
    const leftShore = left.userData.waterShore as {
      texture: THREE.DataTexture;
      center: [number, number];
      size: number;
    };
    const separateShore = separate.userData.waterShore as typeof leftShore;
    const image = leftShore.texture.image as { data: Uint8Array; width: number; height: number };
    const seamColumn = Math.floor((0.5 + (0 - leftShore.center[0]) / leftShore.size) * image.width);
    const seamRow = Math.floor((0.5 - (0 - leftShore.center[1]) / leftShore.size) * image.height);

    expect(waterRoot.children).toHaveLength(2);
    expect(waterRoot.getObjectByName('water:right-water')).toBeUndefined();
    expect(left.userData.waterBodyIds).toEqual(['left-water', 'right-water']);
    expect(left.userData.waterShore.worldSpace).toBe(false);
    expect(left.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(separateShore.texture).not.toBe(leftShore.texture);
    expect(image.data[seamRow * image.width + seamColumn]).toBeGreaterThan(128);

    const disposed = new Set<THREE.Texture>();
    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
      const texture = mesh.userData.waterShore?.texture as THREE.Texture | undefined;
      if (texture && !disposed.has(texture)) {
        disposed.add(texture);
        texture.dispose();
      }
    });
  });

  it('compiles even two matching asset copies into one scene-level primitive batch', async () => {
    const map = createEmptyMap('instances', 'map-shared-geometry');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-tree',
      name: 'tree',
      prompt: 'tree',
      modelJson: {
        nodes: [{
          id: 'trunk',
          mesh: { type: 'box', params: { width: 1, height: 2, depth: 1 }, color: 0x445522 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'test',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = [
      { ...createTestObject('tree-a', asset.id), transform: { ...createTestObject('tree-a', asset.id).transform, position: [0, 0, 0] } },
      { ...createTestObject('tree-b', asset.id), transform: { ...createTestObject('tree-b', asset.id).transform, position: [4, 0, 0] } }
    ];

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(2);
    expect(rendered.objectGroups.get('tree-a')?.getObjectByName('trunk')).toBeUndefined();
    expect(rendered.objectGroups.get('tree-b')?.getObjectByName('trunk')).toBeUndefined();
    expect(rendered.pickables).toContain(batch);
    rendered.dispose();
  });

  it('instances four safe copies and keeps editable object transform bindings', async () => {
    const map = createEmptyMap('dense', 'map-instanced-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-shrub',
      name: 'shrub',
      prompt: 'shrub',
      modelJson: {
        nodes: [{
          id: 'leaf',
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x447733 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'voxel',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 4 }, (_, index) => {
      const object = createTestObject(`shrub-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(4);
    expect(batch.userData.resolveMapObjectId({ object: batch, instanceId: 2 })).toBe('shrub-2');
    expect(rendered.pickables).toContain(batch);

    const selected = rendered.objectGroups.get('shrub-2') as THREE.Group;
    selected.position.x = 20;
    rendered.syncObjectTransform('shrub-2');
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(2, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(20);
    rendered.dispose();
  });

  it('batches material-tagged copies when their tag only needs a shared base recipe', async () => {
    const map = createEmptyMap('tagged', 'map-tagged-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-tagged-tree',
      name: 'tagged tree',
      prompt: 'tagged tree',
      modelJson: {
        nodes: [{
          id: 'leaf',
          tags: [{ tag: 'base', value: 'foliage' }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x447733 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'voxel',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 4 }, (_, index) => {
      const object = createTestObject(`tagged-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(4);
    expect(rendered.objectGroups.get('tagged-0')?.getObjectByName('leaf')).toBeUndefined();
    rendered.dispose();
  });

  it('keeps tags with per-object runtime effects standalone while below the effect-batch threshold', async () => {
    const map = createEmptyMap('tagged-runtime', 'map-tagged-runtime-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-fire',
      name: 'torch flame',
      prompt: 'torch flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 2 }, (_, index) => {
      const object = createTestObject(`flame-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true)).toBeUndefined();
    expect(rendered.objectGroups.get('flame-0')?.getObjectByName('flame')).toBeDefined();
    expect(rendered.getDebugStats()).toMatchObject({
      totalParts: 2,
      effectBatchParts: 0,
      fallbackMeshParts: 2
    });
    rendered.dispose();
  });

  it('keeps animated objects standalone and drives them through the optional motion adapter', async () => {
    const map = createEmptyMap('motion', 'map-motion-adapter');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-gull', name: 'gull', prompt: 'gull', tags: ['bird'],
      modelJson: { nodes: [{ id: 'body', mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'test', createdAt: now, updatedAt: now
    };
    const animated = {
      ...createTestObject('gull-flying', asset.id),
      behavior: {
        kind: 'flock' as const, locomotion: 'air' as const, groupRole: 'outlier' as const,
        animation: { state: 'fly', speed: 1.1, phase: 0.25 }
      }
    };
    map.assets = [asset];
    map.objects = [animated, createTestObject('gull-static', asset.id)];
    const update = vi.fn();
    const dispose = vi.fn();
    const attach = vi.fn(() => ({ update, dispose }));

    const rendered = await buildEditableMapGroup(map, { motionAdapter: { attach } });
    rendered.update(0.25, new THREE.PerspectiveCamera(), 100);

    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      object: expect.objectContaining({ id: 'gull-flying' }),
      asset: expect.objectContaining({ id: asset.id }),
      group: rendered.objectGroups.get('gull-flying')
    }));
    expect(rendered.objectGroups.get('gull-flying')?.getObjectByName('body')).toBeDefined();
    expect(update).toHaveBeenCalledWith(0.25, 0.25);

    rendered.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps cliffs in the terrain mesh without detached vertical wall sheets', async () => {
    const map = applyMapOperations(createEmptyMap('cliff', 'map-cliff-render'), [{
      type: 'terrain.modify', modifier: 'cliff', layout: 'wall',
      region: { kind: 'path', points: [[0, -15], [0, 15]], width: 5 },
      amplitude: 7, softness: 0
    }]);
    const rendered = await buildEditableMapGroup(map);
    expect(rendered.group.getObjectByName('terrain-cliff-walls')).toBeUndefined();
    expect((rendered.group.getObjectByName('terrain') as THREE.Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
    rendered.dispose();
  });

  it('installs animated sand uniforms for semantic sand regions', async () => {
    const map = applyMapOperations(createEmptyMap('sand', 'map-sand-render'), [{
      type: 'terrain.surface', surface: 'sand',
      region: { kind: 'circle', x: 0, z: 0, radius: 8 }, zoneId: 'sand-zone'
    }]);
    const rendered = await buildEditableMapGroup(map);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const sandFlow = terrain.userData.sandFlow as { zones: unknown[]; strength: number };

    expect(sandFlow.zones).toHaveLength(1);
    expect((terrain.material as THREE.MeshStandardMaterial).onBeforeCompile).toBeTypeOf('function');
    rendered.setSandFlowStrength(0.5);
    expect(sandFlow.strength).toBe(0.5);
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>'
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    (terrain.material as THREE.MeshStandardMaterial).onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('terrainSandRipple');
    rendered.dispose();
  });

  it('shows editable road control points only when editor helpers are requested', async () => {
    const map = applyMapOperations(createEmptyMap('road helpers'), [{
      type: 'guide.upsert',
      guide: {
        id: 'main-road', name: 'Main road', points: [[-8, 0], [0, 3], [8, 0]],
        curve: 'catmull-rom', closed: false, width: 4, tags: ['route', 'street']
      }
    }]);
    const editor = await buildEditableMapGroup(map, { editorHelpers: true });
    const viewer = await buildEditableMapGroup(map);

    const helper = editor.group.getObjectByName('road-guide-helpers');
    expect(helper?.children.filter((child) => child.userData.mapGuidePointIndex !== undefined)).toHaveLength(3);
    expect(editor.pickables.some((object) => object.userData.mapGuideId === 'main-road')).toBe(true);
    expect(viewer.group.getObjectByName('road-guide-helpers')).toBeUndefined();

    editor.dispose();
    viewer.dispose();
  });

  it('draws fine asphalt, cut-stone sidewalks, and staggered long brick pavers', async () => {
    const strokes: Array<{ dash: number[]; style: unknown; width: number }> = [];
    const fillRects: Array<{ args: number[]; style: unknown }> = [];
    const strokeRects: Array<{ args: number[]; style: unknown }> = [];
    const translations: number[][] = [];
    let ellipses = 0;
    const state: Record<PropertyKey, unknown> = { dash: [] };
    const stack: Array<Record<PropertyKey, unknown>> = [];
    const context = new Proxy({
      save: () => stack.push({ ...state }),
      restore: () => Object.assign(state, stack.pop() ?? {}),
      setLineDash: (dash: number[]) => { state.dash = [...dash]; },
      stroke: () => strokes.push({
        dash: [...(state.dash as number[])],
        style: state.strokeStyle,
        width: Number(state.lineWidth ?? 0)
      }),
      fillRect: (...args: number[]) => fillRects.push({ args, style: state.fillStyle }),
      strokeRect: (...args: number[]) => strokeRects.push({ args, style: state.strokeStyle }),
      translate: (...args: number[]) => translations.push(args),
      ellipse: () => { ellipses += 1; },
      createRadialGradient: () => ({ addColorStop: () => undefined })
    }, {
      get: (target, property) => property in target
        ? Reflect.get(target, property)
        : state[property] ?? (() => undefined),
      set: (_target, property, value) => {
        state[property] = value;
        return true;
      }
    }) as unknown as CanvasRenderingContext2D;
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => context })
    });
    const map = applyMapOperations(createEmptyMap('street material detail'), [
      {
        type: 'terrain.surface',
        surface: 'paving',
        material: 'brick-paver',
        region: { kind: 'path', points: [[-20, -8], [20, -8]], width: 4 },
        zoneId: 'code:route:market-pavers'
      },
      {
        type: 'terrain.surface',
        surface: 'paving',
        material: 'asphalt',
        region: { kind: 'path', points: [[-20, 0], [20, 0]], width: 8 },
        zoneId: 'code:route:main-road'
      },
      {
        type: 'terrain.surface',
        surface: 'paving',
        material: 'concrete',
        region: { kind: 'path', points: [[-20, 8], [20, 8]], width: 2.6 },
        zoneId: 'code:route:sidewalk'
      }
    ]);

    const rendered = await buildEditableMapGroup(map);

    expect(ellipses).toBe(0);
    expect(fillRects.filter(({ args: [, , width, height] }) => width <= 2 && height <= 2).length).toBeGreaterThan(100);
    expect(strokeRects.length).toBeGreaterThan(20);
    expect(strokes.some((stroke) => stroke.dash.length === 2)).toBe(true);
    const longPavers = strokeRects.filter(({ args: [, , width, height] }) => width >= height * 2);
    expect(longPavers.length).toBeGreaterThan(800);
    expect(longPavers.length).toBeLessThan(1_600);
    expect(fillRects.some(({ style }) => style === '#c96948' || style === '#aa472f')).toBe(true);
    expect(translations[0][0]).not.toBeCloseTo(translations[1][0]);
    expect(strokeRects.some(({ style }) => style === '#4f4f4f')).toBe(false);
    rendered.dispose();
  });

  it('applies terrain recipes and snow to upward model surfaces', async () => {
    const rendered = await buildEditableMapGroup(createEmptyMap('weather-surface', 'map-weather-surface'));
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const terrainMaterial = terrain.material as THREE.MeshStandardMaterial;
    const firstTexture = terrainMaterial.map;
    const firstRoughness = terrainMaterial.roughnessMap;
    const firstBump = terrainMaterial.bumpMap;
    const firstNormal = terrainMaterial.normalMap;
    const roofMaterial = new THREE.MeshStandardMaterial({ color: '#70452f', roughness: 0.7 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 2), roofMaterial);
    rendered.modelsRoot.add(roof);

    rendered.setTerrainMaterialStyle({ detailStrength: 1, soilRecipe: 'moist', sandRecipe: 'beach' });
    rendered.setWeatherSurface(0.65, 0.9);

    expect(terrainMaterial.map).not.toBe(firstTexture);
    expect(terrainMaterial.roughnessMap).not.toBe(firstRoughness);
    expect(terrainMaterial.bumpMap).not.toBe(firstBump);
    expect(terrainMaterial.normalMap).not.toBe(firstNormal);
    expect(terrain.userData.terrainMaterialStyle).toEqual({
      detailStrength: 1,
      soilRecipe: 'moist',
      sandRecipe: 'beach'
    });
    expect(terrain.userData.weatherSurface).toEqual({ wetness: 0.65, snowCover: 0.9 });
    expect(roofMaterial.userData.worldforgeSnowUniform.value).toBe(0.9);
    expect(roofMaterial.userData.shaderPatchChain).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'worldforge-weather-snow' })
    ]));
    rendered.dispose();
  });

  it('regroups matching material-tag effects and keeps their RuntimeIndex transform binding', async () => {
    const map = createEmptyMap('tagged-effect-batch', 'map-tagged-effect-batch');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-shared-flame',
      name: 'shared flame',
      prompt: 'shared flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 8 }, (_, index) => {
      const object = createTestObject(`flame-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const effectBatch = rendered.getRuntimeBatchMeshes().find(
      (object): object is THREE.InstancedMesh => object.userData.isEffectBatch === true
    );
    expect(effectBatch?.count).toBe(8);
    expect(rendered.getDebugStats()).toMatchObject({
      effectBatchCount: 1,
      effectBatchParts: 8,
      runtimeIndexPartRefs: 8,
      orphanPartRefs: 0,
      orphanInstanceRefs: 0
    });
    expect(rendered.pickables).toContain(effectBatch);
    expect(effectBatch?.userData.resolveMapObjectId({ object: effectBatch, instanceId: 3 })).toBe('flame-3');

    const selected = rendered.objectGroups.get('flame-3') as THREE.Group;
    selected.position.x = 30;
    rendered.syncObjectTransform('flame-3');
    const matrix = new THREE.Matrix4();
    effectBatch?.getMatrixAt(3, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(30);
    rendered.dispose();
  });

  it('keeps mixed standalone siblings without mutating the fallback tree during traversal', async () => {
    const map = createEmptyMap('mixed-runtime', 'map-mixed-runtime-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-campfire',
      name: 'campfire',
      prompt: 'campfire',
      modelJson: {
        nodes: [
          { id: 'root' },
          {
            id: 'wood',
            parent: 'root',
            mesh: { type: 'box', params: { width: 1, height: 0.5, depth: 1 }, color: 0x553311 }
          },
          {
            id: 'flame',
            parent: 'root',
            tags: [{ tag: 'fire', value: 1 }],
            mesh: { type: 'box', params: { width: 0.4, height: 0.8, depth: 0.4 }, color: 0xff8822 }
          }
        ]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 2, candidateCount: 2, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('campfire-0', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.objectGroups.get('campfire-0')?.getObjectByName('wood')).toBeUndefined();
    expect(rendered.objectGroups.get('campfire-0')?.getObjectByName('flame')).toBeDefined();
    rendered.dispose();
  });

  it('distance-culls indexed standalone parts and restores them near the camera', async () => {
    const map = createEmptyMap('culling-runtime', 'map-culling-runtime');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-flame',
      name: 'flame',
      prompt: 'flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    const near = createTestObject('flame-near', asset.id);
    const far = createTestObject('flame-far', asset.id);
    far.transform.position = [100, 0, 0];
    map.assets = [asset];
    map.objects = [near, far];

    const rendered = await buildEditableMapGroup(map);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    const nearMesh = rendered.objectGroups.get('flame-near')?.getObjectByName('flame') as THREE.Mesh;
    const farMesh = rendered.objectGroups.get('flame-far')?.getObjectByName('flame') as THREE.Mesh;

    rendered.update(0, camera, 20);
    expect(nearMesh.visible).toBe(true);
    expect(farMesh.visible).toBe(false);

    camera.position.x = 100;
    rendered.update(0, camera, 20);
    expect(nearMesh.visible).toBe(false);
    expect(farMesh.visible).toBe(true);
    rendered.dispose();
  });
});

describe('terrain-only refresh', () => {
  it('rebuilds terrain geometry and surface texture in place, leaving asset batches alone', async () => {
    const map = createEmptyMap('terrain', 'map-terrain-refresh');
    const rendered = await buildEditableMapGroup(map);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const material = terrain.material as THREE.MeshStandardMaterial;
    const firstGeometry = terrain.geometry;
    const firstTexture = material.map;
    const firstRoughness = material.roughnessMap;
    const firstBump = material.bumpMap;
    const firstNormal = material.normalMap;
    const firstIndex = rendered.runtimeIndex;

    map.terrain.heights = map.terrain.heights.map(() => 3);
    rendered.refreshTerrain(map);

    // The mesh itself must survive: it is the raycast target for the brushes.
    expect(rendered.group.getObjectByName('terrain')).toBe(terrain);
    expect(terrain.geometry).not.toBe(firstGeometry);
    expect(terrain.geometry.getAttribute('position').getY(0)).toBeCloseTo(3, 5);
    expect(terrain.geometry.getAttribute('color').count).toBe(terrain.geometry.getAttribute('position').count);
    expect(material.map).not.toBe(firstTexture);
    expect(material.roughnessMap).not.toBe(firstRoughness);
    expect(material.bumpMap).not.toBe(firstBump);
    expect(material.normalMap).not.toBe(firstNormal);
    expect(rendered.runtimeIndex).toBe(firstIndex);
    rendered.dispose();
  });
});

describe('derived local lights', () => {
  it('dims window light and raises practical lights automatically at night indoors', async () => {
    const map = createEmptyMap('night room', 'map-night-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.room!.openings = [{
      id: 'window-main', kind: 'window', wall: 'north', offset: 0, bottom: 1, width: 2.4, height: 1.4
    }];
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-room-lamp', name: 'room lamp', prompt: 'warm room lamp',
      light: { kind: 'point', color: '#ffd878', intensity: 5, range: 10, offset: [0, 1.4, 0] },
      modelJson: { nodes: [{ id: 'bulb', mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('room-lamp', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 4, 8);
    camera.lookAt(0, 1, 0);
    camera.updateProjectionMatrix();
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const practical = lightRoot.children.find((child) => (child as THREE.PointLight).isPointLight) as THREE.PointLight;
    const windowLight = lightRoot.getObjectByName('mapWindowLight') as THREE.SpotLight;
    const indirectProbe = lightRoot.getObjectByName('mapInteriorLightProbe') as THREE.LightProbe;

    rendered.setLightingTimeOfDay('noon');
    rendered.update(0.016, camera, 100);
    const noonPractical = practical.intensity;
    const noonWindow = windowLight.intensity;
    const noonProbe = indirectProbe.intensity;
    rendered.setLightingTimeOfDay('night');
    rendered.update(0.016, camera, 100);

    expect(practical.intensity).toBeGreaterThan(noonPractical);
    expect(practical.intensity).toBeGreaterThan(asset.light!.intensity);
    expect(windowLight.intensity).toBeLessThan(noonWindow * 0.2);
    expect(indirectProbe.intensity).toBeLessThan(noonProbe);
    expect(indirectProbe.sh.coefficients[0].length()).toBeGreaterThan(0);
    expect(windowLight.position.z).toBeLessThan(map.room!.position[2]);
    expect(windowLight.target.position.z).toBeGreaterThan(0);
    rendered.dispose();
  });

  it('keeps a bounded set of real local-light slots for stable shader variants', async () => {
    const map = createEmptyMap('local lights', 'map-local-lights');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-lamp', name: 'lamp', prompt: 'glowing lamp',
      light: { kind: 'point', color: '#ffd878', intensity: 5, range: 12, offset: [0, 0.4, 0] },
      modelJson: { nodes: [{ id: 'bulb', tags: [{ tag: 'emissive', value: 1 }], mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 12 }, (_, index) => {
      const object = createTestObject(`lamp-${index}`, asset.id);
      object.transform.position = [(index % 4) * 2 - 3, 0, Math.floor(index / 4) * 2 - 2];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 8, 16);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    rendered.update(0.016, camera, 100);

    expect(MAX_VISIBLE_MAP_LOCAL_LIGHTS).toBeGreaterThan(2);
    const realLights = lightRoot.children.filter((child) => (child as THREE.Light).isLight);
    expect(realLights).toHaveLength(MAX_VISIBLE_MAP_POINT_LIGHTS);
    expect(realLights.length).toBeLessThanOrEqual(MAX_VISIBLE_MAP_LOCAL_LIGHTS);
    expect(realLights.filter((child) => child.visible)).toHaveLength(MAX_VISIBLE_MAP_POINT_LIGHTS);
    rendered.dispose();
  });

  it('uses AI-authored light metadata without relying on fixture-name keywords', async () => {
    const map = createEmptyMap('pendant lights', 'map-pendant-lights');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-pendant', name: 'Fixture 07', prompt: 'interior fixture', tags: ['interior-fixture'],
      light: { kind: 'point', color: '#7fc8ff', intensity: 6.5, range: 9, offset: [0, -0.25, 0] },
      modelJson: { nodes: [{ id: 'shade', mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('pendant', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 4, 8);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    rendered.update(0.016, camera, 100);

    const light = lightRoot.children.find((child) => (child as THREE.PointLight).isPointLight) as THREE.PointLight;
    expect(light).toBeDefined();
    expect(light.color.getHexString()).toBe('7fc8ff');
    expect(light.intensity).toBe(6.5);
    expect(light.distance).toBe(9);
    rendered.dispose();
  });

  it('keeps ordinary emissive screens visual-only instead of consuming real-light slots', async () => {
    const map = createEmptyMap('emissive screen', 'map-emissive-screen');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-screen', name: 'Computer display', prompt: 'desktop screen', tags: ['computer', 'monitor'],
      modelJson: { nodes: [{ id: 'screen', tags: [{ tag: 'emissive', value: 1 }], mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('screen', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;

    expect(lightRoot.children.filter((child) => (child as THREE.Light).isLight)).toHaveLength(0);
    rendered.dispose();
  });

  it('recognizes legacy AI role tags without reading the asset name', async () => {
    const map = createEmptyMap('legacy tagged light', 'map-legacy-tagged-light');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-panel', name: 'Fixture 08', prompt: 'interior fixture', tags: ['light', 'ceiling', 'panel'],
      modelJson: { nodes: [{ id: 'panel', mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('panel', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;

    expect(lightRoot.children.some((child) => (child as THREE.PointLight).isPointLight)).toBe(true);
    rendered.dispose();
  });

  it('maps a spotlight fixture to a real Three.js spotlight and target', async () => {
    const map = createEmptyMap('spot lights', 'map-spot-lights');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-spot', name: '轨道射灯', prompt: 'downward track spotlight', tags: ['lighting', 'spotlight', 'ceiling-mounted'],
      light: { kind: 'spot', color: '#ffd69a', intensity: 5, range: 12, offset: [0, -0.2, 0], direction: [0, -1, 0], coneAngleDegrees: 36, penumbra: 0.45 },
      modelJson: { nodes: [{ id: 'shade', mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('spot', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;

    expect(lightRoot.children.some((child) => (child as THREE.SpotLight).isSpotLight)).toBe(true);
    expect(lightRoot.getObjectByName('mapLocalLightTarget')).toBeDefined();
    rendered.dispose();
  });

  it('keeps an offscreen emitter active while its light volume reaches the view', async () => {
    const map = createEmptyMap('offscreen local light', 'map-offscreen-local-light');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-lamp', name: 'lamp', prompt: 'glowing lamp',
      light: { kind: 'point', color: '#ffd878', intensity: 5, range: 12, offset: [0, 0.4, 0] },
      modelJson: { nodes: [{ id: 'bulb', tags: [{ tag: 'emissive', value: 1 }], mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    const lamp = createTestObject('lamp-offscreen', asset.id);
    lamp.transform.position = [8, 0, -5];
    map.assets = [asset];
    map.objects = [lamp];

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.lookAt(0, 0, -10);
    camera.updateProjectionMatrix();
    rendered.update(0.016, camera, 1);

    const light = lightRoot.children[0] as THREE.PointLight;
    expect(rendered.objectGroups.get(lamp.id)?.getObjectByName('bulb')?.visible).toBe(false);
    expect(light.visible).toBe(true);
    expect(light.intensity).toBeGreaterThan(0);
    rendered.dispose();
  });
});

describe('procedural indoor finishes', () => {
  it('renders persisted rugs and maps split wall segments through one continuous surface texture', async () => {
    const map = applyMapOperations(
      createEmptyMap('finished room', 'finished-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [
        { type: 'room.set', room: { openings: [
          { id: 'window', kind: 'window', wall: 'north', offset: 0, bottom: 1, width: 2, height: 1.2 }
        ] } },
        { type: 'interior.art-direction.set', artDirection: {
          summary: 'warm room', palette: ['#765432', '#decbaa'], decorDensity: 0.6,
          surfaces: {
            floor: { recipe: 'wood.herringbone', roughness: 0.7 },
            north: { recipe: 'wallpaper.geometric', roughness: 0.91 }
          } as never,
          rugs: [{
            id: 'main', shape: 'rectangle', center: [0.1, -0.1], size: [0.5, 0.4], rotation: 90,
            pattern: 'border', palette: ['#765432', '#decbaa'], seed: 4
          }]
        } }
      ]
    );

    const rendered = await buildEditableMapGroup(map);
    const rugs = rendered.group.getObjectByName('proceduralRugs') as THREE.Group;
    const rug = rendered.group.getObjectByName('proceduralRug:main') as THREE.Mesh;
    const north = rendered.objectGroups.get('__room__:north') as THREE.Group;
    const wallMaterials = north.children.map((child) => (child as THREE.Mesh).material as THREE.MeshStandardMaterial);

    expect(rugs.children).toHaveLength(1);
    expect(rug.userData.proceduralRug).toBe(true);
    expect(rug.position.y).toBeCloseTo(0.012);
    expect((rug.geometry as THREE.PlaneGeometry).parameters.width).toBeCloseTo(7);
    expect((rug.geometry as THREE.PlaneGeometry).parameters.height).toBeCloseTo(4.48);
    expect(wallMaterials).toHaveLength(4);
    expect(wallMaterials.every((material) => material.roughness === 0.91)).toBe(true);
    expect(new Set(wallMaterials.map((material) => `${material.map?.offset.x}:${material.map?.repeat.x}`)).size).toBeGreaterThan(1);
    rendered.dispose();
  });

  it('renders a glass-panel ceiling as a transparent skylight without an opaque shadow shell', async () => {
    const map = applyMapOperations(
      createEmptyMap('glass room', 'glass-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [{ type: 'interior.art-direction.set', artDirection: {
        summary: 'glass conservatory', styleKeywords: ['conservatory'], palette: ['#dbe7da', '#70906c'], decorDensity: 0.6
      } }]
    );
    const rendered = await buildEditableMapGroup(map);
    const ceiling = rendered.objectGroups.get('__room__:ceiling') as THREE.Group;
    const material = (ceiling.children[0] as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    const shadowShell = rendered.group.getObjectByName('roomShadowShell') as THREE.Group;

    expect(material.isMeshPhysicalMaterial).toBe(true);
    expect(material.transparent).toBe(true);
    expect(material.transmission).toBeGreaterThan(0);
    expect(shadowShell.children).toHaveLength(4);
    rendered.dispose();
  });

  it('keeps disabled room finishes configured but renders the plain room shell', async () => {
    const map = applyMapOperations(
      createEmptyMap('disabled finishes', 'disabled-finishes', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]),
      [{ type: 'interior.art-direction.set', artDirection: {
        summary: 'stored but disabled', palette: ['#765432', '#decbaa'], decorDensity: 0.6,
        surfaces: {
          floor: { recipe: 'wood.herringbone', roughness: 0.37 },
          north: { recipe: 'wallpaper.geometric', roughness: 0.41 }
        } as never,
        rugs: [{
          id: 'stored', shape: 'rectangle', center: [0, 0], size: [0.5, 0.4], rotation: 0,
          pattern: 'border', palette: ['#765432', '#decbaa'], seed: 4
        }],
        finishSettings: {
          enabled: false, wallsEnabled: true, floorEnabled: true, carpetEnabled: false, rugsEnabled: true
        }
      } }]
    );

    const rendered = await buildEditableMapGroup(map);
    const floor = rendered.objectGroups.get('__room__:floor') as THREE.Group;
    const north = rendered.objectGroups.get('__room__:north') as THREE.Group;
    expect(rendered.group.getObjectByName('proceduralRugs')).toBeUndefined();
    expect(((floor.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).roughness).not.toBe(0.37);
    expect(((north.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).roughness).not.toBe(0.41);
    rendered.dispose();
  });
});

describe('grass-only refresh', () => {
  it('builds dense farm clumps, seeded magic variants, distinct moss, and visible flowers', async () => {
    const map = createEmptyMap('grass families', 'map-grass-families');
    const meadow = createGrassLayer(
      { id: 'meadow', seed: 7, preset: 'meadow', height: 0.8 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const farm = createGrassLayer(
      { id: 'farm', seed: 8, preset: 'farm', height: 1.55, mix: { short: 0, tall: 0, flowers: 1 } },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const moss = createGrassLayer(
      { id: 'moss', seed: 9, preset: 'alpine-moss', height: 0.45 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const magicA = createGrassLayer(
      { id: 'magic-a', seed: 10, preset: 'magic', height: 1.2 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const magicB = createGrassLayer(
      { id: 'magic-b', seed: 11, preset: 'magic', height: 1.2 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    map.grassLayers = [meadow, farm, moss, magicA, magicB];
    map.grassLayers.forEach((layer) => fillGrassLayerInPlace(map, layer.id, 0.12));

    const rendered = await buildEditableMapGroup(map);
    const meadowMesh = rendered.group.getObjectByName('grass:meadow') as THREE.InstancedMesh;
    const farmMesh = rendered.group.getObjectByName('grass:farm') as THREE.InstancedMesh;
    const mossMesh = rendered.group.getObjectByName('grass:moss') as THREE.InstancedMesh;
    const magicMeshA = rendered.group.getObjectByName('grass:magic-a') as THREE.InstancedMesh;
    const magicMeshB = rendered.group.getObjectByName('grass:magic-b') as THREE.InstancedMesh;
    const flowers = rendered.group.getObjectByName('grass-flowers:farm') as THREE.InstancedMesh;

    expect(meadowMesh.userData).toMatchObject({ grassPreset: 'meadow', grassHeight: 0.8 });
    expect(farmMesh.userData).toMatchObject({ grassPreset: 'farm', grassHeight: 1.55 });
    expect(mossMesh.userData).toMatchObject({ grassPreset: 'alpine-moss', grassHeight: 0.45 });
    expect(farmMesh.geometry.getAttribute('position').count).toBeGreaterThan(meadowMesh.geometry.getAttribute('position').count);
    expect(farmMesh.count).toBeGreaterThan(meadowMesh.count * 2.5);
    expect(mossMesh.geometry.boundingBox?.max.y).toBeLessThan(meadowMesh.geometry.boundingBox?.max.y ?? 0);
    expect(Array.from(magicMeshA.geometry.getAttribute('position').array)).not.toEqual(
      Array.from(magicMeshB.geometry.getAttribute('position').array)
    );
    expect(flowers.count).toBeGreaterThan(0);
    expect(flowers.geometry.getAttribute('position').count).toBeGreaterThan(10);
    rendered.dispose();
  });

  it('replaces just the grass field, keeps the applied style and picks up new density', async () => {
    const map = createEmptyMap('grass', 'map-grass-refresh');
    const layer = createGrassLayer({ seed: 3 }, map.terrain.resolutionX, map.terrain.resolutionZ);
    map.grassLayers = [layer];
    fillGrassLayerInPlace(map, layer.id, 0.4);

    const rendered = await buildEditableMapGroup(map);
    const fields = () => rendered.group.children.filter((child) => child.name === 'CartoonGrassField');
    const blades = () => rendered.group.getObjectByName(`grass:${layer.id}`) as THREE.InstancedMesh;
    const bladeHeightOf = (mesh: THREE.InstancedMesh): number => {
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      mesh.getMatrixAt(0, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale.y;
    };
    const first = blades();
    const firstHeight = bladeHeightOf(first);

    rendered.setGrassStyle({ ...DEFAULT_RUNTIME_GRASS_STYLE, bladeHeight: 1.4 });
    rendered.refreshGrass(map);
    const restyled = blades();

    expect(restyled).not.toBe(first);
    expect(fields()).toHaveLength(1);
    expect(bladeHeightOf(restyled) / firstHeight).toBeCloseTo(1.4 / DEFAULT_RUNTIME_GRASS_STYLE.bladeHeight, 5);

    fillGrassLayerInPlace(map, layer.id, 0.95);
    rendered.refreshGrass(map);

    expect(fields()).toHaveLength(1);
    expect(blades().count).toBeGreaterThan(restyled.count);
    rendered.dispose();
  });
});

function createTestObject(id: string, assetId: string) {
  return {
    id,
    name: id,
    parentId: null,
    assetId,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      size: [1, 1, 1] as [number, number, number]
    },
    visible: true,
    locked: false
  };
}
