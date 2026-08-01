import { describe, expect, it, vi } from 'vitest';
import { RenderStats, type RendererInfoSource } from '../src/client/renderStats';

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
});
