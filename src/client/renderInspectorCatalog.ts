import type { RenderModuleId } from '../shared/renderPlan';

export type RenderInspectorCategoryId =
  | 'lighting'
  | 'style'
  | 'post'
  | 'environment'
  | 'water'
  | 'materials';

export interface RenderInspectorCategory {
  id: RenderInspectorCategoryId;
  label: string;
  description: string;
  moduleIds: readonly RenderModuleId[];
}

/**
 * Keep the host panel vocabulary aligned with Scene Builder. WorldForge adds a
 * material/effect category because those controls are scoped to generated map
 * assets rather than to the renderer as a whole.
 */
export const RENDER_INSPECTOR_CATEGORIES: readonly RenderInspectorCategory[] = [
  {
    id: 'lighting',
    label: '光照',
    description: '环境光、太阳光和命名灯光配方',
    moduleIds: ['lighting.hemisphere', 'lighting.sun', 'runtime.light-rig']
  },
  {
    id: 'style',
    label: '风格',
    description: '表面、描边、画面表现和色彩分级',
    moduleIds: [
      'runtime.surface-style',
      'runtime.outline-style',
      'runtime.presentation-style',
      'runtime.color-grade'
    ]
  },
  {
    id: 'post',
    label: '后期',
    description: '曝光和后处理质量',
    moduleIds: ['presentation.exposure', 'runtime.post-quality']
  },
  {
    id: 'environment',
    label: '环境',
    description: '天空、天气、环境色、距离雾和草地表现',
    moduleIds: ['environment.palette', 'environment.hdri', 'atmosphere.fog', 'runtime.weather', 'runtime.atmosphere-fx', 'runtime.grass-style']
  },
  {
    id: 'water',
    label: '水体',
    description: '湖泊与河流的颜色、波纹、泡沫和反射',
    moduleIds: ['runtime.water-style']
  },
  {
    id: 'materials',
    label: '材质',
    description: '地表细节与按标签应用的材质、特效和隔离 Shader 扩展',
    moduleIds: ['runtime.terrain-materials', 'runtime.material-theme', 'runtime.effect-recipe', 'runtime.shader-extension']
  }
] as const;

export function renderInspectorCategory(id: string): RenderInspectorCategory {
  return RENDER_INSPECTOR_CATEGORIES.find((category) => category.id === id)
    ?? RENDER_INSPECTOR_CATEGORIES[0];
}
