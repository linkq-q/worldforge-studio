/**
 * PlanarReflectionPass.js — 水平水面建筑倒影
 *
 * 使用镜面摄像机将 scene 渲染到 RenderTarget，再通过 textureMatrix
 * 投影到 WaterSurface 的 fragment shader 中采样，实现透视正确的平面倒影。
 *
 * 架构约束（docs/architecture-constraints.md）：
 * - 不翻转场景对象（不修改 modelsRoot / scene 中任何 mesh 的 transform）
 * - 不扩展 EnvironmentReflectionManager 语义
 * - 排除 waterMesh / editorRoot / gizmo / helpers / debug mesh
 * - 新增 RenderTarget 打 skipShaderApply + isEnvironmentObject
 *
 * P0 scope：单水面、512px、无 roughness blur、camera-dirty 节流
 */

import * as THREE from 'three';

const RESOLUTION_MAP = {
  low: 256,
  medium: 512,
  high: 1024,
  ultra: 2048,
};

// Presentation 策略：让倒影 AA/分辨率 与主画面同步（smooth=平滑 / pixelated=像素感）
// resolutionScale 相对 drawingBuffer，maxSize 封顶避免无脑等于全屏分辨率
const PRESENTATION_DEFAULTS = {
  smooth:    { resolutionScale: 0.75, maxSize: 1536, samples: 2, filter: 'linear',  distortionScale: 1.0 },
  pixelated: { resolutionScale: 0.5,  maxSize: 1024, samples: 0, filter: 'nearest', distortionScale: 0.75 },
};

function configureReflectionTexture(texture) {
  texture.userData.skipShaderApply = true;
  texture.userData.isEnvironmentObject = true;
}

