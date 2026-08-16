import { ROOM_WALLS, type EditableMap, type RoomSurface } from '../shared/map';
import {
  normalizeInteriorArtDirection,
  type InteriorArtDirection,
  type InteriorFinishLock,
  type InteriorSurfaceRecipe,
  type ProceduralRug,
  type SurfaceFinishRecipe
} from '../shared/interiorArtDirection';

const WALL_RECIPES: InteriorSurfaceRecipe[] = [
  'paint.solid', 'plaster.soft', 'wallpaper.stripe', 'wallpaper.geometric'
];
const FLOOR_RECIPES: InteriorSurfaceRecipe[] = [
  'paint.solid', 'wood.plank', 'wood.herringbone', 'tile.ceramic', 'tile.stone'
];

export interface InteriorFinishPanelCallbacks {
  changed(message: string): void;
}

export function renderInteriorFinishPanel(map: EditableMap, open: boolean): string {
  if (!map.room) return '';
  const art = map.interiorArtDirection;
  const settings = art?.finishSettings;
  const locked = settings?.locked.length ?? 0;
  return `
    <details class="inspector-disclosure" data-inspector-section="interior-finishes" ${open ? 'open' : ''}>
      <summary><span><b>墙面、地板与地毯</b><small>${art && settings?.enabled ? '已开启' : '已关闭'} · ${locked} 项手调锁定</small></span></summary>
      <section class="editor-section inspector-body">
        <label class="field compact"><span>室内表面装饰总开关</span><input data-interior-master type="checkbox" ${settings?.enabled ? 'checked' : ''} /></label>
        <fieldset class="asset-library-zones" ${settings?.enabled ? '' : 'disabled'}><legend>独立开关</legend>
          <label><input data-interior-feature="walls" type="checkbox" ${settings?.wallsEnabled ? 'checked' : ''} />墙面装饰</label>
          <label><input data-interior-feature="floor" type="checkbox" ${settings?.floorEnabled ? 'checked' : ''} />硬质地板</label>
          <label><input data-interior-feature="carpet" type="checkbox" ${settings?.carpetEnabled ? 'checked' : ''} />满铺地毯</label>
          <label><input data-interior-feature="rugs" type="checkbox" ${settings?.rugsEnabled ? 'checked' : ''} />独立地毯</label>
        </fieldset>
        <label class="field compact"><span>墙面应用范围</span><select data-interior-wall-scope ${settings?.enabled && settings.wallsEnabled ? '' : 'disabled'}>
          <option value="room" ${settings?.uniformWalls !== false ? 'selected' : ''}>整个房间</option>
          <option value="surface" ${settings?.uniformWalls === false ? 'selected' : ''}>仅当前墙面</option>
        </select></label>
        <p class="empty">满铺地毯开启时覆盖硬质地板；关闭后恢复已经保存的硬质地板配置。天花板不在本期控制范围内。</p>
        ${renderRugEditor(art)}
        <button type="button" class="secondary small" data-interior-follow-ai ${locked === 0 ? 'disabled' : ''}>重新跟随 AI</button>
      </section>
    </details>
  `;
}

export function bindInteriorFinishPanel(
  host: ParentNode,
  map: EditableMap,
  callbacks: InteriorFinishPanelCallbacks
): void {
  host.querySelector<HTMLInputElement>('[data-interior-master]')?.addEventListener('change', (event) => {
    commit(map, 'master', '已更新室内表面装饰总开关', (art) => {
      art.finishSettings.enabled = (event.target as HTMLInputElement).checked;
    }, callbacks);
  });
  host.querySelectorAll<HTMLInputElement>('[data-interior-feature]').forEach((input) => {
    input.addEventListener('change', () => {
      const feature = input.dataset.interiorFeature as 'walls' | 'floor' | 'carpet' | 'rugs';
      commit(map, feature, `已更新${featureLabel(feature)}开关`, (art) => {
        if (feature === 'walls') art.finishSettings.wallsEnabled = input.checked;
        else if (feature === 'floor') art.finishSettings.floorEnabled = input.checked;
        else if (feature === 'carpet') art.finishSettings.carpetEnabled = input.checked;
        else art.finishSettings.rugsEnabled = input.checked;
      }, callbacks);
    });
  });
  host.querySelector<HTMLSelectElement>('[data-interior-wall-scope]')?.addEventListener('change', (event) => {
    commit(map, 'walls', '已更新墙面应用范围', (art) => {
      art.finishSettings.uniformWalls = (event.target as HTMLSelectElement).value === 'room';
      if (art.finishSettings.uniformWalls) copyFinishToWalls(art, art.surfaces.north);
    }, callbacks);
  });
  host.querySelector<HTMLButtonElement>('[data-interior-follow-ai]')?.addEventListener('click', () => {
    const art = map.interiorArtDirection;
    if (!art) return;
    art.finishSettings.locked = [];
    map.interiorArtDirection = normalizeInteriorArtDirection(art, map.seed);
    callbacks.changed('表面配置已重新跟随 AI');
  });
  host.querySelector<HTMLButtonElement>('[data-add-procedural-rug]')?.addEventListener('click', () => {
    commit(map, 'rugs', '已添加独立地毯', (art) => {
      if (art.rugs.length >= 4) return;
      art.rugs.push(createRug(art));
      art.finishSettings.rugsEnabled = true;
    }, callbacks);
  });
  host.querySelectorAll<HTMLButtonElement>('[data-remove-procedural-rug]').forEach((button) => {
    button.addEventListener('click', () => {
      commit(map, 'rugs', '已删除独立地毯', (art) => {
        art.rugs = art.rugs.filter((rug) => rug.id !== button.dataset.removeProceduralRug);
      }, callbacks);
    });
  });
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-rug-field]').forEach((input) => {
    input.addEventListener('change', () => {
      commit(map, 'rugs', '已更新独立地毯', (art) => {
        const rug = art.rugs.find((item) => item.id === input.dataset.rugId);
        if (rug) updateRugField(rug, input);
      }, callbacks);
    });
  });
}

