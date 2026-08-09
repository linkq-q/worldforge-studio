// CSMShadowSetup — 级联阴影控制器（从 scene-builder.html 机械迁移，行为等价）。
// 拥有可变状态 csm / enabled / params；外部通过实例读写（裸状态无法用 const 桥接）。
// 注入：sun / camera / scene / modelRoot / updateSceneShadowCameraFit（来自 SceneBuilderScene）。
// 排除（裁决 3）：reapplyNormalSmoothShading（NormalRepair 胶水，留在 Runtime）、
// buildCsmPanel（UI，留在 CsmPanelUI）。
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { TraceGate } from './debug/TraceGate.js';
import { addMaterialShaderPatch, removeMaterialShaderPatch, hasMaterialShaderPatch } from './utils/MaterialShaderPatchChain.js';

// CSM 运行时参数（唯一真相源）。UI / preset / applyCsmParams 全部读写这里。
const CSM_DEFAULTS = Object.freeze({
  enabled: true,
  cascades: 4,
  shadowMapSize: 4096,
  maxFar: 120,
  mode: 'practical',   // practical | uniform | logarithmic
  fade: true,
  lightMargin: 50,
  bias: -0.0001,
  normalBias: 0.01,
});
// 这些改变需要重建 CSM（结构性）；其余（bias/normalBias/lightMargin/intensity）原地更新。
// radius 已删：renderer 用 PCFSoftShadowMap，light.shadow.radius 被忽略（死参数）。
// 可调柔和度若成为需求走 VSMShadowMap 评估，不要恢复这个滑杆。
const CSM_STRUCTURAL_KEYS = ['cascades', 'shadowMapSize', 'mode', 'maxFar', 'fade'];

export class CSMController {
  constructor({ sun, camera, scene, modelRoot, updateSceneShadowCameraFit, useCsmShadows = true }) {
    this._sun = sun;
    this._camera = camera;
    this._scene = scene;
    this._modelRoot = modelRoot;
    this._updateSceneShadowCameraFit = updateSceneShadowCameraFit;
    this.USE_CSM_SHADOWS = useCsmShadows;

    this.csm = null;
    this.enabled = false;
    this._materialPatched = new WeakSet();
    this.params = {
      ...CSM_DEFAULTS,
      normalBias: sun?.shadow?.normalBias ?? CSM_DEFAULTS.normalBias,
    };
    // buildCsmPanel 注入的 UI 回填函数；applyCsmParams 应用后调用它同步控件显示。
    this.panelSync = null;
  }

  // 计算 sun -> target 的方向向量，作为 CSM lightDirection（光线传播方向）。
  getSunDirection() {
    const sun = this._sun;
    return new THREE.Vector3()
      .subVectors(sun.target.position, sun.position)
      .normalize();
  }

  getLightFar(params) {
    const coverageFar = Math.max(1, Math.min(this._camera.far, params.maxFar));
    return Math.max(50, coverageFar * 2 + params.lightMargin * 2);
  }

  // 用当前 params 构造一个 CSM 实例（不接线到 sun / 材质）。init 与 rebuild 共用。
  createCsm(params) {
    const camera = this._camera;
    const maxFar = Math.min(camera.far, params.maxFar);
    const lightFar = this.getLightFar(params);
    const instance = new CSM({
      camera,
      parent: this._scene,
      cascades: params.cascades,
      mode: params.mode,
      shadowMapSize: params.shadowMapSize,
      maxFar,
      lightDirection: this.getSunDirection(),
      lightNear: 1,
      lightFar,
      lightMargin: params.lightMargin,
      fade: params.fade,
    });

    // Three r160 的 CSM 构造函数会无条件把 fade 重置为 false，必须在构造后恢复。
    instance.fade = !!params.fade;
    instance.updateFrustums();
    return instance;
  }

  // 把 sun 的强度/颜色 + params 的 bias/normalBias 落到每个 cascade light 上。
  applyCsmLightSettings(instance, params) {
    const sun = this._sun;
    const intensity = sun.intensity ?? 2.4;
    const lightFar = this.getLightFar(params);
    instance.lightMargin = params.lightMargin;
    instance.lightFar = lightFar;
    instance.lightIntensity = intensity;
    for (const light of instance.lights) {
      light.color.copy(sun.color);
      light.intensity = intensity;
      light.shadow.bias = params.bias;
      light.shadow.normalBias = params.normalBias;
      light.shadow.camera.far = lightFar;
      light.shadow.camera.updateProjectionMatrix();
      light.userData.__csmOwned = true;   // 供 __csmAudit 检测残留 cascade lights
    }
  }

