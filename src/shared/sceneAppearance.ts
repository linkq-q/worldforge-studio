import { normalizeRenderPlan, renderCapabilitySummary, type RenderPlan } from './renderPlan';
import { BUILTIN_RENDER_SCHEMES } from './renderScheme';
import { normalizeSceneArtConfig } from './sceneArt';

export interface SceneAppearancePlan {
  version: 1;
  intent: string;
  materials: Array<{ role: string; color: string; notes: string }>;
  renderPlan: RenderPlan;
}

const forbiddenModules = ['runtime.material-theme','runtime.surface-detail','runtime.shader-extension','runtime.local-light','runtime.wet-surface'];
const promptModuleIds = ['environment.palette','atmosphere.fog','lighting.hemisphere','lighting.sun','presentation.exposure','runtime.grass-style','runtime.water-style','runtime.terrain-materials'];
const appearanceCapabilities = renderCapabilitySummary().flatMap(value => {
  const capability = value as {id:string;params:Record<string,{type:string;min?:number;max?:number;values?:readonly string[]}>};
  if (!promptModuleIds.includes(capability.id)) return [];
  const policy = BUILTIN_RENDER_SCHEMES[0].accessPolicy;
  return [{id:capability.id,params:Object.fromEntries(Object.entries(capability.params).flatMap(([name,rule]) => {
    const access=policy.parameters.find(p => p.moduleId === capability.id && p.parameter === name)?.ai;
    if (!access?.enabled || (capability.id.startsWith('runtime.') && rule.type !== 'color' && !['strength','density','height','opacity'].includes(name))) return [];
    return [[name,rule.type === 'number' ? [access.min ?? rule.min,access.max ?? rule.max] : rule.type === 'enum' ? access.values ?? rule.values : '#rrggbb']];
  }))}];
});

export const SCENE_APPEARANCE_CONTRACT = `Scene appearance companion: {version:1,intent:string,materials:[{role:string,color:'#rrggbb',notes:string}],renderPlan:{version:1|2,baseSchemeId:existing built-in ID,modules:[{id,params}]}}. Choose continuous source colors by semantic material role together with environmental light and color. Explicit part colors take priority. Never quantize colors. Keep this companion outside map/world operations and geometry. No shaders, invented object/node/zone IDs, runtime.material-theme or runtime.surface-detail; generated source materials own asset colors. Numeric terrain/grass runtime.color-field scopes may be used without zone IDs. Use existing AI render capabilities and ranges. Built-in bases: ${BUILTIN_RENDER_SCHEMES.map(s => s.id).join(', ')}. Supported AI modules/parameters/ranges: ${JSON.stringify(appearanceCapabilities)}. runtime.color-field params.config is a JSON string {target:'terrain'|'grass'|'ground-and-grass',axis:'x'|'z'|'radial',center:[x,z],start:number,end:number greater than start,feather:0.01..20,strength:0..1,stops:[[0,'#rrggbb'],[1,'#rrggbb']]}; no zoneId.`;

export function normalizeSceneAppearancePlan(input: unknown): SceneAppearancePlan {
  const raw = object(input);
  if (raw.version !== 1 || Object.keys(raw).some(k => !['version','intent','materials','renderPlan'].includes(k))) throw new Error('invalid_scene_appearance');
  const intent = text(raw.intent, 2000);
  if (!Array.isArray(raw.materials) || raw.materials.length > 32) throw new Error('invalid_scene_appearance_materials');
  const seen = new Set<string>();
  const materials = raw.materials.map(value => {
    const item = object(value), role = text(item.role, 160);
    if (Object.keys(item).some(k => !['role','color','notes'].includes(k)) || seen.has(role.toLowerCase())) throw new Error('invalid_scene_appearance_material_role');
    seen.add(role.toLowerCase());
    if (typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)) throw new Error('invalid_scene_appearance_color');
    if (typeof item.notes !== 'string' || item.notes.length > 1000) throw new Error('invalid_scene_appearance_notes');
    return { role, color: item.color, notes: item.notes };
  });
  const renderInput = object(raw.renderPlan);
  if (Object.keys(renderInput).some(key => !['version','baseSchemeId','modules','visualDirection'].includes(key))) throw new Error('invalid_scene_appearance_render_plan');
  for (const value of Array.isArray(renderInput.modules) ? renderInput.modules : []) {
    const module = object(value);
    if (Object.keys(module).some(key => !['key','id','scope','params'].includes(key))) throw new Error('invalid_scene_appearance_render_module');
    if (module.scope !== undefined) {
      const scope = object(module.scope);
      if (Object.keys(scope).some(key => !['target','tag'].includes(key)) || !['scene','water','material-tag','asset-tag'].includes(String(scope.target))) throw new Error('invalid_scene_appearance_render_scope');
    }
  }
  const base = BUILTIN_RENDER_SCHEMES.find(s => s.id === renderInput.baseSchemeId);
  if (!base) throw new Error('unknown_render_scheme');
  const renderPlan = normalizeRenderPlan(renderInput, BUILTIN_RENDER_SCHEMES.map(s => s.id), base.accessPolicy, 'ai');
  if (renderPlan.visualDirection) {
    const direction = object(renderInput.visualDirection);
    for (const [key,value] of Object.entries(renderPlan.visualDirection)) {
      const authored = direction[key];
      if (value && typeof value === 'object') {
        const fields = object(authored);
        if (Object.keys(fields).length !== Object.keys(value).length || Object.entries(value).some(([field,expected]) => fields[field] !== expected)) throw new Error('invalid_scene_appearance_visual_direction');
      } else if (authored !== value) throw new Error('invalid_scene_appearance_visual_direction');
    }
    if (Object.keys(direction).length !== Object.keys(renderPlan.visualDirection).length) throw new Error('invalid_scene_appearance_visual_direction');
  }
  renderPlan.modules.forEach((module, i) => {
    if (forbiddenModules.includes(module.id)) throw new Error('scene_appearance_render_module_forbidden:'+module.id);
    if (module.id === 'runtime.color-field') {
      const config = normalizeSceneArtConfig(module.id, module.params.config);
      if ('zoneId' in config && config.zoneId) throw new Error('scene_appearance_unknown_zone');
    }
    // The editor normalizer clamps ranges and omits denied parameters; companions reject those inputs.
    const original = object((renderInput.modules as unknown[])[i]);
    for (const [key,value] of Object.entries(object(original.params ?? {}))) {
      if (!(key in module.params) || (key !== 'config' && key !== 'colorStops' && value !== module.params[key])) throw new Error('scene_appearance_render_parameter_invalid:'+module.id+'.'+key);
    }
  });
  return { version: 1, intent, materials, renderPlan };
}

export function sceneAppearanceBrief(plan: SceneAppearancePlan): string {
  return ['Scene appearance direction:', JSON.stringify(plan), 'Use the semantic material role colors as continuous source-color relationships. Preserve natural variation and material identity; explicit user-requested part colors take priority. Lighting colors describe illumination, not object paint. Do not quantize, snap colors or apply a second tint to generated materials.'].join('\n');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_scene_appearance');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_scene_appearance_text');
  return value.trim();
}
