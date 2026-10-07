import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { buildModelGroup } from '../src/client/modelRenderer';
import {
  resolveMapModelZFighting,
  resolveModelZFighting
} from '../src/client/modelZFighting';
import { createEmptyMap, type MapAsset } from '../src/shared/map';

interface BoxNode {
  id: string;
  transform: { pos: [number, number, number] };
  mesh: {
    type: 'box';
    params: { width: number; height: number; depth: number };
    color?: number;
    material?: Record<string, unknown>;
  };
}

function boxNode(
  id: string,
  position: [number, number, number],
  size: number | [number, number, number],
  color?: number
): BoxNode {
  const [width, height, depth] = Array.isArray(size) ? size : [size, size, size];
  return {
    id,
    transform: { pos: position },
    mesh: {
      type: 'box',
      params: { width, height, depth },
      ...(color === undefined ? {} : { color })
    }
  };
}

function stackedSlabsModel(colorLarge?: number, colorSmall?: number) {
  return {
    nodes: [
      boxNode('large', [0, 0.5, 0], [2, 1, 2], colorLarge),
      boxNode('small', [0.25, 0.5, 0.25], 1, colorSmall)
    ]
  };
}

// Exact facade/door dimensions from the cathedral portal that exposed this case.
function recessedDoorModel() {
  return { nodes: [
    boxNode('wall', [0, 5.5, 0], [6, 11, 1.2], 0xe8e6d6),
    boxNode('left-door', [-0.625, 2.37, 0.5], [1.22, 4.5, 0.18], 0x473021),
    boxNode('right-door', [0.625, 2.37, 0.5], [1.22, 4.5, 0.18], 0x473021)
  ] };
}

