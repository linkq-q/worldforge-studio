import { createId } from './map';
import {
  createDefaultRenderAccessPolicy,
  normalizeRenderAccessPolicy,
  normalizeRenderPlan,
  type RenderAccessPolicy,
  type RenderPlan
} from './renderPlan';

export interface RenderEnvironmentSettings {
  background: string;
  fogColor: string;
  fogDensity: number;
  hemisphereSkyColor: string;
  hemisphereGroundColor: string;
  hemisphereIntensity: number;
  sunColor: string;
  sunIntensity: number;
  exposure: number;
}

export interface RenderScheme {
  id: string;
  name: string;
  description: string;
  sourcePrompt: string;
  styleTags: string[];
  provider?: string;
  renderPlan?: RenderPlan;
  accessPolicy: RenderAccessPolicy;
  schemaVersion: 1;
  kind: 'builtin' | 'custom';
  settings: RenderEnvironmentSettings;
  createdAt: number;
  updatedAt: number;
}

export interface RenderSuggestion {
  baseSchemeId: string;
  settings: Partial<RenderScheme['settings']>;
  styleTags: string[];
  explanation: string;
  plan: RenderPlan;
}

export const BUILTIN_RENDER_SCHEMES: readonly RenderScheme[] = [
  builtinScheme('render-natural-day', '自然日光', '清晰、中性的日间光照，适合继续编辑地图。', {
    background: '#9cc7d5',
    fogColor: '#9cc7d5',
    fogDensity: 0.004,
    hemisphereSkyColor: '#eaf6ff',
    hemisphereGroundColor: '#30382f',
    hemisphereIntensity: 1.6,
    sunColor: '#fff0ce',
    sunIntensity: 2.5,
    exposure: 1
  }),
  builtinScheme('render-morning-mist', '薄雾晨光', '低对比度的冷色晨雾，适合田园和森林场景。', {
    background: '#a8bec0',
    fogColor: '#b9c9c5',
    fogDensity: 0.018,
    hemisphereSkyColor: '#dceff1',
    hemisphereGroundColor: '#3b4740',
    hemisphereIntensity: 1.35,
    sunColor: '#ffe1ad',
    sunIntensity: 1.7,
    exposure: 0.94
  }),
  builtinScheme('render-golden-hour', '金色黄昏', '暖色主光和轻微雾化，突出轮廓与空间层次。', {
    background: '#8e6f69',
    fogColor: '#b58a71',
    fogDensity: 0.011,
    hemisphereSkyColor: '#d5a47f',
    hemisphereGroundColor: '#352f32',
    hemisphereIntensity: 1.15,
    sunColor: '#ffb45c',
    sunIntensity: 3.1,
    exposure: 1.08
  }),
  builtinScheme('render-moonlit-night', '月夜', '冷色低照度环境，用于夜景氛围预览。', {
    background: '#101a2d',
    fogColor: '#18243a',
    fogDensity: 0.009,
    hemisphereSkyColor: '#728bb8',
    hemisphereGroundColor: '#101521',
    hemisphereIntensity: 0.72,
    sunColor: '#b9d2ff',
    sunIntensity: 1.25,
    exposure: 0.78
  }),
  builtinScheme('render-runtime-cel-day', '卡通日光', '使用 Voxel Render Runtime 的色阶卡通明暗，适合低多边形场景。', {
    background: '#a9d3df',
    fogColor: '#b8d6d9',
    fogDensity: 0.006,
    hemisphereSkyColor: '#edf9ff',
    hemisphereGroundColor: '#39483b',
    hemisphereIntensity: 1.55,
    sunColor: '#fff0c7',
    sunIntensity: 2.7,
    exposure: 1
  }, {
    version: 1,
    baseSchemeId: 'render-runtime-cel-day',
    modules: [{
      id: 'runtime.surface-style',
      params: {
        mode: 'cel',
        bands: 4,
        shadowFloor: 0.34,
        highlightFactor: 1.05,
        rampStrength: 0.88,
        transitionSoftness: 0.16
      }
    }]
  }),
  builtinScheme('render-runtime-sketch-mist', '淡彩素描晨雾', '程序化交叉排线与柔和晨雾，保留少量原始色彩。', {
    background: '#c9d2cf',
    fogColor: '#d7ddd8',
    fogDensity: 0.019,
    hemisphereSkyColor: '#e8efec',
    hemisphereGroundColor: '#555b55',
    hemisphereIntensity: 1.2,
    sunColor: '#f5e8cf',
    sunIntensity: 1.55,
    exposure: 0.93
  }, {
    version: 1,
    baseSchemeId: 'render-runtime-sketch-mist',
    modules: [
      {
        id: 'runtime.outline-style',
        params: {
          mode: 'ink',
          strength: 0.9,
          width: 1.35,
          color: '#34363d',
          noiseStrength: 0.16,
          strokeVariation: 0.45
        }
      },
      {
        id: 'runtime.presentation-style',
        params: {
          mode: 'sketch',
          coordinateSpace: 'world',
          worldScale: 3.5,
          strength: 0.72,
          hatchSpacing: 7,
          hatchAngle: 35,
          lineWidth: 0.16,
          jitter: 0.18,
          colorMode: 'color',
          toneStrength: 0.5,
          darkFill: 0.4,
          break: 0.1,
          lineColor: '#34363d',
          paperColor: '#f4f0e6',
          paperStrength: 0.12,
          paperScale: 2,
          paperTint: '#f4f0e6'
        }
      }
    ]
  }),
  builtinScheme('render-runtime-comic-clean', '清线漫画', '干净的共享轮廓与克制的漫画印刷处理，保留原有色彩层次。', {
    background: '#a9d3df',
    fogColor: '#b8d6d9',
    fogDensity: 0.006,
    hemisphereSkyColor: '#edf9ff',
    hemisphereGroundColor: '#39483b',
    hemisphereIntensity: 1.55,
    sunColor: '#fff0c7',
    sunIntensity: 2.7,
    exposure: 1
  }, {
    version: 1,
    baseSchemeId: 'render-runtime-comic-clean',
    modules: [
      {
        id: 'runtime.surface-style',
        params: { mode: 'cel', bands: 4, rampStrength: 0.82, transitionSoftness: 0.16 }
      },
      {
        id: 'runtime.outline-style',
        params: { mode: 'clean', strength: 1, width: 1.25, color: '#171824' }
      },
      {
        id: 'runtime.presentation-style',
        params: { mode: 'comic-clean' }
      }
    ]
  }),
  builtinScheme('render-runtime-comic-print', '套色漫画', '共享轮廓、克制网点和轻微套印偏移组成的印刷漫画效果。', {
    background: '#d5d0c2',
    fogColor: '#d5d0c2',
    fogDensity: 0.004,
    hemisphereSkyColor: '#fff5df',
    hemisphereGroundColor: '#4a443c',
    hemisphereIntensity: 1.45,
    sunColor: '#ffe2a3',
    sunIntensity: 2.6,
    exposure: 0.98
  }, {
    version: 1,
    baseSchemeId: 'render-runtime-comic-print',
    modules: [
      {
        id: 'runtime.surface-style',
        params: { mode: 'cel', bands: 4, rampStrength: 0.84, transitionSoftness: 0.14 }
      },
      {
        id: 'runtime.outline-style',
        params: { mode: 'clean', strength: 1, width: 1.25, color: '#17131c' }
      },
      {
        id: 'runtime.presentation-style',
        params: { mode: 'comic-print' }
      }
    ]
  })
];

