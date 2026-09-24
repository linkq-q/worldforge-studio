import { describe, expect, it } from 'vitest';
import { assertModelRoute, assertRoundAvailable, auditApiUse, experimentPrompt, hillsideReviewTrials, PROFILES, trialMatrix } from '../scripts/apiAblationConfig';
import { createEmptyMap } from '../src/shared/map';

describe('API ablation experiment contract', () => {
  it('balances 48 trials over four scenes, six arms and two matched terrain seeds', () => {
    const trials = trialMatrix();
    expect(trials).toHaveLength(48);
    expect(new Set(trials.map(trial => trial.key)).size).toBe(48);
    for (const trial of trials) {
      const group = trials.filter(other => other.scene === trial.scene && other.repeat === trial.repeat);
      expect(new Set(group.map(item => item.profile)).size).toBe(6);
      expect(new Set(group.map(item => item.seed)).size).toBe(1);
    }
  });
  it('stops the review batch after four matched hillside repeats without entering hydro or wetland', () => {
    const trials = hillsideReviewTrials();
    expect(trials).toHaveLength(24);
    expect(trials.slice(0, 12)).toEqual(trialMatrix().filter(trial => trial.scene === 'hillside'));
    for (const repeat of [1, 2, 3, 4]) {
      const group = trials.filter(trial => trial.repeat === repeat);
      expect(new Set(group.map(trial => trial.profile)).size).toBe(6);
      expect(new Set(group.map(trial => trial.seed))).toEqual(new Set([92410 + repeat]));
    }
  });
  it('reserves failed/interrupted attempts too and never admits attempt 51', () => {
    const keys = Array.from({ length: 49 }, (_, index) => `attempt-${index}`);
    expect(() => assertRoundAvailable(keys, 'last')).not.toThrow();
    expect(() => assertRoundAvailable([...keys, 'last'], 'extra')).toThrow('experiment_round_limit_50');
    expect(() => assertRoundAvailable(keys, keys[0])).toThrow('already_attempted');
  });
  it('uses an identical common prompt and changes only the optional API appendix', () => {
    const map = createEmptyMap();
    const base = experimentPrompt(map, 'core10');
    for (const profile of PROFILES.slice(1)) expect(experimentPrompt(map, profile).startsWith(base)).toBe(true);
    expect(base).not.toContain('api.design(');
    expect(base).toContain('Call api.surface with one object containing id and surface');
    expect(base).toContain('every generated placement must use assetId:api.asset(key)');
  });
  it('rejects hidden and aliased API access, while permitting model-authored helpers', () => {
    expect(auditApiUse('function plan(api){ function wave(x){return Math.sin(x);} api.place({position:[wave(2),0]}); }', 'core10')).toEqual(['place']);
    expect(auditApiUse('function plan(api){ api.foundation({under:[]}); }', 'foundation')).toEqual(['foundation']);
    expect(() => auditApiUse('function plan(api){api.foundation({});}', 'core10')).toThrow('not_available:foundation');
    for (const body of ['const a=api; a.design({});', "api['design']({});", 'const f=api.design; f({});']) {
      expect(() => auditApiUse(`function plan(api){${body}}`, 'design')).toThrow('indirect_access');
    }
  });
  it('requires GPT planning, DeepSeek assets, and the agreed asset budget', () => {
    expect(() => assertModelRoute('https://example.test/api/chat', { provider: 'gpt' })).not.toThrow();
    expect(() => assertModelRoute('https://example.test/api/generate/model', { provider: 'deepseek' })).not.toThrow();
    expect(() => assertModelRoute('https://example.test/api/generate/model', { provider: 'gpt' })).toThrow('provider_mismatch');
    expect(() => assertModelRoute('https://example.test/api/chat', { provider: 'deepseek' })).toThrow('provider_mismatch');
    expect(experimentPrompt(createEmptyMap(), 'core10')).toContain('10..16 distinct asset families');
  });
});
