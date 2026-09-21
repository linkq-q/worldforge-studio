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
      polygonOffsetFactor: 0,
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
    expect((small.material as THREE.Material).polygonOffsetFactor).toBe(0);
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
});
