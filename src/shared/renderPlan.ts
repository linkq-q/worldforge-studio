import type { RenderEnvironmentSettings } from './renderScheme';
import {
  compileVisualEnvironment,
  compileVisualWaterPalette,
  visualMaterialTint
} from './colorDirector';
import { compileVisualDirection, normalizeVisualDirection, type VisualDirection } from './visualDirection';

export type RenderModuleId =
  | 'environment.palette'
  | 'environment.hdri'
  | 'atmosphere.fog'
  | 'lighting.hemisphere'
  | 'lighting.sun'
  | 'presentation.exposure'
  | 'runtime.surface-style'
  | 'runtime.outline-style'
  | 'runtime.presentation-style'
  | 'runtime.color-grade'
  | 'runtime.water-style'
  | 'runtime.grass-style'
  | 'runtime.material-theme'
  | 'runtime.light-rig'
  | 'runtime.post-quality'
  | 'runtime.effect-recipe'
  | 'runtime.atmosphere-fx'
  | 'runtime.shader-extension';

export type RenderScopeTarget = 'scene' | 'water' | 'material-tag' | 'asset-tag';

export interface RenderModuleScope {
  target: RenderScopeTarget;
  tag?: string;
}

export interface RenderModuleSelection {
  key?: string;
  id: RenderModuleId;
  scope?: RenderModuleScope;
  params: Record<string, string | number>;
}

export interface RenderPlan {
  version: 1 | 2;
  baseSchemeId: string;
  modules: RenderModuleSelection[];
  visualDirection?: VisualDirection;
}

export type RenderControlType = 'range' | 'number' | 'select' | 'color' | 'toggle' | 'code';

export interface RenderCapability {
  id: RenderModuleId;
  label: string;
  priority?: 'P1' | 'P2' | 'P3' | 'pro';
  repeatable?: boolean;
  developerOnly?: boolean;
  availability?: 'ready' | 'limited' | 'unsupported';
  availabilityNote?: string;
  params: Record<string,
    | { type: 'color'; default?: string; control?: RenderControlType }
    | { type: 'number'; min: number; max: number; default?: number; control?: RenderControlType }
    | { type: 'enum'; values: readonly string[]; default?: string; control?: RenderControlType }
    | { type: 'code'; maxLength: number; default?: string; control?: RenderControlType }
  >;
}

export interface RenderAccessRange {
  enabled: boolean;
  min?: number;
  max?: number;
  values?: string[];
}

export interface RenderParameterAccess {
  moduleId: RenderModuleId;
  parameter: string;
  control: RenderControlType;
  ai: RenderAccessRange;
  developer: RenderAccessRange;
}

export interface RenderAccessPolicy {
  version: 1;
  parameters: RenderParameterAccess[];
}

export interface RuntimeSurfaceStyle {
  mode: 'pbr' | 'cel';
  cartoon: Partial<{
    bands: number;
    shadowFloor: number;
    highlightFactor: number;
    rampStrength: number;
    transitionSoftness: number;
  }>;
}

export interface RuntimeOutlineStyle {
  mode: 'none' | 'clean' | 'ink' | 'echo' | 'curvature';
  params: Partial<{
    strength: number;
    threshold: number;
    width: number;
    color: string;
    depthWeight: number;
    normalWeight: number;
    objectWeight: number;
    materialWeight: number;
    noiseStrength: number;
    strokeVariation: number;
    echoCount: number;
    echoSpacing: number;
    echoAngle: number;
    echoStrength: number;
    echoColor: string;
    fadeStart: number;
    fadeEnd: number;
  }>;
}

export interface RuntimePresentationStyle {
  mode: 'none' | 'sketch' | 'comic-clean' | 'comic-print';
  sketch: Partial<{
    coordinateSpace: 'world' | 'screen';
    worldScale: number;
    strength: number;
    hatchSpacing: number;
    hatchAngle: number;
    lineWidth: number;
    jitter: number;
    preserveColor: boolean;
    toneStrength: number;
    toneBias: number;
    denseSpacing: number;
    darkFill: number;
    break: number;
    lineColor: string;
    paperColor: string;
  }>;
  paper: Partial<{
    strength: number;
    scale: number;
    tint: string;
  }>;
  comic: Partial<{
    halftoneStrength: number;
    cellSize: number;
    printOffset: number;
    lineBoost: number;
    lineWidth: number;
    inkColor: string;
  }>;
}

export interface RuntimeColorGrade {
  recipe: 'neutral' | 'warm' | 'cool' | 'misty' | 'cinematic' | 'pastel';
  temperature?: number;
  contrast?: number;
  saturation?: number;
  shadowLift?: number;
  tint?: string;
}

export interface RuntimeWaterStyle {
  scope: RenderModuleScope;
  recipe: 'calm-lake' | 'clear-river' | 'stylized' | 'stormy';
  opacity?: number;
  color?: string;
  shallowColor?: string;
  depthColor?: string;
  foamColor?: string;
  waveStrength?: number;
  waveSpeed?: number;
  waveScale?: number;
  waveDirection?: number;
  waveSharpness?: number;
  foamStrength?: number;
  shoreFoamWidth?: number;
  shoreWaveRange?: number;
  shoreWaveFrequency?: number;
  shoreWaveWidth?: number;
  shoreWaveBreakup?: number;
  environmentReflectionStrength?: number;
  environmentReflectionExposure?: number;
}

export interface RuntimeGrassStyle {
  rootColor: string;
  tipColor: string;
  paletteVariation: number;
  bands: 2 | 3;
  bladeHeight: number;
  bladeWidth: number;
  windStrength: number;
  windDirection: [number, number];
  normalFlatten: number;
  rootDarken: number;
  gradientBias: number;
  cellSize: number;
  fadeStart: number;
  fadeEnd: number;
  maxInstances: number;
  groundTint: boolean;
  groundColor: string;
  groundTintStrength: number;
}