describe('coplanar z-fighting resolution', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => null })
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assigns the smaller primitive a render-only depth layer without moving source geometry', () => {
    const model = stackedSlabsModel();
    const result = resolveModelZFighting(model);
    const nodes = (result.modelJson as typeof model).nodes;

    expect(result.modelJson).not.toBe(model);
    expect(model.nodes[1].transform.pos).toEqual([0.25, 0.5, 0.25]);
    expect(nodes[1].transform.pos).toEqual([0.25, 0.5, 0.25]);
    expect(nodes[1].mesh.material).toMatchObject({
      coplanarDepthLayer: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    expect(result.stats).toMatchObject({
      entries: 2,
      pairChecks: 1,
      resolvedPairs: 1,
      adjustedNodes: 1,
      maxDepthLayer: 1
    });
  });

  it('exposes shallowly embedded thin door panels only in the render copy', () => {
    const model = recessedDoorModel();
    const original = structuredClone(model);
    const result = resolveModelZFighting(model);
    const nodes = (result.modelJson as typeof model).nodes;
    for (const panel of nodes.slice(1)) {
      expect(panel.transform.pos[2] + panel.mesh.params.depth / 2).toBeGreaterThan(0.6);
      expect(panel.transform.pos[2]).toBeLessThan(0.511);
      expect(panel.mesh.params).toEqual(model.nodes.find(node => node.id === panel.id)!.mesh.params);
      expect(panel.mesh.material).toMatchObject({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    }
    expect(nodes[0]).toBe(model.nodes[0]);
    expect(model).toEqual(original);
    expect(resolveModelZFighting(result.modelJson).modelJson).toEqual(result.modelJson);
  });

  it('does not pull out deeper recesses, thick blocks, or panels extending beyond the host face', () => {
    const wall = recessedDoorModel().nodes[0];
    for (const panel of [
      boxNode('deep-recess', [0, 2.37, 0.45], [1.22, 4.5, 0.18]),
      boxNode('structural-block', [0, 2.37, 0.15], [1.22, 4.5, 0.88]),
      boxNode('adjoining-panel', [2.8, 2.37, 0.5], [1.22, 4.5, 0.18]),
      boxNode('opposite-contact', [0, 2.37, 0.69], [1.22, 4.5, 0.18])
    ]) {
      const model = { nodes: [wall, panel] };
      expect(resolveModelZFighting(model).modelJson).toBe(model);
    }
  });

  it('resolves the same door under a rotated and nonuniformly scaled parent', () => {
    const model = { nodes: [
      { id: 'facade', transform: { pos: [3, 1, 5], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 3, 0.5] } },
      ...recessedDoorModel().nodes.map(node => ({ ...node, parent: 'facade' }))
    ] };
    const result = resolveModelZFighting(model);
    const panel = (result.modelJson as typeof model).nodes[2];
    expect(panel.transform!.pos[0]).toBeCloseTo(-0.625);
    expect(panel.transform!.pos[1]).toBeCloseTo(2.37);
    expect(panel.transform!.pos[2]).toBeGreaterThan(0.51);
    expect(panel.transform!.pos[2]).toBeLessThan(0.511);
  });

  it('leaves opposite-facing contacts alone but resolves same-color stacks', () => {
    const rug = {
      nodes: [
        boxNode('base', [0, -0.02, 0], [2.4, 0.06, 1.8], 0xf2d9b1),
        boxNode('motif', [-0.72, 0.016, 0.42], [0.52, 0.012, 0.52], 0xf4c842)
      ]
    };
    const sameColor = {
      nodes: [
        boxNode('m0', [0, -0.02, 0.04], [2.4, 0.06, 1.8], 0xf2d9b1),
        boxNode('m1', [0, -0.02, 0.04], [2.6, 0.06, 1.6], 0xf2d9b1)
      ]
    };

    expect(resolveModelZFighting(rug).stats.resolvedPairs).toBe(0);
    expect(resolveModelZFighting(rug).modelJson).toBe(rug);
    const resolvedSameColor = resolveModelZFighting(sameColor);
    expect(resolvedSameColor.stats.resolvedPairs).toBe(1);
    expect(resolvedSameColor.modelJson).not.toBe(sameColor);
    expect((resolvedSameColor.modelJson as typeof sameColor).nodes[1].mesh.material).toMatchObject({
      coplanarDepthLayer: 1,
      polygonOffsetUnits: -1
    });
  });

  it('orders a pair once even when it shares multiple coplanar face directions', () => {
    const model = {
      nodes: [
        { id: 'facade' },
        { ...boxNode('m1', [0, 17, 2.1], [22, 34, 1.8], 0xe8e6d6), parent: 'facade' },
        { ...boxNode('m2', [-9.4, 17.75, 0], [3.2, 35.5, 6], 0xe8e6d6), parent: 'facade' }
      ]
    };

    const result = resolveModelZFighting(model);
    const nodes = (result.modelJson as typeof model).nodes;
    const m1 = nodes[1] as BoxNode;
    const m2 = nodes[2] as BoxNode;

    expect(m1.transform.pos).toEqual([0, 17, 2.1]);
    expect(m2.transform.pos).toEqual([-9.4, 17.75, 0]);
    expect(m2.mesh.material).toMatchObject({ coplanarDepthLayer: 1, polygonOffsetUnits: -1 });
    expect(result.stats).toMatchObject({ resolvedPairs: 1, adjustedNodes: 1, maxDepthLayer: 1 });
  });

  it('runs from the normal model build entry', async () => {
    const group = await buildModelGroup(stackedSlabsModel());
    const small = group.getObjectByName('small') as THREE.Mesh;
    expect(small.position.y).toBeCloseTo(0.5, 10);
    expect((small.material as THREE.Material).polygonOffset).toBe(true);
    expect((small.material as THREE.Material).polygonOffsetFactor).toBe(-1);
    expect((small.material as THREE.Material).polygonOffsetUnits).toBe(-1);
    expect(group.userData.zFightingStats).toMatchObject({ resolvedPairs: 1, adjustedNodes: 1 });
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
  });

  it('adjusts a render copy of map assets while preserving collider truth', async () => {
    const modelJson = stackedSlabsModel();
    const colliderPlan = {
      version: 1 as const, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false
    };
    const asset = {
      id: 'asset', name: 'asset', prompt: '', modelJson, colliderPlan,
      mode: 'standard', createdAt: 0, updatedAt: 0
    } satisfies MapAsset;
    const map = { ...createEmptyMap('z-fight', 'z-fight'), assets: [asset] };
    map.objects = [{
      id: 'object', name: 'object', parentId: null, assetId: asset.id,
      transform: {
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1]
      },
      visible: true, locked: false
    }];
    const result = resolveMapModelZFighting(map);
    expect(result.map).not.toBe(map);
    expect(result.map.assets?.[0].modelJson).not.toBe(modelJson);
    expect(result.map.assets?.[0].colliderPlan).toBe(colliderPlan);
    expect(map.assets?.[0].modelJson).toBe(modelJson);

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.modelsRoot.userData.zFightingStats).toMatchObject({ adjustedAssets: 1, resolvedPairs: 1 });
    const materials: THREE.Material[] = [];
    rendered.modelsRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      materials.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
    });
    expect(materials.some((material) => material.polygonOffset && material.polygonOffsetUnits === -1)).toBe(true);
    rendered.dispose();

  });

  it('renders the corrected door through the map batching path without changing stored geometry or colliders', async () => {
    const modelJson = recessedDoorModel();
    const colliderPlan = {
      version: 1 as const, boxes: [], sourceMeshCount: 3, candidateCount: 0, fallbackUsed: false
    };
    const asset: MapAsset = {
      id: 'portal', name: 'portal', prompt: '', modelJson, colliderPlan,
      mode: 'standard', createdAt: 0, updatedAt: 0
    };
    const map = { ...createEmptyMap('door', 'door'), assets: [asset] };
    map.objects = [{
      id: 'entrance', name: 'entrance', parentId: null, assetId: asset.id,
      transform: { position: [0, 0, 13], rotation: [0, 0, 0], scale: [1, 1, 1], size: [6, 11, 1.2] },
      visible: true, locked: false
    }];
    const original = structuredClone(map);
    const rendered = await buildEditableMapGroup(map);
    try {
      rendered.group.updateMatrixWorld(true);
      const front = (nodeId: string) => {
        const ref = rendered.runtimeIndex.getRenderRef(`entrance:${nodeId}`)!;
        const mesh = ref.object as THREE.InstancedMesh;
        const matrix = mesh.matrixWorld.clone();
        if (ref.instanceId !== undefined) {
          const instance = new THREE.Matrix4();
          mesh.getMatrixAt(ref.instanceId, instance);
          matrix.multiply(instance);
        }
        mesh.geometry.computeBoundingBox();
        return { z: mesh.geometry.boundingBox!.clone().applyMatrix4(matrix).max.z, material: mesh.material as THREE.Material };
      };
      const wall = front('wall');
      for (const nodeId of ['left-door', 'right-door']) {
        const panel = front(nodeId);
        expect(panel.z).toBeGreaterThan(wall.z);
        expect(panel.material.polygonOffsetFactor).toBe(-1);
        expect(panel.material.polygonOffsetUnits).toBe(-1);
      }
      expect(map).toEqual(original);
      expect(map.assets[0].colliderPlan).toBe(colliderPlan);
    } finally { rendered.dispose(); }
  });
});
