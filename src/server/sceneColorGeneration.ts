import type { EditableMap } from '../shared/map';
import type { MapStore } from './mapStore';
import { sceneAppearanceBrief, type SceneAppearancePlan } from '../shared/sceneAppearance';

/** Text context from the confirmed render scheme, never a color quantizer. */
export async function sceneColorGenerationBrief(map: Pick<EditableMap, 'renderSchemeId'>, store: MapStore, appearancePlan?: SceneAppearancePlan): Promise<string> {
  if (appearancePlan) return sceneAppearanceBrief(appearancePlan);
  if (!map.renderSchemeId) return '';
  const { renderPlan: plan } = await store.loadRenderScheme(map.renderSchemeId);
  if (!plan) return '';
  const materialRules = plan.modules.filter(module => module.id === 'runtime.material-theme' && module.params.color)
    .slice(0, 16).map(module => ({ target: module.scope, color: module.params.color, strength: module.params.strength }));
  const surroundings = plan.modules.filter(module => ['runtime.grass-style', 'runtime.water-style', 'runtime.terrain-materials'].includes(module.id))
    .slice(0, 12).map(module => ({ kind: module.id, target: module.scope,
      colors: Object.fromEntries(Object.entries(module.params).filter(([key, value]) => /color$/i.test(key) && typeof value === 'string' && /^#[\da-f]{6}$/i.test(value))) }));
  if (!materialRules.length && !surroundings.some(item => Object.keys(item.colors).length) && !plan.visualDirection) return '';
  return [
    'Scene color direction from the confirmed render scheme:',
    JSON.stringify({ materialRules, surroundings, ...(plan.visualDirection ? { lighting: plan.visualDirection.palette, temperature: plan.visualDirection.temperature } : {}) }),
    'Coordinate this object with those material families and surroundings. Lighting colors describe illumination, not object paint. Preserve material identity and natural light/dark variation; reserve accents for small intentional details. Explicit user-requested part colors take priority. These are continuous color relationships, not a restricted swatch list: do not quantize or snap colors. Tag the actual material of each part so the scene render rules can address it.'
  ].join('\n');
}
