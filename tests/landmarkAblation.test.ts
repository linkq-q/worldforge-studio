import { describe, expect, it } from 'vitest';
import { assertLandmarkOperations, auditLandmarkCode, LANDMARK_PROFILES, landmarkSystemPrompt, landmarkTrials } from '../scripts/landmarkAblationConfig';
import { assertRoundAvailable } from '../scripts/apiAblationConfig';

describe('fixed-kit landmark comparison', () => {
  it('allows the editor reference emitted by the executor without admitting terrain changes', () => {
    expect(() => assertLandmarkOperations([{ type: 'object.add' }, { type: 'reference.set' }])).not.toThrow();
    expect(() => assertLandmarkOperations([{ type: 'terrain.generate' }])).toThrow('unexpected_environment_mutation');
  });
  it('fits the remaining twelve attempts including failures, and rejects attempt 51', () => {
    const keys = Array.from({ length: 38 }, (_, index) => `previous-${index}`);
    const trials = landmarkTrials();
    expect(trials).toHaveLength(12);
    for (const trial of trials) {
      assertRoundAvailable(keys, trial.key);
      keys.push(trial.key);
      const group = trials.filter(item => item.scene === trial.scene && item.repeat === trial.repeat);
      expect(new Set(group.map(item => item.profile)).size).toBe(3);
      expect(new Set(group.map(item => item.seed)).size).toBe(1);
    }
    expect(() => assertRoundAvailable(keys, 'another')).toThrow('round_limit_50');
  });
  it('rejects regeneration, terrain changes, API leakage and indirect access', () => {
    for (const profile of LANDMARK_PROFILES) {
      expect(() => auditLandmarkCode('function plan(api){api.requireAsset({});}', profile)).toThrow('fixed_environment_or_asset_kit');
      expect(() => auditLandmarkCode('function plan(api){api.terrain("mountains");}', profile)).toThrow('fixed_environment_or_asset_kit');
      expect(() => auditLandmarkCode('function plan(api){const x=api;}', profile)).toThrow('indirect_access');
    }
    expect(() => auditLandmarkCode('function plan(api){api.attach({});}', 'core10')).toThrow('not_available');
    expect(auditLandmarkCode('function plan(api){api.place({});api.attach({});}', 'attach')).toEqual(['place', 'attach']);
  });
  it('changes only the optional appendix while preserving assets and coordinate contracts', () => {
    const catalog = [{ id: 'asset-fixed', actualSize: [3, 4, 5] }];
    const base = landmarkSystemPrompt('core10', catalog, 3);
    for (const profile of LANDMARK_PROFILES.slice(1)) expect(landmarkSystemPrompt(profile, catalog, 3).startsWith(base)).toBe(true);
    expect(landmarkSystemPrompt('attach', catalog, 3)).toContain('offset:[x,z]');
    expect(landmarkSystemPrompt('placeBetween', catalog, 3)).toContain('returns no value');
  });
});
