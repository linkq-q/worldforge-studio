export interface RendererInfoSource {
  autoReset: boolean;
  reset(): void;
  render: {
    calls: number;
    triangles: number;
  };
  memory?: {
    geometries?: number;
    textures?: number;
  };
}

export interface RenderDebugDetails {
  objects: number;
  waters: number;
  batchableParts: number;
  instancedParts: number;
  batchedMeshParts: number;
  fallbackParts: number;
  batchCount: number;
  effectBatchCount: number;
  effectBatchParts: number;
  runtimeIndexPartRefs: number;
  orphanPartRefs: number;
  orphanInstanceRefs: number;
  culled: number;
  tested: number;
  grassBlades: number;
  grassFlowers: number;
  grassDrawCalls: number;
  atmosphereParticles: number;
  atmosphereDrawCalls: number;
  weatherParticles: number;
  weatherCapacity: number;
  weatherDrawCalls: number;
  adaptiveQuality: number;
  stages: Array<{ name: string; ms: number }>;
  passes: Array<{ id: string; name: string; enabled: boolean }>;
  composerPasses: Array<{ name: string; ms: number }>;
}

export interface RenderStatsOptions {
  details: () => RenderDebugDetails;
  canExpand?: () => boolean;
  copyText?: (text: string) => Promise<void> | void;
  onTogglePass?: (id: string, enabled: boolean) => void;
  captureDurationMs?: number;
}

export interface FramePerformanceSample {
  frameMs: number;
  calls: number;
  triangles: number;
}

const EMPTY_DETAILS: RenderDebugDetails = {
  objects: 0,
  waters: 0,
  batchableParts: 0,
  instancedParts: 0,
  batchedMeshParts: 0,
  fallbackParts: 0,
  batchCount: 0,
  effectBatchCount: 0,
  effectBatchParts: 0,
  runtimeIndexPartRefs: 0,
  orphanPartRefs: 0,
  orphanInstanceRefs: 0,
  culled: 0,
  tested: 0,
  grassBlades: 0,
  grassFlowers: 0,
  grassDrawCalls: 0,
  atmosphereParticles: 0,
  atmosphereDrawCalls: 0,
  weatherParticles: 0,
  weatherCapacity: 0,
  weatherDrawCalls: 0,
  adaptiveQuality: 1,
  stages: [],
  passes: [],
  composerPasses: []
};

export class RenderStats {
  private smoothedFrameMs = 16.7;
  private lastUpdateAt = Number.NEGATIVE_INFINITY;
  private expanded = false;
  private captureStartedAt: number | null = null;
  private captureSamples: FramePerformanceSample[] = [];
  private status = '';
  private interacting = false;

