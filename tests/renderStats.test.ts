import { describe, expect, it, vi } from 'vitest';
import {
  RenderStats,
  buildPerformanceReport,
  type RenderDebugDetails,
  type RendererInfoSource
} from '../src/client/renderStats';

describe('render stats', () => {
  it('owns renderer info resets and reports compact developer metrics', () => {
    const reset = vi.fn();
    const info: RendererInfoSource = {
      autoReset: true,
      reset,
      render: { calls: 1_234, triangles: 56_780 }
    };
    const element = { hidden: true, textContent: '' } as HTMLElement;
    const stats = new RenderStats(info, element, 0);

    expect(info.autoReset).toBe(false);
    stats.setVisible(true);
    stats.beginFrame();
    stats.endFrame(20, 100);

    expect(element.hidden).toBe(false);
    expect(reset).toHaveBeenCalledOnce();
    expect(element.textContent).toBe('calls 1.2k · tris 56.8k · 17.1 ms');
  });

  it('builds a copyable ten-second report with batching and 1% low metrics', () => {
    const details: RenderDebugDetails = {
      objects: 600,
      waters: 1,
      batchableParts: 500,
      instancedParts: 400,
      batchedMeshParts: 50,
      fallbackParts: 50,
      batchCount: 12,
      effectBatchCount: 2,
      effectBatchParts: 16,
      runtimeIndexPartRefs: 500,
      orphanPartRefs: 0,
      orphanInstanceRefs: 0,
      culled: 100,
      tested: 600,
      grassBlades: 20_000,
      grassFlowers: 900,
      grassDrawCalls: 3,
      atmosphereParticles: 120,
      atmosphereDrawCalls: 2,
      adaptiveQuality: 0.68,
      stages: [],
      passes: [],
      composerPasses: [{ name: 'RenderPass', ms: 4.25 }]
    };
    const report = buildPerformanceReport([
      { frameMs: 16, calls: 120, triangles: 300_000 },
      { frameMs: 20, calls: 140, triangles: 320_000 },
      { frameMs: 40, calls: 160, triangles: 340_000 }
    ], details);

    expect(report).toContain('objects: 600');
    expect(report).toContain('batchCoverage: 90.0%');
    expect(report).toContain('fallbackParts: 50');
    expect(report).toContain('RenderPass=4.25ms');
  });

  it('does not replace interactive controls while the pointer is inside', () => {
    const handlers = new Map<string, () => void>();
    const element = {
      hidden: false,
      innerHTML: 'stable',
      classList: { add: vi.fn() },
      addEventListener: (name: string, handler: () => void) => handlers.set(name, handler),
      querySelector: () => null,
      querySelectorAll: () => []
    } as unknown as HTMLElement;
    const info: RendererInfoSource = {
      autoReset: true,
      reset: vi.fn(),
      render: { calls: 1, triangles: 2 }
    };
    const stats = new RenderStats(info, element, 1, {
      details: () => ({
        objects: 0, waters: 0, batchableParts: 0, instancedParts: 0, batchedMeshParts: 0,
        fallbackParts: 0, batchCount: 0, effectBatchCount: 0, effectBatchParts: 0,
        runtimeIndexPartRefs: 0, orphanPartRefs: 0, orphanInstanceRefs: 0, culled: 0, tested: 0,
        grassBlades: 0, grassFlowers: 0, grassDrawCalls: 0, atmosphereParticles: 0,
        atmosphereDrawCalls: 0, adaptiveQuality: 1, stages: [], passes: [], composerPasses: []
      })
    });

    handlers.get('pointerenter')?.();
    stats.endFrame(16, 100);
    expect(element.innerHTML).toBe('stable');
    handlers.get('pointerleave')?.();
    stats.endFrame(16, 102);
    expect(element.innerHTML).toContain('perf-summary');
  });
});
