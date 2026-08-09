/**
 * TraceGate — 统一 per-frame 性能日志节流控制
 *
 * 默认：所有 per-frame trace（prePass / composer / ssao）不输出。
 * 需要时由消费方注入配置源或调用 enable() 启用降频输出。
 * 消费方可自行暴露快捷调试入口。
 *
 * API:
 *   TraceGate.shouldLog(tag, options)  → boolean  当前帧是否应输出
 *   TraceGate.dump(tag)                → void     标记下次 shouldLog 强制返回 true
 *   TraceGate.enable(tag)              → void     启用 tag 的降频输出
 *   TraceGate.disable(tag)             → void     禁用 tag
 *   TraceGate.warnThrottled(tag, msg, minIntervalMs) → void  节流 warn
 *
 * Usage:
 *   import { TraceGate } from './src/debug/TraceGate.js';
 *   if (TraceGate.shouldLog('prePass')) {
 *     console.log('[PrePassAudit] ...');
 *   }
 */

// ── Internal state ──────────────────────────────────────────

/** @type {Map<string, {frameCount: number, lastLogMs: number, dumpNext: boolean}>} */
const _tags = new Map();

/** @type {Map<string, number>} last warn timestamp per tag */
const _warnTimestamps = new Map();

/** Global frame counter — ticked once per frame by the caller or shouldLog */
let _globalFrame = 0;

let _configSource = null;
const _overrides = {};

// ── Default config ──────────────────────────────────────────

const DEFAULT_CONFIG = {
  prePass: false,
  composer: false,
  ssao: false,
  batching: false,
  resolution: false,
  editorLoop: false,
  // ── Round 2: loading / building ──
  load: false,           // ModelResourceCache, ModelLoadQueueTrace, ModelLoadTrace per-model
  modelLoadTrace: false, // ModelLoadTrace summaries/details
  modelFlow: false,      // [model-flow]
  voxelRuntime: false,   // missing voxel runtime fallback diagnostic
  voxelBuild: false,     // buildModel/*, CoplanarTrace, VoxelRendererTrace, BatchingAudit, SceneManagerTrace
  batchAudit: false,     // BatchingAudit in reportModelLoadTrace
  import: false,          // legacy import umbrella
  importDebug: false,     // ImportDebug
  applyRenderParamsTrace: false,
  shaderPreviewTrace: false,
  registryTrace: false,
  materialOverrideTrace: false,
  staticBatch: false,    // [StaticInstanceBatcher][diagnose], [StaticBatchToggle], [StaticBatchStyleSync]
  csm: false,            // [CSM] init / CameraHelper / setupMaterial detail logs
  csmTrace: false,
  prePassWarn: false,
  ssaoWarn: false,
  composerWarn: false,
  renderPassWarn: false,
  shaderPreviewWarn: false,
  legacyCartoonWarn: false,
  voxelBuildWarn: false,
  modelLoadWarn: false,
  intervalFrames: 60,
  intervalMs: 1000,
};

/**
 * Read current injected config and merge with local overrides.
 */
function _readConfig() {
  const external = typeof _configSource === 'function' ? _configSource() : null;
  return { ...DEFAULT_CONFIG, ...(external || {}), ..._overrides };
}

export function setTraceConfigSource(source) {
  _configSource = typeof source === 'function' ? source : null;
}

/**
 * Ensure a tag has internal tracking state.
 */
function _ensureTag(tag) {
  if (!_tags.has(tag)) {
    _tags.set(tag, { frameCount: 0, lastLogMs: 0, dumpNext: false });
  }
}

// ── Public API ──────────────────────────────────────────────

export const TraceGate = /** @type {const} */ ({
  /**
   * 判断当前帧是否应该输出指定 tag 的日志。
   *
   * @param {string} tag        — 标签名 (prePass | composer | ssao | ...)
   * @param {{intervalFrames?: number, intervalMs?: number}} [options]
   * @returns {boolean}
   */
  shouldLog(tag, options = {}) {
    const config = _readConfig();
    const enabled = config[tag] === true;

    _ensureTag(tag);
    const state = _tags.get(tag);

    // ── dump mode: __perfDump() 请求的强制输出 ──
    if (state.dumpNext) {
      state.dumpNext = false;
      state.lastLogMs = performance.now();
      return true;
    }

    // ── 未启用：完全不输出 ──
    if (!enabled) return false;

    // ── 已启用：按间隔输出 ──
    _globalFrame++;
    state.frameCount++;

    const intervalFrames = options.intervalFrames ?? config.intervalFrames;
    const intervalMs = options.intervalMs ?? config.intervalMs;

    // 优先用帧间隔判定
    if (intervalFrames > 0 && state.frameCount % intervalFrames === 0) {
      state.lastLogMs = performance.now();
      return true;
    }

    // 否则用时间间隔判定
    if (intervalMs > 0) {
      const now = performance.now();
      if (now - state.lastLogMs >= intervalMs) {
        state.lastLogMs = now;
        return true;
      }
    }

    return false;
  },

  /**
   * 标记 tag 在下一次 shouldLog 调用时强制返回 true。
   * 用于消费方的手动快照入口。
   *
   * @param {string} tag
   */
  dump(tag) {
    _ensureTag(tag);
    _tags.get(tag).dumpNext = true;
  },

  /**
   * 启用指定 tag 的降频输出。
   *
   * @param {string} tag
   */
  enable(tag) {
    _overrides[tag] = true;
  },

  /**
   * 禁用指定 tag。
   *
   * @param {string} tag
   */
  disable(tag) {
    _overrides[tag] = false;
  },

  /**
   * 节流 warn：同一 tag 在 minIntervalMs 内最多输出一次。
   *
   * @param {string} tag
   * @param {string} message
   * @param {number} [minIntervalMs=2000]
   */
  warnThrottled(tag, message, minIntervalMs = 2000) {
    const config = _readConfig();
    if (config[tag] !== true) return;

    const now = performance.now();
    const last = _warnTimestamps.get(tag) || 0;
    if (now - last < minIntervalMs) return;
    _warnTimestamps.set(tag, now);
    console.log(`[${tag}] ${message}`);
  },

  /**
   * 重置所有内部状态（用于测试或 A/B 对比）。
   */
  reset() {
    _tags.clear();
    _warnTimestamps.clear();
    _globalFrame = 0;
    for (const key of Object.keys(_overrides)) delete _overrides[key];
  },
});

export default TraceGate;
