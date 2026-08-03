export type AdaptiveQualityLevel = 'high' | 'balanced' | 'performance';

export interface AdaptiveQualityState {
  level: AdaptiveQualityLevel;
  scale: number;
}

const STATES: Record<AdaptiveQualityLevel, AdaptiveQualityState> = {
  high: { level: 'high', scale: 1 },
  balanced: { level: 'balanced', scale: 0.68 },
  performance: { level: 'performance', scale: 0.42 }
};

/** Slow hysteresis prevents one hitch from visibly changing quality. */
export class AdaptiveRenderQuality {
  private averageMs = 16.7;
  private slowFor = 0;
  private fastFor = 0;
  private level: AdaptiveQualityLevel = 'high';

  update(frameMs: number, deltaSeconds: number): AdaptiveQualityState | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    this.averageMs += (frameMs - this.averageMs) * 0.06;
    if (this.averageMs > 34) {
      this.slowFor += deltaSeconds;
      this.fastFor = 0;
    } else if (this.averageMs < 21) {
      this.fastFor += deltaSeconds;
      this.slowFor = 0;
    } else {
      this.slowFor = Math.max(0, this.slowFor - deltaSeconds);
      this.fastFor = Math.max(0, this.fastFor - deltaSeconds);
    }
    if (this.slowFor >= 2) {
      this.slowFor = 0;
      const next = this.level === 'high' ? 'balanced' : 'performance';
      if (next !== this.level) {
        this.level = next;
        return STATES[this.level];
      }
    }
    if (this.fastFor >= 6) {
      this.fastFor = 0;
      const next = this.level === 'performance' ? 'balanced' : 'high';
      if (next !== this.level) {
        this.level = next;
        return STATES[this.level];
      }
    }
    return null;
  }

  current(): AdaptiveQualityState {
    return STATES[this.level];
  }
}