export const DEFAULT_RUNTIME_GRASS_STYLE: RuntimeGrassStyle = {
  rootColor: '#72ad49', tipColor: '#b7df76', paletteVariation: 0.1, bands: 3,
  bladeHeight: 0.95, bladeWidth: 0.18, windStrength: 0.22, windDirection: [1, 0.25],
  normalFlatten: 0.8, rootDarken: 0.8, gradientBias: 0.7, cellSize: 0.8,
  fadeStart: 72, fadeEnd: 140, maxInstances: 15000,
  groundTint: true, groundColor: '#669746', groundTintStrength: 0.82
};

export interface RuntimeMaterialTheme {
  key: string;
  scope: RenderModuleScope;
  recipe: 'natural' | 'autumn' | 'winter' | 'weathered' | 'polished' | 'pastel';
  strength?: number;
  color?: string;
  roughness?: number;
  metalness?: number;
}

export interface RuntimeLightRig {
  recipe: 'neutral' | 'soft-morning' | 'hard-day' | 'backlit' | 'overcast' | 'sunset';
  strength?: number;
  warmth?: number;
  shadowSoftness?: number;
}

export interface RuntimePostQuality {
  bloom: 'off' | 'soft' | 'strong';
  bloomStrength?: number;
  ssao: 'off' | 'soft' | 'strong';
  depthOfField: 'off' | 'soft' | 'portrait';
}

export interface RuntimeEffectRecipe {
  key: string;
  scope: RenderModuleScope;
  recipe: 'glow' | 'fresnel' | 'flame' | 'magic' | 'aura' | 'sway';
  intensity?: number;
  speed?: number;
  color?: string;
}

export interface RuntimeHdriSky {
  /** Empty means "no HDRI"; the scheme's solid background stays in charge. */
  texture: string;
  rotation: number;
  exposure: number;
  saturation: number;
  intensity: number;
  tint?: string;
  tintStrength: number;
  /** Also feed the panorama to `scene.environment` through PMREM. */
  useAsEnvironment: boolean;
}

export interface RuntimeShaderExtension {
  mode: 'off' | 'whitelist-fragment' | 'isolated-glsl';
  fragmentId?: string;
  code?: string;
}

