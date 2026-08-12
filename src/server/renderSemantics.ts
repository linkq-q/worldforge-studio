import { compileRenderPlan, type RenderModuleSelection, type RenderPlan } from '../shared/renderPlan';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';
import { normalizeVisualDirection } from '../shared/visualDirection';
import { mixHexColors } from '../shared/colorDirector';

const SOFT_LIGHT = /柔和|柔光|soft\s*(?:light|morning|sun|lighting)?/i;
const EXPLICIT_LOW_CONTRAST = /雾|薄雾|晨雾|mist|haze|朦胧|低对比|低饱和|粉彩|pastel|泛白|褪色/i;
const STRONG_DAYLIGHT = /艳阳|烈日|强烈阳光|阳光强烈|高对比|hard\s*(?:sun|light)|bright\s*sun|high\s*contrast/i;
const COOL_DIRECTION = /冷调|冷色|蓝调|cool\s*(?:tone|palette)|blue\s*(?:tone|palette)/i;
const DRAMATIC_DIRECTION = /戏剧|史诗|强烈剪影|dramatic|epic|silhouette/i;
const COLORED_SHADOW_DIRECTION = /彩色阴影|色彩丰富|通透|colored?\s*shadow|rich\s*colou?r/i;
const BLUER_WATER = /(?:水(?:面|体|色)?[^，。！？,;\n]{0,8}更蓝|更蓝[^，。！？,;\n]{0,8}水(?:面|体|色)?|(?:water|ocean|sea|lake|river)[ -]?(?:more[ -]?)?blue|bluer[ -]?(?:water|ocean|sea|lake|river))/i;
const WEAKER_WATER_REFLECTION = /(?:(?:反光|反射)[^，。！？,;\n]{0,8}(?:弱|低|少|柔和)|(?:弱化|减弱|降低|减少)[^，。！？,;\n]{0,8}(?:反光|反射)|(?:weaker|softer|less|reduce(?:d)?)[ -]?(?:water[ -]?)?reflection)/i;

/**
 * "Soft light" is a lighting request, not permission to wash out the image.
 * Keep deliberate haze and pastel requests untouched, but make the common
 * wording deterministic when an LLM conflates the two concepts.
 */
export function stabilizeRenderSemantics(
  prompt: string,
  suggestion: RenderSuggestion,
  schemes: readonly RenderScheme[],
  currentPlan?: RenderPlan
): RenderSuggestion {
  const isRefine = Boolean(currentPlan);
  let stabilized = suggestion;
  if (STRONG_DAYLIGHT.test(prompt)) {
    stabilized = stabilizeStrongDaylight(prompt, suggestion, schemes, isRefine);
  } else if (SOFT_LIGHT.test(prompt) && !EXPLICIT_LOW_CONTRAST.test(prompt)) {
    stabilized = stabilizeSoftLight(suggestion, schemes, isRefine);
  }
  return BLUER_WATER.test(prompt) || WEAKER_WATER_REFLECTION.test(prompt)
    ? stabilizeWaterRefine(prompt, stabilized)
    : stabilized;
}

function stabilizeSoftLight(
  suggestion: RenderSuggestion,
  _schemes: readonly RenderScheme[],
  _isRefine: boolean
): RenderSuggestion {
  const plan: RenderPlan = {
    ...suggestion.plan,
    modules: suggestion.plan.modules.map((module) => ({ ...module, params: { ...module.params } }))
  };
  plan.visualDirection = normalizeVisualDirection({
    ...plan.visualDirection,
    contrastMode: plan.visualDirection?.contrastMode ?? 'bright-cartoon',
    timeOfDay: plan.visualDirection?.timeOfDay ?? 'morning'
  });
  const grade = plan.modules.find((module) => module.id === 'runtime.color-grade');
  if (grade) stabilizeColorGrade(grade);
  ensureSoftLightRig(plan.modules);

  const baseSchemeId = plan.baseSchemeId;
  plan.baseSchemeId = baseSchemeId;
  return {
    ...suggestion,
    baseSchemeId,
    plan,
    settings: compileRenderPlan(plan)
  };
}

function stabilizeWaterRefine(prompt: string, suggestion: RenderSuggestion): RenderSuggestion {
  if (!suggestion.plan.modules.some((module) => module.id === 'runtime.water-style')) return suggestion;
  const plan: RenderPlan = {
    ...suggestion.plan,
    modules: suggestion.plan.modules.map((module) => ({ ...module, params: { ...module.params } }))
  };
  for (const module of plan.modules) {
    if (module.id !== 'runtime.water-style') continue;
    delete module.params.reflectionStrength;
    delete module.params.reflectionDistortion;
    delete module.params.reflectionFresnel;
    if (BLUER_WATER.test(prompt)) {
      module.params.color = mixHexColors(colorParam(module.params.color, '#4b8fae'), '#247fc1', 0.68);
      module.params.shallowColor = mixHexColors(colorParam(module.params.shallowColor, '#80bdd0'), '#65b9df', 0.68);
      module.params.depthColor = mixHexColors(colorParam(module.params.depthColor, '#234f73'), '#164c7d', 0.68);
    }
    if (WEAKER_WATER_REFLECTION.test(prompt)) {
      module.params.environmentReflectionStrength = cappedNumber(module.params.environmentReflectionStrength, 0.14);
      module.params.environmentReflectionExposure = cappedNumber(module.params.environmentReflectionExposure, 0.45);
    }
  }
  return { ...suggestion, plan, settings: compileRenderPlan(plan) };
}

function colorParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function cappedNumber(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(value, maximum) : maximum;
}

function stabilizeStrongDaylight(
  prompt: string,
  suggestion: RenderSuggestion,
  _schemes: readonly RenderScheme[],
  _isRefine: boolean
): RenderSuggestion {
  const plan: RenderPlan = {
    ...suggestion.plan,
    modules: suggestion.plan.modules.map((module) => ({ ...module, params: { ...module.params } }))
  };
  plan.visualDirection = normalizeVisualDirection({
    ...plan.visualDirection,
    contrastMode: DRAMATIC_DIRECTION.test(prompt)
      ? 'dramatic'
      : COLORED_SHADOW_DIRECTION.test(prompt)
        ? 'colored-shadow'
        : 'bright-cartoon',
    timeOfDay: plan.visualDirection?.timeOfDay ?? 'noon',
    temperature: COOL_DIRECTION.test(prompt) ? 'cool' : plan.visualDirection?.temperature ?? 'warm'
  });
  let grade = plan.modules.find((module) => module.id === 'runtime.color-grade');
  if (!grade) {
    grade = { id: 'runtime.color-grade', params: {} };
    plan.modules.push(grade);
  }
  stabilizeStrongDaylightGrade(grade, COOL_DIRECTION.test(prompt));
  ensureHardDayRig(plan.modules);
  preserveCelShadowDetail(plan.modules);

  const baseSchemeId = plan.baseSchemeId;
  plan.baseSchemeId = baseSchemeId;
  return {
    ...suggestion,
    baseSchemeId,
    plan,
    settings: compileRenderPlan(plan)
  };
}

function stabilizeColorGrade(module: RenderModuleSelection): void {
  if (module.params.recipe === 'misty' || module.params.recipe === 'pastel') {
    module.params.recipe = 'neutral';
  }
  if (typeof module.params.contrast === 'number') module.params.contrast = Math.max(0.96, module.params.contrast);
  if (typeof module.params.saturation === 'number') module.params.saturation = Math.max(0.9, module.params.saturation);
  if (typeof module.params.shadowLift === 'number') module.params.shadowLift = Math.min(0.035, module.params.shadowLift);
}

function stabilizeStrongDaylightGrade(module: RenderModuleSelection, cool: boolean): void {
  module.params.recipe = cool ? 'cool' : 'warm';
  module.params.temperature = cool
    ? clampNumber(module.params.temperature, -0.3, -0.05, -0.12)
    : clampNumber(module.params.temperature, 0.05, 0.28, 0.12);
  module.params.contrast = clampNumber(module.params.contrast, 1.06, 1.16, 1.1);
  module.params.saturation = clampNumber(module.params.saturation, 1, 1.12, 1.06);
  module.params.shadowLift = clampNumber(module.params.shadowLift, 0.035, 0.07, 0.05);
  module.params.tint = cool ? '#eaf2ff' : '#fff1df';
}

function ensureSoftLightRig(modules: RenderModuleSelection[]): void {
  const rig = modules.find((module) => module.id === 'runtime.light-rig');
  if (rig) return;
  modules.push({
    id: 'runtime.light-rig',
    params: { recipe: 'soft-morning', strength: 0.9, shadowSoftness: 0.78 }
  });
}

function ensureHardDayRig(modules: RenderModuleSelection[]): void {
  let rig = modules.find((module) => module.id === 'runtime.light-rig');
  if (!rig) {
    rig = { id: 'runtime.light-rig', params: {} };
    modules.push(rig);
  }
  rig.params.recipe = 'hard-day';
  rig.params.strength = clampNumber(rig.params.strength, 0.9, 1.15, 1);
  rig.params.warmth = clampNumber(rig.params.warmth, 0.08, 0.35, 0.18);
  rig.params.shadowSoftness = clampNumber(rig.params.shadowSoftness, 0.2, 0.48, 0.3);
}

function preserveCelShadowDetail(modules: RenderModuleSelection[]): void {
  const surface = modules.find((module) => module.id === 'runtime.surface-style');
  if (!surface || surface.params.mode !== 'cel') return;
  surface.params.shadowFloor = clampNumber(surface.params.shadowFloor, 0.34, 0.52, 0.38);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