  // 初始化 CSM。任何报错都 fallback 到原 sun shadow camera，不影响渲染。
  initCsmShadows() {
    const sun = this._sun;
    if (!this.USE_CSM_SHADOWS || this.csm || !this.params.enabled) return;

    try {
      this.csm = this.createCsm(this.params);
      this.applyCsmLightSettings(this.csm, this.params);

      sun.castShadow = false;
      sun.visible = false;
      this.enabled = true;

      this.setupCsmMaterials(this._modelRoot);

      if (TraceGate.shouldLog('csm')) {
        console.log('[CSM] initialized', {
          cascades: this.csm.cascades,
          maxFar: this.csm.maxFar,
          lightDirection: this.csm.lightDirection,
        });
      }
    } catch (error) {
      console.warn('[CSM] init failed, fallback to single shadow camera:', error);
      this.disposeCsm();
      this.enabled = false;
      this._updateSceneShadowCameraFit();
    }
  }

  // 移除 modelRoot 下材质上的 'csm' patch chain 条目以及 csm.setupMaterial() 写入的
  // material.defines（USE_CSM/CSM_CASCADES/CSM_FADE），避免 CSM 关闭后材质仍引用
  // 已 dispose 的 csm 实例（残留 onBeforeCompile 闭包 + defines 不一致）。
  removeCsmPatches(root = this._modelRoot) {
    if (!root) return;
    root.traverse((object) => {
      if (!object.isMesh && !object.isInstancedMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || !hasMaterialShaderPatch(material, 'csm')) continue;
        removeMaterialShaderPatch(material, 'csm');
        if (material.defines) {
          delete material.defines.USE_CSM;
          delete material.defines.CSM_CASCADES;
          delete material.defines.CSM_FADE;
        }
        material.needsUpdate = true;
      }
    });
  }

  // 销毁 CSM 实例，清理其内部创建的 cascade lights，避免泄漏。
  disposeCsm() {
    const sun = this._sun;
    if (!this.csm) return;
    try {
      this.csm.remove();
      // CSM.dispose() 会对其 shaders map 里每个材质 delete onBeforeCompile（它假设自己
      // 独占该钩子），连 MaterialShaderPatchChain 的 dispatcher 一起删——链上全部补丁
      // 静默失效（cascades/mode 换档后阴影错乱、合批主体 cel 失效的根因）。defines 与
      // patch 条目的清理由 removeCsmPatches 负责；这里先清空 map 让 dispose 无从下手。
      this.csm.shaders.clear();
      this.csm.dispose();
    } catch (error) {
      console.warn('[CSM] dispose error:', error);
    }
    this.csm = null;
    this.removeCsmPatches(this._modelRoot);
    this._materialPatched = new WeakSet();  // 旧 csm 实例的 patched 记录失效，新实例需要重新 install
    sun.castShadow = true;
    sun.visible = true;
  }

  // Sync CSM lights from the authoritative DirectionalLight every frame.
  syncCsmFromSun() {
    const sun = this._sun;
    if (!this.enabled || !this.csm || !this.csm.lights) return;

    const totalIntensity = sun.intensity ?? 2.4;
    const active = totalIntensity > 0;

    this.csm.lightDirection.copy(this.getSunDirection());
    this.csm.lights.forEach((light) => {
      light.color.copy(sun.color);
      light.intensity = totalIntensity;
      light.castShadow = active;
      light.visible = active;
    });
  }

  syncCamera() {
    if (!this.enabled || !this.csm) return;
    this.csm.maxFar = Math.min(this._camera.far, this.params.maxFar);
    this.applyCsmLightSettings(this.csm, this.params);
    this.csm.updateFrustums();
  }

  // 把 csm.setupMaterial() 产出的 onBeforeCompile/customProgramCacheKey 接入
  // MaterialShaderPatchChain，使其与 ShaderLibrary 的 toon/PBR overlay patch
  // （order: 100）以及 ShaderEditor 的 rim light patch（order: 150）共存，
  // 而不是互相覆盖 material.onBeforeCompile。
  installCsmPatch(material) {
    const csm = this.csm;
    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;

    csm.setupMaterial(material);

    const csmOnBeforeCompile = material.onBeforeCompile;

    // setupMaterial() also sets material.defines (USE_CSM, CSM_CASCADES, CSM_FADE);
    // those are fine to keep. Only onBeforeCompile gets captured into the chain so
    // other patches aren't dropped. Restore customProgramCacheKey unconditionally —
    // this CSM build doesn't set it, so previousCacheKey may already be the chain's
    // own dispatcher; capturing it as a "csm" cache key would self-reference and
    // recurse infinitely.
    material.onBeforeCompile = previousOnBeforeCompile;
    material.customProgramCacheKey = previousCacheKey;

    if (csmOnBeforeCompile === previousOnBeforeCompile) return;

    // MaterialShaderPatchChain automatically changes the generation whenever this
    // CSM patch is installed or replaced, so a rebuilt instance cannot reuse a stale program.
    addMaterialShaderPatch(material, 'csm', (shader, renderer, mat) => {
      csmOnBeforeCompile.call(mat, shader, renderer);
    }, {
      order: 10,
      cacheKey: () => 'csm',
    });
  }

  // 对 modelRoot 下的网格做 CSM setupMaterial。
  // 第一版只处理 Three.js 标准材质族（Standard/Physical/Phong/Lambert/Toon），
  // ShaderMaterial（CartoonGlass / InkSurfaceMaterial 等）暂时跳过，仅打标记。
  setupCsmMaterials(root = this._modelRoot, stats = null) {
    if (!this.csm || !root) return stats;

    root.traverse((object) => {
      if (!object.isMesh && !object.isInstancedMesh) return;
      if (stats) stats.traversed++;

      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];

      for (const material of materials) {
        if (!material) continue;

        // ShaderMaterial 暂时跳过，避免破坏 CartoonGlass / InkSurfaceMaterial 等自定义 GLSL
        if (material.isShaderMaterial) {
          material.userData.csmSkipped = true;
          if (stats) stats.skipped++;
          continue;
        }

        // 已 CSM 化的材质不要重复 setupMaterial：见 CSMController.disposeCsm 注释。
        if (this._materialPatched.has(material)) {
          if (stats) stats.skipped++;
          continue;
        }

        try {
          this.installCsmPatch(material);
          this._materialPatched.add(material);
          material.needsUpdate = true;
          if (stats) stats.patched++;
        } catch (error) {
          console.warn('[CSM] setupMaterial failed:', material, error);
          if (stats) stats.skipped++;
        }
      }
    });
    return stats;
  }

  // 合批材质克隆丢了 patch-chain 闭包，在克隆上重建 CSM patch（batcher onBatchMaterialReady）。
  patchBatchMaterial(batchMaterial) {
    if (this.enabled && this.csm && batchMaterial && !batchMaterial.isShaderMaterial) {
      if (batchMaterial.userData) delete batchMaterial.userData.shaderPatchChain;
      try {
        this.installCsmPatch(batchMaterial);
        this._materialPatched.add(batchMaterial);
        batchMaterial.needsUpdate = true;
      } catch (error) {
        console.warn('[CSM] batch material setup failed:', batchMaterial, error);
      }
    }
  }

  // 在 modelRoot 材质可能被替换后（preset 切换、场景加载、复制模型等）重新 patch。
  refreshCsmMaterials(reason = 'manual') {
    const t0 = performance.now();
    const stats = { traversed: 0, patched: 0, skipped: 0 };
    if (this.enabled && this.csm) {
      this.setupCsmMaterials(this._modelRoot, stats);
    }
    const elapsed = performance.now() - t0;
    if (TraceGate.shouldLog('csmTrace')) {
      console.log(
        `[CsmTrace] refresh reason=${reason} total=${elapsed.toFixed(1)}ms` +
        ` traversed=${stats.traversed} patched=${stats.patched} skipped=${stats.skipped}`
      );
    }
    return stats;
  }

  // 当前运行中的真实参数快照（preset 导出读它，保证 exported === getCsmParams()）。
  getCsmParams() {
    return { ...this.params };
  }

  // 销毁旧 CSM 并按当前 params 重建，重新 patch 材质。用于结构性参数变化。
  rebuildCsm() {
    this.disposeCsm();
    this.enabled = false;
    this.initCsmShadows();
    this.refreshCsmMaterials('csmRebuild');
  }

  // 应用一批参数：合并进 params → 结构性变化重建、否则原地更新 → 同步 UI。
  applyCsmParams(next = {}) {
    const prev = { ...this.params };
    for (const key of Object.keys(CSM_DEFAULTS)) {
      if (next[key] !== undefined) this.params[key] = next[key];
    }

    if (!this.params.enabled) {
      if (this.enabled || this.csm) {
        this.enabled = false;
        this.disposeCsm();
        this._updateSceneShadowCameraFit();
      }
      this.panelSync?.();
      return this.getCsmParams();
    }

    const structuralChanged = CSM_STRUCTURAL_KEYS.some((k) => prev[k] !== this.params[k]);

    if (!this.csm) {
      this.initCsmShadows();
      this.refreshCsmMaterials('csmEnable');
    } else if (structuralChanged || !prev.enabled) {
      this.rebuildCsm();
    } else {
      this.applyCsmLightSettings(this.csm, this.params);
      this.csm.updateFrustums();
      this.refreshCsmMaterials('csmApply');
    }

    this.panelSync?.();
    return this.getCsmParams();
  }
}