export const RENDER_CAPABILITIES: readonly RenderCapability[] = [
  {
    id: 'environment.palette',
    label: '环境色板',
    params: { background: { type: 'color' }, fogColor: { type: 'color' } }
  },
  {
    id: 'environment.hdri',
    label: 'HDRI 天空',
    priority: 'P1',
    availability: 'ready',
    availabilityNote: '贴图取自 data/map-editor/hdri 目录，同时作为背景天空球与 PMREM 环境光。',
    params: {
      // ponytail: `code` type means "free string, developer only" — exactly the
      // access rule wanted here, so the AI cannot invent a filename.
      texture: { type: 'code', maxLength: 120, default: '', control: 'select' },
      rotation: { type: 'number', min: -180, max: 180, default: 0 },
      exposure: { type: 'number', min: 0.05, max: 4, default: 1 },
      saturation: { type: 'number', min: 0, max: 2, default: 1 },
      intensity: { type: 'number', min: 0, max: 4, default: 1 },
      tint: { type: 'color', default: '#ffffff' },
      tintStrength: { type: 'number', min: 0, max: 1, default: 0 },
      useAsEnvironment: { type: 'enum', values: ['on', 'off'], default: 'on' }
    }
  },
  {
    id: 'atmosphere.fog',
    label: '全局雾',
    params: {
      visibilityDistance: { type: 'number', min: 40, max: 800, default: 300 },
      density: { type: 'number', min: 0, max: 0.045, default: 0.006 }
    }
  },
  {
    id: 'lighting.hemisphere',
    label: '环境光',
    params: {
      skyColor: { type: 'color' },
      groundColor: { type: 'color' },
      intensity: { type: 'number', min: 0, max: 8 }
    }
  },
  {
    id: 'lighting.sun',
    label: '太阳光',
    params: { color: { type: 'color' }, intensity: { type: 'number', min: 0, max: 12 } }
  },
  {
    id: 'presentation.exposure',
    label: '画面曝光',
    params: { value: { type: 'number', min: 0.2, max: 3 } }
  },
  {
    id: 'runtime.surface-style',
    label: 'Runtime 表面风格',
    params: {
      mode: { type: 'enum', values: ['pbr', 'cel'] },
      bands: { type: 'number', min: 2, max: 8 },
      shadowFloor: { type: 'number', min: 0.2, max: 0.6 },
      highlightFactor: { type: 'number', min: 0.5, max: 1.5 },
      rampStrength: { type: 'number', min: 0, max: 1 },
      transitionSoftness: { type: 'number', min: 0, max: 1 }
    }
  },
  {
    id: 'runtime.outline-style',
    label: 'Runtime 统一描边',
    params: {
      mode: { type: 'enum', values: ['none', 'clean', 'ink', 'echo', 'curvature'] },
      strength: { type: 'number', min: 0.25, max: 2 },
      threshold: { type: 'number', min: 0.02, max: 0.3 },
      width: { type: 'number', min: 0.5, max: 5 },
      color: { type: 'color' },
      depthWeight: { type: 'number', min: 0, max: 2 },
      normalWeight: { type: 'number', min: 0, max: 2 },
      objectWeight: { type: 'number', min: 0, max: 2 },
      materialWeight: { type: 'number', min: 0, max: 2 },
      noiseStrength: { type: 'number', min: 0, max: 0.8 },
      strokeVariation: { type: 'number', min: 0, max: 1 },
      echoCount: { type: 'number', min: 0, max: 3 },
      echoSpacing: { type: 'number', min: 1, max: 6 },
      echoAngle: { type: 'number', min: -180, max: 180 },
      echoStrength: { type: 'number', min: 0, max: 1 },
      echoColor: { type: 'color' },
      fadeStart: { type: 'number', min: 20, max: 400, default: 120 },
      fadeEnd: { type: 'number', min: 30, max: 600, default: 260 }
    }
  },
  {
    id: 'runtime.presentation-style',
    label: 'Runtime 画面风格',
    params: {
      mode: { type: 'enum', values: ['none', 'sketch', 'comic-clean', 'comic-print'] },
      coordinateSpace: { type: 'enum', values: ['world', 'screen'] },
      worldScale: { type: 'number', min: 0.25, max: 12 },
      strength: { type: 'number', min: 0.25, max: 1 },
      hatchSpacing: { type: 'number', min: 3, max: 16 },
      hatchAngle: { type: 'number', min: 0, max: 180 },
      lineWidth: { type: 'number', min: 0.08, max: 0.5 },
      jitter: { type: 'number', min: 0, max: 0.5 },
      colorMode: { type: 'enum', values: ['color', 'monochrome'] },
      toneStrength: { type: 'number', min: 0, max: 1 },
      toneBias: { type: 'number', min: -0.5, max: 0.5 },
      denseSpacing: { type: 'number', min: 0.15, max: 1 },
      darkFill: { type: 'number', min: 0, max: 1 },
      break: { type: 'number', min: 0, max: 0.6 },
      lineColor: { type: 'color' },
      paperColor: { type: 'color' },
      paperStrength: { type: 'number', min: 0, max: 0.5 },
      paperScale: { type: 'number', min: 0.5, max: 8 },
      paperTint: { type: 'color' },
      halftoneStrength: { type: 'number', min: 0, max: 0.7 },
      halftoneCellSize: { type: 'number', min: 3, max: 16 },
      printOffset: { type: 'number', min: 0, max: 1 },
      comicLineBoost: { type: 'number', min: 0, max: 0.6 },
      comicLineWidth: { type: 'number', min: 0.5, max: 4 },
      comicInkColor: { type: 'color' }
    }
  },
  {
    id: 'runtime.color-grade',
    label: '色彩分级',
    priority: 'P1',
    availability: 'ready',
    params: {
      recipe: {
        type: 'enum',
        values: ['neutral', 'warm', 'cool', 'misty', 'cinematic', 'pastel'],
        default: 'neutral'
      },
      temperature: { type: 'number', min: -1, max: 1, default: 0 },
      contrast: { type: 'number', min: 0.5, max: 1.6, default: 1 },
      saturation: { type: 'number', min: 0, max: 1.8, default: 1 },
      shadowLift: { type: 'number', min: 0, max: 0.35, default: 0 },
      tint: { type: 'color', default: '#ffffff' }
    }
  },
  {
    id: 'runtime.water-style',
    label: '水体风格',
    priority: 'P1',
    repeatable: true,
    availability: 'ready',
    availabilityNote: '作用于结构化湖泊/河流和带 water 标签的模型水面。',
    params: {
      recipe: {
        type: 'enum',
        values: ['calm-lake', 'clear-river', 'stylized', 'stormy'],
        default: 'calm-lake'
      },
      opacity: { type: 'number', min: 0.25, max: 1, default: 0.62 },
      color: { type: 'color', default: '#347f7c' },
      shallowColor: { type: 'color', default: '#67aaa0' },
      depthColor: { type: 'color', default: '#173f49' },
      foamColor: { type: 'color', default: '#ffffff' },
      waveStrength: { type: 'number', min: 0, max: 1.5, default: 0.35 },
      waveSpeed: { type: 'number', min: 0, max: 2, default: 0.3 },
      waveScale: { type: 'number', min: 0.25, max: 4, default: 1.3 },
      waveDirection: { type: 'number', min: -180, max: 180, default: 28 },
      waveSharpness: { type: 'number', min: 0.5, max: 4, default: 2.1 },
      foamStrength: { type: 'number', min: 0, max: 1.5, default: 0.45 },
      shoreFoamWidth: { type: 'number', min: 0.02, max: 0.25, default: 0.06 },
      shoreWaveRange: { type: 'number', min: 0.12, max: 1, default: 0.44 },
      shoreWaveFrequency: { type: 'number', min: 1, max: 16, default: 6 },
      shoreWaveWidth: { type: 'number', min: 0.1, max: 0.9, default: 0.5 },
      shoreWaveBreakup: { type: 'number', min: 0, max: 0.8, default: 0.39 },
      environmentReflectionStrength: { type: 'number', min: 0, max: 1, default: 0.22 },
      environmentReflectionExposure: { type: 'number', min: 0.1, max: 1.5, default: 0.5 }
    }
  },
  {
    id: 'runtime.grass-style',
    label: '卡通草地风格',
    priority: 'P1',
    availability: 'ready',
    availabilityNote: '草地分布属于地图；这里调整所有草层的叶片、风与远景地表染色。',
    params: {
      rootColor: { type: 'color', default: DEFAULT_RUNTIME_GRASS_STYLE.rootColor },
      tipColor: { type: 'color', default: DEFAULT_RUNTIME_GRASS_STYLE.tipColor },
      paletteVariation: { type: 'number', min: 0, max: 0.5, default: DEFAULT_RUNTIME_GRASS_STYLE.paletteVariation },
      bands: { type: 'enum', values: ['2', '3'], default: '3' },
      bladeHeight: { type: 'number', min: 0.5, max: 1.4, default: DEFAULT_RUNTIME_GRASS_STYLE.bladeHeight },
      bladeWidth: { type: 'number', min: 0.1, max: 0.28, default: DEFAULT_RUNTIME_GRASS_STYLE.bladeWidth },
      windStrength: { type: 'number', min: 0, max: 0.65, default: DEFAULT_RUNTIME_GRASS_STYLE.windStrength },
      windAngle: { type: 'number', min: -180, max: 180, default: 14 },
      normalFlatten: { type: 'number', min: 0, max: 1, default: DEFAULT_RUNTIME_GRASS_STYLE.normalFlatten },
      rootDarken: { type: 'number', min: 0.15, max: 1, default: DEFAULT_RUNTIME_GRASS_STYLE.rootDarken },
      gradientBias: { type: 'number', min: 0.2, max: 2, default: DEFAULT_RUNTIME_GRASS_STYLE.gradientBias },
      cellSize: { type: 'number', min: 0.55, max: 1.4, default: DEFAULT_RUNTIME_GRASS_STYLE.cellSize },
      fadeStart: { type: 'number', min: 10, max: 120, default: DEFAULT_RUNTIME_GRASS_STYLE.fadeStart },
      fadeEnd: { type: 'number', min: 15, max: 180, default: DEFAULT_RUNTIME_GRASS_STYLE.fadeEnd },
      maxInstances: { type: 'number', min: 1000, max: 30000, default: DEFAULT_RUNTIME_GRASS_STYLE.maxInstances },
      groundTint: { type: 'enum', values: ['on', 'off'], default: 'on', control: 'toggle' },
      groundColor: { type: 'color', default: DEFAULT_RUNTIME_GRASS_STYLE.groundColor },
      groundTintStrength: { type: 'number', min: 0, max: 1, default: DEFAULT_RUNTIME_GRASS_STYLE.groundTintStrength }
    }
  },
  {
    id: 'runtime.material-theme',
    label: '标签材质主题',
    priority: 'P1',
    repeatable: true,
    availability: 'ready',
    params: {
      recipe: {
        type: 'enum',
        values: ['natural', 'autumn', 'winter', 'weathered', 'polished', 'pastel'],
        default: 'natural'
      },
      strength: { type: 'number', min: 0, max: 1, default: 1 },
      color: { type: 'color', default: '#ffffff' },
      roughness: { type: 'number', min: 0, max: 1, default: 0.72 },
      metalness: { type: 'number', min: 0, max: 1, default: 0.04 }
    }
  },
  {
    id: 'runtime.light-rig',
    label: '灯光配方',
    priority: 'P2',
    availability: 'ready',
    params: {
      recipe: {
        type: 'enum',
        values: ['neutral', 'soft-morning', 'hard-day', 'backlit', 'overcast', 'sunset'],
        default: 'neutral'
      },
      strength: { type: 'number', min: 0.25, max: 2, default: 1 },
      warmth: { type: 'number', min: -1, max: 1, default: 0 },
      shadowSoftness: { type: 'number', min: 0, max: 1, default: 0.65 }
    }
  },
  {
    id: 'runtime.post-quality',
    label: '后处理质量',
    priority: 'P2',
    availability: 'limited',
    availabilityNote: 'Bloom 与 SSAO 已接通；景深保留高层契约，当前宿主暂不执行。',
    params: {
      bloom: { type: 'enum', values: ['off', 'soft', 'strong'], default: 'off' },
      bloomStrength: { type: 'number', min: 0, max: 1.5, default: 0.4 },
      ssao: { type: 'enum', values: ['off', 'soft', 'strong'], default: 'off' },
      depthOfField: { type: 'enum', values: ['off', 'soft', 'portrait'], default: 'off' }
    }
  },
  {
    id: 'runtime.atmosphere-fx',
    label: '环境动态特效',
    priority: 'P2',
    availability: 'ready',
    availabilityNote: '语义自动触发保持微弱；这里调节总量与各通道上限。',
    params: {
      masterStrength: { type: 'number', min: 0, max: 1, default: 0.35 },
      semanticStrength: { type: 'number', min: 0, max: 1, default: 1 },
      sunShafts: { type: 'number', min: 0, max: 1, default: 0 },
      pollen: { type: 'number', min: 0, max: 1, default: 0 },
      vapor: { type: 'number', min: 0, max: 1, default: 0 },
      dust: { type: 'number', min: 0, max: 1, default: 0 },
      sand: { type: 'number', min: 0, max: 1, default: 0 },
      windStreaks: { type: 'number', min: 0, max: 1, default: 0 }
    }
  },
  {
    id: 'runtime.effect-recipe',
    label: '标签特效配方',
    priority: 'P3',
    repeatable: true,
    availability: 'ready',
    params: {
      recipe: {
        type: 'enum',
        values: ['glow', 'fresnel', 'flame', 'magic', 'aura', 'sway'],
        default: 'glow'
      },
      intensity: { type: 'number', min: 0, max: 2.5, default: 1 },
      speed: { type: 'number', min: 0, max: 5, default: 1 },
      color: { type: 'color', default: '#88bbff' }
    }
  },
  {
    id: 'runtime.shader-extension',
    label: 'Shader 扩展',
    priority: 'pro',
    developerOnly: true,
    availability: 'limited',
    availabilityNote: '基础版 AI 禁止使用；完整 GLSL 仅保存为隔离扩展，不修改核心源码。',
    params: {
      mode: {
        type: 'enum',
        values: ['off', 'whitelist-fragment', 'isolated-glsl'],
        default: 'off'
      },
      fragmentId: {
        type: 'enum',
        values: ['rim-light', 'color-wash', 'vertex-sway'],
        default: 'rim-light'
      },
      code: { type: 'code', maxLength: 12000, default: '', control: 'code' }
    }
  }
];

