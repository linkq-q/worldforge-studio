import { describe, expect, it } from 'vitest';
import { requiresRuntimeStandaloneMaterialTag } from '../src/client/mapMaterialTagBatchPolicy';

describe('map material-tag batching policy', () => {
  it('keeps base-only recipes eligible for primitive batching', () => {
    expect(requiresRuntimeStandaloneMaterialTag({
      effectPackage: { materialLayers: [{ type: 'Triplanar' }] }
    })).toBe(false);
  });

  it('keeps live runtime effects on the standalone path', () => {
    expect(requiresRuntimeStandaloneMaterialTag({
      runtimeEffectPackage: { materialLayers: [{ type: 'Glass' }] }
    })).toBe(true);
  });
});