  constructor(
    private readonly info: RendererInfoSource,
    private readonly element: HTMLElement,
    private readonly updateIntervalMs = 250,
    private readonly options?: RenderStatsOptions
  ) {
    this.info.autoReset = false;
    if (options) {
      this.element.classList.add('viewport-debug-panel');
      // The panel refreshes frequently. Freeze its DOM while the pointer is
      // inside so buttons cannot be detached between pointer-down and click.
      this.element.addEventListener('pointerenter', () => { this.interacting = true; });
      this.element.addEventListener('pointerleave', () => { this.interacting = false; });
    }
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  beginFrame(): void {
    this.info.reset();
  }

  endFrame(frameMs: number, now: number): void {
    if (Number.isFinite(frameMs) && frameMs > 0) {
      this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * 0.12;
      if (this.captureStartedAt !== null) {
        this.captureSamples.push({
          frameMs,
          calls: this.info.render.calls,
          triangles: this.info.render.triangles
        });
      }
    }
    if (this.captureStartedAt !== null && now - this.captureStartedAt >= (this.options?.captureDurationMs ?? 10_000)) {
      void this.finishCapture();
    }
    if (now - this.lastUpdateAt < this.updateIntervalMs) return;
    this.lastUpdateAt = now;
    if (!this.options) {
      this.element.textContent = this.compactText();
      return;
    }
    if (this.interacting) return;
    this.renderPanel();
  }

  beginCapture(now = performance.now()): void {
    this.captureStartedAt = now;
    this.captureSamples = [];
    this.status = '正在记录 10 秒…';
    this.renderPanel();
  }

  private compactText(): string {
    return [
      `calls ${formatCount(this.info.render.calls)}`,
      `tris ${formatCount(this.info.render.triangles)}`,
      `${this.smoothedFrameMs.toFixed(1)} ms`
    ].join(' · ');
  }

  private renderPanel(): void {
    const details = this.options?.details() ?? EMPTY_DETAILS;
    const expanded = this.expanded && (this.options?.canExpand?.() ?? true);
    const fps = 1000 / Math.max(0.01, this.smoothedFrameMs);
    const batchCoverage = details.batchableParts > 0
      ? (details.instancedParts + details.batchedMeshParts) / details.batchableParts * 100
      : 0;
    const passRows = details.composerPasses
      .map((pass) => `<div><span>${escapeHtml(pass.name)}</span><b>${pass.ms.toFixed(2)} ms</b></div>`)
      .join('');
    const passToggles = details.passes
      .map((pass) => `<button type="button" data-perf-pass="${escapeHtml(pass.id)}" data-enabled="${pass.enabled}">${pass.enabled ? '✓' : '○'} ${escapeHtml(pass.name)}</button>`)
      .join('');
    this.element.innerHTML = `
      <button type="button" class="perf-summary" aria-expanded="${expanded}" title="${this.options?.canExpand?.() === false ? '进入开发者模式可展开' : '展开性能详情'}">
        <b>${fps.toFixed(0)} FPS</b><span>${this.smoothedFrameMs.toFixed(1)} ms</span>
        <span>calls ${formatCount(this.info.render.calls)}</span><span>tris ${formatCount(this.info.render.triangles)}</span>
      </button>
      <div class="perf-details" ${expanded ? '' : 'hidden'}>
        <div class="perf-grid">
          <span>物体 <b>${details.objects}</b></span><span>水体 <b>${details.waters}</b></span>
          <span>批次 <b>${details.batchCount}</b></span><span>合批覆盖 <b>${batchCoverage.toFixed(0)}%</b></span>
          <span>Instanced <b>${details.instancedParts}</b></span><span>BatchedMesh <b>${details.batchedMeshParts}</b></span>
          <span>Fallback <b>${details.fallbackParts}</b></span><span>剔除 <b>${details.culled}/${details.tested}</b></span>
          <span>特效批次 <b>${details.effectBatchCount}/${details.effectBatchParts}</b></span><span>Index <b>${details.runtimeIndexPartRefs}</b></span>
          <span>孤儿 Part <b>${details.orphanPartRefs}</b></span><span>孤儿实例 <b>${details.orphanInstanceRefs}</b></span>
          <span>草叶 <b>${formatCount(details.grassBlades)}</b></span><span>碎花 <b>${formatCount(details.grassFlowers)}</b></span>
          <span>草 Draw <b>${details.grassDrawCalls}</b></span><span>纹理 <b>${this.info.memory?.textures ?? 0}</b></span>
          <span>氛围粒子 <b>${formatCount(details.atmosphereParticles)}</b></span><span>氛围 Draw <b>${details.atmosphereDrawCalls}</b></span>
          <span>天气粒子 <b>${formatCount(details.weatherParticles)}/${formatCount(details.weatherCapacity)}</b></span><span>天气 Draw <b>${details.weatherDrawCalls}</b></span>
          <span>自适应质量 <b>${Math.round(details.adaptiveQuality * 100)}%</b></span><span>未合批 Part <b>${details.fallbackParts}</b></span>
        </div>
        ${passRows ? `<div class="perf-pass-list"><strong>Pass Timing</strong>${passRows}</div>` : ''}
        ${passToggles ? `<div class="perf-pass-toggles"><strong>临时 Pass 开关</strong>${passToggles}</div>` : ''}
        <button type="button" class="perf-capture">记录并复制 10 秒报告</button>
        <small>${escapeHtml(this.status || 'CPU 帧时；Pass 开关不会修改方案存档')}</small>
      </div>`;
    this.bindPanel();
  }

  private bindPanel(): void {
    this.element.querySelector<HTMLButtonElement>('.perf-summary')?.addEventListener('click', () => {
      if (this.options?.canExpand?.() === false) return;
      this.expanded = !this.expanded;
      this.renderPanel();
    });
    this.element.querySelector<HTMLButtonElement>('.perf-capture')?.addEventListener('click', () => {
      this.beginCapture();
    });
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-perf-pass]')) {
      button.addEventListener('click', () => {
        const id = button.dataset.perfPass;
        if (id) this.options?.onTogglePass?.(id, button.dataset.enabled !== 'true');
      });
    }
  }

  private async finishCapture(): Promise<void> {
    this.captureStartedAt = null;
    const report = buildPerformanceReport(this.captureSamples, this.options?.details() ?? EMPTY_DETAILS);
    try {
      await (this.options?.copyText?.(report) ?? navigator.clipboard?.writeText(report));
      this.status = `已复制性能报告（${this.captureSamples.length} 帧）`;
    } catch {
      this.status = '性能报告生成完成，但剪贴板写入失败';
    }
    this.renderPanel();
  }
}

