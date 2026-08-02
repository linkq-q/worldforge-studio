import type * as THREE from 'three';
import { ObjectDistanceCuller, type RuntimeIndex } from '@voxel-studio/render-runtime';

export interface MapObjectCullingStats {
  tested: number;
  culled: number;
}

/** Keeps distance-culling lifecycle outside the map builder and editor loop. */
export class MapObjectCulling {
  private readonly culler = new ObjectDistanceCuller({ hysteresis: 0.1 });

  constructor(private readonly runtimeIndex: RuntimeIndex) {}

  update(camera: THREE.Camera, maxDistance: number): MapObjectCullingStats {
    this.culler.syncRuntimeIndex(this.runtimeIndex);
    return this.culler.update(camera, maxDistance);
  }

  dispose(): void {
    this.culler.dispose();
  }
}
