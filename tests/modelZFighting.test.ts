import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { buildModelGroup } from '../src/client/modelRenderer';
import {
  MODEL_Z_FIGHTING_OFFSET,
  resolveMapModelZFighting,
  resolveModelZFighting
} from '../src/client/modelZFighting';
import { createEmptyMap, type MapAsset } from '../src/shared/map';

function boxNode(
  id: string,
  position: [number, number, number],
  size: number | [number, number, number],
  color?: number
) {
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

  it('micro-offsets the smaller primitive without mutating source JSON', () => {
    const model = stackedSlabsModel();
    const result = resolveModelZFighting(model);
    const nodes = (result.modelJson as typeof model).nodes;

    expect(result.modelJson).not.toBe(model);
    expect(model.nodes[1].transform.pos).toEqual([0.25, 0.5, 0.25]);
    expect(nodes[1].transform.pos[1]).toBeCloseTo(0.5 + MODEL_Z_FIGHTING_OFFSET, 10);
    expect(result.stats).toMatchObject({ entries: 2, pairChecks: 1, resolvedPairs: 1, adjustedNodes: 1 });
  });

  it('leaves opposite-facing contacts and same-color stacks alone', () => {
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
    expect(resolveModelZFighting(sameColor).stats.resolvedPairs).toBe(0);
    expect(resolveModelZFighting(sameColor).modelJson).toBe(sameColor);
  });

  it('runs from the normal model build entry', async () => {
    const group = await buildModelGroup(stackedSlabsModel());
    expect(group.getObjectByName('small')?.position.y).toBeCloseTo(0.5 + MODEL_Z_FIGHTING_OFFSET, 10);
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
    const result = resolveMapModelZFighting(map);
    expect(result.map).not.toBe(map);
    expect(result.map.assets?.[0].modelJson).not.toBe(modelJson);
    expect(result.map.assets?.[0].colliderPlan).toBe(colliderPlan);
    expect(map.assets?.[0].modelJson).toBe(modelJson);

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.modelsRoot.userData.zFightingStats).toMatchObject({ adjustedAssets: 1, resolvedPairs: 1 });
    rendered.dispose();

  });
});