export function renderRoomSurfaceFinishEditor(map: EditableMap, surface: RoomSurface): string {
  if (surface === 'ceiling') return '<p class="empty">天花板暂不纳入表面装修编辑。</p>';
  const art = map.interiorArtDirection;
  if (!art) return '<p class="empty">请先在地图设置中开启“墙面、地板与地毯”。</p>';
  if (surface === 'floor') {
    return `
      <details class="inspector-disclosure compact" open>
        <summary><span><b>硬质地板</b><small>${art.finishSettings.floorEnabled ? '开启' : '关闭'}</small></span></summary>
        ${renderFinishControls(art.surfaces.floor, 'floor', FLOOR_RECIPES)}
      </details>
      <details class="inspector-disclosure compact" ${art.finishSettings.carpetEnabled ? 'open' : ''}>
        <summary><span><b>满铺地毯</b><small>${art.finishSettings.carpetEnabled ? '当前覆盖地板' : '已保留配置'}</small></span></summary>
        ${renderFinishControls(art.finishSettings.carpet, 'carpet', ['carpet.loop'])}
      </details>
    `;
  }
  return `
    <label class="field compact"><span>应用范围</span><select data-selected-wall-scope>
      <option value="room" ${art.finishSettings.uniformWalls ? 'selected' : ''}>整个房间</option>
      <option value="surface" ${art.finishSettings.uniformWalls ? '' : 'selected'}>仅${surfaceLabel(surface)}</option>
    </select></label>
    ${renderFinishControls(art.surfaces[surface], 'wall', WALL_RECIPES)}
  `;
}

export function bindRoomSurfaceFinishEditor(
  host: ParentNode,
  map: EditableMap,
  surface: RoomSurface,
  callbacks: InteriorFinishPanelCallbacks
): void {
  host.querySelector<HTMLSelectElement>('[data-selected-wall-scope]')?.addEventListener('change', (event) => {
    commit(map, 'walls', '已更新墙面应用范围', (art) => {
      art.finishSettings.uniformWalls = (event.target as HTMLSelectElement).value === 'room';
      if (art.finishSettings.uniformWalls && surface !== 'floor' && surface !== 'ceiling') {
        copyFinishToWalls(art, art.surfaces[surface]);
      }
    }, callbacks);
  });
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-finish-field]').forEach((input) => {
    input.addEventListener('change', () => {
      const target = input.dataset.finishTarget as 'wall' | 'floor' | 'carpet';
      const lock: InteriorFinishLock = target === 'wall' ? 'walls' : target;
      commit(map, lock, '已更新房间表面材质', (art) => {
        const finish = target === 'carpet' ? art.finishSettings.carpet : art.surfaces[surface];
        updateFinishField(finish, input);
        if (target === 'wall' && art.finishSettings.uniformWalls) copyFinishToWalls(art, finish);
      }, callbacks);
    });
  });
}

