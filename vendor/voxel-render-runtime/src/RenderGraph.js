/**
 * RenderGraph v1 — 侧资源图 + 资源黑板（纯逻辑，零 three 依赖）
 *
 * 建模 depth/normal/reflection/glassEnv/water 这类"侧资源"的 producer→consumer：
 *   - producer 声明 writes（写哪些资源）、reads（依赖哪些资源）、run(ctx, blackboard)
 *   - consumer 声明 reads + enabled()，决定 producer 是否被需求
 *   - 图据此推导执行顺序（拓扑）、按需门控、启动校验
 *
 * 契约（详见 docs/tasks/render-graph-v1.md）：
 *   - 资源名约定 `域:名`（scene:depth / reflection:planar / env:glass …），不建词表文件
 *   - 只有 execute() 可以调 producer.run；只有 producer 可以写黑板
 *   - onDirty producer 跳过的帧，consumer 仍拿到上一次的句柄（黑板跨帧持久）
 *   - read 到 null 时 consumer 自己降级，图不强制禁用
 */

export class RenderGraph {
  constructor() {
    /** id → { id, writes, reads, run, policy } */
    this.producers = new Map();
    /** id → { id, reads, enabled } */
    this.consumers = new Map();
    /** 资源名 → texture/RT 句柄 */
    this.blackboard = new Map();
    /** 脏资源名集合；写它的 onDirty producer 下一帧跑一次 */
    this._dirty = new Set();
    /** 缓存的拓扑序（注册 producer 时失效） */
    this._order = null;
  }

  /**
   * @param {object} spec
   * @param {string} spec.id
   * @param {string[]} [spec.writes]
   * @param {string[]} [spec.reads]
   * @param {(ctx:any, blackboard:Map)=>void} spec.run
   * @param {'everyFrame'|'onDirty'} [spec.policy]
   * @param {string} [spec.phase] 帧序分组；execute(phase) 只跑匹配的 producer。默认 'default'。
   *   反映真实帧序约束：planar/glass 在 syncPassState 前（'default'），prePass 在其后（'prePass'）。
   */
  registerProducer({ id, writes = [], reads = [], run, policy = 'everyFrame', phase = 'default' }) {
    this.producers.set(id, { id, writes, reads, run, policy, phase });
    this._order = null;
  }

  /**
   * @param {object} spec
   * @param {string} spec.id
   * @param {string[]} [spec.reads]
   * @param {boolean|(()=>boolean)} [spec.enabled] 默认 true；传函数则每帧求值
   */
  registerConsumer({ id, reads = [], enabled = true }) {
    this.consumers.set(id, { id, reads, enabled });
  }

  /** 标记资源脏：写它的 onDirty producer 下一帧跑一次（按资源名，非 producer id） */
  markDirty(resourceName) {
    this._dirty.add(resourceName);
  }

  /** 从黑板读资源句柄，缺失返回 null（consumer 自行降级） */
  getResource(name) {
    return this.blackboard.get(name) ?? null;
  }

  /** 资源名 → 写它的 producer id */
  _writeMap() {
    const m = new Map();
    for (const p of this.producers.values()) {
      for (const w of p.writes) m.set(w, p.id);
    }
    return m;
  }

  _isEnabled(consumer) {
    return typeof consumer.enabled === 'function'
      ? !!consumer.enabled()
      : consumer.enabled !== false;
  }

  /** producer 拓扑序（A.writes 被 B.reads 依赖 → A 在前）；环 → 抛错 */
  _topoOrder() {
    const writeMap = this._writeMap();
    const state = new Map(); // id → 0 未访问 / 1 访问中 / 2 完成
    const order = [];
    const visit = (p) => {
      const s = state.get(p.id) || 0;
      if (s === 2) return;
      if (s === 1) throw new Error(`RenderGraph: cycle detected at producer "${p.id}"`);
      state.set(p.id, 1);
      for (const r of p.reads) {
        const depId = writeMap.get(r);
        if (depId && depId !== p.id) visit(this.producers.get(depId));
      }
      state.set(p.id, 2);
      order.push(p);
    };
    for (const p of this.producers.values()) visit(p);
    return order;
  }

  /** 被需求的 producer id 集合：从 enabled consumer 的 reads 反向可达 */
  _demandSet() {
    const writeMap = this._writeMap();
    const demanded = new Set();
    const stack = [];
    const demand = (name) => {
      const pid = writeMap.get(name);
      if (pid && !demanded.has(pid)) { demanded.add(pid); stack.push(pid); }
    };
    for (const c of this.consumers.values()) {
      if (!this._isEnabled(c)) continue;
      for (const r of c.reads) demand(r);
    }
    while (stack.length) {
      const p = this.producers.get(stack.pop());
      for (const r of p.reads) demand(r);
    }
    return demanded;
  }

  /**
   * 按拓扑序跑被需求且 policy 允许的 producer；只有这里能调 run。
   * @param {any} ctx
   * @param {string} [phase='default'] 只跑该 phase 的 producer（需求/拓扑仍全局计算）。
   */
  execute(ctx, phase = 'default') {
    if (!this._order) this._order = this._topoOrder();
    const demanded = this._demandSet();
    for (const p of this._order) {
      if ((p.phase || 'default') !== phase) continue;
      if (!demanded.has(p.id)) continue;
      if (p.policy === 'onDirty' && !p.writes.some(w => this._dirty.has(w))) continue;
      p.run(ctx, this.blackboard);
      for (const w of p.writes) this._dirty.delete(w);
    }
  }

  /** 静态校验：写者唯一 + enabled consumer 的 reads 有 producer。返回错误串数组并 console.error */
  validate() {
    const errors = [];
    const writers = new Map(); // 资源 → [producer id]
    for (const p of this.producers.values()) {
      for (const w of p.writes) {
        if (!writers.has(w)) writers.set(w, []);
        writers.get(w).push(p.id);
      }
    }
    for (const [res, ids] of writers) {
      if (ids.length > 1) {
        errors.push(`RenderGraph: resource "${res}" has multiple writers: ${ids.join(', ')}`);
      }
    }
    const produced = new Set(writers.keys());
    for (const c of this.consumers.values()) {
      if (!this._isEnabled(c)) continue;
      for (const r of c.reads) {
        if (!produced.has(r)) {
          errors.push(`RenderGraph: consumer "${c.id}" reads "${r}" but no producer writes it`);
        }
      }
    }
    for (const e of errors) console.error(e);
    return errors;
  }

  dispose() {
    this.producers.clear();
    this.consumers.clear();
    this.blackboard.clear();
    this._dirty.clear();
    this._order = null;
  }
}

export default RenderGraph;
