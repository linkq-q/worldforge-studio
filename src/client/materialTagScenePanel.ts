import type { EditableMap, MapAsset } from '../shared/map';
import { materialTagSelector } from '../shared/materialTagPolicy';

export interface SceneMaterialTagOption {
  selector: string;
  label: string;
  affectedParts: number;
  enabled: boolean;
}

const MATERIAL_TAG_LABELS: Record<string, string> = {
  'base:fur': '毛绒',
  'base:wood': '木纹',
  'base:stone': '石材',
  'base:glass': '玻璃',
  'base:metal': '金属',
  'base:gold': '金色金属',
  'base:silver': '银色金属',
  foliage: '树冠材质',
  vegetation: '植物摆动',
  emissive: '自发光',
  fire: '火焰',
  smoke: '烟雾',
  electric: '电流',
  poison: '毒素',
  ice: '冰霜',
  wet: '湿润',
  rust: '锈蚀',
  mossy: '苔藓',
  dirty: '污渍',
  damage: '破损'
};

export function collectSceneMaterialTagOptions(
  map: EditableMap,
  assets: readonly MapAsset[]
): SceneMaterialTagOption[] {
  const instanceCounts = new Map<string, number>();
  for (const object of map.objects) {
    if (!object.visible || !object.assetId) continue;
    instanceCounts.set(object.assetId, (instanceCounts.get(object.assetId) ?? 0) + 1);
  }
  const affectedParts = new Map<string, number>();
  for (const asset of assets) {
    const instances = instanceCounts.get(asset.id) ?? 0;
    if (instances === 0) continue;
    const nodes = (asset.modelJson as { nodes?: unknown[] } | undefined)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const tags = (node as { tags?: unknown[] } | undefined)?.tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        const selector = materialTagSelector(tag);
        if (!selector) continue;
        affectedParts.set(selector, (affectedParts.get(selector) ?? 0) + instances);
      }
    }
  }
  const disabled = new Set(map.materialTagPolicy.disabled);
  return [...affectedParts]
    .map(([selector, count]) => ({
      selector,
      label: MATERIAL_TAG_LABELS[selector] ?? selector,
      affectedParts: count,
      enabled: !disabled.has(selector)
    }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

export function renderMaterialTagScenePanel(
  map: EditableMap,
  assets: readonly MapAsset[],
  open: boolean
): string {
  const options = collectSceneMaterialTagOptions(map, assets);
  const enabledCount = options.filter((option) => option.enabled).length;
  return `
    <details class="inspector-disclosure" data-inspector-section="material-tags" ${open ? 'open' : ''}>
      <summary><span><b>材质 Tag</b><small>${options.length > 0 ? `已启用 ${enabledCount}/${options.length}` : '当前场景无 Tag'}</small></span></summary>
      <section class="editor-section inspector-body">
        <p class="empty inspector-note">只影响当前地图。毛绒默认关闭；切换后画面与合批会立即按新配置重建。</p>
        ${options.length > 0 ? `<div class="material-tag-options">
          ${options.map((option) => `
            <label class="material-tag-option">
              <input type="checkbox" data-scene-material-tag="${escapeHtml(option.selector)}" ${option.enabled ? 'checked' : ''} />
              <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.selector)} · ${option.affectedParts} 个实例部件</small></span>
            </label>
          `).join('')}
        </div>` : '<p class="empty">添加包含材质 Tag 的模型后，这里会自动出现可用项。</p>'}
      </section>
    </details>
  `;
}

export function bindMaterialTagScenePanel(
  host: HTMLElement,
  map: EditableMap,
  onChanged: (label: string, enabled: boolean) => void
): void {
  host.querySelectorAll<HTMLInputElement>('[data-scene-material-tag]').forEach((input) => {
    input.addEventListener('change', () => {
      const selector = input.dataset.sceneMaterialTag;
      if (!selector) return;
      const disabled = new Set(map.materialTagPolicy.disabled);
      if (input.checked) disabled.delete(selector);
      else disabled.add(selector);
      map.materialTagPolicy = { disabled: [...disabled].sort() };
      onChanged(MATERIAL_TAG_LABELS[selector] ?? selector, input.checked);
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character);
}