function renderFinishControls(
  finish: SurfaceFinishRecipe,
  target: 'wall' | 'floor' | 'carpet',
  recipes: InteriorSurfaceRecipe[]
): string {
  return `
    <label class="field compact"><span>材质</span><select data-finish-field="recipe" data-finish-target="${target}">
      ${recipes.map((recipe) => `<option value="${recipe}" ${finish.recipe === recipe ? 'selected' : ''}>${recipeLabel(recipe)}</option>`).join('')}
    </select></label>
    <div class="color-grid">
      <label><span>主颜色</span><input data-finish-field="palette" data-finish-index="0" data-finish-target="${target}" type="color" value="${finish.palette[0]}" /></label>
      <label><span>辅助颜色</span><input data-finish-field="palette" data-finish-index="1" data-finish-target="${target}" type="color" value="${finish.palette[1]}" /></label>
    </div>
    <details class="inspector-disclosure compact">
      <summary><span><b>高级参数</b><small>尺度、接缝与表面质感</small></span></summary>
      <div class="triple">
        ${finishNumber('纹理尺度', target, 'scale', finish.scale, 0.08, 3, 0.01)}
        ${finishNumber('接缝宽度', target, 'jointWidth', finish.jointWidth, 0, 0.12, 0.001)}
        ${finishNumber('随机变化', target, 'variation', finish.variation, 0, 0.35, 0.01)}
      </div>
      <div class="triple">
        ${finishNumber('粗糙度', target, 'roughness', finish.roughness, 0.2, 1, 0.01)}
        <label><span>旋转</span><select data-finish-field="rotation" data-finish-target="${target}">
          <option value="0" ${finish.rotation === 0 ? 'selected' : ''}>0°</option>
          <option value="90" ${finish.rotation === 90 ? 'selected' : ''}>90°</option>
        </select></label>
      </div>
    </details>
  `;
}

function renderRugEditor(art: InteriorArtDirection | null): string {
  const rugs = art?.rugs ?? [];
  return `
    <details class="inspector-disclosure compact">
      <summary><span><b>独立地毯</b><small>${rugs.length}/4</small></span></summary>
      <button type="button" class="secondary small" data-add-procedural-rug ${rugs.length >= 4 || !art?.finishSettings.enabled ? 'disabled' : ''}>添加地毯</button>
      ${rugs.map((rug) => `
        <details class="inspector-disclosure compact" data-rug-row="${escapeHtml(rug.id)}">
          <summary><span><b>${escapeHtml(rug.id)}</b><small>${rug.shape} · ${rug.pattern}</small></span></summary>
          <div class="triple">
            ${rugSelect(rug, 'shape', [['rectangle', '矩形'], ['round', '圆形'], ['runner', '长条']])}
            ${rugSelect(rug, 'pattern', [['border', '边框'], ['stripe', '条纹'], ['geometric', '几何'], ['woven', '编织']])}
            ${rugSelect(rug, 'rotation', [['0', '0°'], ['90', '90°']])}
          </div>
          <div class="triple">
            ${rugNumber(rug, 'centerX', '中心 X', rug.center[0], -1, 1, 0.05)}
            ${rugNumber(rug, 'centerZ', '中心 Z', rug.center[1], -1, 1, 0.05)}
            ${rugNumber(rug, 'sizeX', '宽度', rug.size[0], 0.12, 0.9, 0.01)}
          </div>
          <div class="triple">
            ${rugNumber(rug, 'sizeZ', '深度', rug.size[1], 0.12, 0.9, 0.01)}
            <label><span>主颜色</span><input data-rug-field="color0" data-rug-id="${escapeHtml(rug.id)}" type="color" value="${rug.palette[0]}" /></label>
            <label><span>辅助颜色</span><input data-rug-field="color1" data-rug-id="${escapeHtml(rug.id)}" type="color" value="${rug.palette[1]}" /></label>
          </div>
          <button type="button" class="secondary danger small" data-remove-procedural-rug="${escapeHtml(rug.id)}">删除地毯</button>
        </details>
      `).join('') || '<p class="empty">当前没有独立地毯。</p>'}
    </details>
  `;
}

function commit(
  map: EditableMap,
  lock: InteriorFinishLock,
  message: string,
  mutate: (art: InteriorArtDirection) => void,
  callbacks: InteriorFinishPanelCallbacks
): void {
  const art = ensureInteriorArtDirection(map);
  mutate(art);
  if (!art.finishSettings.locked.includes(lock)) art.finishSettings.locked.push(lock);
  map.interiorArtDirection = normalizeInteriorArtDirection(art, map.seed);
  callbacks.changed(message);
}