const CAPABILITY_BY_ID = new Map(RENDER_CAPABILITIES.map((capability) => [capability.id, capability]));

export function normalizeRenderPlan(
  input: unknown,
  allowedBaseIds?: readonly string[],
  accessPolicy?: RenderAccessPolicy,
  actor: 'ai' | 'developer' = 'developer'
): RenderPlan {
  if (!input || typeof input !== 'object') throw new Error('invalid_render_plan');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== 2) throw new Error('unsupported_render_plan_version');
  const baseSchemeId = typeof raw.baseSchemeId === 'string' ? raw.baseSchemeId.trim() : '';
  if (!baseSchemeId) throw new Error('missing_render_base_scheme');
  if (allowedBaseIds && !allowedBaseIds.includes(baseSchemeId)) throw new Error('unknown_render_scheme');
  if (raw.modules !== undefined && !Array.isArray(raw.modules)) throw new Error('invalid_render_modules');

  const modules: RenderModuleSelection[] = [];
  const seen = new Set<string>();
  for (const item of (raw.modules as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== 'object') throw new Error('invalid_render_module');
    const moduleInput = item as Record<string, unknown>;
    const rawId = typeof moduleInput.id === 'string' ? moduleInput.id : '';
    const capability = CAPABILITY_BY_ID.get(rawId as RenderModuleId);
    if (!capability) throw new Error(`unknown_render_module:${rawId || 'missing'}`);
    if (actor === 'ai' && capability.developerOnly) {
      throw new Error(`render_module_forbidden:${capability.id}`);
    }
    const scope = normalizeScope(moduleInput.scope, capability);
    const key = cleanModuleKey(moduleInput.key, capability, scope, modules.length);
    const identity = capability.repeatable && raw.version === 2 ? key : capability.id;
    if (seen.has(identity)) throw new Error(`duplicate_render_module:${identity}`);
    seen.add(identity);
    modules.push({
      ...(capability.repeatable && raw.version === 2 ? { key } : {}),
      id: capability.id,
      ...(scope.target === 'scene' ? {} : { scope }),
      params: normalizeParams(moduleInput.params, capability, accessPolicy, actor)
    });
  }
  return {
    version: raw.version,
    baseSchemeId,
    modules,
    ...(raw.visualDirection === undefined ? {} : { visualDirection: normalizeVisualDirection(raw.visualDirection) })
  };
}

