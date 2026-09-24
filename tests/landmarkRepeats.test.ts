import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { assertRepeatBudget, calibratedPrompt, calibratedTrials, REPEAT_BATCH } from '../scripts/landmarkRepeatConfig';

describe('calibrated landmark repeats', () => {
  it('reserves exactly twenty new attempts and refuses attempt seventy-one', () => {
    const rounds: { key: string; batch?: string }[] = Array.from({ length: 50 }, (_, i) => ({ key: `old-${i}` }));
    const trials = calibratedTrials();
    expect(trials).toHaveLength(20);
    for (const trial of trials) {
      assertRepeatBudget(rounds, trial.key);
      rounds.push({ key: trial.key, batch: REPEAT_BATCH });
    }
    expect(() => assertRepeatBudget(rounds, 'extra')).toThrow('budget_exhausted');
    expect(() => assertRepeatBudget([], 'first')).not.toThrow();
    expect(() => assertRepeatBudget([{ key: 'same' }], 'same')).toThrow('already_reserved');
  });
  it('holds input and seed constant across five repeats in each condition', () => {
    const trials = calibratedTrials();
    for (const scene of ['qiniandian', 'colosseum']) for (const profile of ['core10', 'placeBetween'] as const) {
      const group = trials.filter(t => t.scene === scene && t.profile === profile);
      expect(group).toHaveLength(5);
      expect(new Set(group.map(t => calibratedPrompt(profile, [], t.seed))).size).toBe(1);
    }
  });
  it('matches the actual radians contract rather than feeding degrees into rendering', () => {
    const prompt = calibratedPrompt('core10', [], 1);
    expect(prompt).toContain('rotationY?:radians');
    expect(prompt).not.toContain('rotationY?:degrees');
    const suggestion = executeMapCodePlan('function plan(api){api.place({name:"rotation calibration",position:[0,0,0],terrain:false,rotationY:Math.PI/2});}', createEmptyMap(), [], { mode: 'final', spatialPolicy: 'diagnose' });
    const object = suggestion.operations.find(o => o.type === 'object.add');
    expect(object?.type === 'object.add' && object.object.transform?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
  });
});
