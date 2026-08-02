import { compileRenderPlan, type RenderModuleSelection, type RenderPlan } from '../shared/renderPlan';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';

const SOFT_LIGHT = /柔和|柔光|soft\s*(?:light|morning|sun|lighting)?/i;
const EXPLICIT_LOW_CONTRAST = /雾|薄雾|晨雾|mist|haze|朦胧|低对比|低饱和|粉彩|pastel|泛白|褪色/i;

/**
 * "Soft light" is a lighting request, not permission to wash out the image.
 * Keep deliberate haze and pastel requests untouched, but make the common
 * wording deterministic when an LLM conflates the two concepts.
 */
export function stabilizeRenderSemantics(
  prompt: string,
  suggestion: RenderSuggestion,
  schemes: readonly RenderScheme[],
  isRefine: boolean
): RenderSuggestion {
  if (!SOFT_LIGHT.test(prompt) || EXPLICIT_LOW_CONTRAST.test(prompt)) return suggestion;

  const plan: RenderPlan = {
    ...suggestion.plan,
    modules: suggestion.plan.modules.map((module) => ({ ...module, params: { ...module.params } }))
  };
  const grade = plan.modules.find((module) => module.id === 'runtime.color-grade');
  if (grade) stabilizeColorGrade(grade);
  ensureSoftLightRig(plan.modules);

  const baseSchemeId = !isRefine && isMistBaseScheme(plan.baseSchemeId)
    && schemes.some((scheme) => scheme.id === 'render-natural-day')
    ? 'render-natural-day'
    : plan.baseSchemeId;
  plan.baseSchemeId = baseSchemeId;
  return {
    ...suggestion,
    baseSchemeId,
    plan,
    settings: compileRenderPlan(plan)
  };
}

function isMistBaseScheme(id: string): boolean {
  return id === 'render-morning-mist' || id === 'render-runtime-sketch-mist';
}

function stabilizeColorGrade(module: RenderModuleSelection): void {
  if (module.params.recipe === 'misty' || module.params.recipe === 'pastel') {
    module.params.recipe = 'neutral';
  }
  if (typeof module.params.contrast === 'number') module.params.contrast = Math.max(0.96, module.params.contrast);
  if (typeof module.params.saturation === 'number') module.params.saturation = Math.max(0.9, module.params.saturation);
  if (typeof module.params.shadowLift === 'number') module.params.shadowLift = Math.min(0.035, module.params.shadowLift);
}

function ensureSoftLightRig(modules: RenderModuleSelection[]): void {
  const rig = modules.find((module) => module.id === 'runtime.light-rig');
  if (rig) return;
  modules.push({
    id: 'runtime.light-rig',
    params: { recipe: 'soft-morning', strength: 0.9, shadowSoftness: 0.78 }
  });
}