export function compileRenderPlan(plan: RenderPlan): Partial<RenderEnvironmentSettings> {
  const settings: Partial<RenderEnvironmentSettings> = plan.visualDirection
    ? compileVisualEnvironment(plan.visualDirection)
    : {};
  for (const module of plan.modules) {
    const params = module.params;
    switch (module.id) {
      case 'environment.palette':
        if (typeof params.background === 'string') settings.background = params.background;
        if (typeof params.fogColor === 'string') settings.fogColor = params.fogColor;
        break;
      case 'atmosphere.fog':
        if (typeof params.visibilityDistance === 'number') {
          settings.fogDensity = fogDensityForVisibilityDistance(params.visibilityDistance);
        } else if (typeof params.density === 'number') settings.fogDensity = params.density;
        break;
      case 'lighting.hemisphere':
        if (typeof params.skyColor === 'string') settings.hemisphereSkyColor = params.skyColor;
        if (typeof params.groundColor === 'string') settings.hemisphereGroundColor = params.groundColor;
        if (typeof params.intensity === 'number') settings.hemisphereIntensity = params.intensity;
        break;
      case 'lighting.sun':
        if (typeof params.color === 'string') settings.sunColor = params.color;
        if (typeof params.intensity === 'number') settings.sunIntensity = params.intensity;
        break;
      case 'presentation.exposure':
        if (typeof params.value === 'number') settings.exposure = params.value;
        break;
    }
  }
  return settings;
}

/** Density for 95% fog opacity at a user-facing visibility distance. */
export function fogDensityForVisibilityDistance(distance: number): number {
  const safeDistance = Math.max(1, Number.isFinite(distance) ? distance : 300);
  return Math.sqrt(-Math.log(0.05)) / safeDistance;
}

export function compileRuntimeStyle(plan: RenderPlan): RuntimeSurfaceStyle {
  const module = plan.modules.find((item) => item.id === 'runtime.surface-style');
  const params = module?.params ?? {};
  const cartoon: RuntimeSurfaceStyle['cartoon'] = plan.visualDirection
    ? { shadowFloor: compileVisualDirection(plan.visualDirection).surfaceShadowFloor }
    : {};
  for (const key of ['bands', 'shadowFloor', 'highlightFactor', 'rampStrength', 'transitionSoftness'] as const) {
    if (typeof params[key] === 'number') cartoon[key] = params[key];
  }
  return {
    mode: params.mode === 'cel' ? 'cel' : 'pbr',
    cartoon
  };
}

export function compileRuntimeOutline(plan: RenderPlan): RuntimeOutlineStyle {
  const module = plan.modules.find((item) => item.id === 'runtime.outline-style');
  const params = module?.params ?? {};
  const compiled: RuntimeOutlineStyle['params'] = {};
  for (const key of [
    'strength',
    'threshold',
    'width',
    'depthWeight',
    'normalWeight',
    'objectWeight',
    'materialWeight',
    'noiseStrength',
    'strokeVariation',
    'echoCount',
    'echoSpacing',
    'echoAngle',
    'echoStrength',
    'fadeStart',
    'fadeEnd'
  ] as const) {
    if (typeof params[key] === 'number') compiled[key] = params[key];
  }
  if (typeof params.color === 'string') compiled.color = params.color;
  if (typeof params.echoColor === 'string') compiled.echoColor = params.echoColor;
  const modes: RuntimeOutlineStyle['mode'][] = ['none', 'clean', 'ink', 'echo', 'curvature'];
  return {
    mode: modes.includes(params.mode as RuntimeOutlineStyle['mode'])
      ? params.mode as RuntimeOutlineStyle['mode']
      : 'none',
    params: compiled
  };
}

export function compileRuntimePresentation(plan: RenderPlan): RuntimePresentationStyle {
  const module = plan.modules.find((item) => item.id === 'runtime.presentation-style');
  const params = module?.params ?? {};
  const sketch: RuntimePresentationStyle['sketch'] = {};
  for (const key of [
    'worldScale',
    'strength',
    'hatchSpacing',
    'hatchAngle',
    'lineWidth',
    'jitter',
    'toneStrength',
    'toneBias',
    'denseSpacing',
    'darkFill',
    'break'
  ] as const) {
    if (typeof params[key] === 'number') sketch[key] = params[key];
  }
  if (params.coordinateSpace === 'world' || params.coordinateSpace === 'screen') {
    sketch.coordinateSpace = params.coordinateSpace;
  }
  if (typeof params.lineColor === 'string') sketch.lineColor = params.lineColor;
  if (typeof params.paperColor === 'string') sketch.paperColor = params.paperColor;
  if (params.colorMode === 'color' || params.colorMode === 'monochrome') {
    sketch.preserveColor = params.colorMode === 'color';
  }
  const paper: RuntimePresentationStyle['paper'] = {};
  if (typeof params.paperStrength === 'number') paper.strength = params.paperStrength;
  if (typeof params.paperScale === 'number') paper.scale = params.paperScale;
  if (typeof params.paperTint === 'string') paper.tint = params.paperTint;
  const comic: RuntimePresentationStyle['comic'] = {};
  if (typeof params.halftoneStrength === 'number') comic.halftoneStrength = params.halftoneStrength;
  if (typeof params.halftoneCellSize === 'number') comic.cellSize = params.halftoneCellSize;
  if (typeof params.printOffset === 'number') comic.printOffset = params.printOffset;
  if (typeof params.comicLineBoost === 'number') comic.lineBoost = params.comicLineBoost;
  if (typeof params.comicLineWidth === 'number') comic.lineWidth = params.comicLineWidth;
  if (typeof params.comicInkColor === 'string') comic.inkColor = params.comicInkColor;
  const modes: RuntimePresentationStyle['mode'][] = [
    'none',
    'sketch',
    'comic-clean',
    'comic-print'
  ];
  return {
    mode: modes.includes(params.mode as RuntimePresentationStyle['mode'])
      ? params.mode as RuntimePresentationStyle['mode']
      : 'none',
    sketch,
    paper,
    comic
  };
}

