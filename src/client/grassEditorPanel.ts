import type { EditableMap } from '../shared/map';
import {
  createGrassLayer,
  fillGrassLayerInPlace,
  generateGrassRegionInPlace,
  normalizeGrassMix,
  type GrassBrushMode,
} from '../shared/mapGrass';

export interface GrassEditorState {
  selectedLayerId: string | null;
  brushMode: GrassBrushMode;
  brushSize: number;
  brushStrength: number;
  targetDensity: number;
  fillDensity: number;
  regionX: number;
  regionZ: number;
  regionRadius: number;
}

export interface GrassEditorCallbacks {
  changed(message: string): void;
  selectionChanged(): void;
}

export function ensureGrassLayerSelection(map: EditableMap, state: GrassEditorState): void {
  if (!map.grassLayers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = map.grassLayers[0]?.id ?? null;
  }
}

export function renderGrassEditorPanel(map: EditableMap, state: GrassEditorState): string {
  ensureGrassLayerSelection(map, state);
  const layer = map.grassLayers.find((item) => item.id === state.selectedLayerId) ?? null;
  return `
    <section class="editor-section grass-editor-panel">
      <h2>草地层</h2>
      <p class="empty">地图保存草的分布；短草、高草和花草按比例混合。水边与水下不会被自动排除。</p>
      <div class="grass-layer-row">
        <select data-grass-layer ${map.grassLayers.length ? '' : 'disabled'}>
          ${map.grassLayers.map((item) => `<option value="${escapeAttribute(item.id)}" ${item.id === state.selectedLayerId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
        <button type="button" class="secondary small" data-grass-add>新增</button>
        <button type="button" class="secondary small" data-grass-remove ${layer ? '' : 'disabled'}>删除</button>
      </div>
      ${layer ? `
        <label class="field compact"><span>名称</span><input data-grass-name maxlength="80" value="${escapeAttribute(layer.name)}" /></label>
        <label class="field compact"><span>显示</span><input data-grass-visible type="checkbox" ${layer.visible ? 'checked' : ''} /></label>
        <div class="triple">
          ${ratioField('短草', 'short', layer.mix.short)}
          ${ratioField('高草', 'tall', layer.mix.tall)}
          ${ratioField('花草', 'flowers', layer.mix.flowers)}
        </div>
        <h3>草刷</h3>
        <select data-grass-brush-mode>
          ${option('add', '增加', state.brushMode)}
          ${option('erase', '擦除', state.brushMode)}
          ${option('density', '设为密度', state.brushMode)}
          ${option('smooth', '平滑', state.brushMode)}
        </select>
        ${rangeField('大小', 'brush-size', 0.5, 12, 0.1, state.brushSize)}
        ${rangeField('强度', 'brush-strength', 0.02, 1, 0.02, state.brushStrength)}
        ${state.brushMode === 'density' ? rangeField('目标密度', 'target-density', 0, 1, 0.02, state.targetDensity) : ''}
        <h3>快速生成</h3>
        ${rangeField('整片密度', 'fill-density', 0, 1, 0.02, state.fillDensity)}
        <div class="grass-action-row">
          <button type="button" data-grass-fill>整片填充</button>
          <button type="button" class="secondary" data-grass-clear>清空</button>
        </div>
        <p class="empty">区域圆心与半径使用地图世界坐标。</p>
        <div class="triple">
          ${numberField('X', 'region-x', state.regionX, 0.5)}
          ${numberField('Z', 'region-z', state.regionZ, 0.5)}
          ${numberField('半径', 'region-radius', state.regionRadius, 0.5, 0.5)}
        </div>
        <button type="button" data-grass-generate-region>按区域一键生成</button>
      ` : '<p class="empty">新增一个草地层后即可开始绘制。</p>'}
    </section>
  `;
}

export function bindGrassEditorPanel(
  host: HTMLElement,
  map: EditableMap,
  state: GrassEditorState,
  callbacks: GrassEditorCallbacks
): void {
  ensureGrassLayerSelection(map, state);
  const current = () => map.grassLayers.find((layer) => layer.id === state.selectedLayerId) ?? null;
  host.querySelector<HTMLSelectElement>('[data-grass-layer]')?.addEventListener('change', (event) => {
    state.selectedLayerId = (event.target as HTMLSelectElement).value || null;
    callbacks.selectionChanged();
  });
  host.querySelector<HTMLButtonElement>('[data-grass-add]')?.addEventListener('click', () => {
    const layer = createGrassLayer(
      { name: `草地 ${map.grassLayers.length + 1}`, seed: map.seed + map.grassLayers.length + 1 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ,
      map.seed
    );
    map.grassLayers.push(layer);
    state.selectedLayerId = layer.id;
    callbacks.changed('已新增草地层');
  });
  host.querySelector<HTMLButtonElement>('[data-grass-remove]')?.addEventListener('click', () => {
    const index = map.grassLayers.findIndex((layer) => layer.id === state.selectedLayerId);
    if (index < 0) return;
    map.grassLayers.splice(index, 1);
    state.selectedLayerId = map.grassLayers[Math.min(index, map.grassLayers.length - 1)]?.id ?? null;
    callbacks.changed('已删除草地层');
  });
  host.querySelector<HTMLInputElement>('[data-grass-name]')?.addEventListener('change', (event) => {
    const layer = current();
    if (!layer) return;
    layer.name = (event.target as HTMLInputElement).value.trim().slice(0, 80) || layer.name;
    callbacks.changed('已更新草地层');
  });
  host.querySelector<HTMLInputElement>('[data-grass-visible]')?.addEventListener('change', (event) => {
    const layer = current();
    if (!layer) return;
    layer.visible = (event.target as HTMLInputElement).checked;
    callbacks.changed(layer.visible ? '已显示草地层' : '已隐藏草地层');
  });
  host.querySelectorAll<HTMLInputElement>('[data-grass-ratio]').forEach((input) => {
    input.addEventListener('change', () => {
      const layer = current();
      if (!layer) return;
      const raw = { ...layer.mix, [input.dataset.grassRatio ?? 'short']: numberValue(input.value, 0) };
      layer.mix = normalizeGrassMix(raw);
      callbacks.changed('已更新草种比例');
    });
  });
  bindSelect(host, '[data-grass-brush-mode]', (value) => { state.brushMode = value as GrassBrushMode; callbacks.selectionChanged(); });
  bindNumber(host, '[data-grass-brush-size]', (value) => { state.brushSize = value; });
  bindNumber(host, '[data-grass-brush-strength]', (value) => { state.brushStrength = value; });
  bindNumber(host, '[data-grass-target-density]', (value) => { state.targetDensity = value; });
  bindNumber(host, '[data-grass-fill-density]', (value) => { state.fillDensity = value; });
  bindNumber(host, '[data-grass-region-x]', (value) => { state.regionX = value; });
  bindNumber(host, '[data-grass-region-z]', (value) => { state.regionZ = value; });
  bindNumber(host, '[data-grass-region-radius]', (value) => { state.regionRadius = Math.max(0.5, value); });
  host.querySelector<HTMLButtonElement>('[data-grass-fill]')?.addEventListener('click', () => {
    const layer = current();
    if (!layer) return;
    fillGrassLayerInPlace(map, layer.id, state.fillDensity);
    callbacks.changed('已整片填充草地');
  });
  host.querySelector<HTMLButtonElement>('[data-grass-clear]')?.addEventListener('click', () => {
    const layer = current();
    if (!layer) return;
    fillGrassLayerInPlace(map, layer.id, 0);
    callbacks.changed('已清空当前草地层');
  });
  host.querySelector<HTMLButtonElement>('[data-grass-generate-region]')?.addEventListener('click', () => {
    const layer = current();
    if (!layer) return;
    generateGrassRegionInPlace(map, layer.id, {
      kind: 'circle',
      center: [state.regionX, state.regionZ],
      radius: state.regionRadius,
    }, state.fillDensity, 0.22, 0.25, layer.seed);
    callbacks.changed('已按区域生成草地');
  });
}

function ratioField(label: string, key: string, value: number): string {
  return `<label class="field compact"><span>${label}</span><input data-grass-ratio="${key}" type="number" min="0" max="1" step="0.05" value="${value.toFixed(2)}" /></label>`;
}

function rangeField(label: string, key: string, min: number, max: number, step: number, value: number): string {
  return `<label class="field compact"><span>${label} <output>${value.toFixed(2)}</output></span><input data-grass-${key} type="range" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

function numberField(label: string, key: string, value: number, step: number, min?: number): string {
  return `<label class="field compact"><span>${label}</span><input data-grass-${key} type="number" ${min === undefined ? '' : `min="${min}"`} step="${step}" value="${value}" /></label>`;
}

function option(value: GrassBrushMode, label: string, selected: GrassBrushMode): string {
  return `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
}

function bindSelect(host: HTMLElement, selector: string, setter: (value: string) => void): void {
  host.querySelector<HTMLSelectElement>(selector)?.addEventListener('change', (event) => setter((event.target as HTMLSelectElement).value));
}

function bindNumber(host: HTMLElement, selector: string, setter: (value: number) => void): void {
  host.querySelector<HTMLInputElement>(selector)?.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    setter(numberValue(input.value, 0));
    const output = input.closest('label')?.querySelector('output');
    if (output) output.textContent = numberValue(input.value, 0).toFixed(2);
  });
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