export function createRenderScheme(input: Partial<RenderScheme>): RenderScheme {
  const now = Date.now();
  return normalizeRenderScheme({
    ...input,
    id: createId('render'),
    kind: 'custom',
    createdAt: now,
    updatedAt: now
  });
}

export function normalizeRenderScheme(input: Partial<RenderScheme>): RenderScheme {
  const fallback = BUILTIN_RENDER_SCHEMES[0]?.settings ?? defaultSettings();
  const now = Date.now();
  const accessPolicy = normalizeRenderAccessPolicy(input.accessPolicy);
  return {
    id: cleanText(input.id, createId('render'), 80),
    name: cleanText(input.name, '未命名渲染方案', 48),
    description: cleanText(input.description, '', 160),
    sourcePrompt: cleanText(input.sourcePrompt, '', 1000),
    styleTags: normalizeStyleTags(input.styleTags),
    provider: cleanText(input.provider, '', 40) || undefined,
    renderPlan: safeRenderPlan(input.renderPlan),
    accessPolicy,
    schemaVersion: 1,
    kind: input.kind === 'builtin' ? 'builtin' : 'custom',
    settings: normalizeSettings(input.settings, fallback),
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}

function safeRenderPlan(value: unknown): RenderPlan | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeRenderPlan(value);
  } catch {
    return undefined;
  }
}

function builtinScheme(
  id: string,
  name: string,
  description: string,
  settings: RenderEnvironmentSettings,
  renderPlan?: RenderPlan
): RenderScheme {
  return {
    id,
    name,
    description,
    sourcePrompt: '',
    styleTags: [],
    renderPlan,
    accessPolicy: createDefaultRenderAccessPolicy(),
    schemaVersion: 1,
    kind: 'builtin',
    settings,
    createdAt: 0,
    updatedAt: 0
  };
}

function normalizeSettings(
  input: Partial<RenderEnvironmentSettings> | undefined,
  fallback: RenderEnvironmentSettings
): RenderEnvironmentSettings {
  return {
    background: color(input?.background, fallback.background),
    fogColor: color(input?.fogColor, fallback.fogColor),
    fogDensity: clamp(finiteNumber(input?.fogDensity, fallback.fogDensity), 0, 0.08),
    hemisphereSkyColor: color(input?.hemisphereSkyColor, fallback.hemisphereSkyColor),
    hemisphereGroundColor: color(input?.hemisphereGroundColor, fallback.hemisphereGroundColor),
    hemisphereIntensity: clamp(finiteNumber(input?.hemisphereIntensity, fallback.hemisphereIntensity), 0, 8),
    sunColor: color(input?.sunColor, fallback.sunColor),
    sunIntensity: clamp(finiteNumber(input?.sunIntensity, fallback.sunIntensity), 0, 12),
    exposure: clamp(finiteNumber(input?.exposure, fallback.exposure), 0.2, 3)
  };
}

function defaultSettings(): RenderEnvironmentSettings {
  return {
    background: '#9cc7d5',
    fogColor: '#9cc7d5',
    fogDensity: 0.004,
    hemisphereSkyColor: '#eaf6ff',
    hemisphereGroundColor: '#30382f',
    hemisphereIntensity: 1.6,
    sunColor: '#fff0ce',
    sunIntensity: 2.5,
    exposure: 1
  };
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function normalizeStyleTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, 24))
    .filter(Boolean))]
    .slice(0, 8);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
