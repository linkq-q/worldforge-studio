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

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_BOX_EDGE_POSITIONS = new THREE.EdgesGeometry(UNIT_BOX).attributes.position.array as Float32Array;
const EDGE_VERTEX_COUNT = UNIT_BOX_EDGE_POSITIONS.length / 3;
const UP = new THREE.Vector3(0, 1, 0);
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

interface PlacementEntry {
  key: string;
  instanceIndex: number;
  placement: CodePlanPlacementPreview;
  status: PlacementStatus;
  modelRoot: THREE.Group | null;
}

interface ModelBuildJob {
  entry: PlacementEntry;
  asset: MapAsset;
  fitToFootprint: boolean;
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

/**
 * View-only progress layer for the code-driven planner: translucent placeholder
 * boxes appear the moment discovery finishes, and each one is swapped for the
 * real model as soon as its asset finishes generating.
 *
 * Performance contract: the ghost layer is exactly two draw calls (one
 * InstancedMesh for the faces, one merged LineSegments for the edges), and
 * finished models are built at most one per animation frame so voxel meshing
 * never blocks the main thread for seconds at a time. It lives outside the
 * rebuildable map group so scene refreshes never remove it.
 */
export function createGenerationPreviewOverlay(scene: THREE.Scene): GenerationPreviewOverlay {
  const group = new THREE.Group();
  group.name = 'generation-preview-overlay';
  group.visible = false;
  scene.add(group);

  const entries = new Map<string, PlacementEntry>();
  const placeholdersByProgressName = new Map<string, string[]>();
  const buildQueue: ModelBuildJob[] = [];
  let building = false;
  let facesMesh: THREE.InstancedMesh | null = null;
  let faceMaterial: THREE.MeshBasicMaterial | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let edgeMaterial: THREE.LineBasicMaterial | null = null;
  let edgePositions: Float32Array | null = null;
  let edgeColors: Float32Array | null = null;

  const roleColor = (entry: PlacementEntry): number => {
    if (entry.status === 'failed') return FAILED_COLOR;
    if (entry.status === 'retrying') return RETRYING_COLOR;
    return ROLE_COLORS[entry.placement.role ?? ''] ?? DEFAULT_COLOR;
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

  const writeEdgeVertex = (entry: PlacementEntry, vertexIndex: number, x: number, y: number, z: number): void => {
    if (!edgePositions) return;
    const base = (entry.instanceIndex * EDGE_VERTEX_COUNT + vertexIndex) * 3;
    edgePositions[base] = x;
    edgePositions[base + 1] = y;
    edgePositions[base + 2] = z;
  };

  const hideGhost = (entry: PlacementEntry): void => {
    facesMesh?.setMatrixAt(entry.instanceIndex, ZERO_MATRIX);
    if (facesMesh) facesMesh.instanceMatrix.needsUpdate = true;
    for (let vertex = 0; vertex < EDGE_VERTEX_COUNT; vertex += 1) writeEdgeVertex(entry, vertex, 0, 0, 0);
    if (edgeLines) edgeLines.geometry.attributes.position.needsUpdate = true;
  };

  const recolorEntry = (entry: PlacementEntry): void => {
    const color = roleColor(entry);
    facesMesh?.setColorAt(entry.instanceIndex, new THREE.Color(color));
    if (facesMesh?.instanceColor) facesMesh.instanceColor.needsUpdate = true;
    if (edgeColors) {
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;
      for (let vertex = 0; vertex < EDGE_VERTEX_COUNT; vertex += 1) {
        const base = (entry.instanceIndex * EDGE_VERTEX_COUNT + vertex) * 3;
        edgeColors[base] = r;
        edgeColors[base + 1] = g;
        edgeColors[base + 2] = b;
      }
      if (edgeLines) edgeLines.geometry.attributes.color.needsUpdate = true;
    }
  };

  const attachModelRoot = (entry: PlacementEntry, model: THREE.Object3D): void => {
    const root = new THREE.Group();
    root.name = `generation-preview:${entry.key}`;
    root.position.set(entry.placement.position[0], entry.placement.position[1], entry.placement.position[2]);
    root.rotation.y = entry.placement.rotationY;
    root.add(model);
    // The overlay is a transient read-only preview: keep it out of shadow passes
    // and out of the per-frame matrix refresh.
    root.traverse((child) => {
      child.raycast = () => {};
      child.castShadow = false;
      child.receiveShadow = false;
      child.matrixAutoUpdate = false;
      child.updateMatrix();
    });
    root.matrixAutoUpdate = false;
    root.updateMatrix();
    entry.modelRoot = root;
    group.add(root);
  };

  /**
   * Fits the finished model's real bounds onto the ghost footprint so the swap
   * is visually seamless; existing-asset placements instead use the transform
   * scale exactly as the sandbox fitted it during discovery.
   */
  const pumpBuild = (): void => {
    if (building || buildQueue.length === 0) return;
    const job = buildQueue.shift()!;
    building = true;
    void (async () => {
      const startedAt = performance.now();
      try {
        const model = await buildModelGroup(job.asset.modelJson);
        const buildMs = performance.now() - startedAt;
        if (buildMs > 16) console.info(`[perf] generation preview built "${job.asset.name}" in ${buildMs.toFixed(0)}ms`);
        // A new plan may have cleared the layer while this build was in flight.
        if (entries.get(job.entry.key) !== job.entry) return;
        // buildModelGroup already rests the visual bottom at y=0, centered in
        // x/z (centerGroup), matching the final renderer's transform contract
        // (position + scale * size). Scaling preserves that alignment, so no
        // extra offset is applied here.
        if (job.fitToFootprint) {
          const footprint = footprintOf(job.entry.placement);
          const bounds = calculateModelVisualBounds(job.asset.modelJson);
          const boundsSize: [number, number, number] = [
            Math.max(0.000001, bounds.max[0] - bounds.min[0]),
            Math.max(0.000001, bounds.max[1] - bounds.min[1]),
            Math.max(0.000001, bounds.max[2] - bounds.min[2])
          ];
          model.scale.set(footprint[0] / boundsSize[0], footprint[1] / boundsSize[1], footprint[2] / boundsSize[2]);
        } else {
          model.scale.set(
            job.entry.placement.scale[0] * job.entry.placement.size[0],
            job.entry.placement.scale[1] * job.entry.placement.size[1],
            job.entry.placement.scale[2] * job.entry.placement.size[2]
          );
        }
        job.entry.status = 'success';
        attachModelRoot(job.entry, model);
        hideGhost(job.entry);
      } catch {
        // Keep the ghost box when the model cannot be built; the final preview map stays authoritative.
      } finally {
        building = false;
      }
    })();
  };

  const overlay: GenerationPreviewOverlay = {
    group,
    get active(): boolean {
      return entries.size > 0;
    },
    showPlan(plan, resolveAsset) {
      const planStartedAt = performance.now();
      overlay.clear();
      placeholdersByProgressName.clear();
      const count = plan.placements.length;
      if (count === 0) return;

      faceMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.12,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      facesMesh = new THREE.InstancedMesh(UNIT_BOX, faceMaterial, count);
      facesMesh.frustumCulled = false;
      facesMesh.renderOrder = 18;
      facesMesh.raycast = () => {};

      edgePositions = new Float32Array(count * EDGE_VERTEX_COUNT * 3);
      edgeColors = new Float32Array(count * EDGE_VERTEX_COUNT * 3);
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
      edgeGeometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
      edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false
      });
      edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeLines.frustumCulled = false;
      edgeLines.renderOrder = 19;
      edgeLines.raycast = () => {};

      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const vertex = new THREE.Vector3();
      plan.placements.forEach((placement, index) => {
        const key = placement.objectId || `${placement.name}@${placement.position.join(',')}`;
        const entry: PlacementEntry = { key, instanceIndex: index, placement, status: 'queued', modelRoot: null };
        entries.set(key, entry);
        const footprint = footprintOf(placement);
        position.set(placement.position[0], placement.position[1], placement.position[2]);
        quaternion.setFromAxisAngle(UP, placement.rotationY);
        scale.set(Math.max(0.05, footprint[0]), Math.max(0.05, footprint[1]), Math.max(0.05, footprint[2]));
        matrix.compose(position.set(placement.position[0], placement.position[1] + footprint[1] / 2, placement.position[2]), quaternion, scale);
        facesMesh!.setMatrixAt(index, matrix);
        facesMesh!.setColorAt(index, new THREE.Color(ROLE_COLORS[placement.role ?? ''] ?? DEFAULT_COLOR));
        for (let edgeVertex = 0; edgeVertex < EDGE_VERTEX_COUNT; edgeVertex += 1) {
          vertex.set(
            UNIT_BOX_EDGE_POSITIONS[edgeVertex * 3] * footprint[0],
            UNIT_BOX_EDGE_POSITIONS[edgeVertex * 3 + 1] * footprint[1] + footprint[1] / 2,
            UNIT_BOX_EDGE_POSITIONS[edgeVertex * 3 + 2] * footprint[2]
          );
          vertex.applyQuaternion(quaternion).add(position);
          writeEdgeVertex(entry, edgeVertex, vertex.x, vertex.y, vertex.z);
        }
        recolorEntry(entry);
      });
      facesMesh.instanceMatrix.needsUpdate = true;
      if (facesMesh.instanceColor) facesMesh.instanceColor.needsUpdate = true;
      edgeGeometry.attributes.position.needsUpdate = true;
      edgeGeometry.attributes.color.needsUpdate = true;
      group.add(facesMesh, edgeLines);

      for (const requirement of plan.requirements) {
        for (let variantIndex = 0; variantIndex < requirement.variants; variantIndex += 1) {
          // The asset pool reports tasks as "${name} ${i + 1}" when a requirement has multiple variants.
          const progressName = requirement.variants > 1 ? `${requirement.name} ${variantIndex + 1}` : requirement.name;
          const placeholders = placeholdersByProgressName.get(progressName) ?? [];
          placeholders.push(codePlanPlaceholderAssetId(requirement.key, variantIndex));
          placeholdersByProgressName.set(progressName, placeholders);
        }
      }
      for (const entry of entries.values()) {
        if (!entry.placement.pending && entry.placement.assetId) {
          const asset = resolveAsset(entry.placement.assetId);
          if (asset) buildQueue.push({ entry, asset, fitToFootprint: false });
        }
      }
      group.visible = true;
      const planMs = performance.now() - planStartedAt;
      if (planMs > 16) console.info(`[perf] generation plan layer (${count} placements) in ${planMs.toFixed(0)}ms`);
    },
    attachAsset(payload) {
      const placeholderId = codePlanPlaceholderAssetId(payload.key, payload.variantIndex);
      for (const entry of entries.values()) {
        if (entry.placement.assetId === placeholderId && !entry.modelRoot && entry.status !== 'failed') {
          buildQueue.push({ entry, asset: payload.asset, fitToFootprint: true });
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
          if (entry.modelRoot || entry.status === asset.status) continue;
          entry.status = asset.status;
          recolorEntry(entry);
        }
      }
    },
    update(nowMs) {
      // At most one voxel model meshing job per frame keeps long builds from
      // blocking the main thread while assets stream in.
      pumpBuild();
      if (!group.visible || !faceMaterial || !edgeMaterial) return;
      const wave = 0.5 + 0.5 * Math.sin(nowMs / 1000 * 1.6);
      faceMaterial.opacity = 0.1 + 0.07 * wave;
      edgeMaterial.opacity = 0.45 + 0.2 * wave;
    },
    clear() {
      buildQueue.length = 0;
      entries.clear();
      for (const child of [...group.children]) {
        group.remove(child);
        child.traverse((descendant) => {
          const mesh = descendant as THREE.Mesh;
          if (mesh.geometry && mesh.geometry !== UNIT_BOX) mesh.geometry.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material?.dispose();
        });
      }
      facesMesh?.dispose();
      facesMesh = null;
      faceMaterial = null;
      edgeLines = null;
      edgeMaterial = null;
      edgePositions = null;
      edgeColors = null;
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
