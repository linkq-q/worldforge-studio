import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createGenerationPreviewOverlay } from '../src/client/generationPreviewOverlay';
import type { MapAsset } from '../src/shared/map';
import type { CodePlanPreviewPayload } from '../src/shared/mapOperations';

const asset: MapAsset = {
  id: 'asset-tower', name: '塔', prompt: '塔', tags: [],
  modelJson: { nodes: [{ id: 'tower', transform: { pos: [0, 5, 0] }, mesh: {
    type: 'box', params: { width: 6, height: 10, depth: 4 }
  } }] },
  colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
  mode: 'voxel', createdAt: 1, updatedAt: 1
};

describe('generation preview overlay scale', () => {
  it('uses the final object transform for both ghost size and streamed model scale', async () => {
    const overlay = createGenerationPreviewOverlay(new THREE.Scene());
    const plan: CodePlanPreviewPayload = {
      summary: '塔的规划', requirements: [{ key: 'tower', name: '塔', variants: 1 }],
      placements: [
        { objectId: 'tower', name: '塔', assetId: 'code-asset://tower/0', pending: true,
          position: [2, 0, 3], rotationY: 0, size: [1, 1, 1], scale: [1, 1, 1] },
        { objectId: 'scaled', name: '放大占位', assetId: null, pending: false,
          position: [10, 0, 3], rotationY: 0, size: [3, 2, 4], scale: [2, 1.5, 0.5] }
      ]
    };

    try {
      overlay.showPlan(plan, () => undefined);
      const faces = overlay.group.children.find((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh)!;
      const matrix = new THREE.Matrix4();
      const ghostScale = new THREE.Vector3();
      faces.getMatrixAt(1, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), ghostScale);
      expect(ghostScale.toArray()).toEqual([6, 3, 2]);

      overlay.attachAsset({ key: 'tower', variantIndex: 0, asset });
      overlay.update(0);
      await vi.waitFor(() => expect(overlay.group.getObjectByName('generation-preview:tower')).toBeTruthy());
      const model = overlay.group.getObjectByName('generation-preview:tower')!.children[0];
      expect(model.scale.toArray()).toEqual([1, 1, 1]);
      const worldSize = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      expect(worldSize.toArray()).toEqual([6, 10, 4]);
    } finally {
      overlay.dispose();
    }
  });

  it('keeps declared ghost bounds separate from the finished model transform', async () => {
    const overlay = createGenerationPreviewOverlay(new THREE.Scene());
    const plan: CodePlanPreviewPayload = {
      summary: '塔的尺寸', requirements: [{ key: 'tower', name: '塔', variants: 2 }],
      placements: [
        { objectId: 'declared', name: '声明尺寸', assetId: 'code-asset://tower/0', pending: true,
          position: [0, 0, 0], rotationY: 0, size: [1, 1, 1], placeholderSize: [6, 10, 4], scale: [1, 1, 1] },
        { objectId: 'fitted', name: '放大拟合', assetId: 'code-asset://tower/1', pending: true,
          position: [20, 0, 0], rotationY: 0, size: [3, 5, 2], scale: [2, 1, 0.5], fitToDimensions: true }
      ]
    };

    try {
      overlay.showPlan(plan, () => undefined);
      const faces = overlay.group.children.find((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh)!;
      const matrix = new THREE.Matrix4();
      const ghostScale = new THREE.Vector3();
      faces.getMatrixAt(0, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), ghostScale);
      expect(ghostScale.toArray()).toEqual([6, 10, 4]);

      overlay.attachAsset({ key: 'tower', variantIndex: 0, asset });
      overlay.attachAsset({ key: 'tower', variantIndex: 1, asset });
      overlay.update(0);
      await vi.waitFor(() => expect(overlay.group.getObjectByName('generation-preview:declared')).toBeTruthy());
      overlay.update(16);
      await vi.waitFor(() => expect(overlay.group.getObjectByName('generation-preview:fitted')).toBeTruthy());
      const declaredModel = overlay.group.getObjectByName('generation-preview:declared')!.children[0];
      const fittedModel = overlay.group.getObjectByName('generation-preview:fitted')!.children[0];
      expect(declaredModel.scale.toArray()).toEqual([1, 1, 1]);
      expect(fittedModel.scale.toArray()).toEqual([1, 0.5, 0.25]);
    } finally {
      overlay.dispose();
    }
  });
});
