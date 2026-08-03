import { describe, expect, it } from 'vitest';
import { AdaptiveRenderQuality } from '../src/client/adaptiveRenderQuality';

describe('adaptive render quality', () => {
  it('degrades only after sustained slow frames and restores more slowly', () => {
    const controller = new AdaptiveRenderQuality();
    let change = null;
    for (let index = 0; index < 160; index += 1) change = controller.update(45, 1 / 60) ?? change;
    expect(change?.level).toBe('balanced');

    change = null;
    for (let index = 0; index < 400; index += 1) change = controller.update(16, 1 / 60) ?? change;
    expect(change?.level).toBe('high');
  });
});
