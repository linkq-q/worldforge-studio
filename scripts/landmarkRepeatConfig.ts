import { LANDMARKS, landmarkSystemPrompt } from './landmarkAblationConfig';

export const REPEAT_BATCH = 'landmark-calibrated-v2';
export const REPEAT_LIMIT = 70;
export const REPEAT_PROFILES = ['core10', 'placeBetween'] as const;
export function calibratedTrials() {
  return Array.from({ length: 5 }, (_, i) => i + 1).flatMap(repeat =>
    LANDMARKS.flatMap((scene, index) =>
      (repeat % 2 ? [...REPEAT_PROFILES] : [...REPEAT_PROFILES].reverse()).map(profile => ({
        key: `landmark-v2-${scene.id}-${profile}-r${repeat}`, scene: scene.id, profile, repeat,
        seed: 92600 + index
      }))));
}
export function assertRepeatBudget(rounds: readonly { key: string; batch?: string }[], key: string) {
  if (rounds.some(r => r.key === key)) throw new Error('repeat_already_reserved');
  if (rounds.length >= REPEAT_LIMIT || rounds.filter(r => r.batch === REPEAT_BATCH).length >= 20) throw new Error('repeat_budget_exhausted');
}
export function calibratedPrompt(profile: typeof REPEAT_PROFILES[number], catalog: unknown, seed: number) {
  return landmarkSystemPrompt(profile, catalog, seed) + `
Experiment execution: standard automatic spatial repair is enabled identically in both conditions, including connected-run fitting. Label separate structural runs/stories with separate groupId values so unrelated rings are not grouped together. Whole rings/roofs are single components: inspect descriptions AND measured bounds before deciding whether to repeat a component. Do not assume every asset is one bay. This is not a requirement to use any optional API.
`;
}