function ensureInteriorArtDirection(map: EditableMap): InteriorArtDirection {
  if (map.interiorArtDirection) return map.interiorArtDirection;
  const walls = Object.fromEntries(ROOM_WALLS.map((wall) => [wall, {
    recipe: 'paint.solid', palette: [map.box.colors[wall], map.box.colors[wall]], variation: 0
  }]));
  map.interiorArtDirection = normalizeInteriorArtDirection({
    summary: 'manual room finishes',
    palette: [map.box.colors.floor, map.box.colors.north],
    surfaces: {
      floor: { recipe: 'wood.plank', palette: [map.box.colors.floor, map.box.colors.floor] },
      ...walls
    } as never,
    finishSettings: { enabled: true } as never
  }, map.seed);
  return map.interiorArtDirection!;
}

function copyFinishToWalls(art: InteriorArtDirection, finish: SurfaceFinishRecipe): void {
  for (const wall of ROOM_WALLS) art.surfaces[wall] = cloneFinish(finish);
}

function cloneFinish(finish: SurfaceFinishRecipe): SurfaceFinishRecipe {
  return { ...finish, palette: [...finish.palette] };
}

function updateFinishField(finish: SurfaceFinishRecipe, input: HTMLInputElement | HTMLSelectElement): void {
  const field = input.dataset.finishField;
  if (field === 'recipe') {
    finish.recipe = input.value as InteriorSurfaceRecipe;
    if (finish.recipe === 'paint.solid') {
      finish.palette[1] = finish.palette[0];
      finish.variation = 0;
    }
  } else if (field === 'palette') {
    finish.palette[Number(input.dataset.finishIndex) === 1 ? 1 : 0] = input.value;
  } else if (field === 'rotation') {
    finish.rotation = input.value === '90' ? 90 : 0;
  } else if (field === 'scale' || field === 'jointWidth' || field === 'variation' || field === 'roughness') {
    finish[field] = Number(input.value);
  }
}

function createRug(art: InteriorArtDirection): ProceduralRug {
  return {
    id: `rug-${crypto.randomUUID().slice(0, 8)}`,
    shape: 'rectangle', center: [0, 0], size: [0.55, 0.42], rotation: 0, pattern: 'border',
    palette: art.palette.slice(0, 2), seed: Math.trunc(Math.random() * 0xffffffff) >>> 0
  };
}

function updateRugField(rug: ProceduralRug, input: HTMLInputElement | HTMLSelectElement): void {
  const field = input.dataset.rugField;
  if (field === 'shape') rug.shape = input.value as ProceduralRug['shape'];
  else if (field === 'pattern') rug.pattern = input.value as ProceduralRug['pattern'];
  else if (field === 'rotation') rug.rotation = input.value === '90' ? 90 : 0;
  else if (field === 'centerX') rug.center[0] = Number(input.value);
  else if (field === 'centerZ') rug.center[1] = Number(input.value);
  else if (field === 'sizeX') rug.size[0] = Number(input.value);
  else if (field === 'sizeZ') rug.size[1] = Number(input.value);
  else if (field === 'color0') rug.palette[0] = input.value;
  else if (field === 'color1') rug.palette[1] = input.value;
}

function finishNumber(label: string, target: string, field: string, value: number, min: number, max: number, step: number): string {
  return `<label><span>${label}</span><input data-finish-field="${field}" data-finish-target="${target}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

function rugNumber(rug: ProceduralRug, field: string, label: string, value: number, min: number, max: number, step: number): string {
  return `<label><span>${label}</span><input data-rug-field="${field}" data-rug-id="${escapeHtml(rug.id)}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

function rugSelect(rug: ProceduralRug, field: string, options: string[][]): string {
  const value = String(rug[field as 'shape' | 'pattern' | 'rotation']);
  return `<label><span>${field === 'shape' ? '形状' : field === 'pattern' ? '图案' : '旋转'}</span><select data-rug-field="${field}" data-rug-id="${escapeHtml(rug.id)}">${options.map(([key, label]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}

function recipeLabel(recipe: InteriorSurfaceRecipe): string {
  return ({
    'paint.solid': '纯色', 'plaster.soft': '柔和灰泥', 'wallpaper.stripe': '条纹墙纸',
    'wallpaper.geometric': '几何墙纸', 'wood.plank': '木板', 'wood.herringbone': '人字拼木地板',
    'tile.ceramic': '陶瓷砖', 'tile.stone': '石砖', 'carpet.loop': '圈绒满铺地毯',
    'ceiling.panel': '天花板面板', 'glass.panel': '玻璃面板'
  })[recipe];
}

function featureLabel(feature: string): string {
  return ({ walls: '墙面装饰', floor: '硬质地板', carpet: '满铺地毯', rugs: '独立地毯' })[feature] ?? feature;
}

function surfaceLabel(surface: RoomSurface): string {
  return ({ floor: '地板', ceiling: '天花板', north: '北墙', south: '南墙', east: '东墙', west: '西墙' })[surface];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