export function compileRuntimeColorGrade(plan: RenderPlan): RuntimeColorGrade {
  const params = plan.modules.find((item) => item.id === 'runtime.color-grade')?.params ?? {};
  const directed = plan.visualDirection ? compileVisualDirection(plan.visualDirection).colorGrade : undefined;
  return {
    recipe: enumValue(params.recipe, ['neutral', 'warm', 'cool', 'misty', 'cinematic', 'pastel'], 'neutral'),
    temperature: numericValue(params.temperature) ?? directed?.temperature,
    contrast: numericValue(params.contrast) ?? directed?.contrast,
    saturation: numericValue(params.saturation) ?? directed?.saturation,
    shadowLift: numericValue(params.shadowLift) ?? directed?.shadowLift,
    tint: stringValue(params.tint) ?? directed?.tint
  };
}

export function compileRuntimeWaterStyles(plan: RenderPlan): RuntimeWaterStyle[] {
  const directed = plan.visualDirection ? compileVisualWaterPalette(plan.visualDirection) : undefined;
  const modules = plan.modules
    .filter((item) => item.id === 'runtime.water-style')
  if (modules.length === 0 && directed) {
    return [{ scope: { target: 'water', tag: 'water' }, recipe: 'calm-lake', ...directed }];
  }
  return modules.map((item) => ({
      scope: item.scope ?? { target: 'water', tag: 'water' },
      recipe: enumValue(item.params.recipe, ['calm-lake', 'clear-river', 'stylized', 'stormy'], 'calm-lake'),
      opacity: numericValue(item.params.opacity),
      color: stringValue(item.params.color) ?? directed?.color,
      shallowColor: stringValue(item.params.shallowColor) ?? directed?.shallowColor,
      depthColor: stringValue(item.params.depthColor) ?? directed?.depthColor,
      foamColor: stringValue(item.params.foamColor),
      waveStrength: numericValue(item.params.waveStrength),
      waveSpeed: numericValue(item.params.waveSpeed),
      waveScale: numericValue(item.params.waveScale),
      waveDirection: numericValue(item.params.waveDirection),
      waveSharpness: numericValue(item.params.waveSharpness),
      foamStrength: numericValue(item.params.foamStrength),
      shoreFoamWidth: numericValue(item.params.shoreFoamWidth),
      shoreWaveRange: numericValue(item.params.shoreWaveRange),
      shoreWaveFrequency: numericValue(item.params.shoreWaveFrequency),
      shoreWaveWidth: numericValue(item.params.shoreWaveWidth),
      shoreWaveBreakup: numericValue(item.params.shoreWaveBreakup),
      environmentReflectionStrength: numericValue(item.params.environmentReflectionStrength),
      environmentReflectionExposure: numericValue(item.params.environmentReflectionExposure)
    }));
}

export function compileRuntimeGrassStyle(plan: RenderPlan): RuntimeGrassStyle {
  const params = plan.modules.find((item) => item.id === 'runtime.grass-style')?.params ?? {};
  const angle = (numericValue(params.windAngle) ?? 14) * Math.PI / 180;
  return {
    ...DEFAULT_RUNTIME_GRASS_STYLE,
    rootColor: stringValue(params.rootColor) ?? DEFAULT_RUNTIME_GRASS_STYLE.rootColor,
    tipColor: stringValue(params.tipColor) ?? DEFAULT_RUNTIME_GRASS_STYLE.tipColor,
    paletteVariation: numericValue(params.paletteVariation) ?? DEFAULT_RUNTIME_GRASS_STYLE.paletteVariation,
    bands: params.bands === '2' ? 2 : 3,
    bladeHeight: numericValue(params.bladeHeight) ?? DEFAULT_RUNTIME_GRASS_STYLE.bladeHeight,
    bladeWidth: numericValue(params.bladeWidth) ?? DEFAULT_RUNTIME_GRASS_STYLE.bladeWidth,
    windStrength: numericValue(params.windStrength) ?? DEFAULT_RUNTIME_GRASS_STYLE.windStrength,
    windDirection: [Math.cos(angle), Math.sin(angle)],
    normalFlatten: numericValue(params.normalFlatten) ?? DEFAULT_RUNTIME_GRASS_STYLE.normalFlatten,
    rootDarken: numericValue(params.rootDarken) ?? DEFAULT_RUNTIME_GRASS_STYLE.rootDarken,
    gradientBias: numericValue(params.gradientBias) ?? DEFAULT_RUNTIME_GRASS_STYLE.gradientBias,
    cellSize: numericValue(params.cellSize) ?? DEFAULT_RUNTIME_GRASS_STYLE.cellSize,
    fadeStart: numericValue(params.fadeStart) ?? DEFAULT_RUNTIME_GRASS_STYLE.fadeStart,
    fadeEnd: numericValue(params.fadeEnd) ?? DEFAULT_RUNTIME_GRASS_STYLE.fadeEnd,
    maxInstances: numericValue(params.maxInstances) ?? DEFAULT_RUNTIME_GRASS_STYLE.maxInstances,
    groundTint: params.groundTint !== 'off',
    groundColor: stringValue(params.groundColor) ?? DEFAULT_RUNTIME_GRASS_STYLE.groundColor,
    groundTintStrength: numericValue(params.groundTintStrength) ?? DEFAULT_RUNTIME_GRASS_STYLE.groundTintStrength
  };
}

