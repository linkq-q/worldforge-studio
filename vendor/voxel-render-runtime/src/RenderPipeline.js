/**
 * RenderPipeline v1 — 渲染调度类，收口 composer pass 管理
 *
 * 帧序列：
 *   tick → skyUpdate → sideResources(graph, default) → qualityFallback → syncPassState
 *   → adaptiveThreshold → prePass(graph, 'prePass') → waterUpdate → mainComposer
 *
 * 侧资源图（RenderGraph）分两个 phase 执行：'default'（planarReflection + glassEnv，
 * 在 syncPassState 前）与 'prePass'（scene:depth/normal，必须在 syncPassState 后读新鲜
 * pass.enabled）。prePass producer 由 ShaderEditor 注册。water 待 Phase 4。见 RenderGraph.js。
 *
 * Pass 增删、排序、启停必须通过注册表完成：
 *   pipeline.registerPass / unregisterPass / setPassEnabled / syncComposer
 *
 * 只有 syncComposer() 可以写 composer.passes。
 *
 * renderFrame(deltaTime, elapsed, context):
 *   deltaTime — 本帧增量秒（≈ 0.016），给 waterSurface.update 用
 *   elapsed  — 自启动以来总秒数，给 shaderLib.tick / proceduralSky.update 用
 */

import { TraceGate } from './debug/TraceGate.js';
import { RenderGraph } from './RenderGraph.js';

