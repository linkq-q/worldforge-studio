import * as THREE from 'three';
import type { MapAsset } from '../shared/map';
import {
  codePlanPlaceholderAssetId,
  type CodePlanAssetReadyPayload,
  type CodePlanPlacementPreview,
  type CodePlanPreviewPayload
} from '../shared/mapOperations';
import type { AgentAssetProgress } from '../shared/protocol';
import { buildModelGroup } from './modelRenderer';
import { calculateModelVisualBounds } from '../shared/modelBounds';

type PlacementStatus = 'queued' | 'running' | 'retrying' | 'failed' | 'success';

const ROLE_COLORS: Record<string, number> = {
  structure: 0x5b8def,
  environment: 0x55c47a,
  functional: 0xe8a54b,
  decor: 0xa779f0
};
const DEFAULT_COLOR = 0x86a8c8;
const RETRYING_COLOR = 0xd9c34a;
const FAILED_COLOR = 0xd95b5b;

interface PlacementEntry {
  key: string;
  placement: CodePlanPlacementPreview;
  root: THREE.Group;
  ghostFace: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  ghostEdges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  model: THREE.Object3D | null;
  status: PlacementStatus;
}

export interface GenerationPreviewOverlay {
  readonly group: THREE.Group;
  readonly active: boolean;
  showPlan(plan: CodePlanPreviewPayload, resolveAsset: (assetId: string) => MapAsset | undefined): void;
  attachAsset(payload: CodePlanAssetReadyPayload): void;
  updateAssetProgress(progress: { assets?: AgentAssetProgress[] }): void;
  update(nowMs: number): void;
  clear(): void;
  dispose(): void;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_BOX_EDGES = new THREE.EdgesGeometry(UNIT_BOX);

/**
 * View-only progress layer for the code-driven planner: translucent placeholder
 * boxes appear the moment discovery finishes, and each one is swapped for the
 * real model as soon as its asset finishes generating. It lives outside the
 * rebuildable map group so scene refreshes never remove it.
 */
export function createGenerationPreviewOverlay(scene: THREE.Scene): GenerationPreviewOverlay {
  const group = new THREE.Group();
  group.name = 'generation-preview-overlay';
  group.visible = false;
  scene.add(group);

  const entries = new Map<string, PlacementEntry>();
  const placeholdersByProgressName = new Map<string, string[]>();
  let modelWork = Promise.resolve();

  const disposeTree = (object: THREE.Object3D): void => {
    object.traverse((child) => {
      child.raycast = () => {};
      const mesh = child as THREE.Mesh;
      if (mesh.geometry && mesh.geometry !== UNIT_BOX && mesh.geometry !== UNIT_BOX_EDGES) {
        mesh.geometry.dispose();
      }
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  };

  const roleColor = (entry: PlacementEntry): number => {
    if (entry.status === 'failed') return FAILED_COLOR;
    if (entry.status === 'retrying') return RETRYING_COLOR;
    return ROLE_COLORS[entry.placement.role ?? ''] ?? DEFAULT_COLOR;
  };

  const applyGhostTint = (entry: PlacementEntry, faceOpacity: number, edgeOpacity: number): void => {
    const color = roleColor(entry);
    entry.ghostFace.material.color.setHex(color);
    entry.ghostEdges.material.color.setHex(color);
    entry.ghostFace.material.opacity = faceOpacity;
    entry.ghostEdges.material.opacity = edgeOpacity;
  };

  /** Declared dimensions win; a meaningful scale is the next best world-size estimate. */
  const footprintOf = (placement: CodePlanPlacementPreview): [number, number, number] => {
    if (placement.size.some((value) => Math.abs(value - 1) > 0.05)) {
      return [placement.size[0], placement.size[1], placement.size[2]];
    }
    if (placement.scale.some((value) => Math.abs(value - 1) > 0.05)) {
      return [placement.scale[0], placement.scale[1], placement.scale[2]];
    }
    return [placement.size[0], placement.size[1], placement.size[2]];
  };

  const createEntry = (placement: CodePlanPlacementPreview, key: string): PlacementEntry => {
    const root = new THREE.Group();
    root.name = `generation-preview:${key}`;
    root.position.set(placement.position[0], placement.position[1], placement.position[2]);
    root.rotation.y = placement.rotationY;
    const footprint = footprintOf(placement);
    const color = ROLE_COLORS[placement.role ?? ''] ?? DEFAULT_COLOR;
    const face = new THREE.Mesh(
      UNIT_BOX,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.12,
        depthTest: false,
        depthWrite: false
      })
    );
    face.scale.set(Math.max(0.05, footprint[0]), Math.max(0.05, footprint[1]), Math.max(0.05, footprint[2]));
    face.renderOrder = 18;
    face.raycast = () => {};
    const edges = new THREE.LineSegments(
      UNIT_BOX_EDGES,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false
      })
    );
    edges.scale.copy(face.scale);
    edges.renderOrder = 19;
    edges.raycast = () => {};
    root.add(face, edges);
    group.add(root);
    return { key, placement, root, ghostFace: face, ghostEdges: edges, model: null, status: 'queued' };
  };

  /**
   * Fits the finished model's real bounds onto the ghost footprint so the swap
   * is visually seamless; existing-asset placements instead use the transform
   * scale exactly as the sandbox fitted it during discovery.
   */
  const attachModel = (entry: PlacementEntry, asset: MapAsset, fitToFootprint: boolean): void => {
    modelWork = modelWork.then(async () => {
      if (entry.model || !entries.has(entry.key)) return;
      const model = await buildModelGroup(asset.modelJson);
      model.raycast = () => {};
      if (fitToFootprint) {
        const footprint = footprintOf(entry.placement);
        const bounds = calculateModelVisualBounds(asset.modelJson);
        const boundsSize: [number, number, number] = [
          Math.max(0.000001, bounds.max[0] - bounds.min[0]),
          Math.max(0.000001, bounds.max[1] - bounds.min[1]),
          Math.max(0.000001, bounds.max[2] - bounds.min[2])
        ];
        model.scale.set(footprint[0] / boundsSize[0], footprint[1] / boundsSize[1], footprint[2] / boundsSize[2]);
        const center = new THREE.Vector3(
          (bounds.min[0] + bounds.max[0]) / 2,
          (bounds.min[1] + bounds.max[1]) / 2,
          (bounds.min[2] + bounds.max[2]) / 2
        );
        model.position.set(-center.x * model.scale.x, -center.y * model.scale.y, -center.z * model.scale.z);
      } else {
        model.scale.set(entry.placement.scale[0], entry.placement.scale[1], entry.placement.scale[2]);
      }
      entry.model = model;
      entry.status = 'success';
      entry.ghostFace.visible = false;
      entry.ghostEdges.visible = false;
      entry.root.add(model);
    }).catch(() => {
      // Keep the ghost box when the model cannot be built; the final preview map stays authoritative.
    });
  };

  const overlay: GenerationPreviewOverlay = {
    group,
    get active(): boolean {
      return entries.size > 0;
    },
    showPlan(plan, resolveAsset) {
      overlay.clear();
      placeholdersByProgressName.clear();
      for (const requirement of plan.requirements) {
        for (let variantIndex = 0; variantIndex < requirement.variants; variantIndex += 1) {
          // The asset pool reports tasks as "${name} ${i + 1}" when a requirement has multiple variants.
          const progressName = requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name;
          const placeholders = placeholdersByProgressName.get(progressName) ?? [];
          placeholders.push(codePlanPlaceholderAssetId(requirement.key, variantIndex));
          placeholdersByProgressName.set(progressName, placeholders);
        }
      }
      for (const placement of plan.placements) {
        const key = placement.objectId || `${placement.name}@${placement.position.join(',')}`;
        const entry = createEntry(placement, key);
        entries.set(key, entry);
        if (!placement.pending && placement.assetId) {
          const asset = resolveAsset(placement.assetId);
          if (asset) attachModel(entry, asset, false);
        }
      }
      group.visible = entries.size > 0;
    },
    attachAsset(payload) {
      const placeholderId = codePlanPlaceholderAssetId(payload.key, payload.variantIndex);
      for (const entry of entries.values()) {
        if (entry.placement.assetId === placeholderId && !entry.model) {
          attachModel(entry, payload.asset, true);
        }
      }
    },
    updateAssetProgress(progress) {
      if (!progress.assets) return;
      for (const asset of progress.assets) {
        if (asset.status !== 'running' && asset.status !== 'retrying' && asset.status !== 'failed') continue;
        const placeholders = placeholdersByProgressName.get(asset.name);
        if (!placeholders) continue;
        const placeholderSet = new Set(placeholders);
        for (const entry of entries.values()) {
          if (!placeholderSet.has(entry.placement.assetId ?? '')) continue;
          if (entry.status === 'success' || entry.status === asset.status) continue;
          entry.status = asset.status;
        }
      }
    },
    update(nowMs) {
      if (!group.visible) return;
      let index = 0;
      for (const entry of entries.values()) {
        index += 1;
        if (entry.model || entry.status === 'failed') continue;
        const speed = entry.status === 'running' || entry.status === 'retrying' ? 2.6 : 1.2;
        const wave = 0.5 + 0.5 * Math.sin(nowMs / 1000 * speed + index * 0.7);
        if (entry.status === 'running' || entry.status === 'retrying') {
          applyGhostTint(entry, 0.16 + 0.18 * wave, 0.55 + 0.4 * wave);
        } else {
          applyGhostTint(entry, 0.1 + 0.06 * wave, 0.45 + 0.18 * wave);
        }
      }
    },
    clear() {
      for (const entry of entries.values()) {
        entry.root.removeFromParent();
        disposeTree(entry.root);
      }
      entries.clear();
      group.visible = false;
    },
    dispose() {
      overlay.clear();
      placeholdersByProgressName.clear();
      group.removeFromParent();
    }
  };

  return overlay;
}
