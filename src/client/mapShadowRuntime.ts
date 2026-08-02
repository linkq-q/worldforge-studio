import type * as THREE from 'three';
import { CSMController } from '@voxel-studio/render-runtime';

const WORLD_FORGE_CSM = {
  enabled: true,
  cascades: 3,
  shadowMapSize: 2048,
  maxFar: 240,
  mode: 'practical' as const,
  fade: true,
  lightMargin: 40,
  bias: -0.0001,
  normalBias: 0.02
};

/** Owns cascaded shadows for one rendered map lifetime. */
export class MapShadowRuntime {
  private controller: CSMController | null = null;
  private terrain: THREE.Object3D | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly sun: THREE.DirectionalLight,
    private readonly restoreFallbackShadowFit: () => void
  ) {}

  setSceneRoots(contentRoot: THREE.Object3D | null, modelsRoot: THREE.Object3D | null): void {
    this.disposeController();
    if (!contentRoot || !modelsRoot) return;

    this.terrain = contentRoot.getObjectByName('terrain') ?? null;
    this.controller = new CSMController({
      sun: this.sun,
      camera: this.camera,
      scene: this.scene,
      modelRoot: modelsRoot,
      updateSceneShadowCameraFit: this.restoreFallbackShadowFit
    });
    this.controller.applyCsmParams(WORLD_FORGE_CSM);
    if (this.terrain) this.controller.setupCsmMaterials(this.terrain);
  }

  update(): void {
    const controller = this.controller;
    if (!controller?.enabled || !controller.csm) return;
    controller.syncCsmFromSun();
    controller.csm.update();
  }

  dispose(): void {
    this.disposeController();
  }

  private disposeController(): void {
    if (!this.controller) return;
    if (this.terrain) this.controller.removeCsmPatches(this.terrain);
    this.controller.disposeCsm();
    this.controller = null;
    this.terrain = null;
  }
}
