import { describe, expect, it } from 'vitest';
import { allowed, audit, CORE, FULL, systemPrompt, trials } from '../scripts/controlledApiStudy';

describe('100-map controlled API study', () => {
  it('allocates 96 planned maps and leaves four review slots', () => {
    const queue = trials();
    expect(queue).toHaveLength(96);
    expect(new Set(queue.map(t => t.key)).size).toBe(96);
    expect(Object.fromEntries(['main','single-api','open-assets','reference'].map(stage => [stage,queue.filter(t=>t.stage===stage).length]))).toEqual({ main:42, 'single-api':24, 'open-assets':24, reference:6 });
    for (const t of queue.filter(t=>t.stage==='single-api'||t.stage==='reference')) {
      const baseline=queue.find(b=>b.group===t.group&&b.stage==='main'&&b.profile==='minimal')!;
      expect(t.kitKey).toBe(baseline.kitKey);
      expect(t.seed).toBe(baseline.seed);
    }
    expect(new Set(queue.filter(t=>t.stage==='open-assets').map(t=>t.kitKey)).size).toBe(24);
  });
  it('enforces the frozen capability profiles without dynamic access', () => {
    expect(CORE).toHaveLength(12);expect(FULL).toHaveLength(34);
    expect(allowed('foundation')).toEqual([...CORE,'foundation']);
    expect(()=>audit('function plan(api){api.foundation({});}','minimal')).toThrow('api_not_available');
    expect(()=>audit('function plan(api){api.ellipsePoint(0,8,4,3);}','full')).toThrow('api_not_available');
    expect(()=>audit('function plan(api){api["place"]({});}','full')).toThrow('indirect_api_access');
    expect(audit('function plan(api){api.place({position:[0,0]});}','minimal')).toEqual(['place']);
  });
  it('shares the supplied catalog and only permits new assets in shape trials', () => {
    const queue=trials(),catalog='SHARED_ASSET_CATALOG';
    for(const t of queue.filter(t=>t.group==='village-r1')){
      const prompt=systemPrompt(t,'voxel',catalog);
      expect(prompt).toContain(catalog);expect(prompt).toContain('do not call requireAsset or asset');
      expect(prompt).not.toContain('No reusable assets are available');
    }
    expect(systemPrompt(queue.find(t=>t.stage==='open-assets')!,'voxel')).toContain('10..16 distinct');
  });
});
