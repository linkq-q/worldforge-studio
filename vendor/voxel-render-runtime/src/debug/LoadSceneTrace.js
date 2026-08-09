/**
 * LoadSceneTrace — 场景加载性能追踪工具
 *
 * 只在 #debug 模式下启用。
 * 记录 load 新场景时高级管线的完整耗时链路。
 *
 * 用法：
 *   LoadSceneTrace.begin('sceneLoad');
 *   // ... load steps ...
 *   LoadSceneTrace.end('sceneLoad');
 *   LoadSceneTrace.report(); // 打印汇总
 *
 * 输出格式：
 *   [LoadTrace] sceneLoad:start
 *   [LoadTrace] advanced:detachOldScene 3.2ms
 *   [LoadTrace] post:createBundle called=true 146.5ms
 *   ...
 *   [LoadTrace] sceneLoad:end totalAdvancedCost=1450.8ms
 */

let _enabled = false;
let _traces = [];
let _activeSpans = new Map();
let _globalStart = 0;
let _globalEnd = 0;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function _log(msg) {
  console.debug(`[LoadTrace] ${msg}`);
}

export const LoadSceneTrace = {
  /** 启用追踪（通常由 init 时自动检测 #debug） */
  enable() {
    _enabled = true;
  },

  disable() {
    _enabled = false;
    _traces = [];
    _activeSpans.clear();
  },

  get enabled() {
    return _enabled;
  },

  /**
   * 开始一个计时阶段
   * @param {string} label
   */
  begin(label) {
    if (!_enabled) return;
    _activeSpans.set(label, nowMs());
    _log(`${label}:start`);
  },

  /**
   * 结束一个计时阶段
   * @param {string} label
   * @param {object} [meta] - 附加元数据
   */
  end(label, meta = null) {
    if (!_enabled) return;
    const start = _activeSpans.get(label);
    if (start === undefined) {
      _log(`${label}:end (no begin found)`);
      return;
    }
    _activeSpans.delete(label);
    const ms = nowMs() - start;
    const entry = { label, ms, meta, ts: nowMs() };
    _traces.push(entry);

    let metaStr = '';
    if (meta && typeof meta === 'object') {
      const parts = [];
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === 'number') parts.push(`${k}=${v.toFixed(1)}`);
        else parts.push(`${k}=${v}`);
      }
      metaStr = ' ' + parts.join(' ');
    }
    _log(`${label} ${ms.toFixed(1)}ms${metaStr}`);
  },

  /**
   * 记录一个瞬时事件（不计时）
   * @param {string} label
   * @param {object} [meta]
   */
  mark(label, meta = null) {
    if (!_enabled) return;
    let metaStr = '';
    if (meta && typeof meta === 'object') {
      const parts = [];
      for (const [k, v] of Object.entries(meta)) {
        parts.push(`${k}=${v}`);
      }
      metaStr = ' ' + parts.join(' ');
    }
    _log(`${label}${metaStr}`);
  },

  /**
   * 获取所有追踪记录
   * @returns {Array<{label:string, ms:number, meta:object|null, ts:number}>}
   */
  getTraces() {
    return [..._traces];
  },

  /**
   * 打印汇总报告到 console。
   *
   * 输出：
   * 1. 一行 flat summary：[LoadTraceSummary] total=...ms ...
   * 2. console.table 所有 events（label / elapsedMs / meta）
   * 3. 无 events 时输出 [LoadTrace] no events recorded
   */
  report() {
    if (!_enabled) return null;

    // ── 关闭所有未结束的 span ──
    for (const [label] of _activeSpans) {
      _log(`${label}:end (unclosed span, forcing close)`);
    }
    _activeSpans.clear();

    if (_traces.length === 0) {
      console.warn('[LoadTrace] no events recorded');
      return null;
    }

    // ── 1. Flat summary line ──
    let total = 0;
    const byLabel = {};
    for (const entry of _traces) {
      total += entry.ms;
      byLabel[entry.label] = (byLabel[entry.label] || 0) + entry.ms;
    }

    const short = (label) => {
      const parts = label.split(':');
      return parts.length > 1 ? parts.slice(1).join(':') : label;
    };

    const summaryParts = [`total=${total.toFixed(1)}ms`];
    const keyLabels = [
      'sceneLoad', 'style:importState', 'post:createBundle',
      'shader:applyToScene', 'env:pmrem', 'warmup:enqueue',
      'style:applyRenderParams',
    ];
    for (const key of keyLabels) {
      if (byLabel[key] !== undefined) {
        summaryParts.push(`${short(key)}=${byLabel[key].toFixed(1)}ms`);
      }
    }
    // Also include any marks (0ms entries are from mark(), they still carry meta)
    console.log(`[LoadTraceSummary] ${summaryParts.join(' ')}`);

    // ── 2. console.table ──
    const rows = _traces.map(entry => ({
      label: entry.label,
      elapsedMs: entry.ms.toFixed(2),
      meta: entry.meta ? JSON.stringify(entry.meta) : '',
    }));
    console.table(rows);

    // ── 3. Grouped detail ──
    console.groupCollapsed('[LoadTrace] detail');
    const categories = {};
    for (const entry of _traces) {
      const cat = entry.label.split(':')[0];
      if (!categories[cat]) categories[cat] = { entries: [], total: 0 };
      categories[cat].entries.push(entry);
      categories[cat].total += entry.ms;
    }
    for (const [cat, group] of Object.entries(categories)) {
      console.debug(`  [${cat}] total=${group.total.toFixed(1)}ms`);
      for (const entry of group.entries) {
        const shortLabel = short(entry.label);
        let meta = '';
        if (entry.meta) meta = ' ' + JSON.stringify(entry.meta);
        console.debug(`    ${shortLabel}: ${entry.ms.toFixed(1)}ms${meta}`);
      }
    }
    console.debug(`  TOTAL: ${total.toFixed(1)}ms  events: ${_traces.length}`);
    console.groupEnd();

    return { total, count: _traces.length, byLabel };
  },

  /**
   * 重置追踪状态
   */
  reset() {
    _traces = [];
    _activeSpans.clear();
  },

  /**
   * 快照 renderer.info.memory
   * @param {THREE.WebGLRenderer} renderer
   * @returns {{textures:number, geometries:number}}
   */
  snapshotMemory(renderer) {
    if (!renderer?.info?.memory) return null;
    return {
      textures: renderer.info.memory.textures ?? 0,
      geometries: renderer.info.memory.geometries ?? 0,
    };
  },

  /**
   * 记录 memory delta
   * @param {string} label
   * @param {object} before - snapshotMemory 返回值
   * @param {object} after - snapshotMemory 返回值
   */
  logMemoryDelta(label, before, after) {
    if (!_enabled || !before || !after) return;
    const texDelta = (after.textures ?? 0) - (before.textures ?? 0);
    const geoDelta = (after.geometries ?? 0) - (before.geometries ?? 0);
    _log(`${label} textures=${texDelta >= 0 ? '+' : ''}${texDelta} geometries=${geoDelta >= 0 ? '+' : ''}${geoDelta}`);
  },
};

export default LoadSceneTrace;