export function compileRuntimeMaterialThemes(plan: RenderPlan): RuntimeMaterialTheme[] {
  return plan.modules
    .filter((item) => item.id === 'runtime.material-theme')
    .map((item, index) => {
      const scope = item.scope ?? { target: 'material-tag' as const, tag: 'base' };
      const directed = plan.visualDirection ? visualMaterialTint(plan.visualDirection, scope.tag) : undefined;
      return {
        key: item.key ?? `material-theme-${index}`,
        scope,
        recipe: enumValue(item.params.recipe, ['natural', 'autumn', 'winter', 'weathered', 'polished', 'pastel'], 'natural'),
        strength: numericValue(item.params.strength) ?? directed?.strength,
        color: stringValue(item.params.color) ?? directed?.color,
        roughness: numericValue(item.params.roughness),
        metalness: numericValue(item.params.metalness)
      };
    });
}

export function compileRuntimeLightRig(plan: RenderPlan): RuntimeLightRig {
  const params = plan.modules.find((item) => item.id === 'runtime.light-rig')?.params ?? {};
  const directed = plan.visualDirection ? compileVisualDirection(plan.visualDirection).lightRig : undefined;
  return {
    recipe: enumValue(params.recipe, ['neutral', 'soft-morning', 'hard-day', 'backlit', 'overcast', 'sunset'], directed?.recipe ?? 'neutral'),
    strength: numericValue(params.strength) ?? directed?.strength,
    warmth: numericValue(params.warmth) ?? directed?.warmth,
    shadowSoftness: numericValue(params.shadowSoftness) ?? directed?.shadowSoftness
  };
}

export function compileRuntimePostQuality(plan: RenderPlan): RuntimePostQuality {
  const params = plan.modules.find((item) => item.id === 'runtime.post-quality')?.params ?? {};
  return {
    bloom: enumValue(params.bloom, ['off', 'soft', 'strong'], 'off'),
    bloomStrength: numericValue(params.bloomStrength),
    ssao: enumValue(params.ssao, ['off', 'soft', 'strong'], 'off'),
    depthOfField: enumValue(params.depthOfField, ['off', 'soft', 'portrait'], 'off')
  };
}

export function compileRuntimeEffectRecipes(plan: RenderPlan): RuntimeEffectRecipe[] {
  return plan.modules
    .filter((item) => item.id === 'runtime.effect-recipe')
    .map((item, index) => ({
      key: item.key ?? `effect-recipe-${index}`,
      scope: item.scope ?? { target: 'material-tag', tag: 'emissive' },
      recipe: enumValue(item.params.recipe, ['glow', 'fresnel', 'flame', 'magic', 'aura', 'sway'], 'glow'),
      intensity: numericValue(item.params.intensity),
      speed: numericValue(item.params.speed),
      color: stringValue(item.params.color)
    }));
}

export function compileRuntimeHdriSky(plan: RenderPlan): RuntimeHdriSky {
  const params = plan.modules.find((item) => item.id === 'environment.hdri')?.params ?? {};
  return {
    texture: stringValue(params.texture)?.trim() ?? '',
    rotation: numericValue(params.rotation) ?? 0,
    exposure: numericValue(params.exposure) ?? 1,
    saturation: numericValue(params.saturation) ?? 1,
    intensity: numericValue(params.intensity) ?? 1,
    tint: stringValue(params.tint),
    tintStrength: numericValue(params.tintStrength) ?? 0,
    useAsEnvironment: params.useAsEnvironment !== 'off'
  };
}

export function compileRuntimeShaderExtension(plan: RenderPlan): RuntimeShaderExtension {
  const params = plan.modules.find((item) => item.id === 'runtime.shader-extension')?.params ?? {};
  return {
    mode: enumValue(params.mode, ['off', 'whitelist-fragment', 'isolated-glsl'], 'off'),
    fragmentId: stringValue(params.fragmentId),
    code: stringValue(params.code)
  };
}

export function createDefaultRenderAccessPolicy(): RenderAccessPolicy {
  return {
    version: 1,
    parameters: RENDER_CAPABILITIES.flatMap((capability) => Object.entries(capability.params).map(([parameter, rule]) => {
      const control = rule.control ?? (
        rule.type === 'number' ? 'range'
          : rule.type === 'enum' ? 'select'
            : rule.type === 'color' ? 'color'
              : 'code'
      );
      const range: RenderAccessRange = {
        enabled: !capability.developerOnly
          && !(capability.id === 'runtime.post-quality' && parameter === 'depthOfField')
          && !(capability.id === 'runtime.outline-style' && ['fadeStart', 'fadeEnd'].includes(parameter))
          && !(capability.id === 'runtime.grass-style' && [
            'normalFlatten', 'rootDarken', 'gradientBias', 'cellSize', 'fadeStart', 'fadeEnd', 'maxInstances'
          ].includes(parameter)),
        ...(rule.type === 'number' ? { min: rule.min, max: rule.max } : {}),
        ...(rule.type === 'enum' ? { values: [...rule.values] } : {})
      };
      const aiMax = aiSafetyMaximum(capability.id, parameter);
      const aiRange = aiMax === undefined || range.max === undefined
        ? range
        : { ...range, max: Math.min(range.max, aiMax) };
      return {
        moduleId: capability.id,
        parameter,
        control,
        ai: { ...aiRange },
        developer: {
          ...range,
          enabled: true
        }
      };
    }))
  };
}

function aiSafetyMaximum(moduleId: RenderModuleId, parameter: string): number | undefined {
  const limits: Partial<Record<RenderModuleId, Record<string, number>>> = {
    'environment.hdri': { exposure: 1.5, intensity: 1.8 },
    'lighting.hemisphere': { intensity: 2.4 },
    'lighting.sun': { intensity: 5 },
    'presentation.exposure': { value: 1.5 },
    'runtime.water-style': {
      opacity: 0.78,
      environmentReflectionStrength: 0.35,
      environmentReflectionExposure: 0.7
    }
  };
  return limits[moduleId]?.[parameter];
}

