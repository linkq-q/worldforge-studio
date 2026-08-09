import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPipeline } from '@voxel-studio/render-runtime';

export interface RenderPrePassResources {
  normal: THREE.Texture;
  depth: THREE.DepthTexture | null;
}

export interface RenderFrameCoordinatorOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  needsPrePass(): boolean;
  producePrePass(): RenderPrePassResources | null;
  updateWater(deltaTime: number, depthTexture: THREE.DepthTexture | null): void;
}

export interface RenderPipelineStats {
  stages: Array<{ name: string; ms: number }>;
  passes: Array<{ id: string; name: string; enabled: boolean }>;
  composerTrace: null | { total: number; unknown: number; passes: Array<{ name: string; ms: number }> };
}

/**
 * WorldForge host wiring for the shared render runtime frame scheduler.
 * Capability modules own their resources; this class only declares ordering
 * and resource demand to RenderPipeline/RenderGraph.
 */
export class RenderFrameCoordinator {
  private readonly pipeline: RenderPipeline;

  constructor(private readonly options: RenderFrameCoordinatorOptions) {
    this.pipeline = new RenderPipeline({
      renderer: options.renderer,
      scene: options.scene,
      camera: options.camera,
      composer: options.composer
    });
    this.pipeline.graph.registerProducer({
      id: 'worldforgePrePass',
      phase: 'prePass',
      writes: ['scene:normal', 'scene:depth'],
      run: (_context, blackboard) => {
        const resources = this.options.producePrePass();
        if (!resources) return;
        blackboard.set('scene:normal', resources.normal);
        blackboard.set('scene:depth', resources.depth);
      }
    });
    this.pipeline.graph.registerConsumer({
      id: 'worldforgePrePassConsumers',
      reads: ['scene:normal', 'scene:depth'],
      enabled: () => this.options.needsPrePass()
    });
  }

  registerPass(pass: Pass, id: string, order: number, enabled: boolean): void {
    this.pipeline.registerPass(pass, 'mainComposer', order, { id, enabled });
  }

  setPassEnabled(id: string, enabled: boolean): void {
    this.pipeline.setPassEnabled(id, enabled);
    this.pipeline.syncComposer();
  }

  syncPasses(): void {
    this.pipeline.syncComposer();
  }

  getStats(): RenderPipelineStats {
    return this.pipeline.getStats();
  }

  notifySceneLoaded(protectionFrames = 2): void {
    this.pipeline.notifySceneLoaded(protectionFrames);
  }

  renderFrame(deltaTime: number, elapsedSeconds: number): void {
    this.pipeline.renderFrame(deltaTime, elapsedSeconds, {
      getPrePassConsumers: () => ({ needsPrePass: this.options.needsPrePass() }),
      updateWater: () => {
        const depth = this.options.needsPrePass()
          ? this.pipeline.graph.getResource('scene:depth') as THREE.DepthTexture | null
          : null;
        this.options.updateWater(deltaTime, depth);
      }
    });
  }
}