export class PlanarReflectionPass {
  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene}         opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera — 主摄像机
   * @param {THREE.Mesh}          opts.waterMesh — 水面 mesh（用于计算反射平面 + 排除）
   * @param {number}              [opts.waterLevel=0] — 水面 Y 坐标
   * @param {number}              [opts.width=512]
   * @param {number}              [opts.height=512]
   * @param {number}              [opts.clipBias=0.003]
   * @param {THREE.Object3D[]}    [opts.excludeObjects=[]] — 额外排除的对象列表
   * @param {boolean}             [opts.enabled=true]
   */
  constructor(opts = {}) {
    this.renderer = opts.renderer;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.waterMesh = opts.waterMesh;
    this.waterLevel = opts.waterLevel ?? 0;

    const width = opts.width ?? 512;
    const height = opts.height ?? 512;
    this._clipBias = opts.clipBias ?? 0.003;
    this._excludeObjects = opts.excludeObjects ?? [];

    this.enabled = opts.enabled !== false;
    this.tier = opts.tier || 'medium';

    // ── Mirror Camera ──
    this.mirrorCamera = new THREE.PerspectiveCamera(
      this.camera.fov,
      width / height,
      0.1,
      this.camera.far
    );
    this.mirrorCamera.userData.skipShaderApply = true;
    this.mirrorCamera.userData.isEnvironmentObject = true;

    // ── Render Target ──
    this.renderTarget = this._createRenderTarget(width, height, 0, 'linear');

    // ── Presentation 策略（smooth / pixelated，与主画面 AA 同步）──
    this._presentationMode = opts.presentationMode === 'pixelated' ? 'pixelated' : 'smooth';
    this._presentation = {
      smooth: { ...PRESENTATION_DEFAULTS.smooth },
      pixelated: { ...PRESENTATION_DEFAULTS.pixelated },
    };
    this._rtSamples = 0;                 // 初始 RT samples（构造时为 0）
    this._rtFilter = 'linear';           // 初始 RT filter（构造默认 LinearFilter）
    this._tmpSize = new THREE.Vector2();

    // ── Texture Matrix（worldPos → mirrorCamera clip → [0,1] UV）──
    this.textureMatrix = new THREE.Matrix4();

    // ── Reflection Plane（水平面 y=waterLevel，法线 (0,1,0)）──
    this._reflectorPlane = new THREE.Plane();
    this._reflectorNormal = new THREE.Vector3(0, 1, 0);
    this._reflectorPosition = new THREE.Vector3(0, this.waterLevel, 0);
    this._waterWorldPosition = new THREE.Vector3(0, this.waterLevel, 0);

    // ── Temps（避免 GC churn）──
    this._cameraWorldPos = new THREE.Vector3();
    this._lookAtPos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._mirrorPos = new THREE.Vector3();
    this._rotationMatrix = new THREE.Matrix4();
    this._clipPlane = new THREE.Vector4();
    this._q = new THREE.Vector4();

    // ── Dirty tracking（摄像机移动或水面位置变化时重渲）──
    this.needsUpdate = true;
    this._lastCameraMatrix = new THREE.Matrix4();
    this._lastWaterLevel = this.waterLevel;

    // ── WaterSurface 引用（自动同步反射纹理 + matrix）──
    this._waterSurface = null;
    this._extraWaterTargets = new Map();

    // ── Stats ──
    this._renderCount = 0;
    this._skipCount = 0;
    this._lastRenderMs = 0;
    this._loggedMirrorCamera = false;
    this._loggedMissingWaterSurfaceApi = false;

    // ── Debug API reference（由 scene-builder 注入）──
    this._debugApi = null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════

  setResolution(width, height) {
    if (width === this.renderTarget.width && height === this.renderTarget.height) return;
    this.renderTarget.setSize(width, height);
    for (const target of this._extraWaterTargets.values()) target.renderTarget.setSize(width, height);
    this.mirrorCamera.aspect = width / height;
    this.mirrorCamera.updateProjectionMatrix();
    this.needsUpdate = true;
    for (const target of this._extraWaterTargets.values()) target.needsUpdate = true;
  }

  setTier(tier) {
    const res = RESOLUTION_MAP[tier];
    if (!res) return;
    this.tier = tier;
    this.setResolution(res, res * 0.5);
  }

  // ═══ Presentation 策略：与主画面 AA/像素感同步 ═══
  // 注：presentation 尺寸由 drawingBuffer 动态计算，会覆盖 setTier 的固定尺寸

  setPresentationMode(mode) {
    this._presentationMode = mode === 'pixelated' ? 'pixelated' : 'smooth';
    this._applyPresentation();
    return this.getPresentationConfig();
  }

  setPresentationConfig(partial) {
    if (!partial || typeof partial !== 'object') return this.getPresentationConfig();
    const mode = partial.mode === 'pixelated' ? 'pixelated' : partial.mode === 'smooth' ? 'smooth' : this._presentationMode;
    const cfg = this._presentation[mode];
    for (const k of ['resolutionScale', 'maxSize', 'samples', 'distortionScale']) {
      if (Number.isFinite(partial[k])) cfg[k] = partial[k];
    }
    if (partial.filter === 'nearest' || partial.filter === 'linear') cfg.filter = partial.filter;
    if (mode === this._presentationMode) this._applyPresentation();
    return this.getPresentationConfig();
  }

  getPresentationConfig() {
    return { mode: this._presentationMode, ...this._presentation[this._presentationMode] };
  }

  // resize / DPR 变化后由外部调用，按当前模式重算 RT 尺寸
  syncToRendererSize() {
    this._applyPresentation();
  }

  _computeRenderTargetSize(cfg) {
    // getSize = CSS 像素；DPR 限制到 2，避免高 DPR 屏倒影 RT 爆炸
    const size = this.renderer.getSize(this._tmpSize);
    const dpr = Math.min(this.renderer.getPixelRatio(), 2);
    let w = Math.round(size.x * dpr * cfg.resolutionScale);
    let h = Math.round(size.y * dpr * cfg.resolutionScale);
    const maxDim = Math.max(w, h);
    if (maxDim > cfg.maxSize) {
      const s = cfg.maxSize / maxDim;
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  _applyPresentation() {
    const cfg = this._presentation[this._presentationMode];
    const { w, h } = this._computeRenderTargetSize(cfg);
    const canMSAA = this.renderer.capabilities.isWebGL2;
    const samples = canMSAA ? Math.min(4, cfg.samples || 0) : 0;
    const filter = cfg.filter === 'nearest' ? 'nearest' : 'linear';

    // samples / filter 变了必须重建 RT（three.js 无法原地改 samples）；否则仅 setSize
    if (samples !== this._rtSamples || filter !== this._rtFilter) {
      this.renderTarget.dispose();
      this.renderTarget = this._createRenderTarget(w, h, samples, filter);
      for (const target of this._extraWaterTargets.values()) {
        target.renderTarget.dispose();
        target.renderTarget = this._createRenderTarget(w, h, samples, filter);
        target.needsUpdate = true;
      }
      this._rtSamples = samples;
      this._rtFilter = filter;
    } else if (w !== this.renderTarget.width || h !== this.renderTarget.height) {
      this.renderTarget.setSize(w, h);
      for (const target of this._extraWaterTargets.values()) {
        target.renderTarget.setSize(w, h);
        target.needsUpdate = true;
      }
    }

    this.mirrorCamera.aspect = w / h;
    this.mirrorCamera.updateProjectionMatrix();
    this.needsUpdate = true;
  }

  setWaterLevel(y) {
    if (Math.abs(y - this.waterLevel) < 0.0001) return;
    this.waterLevel = y;
    this._reflectorPosition.y = y;
    this._waterWorldPosition.y = y;
    this.needsUpdate = true;
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  /**
   * 注册 WaterSurface 引用，render() 后自动同步反射纹理 + matrix。
   * @param {object|null} waterSurface
   */
  setWaterSurface(waterSurface) {
    this._waterSurface = waterSurface;
    this.waterMesh = waterSurface?.mesh || null;
    this.needsUpdate = true;
  }

  setWaterSurfaces(waterSurfaces = []) {
    const [primary, ...extra] = waterSurfaces.filter(Boolean);
    this.setWaterSurface(primary || null);
    const desired = new Set(extra);
    for (const waterSurface of [...this._extraWaterTargets.keys()]) {
      if (!desired.has(waterSurface)) this.removeWaterSurface(waterSurface);
    }
    for (const waterSurface of desired) this.addWaterSurface(waterSurface);
  }

  addWaterSurface(waterSurface) {
    if (!waterSurface || waterSurface === this._waterSurface || this._extraWaterTargets.has(waterSurface)) return;
    const target = {
      waterSurface,
      waterMesh: waterSurface.mesh,
      renderTarget: this._createRenderTarget(this.renderTarget.width, this.renderTarget.height, this._rtSamples, this._rtFilter),
      textureMatrix: new THREE.Matrix4(),
      lastCameraMatrix: new THREE.Matrix4(),
      lastWaterLevel: Number.NaN,
      needsUpdate: true,
    };
    this._extraWaterTargets.set(waterSurface, target);
  }

  removeWaterSurface(waterSurface) {
    const target = this._extraWaterTargets.get(waterSurface);
    if (!target) return;
    this._extraWaterTargets.delete(waterSurface);
    waterSurface?.setPlanarReflectionTexture?.(null);
    target.renderTarget.dispose();
  }

  forceUpdate() {
    this.needsUpdate = true;
    for (const target of this._extraWaterTargets.values()) target.needsUpdate = true;
  }

  /**
   * 每帧由 RenderPipeline 调用，在 prePass 前执行。
   */
  render() {
    if (!this.enabled) {
      this._skipCount++;
      return;
    }

    const primaryTarget = {
      waterSurface: this._waterSurface,
      waterMesh: this.waterMesh,
      renderTarget: this.renderTarget,
      textureMatrix: this.textureMatrix,
      lastCameraMatrix: this._lastCameraMatrix,
      lastWaterLevel: this._lastWaterLevel,
      needsUpdate: this.needsUpdate,
      primary: true,
    };

    this._renderWaterTarget(primaryTarget);
    this._lastWaterLevel = primaryTarget.lastWaterLevel;
    this.needsUpdate = primaryTarget.needsUpdate;

    for (const target of this._extraWaterTargets.values()) {
      this._renderWaterTarget(target);
    }
  }

  _renderWaterTarget(target) {
    const waterMesh = target.waterMesh;
    const renderTarget = target.renderTarget;
    const textureMatrix = target.textureMatrix;
    const waterSurface = target.waterSurface;
    if (!waterSurface || !waterMesh || !renderTarget) return;

    if (waterMesh) {
      waterMesh.updateMatrixWorld(true);
      waterMesh.getWorldPosition(this._waterWorldPosition);
      this.waterLevel = this._waterWorldPosition.y;
      this._reflectorPosition.copy(this._waterWorldPosition);
    } else {
      this._waterWorldPosition.set(0, this.waterLevel, 0);
      this._reflectorPosition.copy(this._waterWorldPosition);
    }

    // Dirty 检测：摄像机移动 或 水面高度变化
    this.camera.updateMatrixWorld(true);
    const cameraMoved = !target.lastCameraMatrix.equals(this.camera.matrixWorld);
    const waterChanged = Math.abs(this.waterLevel - target.lastWaterLevel) > 0.0001;

    if (!cameraMoved && !waterChanged && !target.needsUpdate) {
      this._syncWaterSurface(waterSurface, renderTarget, textureMatrix);
      this._skipCount++;
      return;
    }

    // 更新水面位置（可能从 WaterSurface 动态变化）
    if (waterMesh) {
      waterMesh.getWorldPosition(this._reflectorPosition);
    } else {
      this._reflectorPosition.set(0, this.waterLevel, 0);
    }

    target.lastCameraMatrix.copy(this.camera.matrixWorld);
    target.lastWaterLevel = this.waterLevel;

    const t0 = performance.now();

    this._updateMirrorCamera(waterMesh);
    this._updateTextureMatrix(textureMatrix);
    this._applyObliqueClipPlane();

    if (!this._loggedMirrorCamera) {
      console.log('[PlanarReflection] mirror camera', {
        position: this.mirrorCamera.position.toArray(),
        fov: this.mirrorCamera.fov,
        aspect: this.mirrorCamera.aspect,
        near: this.mirrorCamera.near,
        far: this.mirrorCamera.far,
        renderCount: this._renderCount,
      });
      this._loggedMirrorCamera = true;
    }

    // ── 保存渲染状态 ──
    const prevRenderTarget = this.renderer.getRenderTarget();
    const prevXrEnabled = this.renderer.xr.enabled;
    const prevShadowAutoUpdate = this.renderer.shadowMap.autoUpdate;

    this.renderer.xr.enabled = false;
    this.renderer.shadowMap.autoUpdate = false;

    // ── 隐藏不应出现在倒影中的对象 ──
    const hidden = this._hideExcluded(waterMesh);

    // ── 渲染倒影 ──
    this.renderer.setRenderTarget(renderTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.mirrorCamera);

    // ── 恢复 ──
    this._restoreVisibility(hidden);

    this.renderer.setRenderTarget(prevRenderTarget);
    this.renderer.xr.enabled = prevXrEnabled;
    this.renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;

    // ── 同步到 WaterSurface ──
    this._syncWaterSurface(waterSurface, renderTarget, textureMatrix);

    target.needsUpdate = false;
    this._renderCount++;
    this._lastRenderMs = performance.now() - t0;
  }

  getStats() {
    return {
      enabled: this.enabled,
      tier: this.tier,
      presentationMode: this._presentationMode,
      renderTargetWidth: this.renderTarget.width,
      renderTargetHeight: this.renderTarget.height,
      rendererPixelRatio: this.renderer.getPixelRatio(),
      drawingBufferSize: this.renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(),
      samples: this._rtSamples,
      filter: this._rtFilter,
      distortionScale: this._presentation[this._presentationMode].distortionScale,
      resolution: `${this.renderTarget.width}x${this.renderTarget.height}`,
      hasTexture: !!this.renderTarget.texture,
      renderCount: this._renderCount,
      skipCount: this._skipCount,
      lastRenderMs: this._lastRenderMs,
      cameraMoved: !this._lastCameraMatrix.equals(this.camera.matrixWorld),
      waterLevel: this.waterLevel,
      waterWorldPosition: this._waterWorldPosition.toArray(),
      'waterMesh.matrixWorld': this.waterMesh ? this.waterMesh.matrixWorld.toArray() : null,
      waterMeshMatrixWorld: this.waterMesh ? this.waterMesh.matrixWorld.toArray() : null,
      textureMatrix: this.textureMatrix.toArray(),
      excludedCount: this._excludeObjects.length,
    };
  }

  readRenderTargetSample(gridSize = 8) {
    const width = Math.max(1, Math.min(this.renderTarget.width, Math.floor(gridSize)));
    const height = Math.max(1, Math.min(this.renderTarget.height, Math.floor(gridSize)));
    const pixels = new Uint8Array(width * height * 4);
    const prevRenderTarget = this.renderer.getRenderTarget();

    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.readRenderTargetPixels(
      this.renderTarget,
      Math.max(0, Math.floor((this.renderTarget.width - width) * 0.5)),
      Math.max(0, Math.floor((this.renderTarget.height - height) * 0.5)),
      width,
      height,
      pixels
    );
    this.renderer.setRenderTarget(prevRenderTarget);

    let nonZeroPixels = 0;
    let maxChannel = 0;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (r || g || b || a) nonZeroPixels++;
      maxChannel = Math.max(maxChannel, r, g, b, a);
      sum += r + g + b + a;
    }

    return {
      width,
      height,
      nonZeroPixels,
      totalPixels: width * height,
      maxChannel,
      averageChannel: sum / pixels.length,
    };
  }

  dispose() {
    this.renderTarget.dispose();
    for (const target of this._extraWaterTargets.values()) target.renderTarget.dispose();
    this._extraWaterTargets.clear();
    if (this._debugApi) this._debugApi = null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Private
  // ═══════════════════════════════════════════════════════════

  /**
   * 计算镜面摄像机：将主摄像机沿水面 Y 平面镜像。
   * 参考 Three.js Reflector.js 实现，不翻转场景对象。
   */
  _createRenderTarget(width, height, samples = 0, filter = 'linear') {
    const filterConst = filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
    const target = new THREE.WebGLRenderTarget(width, height, {
      samples,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: filterConst,
      magFilter: filterConst,
    });
    configureReflectionTexture(target.texture);
    return target;
  }

  _updateMirrorCamera(waterMesh = this.waterMesh) {
    // 获取水面世界位置（如果 waterMesh 有非 identity transform）
    if (waterMesh) {
      waterMesh.getWorldPosition(this._reflectorPosition);
    }

    // 水面世界法线（水平面，始终 (0,1,0) 除非水面有旋转）
    this._reflectorNormal.set(0, 1, 0);
    this._rotationMatrix.extractRotation(waterMesh ? waterMesh.matrixWorld : new THREE.Matrix4().identity());
    this._reflectorNormal.applyMatrix4(this._rotationMatrix);

    // 主摄像机世界位置
    this.camera.getWorldPosition(this._cameraWorldPos);

    // view = reflectorPosition - cameraPosition
    this._view.subVectors(this._reflectorPosition, this._cameraWorldPos);

    // 摄像机在水面下方 → 跳过（但 P0 不做额外处理，仍渲染）
    // 镜像 view
    this._view.reflect(this._reflectorNormal).negate();
    this._mirrorPos.copy(this._view).add(this._reflectorPosition);

    // 计算 lookAt target
    this._rotationMatrix.extractRotation(this.camera.matrixWorld);
    this._lookAtPos.set(0, 0, -1);
    this._lookAtPos.applyMatrix4(this._rotationMatrix);
    this._lookAtPos.add(this._cameraWorldPos);

    this._target.subVectors(this._reflectorPosition, this._lookAtPos);
    this._target.reflect(this._reflectorNormal).negate();
    this._target.add(this._reflectorPosition);

    this.mirrorCamera.position.copy(this._mirrorPos);
    this.mirrorCamera.up.set(0, 1, 0);
    this.mirrorCamera.up.applyMatrix4(this._rotationMatrix);
    this.mirrorCamera.up.reflect(this._reflectorNormal);
    this.mirrorCamera.lookAt(this._target);

    // 同步 FOV / aspect
    this.mirrorCamera.fov = this.camera.fov;
    this.mirrorCamera.aspect = this.camera.aspect;
    this.mirrorCamera.near = this.camera.near;
    this.mirrorCamera.far = this.camera.far;
    this.mirrorCamera.updateProjectionMatrix();
    // textureMatrix and the oblique clip plane are calculated immediately
    // after this method. Camera.lookAt() updates the quaternion but leaves the
    // world rotation stale until the renderer visits the camera, which is too
    // late for those calculations.
    this.mirrorCamera.updateMatrixWorld(true);
  }

  /**
   * 计算 texture matrix：worldPos → mirrorCamera clip → NDC → [0,1] UV
   */
  _updateTextureMatrix(textureMatrix = this.textureMatrix) {
    // shader 端已用 * 0.5 + 0.5 做 NDC→[0,1] UV,
    // 此处只生产 proj×view，避免双重 bias 导致倒影偏移。
    textureMatrix.identity();
    textureMatrix.multiply(this.mirrorCamera.projectionMatrix);
    textureMatrix.multiply(this.mirrorCamera.matrixWorldInverse);
  }

  /**
   * Oblique clipping plane：修改 mirrorCamera.projectionMatrix，
   * 裁剪水面以下的物体（在镜面摄像机视角中）。
   * 参考 Lengyel 的 oblique near-plane clipping 方法。
   */
  _applyObliqueClipPlane() {
    // 计算世界空间的反射平面
    this._reflectorPlane.setFromNormalAndCoplanarPoint(
      this._reflectorNormal,
      this._reflectorPosition
    );

    // 变换到 mirrorCamera 视图空间
    this._reflectorPlane.applyMatrix4(this.mirrorCamera.matrixWorldInverse);

    // 裁剪平面 (A, B, C, D) = plane.normal + plane.constant
    this._clipPlane.set(
      this._reflectorPlane.normal.x,
      this._reflectorPlane.normal.y,
      this._reflectorPlane.normal.z,
      this._reflectorPlane.constant
    );

    const proj = this.mirrorCamera.projectionMatrix;
    const clipBias = this._clipBias;

    // 计算 q 向量（Lengyel 方法）
    this._q.x = (Math.sign(this._clipPlane.x) + proj.elements[8]) / proj.elements[0];
    this._q.y = (Math.sign(this._clipPlane.y) + proj.elements[9]) / proj.elements[5];
    this._q.z = -1.0;
    this._q.w = (1.0 + proj.elements[10]) / proj.elements[14];

    // 缩放裁剪平面使得经过 q
    const dot = this._clipPlane.dot(this._q);
    this._clipPlane.multiplyScalar(2.0 / dot);

    // 替换投影矩阵第三行
    proj.elements[2] = this._clipPlane.x;
    proj.elements[6] = this._clipPlane.y;
    proj.elements[10] = this._clipPlane.z + 1.0 - clipBias;
    proj.elements[14] = this._clipPlane.w;
  }

  /**
   * 隐藏不应出现在倒影中的对象，返回需要恢复的对象列表。
   * 规则：
   * - waterMesh 自身（避免递归）
   * - excludeObjects 中的所有对象
   * - userData.excludeFromPlanarReflection === true 的对象
   */
  _hideExcluded(waterMesh = this.waterMesh) {
    const hidden = [];

    // 1. 隐藏水面自身
    if (waterMesh && waterMesh.visible) {
      waterMesh.visible = false;
      hidden.push({ object: waterMesh, wasVisible: true });
    }

    // 2. 隐藏 excludeObjects 中的对象（editorRoot, helpers 等）
    for (const obj of this._excludeObjects) {
      if (obj && obj.visible) {
        obj.visible = false;
        hidden.push({ object: obj, wasVisible: true });
      }
    }

    // 3. 遍历 scene，隐藏有 excludeFromPlanarReflection 标记的对象
    //    但跳过已在 excludeObjects 中的（避免重复记录）
    const excludeSet = new Set(this._excludeObjects);
    if (waterMesh) excludeSet.add(waterMesh);

    this.scene.traverse(obj => {
      if (excludeSet.has(obj)) return;
      if (obj.userData?.excludeFromPlanarReflection && obj.visible) {
        obj.visible = false;
        hidden.push({ object: obj, wasVisible: true });
      }
    });

    return hidden;
  }

  /**
   * 恢复被 _hideExcluded 隐藏的对象可见性。
   */
  _restoreVisibility(hidden) {
    for (const entry of hidden) {
      if (entry.wasVisible) {
        entry.object.visible = true;
      }
    }
  }

  _syncWaterSurface(waterSurface = this._waterSurface, renderTarget = this.renderTarget, textureMatrix = this.textureMatrix) {
    if (!waterSurface) return false;
    const canSetTexture = typeof waterSurface.setPlanarReflectionTexture === 'function';
    const canSetMatrix = typeof waterSurface.setPlanarReflectionMatrix === 'function';
    if (!canSetTexture || !canSetMatrix) {
      if (!this._loggedMissingWaterSurfaceApi) {
        console.warn('[PlanarReflection] WaterSurface planar API unavailable; skipping reflection texture sync.', {
          hasSetPlanarReflectionTexture: canSetTexture,
          hasSetPlanarReflectionMatrix: canSetMatrix,
          waterSurfaceType: waterSurface?.constructor?.name || typeof waterSurface,
        });
        this._loggedMissingWaterSurfaceApi = true;
      }
      return false;
    }
    waterSurface.setPlanarReflectionTexture(renderTarget.texture);
    waterSurface.setPlanarReflectionMatrix(textureMatrix);
    return true;
  }
}
