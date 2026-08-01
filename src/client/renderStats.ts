export interface RendererInfoSource {
  autoReset: boolean;
  reset(): void;
  render: {
    calls: number;
    triangles: number;
  };
}

export class RenderStats {
  private smoothedFrameMs = 16.7;
  private lastUpdateAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly info: RendererInfoSource,
    private readonly element: HTMLElement,
    private readonly updateIntervalMs = 250
  ) {
    this.info.autoReset = false;
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
    }
    if (now - this.lastUpdateAt < this.updateIntervalMs) return;
    this.lastUpdateAt = now;
    this.element.textContent = [
      `calls ${formatCount(this.info.render.calls)}`,
      `tris ${formatCount(this.info.render.triangles)}`,
      `${this.smoothedFrameMs.toFixed(1)} ms`
    ].join(' · ');
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}
