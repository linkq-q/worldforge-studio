/**
 * PerfTimer.js — 轻量 CPU 计时器，用于 Voxel Studio Perf HUD v0
 *
 * 职责：
 *   - 记录每帧的整体耗时和各阶段（pass）耗时
 *   - FPS 使用指数平滑避免跳动
 *   - 提供 getStats() 供 PerfHUD 读取
 *
 * 注意：所有计时均为 CPU 侧 JS 提交耗时（performance.now），
 *       不等于 GPU 实际执行耗时，v0 先接受这个误差。
 *
 * @module PerfTimer
 */

export class PerfTimer {
  constructor() {
    /** 帧开始时间（performance.now） */
    this._frameStart = 0;

    /** 每帧各 pass 的开始时间 Map<label, number> */
    this._passStart = new Map();

    /** 当前帧各 pass 测量结果 Map<label, number> */
    this._passDurations = new Map();

    /** pass 注册顺序（本帧遇到顺序，用于展示排序） */
    this._passOrder = [];

    /** 指数平滑后的帧时间 (ms) */
    this._smoothFrameMs = 16.67;

    /** 上一帧真实耗时 (ms) */
    this._lastFrameMs = 0;

    /** 已有帧数（用于冷启动不显示异常值） */
    this._frameCount = 0;

    /**
     * 手动标记：外部可直接提交一个 pass 的耗时（不通过 begin/end 包裹）
     * 例如来自 GPU timer query 的结果
     */
    this._marks = new Map();
  }

  // ─── 帧边界 ───────────────────────────────────────────

  /**
   * 每帧渲染开始时调用
   */
  beginFrame() {
    this._frameStart = performance.now();
    this._passDurations.clear();
    this._passOrder = [];
    this._marks.clear();
  }

  /**
   * 每帧渲染结束时调用，更新平滑 FPS
   */
  endFrame() {
    const now = performance.now();
    this._lastFrameMs = now - this._frameStart;
    this._frameCount++;

    // 指数平滑：慢速衰减，快速响应
    const alpha = this._frameCount <= 5 ? 0.5 : 0.1;
    this._smoothFrameMs = this._smoothFrameMs * (1 - alpha) + this._lastFrameMs * alpha;
  }

  // ─── Pass 计时 ───────────────────────────────────────

  /**
   * 开始计时某个 pass / 阶段
   * @param {string} label
   */
  begin(label) {
    this._passStart.set(label, performance.now());
    if (!this._passOrder.includes(label)) {
      this._passOrder.push(label);
    }
  }

  /**
   * 结束计时某个 pass / 阶段
   * @param {string} label
   */
  end(label) {
    const start = this._passStart.get(label);
    if (start === undefined) {
      console.warn(`[PerfTimer] end("${label}") called without begin`);
      return;
    }
    const duration = performance.now() - start;
    this._passStart.delete(label);

    // 累加（同名 pass 可能被多次调用）
    const prev = this._passDurations.get(label) ?? 0;
    this._passDurations.set(label, prev + duration);
  }

  /**
   * 手动提交一个已知耗时（外部测量后推入）
   * @param {string} label
   * @param {number} durationMs
   */
  mark(label, durationMs) {
    this._marks.set(label, durationMs);
    if (!this._passOrder.includes(label)) {
      this._passOrder.push(label);
    }
  }

  // ─── 读取 ─────────────────────────────────────────────

  /**
   * 获取当前帧统计结果
   * @returns {{
   *   fps: number,
   *   frameMs: number,
   *   smoothFrameMs: number,
   *   passes: Array<{name: string, ms: number}>
   * }}
   */
  getStats() {
    const fps = this._smoothFrameMs > 0 ? 1000 / this._smoothFrameMs : 0;

    const passes = this._passOrder.map(name => {
      const ms =
        this._passDurations.has(name)
          ? this._passDurations.get(name)
          : (this._marks.get(name) ?? 0);
      return { name, ms };
    });

    // 补充 marks 中有但 passOrder 没收录的（以防 mark() 在 beginFrame 清空后调用）
    for (const [name, ms] of this._marks) {
      if (!passes.find(p => p.name === name)) {
        passes.push({ name, ms });
      }
    }

    return {
      fps: Math.round(fps * 10) / 10,
      frameMs: Math.round(this._lastFrameMs * 100) / 100,
      smoothFrameMs: Math.round(this._smoothFrameMs * 100) / 100,
      passes,
    };
  }

  /**
   * 重置所有统计数据（场景切换后调用）
   */
  reset() {
    this._frameStart = 0;
    this._passStart.clear();
    this._passDurations.clear();
    this._passOrder = [];
    this._marks.clear();
    this._smoothFrameMs = 16.67;
    this._lastFrameMs = 0;
    this._frameCount = 0;
  }
}

export default PerfTimer;
