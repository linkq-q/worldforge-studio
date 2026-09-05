import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editorSource = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../src/client/renderRuntimeAdapter.ts', import.meta.url), 'utf8');

describe('lighting review workflow', () => {
  it('offers final, grayscale, neutral-material and no-post inspection modes', () => {
    expect(editorSource).toContain('id="lighting-review-mode"');
    expect(editorSource).toContain("mode === 'grayscale' ? 'grayscale(1)'");
    expect(editorSource).toContain("mode === 'neutral-material' ? this.neutralLightingReviewMaterial");
    expect(editorSource).toContain("setPostProcessingBypassed(mode === 'no-post')");
  });

  it('bypasses the composer without mutating the saved render scheme', () => {
    expect(adapterSource).toContain('if (this.postProcessingBypassed) this.renderer.render(this.scene, this.camera)');
    expect(adapterSource).toContain('else this.frameCoordinator.renderFrame');
  });
});