export function buildPerformanceReport(
  samples: readonly FramePerformanceSample[],
  details: RenderDebugDetails
): string {
  const frameTimes = samples.map((sample) => sample.frameMs).filter((value) => Number.isFinite(value) && value > 0);
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const averageFrameMs = average(frameTimes);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const averageCalls = average(samples.map((sample) => sample.calls));
  const averageTriangles = average(samples.map((sample) => sample.triangles));
  const batchCoverage = details.batchableParts > 0
    ? (details.instancedParts + details.batchedMeshParts) / details.batchableParts * 100
    : 0;
  return [
    'WorldForge Performance Report',
    `frames: ${samples.length}`,
    `fps.avg: ${(1000 / Math.max(0.01, averageFrameMs)).toFixed(1)}`,
    `fps.1%low: ${(1000 / Math.max(0.01, p99)).toFixed(1)}`,
    `frame.avgMs: ${averageFrameMs.toFixed(2)}`,
    `frame.p95Ms: ${p95.toFixed(2)}`,
    `drawCalls.avg: ${averageCalls.toFixed(1)}`,
    `triangles.avg: ${Math.round(averageTriangles)}`,
    `objects: ${details.objects}`,
    `waterBodies: ${details.waters}`,
    `batches: ${details.batchCount}`,
    `batchCoverage: ${batchCoverage.toFixed(1)}%`,
    `fallbackParts: ${details.fallbackParts}`,
    `effectBatches: ${details.effectBatchCount}`,
    `effectBatchParts: ${details.effectBatchParts}`,
    `runtimeIndexPartRefs: ${details.runtimeIndexPartRefs}`,
    `orphanPartRefs: ${details.orphanPartRefs}`,
    `orphanInstanceRefs: ${details.orphanInstanceRefs}`,
    `grassBlades: ${details.grassBlades}`,
    `grassFlowers: ${details.grassFlowers}`,
    `atmosphereParticles: ${details.atmosphereParticles}`,
    `weatherParticles: ${details.weatherParticles}/${details.weatherCapacity}`,
    `adaptiveQuality: ${details.adaptiveQuality.toFixed(2)}`,
    `composer: ${details.composerPasses.map((pass) => `${pass.name}=${pass.ms.toFixed(2)}ms`).join(', ') || 'none'}`
  ].join('\n');
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}