export class RenderPipeline {
  /** 合法渲染质量档位，由低到高 */
  static QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];

  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene}         opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {EffectComposer|null}  opts.composer
   * @param {import('./debug/PerfTimer.js').PerfTimer|null} [opts.timer]
   * @param {boolean} [opts.debug]
   */
  constructor({ renderer, scene, camera, composer, timer = null, debug = false }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = composer;
    this.timer = timer;
    this.debug = debug;

    /** Pass 注册表：id → PassRecord */
    this.passRegistry = new Map();

    /** 需要重建 composer.passes */
    this.dirty = true;

    this.stats = { stages: [], passes: [] };

    /** Load 保护：场景加载后前 N 帧降低渲染质量 */
    this._loadProtectionFrames = 0;
    this._loadProtectionTotal = 5; // 默认保护 5 帧
    /** 当前渲染质量 tier */
    this._currentTier = 'medium';

    /** PlanarReflectionPass 引用（可选）*/
    this._planarReflectionPass = null;

    /** 侧资源图（depth/normal/reflection/glassEnv/water 的 producer→consumer 调度） */
    this.graph = new RenderGraph();
    this._registerSideResourceGraph();
  }

  /**
   * 注册侧资源 producer/consumer。逐 Phase 迁入；run/enabled 闭包读 this.* 实时状态。
   * 详见 docs/tasks/render-graph-v1.md。
   */
  _registerSideResourceGraph() {
    // Phase 1：planarReflection。render() 内部已自门控（!enabled / 无水面早退）+ 通过
    // setPlanarReflectionTexture 把纹理推给水面。这里 consumer.enabled 复刻原 `if (pass)`
    // + `!enabled` 早退语义：pass 存在且启用才需求 → producer 才跑。
    this.graph.registerProducer({
      id: 'planarReflection',
      writes: ['reflection:planar'],
      policy: 'everyFrame',
      run: () => this._planarReflectionPass?.render(),
    });
    this.graph.registerConsumer({
      id: 'waterPlanarReflection',
      reads: ['reflection:planar'],
      enabled: () => !!this._planarReflectionPass && this._planarReflectionPass.enabled !== false,
    });

    // Phase 2：glassEnv。renderGlassEnvironment() 内部已自门控（无玻璃 mesh 早退），只把
    // 场景重渲进固定 glassEnvTarget，不读 quality tier。onDirty policy 复刻原
    // `if (_glassEnvDirty)` 语义；consumer 恒需求（玻璃材质总想要环境反射，无玻璃时 run 自空转）。
    // 保护窗口的 `|| inProtection` 逐帧重渲，由 renderFrame 在保护帧 markDirty 复刻。
    this.graph.registerProducer({
      id: 'glassEnv',
      writes: ['env:glass'],
      policy: 'onDirty',
      run: (ctx) => ctx?.renderGlassEnvironment?.(),
    });
    this.graph.registerConsumer({
      id: 'glassMaterials',
      reads: ['env:glass'],
      enabled: () => true,
    });
    // 构造即脏：复刻原 `_glassEnvDirty = true` 初值，保证首帧渲染一次环境。
    this.graph.markDirty('env:glass');
  }

  /**
   * 设置 PlanarReflectionPass 引用，renderFrame 时自动调用其 render()。
   * @param {import('./PlanarReflectionPass.js').PlanarReflectionPass|null} pass
   */
  setPlanarReflectionPass(pass) {
    this._planarReflectionPass = pass;
  }

  /**
   * 通知 pipeline 场景已加载，启动渲染保护窗口。
   * 前 protectionFrames 帧使用 low tier，之后恢复 medium。
   * @param {number} [protectionFrames=5]
   */
  notifySceneLoaded(protectionFrames = 5) {
    this._loadProtectionFrames = protectionFrames;
    this._loadProtectionTotal = protectionFrames;
    this.dirty = true;
    this.graph.markDirty('env:glass');
    if (this.debug) {
      console.debug('[RenderPipeline] notifySceneLoaded: protectionFrames=%d', protectionFrames);
    }
  }

  /**
   * 标记 glassEnv 需要重新渲染（下一帧图执行时 onDirty producer 跑一次）
   */
  markGlassEnvDirty() {
    this.graph.markDirty('env:glass');
  }

  /**
   * 获取当前帧的渲染质量 tier
   * @returns {'low'|'medium'|'high'|'ultra'}
   */
  getCurrentTier() {
    if (this._loadProtectionFrames > 0) return 'low';
    return this._currentTier;
  }

  /**
   * 设置渲染质量 tier。
   * @param {'low'|'medium'|'high'|'ultra'} tier
   */
  setQualityTier(tier) {
    if (!RenderPipeline.QUALITY_TIERS.includes(tier)) {
      console.warn(`[RenderPipeline] Unknown quality tier "${tier}", keeping "${this._currentTier}"`);
      return;
    }
    if (this._currentTier === tier) return;
    this._currentTier = tier;
    this.dirty = true;
  }

  // ── 云分档映射（quality tier → cloud tier）────────────────

  /**
   * 由质量档位解析有效云分档（纯函数，便于测试）。
   * - Low/Medium → 强制 cloudTier = 1（不可手动覆盖为 2，避免低端设备性能问题）。
   * - High/Ultra → 用户可选 1 或 2，默认 2。
   * @param {'low'|'medium'|'high'|'ultra'} qualityTier
   * @param {1|2|null} [requestedTier] High/Ultra 下用户请求的云分档
   * @returns {1|2}
   */
  static resolveCloudTier(qualityTier, requestedTier = null) {
    if (qualityTier === 'low' || qualityTier === 'medium') {
      return 1;
    }
    // High / Ultra：用户可选，未指定时默认 2
    return Number(requestedTier) === 1 ? 1 : 2;
  }

  /**
   * 基于当前质量档位解析有效云分档。
   * @param {1|2|null} [requestedTier]
   * @returns {1|2}
   */
  getEffectiveCloudTier(requestedTier = null) {
    return RenderPipeline.resolveCloudTier(this.getCurrentTier(), requestedTier);
  }

  /**
   * 由质量档位解析档 2 raymarch 步数（纯函数）。
   * Ultra = 16，其余（High）= 8。Low/Medium 不渲染档 2，步数无意义但返回 8。
   * @param {'low'|'medium'|'high'|'ultra'} qualityTier
   * @returns {number}
   */
  static resolveRaymarchSteps(qualityTier) {
    return qualityTier === 'ultra' ? 16 : 8;
  }

  /**
   * 基于当前质量档位解析 raymarch 步数。
   * @returns {number}
   */
  getEffectiveRaymarchSteps() {
    return RenderPipeline.resolveRaymarchSteps(this.getCurrentTier());
  }

  // ── Pass 注册 ───────────────────────────────────────────

  /**
   * 注册 pass（幂等：相同 id 重复调用只更新，不重复插入）
   *
   * @param {Pass}   pass
   * @param {'mainComposer'|'presentation'|'overlay'} slot
   * @param {number} [order=0]
   * @param {object} [metadata]
   * @param {string} metadata.id        必须
   * @param {string} [metadata.name]
   * @param {boolean} [metadata.enabled]
   * @param {string[]} [metadata.tiers]
   * @param {number} [metadata.budgetMs]
   * @param {string} [metadata.fallback]
   * @returns {PassRecord}
   */
  registerPass(pass, slot, order = 0, metadata = {}) {
    const id = metadata.id || pass.name || pass.constructor?.name;
    if (!id) throw new Error('[RenderPipeline] pass id is required');

    const existing = this.passRegistry.get(id);
    const enabled = metadata.enabled ?? true;
    const tiers = metadata.tiers ?? ['low', 'medium', 'high', 'ultra'];

    const record = {
      id,
      pass,
      slot,
      order,
      enabled,
      tiers,
      budgetMs: metadata.budgetMs ?? 0,
      fallback: metadata.fallback ?? 'none',
      name: metadata.name ?? id,
    };

    if (
      !existing ||
      existing.pass !== pass ||
      existing.slot !== slot ||
      existing.order !== order ||
      existing.enabled !== enabled ||
      existing.tiers.join('|') !== tiers.join('|')
    ) {
      this.dirty = true;
    }

    // Keep pass.enabled in sync
    pass.enabled = enabled && tiers.includes(this.getCurrentTier());

    this.passRegistry.set(id, record);
    return record;
  }

  /** 注销 pass */
  unregisterPass(id) {
    if (this.passRegistry.has(id)) {
      this.passRegistry.delete(id);
      this.dirty = true;
    }
  }

  /** 切换 pass 启用状态 */
  setPassEnabled(id, enabled) {
    const record = this.passRegistry.get(id);
    if (!record || record.enabled === enabled) return;
    record.enabled = enabled;
    record.pass.enabled = enabled && record.tiers.includes(this.getCurrentTier());
    this.dirty = true;
  }

  /** 更新 pass 排序权重 */
  setPassOrder(id, order) {
    const record = this.passRegistry.get(id);
    if (!record || record.order === order) return;
    record.order = order;
    this.dirty = true;
  }

  /** 按 id 获取 pass 对象 */
  getPass(id) {
    return this.passRegistry.get(id)?.pass ?? null;
  }

  /**
   * 获取注册记录列表
   * @param {'mainComposer'|'presentation'|'overlay'|null} [slot] 为 null 时返回全部
   */
  getPasses(slot = null) {
    const records = [...this.passRegistry.values()];
    return slot ? records.filter(r => r.slot === slot) : records;
  }

  // ── Composer 同步 ───────────────────────────────────────

  /**
   * 唯一可以写 composer.passes 的方法。
   * 同步顺序：mainComposer → presentation → overlay（各 slot 内按 order 升序）
   * presentation = 最终画面媒介风格（像素化/印刷感等），永远在主后处理链之后。
   * 只在 dirty 时重建。
   */
  syncComposer() {
    if (!this.composer || !this.dirty) return;

    const ordered = [...this.passRegistry.values()]
      .filter(r => r.slot === 'mainComposer' || r.slot === 'presentation' || r.slot === 'overlay')
      .filter(r => {
        const active = r.enabled !== false && r.tiers.includes(this.getCurrentTier());
        r.pass.enabled = active;
        return active;
      })
      .sort((a, b) => {
        const slotWeight = { mainComposer: 0, presentation: 1, overlay: 2 };
        return (slotWeight[a.slot] - slotWeight[b.slot]) || (a.order - b.order);
      });

    // EffectComposer.addPass() also sizes the pass to the composer's current
    // effective resolution. Direct assignment skips that contract, leaving a
    // pass that is enabled later (SSAO/bloom) at its constructor size (often
    // 1x1) until the next viewport resize.
    this.composer.passes = [];
    for (const record of ordered) this.composer.addPass(record.pass);

    for (const pass of this.composer.passes) {
      pass.renderToScreen = false;
    }
    const last = this.composer.passes[this.composer.passes.length - 1];
    if (last) last.renderToScreen = true;

    this.dirty = false;
  }

  // ── 帧调度 ─────────────────────────────────────────────

  /**
   * 执行一个阶段，包裹计时
   * @param {string} name
   * @param {Function} fn
   */
  runStage(name, fn) {
    const start = performance.now();
    this.timer?.begin?.(name);
    try {
      return fn();
    } finally {
      this.timer?.end?.(name);
      const ms = performance.now() - start;
      this.stats.stages.push({ name, ms });
    }
  }

  renderComposerWithTrace(doLog = false) {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const passes = Array.isArray(this.composer.passes) ? this.composer.passes : [];
    const timings = new Map();
    const originals = [];
    for (const pass of passes) {
      if (!pass || typeof pass.render !== 'function') continue;
      const original = pass.render;
      originals.push([pass, original]);
      pass.render = function tracedPassRender(...args) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const name = this.name || this.constructor?.name || 'UnnamedPass';
          timings.set(name, (timings.get(name) || 0) + performance.now() - start);
        }
      };
    }

    const totalStart = performance.now();
    try {
      this.composer.render();
    } finally {
      for (const [pass, original] of originals) {
        pass.render = original;
      }
    }

    const total = performance.now() - totalStart;
    const known = [...timings.values()].reduce((sum, value) => sum + value, 0);
    const unknown = Math.max(0, total - known);
    this.stats.composerTrace = {
      total,
      unknown,
      passes: [...timings.entries()].map(([name, ms]) => ({ name, ms })),
    };

    if (TraceGate.shouldLog('composer')) {
      const parts = [`total=${total.toFixed(1)}ms`];
      for (const [name, ms] of timings) {
        parts.push(`${String(name).replace(/\s+/g, '')}=${ms.toFixed(1)}ms`);
      }
      parts.push(`unknown=${unknown.toFixed(1)}ms`);
      console.log(`[ComposerTrace] ${parts.join(' ')}`);
    }
    if (unknown > 5) {
      TraceGate.warnThrottled('composerWarn',
        `ComposerTrace UNTRACED GAP ${unknown.toFixed(1)}ms`, 2000);
    }
  }

  /**
   * 执行一帧渲染
   *
   * @param {number} deltaTime  本帧增量（秒），≈ 0.016
   * @param {number} elapsed    自启动以来总秒数（shaderLib.tick / proceduralSky.update 用）
   * @param {object} context
   * @param {import('./ShaderLibrary.js').ShaderLibrary} [context.shaderLib]
   * @param {object}   [context.proceduralSky]
   * @param {Function} [context.renderGlassEnvironment]
   * @param {import('../../../src/PostProcessPanel.js').PostProcessPanel} [context.postProcessPanel]
   * @param {object}   [context.selectionOutline]
   * @param {Function} [context.updateAdaptiveThreshold]
   * @param {Function} [context.getPrePassConsumers]
   * @param {Function} [context.updateWater]
   * @param {number}   [context.meshCount]
   * @param {Function|null} [context.wrapRender]  用于 cartoon 模式 withSelectedVisibility 包裹
   */
  renderFrame(deltaTime, elapsed, context = {}) {
    this.stats = { stages: [], passes: [] };
    const timerStats = this.timer?.getStats?.() || {};
    const smoothFrameMs = Math.max(
      Number(deltaTime) * 1000 || 0,
      Number(timerStats.smoothFrameMs ?? timerStats.frameMs) || 0
    );
    const meshCount = Number(context.meshCount) || 0;

    const isDebug = this.debug;
    if (isDebug && this._logEvery !== 0) {
      if (!this._logEvery) this._logEvery = 60;
      this._logEvery -= 1;
      if (this._logEvery <= 0) this._logEvery = 60;
    }
    const doLog = isDebug && this._logEvery === 60;

    // ── Load 保护：前 N 帧降低渲染质量 ──
    const inProtection = this._loadProtectionFrames > 0;
    if (inProtection) {
      this._loadProtectionFrames--;
      if (this._loadProtectionFrames === 0) this.dirty = true;
      if (doLog) console.debug('[RenderPipeline] loadProtection frame %d/%d', this._loadProtectionTotal - this._loadProtectionFrames, this._loadProtectionTotal);
    }

    this.runStage('tick', () => {
      context.shaderLib?.tick?.(elapsed);
    });

    this.runStage('skyUpdate', () => {
      context.proceduralSky?.update?.(elapsed);
    });

    // 侧资源图（当前含 planarReflection + glassEnv；prePass/water 待后续 Phase 迁入）。
    // 保护窗口内每帧重渲 glassEnv：复刻旧 `if (_glassEnvDirty || inProtection)` 的 inProtection 分支。
    this.runStage('sideResources', () => {
      if (inProtection) this.graph.markDirty('env:glass');
      this.graph.execute(context);
    });

    this.runStage('qualityFallback', () => {
      context.postProcessPanel?.updateQualityFallback?.({ meshCount, smoothFrameMs });
    });

    this.runStage('syncPassState', () => {
      context.postProcessPanel?.applyToPipeline?.(this);
      context.selectionOutline?.applyToPipeline?.(this);
      this.syncComposer();
    });

    this.runStage('adaptiveThreshold', () => {
      context.updateAdaptiveThreshold?.();
    });

    // prePassConsumers 仍由 waterUpdate（Phase 4 前）消费，这里先算好挂到 context 供 producer 复用。
    context.prePassConsumers = context.getPrePassConsumers?.();

    // prePass：由图 'prePass' phase 的 producer 驱动（ShaderEditor 注册），必须在 syncPassState
    // 之后跑以读到新鲜 pass.enabled。图按需门控（aggregate consumer.enabled = needsPrePass）。
    // load 保护期间跳过（首帧后恢复）——语义同旧的 renderNormalPrePass 跳过。
    this.runStage('prePass', () => {
      if (!inProtection || this._loadProtectionFrames < this._loadProtectionTotal - 1) {
        this.graph.execute(context, 'prePass');
      }
    });

    this.runStage('waterUpdate', () => {
      if (doLog) console.debug('[RenderPipeline] waterUpdate called, dt=', deltaTime.toFixed(6));
      context.updateWater?.(context.prePassConsumers);
    });

    this.runStage('mainComposer', () => {
      const doRender = () => {
        if (this.composer) {
          this.renderComposerWithTrace(doLog);
        } else {
          this.renderer.render(this.scene, this.camera);
        }
      };
      if (context.wrapRender) {
        context.wrapRender(doRender);
      } else {
        doRender();
      }
    });

    this.stats.passes = [...this.passRegistry.values()].map(r => ({
      id: r.id,
      name: r.name,
      slot: r.slot,
      order: r.order,
      enabled: r.enabled,
      tiers: r.tiers,
      budgetMs: r.budgetMs,
      fallback: r.fallback,
    }));
  }

  /** 获取最近一帧的阶段 + pass 统计 */
  getStats() {
    return {
      stages: [...this.stats.stages],
      passes: [...this.stats.passes],
      composerTrace: this.stats.composerTrace || null,
    };
  }

  dispose() {
    this.passRegistry.clear();
    this.composer = null;
    this.timer = null;
  }
}

export default RenderPipeline;
