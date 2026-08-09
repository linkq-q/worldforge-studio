import * as THREE from 'three';

function hasTransparentMaterial(material) {
  if (Array.isArray(material)) return material.some(hasTransparentMaterial);
  return Boolean(material?.transparent || material?.transmission > 0);
}

/**
 * One shared scene-color buffer for every model-water body in Voxel Studio.
 * It preserves the normal model meshes/materials, so their existing batching is
 * reused unchanged; only one extra half-resolution opaque scene pass is added.
 */
export class WaterSceneCapture {
  constructor(renderer, scene, { scale = 0.5 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.scale = scale;
    this.viewportSize = new THREE.Vector2(1, 1);
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'WaterSceneColor';
  }

  get texture() {
    return this.target.texture;
  }

  _hasVisibleBody() {
    let found = false;
    this.scene.traverseVisible((object) => {
      if (object.userData?.isWaterRefractionBody) found = true;
    });
    return found;
  }

  _resize() {
    this.renderer.getDrawingBufferSize(this.viewportSize);
    const width = Math.max(1, Math.round(this.viewportSize.x * this.scale));
    const height = Math.max(1, Math.round(this.viewportSize.y * this.scale));
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
    }
  }

  render(camera) {
    if (!this._hasVisibleBody()) return false;
    this._resize();

    // The captured texture is the background seen through water. Transparent
    // surfaces (including the glass shell and all water) render in the main pass.
    const hidden = [];
    this.scene.traverseVisible((object) => {
      if (!object.isMesh) return;
      if (object.userData?.isWater || hasTransparentMaterial(object.material)) {
        hidden.push(object);
        object.visible = false;
      }
    });

    const previousTarget = this.renderer.getRenderTarget();
    const previousXrEnabled = this.renderer.xr?.enabled;
    try {
      if (this.renderer.xr) this.renderer.xr.enabled = false;
      this.renderer.setRenderTarget(this.target);
      this.renderer.clear();
      this.renderer.render(this.scene, camera);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      if (this.renderer.xr) this.renderer.xr.enabled = previousXrEnabled;
      for (const object of hidden) object.visible = true;
    }
    return true;
  }

  dispose() {
    this.target.dispose();
  }
}

export default WaterSceneCapture;
