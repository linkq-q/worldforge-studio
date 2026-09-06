import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

const editorSource = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('lighting review workflow', () => {
  it('offers final, grayscale, neutral-material and no-post inspection modes', () => {
    expect(editorSource).toContain('id="lighting-review-mode"');
    expect(editorSource).toContain("mode === 'grayscale' ? 'grayscale(1)'");
    expect(editorSource).toContain("mode === 'neutral-material' ? this.neutralLightingReviewMaterial");
    expect(editorSource).toContain("setPostProcessingBypassed(mode === 'no-post')");
  });

  it('bypasses the composer without mutating the saved render scheme', () => {
    const renderer = { render: vi.fn() };
    const frameCoordinator = { renderFrame: vi.fn() };
    const producePrePass = vi.fn();
    const volumetricLight = { group: { visible: false } };
    const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      renderer, frameCoordinator, producePrePass, volumetricLight,
      scene: {}, camera: {}, postProcessingBypassed: true, pendingDeltaTime: 0.016, pendingElapsedSeconds: 1
    }) as RenderRuntimeAdapter;
    adapter.render();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(frameCoordinator.renderFrame).not.toHaveBeenCalled();
    expect(producePrePass).not.toHaveBeenCalled();
    volumetricLight.group.visible = true;
    adapter.render();
    expect(producePrePass).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    adapter.setPostProcessingBypassed(false);
    adapter.render();
    expect(frameCoordinator.renderFrame).toHaveBeenCalledWith(0.016, 1);
  });
});