export function normalizeRenderAccessPolicy(input: unknown): RenderAccessPolicy {
  const defaults = createDefaultRenderAccessPolicy();
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.parameters)) return defaults;
  const provided = new Map<string, Record<string, unknown>>();
  for (const item of raw.parameters) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.moduleId !== 'string' || typeof entry.parameter !== 'string') continue;
    provided.set(`${entry.moduleId}:${entry.parameter}`, entry);
  }
  return {
    version: 1,
    parameters: defaults.parameters.map((fallback) => {
      const entry = provided.get(`${fallback.moduleId}:${fallback.parameter}`);
      if (!entry) return fallback;
      const controls: RenderControlType[] = ['range', 'number', 'select', 'color', 'toggle', 'code'];
      return {
        ...fallback,
        control: controls.includes(entry.control as RenderControlType)
          ? entry.control as RenderControlType
          : fallback.control,
        ai: normalizeAccessRange(entry.ai, fallback.ai),
        developer: normalizeAccessRange(entry.developer, fallback.developer)
      };
    })
  };
}

export function renderCapabilitySummary(): unknown[] {
  return RENDER_CAPABILITIES.map((capability) => ({
    id: capability.id,
    label: capability.label,
    priority: capability.priority,
    repeatable: capability.repeatable === true,
    developerOnly: capability.developerOnly === true,
    availability: capability.availability ?? 'ready',
    availabilityNote: capability.availabilityNote,
    params: capability.params
  }));
}

export function renderModuleLabel(id: RenderModuleId): string {
  return CAPABILITY_BY_ID.get(id)?.label ?? id;
}

function normalizeParams(
  value: unknown,
  capability: RenderCapability,
  accessPolicy?: RenderAccessPolicy,
  actor: 'ai' | 'developer' = 'developer'
): Record<string, string | number> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object') throw new Error(`invalid_render_params:${capability.id}`);
  const input = value as Record<string, unknown>;
  const output: Record<string, string | number> = {};
  for (const key of Object.keys(input)) {
    const rule = capability.params[key];
    if (!rule) {
      if (isRetiredRenderParameter(capability.id, key)) continue;
      throw new Error(`unknown_render_parameter:${capability.id}.${key}`);
    }
    const access = accessPolicy?.parameters.find((entry) => (
      entry.moduleId === capability.id && entry.parameter === key
    ))?.[actor];
    if (access && !access.enabled) {
      if (actor === 'ai') continue;
      throw new Error(`render_parameter_forbidden:${capability.id}.${key}`);
    }
    if (rule.type === 'color') {
      if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) {
        throw new Error(`invalid_render_color:${capability.id}.${key}`);
      }
      output[key] = input[key];
      continue;
    }
    if (rule.type === 'enum') {
      const allowedValues = access?.values?.length
        ? rule.values.filter((item) => access.values?.includes(item))
        : rule.values;
      if (typeof input[key] !== 'string' || !allowedValues.includes(input[key])) {
        throw new Error(`invalid_render_enum:${capability.id}.${key}`);
      }
      output[key] = input[key];
      continue;
    }
    if (rule.type === 'code') {
      const candidate = input[key];
      const isApprovedAiLibraryValue = actor === 'ai'
        && typeof candidate === 'string'
        && (access?.values ?? []).includes(candidate);
      if ((actor !== 'developer' && !isApprovedAiLibraryValue) || typeof candidate !== 'string') {
        throw new Error(`invalid_render_code:${capability.id}.${key}`);
      }
      output[key] = candidate.slice(0, rule.maxLength);
      continue;
    }
    const number = Number(input[key]);
    if (!Number.isFinite(number)) throw new Error(`invalid_render_number:${capability.id}.${key}`);
    const min = Math.max(rule.min, access?.min ?? rule.min);
    const max = Math.min(rule.max, access?.max ?? rule.max);
    output[key] = Math.min(max, Math.max(min, number));
  }
  return output;
}

function isRetiredRenderParameter(moduleId: RenderModuleId, parameter: string): boolean {
  return moduleId === 'runtime.water-style'
    && ['reflectionStrength', 'reflectionDistortion', 'reflectionFresnel'].includes(parameter);
}

function normalizeScope(value: unknown, capability: RenderCapability): RenderModuleScope {
  const fallback: RenderModuleScope = capability.id === 'runtime.water-style'
    ? { target: 'water', tag: 'water' }
    : capability.repeatable
      ? { target: 'material-tag', tag: capability.id === 'runtime.effect-recipe' ? 'emissive' : 'base' }
      : { target: 'scene' };
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const targets: RenderScopeTarget[] = ['scene', 'water', 'material-tag', 'asset-tag'];
  const target = targets.includes(raw.target as RenderScopeTarget)
    ? raw.target as RenderScopeTarget
    : fallback.target;
  const tag = typeof raw.tag === 'string'
    ? raw.tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)
    : fallback.tag;
  if ((target === 'material-tag' || target === 'asset-tag') && !tag) {
    throw new Error(`missing_render_scope_tag:${capability.id}`);
  }
  return { target, ...(tag ? { tag } : {}) };
}

function cleanModuleKey(
  value: unknown,
  capability: RenderCapability,
  scope: RenderModuleScope,
  index: number
): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return clean || `${capability.id.replaceAll('.', '-')}-${scope.tag ?? scope.target}-${index}`;
}

function normalizeAccessRange(value: unknown, fallback: RenderAccessRange): RenderAccessRange {
  if (!value || typeof value !== 'object') return { ...fallback };
  const raw = value as Record<string, unknown>;
  const min = numericValue(raw.min);
  const max = numericValue(raw.max);
  const fallbackValues = fallback.values ?? [];
  const values = Array.isArray(raw.values)
    ? raw.values.filter((item): item is string => typeof item === 'string' && fallbackValues.includes(item))
    : fallback.values;
  const nextMin = min === undefined ? fallback.min : Math.max(fallback.min ?? min, min);
  const nextMax = max === undefined ? fallback.max : Math.min(fallback.max ?? max, max);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    ...(nextMin === undefined ? {} : { min: nextMin }),
    ...(nextMax === undefined ? {} : { max: Math.max(nextMin ?? nextMax, nextMax) }),
    ...(values === undefined ? {} : { values: [...values] })
  };
}

function numericValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}
