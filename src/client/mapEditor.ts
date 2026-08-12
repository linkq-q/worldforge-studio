import * as THREE from 'three';
import { serverHttpBase } from './serverEndpoint';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  MAP_SIZE_PRESETS,
  SUPER_MAP_MEDIUM_COUNT_MAX,
  SUPER_MAP_MEDIUM_COUNT_MIN,
  DEFAULT_PLAYER_HEIGHT,
  DEFAULT_WORLD_SCALE_PROFILE,
  PLAYER_SPAWN_OBJECT_ID,
  ROOM_OBJECT_ID,
  ROOM_SURFACES,
  SUN_OBJECT_ID,
  addPaintStroke,
  applyTerrainBrush,
  createMapObject,
  createPaintStroke,
  getMapBounds,
  getMapPlayerMetrics,
  getPlayerSpawnYaw,
  getSpawnPoints,
  getSunPosition,
  normalizeMap,
  normalizeMapRoom,
  normalizeMapSceneMode,
  normalizeWorldScaleProfile,
  placeRoomOpeningObjectInPlace,
  reassignRegionGenerationOwnersInPlace,
  sampleTerrainHeight,
  roomSurfaceObjectId,
  syncRoomOpeningFromObjectInPlace,
  superMapSizeFromMediumCount,
  surfaceUvFromPoint,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type MapSceneMode,
  type MapSummary,
  type MapSurface,
  type MapSizePresetKey,
  type RoomSurface,
  type RoomWallDisplayMode,
  type WorldScaleProfile,
  type TerrainBrushMode
} from '../shared/map';
import { lintMap } from '../shared/mapLint';
import {
  DEFAULT_MAP_AI_MIN_NEW_ASSETS,
  DEFAULT_MAP_AI_MAX_NEW_ASSETS,
  MAP_AI_MAX_NEW_ASSETS,
  normalizeMapAiNewAssetRange
} from '../shared/mapPlanning';
import { isCompositionEmptyMap, SCENE_COMPOSITION_LIMITS, type SceneCompositionPlan } from '../shared/sceneComposition';
import { renderMapCompositionPlanApproval, renderMapCompositionSummary } from './mapCompositionPanel';
import {
  bindMaterialTagScenePanel,
  renderMaterialTagScenePanel
} from './materialTagScenePanel';
import {
  bindGrassEditorPanel,
  ensureGrassLayerSelection,
  renderGrassEditorPanel,
  type GrassEditorState,
} from './grassEditorPanel';
import { applyGrassBrushInPlace } from '../shared/mapGrass';
import {
  defaultRenderModule,
  renderDeveloperWorkspace,
  type DeveloperRenderView
} from './developerRenderControls';
import type { RenderInspectorCategoryId } from './renderInspectorCatalog';
import {
  humanizeAgentError,
  humanizeRenderAgentError,
  renderAgentProgress,
  updateAgentProgress
} from './agentProgressPanel';
import { buildEditableMapGroup, type RenderedMap } from './mapRenderer';
import { buildModelGroup } from './modelRenderer';
import { RenderSceneRuntime } from './renderSceneRuntime';
import { RenderStats, type RenderDebugDetails } from './renderStats';
import { AdaptiveRenderQuality } from './adaptiveRenderQuality';
import { PlayModeController } from './playModeController';
import {
  exportWorldForge,
  importWorldForgeFile,
  type EditorExportKind
} from './editorTransfer';
import {
  applyMapOperations,
  type MapAiSuggestion,
  type MapOperation,
  type MapTransactionSummary
} from '../shared/mapOperations';
import {
  TERRAIN_CLIFF_LAYOUTS,
  TERRAIN_GENERATION_PRESETS,
  TERRAIN_MODIFIERS,
  TERRAIN_SURFACES,
  type TerrainCliffLayout,
  type TerrainGenerationPreset,
  type TerrainModifier,
  type TerrainSurfaceKind
} from '../shared/terrainGeneration';
import {
  type AgentProgressEvent,
  type ChatProvider
} from '../shared/protocol';
import type { HdriTexture } from '../shared/hdri';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';
import {
  ASSET_LIBRARY_ZONE_TAGS,
  type AssetLibrary,
  type AssetLibraryMetadata,
  type AssetLibraryPack
} from '../shared/assetLibrary';
import {
  MODEL_GENERATION_MODES,
  normalizeModelGenerationMode,
  type ModelGenerationMode
} from '../shared/modelGenerationMode';
import { harmonizeHdriAtmosphere } from '../shared/hdriAtmosphere';
import { patchMapVisualZone, type VisualZonePatch } from '../shared/mapVisualSemantics';
import {
  VISUAL_ZONE_FIELDS,
  VISUAL_ZONE_TAGS,
  normalizeMapVisualSemantics,
  type VisualZoneField,
  type VisualZoneTag
} from '../shared/visualDirection';
import { inspectMapDerivedResults } from './mapDerivedInspection';
import {
  createMapEdgeMask,
  findAdjacentMapRegion,
  maxMapRegionCount,
  measureMapLayoutCoverage,
  mergeMapRegions,
  rectanglePolygon,
  splitMapRegion,
  type MapEcologyRegion,
  type MapLayout,
  type MapEdgeMaskKind
} from '../shared/mapLayout';
import {
  RENDER_CAPABILITIES,
  compileRenderPlan,
  compileRuntimeHdriSky,
  compileRuntimeShaderExtension,
  createDefaultRenderAccessPolicy,
  normalizeRenderAccessPolicy,
  type RenderModuleSelection,
  type RenderParameterAccess,
  type RenderPlan,
  renderModuleLabel
} from '../shared/renderPlan';

type EditorTool = 'select' | 'paint' | 'terrain' | 'grass';
type TransformMode = 'translate' | 'rotate' | 'scale';
type EditorStage = 'map' | 'render';
type TerrainEditorAction = 'brush' | 'modifier' | 'surface';

const CAMERA_MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']);
const CAMERA_BASE_SPEED = 8;
const MAX_HISTORY_STEPS = 50;
const VIEW_DIRECTIONS = {
  perspective: new THREE.Vector3(1, 0.72, 1),
  top: new THREE.Vector3(0, 1, 0),
  front: new THREE.Vector3(0, 0, 1),
  right: new THREE.Vector3(1, 0, 0)
} as const;

interface EditorState {
  maps: MapSummary[];
  assets: MapAsset[];
  assetLibraries: AssetLibrary[];
  libraryAssets: MapAsset[];
  renderSchemes: RenderScheme[];
  map: EditableMap | null;
  selectedObjectId: string | null;
  selectedAssetId: string | null;
  stage: EditorStage;
  tool: EditorTool;
  transformMode: TransformMode;
  brushColor: string;
  brushSize: number;
  brushSoftness: number;
  terrainMode: TerrainBrushMode;
  terrainAction: TerrainEditorAction;
  terrainPreset: TerrainGenerationPreset;
  terrainModifier: TerrainModifier;
  terrainCliffLayout: TerrainCliffLayout;
  terrainSurface: TerrainSurfaceKind;
  terrainSize: number;
  terrainStrength: number;
  terrainAmplitude: number;
  terrainSoftness: number;
  terrainDirection: number;
  terrainLayers: number;
  uniformScale: boolean;
  dirty: boolean;
  busy: boolean;
  message: string;
  undoTransaction: MapTransactionSummary | null;
  redoTransaction: MapTransactionSummary | null;
}

export function startMapEditor(app: HTMLElement): void {
  const editor = new MapEditor(app);
  void editor.start();
}

class MapEditor {
  private readonly state: EditorState = {
    maps: [],
    assets: [],
    assetLibraries: [],
    libraryAssets: [],
    renderSchemes: [],
    map: null,
    selectedObjectId: null,
    selectedAssetId: null,
    stage: 'map',
    tool: 'select',
    transformMode: 'translate',
    brushColor: '#d8ef75',
    brushSize: 1.2,
    brushSoftness: 0.35,
    terrainMode: 'raise',
    terrainAction: 'brush',
    terrainPreset: 'hills',
    terrainModifier: 'cliff',
    terrainCliffLayout: 'plateau',
    terrainSurface: 'sand',
    terrainSize: 1.8,
    terrainStrength: 0.3,
    terrainAmplitude: 5,
    terrainSoftness: 0.2,
    terrainDirection: 90,
    terrainLayers: 4,
    uniformScale: false,
    dirty: false,
    busy: false,
    message: '',
    undoTransaction: null,
    redoTransaction: null
  };

  /** Scene, lights, shadows and post-processing, shared with the map viewer. */
  private renderScene: RenderSceneRuntime | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private renderStats: RenderStats | null = null;
  private readonly adaptiveQuality = new AdaptiveRenderQuality();
  private playMode: PlayModeController | null = null;
  private hdriFiles: string[] = [];
  private hdriTextures: HdriTexture[] = [];
  private orbit: OrbitControls | null = null;
  private transform: TransformControls | null = null;
  private renderedMap: RenderedMap | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cameraKeys = new Set<string>();
  private readonly cameraMove = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private transformDragging = false;
  private transformPointerActive = false;
  private animationFrame = 0;
  private grassRefreshHandle = 0;
  private terrainRefreshHandle = 0;
  private sceneRefresh: Promise<void> | null = null;
  private sceneRefreshQueued: Promise<void> | null = null;
  private lastFrameAt = performance.now();
  private painting = false;
  private terrainFlattenHeight: number | null = null;
  private terrainSeed: number | null = null;
  private terrainGesturePoints: Array<[number, number]> = [];
  private previewRenderer: THREE.WebGLRenderer | null = null;
  private previewScene: THREE.Scene | null = null;
  private previewCamera: THREE.PerspectiveCamera | null = null;
  private previewOrbit: OrbitControls | null = null;
  private previewModelRoot: THREE.Group | null = null;
  private previewModel: THREE.Object3D | null = null;
  private previewAssetId: string | null = null;
  private previewRequestId = 0;
  private selectionOutline: THREE.BoxHelper | null = null;
  private brushPreview: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null = null;
  private placementPreview: THREE.Object3D | null = null;
  private placingAssetId: string | null = null;
  private placementRequestId = 0;
  private savedMapSnapshot = '';
  private historyPresent: EditableMap | null = null;
  private readonly historyPast: EditableMap[] = [];
  private readonly historyFuture: EditableMap[] = [];
  private historyGestureStart: EditableMap | null = null;
  private renderDraft: RenderScheme | null = null;
  private renderDraftChanged = false;
  private renderAiPrompt = '';
  private renderAiProvider: ChatProvider = 'gpt';
  private renderAiPreview = false;
  private renderAiPreviewVisible = true;
  private renderAiComparisonScheme: RenderScheme | null = null;
  private renderAiExplanation = '';
  private renderAiAbortController: AbortController | null = null;
  private renderAgentProgress: AgentProgressEvent[] = [];
  private renderAgentStartedAt = 0;
  private renderAgentElapsedMs = 0;
  private renderAgentProgressTimer: number | null = null;
  private developerMode = false;
  private hierarchyOpen = false;
  private developerRenderView: DeveloperRenderView = 'tuning';
  private developerRenderCategory: RenderInspectorCategoryId = 'lighting';
  private mapAiPrompt = '';
  private mapLayoutPrompt = '';
  private mapLayoutSuggestion: { summary: string; layout: MapLayout } | null = null;
  private mapLayoutAbortController: AbortController | null = null;
  private mapLayoutProgress: AgentProgressEvent[] = [];
  private mapLayoutStartedAt = 0;
  private mapLayoutElapsedMs = 0;
  private mapLayoutProgressTimer: number | null = null;
  private selectedEcologyRegionId = '';
  private selectedStitchSeamId = '';
  private mapAiTargetRegionId = '';
  private mapAiBaseTerrainOnly = false;
  private mapAiProvider: ChatProvider = 'gpt';
  private mapAiReuseExistingAssets = false;
  private mapAiConfirmCompositionPlan = false;
  private pendingCompositionPlan: SceneCompositionPlan | null = null;
  private activeAssetLibraryId = '';
  private selectedLibraryAssetId = '';
  private previewingLibraryAsset = false;
  private mapAiMinNewAssets = DEFAULT_MAP_AI_MIN_NEW_ASSETS;
  private mapAiMaxNewAssets = DEFAULT_MAP_AI_MAX_NEW_ASSETS;
  private mapAiTargetVisualZoneId = '';
  private selectedVisualZoneId = '';
  private newMapAssetGenerationMode: ModelGenerationMode = 'voxel';
  private newMapSceneMode: MapSceneMode = 'outdoor';
  private newRoomSize: [number, number, number] = [10, 3, 8];
  private newPlayerHeight = DEFAULT_PLAYER_HEIGHT;
  private newWorldScaleProfile: WorldScaleProfile = DEFAULT_WORLD_SCALE_PROFILE;
  private roomWallDisplayMode: RoomWallDisplayMode = 'cutaway';
  private mapAiSuggestion: MapAiSuggestion | null = null;
  private mapPreviewKind: 'ai' | 'terrain' = 'ai';
  private mapAiPreviewMap: EditableMap | null = null;
  private mapAiPreviewVisible = true;
  private mapAiComparisonMap: EditableMap | null = null;
  private mapAiAbortController: AbortController | null = null;
  private mapAgentProgress: AgentProgressEvent[] = [];
  private mapAgentStartedAt = 0;
  private mapAgentElapsedMs = 0;
  private mapAgentProgressTimer: number | null = null;
  private newMapSizePreset: MapSizePresetKey = 'medium';
  private newMapSuperMediumCount = 16;
  private readonly grassEditorState: GrassEditorState = {
    selectedLayerId: null,
    brushMode: 'add',
    brushSize: 3,
    brushStrength: 0.35,
    targetDensity: 0.65,
    fillDensity: 0.72,
    regionX: 0,
    regionZ: 0,
    regionRadius: 12,
  };

  constructor(private readonly app: HTMLElement) {}

  async start(): Promise<void> {
    this.developerMode = localStorage.getItem('worldforge.developerMode') === 'on';
    this.newMapAssetGenerationMode = normalizeModelGenerationMode(localStorage.getItem('worldforge.newMapAssetMode'));
    this.roomWallDisplayMode = normalizeRoomWallDisplayMode(localStorage.getItem('worldforge.roomWallDisplayMode'));
    this.activeAssetLibraryId = localStorage.getItem('worldforge.activeAssetLibraryId') ?? '';
    this.renderShell();
    this.setupViewport();
    this.setupAssetPreview();
    await this.reloadLists();
    this.renderPanels();
    this.animate();
  }

  private renderShell(): void {
    this.app.className = 'app editor-active';
    this.app.innerHTML = `
      <main class="editor-shell">
        <aside class="editor-sidebar left">
          <div class="studio-brand">
            <span class="studio-brand-mark">W</span>
            <span><strong>WorldForge</strong><small>SCENE STUDIO</small></span>
          </div>
          <button id="toggle-hierarchy" class="hierarchy-toggle secondary" type="button" aria-expanded="false" title="展开层级">
            <span>层级</span>
          </button>
          <div class="hierarchy-panel">
            <div class="editor-section hierarchy-head">
              <h2>层级</h2>
              <button id="add-object" class="secondary small" data-map-only>添加空物体</button>
            </div>
            <div id="hierarchy" class="hierarchy"></div>
          </div>
        </aside>
        <section class="editor-main">
          <header class="editor-toolbar">
            <div class="toolbar-project" aria-label="地图项目">
              <details class="toolbar-transfer toolbar-project-menu">
                <summary><span id="toolbar-map-name">选择地图</span></summary>
                <div class="toolbar-transfer-menu">
                  <label><span>当前地图</span><select id="editor-map-select" aria-label="当前地图"></select></label>
                  <label><span>重命名当前地图</span><input id="rename-current-map-input" maxlength="80" aria-label="重命名当前地图" placeholder="输入地图名称"></label>
                  <button id="rename-current-map" class="secondary" type="button">重命名</button>
                  <button id="delete-map" class="secondary danger" type="button">删除当前地图</button>
                  <label><span>场景类型</span><select id="new-map-scene-mode" aria-label="新地图场景类型">
                    <option value="outdoor" ${this.newMapSceneMode === 'outdoor' ? 'selected' : ''}>室外</option>
                    <option value="indoor" ${this.newMapSceneMode === 'indoor' ? 'selected' : ''}>室内</option>
                    <option value="mixed" ${this.newMapSceneMode === 'mixed' ? 'selected' : ''}>室内 + 室外</option>
                  </select></label>
                  <label id="new-map-size-field"><span>地图尺寸</span><select id="new-map-size" aria-label="新地图尺寸">
                    ${MAP_SIZE_PRESETS.map((preset) => `
                      <option value="${preset.key}" ${preset.key === this.newMapSizePreset ? 'selected' : ''}>${preset.label}</option>
                    `).join('')}
                  </select></label>
                  <label id="new-map-super-size" ${this.newMapSizePreset === 'super' ? '' : 'hidden'}>
                    <span>超大地图面积（中地图数量）</span>
                    <input id="new-map-super-units" type="number" min="${SUPER_MAP_MEDIUM_COUNT_MIN}" max="${SUPER_MAP_MEDIUM_COUNT_MAX}" step="1" value="${this.newMapSuperMediumCount}" />
                    <small id="new-map-super-size-hint"></small>
                  </label>
                  <label id="new-room-size-field" ${this.newMapSceneMode === 'outdoor' ? 'hidden' : ''}>
                    <span>房间宽 × 高 × 深（米）</span>
                    <div class="triple">
                      <input data-new-room-size="0" type="number" min="3" max="40" step="0.5" value="${this.newRoomSize[0]}" aria-label="房间宽度" />
                      <input data-new-room-size="1" type="number" min="2.2" max="12" step="0.1" value="${this.newRoomSize[1]}" aria-label="房间高度" />
                      <input data-new-room-size="2" type="number" min="3" max="40" step="0.5" value="${this.newRoomSize[2]}" aria-label="房间深度" />
                    </div>
                  </label>
                  <label><span>资产风格</span><select id="new-map-asset-mode" aria-label="新地图模型风格">
                    ${MODEL_GENERATION_MODES.map((mode) => `
                      <option value="${mode.key}" ${mode.key === this.newMapAssetGenerationMode ? 'selected' : ''}>${mode.label}</option>
                    `).join('')}
                  </select></label>
                  <label><span>角色高度（米）</span><input id="new-player-height" type="number" min="0.8" max="2.4" step="0.1" value="${this.newPlayerHeight}" /></label>
                  <label><span>世界尺度</span><select id="new-world-scale-profile">
                    <option value="intimate" ${this.newWorldScaleProfile === 'intimate' ? 'selected' : ''}>亲近（人物与景物差距较小）</option>
                    <option value="balanced" ${this.newWorldScaleProfile === 'balanced' ? 'selected' : ''}>均衡</option>
                    <option value="grand" ${this.newWorldScaleProfile === 'grand' ? 'selected' : ''}>宏大（景物更有体量）</option>
                  </select></label>
                  <button id="new-map" type="button">创建地图</button>
                </div>
              </details>
            </div>
            <div class="stage-switcher segmented compact toolbar-workspace" aria-label="制作阶段">
              <button data-stage="map">地图</button>
              <button data-stage="render">渲染</button>
            </div>
            <div class="toolbar-group toolbar-tools" data-map-only>
              <span class="toolbar-label">工具</span>
              <div class="segmented compact">
                <button data-tool="select">选择</button>
                <button data-tool="paint">绘制</button>
                <button data-tool="terrain">地形</button>
                <button data-tool="grass">草地</button>
              </div>
            </div>
            <div class="toolbar-group toolbar-transform" data-transform-tools data-map-only>
              <span class="toolbar-label">对象变换</span>
              <div class="segmented compact">
                <button data-transform-mode="translate" title="移动物体">移动</button>
                <button data-transform-mode="rotate" title="旋转物体">旋转</button>
                <button data-transform-mode="scale" title="缩放物体">缩放</button>
              </div>
            </div>
            <details class="toolbar-transfer toolbar-view-menu toolbar-navigation">
              <summary>视角</summary>
              <div class="toolbar-transfer-menu">
                <button type="button" data-view="perspective">透视</button>
                <button type="button" data-view="top">顶视图</button>
                <button type="button" data-view="front">前视图</button>
                <button type="button" data-view="right">右视图</button>
                <label id="room-wall-display-field" hidden><span>房间显示</span><select id="room-wall-display-mode">
                  <option value="full" ${this.roomWallDisplayMode === 'full' ? 'selected' : ''}>完整墙体</option>
                  <option value="cutaway" ${this.roomWallDisplayMode === 'cutaway' ? 'selected' : ''}>自动剖切</option>
                  <option value="half" ${this.roomWallDisplayMode === 'half' ? 'selected' : ''}>半墙</option>
                  <option value="hidden" ${this.roomWallDisplayMode === 'hidden' ? 'selected' : ''}>隐藏墙体</option>
                </select></label>
              </div>
            </details>
            <button data-play-mode class="secondary toolbar-utility" title="从出生点进入第一人称游玩视角">游玩</button>
            <button id="toggle-developer-mode" class="secondary toolbar-utility" data-render-only>开发者</button>
            <div class="toolbar-actions">
              <button id="undo-edit" class="secondary" disabled title="撤销手工编辑（Ctrl+Z）">撤销</button>
              <button id="redo-edit" class="secondary" disabled title="重做手工编辑（Ctrl+Shift+Z）">重做</button>
              <button id="undo-transaction" class="secondary" disabled title="撤销最近一次 AI/Agent 生成">撤销 AI</button>
              <button id="redo-transaction" class="secondary" disabled title="重做最近一次撤销的 AI/Agent 生成">重做 AI</button>
              <button id="confirm-map" title="进入渲染阶段">进入渲染</button>
              <button id="save-map" class="secondary toolbar-save">保存</button>
              <details class="toolbar-transfer toolbar-more">
                <summary>更多</summary>
                <div class="toolbar-transfer-menu">
                  <button type="button" data-editor-export="map">地图数据</button>
                  <button type="button" data-editor-export="render-scheme">渲染方案</button>
                  <button type="button" data-editor-export="scene">完整场景包</button>
                  <button type="button" id="import-transfer">导入文件…</button>
                </div>
              </details>
              <input id="import-transfer-file" type="file" accept=".json,.zip,application/json,application/zip" hidden>
            </div>
          </header>
          <div id="editor-viewport" class="editor-viewport">
            <div class="viewport-badge"><span></span><b id="viewport-view-name">透视视图</b></div>
            <div id="editor-status" class="viewport-status" role="status"></div>
            <div id="viewport-stats" class="viewport-stats" hidden></div>
            <div class="play-mode-hud" hidden>
              <span class="play-crosshair" aria-hidden="true"></span>
              <div class="play-mode-help"><b>游玩视角</b><span>WASD 移动 · Shift 冲刺 · Space 跳跃 · Esc 退出</span></div>
            </div>
            <details class="shortcut-help">
              <summary>快捷键</summary>
              <div class="shortcut-help-panel" aria-label="地图编辑器操作键">
                <span><kbd>左键</kbd>选择 / 绘制 / 地形</span>
                <span><kbd>右键拖动</kbd>旋转视角</span>
                <span><kbd>中键拖动</kbd>平移视角</span>
                <span><kbd>Alt</kbd>+<kbd>左键</kbd>旋转视角</span>
                <span><kbd>滚轮</kbd>缩放视角</span>
                <span><kbd>F</kbd>聚焦选中 <kbd>Home</kbd>显示全景</span>
                <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动镜头</span>
                <span><kbd>↑</kbd>/<kbd>↓</kbd>上升 / 下沉镜头</span>
              </div>
            </details>
          </div>
        </section>
        <aside class="editor-sidebar right">
          <div class="inspector-heading"><strong>属性</strong><small>SCENE</small></div>
          <div id="map-ai-panel"></div>
          <div id="map-inspector"></div>
          <div id="object-inspector"></div>
          <div id="asset-panel"></div>
          <div id="render-inspector"></div>
        </aside>
      </main>
    `;

    this.updateHierarchyLayout();
    this.app.querySelector('#toggle-hierarchy')?.addEventListener('click', () => {
      this.hierarchyOpen = !this.hierarchyOpen;
      this.updateHierarchyLayout();
      requestAnimationFrame(() => this.resize());
    });
    this.app.querySelector('#new-map')?.addEventListener('click', (event) => {
      (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
      void this.createMap();
    });
    this.app.querySelector('#delete-map')?.addEventListener('click', () => void this.deleteCurrentMap());
    this.app.querySelector('#rename-current-map')?.addEventListener('click', () => {
      const input = this.app.querySelector<HTMLInputElement>('#rename-current-map-input');
      this.renameCurrentMap(input?.value ?? '');
    });
    this.app.querySelector<HTMLInputElement>('#rename-current-map-input')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.renameCurrentMap((event.currentTarget as HTMLInputElement).value);
    });
    const updateSuperMapSizeControls = () => {
      const field = this.app.querySelector<HTMLElement>('#new-map-super-size');
      const sizeField = this.app.querySelector<HTMLElement>('#new-map-size-field');
      const roomField = this.app.querySelector<HTMLElement>('#new-room-size-field');
      const input = this.app.querySelector<HTMLInputElement>('#new-map-super-units');
      const hint = this.app.querySelector<HTMLElement>('#new-map-super-size-hint');
      if (sizeField) sizeField.hidden = this.newMapSceneMode === 'indoor';
      if (roomField) roomField.hidden = this.newMapSceneMode === 'outdoor';
      if (field) field.hidden = this.newMapSceneMode === 'indoor' || this.newMapSizePreset !== 'super';
      if (input) input.value = String(this.newMapSuperMediumCount);
      const size = superMapSizeFromMediumCount(this.newMapSuperMediumCount);
      if (hint) hint.textContent = `约 ${this.newMapSuperMediumCount} 个中地图面积 · ${size[0]} × ${size[2]}`;
    };
    this.app.querySelector<HTMLSelectElement>('#new-map-scene-mode')?.addEventListener('change', (event) => {
      this.newMapSceneMode = normalizeMapSceneMode((event.target as HTMLSelectElement).value);
      updateSuperMapSizeControls();
    });
    this.app.querySelector<HTMLSelectElement>('#new-map-size')?.addEventListener('change', (event) => {
      this.newMapSizePreset = (event.target as HTMLSelectElement).value as MapSizePresetKey;
      updateSuperMapSizeControls();
    });
    this.app.querySelector<HTMLInputElement>('#new-map-super-units')?.addEventListener('change', (event) => {
      this.newMapSuperMediumCount = Math.min(
        SUPER_MAP_MEDIUM_COUNT_MAX,
        Math.max(SUPER_MAP_MEDIUM_COUNT_MIN, Math.round(Number((event.target as HTMLInputElement).value) || 16))
      );
      updateSuperMapSizeControls();
    });
    updateSuperMapSizeControls();
    this.app.querySelectorAll<HTMLInputElement>('[data-new-room-size]').forEach((input) => {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.newRoomSize);
        const fallback = this.newRoomSize[index];
        const value = Number(input.value);
        if (!Number.isFinite(value)) {
          input.value = String(fallback);
          return;
        }
        const minimum = index === 1 ? 2.2 : 3;
        const maximum = index === 1 ? 12 : 40;
        this.newRoomSize[index] = clampNumber(value, minimum, maximum);
        input.value = String(this.newRoomSize[index]);
      });
    });
    this.app.querySelector<HTMLSelectElement>('#new-map-asset-mode')?.addEventListener('change', (event) => {
      this.newMapAssetGenerationMode = normalizeModelGenerationMode((event.target as HTMLSelectElement).value);
      localStorage.setItem('worldforge.newMapAssetMode', this.newMapAssetGenerationMode);
    });
    this.app.querySelector<HTMLInputElement>('#new-player-height')?.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      this.newPlayerHeight = clampNumber(Number(input.value), 0.8, 2.4);
      input.value = String(this.newPlayerHeight);
    });
    this.app.querySelector<HTMLSelectElement>('#new-world-scale-profile')?.addEventListener('change', (event) => {
      this.newWorldScaleProfile = normalizeWorldScaleProfile((event.target as HTMLSelectElement).value);
    });
    this.app.querySelector<HTMLSelectElement>('#room-wall-display-mode')?.addEventListener('change', (event) => {
      this.roomWallDisplayMode = normalizeRoomWallDisplayMode((event.target as HTMLSelectElement).value);
      localStorage.setItem('worldforge.roomWallDisplayMode', this.roomWallDisplayMode);
      this.applyRoomWallDisplayMode();
    });
    this.app.querySelector('#add-object')?.addEventListener('click', () => this.addObject());
    this.app.querySelector('#save-map')?.addEventListener('click', () => void this.saveMap());
    this.app.querySelector('#confirm-map')?.addEventListener('click', () => void this.confirmMap());
    this.app.querySelector('#undo-edit')?.addEventListener('click', () => void this.undoManualEdit());
    this.app.querySelector('#redo-edit')?.addEventListener('click', () => void this.redoManualEdit());
    this.app.querySelector('#undo-transaction')?.addEventListener('click', () => void this.undoLatestTransaction());
    this.app.querySelector('#redo-transaction')?.addEventListener('click', () => void this.redoLatestTransaction());
    this.app.querySelectorAll<HTMLButtonElement>('[data-editor-export]').forEach((button) => {
      button.addEventListener('click', () => {
        void this.exportTransfer(button.dataset.editorExport as EditorExportKind);
        button.closest('details')?.removeAttribute('open');
      });
    });
    const importInput = this.app.querySelector<HTMLInputElement>('#import-transfer-file');
    this.app.querySelector('#import-transfer')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) void this.importTransfer(file);
    });
    this.app.querySelector('#editor-map-select')?.addEventListener('change', async (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const menu = select.closest('details');
      const id = select.value;
      if (!await this.loadMap(id)) this.renderMapSelector();
      else menu?.removeAttribute('open');
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        this.setView(button.dataset.view as keyof typeof VIEW_DIRECTIONS);
        button.closest('details')?.removeAttribute('open');
      });
    });
    this.app.querySelector<HTMLButtonElement>('[data-play-mode]')?.addEventListener('click', () => this.enterPlayMode());
    this.app.querySelector<HTMLButtonElement>('#toggle-developer-mode')?.addEventListener('click', () => {
      this.developerMode = !this.developerMode;
      localStorage.setItem('worldforge.developerMode', this.developerMode ? 'on' : 'off');
      this.renderStats?.setVisible(true);
      this.state.message = this.developerMode ? '已进入开发者模式' : '已退出开发者模式';
      this.renderRenderInspector();
      this.updateToolbarState();
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((button) => {
      button.addEventListener('click', () => {
        const stage = button.dataset.stage as EditorStage;
        if (stage === this.state.stage) return;
        if (stage === 'render') void this.confirmMap();
        else this.setStage(stage);
      });
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        this.cancelAssetPlacement();
        this.state.tool = button.dataset.tool as EditorTool;
        if (this.renderer) this.renderer.domElement.style.cursor = this.state.tool === 'select' ? 'default' : 'crosshair';
        if (this.brushPreview) this.brushPreview.visible = false;
        this.renderPanels();
      });
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-transform-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.transformMode as TransformMode;
        this.state.transformMode = this.isTranslateOnlySelection() ? 'translate' : mode;
        this.transform?.setMode(this.state.transformMode);
        this.renderPanels();
      });
    });
  }

  private setupViewport(): void {
    const host = this.app.querySelector<HTMLElement>('#editor-viewport');
    if (!host) return;
    // Identical wiring to `createMapViewer`, so what the editor previews is
    // what a downstream game renders.
    const renderScene = new RenderSceneRuntime({
      hdriUrl: (file) => `${serverHttpBase(location, import.meta.env.DEV)}/api/editor/hdri/${encodeURIComponent(file)}`
    });
    this.renderScene = renderScene;
    this.scene = renderScene.scene;
    this.camera = renderScene.camera;
    this.renderer = renderScene.renderer;
    const statsElement = host.querySelector<HTMLElement>('#viewport-stats');
    if (statsElement) {
      this.renderStats = new RenderStats(this.renderer.info, statsElement, 1000, {
        details: () => this.renderDebugDetails(),
        canExpand: () => this.developerMode,
        onTogglePass: (id, enabled) => this.renderScene?.adapter.setDebugPassEnabled(id, enabled)
      });
      this.renderStats.setVisible(true);
    }
    host.appendChild(this.renderer.domElement);

    this.playMode = new PlayModeController({
      canvas: this.renderer.domElement,
      camera: this.camera,
      getMap: () => this.state.map ? this.mapWithEditorAssets(this.state.map) : null,
      onActiveChange: (active) => this.setPlayModeActive(active),
      onInteraction: (position, speed, waterBodyId) => {
        if (speed <= 0.02) return;
        this.renderScene?.interact(position, performance.now() / 1000, waterBodyId);
      }
    });

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.enableRotate = true;
    this.orbit.enablePan = true;
    this.orbit.enableZoom = true;
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE
    };
    this.orbit.target.set(0, 1.5, 0);

    void this.reloadHdriTextures();
    this.brushPreview = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 64),
      new THREE.MeshBasicMaterial({
        color: 0xd9f47a,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        side: THREE.DoubleSide
      })
    );
    this.brushPreview.visible = false;
    this.brushPreview.renderOrder = 40;
    this.scene.add(this.brushPreview);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode(this.state.transformMode);
    this.transform.addEventListener('mouseDown', () => {
      this.transformPointerActive = true;
      this.beginHistoryGesture();
    });
    this.transform.addEventListener('mouseUp', () => {
      this.transformPointerActive = false;
      this.endHistoryGesture();
      if (this.selectedObject()?.roomOpeningId) void this.refreshScene();
    });
    this.transform.addEventListener('dragging-changed', (event) => {
      this.transformDragging = Boolean(event.value);
      if (this.orbit) this.orbit.enabled = !this.transformDragging;
    });
    this.transform.addEventListener('objectChange', () => this.syncSelectedTransform());
    const transformWithHelper = this.transform as TransformControls & {
      getHelper?: () => THREE.Object3D;
    };
    this.scene.add(
      typeof transformWithHelper.getHelper === 'function'
        ? transformWithHelper.getHelper()
        : this.transform as unknown as THREE.Object3D
    );

    this.renderer.domElement.addEventListener('pointerdown', this.handleOrbitPointerDownCapture, { capture: true });
    this.renderer.domElement.addEventListener('pointerdown', (event) => this.handlePointer(event, true));
    this.renderer.domElement.addEventListener('pointermove', (event) => this.handlePointer(event, false));
    this.renderer.domElement.addEventListener('pointerleave', this.hidePointerPreviews);
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('pointerup', this.handleGlobalPointerEnd);
    window.addEventListener('pointercancel', this.handleGlobalPointerEnd);
    window.addEventListener('blur', this.clearCameraKeys);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private setupAssetPreview(): void {
    this.previewScene = new THREE.Scene();
    this.previewScene.background = new THREE.Color(0x0d1214);
    this.previewCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 80);
    this.previewCamera.position.set(3, 2, 4);
    this.previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.previewRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.previewScene.add(new THREE.HemisphereLight(0xf5fbff, 0x2e332e, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 5, 3);
    this.previewScene.add(key);
    this.previewModelRoot = new THREE.Group();
    this.previewScene.add(this.previewModelRoot);
  }

  private async reloadLists(): Promise<void> {
    const [maps, assets, renderSchemes, assetLibraries] = await Promise.all([
      editorFetch<{ maps: MapSummary[] }>('/api/editor/maps'),
      editorFetch<{ assets: MapAsset[] }>('/api/editor/assets'),
      editorFetch<{ renderSchemes: RenderScheme[] }>('/api/editor/render-schemes'),
      editorFetch<{ libraries: AssetLibrary[] }>('/api/editor/asset-libraries')
    ]);
    this.state.maps = maps.maps;
    this.state.assets = assets.assets;
    this.state.renderSchemes = renderSchemes.renderSchemes;
    this.state.assetLibraries = assetLibraries.libraries;
    if (!this.state.assetLibraries.some((library) => library.id === this.activeAssetLibraryId)) {
      this.activeAssetLibraryId = this.state.assetLibraries[0]?.id ?? '';
    }
    this.state.libraryAssets = this.activeAssetLibraryId
      ? (await editorFetch<{ assets: MapAsset[] }>(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}`)).assets
      : [];
    if (!this.state.libraryAssets.some((asset) => asset.id === this.selectedLibraryAssetId)) {
      this.selectedLibraryAssetId = this.state.libraryAssets[0]?.id ?? '';
    }
    if (!this.state.map && this.state.maps[0]) {
      await this.loadMap(this.state.maps[0].id);
      return;
    }
    if (!this.state.map && this.state.maps.length === 0) {
      const { map } = await editorFetch<{ map: EditableMap }>('/api/editor/maps', {
        method: 'POST',
        body: JSON.stringify({ name: '未命名场景' })
      });
      this.state.map = normalizeMap(map);
      this.state.maps = [{
        id: map.id,
        name: map.name,
        version: map.version,
        updatedAt: map.updatedAt,
        width: map.box.size[0],
        height: map.box.size[1],
        depth: map.box.size[2],
        objectCount: map.objects.length,
        sceneMode: map.sceneMode,
        assetGenerationMode: map.assetGenerationMode,
        confirmedAt: map.confirmedAt,
        renderSchemeId: map.renderSchemeId
      }];
      this.resetManualHistory(this.state.map, true);
      await this.refreshScene();
    }
  }

  private async loadMap(id: string): Promise<boolean> {
    if (!id || id === this.state.map?.id) return true;
    if (!await this.confirmLeaveDirtyMap()) return false;
    this.cancelAssetPlacement();
    const [{ map }, { transaction, redoTransaction }] = await Promise.all([
      editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(id)}`),
      editorFetch<{ transaction: MapTransactionSummary | null; redoTransaction: MapTransactionSummary | null }>(
        `/api/editor/maps/${encodeURIComponent(id)}/transactions`
      )
    ]);
    this.state.map = normalizeMap(map);
    this.clearMapAiPreview();
    this.state.undoTransaction = transaction;
    this.state.redoTransaction = redoTransaction;
    this.state.selectedObjectId = null;
    this.state.stage = 'map';
    this.resetRenderDraft();
    this.state.dirty = false;
    this.resetManualHistory(this.state.map, true);
    await this.refreshScene();
    this.renderPanels();
    return true;
  }

  private async createMap(): Promise<void> {
    if (!await this.confirmLeaveDirtyMap()) return;
    const name = prompt('地图名称', '新地图');
    if (name === null) return;
    const preset = MAP_SIZE_PRESETS.find((item) => item.key === this.newMapSizePreset)
      ?? MAP_SIZE_PRESETS[1];
    const mapSize = this.newMapSceneMode === 'indoor'
      ? [...this.newRoomSize]
      : preset.key === 'super' ? superMapSizeFromMediumCount(this.newMapSuperMediumCount) : preset.size;
    this.cancelAssetPlacement();
    const { map } = await editorFetch<{ map: EditableMap }>('/api/editor/maps', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim() || '新地图',
        size: mapSize,
        sceneMode: this.newMapSceneMode,
        roomSize: this.newMapSceneMode === 'outdoor' ? undefined : this.newRoomSize,
        assetGenerationMode: this.newMapAssetGenerationMode,
        playerHeight: this.newPlayerHeight,
        worldScaleProfile: this.newWorldScaleProfile
      })
    });
    await this.reloadLists();
    this.state.map = normalizeMap(map);
    this.clearMapAiPreview();
    this.state.undoTransaction = null;
    this.state.redoTransaction = null;
    this.state.selectedObjectId = null;
    this.state.stage = 'map';
    this.resetRenderDraft();
    this.resetManualHistory(this.state.map, true);
    await this.refreshScene();
    this.renderPanels();
  }

  private async deleteCurrentMap(): Promise<void> {
    const map = this.state.map;
    if (!map || this.state.busy) return;
    if (!confirm(`确定删除地图“${map.name}”吗？\n\n地图内容无法撤销，但不会删除公共资产和渲染方案。`)) return;
    this.setBusy(true, '正在删除地图...');
    try {
      await editorFetch(`/api/editor/maps/${encodeURIComponent(map.id)}`, { method: 'DELETE' });
      this.state.map = null;
      this.state.selectedObjectId = null;
      this.clearMapAiPreview();
      this.resetRenderDraft();
      this.historyPast.length = 0;
      this.historyFuture.length = 0;
      this.historyPresent = null;
      await this.reloadLists();
      this.app.querySelector('.toolbar-project-menu')?.removeAttribute('open');
      this.state.message = '地图已删除';
      this.renderPanels();
    } catch (error) {
      this.state.message = `删除地图失败：${error instanceof Error ? error.message : '未知错误'}`;
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async saveMap(): Promise<boolean> {
    if (!this.state.map) return false;
    if (this.mapAiPreviewMap) {
      this.state.message = '请先应用或放弃 AI 地图预览';
      this.updateToolbarState();
      return false;
    }
    if (this.renderDraftChanged) {
      this.state.message = '请先保存渲染微调，或切换方案放弃预览';
      this.updateToolbarState();
      return false;
    }
    this.setBusy(true, '保存中...');
    try {
      const { map } = await editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(this.state.map.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ map: this.state.map })
      });
      this.state.map = normalizeMap(map);
      this.state.dirty = false;
      this.state.undoTransaction = null;
      this.state.redoTransaction = null;
      this.resetManualHistory(this.state.map, true);
      await this.reloadLists();
      this.state.message = '已保存';
      await this.refreshScene();
      this.renderPanels();
      return true;
    } catch (error) {
      this.state.message = `保存失败：${error instanceof Error ? error.message : '未知错误'}`;
      return false;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async undoLatestTransaction(): Promise<void> {
    if (!this.state.map || !this.state.undoTransaction || this.state.dirty || this.mapAiPreviewMap) return;
    this.setBusy(true, '撤销事务中...');
    try {
      const { map, transaction } = await editorFetch<{ map: EditableMap; transaction: MapTransactionSummary }>(
        `/api/editor/maps/${encodeURIComponent(this.state.map.id)}/transactions/undo`,
        { method: 'POST' }
      );
      this.state.map = normalizeMap(map);
      this.clearMapAiPreview();
      this.state.undoTransaction = null;
      this.state.redoTransaction = transaction;
      this.state.selectedObjectId = null;
      this.state.message = `已撤销：${transaction.label}`;
      this.resetManualHistory(this.state.map, true);
      await this.reloadLists();
      await this.refreshScene();
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async redoLatestTransaction(): Promise<void> {
    if (!this.state.map || !this.state.redoTransaction || this.state.dirty || this.mapAiPreviewMap) return;
    this.setBusy(true, '正在重做事务...');
    try {
      const { map, transaction } = await editorFetch<{ map: EditableMap; transaction: MapTransactionSummary }>(
        `/api/editor/maps/${encodeURIComponent(this.state.map.id)}/transactions/redo`,
        { method: 'POST' }
      );
      this.state.map = normalizeMap(map);
      this.clearMapAiPreview();
      this.state.undoTransaction = transaction;
      this.state.redoTransaction = null;
      this.state.selectedObjectId = null;
      this.state.message = `已重做：${transaction.label}`;
      this.resetManualHistory(this.state.map, true);
      await this.reloadLists();
      await this.refreshScene();
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private addObject(): void {
    if (!this.state.map || this.mapAiPreviewMap) return;
    const object = createMapObject(`物体 ${this.state.map.objects.length + 1}`, null);
    const target = this.orbit?.target;
    if (target) {
      object.transform.position = [
        target.x,
        sampleTerrainHeight(this.state.map, target.x, target.z),
        target.z
      ];
    }
    this.state.map.objects.push(object);
    this.state.selectedObjectId = object.id;
    this.markDirty();
    void this.refreshScene();
    this.renderPanels();
  }

  private deleteSelectedObject(): void {
    const map = this.state.map;
    const object = this.selectedObject();
    if (!map || !object || this.mapAiPreviewMap) return;
    map.objects = map.objects
      .filter((item) => item.id !== object.id)
      .map((item) => item.parentId === object.id ? { ...item, parentId: null } : item);
    this.state.selectedObjectId = null;
    this.markDirty();
    void this.refreshScene();
    this.renderPanels();
  }

  private duplicateSelectedObject(): void {
    const map = this.state.map;
    const source = this.selectedObject();
    if (!map || !source || this.mapAiPreviewMap) return;
    const copy = createMapObject(`${source.name} 副本`, source.assetId);
    copy.parentId = source.parentId;
    copy.visible = source.visible;
    copy.locked = source.locked;
    copy.transform = {
      position: [source.transform.position[0] + 0.5, source.transform.position[1], source.transform.position[2] + 0.5],
      rotation: [...source.transform.rotation],
      scale: [...source.transform.scale],
      size: [...source.transform.size]
    };
    map.objects.push(copy);
    this.state.selectedObjectId = copy.id;
    this.markDirty();
    void this.refreshScene();
    this.renderPanels();
  }

  private renderPanels(): void {
    this.renderStats?.setVisible(true);
    this.renderMapSelector();
    this.renderHierarchy();
    const mapStage = this.state.stage === 'map';
    const mapAiHost = this.app.querySelector<HTMLElement>('#map-ai-panel');
    if (mapAiHost) mapAiHost.hidden = !mapStage;
    const mapEditorHidden = !mapStage || Boolean(this.mapAiPreviewMap);
    for (const id of ['map-inspector', 'object-inspector', 'asset-panel']) {
      const host = this.app.querySelector<HTMLElement>(`#${id}`);
      if (host) host.hidden = mapEditorHidden;
    }
    const renderHost = this.app.querySelector<HTMLElement>('#render-inspector');
    if (renderHost) renderHost.hidden = mapStage;
    if (mapStage) {
      this.renderMapAiPanel();
      if (!this.mapAiPreviewMap) {
        this.renderMapInspector();
        this.renderObjectInspector();
        this.renderAssetPanel();
      }
    } else {
      this.renderRenderInspector();
    }
    const heading = this.app.querySelector<HTMLElement>('.inspector-heading strong');
    const headingMode = this.app.querySelector<HTMLElement>('.inspector-heading small');
    if (heading) heading.textContent = mapStage
      ? this.mapAiPreviewMap ? '地图预览' : '属性'
      : '渲染方案';
    if (headingMode) headingMode.textContent = mapStage ? 'MAP' : 'RENDER';
    this.attachSelectedTransform();
    this.updateToolbarState();
  }

  private renderMapAiPanel(): void {
    const host = this.app.querySelector<HTMLElement>('#map-ai-panel');
    if (!host) return;
    const map = this.state.map;
    if (!map) {
      host.innerHTML = '';
      return;
    }
    const suggestion = this.mapAiSuggestion;
    const isTerrainPreview = this.mapPreviewKind === 'terrain';
    const terrainCount = suggestion?.operations.filter((operation) => operation.type.startsWith('terrain.')).length ?? 0;
    const waterCount = suggestion?.operations.filter((operation) => operation.type.startsWith('water.')).length ?? 0;
    const objectCount = suggestion?.operations.filter((operation) => operation.type.startsWith('object.')).length ?? 0;
    const hasSpawn = suggestion?.operations.some((operation) => operation.type === 'reference.set') ?? false;
    const compositionAvailable = isCompositionEmptyMap(map);
    const visualZones = map.visualSemantics.zones;
    if (this.mapAiTargetVisualZoneId && !visualZones.some((zone) => zone.id === this.mapAiTargetVisualZoneId)) {
      this.mapAiTargetVisualZoneId = '';
    }
    const generationBlocked = this.state.busy || this.state.dirty || !this.mapAiPrompt.trim() || !compositionAvailable || Boolean(this.pendingCompositionPlan);
    const refinementBlocked = generationBlocked || !hasRefinableMapContent(map);
    const mapAiOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="map-ai"]')?.open ?? true;
    const layoutHtml = map.sceneMode === 'indoor' ? '' : this.renderMapLayoutHtml(map);
    host.innerHTML = `
      ${layoutHtml}
      <details class="inspector-disclosure" data-inspector-section="map-ai" ${mapAiOpen || this.state.busy || Boolean(suggestion) ? 'open' : ''}>
        <summary><span><b>${map.sceneMode === 'indoor' ? 'AI 生成室内场景' : 'AI 生成地图'}</b><small>一句话生成或继续调整</small></span></summary>
        <section class="editor-section inspector-body map-ai">
        <textarea id="map-ai-prompt" rows="2" maxlength="1200" placeholder="${map.sceneMode === 'indoor' ? '例如：一间 1980 年代的教室' : '例如：一片树林里散布着许多小木屋'}" ${this.state.busy || this.pendingCompositionPlan ? 'disabled' : ''}>${escapeHtml(this.mapAiPrompt)}</textarea>
        <p class="empty inspector-note">建议只写一句场景描述；AI 会自行安排坐标、数量、密度和空间关系。</p>
        <div class="map-ai-options">
          ${map.sceneMode === 'indoor' ? `<label class="field compact map-ai-toggle">
            <span>生成资产前先确认俯视规划</span>
            <input id="map-ai-confirm-plan" type="checkbox" ${this.mapAiConfirmCompositionPlan ? 'checked' : ''} ${this.state.busy || this.pendingCompositionPlan ? 'disabled' : ''} />
          </label>` : ''}
          <label class="field compact map-ai-toggle">
            <span>允许使用所选资产库</span>
            <input id="map-ai-reuse-assets" type="checkbox" ${this.mapAiReuseExistingAssets ? 'checked' : ''} ${this.state.busy || !this.activeAssetLibraryId ? 'disabled' : ''} />
          </label>
          <label class="field compact">
            <span>本次使用的资产库</span>
            <select id="map-ai-asset-library" ${this.state.busy || this.state.assetLibraries.length === 0 ? 'disabled' : ''}>
              ${this.state.assetLibraries.length === 0 ? '<option value="">尚未创建资产库</option>' : this.state.assetLibraries.map((library) => `
                <option value="${library.id}" ${library.id === this.activeAssetLibraryId ? 'selected' : ''}>${escapeHtml(library.name)} · ${library.assetIds.length} 个</option>
              `).join('')}
            </select>
          </label>
          <label class="field compact">
            <span>本次最少生成新资产</span>
            <input id="map-ai-min-new-assets" type="number" min="0" max="${this.mapAiMaxNewAssets}" step="1" value="${this.mapAiMinNewAssets}" ${this.state.busy ? 'disabled' : ''} />
          </label>
          <label class="field compact">
            <span>本次最多生成新资产</span>
            <input id="map-ai-max-new-assets" type="number" min="0" max="${MAP_AI_MAX_NEW_ASSETS}" step="1" value="${this.mapAiMaxNewAssets}" ${this.state.busy ? 'disabled' : ''} />
          </label>
          ${visualZones.length > 0 ? `<label class="field compact">
            <span>Refine 适用区域</span>
            <select id="map-ai-target-zone" ${this.state.busy ? 'disabled' : ''}>
              <option value="">整张地图</option>
              ${visualZones.map((zone) => `<option value="${escapeHtml(zone.id)}" ${zone.id === this.mapAiTargetVisualZoneId ? 'selected' : ''}>${escapeHtml(zone.id)} · ${escapeHtml(zone.tags.join(', ') || '未标记')}</option>`).join('')}
            </select>
          </label>` : ''}
        </div>
        <div class="map-ai-controls">
          <button id="generate-map-ai" ${generationBlocked ? 'disabled' : ''}>${map.sceneMode === 'indoor' && this.mapAiConfirmCompositionPlan ? '先生成俯视规划' : '生成新规划'}</button>
          <button id="refine-map-ai" class="secondary" ${refinementBlocked ? 'disabled' : ''}>调整当前地图</button>
          ${this.mapAiAbortController ? '<button id="cancel-map-ai" class="secondary">取消</button>' : ''}
        </div>
        ${renderAgentProgress(this.mapAgentProgress, {
          running: Boolean(this.mapAiAbortController),
          elapsedMs: this.mapAgentElapsedMs,
          slowAssetMode: map.assetGenerationMode === 'standard' || map.assetGenerationMode === 'voxel-pro'
        })}
        <p class="empty inspector-note" title="总导演会先组织完整场景，按需调用最多 ${SCENE_COMPOSITION_LIMITS.consultationCount} 个专家；未开启复用时，新内容只使用本次生成的资产。">默认 ${map.assetGenerationMode.toUpperCase()} · ${this.state.dirty
          ? '请先保存当前手工修改，再生成 AI 地图预览。'
          : !compositionAvailable
            ? '当前地图已有内容，请使用“调整当前地图”继续 Refine。'
            : `总导演编排场景 · 生成 ${this.mapAiMinNewAssets}-${this.mapAiMaxNewAssets} 个新资产`}</p>
        </section>
      </details>
      ${this.pendingCompositionPlan ? renderMapCompositionPlanApproval(this.pendingCompositionPlan) : ''}
      ${suggestion && this.mapAiPreviewMap ? `
        <section class="editor-section map-ai-result">
          <span class="stage-kicker">${isTerrainPreview ? '地形编辑预览' : 'AI 地图建议'}</span>
          <h2>${escapeHtml(suggestion.summary)}</h2>
          <div class="preview-comparison segmented compact" aria-label="地图 Refine 前后对比">
            <button type="button" data-map-preview-view="before" class="${this.mapAiPreviewVisible ? '' : 'active'}">修改前</button>
            <button type="button" data-map-preview-view="after" class="${this.mapAiPreviewVisible ? 'active' : ''}">修改后预览</button>
          </div>
          <div class="map-ai-stats">
            <span>地形 <b>${terrainCount}</b></span>
            <span>水域修改 <b>${waterCount}</b></span>
            <span>物体修改 <b>${objectCount}</b></span>
            <span>出生点 <b>${hasSpawn ? '有' : '无'}</b></span>
          </div>
          ${renderMapCompositionSummary(suggestion)}
          ${suggestion.renderPromptSuggestions.length > 0 ? `
            <div>
              <p class="empty">留给渲染阶段的建议</p>
              <div class="style-tags">${suggestion.renderPromptSuggestions.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${suggestion.generatedAssets.length > 0 ? `
            <div>
              <p class="empty">本次自动生成的共享资产</p>
              <div class="style-tags">${suggestion.generatedAssets.map((asset) => `<span>${escapeHtml(asset.name)}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${(suggestion.reusedAssets?.length ?? 0) > 0 ? `
            <details class="inspector-disclosure compact">
              <summary><span><b>高级详情</b><small>资产来源</small></span></summary>
              <div class="style-tags">${suggestion.reusedAssets?.map((asset) => `<span>资产库 · ${escapeHtml(asset.name)}</span>`).join('')}</div>
            </details>
          ` : ''}
          ${!suggestion.composition && (suggestion.diagnostics?.length ?? 0) > 0 ? `
            <div>
              <p class="empty">自动质检</p>
              <div class="style-tags">${suggestion.diagnostics?.map((issue) => `
                <span>${issue.repaired ? '已修复' : '建议'} · ${escapeHtml(issue.message)}</span>
              `).join('')}</div>
            </div>
          ` : ''}
          <div class="map-ai-actions">
            <button id="discard-map-ai" class="secondary">放弃预览</button>
            <button id="apply-map-ai">应用到地图</button>
          </div>
        </section>
      ` : ''}
    `;
    this.bindMapLayoutPanel(host, map);
    host.querySelector<HTMLTextAreaElement>('#map-ai-prompt')?.addEventListener('input', (event) => {
      this.mapAiPrompt = (event.target as HTMLTextAreaElement).value;
      const blocked = this.state.busy || this.state.dirty || !this.mapAiPrompt.trim();
      const generateButton = host.querySelector<HTMLButtonElement>('#generate-map-ai');
      const refineButton = host.querySelector<HTMLButtonElement>('#refine-map-ai');
      if (generateButton) generateButton.disabled = blocked || !isCompositionEmptyMap(map);
      if (refineButton) refineButton.disabled = blocked || !hasRefinableMapContent(map);
    });
    host.querySelector<HTMLInputElement>('#map-ai-reuse-assets')?.addEventListener('change', (event) => {
      this.mapAiReuseExistingAssets = (event.target as HTMLInputElement).checked;
    });
    host.querySelector<HTMLInputElement>('#map-ai-confirm-plan')?.addEventListener('change', (event) => {
      this.mapAiConfirmCompositionPlan = (event.target as HTMLInputElement).checked;
      this.renderMapAiPanel();
    });
    host.querySelector<HTMLSelectElement>('#map-ai-asset-library')?.addEventListener('change', async (event) => {
      await this.selectAssetLibrary((event.target as HTMLSelectElement).value);
      this.renderPanels();
    });
    const updateAssetRange = () => {
      const minInput = host.querySelector<HTMLInputElement>('#map-ai-min-new-assets');
      const maxInput = host.querySelector<HTMLInputElement>('#map-ai-max-new-assets');
      const range = normalizeMapAiNewAssetRange(minInput?.value, maxInput?.value);
      this.mapAiMinNewAssets = range.min;
      this.mapAiMaxNewAssets = range.max;
      if (minInput) {
        minInput.max = String(range.max);
        minInput.value = String(range.min);
      }
      if (maxInput) maxInput.value = String(range.max);
    };
    for (const selector of ['#map-ai-min-new-assets', '#map-ai-max-new-assets']) {
      const input = host.querySelector<HTMLInputElement>(selector);
      input?.addEventListener('change', updateAssetRange);
      input?.addEventListener('blur', updateAssetRange);
    }
    host.querySelector<HTMLSelectElement>('#map-ai-target-zone')?.addEventListener('change', (event) => {
      this.mapAiTargetVisualZoneId = (event.target as HTMLSelectElement).value;
    });
    host.querySelector('#generate-map-ai')?.addEventListener('click', () => {
      this.mapAiBaseTerrainOnly = false;
      this.mapAiTargetRegionId = '';
      if (map.sceneMode === 'indoor' && this.mapAiConfirmCompositionPlan) void this.generateCompositionPlanPreview();
      else void this.generateMapAiPreview('generate');
    });
    host.querySelector('#refine-map-ai')?.addEventListener('click', () => {
      this.mapAiBaseTerrainOnly = false;
      this.mapAiTargetRegionId = '';
      void this.generateMapAiPreview('refine');
    });
    host.querySelector('#cancel-map-ai')?.addEventListener('click', () => {
      this.mapAiAbortController?.abort();
      this.state.message = '正在取消地图 Agent...';
      this.updateToolbarState();
    });
    host.querySelector('#discard-map-ai')?.addEventListener('click', () => void this.discardMapAiPreview());
    host.querySelector('#apply-map-ai')?.addEventListener('click', () => void this.applyMapAiPreview());
    host.querySelector('#discard-composition-plan')?.addEventListener('click', () => {
      this.pendingCompositionPlan = null;
      this.state.message = '已放弃俯视规划，可以修改提示词后重试';
      this.renderPanels();
    });
    host.querySelector('#regenerate-composition-plan')?.addEventListener('click', () => {
      this.pendingCompositionPlan = null;
      void this.generateCompositionPlanPreview();
    });
    host.querySelector('#approve-composition-plan')?.addEventListener('click', () => {
      if (this.pendingCompositionPlan) void this.generateMapAiPreview('generate', this.pendingCompositionPlan);
    });
    host.querySelectorAll<HTMLButtonElement>('[data-map-preview-view]').forEach((button) => {
      button.addEventListener('click', async () => {
        this.mapAiPreviewVisible = button.dataset.mapPreviewView === 'after';
        await this.refreshScene();
        this.renderMapAiPanel();
        this.updateToolbarState();
      });
    });
  }

  private renderMapLayoutHtml(map: EditableMap): string {
    const layout = this.mapLayoutSuggestion?.layout ?? map.layout;
    const regionLimit = maxMapRegionCount(map.box.size);
    const selected = layout.regions.find((region) => region.id === this.selectedEcologyRegionId)
      ?? layout.regions[0];
    if (selected && !this.selectedEcologyRegionId) this.selectedEcologyRegionId = selected.id;
    const halfWidth = map.box.size[0] / 2;
    const halfDepth = map.box.size[2] / 2;
    const svgPoints = (region: MapEcologyRegion) => region.points
      .map(([x, z]) => `${((x + halfWidth) / map.box.size[0]) * 100},${((z + halfDepth) / map.box.size[2]) * 100}`)
      .join(' ');
    const regionOptions = layout.regions.map((region) => `
      <option value="${escapeHtml(region.id)}" ${region.id === selected?.id ? 'selected' : ''}>${escapeHtml(region.name)}</option>
    `).join('');
    const stitchedSourceIds = new Set(map.layout.stitchSources.map((source) => source.mapId));
    const stitchMaps = this.state.maps.filter((item) => item.id !== map.id && !stitchedSourceIds.has(item.id));
    const selectedSeam = map.layout.seams.find((seam) => seam.id === this.selectedStitchSeamId)
      ?? map.layout.seams[0];
    const compositeEdgeMask = map.layout.edgeMask.kind === 'composite';
    if (selectedSeam && !this.selectedStitchSeamId) this.selectedStitchSeamId = selectedSeam.id;
    const layoutOpen = this.app.querySelector<HTMLDetailsElement>('[data-inspector-section="map-layout"]')?.open ?? true;
    return `
      <details class="inspector-disclosure" data-inspector-section="map-layout" ${layoutOpen ? 'open' : ''}>
        <summary><span><b>生态分区与地图拼接</b><small>先规划区块，再分别生成</small></span></summary>
        <section class="editor-section inspector-body map-layout-panel">
          <label class="field compact">
            <span>全地图提示词（建议一句话）</span>
            <textarea id="map-layout-global-prompt" rows="2" maxlength="1200" placeholder="例如：群山环绕的森林谷地，林中散布许多小木屋，东侧有湖泊" ${this.state.busy || Boolean(this.mapLayoutSuggestion) ? 'disabled' : ''}>${escapeHtml(layout.globalPrompt)}</textarea>
          </label>
          <p class="empty inspector-note">写整体环境、2–3 个主要内容和大致关系；不写坐标、数量参数或生成步骤。</p>
          <button id="generate-map-base-terrain" class="secondary" ${this.state.busy || this.state.dirty || !map.layout.globalPrompt.trim() || Boolean(this.mapLayoutSuggestion) || Boolean(this.mapAiPreviewMap) ? 'disabled' : ''}>生成全局基础地形</button>
          <div class="map-layout-planner">
            <textarea id="map-layout-prompt" rows="2" maxlength="800" placeholder="例如：四等分，右上角区域更大" ${this.state.busy ? 'disabled' : ''}>${escapeHtml(this.mapLayoutPrompt)}</textarea>
            <div class="map-ai-controls">
              <button id="plan-map-layout" ${this.state.busy || this.state.dirty || !this.mapLayoutPrompt.trim() ? 'disabled' : ''}>AI 规划分区</button>
              ${this.mapLayoutAbortController ? '<button id="cancel-map-layout" class="secondary">中断</button>' : ''}
            </div>
          </div>
          ${renderAgentProgress(this.mapLayoutProgress, {
            running: Boolean(this.mapLayoutAbortController),
            elapsedMs: this.mapLayoutElapsedMs
          })}
          ${this.mapLayoutSuggestion ? `<div class="map-layout-suggestion"><b>${escapeHtml(this.mapLayoutSuggestion.summary)}</b><span>先检查轮廓；确认后才会显示各区块的建议提示词和生成工具。</span><div class="map-layout-actions"><button id="apply-map-layout" class="map-layout-confirm">确认并使用此分区</button><button id="discard-map-layout" class="secondary">放弃这次规划</button></div></div>` : ''}
          <svg class="map-layout-canvas" viewBox="0 0 100 100" role="img" aria-label="生态分区预览">
            ${layout.regions.map((region, regionIndex) => `
              <polygon data-layout-region="${escapeHtml(region.id)}" points="${svgPoints(region)}" fill="${escapeHtml(region.color)}" class="${region.id === selected?.id ? 'selected' : ''}" />
              ${this.mapLayoutSuggestion ? '' : region.points.map(([x, z], pointIndex) => `<circle class="map-layout-vertex" data-region-index="${regionIndex}" data-point-index="${pointIndex}" cx="${((x + halfWidth) / map.box.size[0]) * 100}" cy="${((z + halfDepth) / map.box.size[2]) * 100}" r="1.3" />`).join('')}
            `).join('')}
          </svg>
          <p class="empty inspector-note">${this.mapLayoutSuggestion ? `${layout.regions.length} 个区块待确认 · 当前只显示分区轮廓` : `${layout.regions.length}/${regionLimit} 个区块 · 拖动公共顶点可调整边界 · 空提示词只保留基础地形`}</p>
          ${this.mapLayoutSuggestion ? '' : `<div class="map-ai-controls"><button id="add-map-region" class="secondary" ${layout.regions.length >= regionLimit ? 'disabled' : ''}>新增区块</button><button id="delete-map-region" class="secondary" ${!selected ? 'disabled' : ''}>删除区块</button></div>`}
          ${!this.mapLayoutSuggestion && selected ? `<div class="map-region-editor">
            <label class="field compact"><span>当前区块</span><select id="map-layout-region-select">${regionOptions}</select></label>
            <label class="field compact"><span>名称</span><input id="map-layout-region-name" value="${escapeHtml(selected.name)}" ${this.mapLayoutSuggestion ? 'disabled' : ''} /></label>
            <label class="field compact"><span>区块提示词（建议一句话）</span><textarea id="map-layout-region-prompt" rows="2" maxlength="1200" placeholder="例如：针叶林里散布小木屋，靠湖一侧逐渐稀疏" ${this.mapLayoutSuggestion ? 'disabled' : ''}>${escapeHtml(selected.prompt)}</textarea></label>
            <p class="empty inspector-note">只写这个区块的生态或地标；AI 会决定密度、位置和边界过渡。</p>
            <label class="field compact"><span>生态组</span><input id="map-layout-region-group" value="${escapeHtml(selected.groupId ?? '')}" placeholder="例如：湿地" ${this.mapLayoutSuggestion ? 'disabled' : ''} /></label>
            <div class="map-layout-locks">
              <label><input id="map-layout-boundary-lock" type="checkbox" ${selected.boundaryLocked ? 'checked' : ''} ${this.mapLayoutSuggestion ? 'disabled' : ''}/> 锁定边界</label>
              <label><input id="map-layout-content-lock" type="checkbox" ${selected.contentLocked ? 'checked' : ''} ${this.mapLayoutSuggestion ? 'disabled' : ''}/> 锁定内容</label>
            </div>
            <div class="map-ai-controls">
              <button id="split-map-region-x" class="secondary" ${this.mapLayoutSuggestion || layout.regions.length >= regionLimit ? 'disabled' : ''}>横向拆分</button>
              <button id="split-map-region-z" class="secondary" ${this.mapLayoutSuggestion || layout.regions.length >= regionLimit ? 'disabled' : ''}>纵向拆分</button>
              <button id="merge-map-region" class="secondary" ${this.mapLayoutSuggestion || layout.regions.length < 2 ? 'disabled' : ''}>与下一块合并</button>
              <button id="generate-map-region" ${this.mapLayoutSuggestion || selected.contentLocked || !selected.prompt.trim() || this.state.busy || this.mapAiPreviewMap ? 'disabled' : ''}>生成此区块</button>
            </div>
          </div>` : ''}
          <details class="inspector-disclosure compact">
            <summary><span><b>边缘裁切</b><small>非破坏式遮罩</small></span></summary>
            <div class="map-layout-subpanel">
              <label class="field compact"><span>形状</span><select id="map-edge-mask-kind" ${this.mapLayoutSuggestion ? 'disabled' : ''}>
                ${(['none', 'circle', 'heart', 'noise', 'polygon', ...(map.layout.edgeMask.kind === 'composite' ? ['composite' as const] : [])] as MapEdgeMaskKind[]).map((kind) => `<option value="${kind}" ${map.layout.edgeMask.kind === kind ? 'selected' : ''}>${({ none: '不裁切', circle: '圆形', heart: '爱心形', noise: '噪声边缘', polygon: '自定义多边形', composite: '保留拼接轮廓' })[kind]}</option>`).join('')}
              </select></label>
              <label class="field compact"><span>噪声强度</span><input id="map-edge-irregularity" type="range" min="0" max="0.45" step="0.01" value="${map.layout.edgeMask.irregularity}" ${this.mapLayoutSuggestion || compositeEdgeMask ? 'disabled' : ''}/></label>
              <label class="field compact"><span>随机种子</span><input id="map-edge-seed" type="number" value="${map.layout.edgeMask.seed}" ${this.mapLayoutSuggestion || compositeEdgeMask ? 'disabled' : ''}/></label>
              <button id="edge-from-selected-region" class="secondary" ${!selected || this.mapLayoutSuggestion ? 'disabled' : ''}>用当前区块轮廓裁切</button>
            </div>
          </details>
          <details class="inspector-disclosure compact">
            <summary><span><b>拼接地图</b><small>源地图保持不变</small></span></summary>
            <div class="map-layout-subpanel">
              <label class="field compact"><span>另一张地图</span><select id="stitch-source-map" ${stitchMaps.length === 0 ? 'disabled' : ''}>${stitchMaps.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('') || '<option>没有其他地图</option>'}</select></label>
              <div class="map-layout-grid">
                <label class="field compact"><span>方向</span><select id="stitch-direction"><option value="east">右侧</option><option value="west">左侧</option><option value="north">上侧</option><option value="south">下侧</option></select></label>
                <label class="field compact"><span>连接</span><select id="stitch-mode"><option value="contact">直接接触</option><option value="corridor">生成过渡带</option></select></label>
                <label class="field compact"><span>过渡宽度</span><input id="stitch-width" type="number" min="8" max="96" value="24" /></label>
                <label class="field compact"><span>接缝抖动</span><input id="stitch-irregularity" type="number" min="0" max="0.65" step="0.05" value="0.2" /></label>
              </div>
              <label class="field compact"><span>过渡带语义备注（可空）</span><input id="stitch-prompt" placeholder="例如：稀疏灌木与碎石坡" /></label>
              <button id="stitch-map" ${this.state.busy || this.state.dirty || stitchMaps.length === 0 ? 'disabled' : ''}>拼接为新地图</button>
              ${selectedSeam ? `<div class="map-stitch-seam-editor">
                <b>已有接缝单独调整</b>
                <label class="field compact"><span>接缝</span><select id="stitch-seam-select">${map.layout.seams.map((seam) => `<option value="${escapeHtml(seam.id)}" ${seam.id === selectedSeam.id ? 'selected' : ''}>${escapeHtml(seam.name)}</option>`).join('')}</select></label>
                <div class="map-layout-grid">
                  <label class="field compact"><span>宽度</span><input id="stitch-seam-width" type="number" min="8" max="96" value="${selectedSeam.width}" ${selectedSeam.locked ? 'disabled' : ''}/></label>
                  <label class="field compact"><span>抖动</span><input id="stitch-seam-irregularity" type="number" min="0" max="0.65" step="0.05" value="${selectedSeam.irregularity}" ${selectedSeam.locked ? 'disabled' : ''}/></label>
                  <label class="field compact"><span>种子</span><input id="stitch-seam-seed" type="number" value="${selectedSeam.seed}" ${selectedSeam.locked ? 'disabled' : ''}/></label>
                  <label class="map-stitch-lock"><input id="stitch-seam-lock" type="checkbox" ${selectedSeam.locked ? 'checked' : ''}/> 锁定接缝</label>
                </div>
                <label class="field compact"><span>接缝语义备注</span><input id="stitch-seam-prompt" value="${escapeHtml(selectedSeam.prompt)}" ${selectedSeam.locked ? 'disabled' : ''}/></label>
                <button id="retune-stitch-seam" class="secondary" ${this.state.busy || this.state.dirty ? 'disabled' : ''}>${selectedSeam.locked ? '解锁接缝' : '重新计算接缝高度'}</button>
              </div>` : ''}
            </div>
          </details>
        </section>
      </details>
    `;
  }

  private bindMapLayoutPanel(host: HTMLElement, map: EditableMap): void {
    const activeLayout = () => map.layout;
    const commitLayoutChange = async () => {
      reassignRegionGenerationOwnersInPlace(map);
      this.markDirty();
      await this.refreshScene();
      this.renderMapAiPanel();
      this.updateToolbarState();
    };
    host.querySelector<HTMLTextAreaElement>('#map-layout-prompt')?.addEventListener('input', (event) => {
      this.mapLayoutPrompt = (event.target as HTMLTextAreaElement).value;
      const button = host.querySelector<HTMLButtonElement>('#plan-map-layout');
      if (button) button.disabled = this.state.busy || this.state.dirty || !this.mapLayoutPrompt.trim();
    });
    host.querySelector<HTMLTextAreaElement>('#map-layout-global-prompt')?.addEventListener('change', (event) => {
      map.layout.globalPrompt = (event.target as HTMLTextAreaElement).value.trim();
      void commitLayoutChange();
    });
    host.querySelector('#generate-map-base-terrain')?.addEventListener('click', async () => {
      if (!map.layout.globalPrompt.trim() || this.state.dirty) return;
      this.mapAiBaseTerrainOnly = true;
      this.mapAiTargetRegionId = '';
      this.mapAiPrompt = map.layout.globalPrompt;
      await this.generateMapAiPreview('refine');
    });
    host.querySelector('#plan-map-layout')?.addEventListener('click', async () => {
      if (!this.mapLayoutPrompt.trim() || this.state.dirty || this.state.busy) return;
      const controller = new AbortController();
      this.mapLayoutAbortController = controller;
      this.mapLayoutProgress = [];
      this.startMapLayoutProgressTimer();
      this.setBusy(true, 'AI 正在规划生态分区...');
      this.renderMapAiPanel();
      try {
        const result = await editorAgentFetch<{ suggestion: { summary: string; layout: MapLayout } }>(
          `/api/editor/maps/${encodeURIComponent(map.id)}/layout`,
          {
            method: 'POST',
            body: JSON.stringify({ prompt: this.mapLayoutPrompt, provider: this.mapAiProvider }),
            signal: controller.signal
          },
          (event) => {
            updateAgentProgress(this.mapLayoutProgress, event);
            this.renderMapAiPanel();
          }
        );
        this.mapLayoutSuggestion = result.suggestion;
        this.selectedEcologyRegionId = result.suggestion.layout.regions[0]?.id ?? '';
        this.state.message = '生态分区预览已生成，尚未应用';
      } catch (error) {
        const cancelled = error instanceof Error && error.name === 'AbortError';
        const detail = humanizeAgentError(error);
        updateAgentProgress(this.mapLayoutProgress, {
          phase: 'failed',
          label: cancelled ? '分区规划已取消' : '分区规划失败',
          detail
        });
        this.state.message = cancelled ? '已取消分区规划' : `分区规划失败：${detail}`;
      } finally {
        if (this.mapLayoutAbortController === controller) this.mapLayoutAbortController = null;
        this.stopMapLayoutProgressTimer();
        this.setBusy(false);
        this.renderMapAiPanel();
      }
    });
    host.querySelector('#cancel-map-layout')?.addEventListener('click', () => {
      this.mapLayoutAbortController?.abort();
      this.state.message = '正在中断分区规划...';
      this.updateToolbarState();
    });
    host.querySelector('#discard-map-layout')?.addEventListener('click', () => {
      this.mapLayoutSuggestion = null;
      this.selectedEcologyRegionId = map.layout.regions[0]?.id ?? '';
      this.renderMapAiPanel();
    });
    host.querySelector('#apply-map-layout')?.addEventListener('click', () => {
      if (!this.mapLayoutSuggestion) return;
      map.layout = this.mapLayoutSuggestion.layout;
      this.mapLayoutSuggestion = null;
      this.selectedEcologyRegionId = map.layout.regions[0]?.id ?? '';
      void commitLayoutChange();
    });
    host.querySelector<HTMLSelectElement>('#map-layout-region-select')?.addEventListener('change', (event) => {
      this.selectedEcologyRegionId = (event.target as HTMLSelectElement).value;
      this.renderMapAiPanel();
    });
    const selectedRegion = () => activeLayout().regions.find((region) => region.id === this.selectedEcologyRegionId)
      ?? activeLayout().regions[0];
    host.querySelector('#add-map-region')?.addEventListener('click', () => {
      const selected = selectedRegion();
      if (!selected) {
        const index = map.layout.regions.length + 1;
        map.layout.regions.push({
          id: `region-${index}`,
          name: `区块 ${index}`,
          prompt: '',
          groupId: null,
          color: '#4f8fdd',
          points: rectanglePolygon(map.box.size),
          boundaryLocked: false,
          contentLocked: false
        });
        this.selectedEcologyRegionId = map.layout.regions[0]?.id ?? '';
        void commitLayoutChange();
        return;
      }
      const xs = selected.points.map((point) => point[0]);
      const zs = selected.points.map((point) => point[1]);
      const axis = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs) ? 'x' : 'z';
      const next = splitMapRegion(selected, axis);
      if (!next) return;
      map.layout.regions.splice(map.layout.regions.indexOf(selected), 1, ...next);
      this.selectedEcologyRegionId = next[1].id;
      void commitLayoutChange();
    });
    host.querySelector('#delete-map-region')?.addEventListener('click', () => {
      const selected = selectedRegion();
      if (!selected) return;
      const previousRegions = structuredClone(map.layout.regions);
      if (map.layout.regions.length === 1) {
        map.layout.regions = [];
        this.selectedEcologyRegionId = '';
      } else {
        const index = map.layout.regions.indexOf(selected);
        const neighbor = findAdjacentMapRegion(map.layout.regions, selected);
        if (!neighbor) {
          this.state.message = '当前区块没有可合并的公共边界';
          this.updateToolbarState();
          return;
        }
        if (selected.boundaryLocked || neighbor.boundaryLocked) return;
        const merged = mergeMapRegions(neighbor, selected);
        map.layout.regions = map.layout.regions.filter((region) => region !== selected && region !== neighbor);
        map.layout.regions.splice(Math.min(index, map.layout.regions.length), 0, merged);
        this.selectedEcologyRegionId = merged.id;
      }
      if (map.layout.regions.length > 0 && !measureMapLayoutCoverage(map.layout, map.box.size).valid) {
        map.layout.regions = previousRegions;
        this.state.message = '删除会破坏完整分区，已取消';
        this.renderMapAiPanel();
        return;
      }
      void commitLayoutChange();
    });
    const bindRegionField = (selector: string, update: (region: MapEcologyRegion, value: string) => void) => {
      host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener('change', (event) => {
        const region = selectedRegion();
        if (!region) return;
        update(region, (event.target as HTMLInputElement).value.trim());
        void commitLayoutChange();
      });
    };
    bindRegionField('#map-layout-region-name', (region, value) => { region.name = value || region.name; });
    bindRegionField('#map-layout-region-prompt', (region, value) => { region.prompt = value; });
    bindRegionField('#map-layout-region-group', (region, value) => { region.groupId = value || null; });
    host.querySelector<HTMLInputElement>('#map-layout-boundary-lock')?.addEventListener('change', (event) => {
      const region = selectedRegion();
      if (region) region.boundaryLocked = (event.target as HTMLInputElement).checked;
      void commitLayoutChange();
    });
    host.querySelector<HTMLInputElement>('#map-layout-content-lock')?.addEventListener('change', (event) => {
      const region = selectedRegion();
      if (region) region.contentLocked = (event.target as HTMLInputElement).checked;
      void commitLayoutChange();
    });
    (['x', 'z'] as const).forEach((axis) => host.querySelector(`#split-map-region-${axis}`)?.addEventListener('click', () => {
      const region = selectedRegion();
      if (!region || map.layout.regions.length >= maxMapRegionCount(map.box.size)) return;
      const next = splitMapRegion(region, axis);
      if (!next) return;
      map.layout.regions.splice(map.layout.regions.indexOf(region), 1, ...next);
      this.selectedEcologyRegionId = next[0]?.id ?? '';
      void commitLayoutChange();
    }));
    host.querySelector('#merge-map-region')?.addEventListener('click', () => {
      const region = selectedRegion();
      if (!region || map.layout.regions.length < 2) return;
      const index = map.layout.regions.indexOf(region);
      const previousRegions = structuredClone(map.layout.regions);
      const neighbor = findAdjacentMapRegion(map.layout.regions, region);
      if (!neighbor) {
        this.state.message = '当前区块没有可合并的公共边界';
        this.updateToolbarState();
        return;
      }
      const merged = mergeMapRegions(region, neighbor);
      map.layout.regions = map.layout.regions.filter((item) => item !== region && item !== neighbor);
      map.layout.regions.splice(Math.min(index, map.layout.regions.length), 0, merged);
      this.selectedEcologyRegionId = merged.id;
      if (!measureMapLayoutCoverage(map.layout, map.box.size).valid) {
        map.layout.regions = previousRegions;
        this.state.message = '合并会造成区块重叠或缺口，已取消';
        this.renderMapAiPanel();
        return;
      }
      void commitLayoutChange();
    });
    host.querySelector('#generate-map-region')?.addEventListener('click', async () => {
      const region = selectedRegion();
      if (!region?.prompt.trim()) return;
      const regionId = region.id;
      if (this.state.dirty && !await this.saveMap()) return;
      const savedMap = this.state.map;
      const savedRegion = savedMap?.layout.regions.find((item) => item.id === regionId);
      if (!savedMap || !savedRegion?.prompt.trim()) return;
      this.mapAiBaseTerrainOnly = false;
      this.mapAiTargetRegionId = savedRegion.id;
      this.mapAiPrompt = [savedMap.layout.globalPrompt, `${savedRegion.name}：${savedRegion.prompt}`].filter(Boolean).join('\n\n');
      await this.generateMapAiPreview('refine');
    });
    const updateEdgeMask = () => {
      const kind = (host.querySelector<HTMLSelectElement>('#map-edge-mask-kind')?.value ?? 'none') as MapEdgeMaskKind;
      if (kind === 'composite') return;
      const irregularity = Number(host.querySelector<HTMLInputElement>('#map-edge-irregularity')?.value ?? 0);
      const seed = Number(host.querySelector<HTMLInputElement>('#map-edge-seed')?.value ?? map.seed);
      map.layout.edgeMask = createMapEdgeMask(kind, map.box.size, seed, irregularity);
      void commitLayoutChange();
    };
    host.querySelector('#map-edge-mask-kind')?.addEventListener('change', updateEdgeMask);
    host.querySelector('#map-edge-irregularity')?.addEventListener('change', updateEdgeMask);
    host.querySelector('#map-edge-seed')?.addEventListener('change', updateEdgeMask);
    host.querySelector('#edge-from-selected-region')?.addEventListener('click', () => {
      const region = selectedRegion();
      if (!region) return;
      map.layout.edgeMask = createMapEdgeMask('polygon', map.box.size, map.seed, 0, region.points);
      void commitLayoutChange();
    });
    host.querySelectorAll<SVGCircleElement>('.map-layout-vertex').forEach((vertex) => {
      vertex.addEventListener('pointerdown', (event) => {
        const regionIndex = Number(vertex.dataset.regionIndex);
        const pointIndex = Number(vertex.dataset.pointIndex);
        const sourceRegion = map.layout.regions[regionIndex];
        const sourcePoint = sourceRegion?.points[pointIndex];
        const svg = host.querySelector<SVGSVGElement>('.map-layout-canvas');
        if (!sourceRegion || !sourcePoint || !svg || sourceRegion.boundaryLocked) return;
        const touching = map.layout.regions.filter((region) => region.points.some((point) => (
          Math.abs(point[0] - sourcePoint[0]) < 0.001 && Math.abs(point[1] - sourcePoint[1]) < 0.001
        )));
        if (touching.some((region) => region.boundaryLocked)) {
          this.state.message = '该公共顶点连接着已锁定区块';
          this.updateToolbarState();
          return;
        }
        event.preventDefault();
        const original: [number, number] = [...sourcePoint];
        const sharedPoints = touching.flatMap((region) => region.points.filter((point) => (
          Math.abs(point[0] - original[0]) < 0.001 && Math.abs(point[1] - original[1]) < 0.001
        )));
        const move = (moveEvent: PointerEvent) => {
          const rect = svg.getBoundingClientRect();
          const halfWidth = map.box.size[0] / 2;
          const halfDepth = map.box.size[2] / 2;
          const freeX = Math.max(-halfWidth, Math.min(halfWidth, ((moveEvent.clientX - rect.left) / rect.width - 0.5) * map.box.size[0]));
          const freeZ = Math.max(-halfDepth, Math.min(halfDepth, ((moveEvent.clientY - rect.top) / rect.height - 0.5) * map.box.size[2]));
          const x = Math.abs(Math.abs(original[0]) - halfWidth) < 0.001 ? original[0] : freeX;
          const z = Math.abs(Math.abs(original[1]) - halfDepth) < 0.001 ? original[1] : freeZ;
          for (const point of sharedPoints) {
            point[0] = x;
            point[1] = z;
          }
          host.querySelectorAll<SVGPolygonElement>('[data-layout-region]').forEach((polygon) => {
            const region = map.layout.regions.find((item) => item.id === polygon.dataset.layoutRegion);
            if (region) polygon.setAttribute('points', region.points.map(([px, pz]) => `${((px + halfWidth) / map.box.size[0]) * 100},${((pz + halfDepth) / map.box.size[2]) * 100}`).join(' '));
          });
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          if (!measureMapLayoutCoverage(map.layout, map.box.size).valid) {
            for (const point of sharedPoints) {
              point[0] = original[0];
              point[1] = original[1];
            }
            this.state.message = '这次拖动会造成区块重叠或缺口，已恢复原边界';
            this.renderMapAiPanel();
            this.updateToolbarState();
            return;
          }
          void commitLayoutChange();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
      });
    });
    host.querySelector('#stitch-map')?.addEventListener('click', async () => {
      const sourceMapId = host.querySelector<HTMLSelectElement>('#stitch-source-map')?.value;
      if (!sourceMapId || this.state.dirty || this.state.busy) return;
      this.setBusy(true, '正在拼接并平滑接缝...');
      try {
        const result = await editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(map.id)}/stitch`, {
          method: 'POST',
          body: JSON.stringify({
            sourceMapId,
            direction: host.querySelector<HTMLSelectElement>('#stitch-direction')?.value,
            mode: host.querySelector<HTMLSelectElement>('#stitch-mode')?.value,
            width: Number(host.querySelector<HTMLInputElement>('#stitch-width')?.value ?? 24),
            irregularity: Number(host.querySelector<HTMLInputElement>('#stitch-irregularity')?.value ?? 0.2),
            prompt: host.querySelector<HTMLInputElement>('#stitch-prompt')?.value.trim()
          })
        });
        this.state.map = normalizeMap(result.map);
        this.state.dirty = false;
        this.clearMapAiPreview();
        this.mapLayoutSuggestion = null;
        this.resetManualHistory(this.state.map, true);
        await this.reloadLists();
        await this.refreshScene();
        this.state.message = `已创建拼接地图：${result.map.name}`;
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知错误';
        this.state.message = detail.includes('duplicate_stitch_source')
          ? '地图拼接失败：同一个源地图不能在一张拼接地图中重复使用'
          : `地图拼接失败：${detail}`;
      } finally {
        this.setBusy(false);
        this.renderPanels();
      }
    });
    host.querySelector<HTMLSelectElement>('#stitch-seam-select')?.addEventListener('change', (event) => {
      this.selectedStitchSeamId = (event.target as HTMLSelectElement).value;
      this.renderMapAiPanel();
    });
    host.querySelector('#retune-stitch-seam')?.addEventListener('click', async () => {
      const seam = map.layout.seams.find((item) => item.id === this.selectedStitchSeamId) ?? map.layout.seams[0];
      if (!seam || this.state.busy || this.state.dirty) return;
      this.setBusy(true, seam.locked ? '正在解锁接缝...' : '正在重新计算接缝高度...');
      try {
        const locked = host.querySelector<HTMLInputElement>('#stitch-seam-lock')?.checked === true;
        const result = await editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(map.id)}/seams/${encodeURIComponent(seam.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            width: Number(host.querySelector<HTMLInputElement>('#stitch-seam-width')?.value ?? seam.width),
            irregularity: Number(host.querySelector<HTMLInputElement>('#stitch-seam-irregularity')?.value ?? seam.irregularity),
            seed: Number(host.querySelector<HTMLInputElement>('#stitch-seam-seed')?.value ?? seam.seed),
            prompt: host.querySelector<HTMLInputElement>('#stitch-seam-prompt')?.value ?? seam.prompt,
            locked
          })
        });
        this.state.map = normalizeMap(result.map);
        this.state.dirty = false;
        this.resetManualHistory(this.state.map, true);
        await this.refreshScene();
        this.state.message = locked ? '接缝已锁定' : '接缝高度已重新计算并保存';
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知错误';
        this.state.message = detail.includes('stitch_seam_source_changed')
          ? '接缝调整失败：源地图在拼接后已发生变化，请重新拼接以避免意外覆盖'
          : `接缝调整失败：${detail}`;
      } finally {
        this.setBusy(false);
        this.renderPanels();
      }
    });
  }

  private async generateCompositionPlanPreview(): Promise<void> {
    const map = this.state.map;
    const prompt = this.mapAiPrompt.trim();
    if (!map || !prompt || map.sceneMode !== 'indoor' || this.state.busy) return;
    const controller = new AbortController();
    this.mapAiAbortController = controller;
    this.mapAgentProgress = [];
    this.startMapAgentProgressTimer();
    this.setBusy(true, '场景总导演正在绘制室内俯视规划...');
    this.renderMapAiPanel();
    try {
      const { plan } = await editorAgentFetch<{ plan: SceneCompositionPlan }>(
        `/api/editor/maps/${encodeURIComponent(map.id)}/generate`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            provider: this.mapAiProvider,
            reuseExistingAssets: this.mapAiReuseExistingAssets,
            assetLibraryId: this.mapAiReuseExistingAssets ? this.activeAssetLibraryId : undefined,
            minNewAssets: this.mapAiMinNewAssets,
            maxNewAssets: this.mapAiMaxNewAssets,
            planOnly: true
          }),
          signal: controller.signal
        },
        (event) => {
          updateAgentProgress(this.mapAgentProgress, event);
          this.renderMapAiPanel();
        }
      );
      this.pendingCompositionPlan = plan;
      updateAgentProgress(this.mapAgentProgress, { phase: 'complete', label: '俯视空间规划已生成，等待确认' });
      this.state.message = '俯视规划已生成；确认前不会生成任何 3D 资产';
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const detail = humanizeAgentError(error);
      updateAgentProgress(this.mapAgentProgress, {
        phase: 'failed',
        label: cancelled ? '俯视规划已取消' : '俯视规划失败',
        detail
      });
      this.state.message = cancelled ? '已取消俯视规划' : `俯视规划失败：${detail}`;
    } finally {
      if (this.mapAiAbortController === controller) this.mapAiAbortController = null;
      this.stopMapAgentProgressTimer();
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async generateMapAiPreview(
    mode: 'generate' | 'refine',
    approvedCompositionPlan?: SceneCompositionPlan
  ): Promise<void> {
    const map = this.state.map;
    const prompt = this.mapAiPrompt.trim();
    if (!map || !prompt || this.state.busy) return;
    if (this.state.dirty) {
      this.state.message = '请先保存当前手工修改';
      this.updateToolbarState();
      return;
    }
    const controller = new AbortController();
    this.mapAiAbortController = controller;
    this.mapAgentProgress = [];
    this.startMapAgentProgressTimer();
    const previousSuggestion = mode === 'refine' ? this.mapAiSuggestion : null;
    const comparisonMap = mode === 'refine' && this.mapAiPreviewMap ? this.mapAiPreviewMap : map;
    this.setBusy(true, mode === 'refine' ? '地图 Agent 正在调整当前地图...' : '地图 Agent 正在检查资产并规划场景...');
    this.renderMapAiPanel();
    try {
      const { suggestion } = await editorAgentFetch<{ suggestion: MapAiSuggestion }>(
        `/api/editor/maps/${encodeURIComponent(map.id)}/${mode}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            provider: this.mapAiProvider,
            reuseExistingAssets: this.mapAiReuseExistingAssets,
            assetLibraryId: this.mapAiReuseExistingAssets ? this.activeAssetLibraryId : undefined,
            minNewAssets: this.mapAiMinNewAssets,
            maxNewAssets: this.mapAiMaxNewAssets,
            targetVisualZoneId: mode === 'refine' ? this.mapAiTargetVisualZoneId || undefined : undefined,
            targetRegionId: mode === 'refine' ? this.mapAiTargetRegionId || undefined : undefined,
            baseTerrainOnly: mode === 'refine' && this.mapAiBaseTerrainOnly,
            approvedCompositionPlan,
            ...(previousSuggestion ? { baseOperations: previousSuggestion.operations } : {})
          }),
          signal: controller.signal
        },
        (event) => {
          updateAgentProgress(this.mapAgentProgress, event);
          this.renderMapAiPanel();
        }
      );
      if (suggestion.generatedAssets.length > 0) await this.reloadLists();
      const combinedSuggestion = previousSuggestion
        ? {
            ...suggestion,
            operations: [...previousSuggestion.operations, ...suggestion.operations],
            generatedAssets: [...previousSuggestion.generatedAssets, ...suggestion.generatedAssets]
          }
        : suggestion;
      this.mapPreviewKind = 'ai';
      this.mapAiSuggestion = combinedSuggestion;
      this.pendingCompositionPlan = null;
      this.mapAiPreviewMap = applyMapOperations(this.mapWithEditorAssets(map), combinedSuggestion.operations);
      this.mapAiComparisonMap = comparisonMap;
      this.mapAiPreviewVisible = true;
      this.state.selectedObjectId = null;
      this.state.message = 'AI 地图预览已生成，尚未应用';
      await this.refreshScene();
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const detail = humanizeAgentError(error);
      updateAgentProgress(this.mapAgentProgress, {
        phase: 'failed',
        label: cancelled ? '地图 Agent 已取消' : '地图 Agent 执行失败',
        detail
      });
      this.state.message = error instanceof Error && error.name === 'AbortError'
        ? '已取消地图 Agent'
        : `AI 地图生成失败：${detail}`;
    } finally {
      if (this.mapAiAbortController === controller) this.mapAiAbortController = null;
      this.stopMapAgentProgressTimer();
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async previewTerrainBase(): Promise<void> {
    const map = this.state.map;
    if (!map) return;
    const operation: MapOperation = {
      type: 'terrain.generate',
      preset: this.state.terrainPreset,
      seed: this.terrainSeed ?? map.seed,
      amplitude: this.state.terrainPreset === 'plain' ? 0 : this.state.terrainAmplitude,
      roughness: 0.55,
      direction: this.state.terrainDirection
    };
    await this.previewTerrainOperations(`整体地貌：${terrainPresetLabel(this.state.terrainPreset)}`, [operation]);
  }

  private async previewTerrainGesture(): Promise<void> {
    const map = this.state.map;
    const points = this.terrainGesturePoints;
    this.terrainGesturePoints = [];
    if (!map || points.length === 0 || this.state.terrainAction === 'brush') return;
    const useCircle = points.length < 2 || this.state.terrainModifier === 'island';
    const region = useCircle
      ? { kind: 'circle' as const, x: points[0][0], z: points[0][1], radius: this.state.terrainSize }
      : { kind: 'path' as const, points, width: Math.max(0.3, this.state.terrainSize * 2) };
    if (this.state.terrainAction === 'modifier') {
      await this.previewTerrainOperations(`局部地貌：${terrainModifierLabel(this.state.terrainModifier)}`, [{
        type: 'terrain.modify',
        modifier: this.state.terrainModifier,
        region,
        seed: this.terrainSeed ?? map.seed,
        amplitude: this.state.terrainAmplitude,
        softness: this.state.terrainSoftness,
        direction: this.state.terrainDirection,
        variation: 0.45,
        layers: this.state.terrainLayers,
        layout: this.state.terrainCliffLayout
      }]);
      return;
    }
    await this.previewTerrainOperations(`地表区域：${terrainSurfaceLabel(this.state.terrainSurface)}`, [{
      type: 'terrain.surface',
      surface: this.state.terrainSurface,
      region,
      intensity: 1,
      zoneId: `manual-${this.state.terrainSurface}-${Math.round(points[0][0] * 10)}-${Math.round(points[0][1] * 10)}`
    }]);
  }

  private async previewTerrainOperations(summary: string, operations: MapOperation[]): Promise<void> {
    const map = this.state.map;
    if (!map || this.state.busy || this.mapAiPreviewMap) return;
    if (this.state.dirty) {
      this.state.message = '请先保存当前手工修改，再生成地形预览';
      this.renderPanels();
      return;
    }
    this.mapPreviewKind = 'terrain';
    this.mapAiSuggestion = { summary, operations, renderPromptSuggestions: [], generatedAssets: [] };
    this.mapAiComparisonMap = map;
    this.mapAiPreviewMap = applyMapOperations(this.mapWithEditorAssets(map), operations);
    this.mapAiPreviewVisible = true;
    this.state.selectedObjectId = null;
    this.state.message = `${summary}预览已生成，尚未应用`;
    await this.refreshScene();
    this.renderPanels();
  }

  private async previewSceneNormalization(): Promise<void> {
    const map = this.state.map;
    if (!map || this.state.busy || this.mapAiPreviewMap) return;
    const lint = lintMap(this.mapWithEditorAssets(map));
    if (lint.repairOperations.length === 0) {
      this.state.message = '当前场景没有需要本地修正的落地、越界或天花板问题';
      this.renderPanels();
      return;
    }
    await this.previewTerrainOperations('本地尺度与落点重新规范', lint.repairOperations);
  }

  private async discardMapAiPreview(): Promise<void> {
    if (!this.mapAiPreviewMap) return;
    const wasTerrainPreview = this.mapPreviewKind === 'terrain';
    this.clearMapAiPreview();
    this.state.message = wasTerrainPreview ? '已放弃地形预览' : '已放弃 AI 地图预览';
    await this.refreshScene();
    this.renderPanels();
  }

  private async applyMapAiPreview(): Promise<void> {
    const map = this.state.map;
    const suggestion = this.mapAiSuggestion;
    if (!map || !suggestion || this.state.busy || this.state.dirty) return;
    const isTerrainPreview = this.mapPreviewKind === 'terrain';
    this.setBusy(true, isTerrainPreview ? '正在应用地形编辑...' : '正在应用 AI 地图...');
    try {
      const result = await editorFetch<{ map: EditableMap; transaction: MapTransactionSummary }>(
        `/api/editor/maps/${encodeURIComponent(map.id)}/transactions`,
        {
          method: 'POST',
          body: JSON.stringify({
            source: isTerrainPreview ? 'manual' : 'basic-ai',
            label: suggestion.summary,
            operations: suggestion.operations
          })
        }
      );
      this.state.map = normalizeMap(result.map);
      this.state.undoTransaction = result.transaction;
      this.state.redoTransaction = null;
      this.state.selectedObjectId = null;
      this.clearMapAiPreview();
      this.resetRenderDraft();
      this.resetManualHistory(this.state.map, true);
      await this.reloadLists();
      await this.refreshScene();
      this.state.message = `已应用：${result.transaction.label}`;
    } catch (error) {
      this.state.message = `应用${isTerrainPreview ? '地形编辑' : ' AI 地图'}失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private clearMapAiPreview(): void {
    this.mapAiSuggestion = null;
    this.pendingCompositionPlan = null;
    this.mapAiPreviewMap = null;
    this.mapAiPreviewVisible = true;
    this.mapAiComparisonMap = null;
    this.mapPreviewKind = 'ai';
  }

  private renderMapSelector(): void {
    const select = this.app.querySelector<HTMLSelectElement>('#editor-map-select');
    if (!select) return;
    select.innerHTML = this.state.maps.length
      ? this.state.maps.map((map) => `<option value="${map.id}" ${this.state.map?.id === map.id ? 'selected' : ''}>${escapeHtml(map.id === this.state.map?.id ? this.state.map.name : map.name)}</option>`).join('')
      : '<option value="">暂无地图</option>';
    const name = this.app.querySelector<HTMLElement>('#toolbar-map-name');
    if (name) name.textContent = this.state.map?.name ?? '选择地图';
    const renameInput = this.app.querySelector<HTMLInputElement>('#rename-current-map-input');
    if (renameInput) renameInput.value = this.state.map?.name ?? '';
  }

  private renameCurrentMap(value: string): void {
    const map = this.state.map;
    const nextName = value.trim().slice(0, 80);
    if (!map || !nextName || nextName === map.name || this.state.busy || this.mapAiPreviewMap) return;
    map.name = nextName;
    this.markDirty();
    this.renderMapSelector();
    this.renderMapInspector();
    this.updateToolbarState();
  }

  private updateHierarchyLayout(): void {
    this.app.dataset.hierarchyOpen = this.hierarchyOpen ? 'true' : 'false';
    const toggle = this.app.querySelector<HTMLButtonElement>('#toggle-hierarchy');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(this.hierarchyOpen));
    toggle.title = this.hierarchyOpen ? '收起层级' : '展开层级';
  }

  private renderHierarchy(): void {
    const host = this.app.querySelector<HTMLElement>('#hierarchy');
    if (!host) return;
    const map = this.state.map;
    if (!map) {
      host.innerHTML = '<p class="empty">还没有地图。</p>';
      return;
    }
    host.innerHTML = `
      ${map.room ? `
        <div class="hierarchy-row system"><span>房间外壳</span><small>${map.room.size.map((value) => value.toFixed(1)).join(' × ')}</small></div>
        ${ROOM_SURFACES.map((surface) => `
          <button class="hierarchy-row system ${this.isRoomSurfaceSelected(surface) ? 'active' : ''}" data-room-surface="${surface}">
            <span>${roomSurfaceLabel(surface)}</span><small>room</small>
          </button>
        `).join('')}
      ` : ''}
      <button class="hierarchy-row system ${this.isPlayerSpawnSelected() ? 'active' : ''}" data-spawn-object="${PLAYER_SPAWN_OBJECT_ID}">
        <span>场景参考点</span>
        <small>origin</small>
      </button>
      <button class="hierarchy-row system ${this.isSunSelected() ? 'active' : ''}" data-sun-object="${SUN_OBJECT_ID}">
        <span>太阳</span>
        <small>light</small>
      </button>
      ${map.waterBodies.map((water) => `
        <div class="hierarchy-row water">
          <span>${escapeHtml(water.name)}</span>
          <small>${water.type}</small>
        </div>
      `).join('')}
      ${renderObjectTree(map.objects, null, this.state.selectedObjectId)}
    `;
    if (this.mapAiPreviewMap) return;
    host.querySelectorAll<HTMLButtonElement>('[data-room-surface]').forEach((button) => {
      button.addEventListener('click', () => {
        const surface = button.dataset.roomSurface as RoomSurface;
        this.selectObject(roomSurfaceObjectId(surface));
      });
    });
    host.querySelector<HTMLButtonElement>('[data-spawn-object]')?.addEventListener('click', () => {
      this.selectObject(PLAYER_SPAWN_OBJECT_ID);
    });
    host.querySelector<HTMLButtonElement>('[data-sun-object]')?.addEventListener('click', () => {
      this.selectObject(SUN_OBJECT_ID);
    });
    host.querySelectorAll<HTMLButtonElement>('[data-object-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectObject(button.dataset.objectId ?? null);
      });
      button.addEventListener('dblclick', () => {
        this.selectObject(button.dataset.objectId ?? null);
        this.focusSelection();
      });
    });
  }

  private renderMapInspector(): void {
    const host = this.app.querySelector<HTMLElement>('#map-inspector');
    if (!host) return;
    const map = this.state.map;
    if (!map) {
      host.innerHTML = `
        <section class="editor-section">
          <h2>地图</h2>
          <p class="empty">点击“新建”创建第一张服务端地图。</p>
        </section>
      `;
      return;
    }
    const mapSettingsOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="map-settings"]')?.open ?? false;
    const roomSettingsOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="room-settings"]')?.open ?? Boolean(map.room);
    const materialTagsOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="material-tags"]')?.open ?? false;
    const visualSemanticsOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="visual-semantics"]')?.open ?? false;
    if (!map.visualSemantics.zones.some((zone) => zone.id === this.selectedVisualZoneId)) {
      this.selectedVisualZoneId = map.visualSemantics.zones[0]?.id ?? '';
    }
    const selectedZone = map.visualSemantics.zones.find((zone) => zone.id === this.selectedVisualZoneId) ?? null;
    const derived = inspectMapDerivedResults(map);
    host.innerHTML = `
      <details class="inspector-disclosure" data-inspector-section="map-settings" ${mapSettingsOpen ? 'open' : ''}>
        <summary><span><b>地图</b><small>${escapeHtml(map.name)} · ${map.box.size.map((value) => value.toFixed(0)).join(' × ')}</small></span></summary>
        <section class="editor-section inspector-body">
        <label class="field compact"><span>名称</span><input data-map-name value="${escapeHtml(map.name)}" /></label>
        <label class="field compact"><span>场景类型</span><select data-map-scene-mode>
          <option value="outdoor" ${map.sceneMode === 'outdoor' ? 'selected' : ''}>室外</option>
          <option value="indoor" ${map.sceneMode === 'indoor' ? 'selected' : ''}>室内</option>
          <option value="mixed" ${map.sceneMode === 'mixed' ? 'selected' : ''}>室内 + 室外</option>
        </select></label>
        <label class="field compact"><span>角色高度（米）</span><input data-player-height type="number" min="0.8" max="3.2" step="0.1" value="${map.playerHeight}" /></label>
        <label class="field compact"><span>世界尺度</span><select data-world-scale-profile>
          <option value="intimate" ${map.worldScaleProfile === 'intimate' ? 'selected' : ''}>亲近</option>
          <option value="balanced" ${map.worldScaleProfile === 'balanced' ? 'selected' : ''}>均衡</option>
          <option value="grand" ${map.worldScaleProfile === 'grand' ? 'selected' : ''}>宏大</option>
        </select></label>
        <button type="button" class="secondary small" data-renormalize-scene>预览重新规范当前场景</button>
        <p class="empty">只生成本地确定性修正预览，不调用 AI；锁定物体不会被修改。</p>
        <div class="triple">
          ${numberField('宽', 'box-size', 0, map.box.size[0])}
          ${numberField('高', 'box-size', 1, map.box.size[1])}
          ${numberField('深', 'box-size', 2, map.box.size[2])}
        </div>
        <div class="color-grid">
          ${colorField('地板', 'floor', map.box.colors.floor)}
          ${map.room ? `
            ${colorField('天花板', 'ceiling', map.box.colors.ceiling)}
            ${colorField('北墙', 'north', map.box.colors.north)}
            ${colorField('南墙', 'south', map.box.colors.south)}
            ${colorField('东墙', 'east', map.box.colors.east)}
            ${colorField('西墙', 'west', map.box.colors.west)}
          ` : ''}
        </div>
        </section>
      </details>
      ${map.room ? `
        <details class="inspector-disclosure" data-inspector-section="room-settings" ${roomSettingsOpen ? 'open' : ''}>
          <summary><span><b>参数化房间</b><small>${map.room.size.map((value) => value.toFixed(1)).join(' × ')} · ${map.room.openings.length} 个门窗位</small></span></summary>
          <section class="editor-section inspector-body">
            <p class="empty">墙体由模块化墙段围绕门窗预留位拼成，不执行布尔切割。</p>
            <div class="triple">
              ${numberField('位置 X', 'room-position', 0, map.room.position[0])}
              ${numberField('地板 Y', 'room-position', 1, map.room.position[1])}
              ${numberField('位置 Z', 'room-position', 2, map.room.position[2])}
            </div>
            <div class="triple">
              ${numberField('宽', 'room-size', 0, map.room.size[0])}
              ${numberField('高', 'room-size', 1, map.room.size[1])}
              ${numberField('深', 'room-size', 2, map.room.size[2])}
            </div>
            <label class="field compact"><span>墙厚</span><input data-room-thickness type="number" min="0.05" max="0.5" step="0.01" value="${map.room.wallThickness}" /></label>
            <div class="map-ai-controls">
              <button type="button" class="secondary small" data-add-room-opening="door">添加门位</button>
              <button type="button" class="secondary small" data-add-room-opening="window">添加窗位</button>
            </div>
            ${map.room.openings.map((opening) => `
              <details class="inspector-disclosure compact" data-room-opening-row="${escapeHtml(opening.id)}">
                <summary><span><b>${opening.kind === 'door' ? '门位' : '窗位'}</b><small>${escapeHtml(opening.id)} · ${roomSurfaceLabel(opening.wall)}</small></span></summary>
                <label class="field compact"><span>墙面</span><select data-room-opening-wall="${escapeHtml(opening.id)}">
                  ${(['north', 'south', 'east', 'west'] as const).map((wall) => `<option value="${wall}" ${opening.wall === wall ? 'selected' : ''}>${roomSurfaceLabel(wall)}</option>`).join('')}
                </select></label>
                <div class="triple">
                  <label><span>横向偏移</span><input data-room-opening-number="offset" data-room-opening-id="${escapeHtml(opening.id)}" type="number" step="0.1" value="${opening.offset}" /></label>
                  <label><span>离地</span><input data-room-opening-number="bottom" data-room-opening-id="${escapeHtml(opening.id)}" type="number" min="0" step="0.1" value="${opening.bottom}" ${opening.kind === 'door' ? 'disabled' : ''} /></label>
                  <label><span>宽</span><input data-room-opening-number="width" data-room-opening-id="${escapeHtml(opening.id)}" type="number" min="0.4" step="0.1" value="${opening.width}" /></label>
                </div>
                <label class="field compact"><span>高</span><input data-room-opening-number="height" data-room-opening-id="${escapeHtml(opening.id)}" type="number" min="0.4" step="0.1" value="${opening.height}" /></label>
                <button type="button" class="secondary danger small" data-remove-room-opening="${escapeHtml(opening.id)}">删除预留位</button>
              </details>
            `).join('') || '<p class="empty">尚未规划门窗；AI 生成室内场景时可同时创建并绑定模型。</p>'}
          </section>
        </details>
      ` : ''}
      <details class="inspector-disclosure" data-inspector-section="visual-semantics" ${visualSemanticsOpen ? 'open' : ''}>
        <summary><span><b>区域语义</b><small>${map.visualSemantics.zones.length} 个区域 · 手调字段自动保留</small></span></summary>
        <section class="editor-section inspector-body">
          ${selectedZone ? `
            <label class="field compact"><span>区域 ID</span><select data-visual-zone-select>
              ${map.visualSemantics.zones.map((zone) => `<option value="${escapeHtml(zone.id)}" ${zone.id === selectedZone.id ? 'selected' : ''}>${escapeHtml(zone.id)}</option>`).join('')}
            </select></label>
            <div class="triple">
              ${numberField('中心 X', 'visual-zone-center', 0, selectedZone.center[0])}
              ${numberField('中心 Z', 'visual-zone-center', 1, selectedZone.center[1])}
              <label><span>半径</span><input data-visual-zone-number="radius" type="number" min="0.5" max="512" step="0.5" value="${selectedZone.radius}" /></label>
            </div>
            <label class="field compact"><span>强度</span><input data-visual-zone-number="intensity" type="range" min="0" max="1" step="0.05" value="${selectedZone.intensity}" /></label>
            <fieldset class="asset-library-zones"><legend>区域标签</legend>
              ${VISUAL_ZONE_TAGS.map((tag) => `<label><input type="checkbox" data-visual-zone-tag="${tag}" ${selectedZone.tags.includes(tag) ? 'checked' : ''} />${tag}</label>`).join('')}
            </fieldset>
            <details class="inspector-disclosure compact">
              <summary><span><b>更多详情</b><small>控制哪些手调字段不被 AI 重算</small></span></summary>
              <fieldset class="asset-library-zones"><legend>保留手调</legend>
                ${VISUAL_ZONE_FIELDS.map((field) => `<label><input type="checkbox" data-visual-zone-lock="${field}" ${selectedZone.locks?.[field] ? 'checked' : ''} />${field}</label>`).join('')}
              </fieldset>
              <p class="empty">修改字段时会自动锁定；取消勾选后，该字段可再次跟随 AI 重算。</p>
            </details>
          ` : '<p class="empty">当前地图还没有可编辑的语义区域；AI 生成地图后会自动补充。</p>'}
          <details class="inspector-disclosure compact">
            <summary><span><b>派生结果检查</b><small>只读，不阻断生成</small></span></summary>
            <div class="map-ai-stats">
              <span>地表语义 <b>${derived.semanticZoneCount}</b></span>
              <span>湿岸 <b>${derived.wetShoreCount}</b></span>
              <span>草地退让格 <b>${derived.grassRetreatedCells}</b></span>
              <span>局部灯光候选 <b>${derived.localLightCandidateCount}/${derived.localLightVisibleLimit}</b></span>
            </div>
            <div class="style-tags">${map.visualSemantics.zones.map((zone) => `<span>${escapeHtml(zone.id)} · ${escapeHtml(zone.tags.join(', ') || '未标记')}</span>`).join('')}</div>
            <p class="empty">湿岸与草地退让只在渲染时自动计算，不改写手工密度；局部灯光从可见自发光/火焰材质中选取，当前最多显示 ${derived.localLightVisibleLimit} 个。</p>
          </details>
        </section>
      </details>
      ${renderMaterialTagScenePanel(map, this.state.assets, materialTagsOpen)}
      ${this.state.tool === 'paint' ? `<section class="editor-section contextual-editor-section">
        <h2>画笔</h2>
        <label class="field compact"><span>颜色</span><input data-brush-color type="color" value="${this.state.brushColor}" /></label>
        <label class="field compact"><span>大小</span><input data-brush-size type="range" min="0.1" max="8" step="0.1" value="${this.state.brushSize}" /></label>
        <label class="field compact"><span>边缘模糊</span><input data-brush-softness type="range" min="0" max="1" step="0.05" value="${this.state.brushSoftness}" /></label>
      </section>` : ''}
      ${this.state.tool === 'terrain' ? `<section class="editor-section contextual-editor-section">
        <h2>地形</h2>
        <label class="field compact"><span>整体地貌</span><select data-terrain-preset>
          ${TERRAIN_GENERATION_PRESETS.map((preset) => `<option value="${preset}" ${this.state.terrainPreset === preset ? 'selected' : ''}>${terrainPresetLabel(preset)}</option>`).join('')}
        </select></label>
        <div class="map-ai-controls">
          <button type="button" data-terrain-preview-base ${this.state.dirty || this.state.busy || Boolean(this.mapAiPreviewMap) ? 'disabled' : ''}>预览整体替换</button>
          <button type="button" class="secondary" data-terrain-reroll ${this.state.busy || Boolean(this.mapAiPreviewMap) ? 'disabled' : ''}>换一个种子</button>
        </div>
        <p class="empty">种子 ${this.terrainSeed ?? map.seed} · 岛屿自动生成海面；沙漠自动附加沙地与飞沙语义。</p>
        <label class="field compact"><span>局部工具</span><select data-terrain-action>
          <option value="brush" ${this.state.terrainAction === 'brush' ? 'selected' : ''}>基础画笔</option>
          <option value="modifier" ${this.state.terrainAction === 'modifier' ? 'selected' : ''}>地貌修改器</option>
          <option value="surface" ${this.state.terrainAction === 'surface' ? 'selected' : ''}>地表区域</option>
        </select></label>
        ${this.state.terrainAction === 'brush' ? `<select data-terrain-mode>
          <option value="raise" ${this.state.terrainMode === 'raise' ? 'selected' : ''}>抬高</option>
          <option value="lower" ${this.state.terrainMode === 'lower' ? 'selected' : ''}>降低</option>
          <option value="flatten" ${this.state.terrainMode === 'flatten' ? 'selected' : ''}>平整</option>
        </select>` : ''}
        ${this.state.terrainAction === 'modifier' ? `
          <label class="field compact"><span>修改器</span><select data-terrain-modifier>
            ${TERRAIN_MODIFIERS.map((modifier) => `<option value="${modifier}" ${this.state.terrainModifier === modifier ? 'selected' : ''}>${terrainModifierLabel(modifier)}</option>`).join('')}
          </select></label>
          ${this.state.terrainModifier === 'cliff' ? `<label class="field compact"><span>峭壁形态</span><select data-terrain-cliff-layout>
            ${TERRAIN_CLIFF_LAYOUTS.map((layout) => `<option value="${layout}" ${this.state.terrainCliffLayout === layout ? 'selected' : ''}>${terrainCliffLayoutLabel(layout)}</option>`).join('')}
          </select></label>` : ''}
        ` : ''}
        ${this.state.terrainAction === 'surface' ? `<label class="field compact"><span>地表</span><select data-terrain-surface>
          ${TERRAIN_SURFACES.map((surface) => `<option value="${surface}" ${this.state.terrainSurface === surface ? 'selected' : ''}>${terrainSurfaceLabel(surface)}</option>`).join('')}
        </select></label>` : ''}
        <label class="field compact"><span>大小</span><input data-terrain-size type="range" min="0.3" max="8" step="0.1" value="${this.state.terrainSize}" /></label>
        ${this.state.terrainAction === 'brush'
          ? `<label class="field compact"><span>强度</span><input data-terrain-strength type="range" min="0.02" max="1.5" step="0.02" value="${this.state.terrainStrength}" /></label>`
          : this.state.terrainAction === 'modifier'
            ? `<label class="field compact"><span>高度</span><input data-terrain-amplitude type="range" min="0.2" max="${Math.max(1, map.box.size[1] - 0.1)}" step="0.1" value="${this.state.terrainAmplitude}" /></label>`
            : ''}
        ${this.state.terrainAction === 'modifier' ? `
          <label class="field compact"><span>过渡柔和</span><input data-terrain-softness type="range" min="0" max="1" step="0.05" value="${this.state.terrainSoftness}" /></label>
          <label class="field compact"><span>方向</span><input data-terrain-direction type="range" min="0" max="359" step="1" value="${this.state.terrainDirection}" /></label>
          ${this.state.terrainModifier === 'terrace' ? `<label class="field compact"><span>层数</span><input data-terrain-layers type="range" min="2" max="12" step="1" value="${this.state.terrainLayers}" /></label>` : ''}
        ` : ''}
        ${this.state.terrainAction !== 'brush' ? '<p class="empty">在地形上单击盖章，或按住拖动绘制路径；松开后先预览，再统一应用。</p>' : ''}
      </section>` : ''}
      ${this.state.tool === 'grass' ? renderGrassEditorPanel(map, this.grassEditorState) : ''}
    `;
    host.querySelector<HTMLInputElement>('[data-map-name]')?.addEventListener('input', (event) => {
      map.name = (event.target as HTMLInputElement).value;
      this.markDirty(false);
    });
    host.querySelector<HTMLSelectElement>('[data-map-scene-mode]')?.addEventListener('change', (event) => {
      const sceneMode = normalizeMapSceneMode((event.target as HTMLSelectElement).value);
      const room = sceneMode === 'outdoor'
        ? null
        : normalizeMapRoom(map.room, map.box.size);
      this.state.map = normalizeMap({ ...map, sceneMode, room });
      this.markDirty();
      void this.refreshScene();
      this.renderPanels();
    });
    host.querySelector<HTMLInputElement>('[data-player-height]')?.addEventListener('change', (event) => {
      const playerHeight = clampNumber(Number((event.target as HTMLInputElement).value), 0.8, 3.2);
      this.state.map = normalizeMap({ ...map, playerHeight, playerRadius: undefined });
      this.markDirty();
      void this.refreshScene();
      this.renderPanels();
    });
    host.querySelector<HTMLSelectElement>('[data-world-scale-profile]')?.addEventListener('change', (event) => {
      map.worldScaleProfile = normalizeWorldScaleProfile((event.target as HTMLSelectElement).value);
      this.markDirty(false);
      this.renderPanels();
    });
    host.querySelector<HTMLButtonElement>('[data-renormalize-scene]')?.addEventListener('click', () => {
      void this.previewSceneNormalization();
    });
    bindVectorInputs(host, 'box-size', map.box.size, () => {
      if (map.room) map.room = normalizeMapRoom(map.room, map.box.size, map.room);
      this.markDirty();
      void this.refreshScene();
    });
    if (map.room) {
      bindVectorInputs(host, 'room-position', map.room.position, () => {
        map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
        map.objects.forEach((object) => placeRoomOpeningObjectInPlace(map, object));
        this.markDirty();
        void this.refreshScene();
        this.renderMapInspector();
      });
      bindVectorInputs(host, 'room-size', map.room.size, () => {
        if (map.sceneMode === 'indoor') map.box.size = [...map.room!.size];
        map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
        map.objects.forEach((object) => placeRoomOpeningObjectInPlace(map, object));
        this.markDirty();
        void this.refreshScene();
        this.renderMapInspector();
      }, true);
      host.querySelector<HTMLInputElement>('[data-room-thickness]')?.addEventListener('change', (event) => {
        map.room!.wallThickness = Number((event.target as HTMLInputElement).value);
        map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
        map.objects.forEach((object) => placeRoomOpeningObjectInPlace(map, object));
        this.markDirty();
        void this.refreshScene();
        this.renderMapInspector();
      });
      host.querySelectorAll<HTMLButtonElement>('[data-add-room-opening]').forEach((button) => {
        button.addEventListener('click', () => {
          const kind = button.dataset.addRoomOpening === 'window' ? 'window' : 'door';
          map.room!.openings.push({
            id: `opening-${crypto.randomUUID().slice(0, 8)}`,
            kind,
            wall: 'north',
            offset: 0,
            bottom: kind === 'door' ? 0 : 1,
            width: kind === 'door' ? 1.2 : 1.8,
            height: kind === 'door' ? 2.1 : 1.2
          });
          map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
          this.markDirty();
          void this.refreshScene();
          this.renderPanels();
        });
      });
      host.querySelectorAll<HTMLSelectElement>('[data-room-opening-wall]').forEach((select) => {
        select.addEventListener('change', () => {
          const opening = map.room!.openings.find((item) => item.id === select.dataset.roomOpeningWall);
          if (!opening) return;
          opening.wall = select.value as typeof opening.wall;
          map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
          map.objects.forEach((object) => placeRoomOpeningObjectInPlace(map, object));
          this.markDirty();
          void this.refreshScene();
          this.renderMapInspector();
        });
      });
      host.querySelectorAll<HTMLInputElement>('[data-room-opening-number]').forEach((input) => {
        input.addEventListener('change', () => {
          const opening = map.room!.openings.find((item) => item.id === input.dataset.roomOpeningId);
          const field = input.dataset.roomOpeningNumber as 'offset' | 'bottom' | 'width' | 'height';
          const value = Number(input.value);
          if (!opening || !Number.isFinite(value)) return;
          opening[field] = value;
          map.room = normalizeMapRoom(map.room, map.box.size, map.room!);
          map.objects.forEach((object) => placeRoomOpeningObjectInPlace(map, object));
          this.markDirty();
          void this.refreshScene();
          this.renderMapInspector();
        });
      });
      host.querySelectorAll<HTMLButtonElement>('[data-remove-room-opening]').forEach((button) => {
        button.addEventListener('click', () => {
          const openingId = button.dataset.removeRoomOpening;
          map.room!.openings = map.room!.openings.filter((opening) => opening.id !== openingId);
          map.objects.forEach((object) => {
            if (object.roomOpeningId === openingId) object.roomOpeningId = undefined;
          });
          this.markDirty();
          void this.refreshScene();
          this.renderPanels();
        });
      });
    }
    host.querySelectorAll<HTMLInputElement>('[data-color]').forEach((input) => {
      input.addEventListener('input', () => {
        map.box.colors[input.dataset.color as keyof typeof map.box.colors] = input.value;
        this.markDirty();
        void this.refreshScene();
      });
    });
    host.querySelector<HTMLSelectElement>('[data-visual-zone-select]')?.addEventListener('change', (event) => {
      this.selectedVisualZoneId = (event.target as HTMLSelectElement).value;
      this.renderMapInspector();
    });
    const updateSelectedZone = (patch: VisualZonePatch, field: VisualZoneField): void => {
      if (!this.selectedVisualZoneId) return;
      map.visualSemantics = normalizeMapVisualSemantics(patchMapVisualZone(
        map.visualSemantics,
        this.selectedVisualZoneId,
        patch,
        { respectLocks: false, lockFields: [field] }
      ));
      this.markDirty();
      void this.refreshScene();
      this.renderMapInspector();
    };
    host.querySelectorAll<HTMLInputElement>('[data-vector="visual-zone-center"]').forEach((input) => {
      input.addEventListener('change', () => {
        const zone = map.visualSemantics.zones.find((item) => item.id === this.selectedVisualZoneId);
        const value = Number(input.value);
        if (!zone || !Number.isFinite(value)) return;
        const center = [...zone.center] as [number, number];
        center[Number(input.dataset.index)] = value;
        updateSelectedZone({ center }, 'center');
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-visual-zone-number]').forEach((input) => {
      input.addEventListener('change', () => {
        const value = Number(input.value);
        const field = input.dataset.visualZoneNumber as 'radius' | 'intensity';
        if (!Number.isFinite(value)) return;
        updateSelectedZone({ [field]: value }, field);
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-visual-zone-tag]').forEach((input) => {
      input.addEventListener('change', () => {
        const tags = [...host.querySelectorAll<HTMLInputElement>('[data-visual-zone-tag]:checked')]
          .map((item) => item.dataset.visualZoneTag as VisualZoneTag);
        updateSelectedZone({ tags }, 'tags');
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-visual-zone-lock]').forEach((input) => {
      input.addEventListener('change', () => {
        const field = input.dataset.visualZoneLock as VisualZoneField;
        map.visualSemantics = normalizeMapVisualSemantics({
          ...map.visualSemantics,
          zones: map.visualSemantics.zones.map((zone) => {
            if (zone.id !== this.selectedVisualZoneId) return zone;
            const locks = { ...(zone.locks ?? {}) };
            if (input.checked) locks[field] = true;
            else delete locks[field];
            return { ...zone, locks };
          })
        });
        this.markDirty(false);
        this.renderMapInspector();
      });
    });
    bindMaterialTagScenePanel(host, map, (label, enabled) => {
      this.markDirty();
      this.state.message = `${label}材质 Tag 已${enabled ? '开启' : '关闭'}`;
      void this.refreshScene();
      this.renderMapInspector();
      this.updateToolbarState();
    });
    host.querySelector<HTMLInputElement>('[data-brush-color]')?.addEventListener('input', (event) => {
      this.state.brushColor = (event.target as HTMLInputElement).value;
      this.renderPanels();
    });
    bindNumberState(host, '[data-brush-size]', (value) => { this.state.brushSize = value; });
    bindNumberState(host, '[data-brush-softness]', (value) => { this.state.brushSoftness = value; });
    host.querySelector<HTMLSelectElement>('[data-terrain-mode]')?.addEventListener('change', (event) => {
      this.state.terrainMode = (event.target as HTMLSelectElement).value as TerrainBrushMode;
    });
    host.querySelector<HTMLSelectElement>('[data-terrain-preset]')?.addEventListener('change', (event) => {
      this.state.terrainPreset = (event.target as HTMLSelectElement).value as TerrainGenerationPreset;
    });
    host.querySelector<HTMLSelectElement>('[data-terrain-action]')?.addEventListener('change', (event) => {
      this.state.terrainAction = (event.target as HTMLSelectElement).value as TerrainEditorAction;
      this.renderMapInspector();
    });
    host.querySelector<HTMLSelectElement>('[data-terrain-modifier]')?.addEventListener('change', (event) => {
      this.state.terrainModifier = (event.target as HTMLSelectElement).value as TerrainModifier;
      this.renderMapInspector();
    });
    host.querySelector<HTMLSelectElement>('[data-terrain-cliff-layout]')?.addEventListener('change', (event) => {
      this.state.terrainCliffLayout = (event.target as HTMLSelectElement).value as TerrainCliffLayout;
    });
    host.querySelector<HTMLSelectElement>('[data-terrain-surface]')?.addEventListener('change', (event) => {
      this.state.terrainSurface = (event.target as HTMLSelectElement).value as TerrainSurfaceKind;
    });
    host.querySelector('[data-terrain-preview-base]')?.addEventListener('click', () => void this.previewTerrainBase());
    host.querySelector('[data-terrain-reroll]')?.addEventListener('click', () => {
      this.terrainSeed = nextTerrainSeed(this.terrainSeed ?? map.seed);
      this.renderMapInspector();
    });
    bindNumberState(host, '[data-terrain-size]', (value) => { this.state.terrainSize = value; });
    bindNumberState(host, '[data-terrain-strength]', (value) => { this.state.terrainStrength = value; });
    bindNumberState(host, '[data-terrain-amplitude]', (value) => { this.state.terrainAmplitude = value; });
    bindNumberState(host, '[data-terrain-softness]', (value) => { this.state.terrainSoftness = value; });
    bindNumberState(host, '[data-terrain-direction]', (value) => { this.state.terrainDirection = value; });
    bindNumberState(host, '[data-terrain-layers]', (value) => { this.state.terrainLayers = Math.round(value); });
    if (this.state.tool === 'grass') {
      bindGrassEditorPanel(host, map, this.grassEditorState, {
        changed: (message) => {
          this.markDirty();
          this.state.message = message;
          this.scheduleGrassRefresh();
          this.renderPanels();
        },
        selectionChanged: () => this.renderMapInspector(),
      });
    }
  }

  private renderObjectInspector(): void {
    const host = this.app.querySelector<HTMLElement>('#object-inspector');
    if (!host) return;
    const map = this.state.map;
    const roomSurface = this.selectedRoomSurface();
    if (map?.room && roomSurface) {
      const selectionOpen = host.querySelector<HTMLDetailsElement>(`[data-selection-id="room-${roomSurface}"]`)?.open ?? true;
      host.innerHTML = `
        <details class="inspector-disclosure" data-inspector-section="selection" data-selection-id="room-${roomSurface}" ${selectionOpen ? 'open' : ''}>
          <summary><span><b>${roomSurfaceLabel(roomSurface)}</b><small>参数化房间表面</small></span></summary>
          <section class="editor-section inspector-body">
            <p class="empty">该表面属于房间外壳；尺寸由房间参数控制，可独立选择、绘制和修改基础颜色。</p>
            ${colorField('基础颜色', roomSurface, map.box.colors[roomSurface])}
          </section>
        </details>
      `;
      host.querySelector<HTMLInputElement>('[data-color]')?.addEventListener('input', (event) => {
        map.box.colors[roomSurface] = (event.target as HTMLInputElement).value;
        this.markDirty();
        void this.refreshScene();
      });
      return;
    }
    if (map && this.isPlayerSpawnSelected()) {
      const spawn = this.playerSpawnPoint();
      const playerMetrics = getMapPlayerMetrics(map);
      const selectionOpen = host.querySelector<HTMLDetailsElement>('[data-selection-id="player-spawn"]')?.open ?? true;
      host.innerHTML = `
        <details class="inspector-disclosure" data-inspector-section="selection" data-selection-id="player-spawn" ${selectionOpen ? 'open' : ''}>
          <summary><span><b>场景参考点</b><small>${spawn.map((value) => value.toFixed(2)).join(', ')}</small></span></summary>
          <section class="editor-section inspector-body">
          <p class="empty">用于预览、导航或后续运行时接入的默认空间参考点。</p>
          <div class="triple">${numberField('X', 'spawn-pos', 0, spawn[0])}${numberField('Y', 'spawn-pos', 1, spawn[1])}${numberField('Z', 'spawn-pos', 2, spawn[2])}</div>
          <label class="field compact"><span>朝向 Yaw（度）</span><input data-spawn-yaw type="number" step="1" value="${radiansToDegrees(getPlayerSpawnYaw(map)).toFixed(1)}" /></label>
          <div class="triple">${readonlyNumberField('宽', playerMetrics.radius * 2)}${readonlyNumberField('高', playerMetrics.height)}${readonlyNumberField('深', playerMetrics.radius * 2)}</div>
          </section>
        </details>
      `;
      const nextSpawn: [number, number, number] = [...spawn];
      bindVectorInputs(host, 'spawn-pos', nextSpawn, () => {
        this.setPlayerSpawnPoint(nextSpawn);
        this.markDirty();
        void this.refreshScene();
      });
      host.querySelector<HTMLInputElement>('[data-spawn-yaw]')?.addEventListener('change', (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (!Number.isFinite(value)) return;
        map.spawnYaw = degreesToRadians(value);
        this.markDirty();
        void this.refreshScene();
      });
      return;
    }
    if (map && this.isSunSelected()) {
      const sunPosition = getSunPosition(map);
      const selectionOpen = host.querySelector<HTMLDetailsElement>('[data-selection-id="sun"]')?.open ?? true;
      host.innerHTML = `
        <details class="inspector-disclosure" data-inspector-section="selection" data-selection-id="sun" ${selectionOpen ? 'open' : ''}>
          <summary><span><b>太阳</b><small>${sunPosition.map((value) => value.toFixed(1)).join(', ')}</small></span></summary>
          <section class="editor-section inspector-body">
          <p class="empty">调整太阳的位置会改变地图中的主方向光照。太阳始终朝向地图中心。</p>
          <div class="triple">${numberField('X', 'sun-pos', 0, sunPosition[0])}${numberField('Y', 'sun-pos', 1, sunPosition[1])}${numberField('Z', 'sun-pos', 2, sunPosition[2])}</div>
          </section>
        </details>
      `;
      const nextSun: [number, number, number] = [...sunPosition];
      bindVectorInputs(host, 'sun-pos', nextSun, () => {
        this.setSunPosition(nextSun);
        this.markDirty();
        void this.refreshScene();
      });
      return;
    }
    const object = this.selectedObject();
    if (!object || !map) {
      host.innerHTML = '';
      return;
    }
    const availableAssets = this.state.assets;
    const selectionOpen = host.querySelector<HTMLDetailsElement>(`[data-selection-id="${CSS.escape(object.id)}"]`)?.open ?? true;
    host.innerHTML = `
      <details class="inspector-disclosure" data-inspector-section="selection" data-selection-id="${escapeHtml(object.id)}" ${selectionOpen ? 'open' : ''}>
        <summary><span><b>物体</b><small>${escapeHtml(object.name)}</small></span></summary>
        <section class="editor-section inspector-body">
        <label class="field compact"><span>名称</span><input data-object-name value="${escapeHtml(object.name)}" /></label>
        <label class="field compact">
          <span>父级</span>
          <select data-parent>
            <option value="">无</option>
            ${map.objects.filter((item) => item.id !== object.id).map((item) => `<option value="${item.id}" ${object.parentId === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field compact"><span>地形高度</span><select data-object-height-mode>
          <option value="terrain" ${object.heightMode === 'terrain' ? 'selected' : ''}>随地形重贴地</option>
          <option value="fixed" ${object.heightMode === 'fixed' ? 'selected' : ''}>固定 Y 高度</option>
        </select></label>
        ${map.room ? `<label class="field compact"><span>门窗预留绑定</span><select data-room-opening-link>
          <option value="">无</option>
          ${map.room.openings.map((opening) => `<option value="${escapeHtml(opening.id)}" ${object.roomOpeningId === opening.id ? 'selected' : ''}>${escapeHtml(opening.id)} · ${opening.kind === 'door' ? '门' : '窗'} · ${roomSurfaceLabel(opening.wall)}</option>`).join('')}
        </select></label>` : ''}
        <div class="triple">${numberField('X', 'pos', 0, object.transform.position[0])}${numberField('Y', 'pos', 1, object.transform.position[1])}${numberField('Z', 'pos', 2, object.transform.position[2])}</div>
        <div class="triple">${numberField('RX', 'rot', 0, radiansToDegrees(object.transform.rotation[0]))}${numberField('RY', 'rot', 1, radiansToDegrees(object.transform.rotation[1]))}${numberField('RZ', 'rot', 2, radiansToDegrees(object.transform.rotation[2]))}</div>
        <label class="field compact"><span>等比例缩放</span><input data-uniform-scale type="checkbox" ${this.state.uniformScale ? 'checked' : ''} /></label>
        <div class="triple">${numberField('SX', 'scale', 0, object.transform.scale[0])}${numberField('SY', 'scale', 1, object.transform.scale[1])}${numberField('SZ', 'scale', 2, object.transform.scale[2])}</div>
        <div class="triple">${numberField('宽', 'size', 0, object.transform.size[0])}${numberField('高', 'size', 1, object.transform.size[1])}${numberField('深', 'size', 2, object.transform.size[2])}</div>
        <label class="field compact">
          <span>资产</span>
          <select data-object-asset>
            <option value="">未绑定</option>
            ${availableAssets.map((asset) => `<option value="${asset.id}" ${object.assetId === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)} · ${escapeHtml(asset.mode.toUpperCase())}</option>`).join('')}
          </select>
        </label>
        <button id="delete-object" class="secondary small">删除物体</button>
        </section>
      </details>
    `;
    host.querySelector<HTMLInputElement>('[data-object-name]')?.addEventListener('input', (event) => {
      object.name = (event.target as HTMLInputElement).value;
      this.markDirty(false);
      this.renderHierarchy();
    });
    host.querySelector<HTMLSelectElement>('[data-parent]')?.addEventListener('change', (event) => {
      object.parentId = (event.target as HTMLSelectElement).value || null;
      this.markDirty();
      void this.refreshScene();
    });
    host.querySelector<HTMLSelectElement>('[data-object-asset]')?.addEventListener('change', (event) => {
      object.assetId = (event.target as HTMLSelectElement).value || null;
      this.markDirty();
      void this.refreshScene();
    });
    host.querySelector<HTMLSelectElement>('[data-object-height-mode]')?.addEventListener('change', (event) => {
      object.heightMode = (event.target as HTMLSelectElement).value === 'fixed' ? 'fixed' : 'terrain';
      if (object.heightMode === 'terrain' && !object.parentId) {
        object.transform.position[1] = sampleTerrainHeight(map, object.transform.position[0], object.transform.position[2]);
      }
      this.markDirty();
      void this.refreshScene();
    });
    host.querySelector<HTMLSelectElement>('[data-room-opening-link]')?.addEventListener('change', (event) => {
      object.roomOpeningId = (event.target as HTMLSelectElement).value || undefined;
      if (object.roomOpeningId) placeRoomOpeningObjectInPlace(map, object);
      this.markDirty();
      void this.refreshScene();
      this.renderObjectInspector();
    });
    bindVectorInputs(host, 'pos', object.transform.position, () => {
      syncRoomOpeningFromObjectInPlace(map, object);
      this.markDirty();
      void this.refreshScene();
    });
    host.querySelectorAll<HTMLInputElement>('[data-vector="rot"]').forEach((input) => {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.index);
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        object.transform.rotation[index] = degreesToRadians(value);
        this.markDirty();
        void this.refreshScene();
      });
    });
    this.bindScaleInputs(host, object);
    bindVectorInputs(host, 'size', object.transform.size, () => {
      this.markDirty();
      void this.refreshScene();
    }, true);
    host.querySelector('#delete-object')?.addEventListener('click', () => {
      this.deleteSelectedObject();
    });
  }

  private renderAssetPanel(): void {
    const host = this.app.querySelector<HTMLElement>('#asset-panel');
    if (!host) return;
    const availableAssets = this.state.assets;
    const selectedAsset = availableAssets.find((asset) => asset.id === this.state.selectedAssetId) ?? availableAssets[0] ?? null;
    if (this.state.selectedAssetId !== selectedAsset?.id) this.state.selectedAssetId = selectedAsset?.id ?? null;
    const assetPanelOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="assets"]')?.open ?? Boolean(this.placingAssetId);
    const assetLibraryOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="asset-library"]')?.open ?? this.previewingLibraryAsset;
    host.innerHTML = `
      <details class="inspector-disclosure" data-inspector-section="assets" ${assetPanelOpen || Boolean(this.placingAssetId) ? 'open' : ''}>
        <summary><span><b>资产</b><small>${selectedAsset ? escapeHtml(`${selectedAsset.name} · ${selectedAsset.mode.toUpperCase()}`) : `${availableAssets.length} 个可用`}</small></span></summary>
        <section class="editor-section inspector-body asset-tools">
        <textarea id="asset-prompt" placeholder="例如：一座低多边形林间小木屋"></textarea>
        <p class="empty">新生成资产默认使用 ${this.state.map?.assetGenerationMode.toUpperCase() ?? 'VOXEL'}；已有资产可跨模式混合使用。</p>
        <button id="generate-asset" ${this.state.busy ? 'disabled' : ''}>生成资产</button>
        <p class="empty">资产列表显示全部模式，名称后会标注生成模式。</p>
        <select id="asset-list" ${selectedAsset ? '' : 'disabled'}>
          ${availableAssets.map((asset) => `<option value="${asset.id}" ${selectedAsset?.id === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)} · ${escapeHtml(asset.mode.toUpperCase())}</option>`).join('')}
        </select>
        <div id="asset-preview" class="asset-preview"></div>
        ${selectedAsset ? `
          <div class="style-tags">${(selectedAsset.tags?.length ? selectedAsset.tags : ['未标注'])
            .map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        ` : ''}
        <p class="empty">${selectedAsset
          ? `模式 ${selectedAsset.mode.toUpperCase()} · 尺寸 ${selectedAsset.sizeClass ?? '未分类'} · 占地半径 ${(selectedAsset.footprintRadius ?? 0.5).toFixed(2)}m · 自动碰撞箱 ${selectedAsset.colliderPlan.boxes.length} 个${selectedAsset.colliderPlan.fallbackUsed ? ' · 已回退整体边界' : ''}`
          : '尚未选择资产'}</p>
        <button id="place-selected-asset" ${selectedAsset ? '' : 'disabled'}>${this.placingAssetId === selectedAsset?.id ? '取消放置' : '放入地图'}</button>
        <button id="bind-selected-asset" class="secondary small" ${this.selectedObject() && selectedAsset ? '' : 'disabled'}>绑定到选中物体</button>
        </section>
      </details>
      ${this.renderAssetLibraryManager(selectedAsset, assetLibraryOpen)}
    `;
    const previewHost = host.querySelector<HTMLElement>(this.previewingLibraryAsset ? '#library-asset-preview' : '#asset-preview');
    if (previewHost && this.previewRenderer) {
      previewHost.appendChild(this.previewRenderer.domElement);
      this.resizePreview();
    }
    host.querySelector('#generate-asset')?.addEventListener('click', () => void this.generateAsset());
    host.querySelector<HTMLSelectElement>('#asset-list')?.addEventListener('change', (event) => {
      this.cancelAssetPlacement();
      this.previewingLibraryAsset = false;
      this.state.selectedAssetId = (event.target as HTMLSelectElement).value;
      this.renderPanels();
    });
    host.querySelector('#place-selected-asset')?.addEventListener('click', () => {
      if (this.placingAssetId === this.state.selectedAssetId) {
        this.cancelAssetPlacement();
        this.renderPanels();
        return;
      }
      void this.beginAssetPlacement();
    });
    host.querySelector('#bind-selected-asset')?.addEventListener('click', () => {
      const object = this.selectedObject();
      if (!object || !this.state.selectedAssetId) return;
      object.assetId = this.state.selectedAssetId;
      this.markDirty();
      void this.refreshScene();
      this.renderPanels();
    });
    this.bindAssetLibraryManager(host);
    void this.renderAssetPreview();
  }

  private renderAssetLibraryManager(selectedAsset: MapAsset | null, open: boolean): string {
    const selectedLibrary = this.state.assetLibraries.find((library) => library.id === this.activeAssetLibraryId) ?? null;
    const libraryAsset = this.state.libraryAssets.find((asset) => asset.id === this.selectedLibraryAssetId) ?? null;
    const metadata = libraryAsset?.libraryMetadata;
    return `
      <details class="inspector-disclosure" data-inspector-section="asset-library" ${open ? 'open' : ''}>
        <summary><span><b>资产库</b><small>${selectedLibrary ? `${escapeHtml(selectedLibrary.name)} · ${this.state.libraryAssets.length} 个` : '创建或导入资产库'}</small></span></summary>
        <section class="editor-section inspector-body asset-library-tools">
          <label class="field compact"><span>当前资产库</span>
            <select id="asset-library-list" ${this.state.assetLibraries.length ? '' : 'disabled'}>
              ${this.state.assetLibraries.length ? this.state.assetLibraries.map((library) => `
                <option value="${library.id}" ${library.id === this.activeAssetLibraryId ? 'selected' : ''}>${escapeHtml(library.name)} · ${library.assetIds.length} 个</option>
              `).join('') : '<option value="">尚无资产库</option>'}
            </select>
          </label>
          <div class="asset-library-inline">
            <input id="new-asset-library-name" maxlength="48" placeholder="新资产库名称" />
            <button id="create-asset-library" class="secondary small" type="button">新建</button>
          </div>
          <div class="asset-library-actions">
            <button id="add-asset-to-library" class="secondary small" type="button" ${selectedLibrary && selectedAsset ? '' : 'disabled'}>收藏当前资产</button>
            <button id="import-library-asset" class="secondary small" type="button" ${selectedLibrary ? '' : 'disabled'}>导入模型 JSON</button>
            <button id="export-asset-library" class="secondary small" type="button" ${selectedLibrary ? '' : 'disabled'}>分享导出</button>
            <button id="import-asset-library" class="secondary small" type="button">导入资产库</button>
          </div>
          <input id="library-asset-file" type="file" accept="application/json,.json" hidden />
          <input id="asset-library-file" type="file" accept="application/json,.json" hidden />
          ${selectedLibrary ? `
            <label class="field compact"><span>库内资产</span>
              <select id="library-asset-list" ${libraryAsset ? '' : 'disabled'}>
                ${this.state.libraryAssets.length ? this.state.libraryAssets.map((asset) => `
                  <option value="${asset.id}" ${asset.id === libraryAsset?.id ? 'selected' : ''}>${escapeHtml(asset.name)}${asset.libraryMetadata?.analysisStatus === 'pending' ? ' · 待分析' : ''}</option>
                `).join('') : '<option value="">资产库为空</option>'}
              </select>
            </label>
          ` : ''}
          ${libraryAsset && metadata ? `
            <div id="library-asset-preview" class="asset-preview"></div>
            <label class="field compact"><span>名称</span><input id="library-asset-name" maxlength="48" value="${escapeHtml(libraryAsset.name)}" /></label>
            <label class="field compact"><span>语义标签（逗号分隔）</span><input id="library-asset-tags" value="${escapeHtml(metadata.tags.join(', '))}" /></label>
            <fieldset class="asset-library-zones"><legend>适用区域</legend>
              ${ASSET_LIBRARY_ZONE_TAGS.map((zone) => `<label><input type="checkbox" data-library-zone="${zone}" ${metadata.applicableZones.includes(zone) ? 'checked' : ''} />${zone}</label>`).join('')}
            </fieldset>
            <p class="empty">尺寸 ${libraryAsset.sizeClass ?? '未分类'} · 占地半径 ${(libraryAsset.footprintRadius ?? 0.5).toFixed(2)}m · ${metadata.analysisStatus === 'ready' ? 'AI 标签已就绪' : 'AI 分析待重试，当前不会供生成使用'}</p>
            <div class="asset-library-flags">
              <label><input id="library-asset-repeatable" type="checkbox" ${metadata.repeatable ? 'checked' : ''} />可重复</label>
              <label><input id="library-asset-landmark" type="checkbox" ${metadata.landmark ? 'checked' : ''} />地标</label>
              <label><input id="library-asset-enabled" type="checkbox" ${metadata.enabled ? 'checked' : ''} />启用</label>
            </div>
            <label class="field compact"><span>推荐优先级</span><input id="library-asset-priority" type="range" min="0" max="1" step="0.05" value="${metadata.priority}" /></label>
            <details class="inspector-disclosure compact">
              <summary><span><b>更多详细参数</b><small>摆放约束与来源</small></span></summary>
              <div class="asset-library-details">
                <label class="field compact"><span>推荐密度</span><input id="library-asset-density" type="number" min="0.01" max="1" step="0.01" value="${metadata.density ?? ''}" placeholder="自动" /></label>
                <label class="field compact"><span>最小间距（m）</span><input id="library-asset-spacing" type="number" min="0.1" max="100" step="0.1" value="${metadata.minSpacing ?? ''}" placeholder="自动" /></label>
                <div class="asset-library-inline"><label class="field compact"><span>最小缩放</span><input id="library-asset-scale-min" type="number" min="0.05" max="20" step="0.05" value="${metadata.scaleRange?.[0] ?? ''}" placeholder="自动" /></label><label class="field compact"><span>最大缩放</span><input id="library-asset-scale-max" type="number" min="0.05" max="20" step="0.05" value="${metadata.scaleRange?.[1] ?? ''}" placeholder="自动" /></label></div>
                <label class="field compact"><span>旋转策略</span><select id="library-asset-rotation"><option value="random" ${metadata.rotation === 'random' ? 'selected' : ''}>随机朝向</option><option value="fixed" ${metadata.rotation === 'fixed' ? 'selected' : ''}>固定朝向</option></select></label>
                <p class="empty">来源：独立资产库快照 · ${escapeHtml(libraryAsset.mode.toUpperCase())}</p>
              </div>
            </details>
            <div class="asset-library-actions">
              <button id="save-library-asset" type="button">保存标签</button>
              <button id="analyze-library-asset" class="secondary small" type="button">重新 AI 分析</button>
              <button id="remove-library-asset" class="secondary small" type="button">从库移除</button>
            </div>
          ` : ''}
          ${selectedLibrary ? `<button id="delete-asset-library" class="secondary small" type="button">删除当前库</button>` : ''}
        </section>
      </details>
    `;
  }

  private bindAssetLibraryManager(host: HTMLElement): void {
    host.querySelector<HTMLSelectElement>('#asset-library-list')?.addEventListener('change', async (event) => {
      await this.selectAssetLibrary((event.target as HTMLSelectElement).value);
      this.previewingLibraryAsset = true;
      this.renderPanels();
    });
    host.querySelector('#create-asset-library')?.addEventListener('click', () => void this.createAssetLibrary());
    host.querySelector('#add-asset-to-library')?.addEventListener('click', () => void this.addSelectedAssetToLibrary());
    host.querySelector('#import-library-asset')?.addEventListener('click', () => host.querySelector<HTMLInputElement>('#library-asset-file')?.click());
    host.querySelector<HTMLInputElement>('#library-asset-file')?.addEventListener('change', (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.importModelIntoLibrary(file);
    });
    host.querySelector('#export-asset-library')?.addEventListener('click', () => void this.exportAssetLibrary());
    host.querySelector('#import-asset-library')?.addEventListener('click', () => host.querySelector<HTMLInputElement>('#asset-library-file')?.click());
    host.querySelector<HTMLInputElement>('#asset-library-file')?.addEventListener('change', (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.importAssetLibrary(file);
    });
    host.querySelector<HTMLSelectElement>('#library-asset-list')?.addEventListener('change', (event) => {
      this.selectedLibraryAssetId = (event.target as HTMLSelectElement).value;
      this.previewingLibraryAsset = true;
      this.renderPanels();
    });
    host.querySelector('#save-library-asset')?.addEventListener('click', () => void this.saveLibraryAssetMetadata(host));
    host.querySelector('#analyze-library-asset')?.addEventListener('click', () => void this.analyzeLibraryAsset());
    host.querySelector('#remove-library-asset')?.addEventListener('click', () => void this.removeLibraryAsset());
    host.querySelector('#delete-asset-library')?.addEventListener('click', () => void this.deleteAssetLibrary());
  }

  private async selectAssetLibrary(id: string): Promise<void> {
    this.activeAssetLibraryId = id;
    localStorage.setItem('worldforge.activeAssetLibraryId', id);
    this.state.libraryAssets = id
      ? (await editorFetch<{ assets: MapAsset[] }>(`/api/editor/asset-libraries/${encodeURIComponent(id)}`)).assets
      : [];
    this.selectedLibraryAssetId = this.state.libraryAssets[0]?.id ?? '';
    if (!id) this.mapAiReuseExistingAssets = false;
  }

  private async refreshAssetLibraries(preferredLibraryId = this.activeAssetLibraryId): Promise<void> {
    const { libraries } = await editorFetch<{ libraries: AssetLibrary[] }>('/api/editor/asset-libraries');
    this.state.assetLibraries = libraries;
    const selected = libraries.some((library) => library.id === preferredLibraryId)
      ? preferredLibraryId
      : libraries[0]?.id ?? '';
    await this.selectAssetLibrary(selected);
  }

  private async createAssetLibrary(): Promise<void> {
    const name = this.app.querySelector<HTMLInputElement>('#new-asset-library-name')?.value.trim() ?? '';
    if (!name || this.state.busy) return;
    this.setBusy(true, '正在创建资产库...');
    try {
      const { library } = await editorFetch<{ library: AssetLibrary }>('/api/editor/asset-libraries', {
        method: 'POST', body: JSON.stringify({ name })
      });
      await this.refreshAssetLibraries(library.id);
      this.state.message = `资产库“${library.name}”已创建`;
    } catch (error) {
      this.state.message = `创建资产库失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async addSelectedAssetToLibrary(): Promise<void> {
    if (!this.activeAssetLibraryId || !this.state.selectedAssetId || this.state.busy) return;
    this.setBusy(true, 'AI 正在为资产补充标签...');
    try {
      const result = await editorFetch<{ asset: MapAsset }>(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/assets`, {
        method: 'POST',
        body: JSON.stringify({ assetId: this.state.selectedAssetId, provider: this.mapAiProvider })
      });
      await this.refreshAssetLibraries(this.activeAssetLibraryId);
      this.selectedLibraryAssetId = result.asset.id;
      this.previewingLibraryAsset = true;
      this.state.message = result.asset.libraryMetadata?.analysisStatus === 'ready'
        ? '资产已收藏，AI 标签已自动填写'
        : '资产已收藏；AI 标签暂时待分析，当前不会用于生成';
    } catch (error) {
      this.state.message = `收藏资产失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async importModelIntoLibrary(file: File): Promise<void> {
    if (!this.activeAssetLibraryId || this.state.busy) return;
    this.setBusy(true, '正在导入模型并分析标签...');
    try {
      const input = JSON.parse(await file.text()) as { name?: string; prompt?: string; tags?: string[]; modelJson?: unknown; mode?: string };
      const result = await editorFetch<{ asset: MapAsset }>(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/import-asset`, {
        method: 'POST',
        body: JSON.stringify({
          name: input.name ?? file.name.replace(/\.json$/i, ''),
          prompt: input.prompt,
          tags: input.tags,
          modelJson: input.modelJson ?? input,
          mode: input.mode,
          provider: this.mapAiProvider
        })
      });
      await this.refreshAssetLibraries(this.activeAssetLibraryId);
      this.selectedLibraryAssetId = result.asset.id;
      this.previewingLibraryAsset = true;
      this.state.message = '模型已导入资产库';
    } catch (error) {
      this.state.message = `导入模型失败：${error instanceof Error ? error.message : '文件不是有效 JSON'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async exportAssetLibrary(): Promise<void> {
    if (!this.activeAssetLibraryId) return;
    const library = this.state.assetLibraries.find((item) => item.id === this.activeAssetLibraryId);
    const pack = await editorFetch<AssetLibraryPack>(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/export`);
    downloadJson(`${safeDownloadName(library?.name ?? 'asset-library')}.worldforge-assets.json`, pack);
    this.state.message = '资产库分享包已导出';
    this.updateToolbarState();
  }

  private async importAssetLibrary(file: File): Promise<void> {
    if (this.state.busy) return;
    this.setBusy(true, '正在导入资产库...');
    try {
      const result = await editorFetch<{ library: AssetLibrary }>('/api/editor/asset-libraries/import', {
        method: 'POST', body: await file.text()
      });
      await this.refreshAssetLibraries(result.library.id);
      this.previewingLibraryAsset = true;
      this.state.message = `资产库“${result.library.name}”已导入，资产 ID 已安全重建`;
    } catch (error) {
      this.state.message = `导入资产库失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async saveLibraryAssetMetadata(host: HTMLElement): Promise<void> {
    if (!this.activeAssetLibraryId || !this.selectedLibraryAssetId) return;
    const assetId = this.selectedLibraryAssetId;
    const numberOrUndefined = (selector: string): number | undefined => {
      const value = host.querySelector<HTMLInputElement>(selector)?.value.trim();
      return value && Number.isFinite(Number(value)) ? Number(value) : undefined;
    };
    const scaleMin = numberOrUndefined('#library-asset-scale-min');
    const scaleMax = numberOrUndefined('#library-asset-scale-max');
    const metadata: Partial<AssetLibraryMetadata> = {
      tags: (host.querySelector<HTMLInputElement>('#library-asset-tags')?.value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      applicableZones: [...host.querySelectorAll<HTMLInputElement>('[data-library-zone]:checked')].map((input) => input.dataset.libraryZone as AssetLibraryMetadata['applicableZones'][number]),
      repeatable: host.querySelector<HTMLInputElement>('#library-asset-repeatable')?.checked === true,
      landmark: host.querySelector<HTMLInputElement>('#library-asset-landmark')?.checked === true,
      enabled: host.querySelector<HTMLInputElement>('#library-asset-enabled')?.checked === true,
      priority: numberOrUndefined('#library-asset-priority'),
      density: numberOrUndefined('#library-asset-density'),
      minSpacing: numberOrUndefined('#library-asset-spacing'),
      ...(scaleMin !== undefined && scaleMax !== undefined ? { scaleRange: [scaleMin, scaleMax] } : {}),
      rotation: host.querySelector<HTMLSelectElement>('#library-asset-rotation')?.value === 'fixed' ? 'fixed' : 'random'
    };
    await editorFetch(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: host.querySelector<HTMLInputElement>('#library-asset-name')?.value, metadata })
    });
    await this.selectAssetLibrary(this.activeAssetLibraryId);
    this.selectedLibraryAssetId = this.state.libraryAssets.find((asset) => asset.id === assetId)?.id ?? this.state.libraryAssets[0]?.id ?? '';
    this.state.message = '资产库标签已保存';
    this.renderPanels();
  }

  private async analyzeLibraryAsset(): Promise<void> {
    if (!this.activeAssetLibraryId || !this.selectedLibraryAssetId || this.state.busy) return;
    const assetId = this.selectedLibraryAssetId;
    this.setBusy(true, 'AI 正在重新分析资产...');
    try {
      await editorFetch(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/assets/${encodeURIComponent(assetId)}/analyze`, {
        method: 'POST', body: JSON.stringify({ provider: this.mapAiProvider })
      });
      await this.selectAssetLibrary(this.activeAssetLibraryId);
      this.selectedLibraryAssetId = assetId;
      this.state.message = '资产标签分析已更新';
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private async removeLibraryAsset(): Promise<void> {
    if (!this.activeAssetLibraryId || !this.selectedLibraryAssetId) return;
    await editorFetch(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}/assets/${encodeURIComponent(this.selectedLibraryAssetId)}`, { method: 'DELETE' });
    await this.refreshAssetLibraries(this.activeAssetLibraryId);
    this.previewingLibraryAsset = true;
    this.state.message = '资产已从库中移除；已使用它的地图不受影响';
    this.renderPanels();
  }

  private async deleteAssetLibrary(): Promise<void> {
    if (!this.activeAssetLibraryId) return;
    await editorFetch(`/api/editor/asset-libraries/${encodeURIComponent(this.activeAssetLibraryId)}`, { method: 'DELETE' });
    await this.refreshAssetLibraries('');
    this.mapAiReuseExistingAssets = false;
    this.state.message = '资产库已删除；已有地图中的资产快照仍然保留';
    this.renderPanels();
  }

  private renderDeveloperPresetEditor(draft: RenderScheme): string {
    const shader = draft.renderPlan ? compileRuntimeShaderExtension(draft.renderPlan) : { mode: 'off' as const };
    return `
      <section class="editor-section developer-render-panel">
        <div class="developer-panel-heading">
          <span><b>开发者调节</b><small>修改时实时预览，保存时创建新方案</small></span>
          <div class="segmented compact developer-view-switcher">
            <button type="button" data-dev-view="tuning" class="${this.developerRenderView === 'tuning' ? 'active' : ''}">效果调节</button>
            <button type="button" data-dev-view="access" class="${this.developerRenderView === 'access' ? 'active' : ''}">开放范围</button>
          </div>
        </div>
        ${this.developerRenderView === 'access' ? `
          <div class="developer-scheme-fields">
            <label class="field compact">
              <span>方案名称</span>
              <input data-dev-scheme-field="name" maxlength="48" value="${escapeHtml(draft.name)}" />
            </label>
            <label class="field compact">
              <span>方案说明</span>
              <textarea data-dev-scheme-field="description" rows="2" maxlength="160">${escapeHtml(draft.description)}</textarea>
            </label>
          </div>
        ` : ''}
        ${renderDeveloperWorkspace(
          draft,
          this.hdriFiles,
          this.developerRenderCategory,
          this.developerRenderView
        )}
        ${this.renderHdriClassificationEditor(draft)}
        <div class="developer-save-bar">
          <p id="render-tuning-note" class="empty">${this.renderDraftChanged
            ? '当前修改正在预览；保存后会生成新方案，不会改动原预设。'
            : '调节参数不会覆盖原预设。'}</p>
          ${this.renderAiPreview ? '' : `<button id="save-render-scheme">${this.renderDraftChanged ? '保存为新方案' : '复制为新方案'}</button>`}
        </div>
        ${shader.mode === 'isolated-glsl' ? `
          <p class="developer-warning">完整 GLSL 只作为隔离扩展保存在方案中；当前基础编辑器不会执行它，也不会修改核心源码。</p>
        ` : ''}
      </section>
    `;
  }

  private renderHdriClassificationEditor(draft: RenderScheme): string {
    if (this.developerRenderView !== 'tuning' || this.developerRenderCategory !== 'environment' || !draft.renderPlan) return '';
    const file = compileRuntimeHdriSky(draft.renderPlan).texture;
    const texture = this.hdriTextures.find((entry) => entry.file === file);
    if (!texture) return '';
    const time = ['morning', 'day', 'evening'].find((tag) => texture.tags.includes(tag)) ?? '';
    const temperature = ['cool', 'warm'].find((tag) => texture.tags.includes(tag)) ?? '';
    return `
      <section class="hdri-classification" data-hdri-file="${escapeHtml(file)}">
        <div><b>天空分类</b><small>${escapeHtml(file)} · 供 AI 软匹配，不锁死随机性</small></div>
        <label><span>时间</span><select data-hdri-category="timeOfDay">
          <option value="" ${time ? '' : 'selected'}>未分类</option>
          <option value="morning" ${time === 'morning' ? 'selected' : ''}>早晨</option>
          <option value="day" ${time === 'day' ? 'selected' : ''}>白天</option>
          <option value="evening" ${time === 'evening' ? 'selected' : ''}>傍晚</option>
        </select></label>
        <label><span>色温</span><select data-hdri-category="temperature">
          <option value="" ${temperature ? '' : 'selected'}>未分类</option>
          <option value="cool" ${temperature === 'cool' ? 'selected' : ''}>冷</option>
          <option value="warm" ${temperature === 'warm' ? 'selected' : ''}>暖</option>
        </select></label>
      </section>
    `;
  }

  private renderRenderInspector(): void {
    const host = this.app.querySelector<HTMLElement>('#render-inspector');
    if (!host) return;
    const map = this.mapAiPreviewMap ?? this.state.map;
    if (!map?.confirmedAt) {
      host.innerHTML = '<section class="editor-section"><h2>渲染方案</h2><p class="empty">请先确认地图。</p></section>';
      return;
    }
    const selected = this.selectedRenderScheme();
    if (!this.renderAiPreview && (!this.renderDraft || this.renderDraft.id !== selected?.id)) this.resetRenderDraft();
    const draft = this.renderDraft;
    const activeSchemeId = this.renderAiPreview
      ? this.renderAiPreviewVisible ? draft?.id : this.renderAiComparisonScheme?.id
      : selected?.id;
    const renderAiOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="render-ai"]')?.open ?? true;
    const schemeLibraryOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="scheme-library"]')?.open ?? true;
    const renderTuningOpen = host.querySelector<HTMLDetailsElement>('[data-inspector-section="render-tuning"]')?.open ?? false;
    host.innerHTML = `
      ${draft && this.developerMode ? this.renderDeveloperPresetEditor(draft) : ''}
      <details class="inspector-disclosure" data-inspector-section="render-ai" ${renderAiOpen || this.state.busy || Boolean(this.renderAiPreview) ? 'open' : ''}>
        <summary><span><b>AI 生成风格</b><small>一句话编排光照与氛围</small></span></summary>
        <section class="editor-section inspector-body render-ai">
          <div class="section-title-row">
          ${map.renderPromptSuggestions.length > 0 ? `
            <details class="render-prompt-suggestions">
              <summary>氛围建议</summary>
              <div class="render-prompt-suggestion-menu">
                ${map.renderPromptSuggestions.map((suggestion) => `
                  <button type="button" data-render-prompt-suggestion="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>
                `).join('')}
              </div>
            </details>
          ` : ''}
          </div>
        <textarea id="render-ai-prompt" rows="3" maxlength="1000" placeholder="例如：素描风格的宁静田园，带有柔和晨雾">${escapeHtml(this.renderAiPrompt)}</textarea>
        <div class="render-ai-controls">
          <button id="generate-render-ai" ${this.state.busy || !this.renderAiPrompt.trim() ? 'disabled' : ''}>生成新风格</button>
          <button id="refine-render-ai" class="secondary" ${this.state.busy || !this.renderAiPrompt.trim() || !draft ? 'disabled' : ''}>
            ${this.renderAiPreview ? '继续调整预览' : '调整当前方案'}
          </button>
          ${this.renderAiAbortController ? '<button id="cancel-render-ai" class="secondary">取消</button>' : ''}
        </div>
        ${renderAgentProgress(this.renderAgentProgress, {
          running: Boolean(this.renderAiAbortController),
          elapsedMs: this.renderAgentElapsedMs
        })}
        </section>
      </details>
      ${this.renderAiPreview && draft ? `
        <section class="editor-section render-ai-result">
          <span class="stage-kicker">AI 建议 · ${escapeHtml(draft.name)}</span>
          <p>${escapeHtml(this.renderAiExplanation || '已根据提示词生成可预览的渲染方案。')}</p>
          <div class="preview-comparison segmented compact" aria-label="渲染 Refine 前后对比">
            <button type="button" data-render-preview-view="before" class="${this.renderAiPreviewVisible ? '' : 'active'}">修改前</button>
            <button type="button" data-render-preview-view="after" class="${this.renderAiPreviewVisible ? 'active' : ''}">修改后预览</button>
          </div>
          ${draft.styleTags.length > 0 ? `
            <div class="style-tags">${draft.styleTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
          ` : ''}
          ${draft.renderPlan?.modules.length ? `
            <p class="empty">已编排模块</p>
            <div class="style-tags">${draft.renderPlan.modules.map((module) => `<span>${escapeHtml(renderModuleLabel(module.id))}</span>`).join('')}</div>
          ` : ''}
          <div class="render-ai-actions">
            <button id="discard-render-ai" class="secondary">放弃预览</button>
            <button id="apply-render-ai">应用并另存</button>
          </div>
        </section>
      ` : ''}
      <details class="inspector-disclosure scheme-library" data-inspector-section="scheme-library" ${schemeLibraryOpen ? 'open' : ''}>
        <summary><span><b>方案库</b><small>${this.state.renderSchemes.length} 个方案</small></span></summary>
        <section class="editor-section inspector-body">
        <div class="render-scheme-list">
          ${this.state.renderSchemes.map((scheme) => `
            <div class="render-scheme-item ${scheme.kind}">
              <button class="render-scheme-card ${scheme.id === activeSchemeId ? 'active' : ''}" data-render-scheme="${scheme.id}" title="${escapeHtml(scheme.description || scheme.name)}">
                <span class="scheme-swatch" style="--scheme-bg:${scheme.settings.background};--scheme-sun:${scheme.settings.sunColor}"></span>
                <strong>${escapeHtml(scheme.name)}</strong>
              </button>
              ${scheme.kind === 'custom' ? `<button class="render-scheme-delete danger" data-delete-render-scheme="${scheme.id}" title="删除 ${escapeHtml(scheme.name)}" aria-label="删除 ${escapeHtml(scheme.name)}" ${this.state.dirty || this.renderDraftChanged ? 'disabled' : ''}>×</button>` : ''}
            </div>
          `).join('')}
        </div>
        </section>
      </details>
      ${draft && !this.developerMode ? `
        <details class="inspector-disclosure" data-inspector-section="render-tuning" ${renderTuningOpen ? 'open' : ''}>
          <summary><span><b>安全微调</b><small>${escapeHtml(draft.name)}</small></span></summary>
          <section class="editor-section inspector-body render-tuning">
          <label class="field compact">
            <span>曝光 <output data-render-output="exposure">${draft.settings.exposure.toFixed(2)}</output></span>
            <input data-render-number="exposure" type="range" min="0.2" max="2" step="0.02" value="${draft.settings.exposure}" />
          </label>
          <label class="field compact">
            <span>雾浓度 <output data-render-output="fogDensity">${draft.settings.fogDensity.toFixed(3)}</output></span>
            <input data-render-number="fogDensity" type="range" min="0" max="0.05" step="0.001" value="${draft.settings.fogDensity}" />
          </label>
          <label class="field compact">
            <span>主光强度 <output data-render-output="sunIntensity">${draft.settings.sunIntensity.toFixed(1)}</output></span>
            <input data-render-number="sunIntensity" type="range" min="0" max="8" step="0.1" value="${draft.settings.sunIntensity}" />
          </label>
          <label class="field compact">
            <span>动态氛围 <output data-render-atmosphere-output>${atmosphereMasterStrength(draft).toFixed(2)}</output></span>
            <input data-render-atmosphere type="range" min="0" max="1" step="0.01" value="${atmosphereMasterStrength(draft)}" />
          </label>
          <p id="render-tuning-note" class="empty">${this.renderDraftChanged ? '微调正在预览，保存后会生成新的渲染方案，不会改动原预设。' : '只开放普通用户容易理解的白名单参数。'}</p>
          ${this.renderAiPreview ? '' : `<button id="save-render-scheme">${this.renderDraftChanged ? '保存为新方案' : '复制为新方案'}</button>`}
          </section>
        </details>
      ` : ''}
    `;
    host.querySelectorAll<HTMLButtonElement>('[data-dev-view]').forEach((button) => {
      button.addEventListener('click', () => {
        this.developerRenderView = button.dataset.devView === 'access' ? 'access' : 'tuning';
        this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-dev-category]').forEach((button) => {
      button.addEventListener('click', () => {
        this.developerRenderCategory = button.dataset.devCategory as RenderInspectorCategoryId;
        this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-dev-scheme-field]').forEach((input) => {
      input.addEventListener('input', () => {
        if (!this.renderDraft) return;
        const field = input.dataset.devSchemeField as 'name' | 'description';
        this.renderDraft[field] = input.value;
        this.markRenderDraftChanged();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-dev-add-module]').forEach((button) => {
      button.addEventListener('click', () => {
        const plan = this.ensureRenderDraftPlan();
        const capability = RENDER_CAPABILITIES.find((entry) => entry.id === button.dataset.devAddModule);
        if (!plan || !capability) return;
        plan.modules.push(defaultRenderModule(capability, plan.modules.length));
        this.markRenderDraftChanged(true);
        this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-dev-remove-module]').forEach((button) => {
      button.addEventListener('click', () => {
        const plan = this.ensureRenderDraftPlan();
        const index = Number(button.dataset.devRemoveModule);
        if (!plan || !Number.isInteger(index)) return;
        plan.modules.splice(index, 1);
        this.markRenderDraftChanged(true);
        this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-dev-module-index][data-dev-param]').forEach((input) => {
      input.addEventListener('input', () => {
        const requestedIndex = Number(input.dataset.devModuleIndex);
        const resolved = this.ensureDeveloperModule(requestedIndex, input.dataset.devModuleId);
        const parameter = input.dataset.devParam;
        const module = resolved?.module;
        const index = resolved?.index ?? requestedIndex;
        const capability = module && RENDER_CAPABILITIES.find((entry) => entry.id === module.id);
        const rule = capability && parameter ? capability.params[parameter] : null;
        if (!module || !parameter || !rule) return;
        if (rule.type === 'number') {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          module.params[parameter] = value;
          host.querySelectorAll<HTMLInputElement>(
            `[data-dev-module-index="${requestedIndex}"][data-dev-param="${parameter}"]`
          ).forEach((peer) => {
            if (peer !== input) peer.value = String(value);
          });
          const output = host.querySelector<HTMLOutputElement>(
            `[data-dev-value-output="${requestedIndex}:${parameter}"]`
          );
          if (output) {
            output.value = String(value);
            output.textContent = String(value);
          }
        } else {
          module.params[parameter] = input.value;
        }
        // Free-form GLSL must not re-apply on every keystroke, but the HDRI
        // picker is a select — the sky should change the moment it is chosen.
        this.markRenderDraftChanged(rule.type !== 'code' || rule.control === 'select');
        if (module.id === 'environment.hdri' && parameter === 'texture') this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLSelectElement>('[data-hdri-category]').forEach((input) => {
      input.addEventListener('change', () => void this.saveHdriClassification(host));
    });
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-dev-module-index][data-dev-scope]').forEach((input) => {
      input.addEventListener(input.dataset.devScope === 'tag' ? 'input' : 'change', () => {
        const resolved = this.ensureDeveloperModule(
          Number(input.dataset.devModuleIndex),
          input.dataset.devModuleId
        );
        const module = resolved?.module;
        if (!module) return;
        module.scope ??= { target: 'material-tag', tag: 'base' };
        if (input.dataset.devScope === 'target') {
          module.scope.target = input.value as 'water' | 'material-tag' | 'asset-tag';
        } else {
          module.scope.tag = input.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
        }
        this.markRenderDraftChanged(true);
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-policy-enabled]').forEach((input) => {
      input.addEventListener('change', () => {
        const entry = this.renderPolicyEntry(input.dataset.policyModule, input.dataset.policyParam);
        const side = input.dataset.policyEnabled as 'ai' | 'developer';
        if (!entry || (side !== 'ai' && side !== 'developer')) return;
        entry[side].enabled = input.checked;
        this.markRenderDraftChanged();
      });
    });
    host.querySelectorAll<HTMLSelectElement>('[data-policy-control]').forEach((input) => {
      input.addEventListener('change', () => {
        const entry = this.renderPolicyEntry(input.dataset.policyModule, input.dataset.policyParam);
        if (!entry) return;
        entry.control = input.value as RenderParameterAccess['control'];
        this.markRenderDraftChanged();
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-policy-range]').forEach((input) => {
      input.addEventListener('input', () => {
        const entry = this.renderPolicyEntry(input.dataset.policyModule, input.dataset.policyParam);
        const side = input.dataset.policySide as 'ai' | 'developer';
        const edge = input.dataset.policyRange as 'min' | 'max';
        const value = Number(input.value);
        if (!entry || !Number.isFinite(value) || (side !== 'ai' && side !== 'developer')) return;
        entry[side][edge] = value;
        this.markRenderDraftChanged();
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-policy-enum-value]').forEach((input) => {
      input.addEventListener('change', () => {
        const entry = this.renderPolicyEntry(input.dataset.policyModule, input.dataset.policyParam);
        const side = input.dataset.policySide as 'ai' | 'developer';
        const value = input.dataset.policyEnumValue;
        if (!entry || !value || (side !== 'ai' && side !== 'developer')) return;
        const values = new Set(entry[side].values ?? []);
        if (input.checked) values.add(value);
        else values.delete(value);
        entry[side].values = [...values];
        this.markRenderDraftChanged();
      });
    });
    host.querySelector<HTMLTextAreaElement>('#render-ai-prompt')?.addEventListener('input', (event) => {
      this.renderAiPrompt = (event.target as HTMLTextAreaElement).value;
      const blocked = this.state.busy || !this.renderAiPrompt.trim();
      const generateButton = host.querySelector<HTMLButtonElement>('#generate-render-ai');
      const refineButton = host.querySelector<HTMLButtonElement>('#refine-render-ai');
      if (generateButton) generateButton.disabled = blocked;
      if (refineButton) refineButton.disabled = blocked || !this.renderDraft;
    });
    host.querySelectorAll<HTMLButtonElement>('[data-render-prompt-suggestion]').forEach((button) => {
      button.addEventListener('click', () => {
        const suggestion = button.dataset.renderPromptSuggestion?.trim();
        if (!suggestion) return;
        const current = this.renderAiPrompt.trim();
        if (!current.includes(suggestion)) this.renderAiPrompt = current ? `${current}，${suggestion}` : suggestion;
        button.closest('details')?.removeAttribute('open');
        this.renderRenderInspector();
      });
    });
    host.querySelector('#generate-render-ai')?.addEventListener('click', () => void this.generateRenderAiPreview('generate'));
    host.querySelector('#refine-render-ai')?.addEventListener('click', () => void this.generateRenderAiPreview('refine'));
    host.querySelector('#cancel-render-ai')?.addEventListener('click', () => {
      this.renderAiAbortController?.abort();
      this.state.message = '正在取消渲染 Agent...';
      this.updateToolbarState();
    });
    host.querySelector('#discard-render-ai')?.addEventListener('click', () => {
      this.resetRenderDraft();
      this.state.message = '已放弃 AI 渲染预览';
      this.applyCurrentRenderScheme();
      this.renderPanels();
    });
    host.querySelector('#apply-render-ai')?.addEventListener('click', () => void this.saveRenderDraft());
    host.querySelectorAll<HTMLButtonElement>('[data-render-preview-view]').forEach((button) => {
      button.addEventListener('click', () => {
        this.renderAiPreviewVisible = button.dataset.renderPreviewView === 'after';
        this.applyCurrentRenderScheme();
        this.renderRenderInspector();
        this.updateToolbarState();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-render-scheme]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!this.state.map) return;
        this.state.map.renderSchemeId = button.dataset.renderScheme ?? null;
        this.resetRenderDraft();
        this.markDirty(true, false);
        this.applyCurrentRenderScheme();
        this.renderRenderInspector();
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-delete-render-scheme]').forEach((button) => {
      button.addEventListener('click', () => void this.deleteRenderScheme(button.dataset.deleteRenderScheme ?? ''));
    });
    host.querySelectorAll<HTMLInputElement>('[data-render-number]').forEach((input) => {
      input.addEventListener('input', () => {
        if (!this.renderDraft) return;
        const key = input.dataset.renderNumber as 'exposure' | 'fogDensity' | 'sunIntensity';
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        this.renderDraft.settings[key] = value;
        if (this.renderDraft.renderPlan) {
          const [moduleId, parameter] = key === 'exposure'
            ? ['presentation.exposure', 'value'] as const
            : key === 'fogDensity'
              ? ['atmosphere.fog', 'density'] as const
              : ['lighting.sun', 'intensity'] as const;
          let module = this.renderDraft.renderPlan.modules.find((item) => item.id === moduleId);
          if (!module) {
            module = { id: moduleId, params: {} };
            this.renderDraft.renderPlan.modules.push(module);
          }
          module.params[parameter] = value;
        }
        this.renderDraftChanged = true;
        const output = host.querySelector<HTMLOutputElement>(`[data-render-output="${key}"]`);
        if (output) output.value = key === 'fogDensity' ? value.toFixed(3) : key === 'sunIntensity' ? value.toFixed(1) : value.toFixed(2);
        const note = host.querySelector<HTMLElement>('#render-tuning-note');
        if (note) note.textContent = '微调正在预览，保存后会生成新的渲染方案，不会改动原预设。';
        const saveButton = host.querySelector<HTMLButtonElement>('#save-render-scheme');
        if (saveButton) saveButton.textContent = '保存为新方案';
        this.applyCurrentRenderScheme();
        this.updateToolbarState();
      });
    });
    host.querySelector<HTMLInputElement>('[data-render-atmosphere]')?.addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      const plan = this.ensureRenderDraftPlan();
      if (!plan || !Number.isFinite(value)) return;
      let module = plan.modules.find((item) => item.id === 'runtime.atmosphere-fx');
      if (!module) {
        module = { id: 'runtime.atmosphere-fx', params: {} };
        plan.modules.push(module);
      }
      module.params.masterStrength = value;
      this.renderDraftChanged = true;
      const output = host.querySelector<HTMLOutputElement>('[data-render-atmosphere-output]');
      if (output) output.value = value.toFixed(2);
      this.applyCurrentRenderScheme();
    });
    host.querySelector('#save-render-scheme')?.addEventListener('click', () => void this.saveRenderDraft());
  }

  private selectedRenderScheme(): RenderScheme | null {
    const id = this.state.map?.renderSchemeId;
    return this.state.renderSchemes.find((scheme) => scheme.id === id) ?? this.state.renderSchemes[0] ?? null;
  }

  private async exportTransfer(kind: EditorExportKind): Promise<void> {
    const map = this.state.map;
    if (!map || this.state.busy) return;
    if (this.state.dirty || this.mapAiPreviewMap || this.renderDraftChanged) {
      this.state.message = '请先保存或确认当前预览，再导出稳定版本';
      this.updateToolbarState();
      return;
    }
    if (kind !== 'render-scheme' && !map.confirmedAt) {
      this.state.message = '请先确认地图，再导出地图或完整场景包';
      this.updateToolbarState();
      return;
    }
    this.setBusy(true, '正在打包导出文件...');
    try {
      const file = await exportWorldForge(kind, map, this.selectedRenderScheme(), {
        hdriUrl: (name) => `${serverHttpBase(location, import.meta.env.DEV)}/api/editor/hdri/${encodeURIComponent(name)}`
      });
      this.state.message = `已导出：${file}`;
    } catch (error) {
      this.state.message = `导出失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
    }
  }

  private async importTransfer(file: File): Promise<void> {
    if (this.state.busy) return;
    if (this.state.dirty || this.mapAiPreviewMap || this.renderDraftChanged) {
      this.state.message = '请先保存或放弃当前预览，再导入文件';
      this.updateToolbarState();
      return;
    }
    this.setBusy(true, `正在导入 ${file.name}...`);
    try {
      const result = await importWorldForgeFile(
        file,
        `${serverHttpBase(location, import.meta.env.DEV)}/api/editor/import`
      );
      await this.reloadLists();
      if (result.map) await this.loadMap(result.map.id);
      this.state.message = result.kind === 'scene'
        ? '完整场景包已导入为新项目'
        : result.kind === 'map'
          ? '地图已导入为新项目'
          : '渲染方案已导入';
    } catch (error) {
      this.state.message = `导入失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private ensureRenderDraftPlan(): RenderPlan | null {
    if (!this.renderDraft) return null;
    this.renderDraft.renderPlan ??= {
      version: 2,
      baseSchemeId: this.renderDraft.id,
      modules: []
    };
    this.renderDraft.renderPlan.version = 2;
    return this.renderDraft.renderPlan;
  }

  private ensureDeveloperModule(
    requestedIndex: number,
    moduleId?: string
  ): { module: RenderModuleSelection; index: number } | null {
    const plan = this.ensureRenderDraftPlan();
    if (!plan) return null;
    if (requestedIndex >= 0) {
      const module = plan.modules[requestedIndex];
      return module ? { module, index: requestedIndex } : null;
    }
    const capability = RENDER_CAPABILITIES.find((entry) => entry.id === moduleId);
    if (!capability) return null;
    const existingIndex = plan.modules.findIndex((module) => module.id === capability.id);
    if (existingIndex >= 0) return { module: plan.modules[existingIndex], index: existingIndex };
    const module = defaultRenderModule(capability, plan.modules.length, this.renderDraft ?? undefined);
    plan.modules.push(module);
    return { module, index: plan.modules.length - 1 };
  }

  private renderPolicyEntry(moduleId?: string, parameter?: string): RenderParameterAccess | null {
    if (!this.renderDraft || !moduleId || !parameter) return null;
    this.renderDraft.accessPolicy = normalizeRenderAccessPolicy(
      this.renderDraft.accessPolicy ?? createDefaultRenderAccessPolicy()
    );
    return this.renderDraft.accessPolicy.parameters.find((entry) => (
      entry.moduleId === moduleId && entry.parameter === parameter
    )) ?? null;
  }

  private markRenderDraftChanged(applyPreview = false): void {
    this.renderDraftChanged = true;
    if (applyPreview) this.applyCurrentRenderScheme();
    const note = this.app.querySelector<HTMLElement>('#render-tuning-note');
    if (note) note.textContent = '当前修改正在预览；保存后会生成新方案，不会改动原预设。';
    const saveButton = this.app.querySelector<HTMLButtonElement>('#save-render-scheme');
    if (saveButton) saveButton.textContent = '保存为新方案';
    this.updateToolbarState();
  }

  private resetRenderDraft(): void {
    const selected = this.selectedRenderScheme();
    this.renderDraft = selected ? structuredClone(selected) : null;
    this.renderDraftChanged = false;
    this.renderAiPreview = false;
    this.renderAiPreviewVisible = true;
    this.renderAiComparisonScheme = null;
    this.renderAiExplanation = '';
  }

  private async generateRenderAiPreview(mode: 'generate' | 'refine'): Promise<void> {
    const prompt = this.renderAiPrompt.trim();
    if (!prompt || !this.state.map?.confirmedAt || this.state.busy) return;
    const currentPlan = mode === 'refine' ? structuredClone(this.ensureRenderDraftPlan()) : null;
    if (mode === 'refine' && !currentPlan) return;
    const comparisonScheme = mode === 'refine' && this.renderDraft
      ? structuredClone(this.renderDraft)
      : this.selectedRenderScheme() ? structuredClone(this.selectedRenderScheme()!) : null;
    const controller = new AbortController();
    this.renderAiAbortController = controller;
    this.renderAgentProgress = [];
    this.startRenderAgentProgressTimer();
    this.setBusy(true, mode === 'refine' ? 'AI 正在调整当前渲染方案...' : 'AI 正在生成渲染预览...');
    this.renderRenderInspector();
    try {
      const { suggestion } = await editorAgentFetch<{ suggestion: RenderSuggestion }>(
        `/api/editor/render-schemes/${mode}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            provider: this.renderAiProvider,
            useHdriSky: true,
            ...(currentPlan ? { currentPlan } : {})
          }),
          signal: controller.signal
        },
        (event) => {
          updateAgentProgress(this.renderAgentProgress, event);
          this.renderRenderInspector();
        }
      );
      const base = this.state.renderSchemes.find((scheme) => scheme.id === suggestion.baseSchemeId);
      if (!base) throw new Error('AI 返回了不存在的渲染方案');
      this.renderDraft = {
        ...structuredClone(base),
        description: suggestion.explanation || base.description,
        settings: { ...base.settings, ...suggestion.settings },
        renderPlan: suggestion.plan,
        sourcePrompt: prompt,
        styleTags: suggestion.styleTags,
        provider: this.renderAiProvider
      };
      this.renderDraftChanged = true;
      this.renderAiPreview = true;
      this.renderAiPreviewVisible = true;
      this.renderAiComparisonScheme = comparisonScheme;
      this.renderAiExplanation = suggestion.explanation;
      this.state.message = 'AI 渲染预览已生成，尚未应用';
      this.applyCurrentRenderScheme();
      await this.harmonizeDraftFromHdri();
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const detail = humanizeRenderAgentError(error);
      updateAgentProgress(this.renderAgentProgress, {
        phase: 'failed',
        label: cancelled ? '渲染 Agent 已取消' : '渲染 Agent 执行失败',
        detail
      });
      this.state.message = cancelled ? '已取消渲染 Agent' : `AI 渲染生成失败：${detail}`;
    } finally {
      if (this.renderAiAbortController === controller) this.renderAiAbortController = null;
      this.stopRenderAgentProgressTimer();
      this.setBusy(false);
      this.renderPanels();
    }
  }

  /**
   * Distance fog and hemisphere light follow the panorama's lower half. The
   * HDRI catalog may carry those swatches, but the loaded texture always does,
   * so sample what the sky dome just decoded and re-harmonize the draft with it.
   */
  private async harmonizeDraftFromHdri(): Promise<void> {
    const draft = this.renderDraft;
    const plan = draft?.renderPlan;
    if (!draft || !plan) return;
    const file = compileRuntimeHdriSky(plan).texture;
    if (!file) return;
    const swatch = await this.renderScene?.hdriSky.swatch(file);
    if (!swatch || this.renderDraft !== draft) return;
    draft.renderPlan = harmonizeHdriAtmosphere(plan, [{ file, ...swatch }]);
    draft.settings = { ...draft.settings, ...compileRenderPlan(draft.renderPlan) };
    this.applyCurrentRenderScheme();
    this.renderRenderInspector();
  }

  private async saveRenderDraft(): Promise<void> {
    if (!this.renderDraft || !this.state.map) return;
    const defaultName = this.renderDraft.sourcePrompt
      ? this.renderDraft.sourcePrompt.slice(0, 24)
      : `${this.renderDraft.name} 副本`;
    const name = this.developerMode
      ? this.renderDraft.name
      : prompt('新渲染方案名称', defaultName);
    if (name === null) return;
    this.setBusy(true, '正在保存渲染方案...');
    try {
      const { renderScheme } = await editorFetch<{ renderScheme: RenderScheme }>('/api/editor/render-schemes', {
        method: 'POST',
        body: JSON.stringify({
          ...this.renderDraft,
          name: name.trim() || `${this.renderDraft.name} 副本`,
          kind: 'custom'
        })
      });
      this.state.renderSchemes.push(renderScheme);
      this.state.map.renderSchemeId = renderScheme.id;
      this.renderDraft = structuredClone(renderScheme);
      this.renderDraftChanged = false;
      this.renderAiPreview = false;
      this.renderAiPreviewVisible = true;
      this.renderAiComparisonScheme = null;
      this.renderAiExplanation = '';
      this.markDirty(true, false);
      this.state.message = '新渲染方案已保存，记得保存地图引用';
      this.applyCurrentRenderScheme();
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async deleteRenderScheme(id: string): Promise<void> {
    const scheme = this.state.renderSchemes.find((entry) => entry.id === id);
    if (!scheme || scheme.kind !== 'custom' || this.state.busy) return;
    if (this.state.dirty || this.renderDraftChanged || this.mapAiPreviewMap) {
      this.state.message = '请先保存或放弃当前预览，再删除渲染方案';
      this.updateToolbarState();
      return;
    }
    if (!confirm(`确定删除渲染方案“${scheme.name}”吗？\n\n引用它的地图会自动切换到默认方案。`)) return;
    this.setBusy(true, '正在删除渲染方案...');
    try {
      await editorFetch(`/api/editor/render-schemes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const { renderSchemes } = await editorFetch<{ renderSchemes: RenderScheme[] }>('/api/editor/render-schemes');
      this.state.renderSchemes = renderSchemes;
      if (this.state.map?.renderSchemeId === id) {
        const { map } = await editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(this.state.map.id)}`);
        this.state.map = normalizeMap(map);
        this.resetManualHistory(this.state.map, true);
      }
      this.resetRenderDraft();
      this.applyCurrentRenderScheme();
      this.state.message = '渲染方案已删除';
      this.renderPanels();
    } catch (error) {
      this.state.message = `删除渲染方案失败：${error instanceof Error ? error.message : '未知错误'}`;
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async generateAsset(): Promise<void> {
    const promptInput = this.app.querySelector<HTMLTextAreaElement>('#asset-prompt');
    const prompt = promptInput?.value.trim() ?? '';
    if (!prompt) {
      this.state.message = '请输入资产提示词';
      this.renderPanels();
      return;
    }
    this.setBusy(true, '生成资产中...');
    try {
      const { asset } = await editorFetch<{ asset: MapAsset }>('/api/editor/assets/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt, mode: this.state.map?.assetGenerationMode ?? 'voxel' })
      });
      this.state.assets.unshift(asset);
      this.state.selectedAssetId = asset.id;
      this.state.message = '资产已生成';
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async renderAssetPreview(): Promise<void> {
    if (!this.previewScene || !this.previewCamera || !this.previewRenderer || !this.previewModelRoot) return;
    const asset = this.previewingLibraryAsset
      ? this.state.libraryAssets.find((item) => item.id === this.selectedLibraryAssetId)
      : this.state.assets.find((item) => item.id === this.state.selectedAssetId);
    const assetId = asset?.id ?? null;
    if (this.previewAssetId === assetId && (assetId === null || this.previewModel)) return;
    this.previewAssetId = assetId;
    const requestId = this.previewRequestId + 1;
    this.previewRequestId = requestId;
    this.clearAssetPreviewModel();
    if (!asset?.modelJson) return;
    const model = await buildModelGroup(asset.modelJson);
    const selectedPreviewAssetId = this.previewingLibraryAsset ? this.selectedLibraryAssetId : this.state.selectedAssetId;
    if (requestId !== this.previewRequestId || selectedPreviewAssetId !== assetId || !this.previewModelRoot) {
      disposeObject(model);
      return;
    }
    this.previewModel = model;
    this.previewModelRoot.add(model);
    this.previewModelRoot.add(buildColliderPreview(asset.colliderPlan.boxes));
    if (!this.previewOrbit) {
      this.previewOrbit = new OrbitControls(this.previewCamera, this.previewRenderer.domElement);
      this.previewOrbit.enableDamping = true;
      this.previewOrbit.target.set(0, 0.8, 0);
    }
  }

  private clearAssetPreviewModel(): void {
    if (this.previewModel) {
      this.previewModel.parent?.remove(this.previewModel);
      disposeObject(this.previewModel);
      this.previewModel = null;
    }
    if (!this.previewModelRoot) return;
    for (const child of [...this.previewModelRoot.children]) {
      this.previewModelRoot.remove(child);
      disposeObject(child);
    }
  }

  private async confirmMap(): Promise<void> {
    if (!this.state.map || this.state.busy || this.mapAiPreviewMap) return;
    if (this.state.map.confirmedAt && !this.state.dirty) {
      this.state.message = '已进入渲染阶段';
      this.setStage('render');
      return;
    }
    const previousConfirmedAt = this.state.map.confirmedAt;
    const previousRenderSchemeId = this.state.map.renderSchemeId;
    this.state.map.confirmedAt = Date.now();
    this.state.map.renderSchemeId ??= this.state.renderSchemes[0]?.id ?? null;
    this.state.dirty = true;
    this.updateToolbarState();
    this.setBusy(true, '正在确认地图...');
    try {
      if (!await this.saveMap()) {
        this.state.map.confirmedAt = previousConfirmedAt;
        this.state.map.renderSchemeId = previousRenderSchemeId;
        this.state.dirty = mapSnapshot(this.state.map) !== this.savedMapSnapshot;
        this.applyCurrentRenderScheme();
        this.renderPanels();
        return;
      }
      this.state.message = '地图已保存，已进入渲染阶段';
      this.setStage('render');
    } finally {
      this.setBusy(false);
    }
  }

  private setStage(stage: EditorStage): void {
    if (this.mapAiPreviewMap) {
      this.state.message = '请先应用或放弃 AI 地图预览';
      this.updateToolbarState();
      return;
    }
    if (stage === 'render' && !this.state.map?.confirmedAt) {
      this.state.message = '请先确认地图，再进入渲染阶段';
      this.updateToolbarState();
      return;
    }
    if (this.state.stage === 'render' && stage !== 'render' && this.renderDraftChanged) {
      if (!confirm('当前渲染微调尚未保存。\n\n确定：放弃预览并返回地图\n取消：继续调整渲染')) return;
      this.resetRenderDraft();
    }
    this.cancelAssetPlacement();
    this.state.stage = stage;
    this.state.tool = 'select';
    this.painting = false;
    if (this.brushPreview) this.brushPreview.visible = false;
    if (this.renderer) this.renderer.domElement.style.cursor = 'default';
    if (stage === 'render') this.resetRenderDraft();
    this.applyCurrentRenderScheme();
    this.renderPanels();
  }

  private async beginAssetPlacement(): Promise<void> {
    const asset = this.state.assets.find((item) => item.id === this.state.selectedAssetId);
    if (!asset?.modelJson || !this.scene) return;
    this.cancelAssetPlacement();
    this.placingAssetId = asset.id;
    this.state.tool = 'select';
    const requestId = ++this.placementRequestId;
    this.state.message = '移动鼠标预览位置，左键放置，Esc 取消';
    this.renderPanels();
    const preview = await buildModelGroup(asset.modelJson);
    if (requestId !== this.placementRequestId || this.placingAssetId !== asset.id || !this.scene) {
      disposeObject(preview);
      return;
    }
    makePlacementPreview(preview);
    preview.visible = false;
    this.placementPreview = preview;
    this.scene.add(preview);
  }

  private cancelAssetPlacement(): void {
    this.placementRequestId += 1;
    this.placingAssetId = null;
    if (!this.placementPreview) return;
    this.placementPreview.parent?.remove(this.placementPreview);
    disposeObject(this.placementPreview);
    this.placementPreview = null;
  }

  private updatePlacementPreview(hit: THREE.Intersection | null): void {
    if (!this.placementPreview || !this.state.map) return;
    this.placementPreview.visible = Boolean(hit);
    if (!hit) return;
    const y = sampleTerrainHeight(this.state.map, hit.point.x, hit.point.z);
    this.placementPreview.position.set(hit.point.x, y, hit.point.z);
  }

  private placeAssetAt(point: THREE.Vector3): void {
    if (!this.state.map || !this.placingAssetId) return;
    const asset = this.state.assets.find((item) => item.id === this.placingAssetId);
    if (!asset) return;
    const object = createMapObject(asset.name, asset.id);
    object.transform.position = [
      point.x,
      sampleTerrainHeight(this.state.map, point.x, point.z),
      point.z
    ];
    this.state.map.objects.push(object);
    this.state.selectedObjectId = object.id;
    this.markDirty();
    this.cancelAssetPlacement();
    this.state.message = `${asset.name} 已放入地图`;
    void this.refreshScene();
    this.renderPanels();
  }

  /**
   * A grass stroke only edits the density field, so it rebuilds the grass field
   * instead of the whole scene. Pointer moves fire far faster than a rebuild
   * finishes, so collapse every sample in a frame into one rebuild.
   */
  private scheduleGrassRefresh(): void {
    if (this.grassRefreshHandle) return;
    this.grassRefreshHandle = requestAnimationFrame(() => {
      this.grassRefreshHandle = 0;
      if (this.state.map) this.renderedMap?.refreshGrass(this.state.map);
    });
  }

  /**
   * A paint or terrain stroke only changes the terrain mesh, so it rebuilds
   * that instead of the whole scene, one rebuild per frame at most.
   */
  private scheduleTerrainRefresh(): void {
    if (this.terrainRefreshHandle) return;
    this.terrainRefreshHandle = requestAnimationFrame(() => {
      this.terrainRefreshHandle = 0;
      if (this.state.map) this.renderedMap?.refreshTerrain(this.state.map);
    });
  }

  /**
   * A rebuild detaches and re-adds the scene root, so two runs in flight can
   * interleave and leave a stale group attached. Serialize them, and collapse
   * everything requested mid-flight into a single trailing rebuild.
   */
  private refreshScene(): Promise<void> {
    if (this.sceneRefresh) {
      this.sceneRefreshQueued ??= this.sceneRefresh.then(() => this.refreshScene());
      return this.sceneRefreshQueued;
    }
    this.sceneRefresh = this.rebuildScene().finally(() => {
      this.sceneRefresh = null;
      this.sceneRefreshQueued = null;
    });
    return this.sceneRefresh;
  }

  private async rebuildScene(): Promise<void> {
    if (!this.scene) return;
    // A full rebuild already replaces both; drop any pending partial refresh.
    if (this.grassRefreshHandle) {
      cancelAnimationFrame(this.grassRefreshHandle);
      this.grassRefreshHandle = 0;
    }
    if (this.terrainRefreshHandle) {
      cancelAnimationFrame(this.terrainRefreshHandle);
      this.terrainRefreshHandle = 0;
    }
    this.clearSelectionOutline();
    const previous = this.renderedMap;
    if (!this.state.map) {
      if (previous) {
        this.renderScene?.attach(null);
        this.scene.remove(previous.group);
        previous.dispose();
        this.renderedMap = null;
      }
      this.transform?.detach();
      return;
    }
    this.updateSceneLighting();
    const next = await buildEditableMapGroup(this.mapWithEditorAssets(), {
      editorHelpers: true,
      scene: this.scene
    });
    if (previous) {
      this.renderScene?.attach(null);
      this.scene.remove(previous.group);
      previous.dispose();
    }
    this.renderedMap = next;
    this.scene.add(next.group);
    this.renderScene?.attach(next);
    this.applyRoomWallDisplayMode();
    this.attachSelectedTransform();
    this.applyCurrentRenderScheme();
  }

  private handlePointer(event: PointerEvent, first: boolean): void {
    if (this.playMode?.isActive) return;
    if (!this.renderer || !this.camera || !this.renderedMap || !this.state.map) return;
    if (this.mapAiPreviewMap) return;
    if (event.altKey) return;
    if (first && event.button !== 0) return;
    const hoverOnly = !first && event.buttons === 0;
    if (hoverOnly) {
      const hits = this.raycast(event);
      if (this.placingAssetId) {
        const hit = groundSurfaceHit(hits);
        this.updatePlacementPreview(hit);
        this.renderer.domElement.style.cursor = hit ? 'copy' : 'not-allowed';
        return;
      }
      if (this.state.tool !== 'select') {
        this.updateBrushPreview(surfaceHit(hits));
        return;
      }
      const objectHit = selectableObjectHit(hits);
      this.renderer.domElement.style.cursor = objectHit ? 'pointer' : 'default';
      return;
    }
    if (!first && (!this.painting || (event.buttons & 1) === 0)) return;
    if (this.isTransformControlPointerActive()) {
      this.painting = false;
      event.preventDefault();
      return;
    }
    if (first && this.placingAssetId) {
      const hit = groundSurfaceHit(this.raycast(event));
      if (hit) this.placeAssetAt(hit.point);
      event.preventDefault();
      return;
    }
    if (first) {
      this.painting = this.state.tool !== 'select';
      const terrainPreviewGesture = this.state.tool === 'terrain' && this.state.terrainAction !== 'brush';
      if (terrainPreviewGesture && this.state.dirty) {
        this.painting = false;
        this.state.message = '请先保存当前手工修改，再绘制地貌预览';
        this.updateToolbarState();
        return;
      }
      if (this.painting && !terrainPreviewGesture) this.beginHistoryGesture();
      if (terrainPreviewGesture) this.terrainGesturePoints = [];
      event.preventDefault();
    }
    const hits = this.raycast(event);
    if (this.state.tool === 'select') {
      if (!first) return;
      const hit = selectableObjectHit(hits);
      this.selectObject(hit ? findMapObjectIdFromHit(hit) : null);
      return;
    }
    const hit = surfaceHit(hits);
    if (!hit) return;
    this.updateBrushPreview(hit);
    if (this.state.tool === 'terrain' && this.state.terrainAction !== 'brush') {
      const point: [number, number] = [hit.point.x, hit.point.z];
      const previous = this.terrainGesturePoints[this.terrainGesturePoints.length - 1];
      if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) >= Math.max(0.15, this.state.terrainSize * 0.2)) {
        this.terrainGesturePoints.push(point);
      }
      return;
    }
    if (this.state.tool === 'paint') {
      const surface = findMapSurface(hit.object) ?? 'terrain';
      this.state.map = addPaintStroke(this.state.map, createPaintStroke({
        surface,
        point: [hit.point.x, hit.point.y, hit.point.z],
        uv: hit.uv ? [hit.uv.x, hit.uv.y] : surfaceUvFromPoint(this.state.map, surface, [hit.point.x, hit.point.y, hit.point.z]),
        color: this.state.brushColor,
        size: this.state.brushSize,
        softness: this.state.brushSoftness
      }));
      this.markDirty(false);
      this.scheduleTerrainRefresh();
      return;
    }
    if (this.state.tool === 'grass') {
      ensureGrassLayerSelection(this.state.map, this.grassEditorState);
      const layerId = this.grassEditorState.selectedLayerId;
      if (!layerId) {
        this.state.message = '请先新增一个草地层';
        this.renderPanels();
        return;
      }
      applyGrassBrushInPlace(
        this.state.map,
        layerId,
        this.grassEditorState.brushMode,
        [hit.point.x, hit.point.z],
        this.grassEditorState.brushSize,
        this.grassEditorState.brushStrength,
        this.grassEditorState.targetDensity
      );
      this.markDirty(false);
      this.scheduleGrassRefresh();
      return;
    }
    if (first && this.state.terrainMode === 'flatten') this.terrainFlattenHeight = hit.point.y;
    const targetHeight = this.state.terrainMode === 'flatten'
      ? this.terrainFlattenHeight ?? hit.point.y
      : hit.point.y;
    this.state.map = applyTerrainBrush(
      this.state.map,
      this.state.terrainMode,
      [hit.point.x, hit.point.y, hit.point.z],
      this.state.terrainSize,
      this.state.terrainStrength,
      targetHeight
    );
    this.markDirty(false);
    this.scheduleTerrainRefresh();
  }

  private raycast(event: PointerEvent): THREE.Intersection[] {
    if (!this.renderer || !this.camera || !this.renderedMap) return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.renderedMap.pickables, true);
  }

  private updateBrushPreview(hit: THREE.Intersection | null): void {
    if (!this.brushPreview) return;
    this.brushPreview.visible = Boolean(hit) && this.state.tool !== 'select';
    if (!hit || this.state.tool === 'select') return;
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    const radius = this.state.tool === 'terrain'
      ? this.state.terrainSize
      : this.state.tool === 'grass'
        ? this.grassEditorState.brushSize
        : this.state.brushSize;
    this.brushPreview.position.copy(hit.point).addScaledVector(normal, 0.025);
    this.brushPreview.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.brushPreview.scale.setScalar(radius);
    this.brushPreview.material.color.set(this.state.tool === 'paint' ? this.state.brushColor : 0xd9f47a);
  }

  private clearSelectionOutline(): void {
    if (!this.selectionOutline) return;
    this.selectionOutline.parent?.remove(this.selectionOutline);
    this.selectionOutline.geometry.dispose();
    (this.selectionOutline.material as THREE.Material).dispose();
    this.selectionOutline = null;
  }

  private updateSelectionOutline(): void {
    this.clearSelectionOutline();
    const group = this.renderedMap?.objectGroups.get(this.state.selectedObjectId ?? '');
    if (!group || !this.scene) return;
    const outline = new THREE.BoxHelper(group, 0xd9f47a);
    const material = outline.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.9;
    outline.renderOrder = 30;
    this.selectionOutline = outline;
    this.scene.add(outline);
  }

  private selectObject(objectId: string | null): void {
    if (this.state.selectedObjectId === objectId) return;
    this.state.selectedObjectId = objectId;
    if (this.isTranslateOnlySelection()) this.state.transformMode = 'translate';
    this.renderHierarchy();
    this.renderObjectInspector();
    this.attachSelectedTransform();
    const bindAsset = this.app.querySelector<HTMLButtonElement>('#bind-selected-asset');
    if (bindAsset) bindAsset.disabled = !(this.selectedObject() && this.state.selectedAssetId);
    this.updateToolbarState();
  }

  private syncSelectedTransform(): void {
    if (this.isPlayerSpawnSelected()) {
      const controlObject = this.transform?.object as THREE.Object3D | undefined;
      if (!controlObject) return;
      this.setPlayerSpawnPoint([controlObject.position.x, controlObject.position.y, controlObject.position.z]);
      this.markDirty(false);
      this.renderObjectInspector();
      return;
    }
    if (this.isSunSelected()) {
      const controlObject = this.transform?.object as THREE.Object3D | undefined;
      if (!controlObject) return;
      this.setSunPosition([controlObject.position.x, controlObject.position.y, controlObject.position.z]);
      this.markDirty(false);
      this.renderObjectInspector();
      return;
    }
    const object = this.selectedObject();
    const controlObject = this.transform?.object as THREE.Object3D | undefined;
    if (!object || !controlObject) return;
    object.transform.position = [controlObject.position.x, controlObject.position.y, controlObject.position.z];
    object.transform.rotation = [controlObject.rotation.x, controlObject.rotation.y, controlObject.rotation.z];
    const nextScale: [number, number, number] = [
      Math.max(0.01, controlObject.scale.x / object.transform.size[0]),
      Math.max(0.01, controlObject.scale.y / object.transform.size[1]),
      Math.max(0.01, controlObject.scale.z / object.transform.size[2])
    ];
    if (this.state.uniformScale && this.state.transformMode === 'scale') {
      const uniform = uniformScaleFromAxes(nextScale, object.transform.scale, this.transform?.axis ?? null);
      object.transform.scale = [uniform, uniform, uniform];
      controlObject.scale.set(
        uniform * object.transform.size[0],
        uniform * object.transform.size[1],
        uniform * object.transform.size[2]
      );
    } else {
      object.transform.scale = nextScale;
    }
    syncRoomOpeningFromObjectInPlace(this.state.map!, object);
    this.renderedMap?.syncObjectTransform(object.id);
    this.markDirty(false);
    this.renderObjectInspector();
  }

  private bindScaleInputs(host: HTMLElement, object: MapObject): void {
    host.querySelector<HTMLInputElement>('[data-uniform-scale]')?.addEventListener('change', (event) => {
      this.state.uniformScale = (event.target as HTMLInputElement).checked;
      if (this.state.uniformScale) {
        const uniform = averageScale(object.transform.scale);
        object.transform.scale = [uniform, uniform, uniform];
        this.markDirty();
        void this.refreshScene();
      }
      this.renderObjectInspector();
      this.updateToolbarState();
    });
    host.querySelectorAll<HTMLInputElement>('[data-vector="scale"]').forEach((input) => {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.index);
        const value = Math.max(0.01, Number(input.value));
        if (!Number.isFinite(value)) return;
        if (this.state.uniformScale) object.transform.scale = [value, value, value];
        else object.transform.scale[index] = value;
        this.markDirty();
        void this.refreshScene();
        this.renderObjectInspector();
      });
    });
  }

  private attachSelectedTransform(): void {
    this.updateSelectionOutline();
    if (this.mapAiPreviewMap || this.state.stage !== 'map' || this.state.tool !== 'select') {
      this.transform?.detach();
      return;
    }
    if (this.isTranslateOnlySelection()) {
      const group = this.renderedMap?.objectGroups.get(this.state.selectedObjectId ?? '');
      if (!group || !this.transform) {
        this.transform?.detach();
        return;
      }
      this.state.transformMode = 'translate';
      this.transform.attach(group);
      this.transform.setMode('translate');
      return;
    }
    const object = this.selectedObject();
    const group = object ? this.renderedMap?.objectGroups.get(object.id) : null;
    if (!group || !this.transform) {
      this.transform?.detach();
      return;
    }
    this.transform.attach(group);
    this.transform.setMode(this.state.transformMode);
  }

  private selectedObject(): MapObject | null {
    return this.state.map?.objects.find((object) => object.id === this.state.selectedObjectId) ?? null;
  }

  private displayedMap(): EditableMap | null {
    if (!this.mapAiPreviewMap) return this.state.map;
    return this.mapAiPreviewVisible ? this.mapAiPreviewMap : this.mapAiComparisonMap ?? this.state.map;
  }

  private mapWithEditorAssets(source = this.displayedMap()): EditableMap {
    if (!source) throw new Error('missing_map');
    const assets = new Map<string, MapAsset>();
    for (const asset of source.assets ?? []) assets.set(asset.id, asset);
    for (const asset of this.state.assets) assets.set(asset.id, asset);
    return {
      ...source,
      assets: [...assets.values()]
    };
  }

  private isPlayerSpawnSelected(): boolean {
    return this.state.selectedObjectId === PLAYER_SPAWN_OBJECT_ID;
  }

  private selectedRoomSurface(): RoomSurface | null {
    const id = this.state.selectedObjectId;
    if (!id?.startsWith(`${ROOM_OBJECT_ID}:`)) return null;
    const surface = id.slice(ROOM_OBJECT_ID.length + 1) as RoomSurface;
    return ROOM_SURFACES.includes(surface) ? surface : null;
  }

  private isRoomSurfaceSelected(surface: RoomSurface): boolean {
    return this.selectedRoomSurface() === surface;
  }

  private isSunSelected(): boolean {
    return this.state.selectedObjectId === SUN_OBJECT_ID;
  }

  private isTranslateOnlySelection(): boolean {
    return this.isPlayerSpawnSelected() || this.isSunSelected();
  }

  private isTransformControlPointerActive(): boolean {
    return Boolean(this.transform && (this.transformPointerActive || this.transformDragging || this.transform.axis !== null));
  }

  private playerSpawnPoint(): [number, number, number] {
    return this.state.map ? [...getSpawnPoints(this.state.map)[0]] : [0, 0, 0];
  }

  private setPlayerSpawnPoint(position: [number, number, number]): void {
    if (!this.state.map) return;
    const bounds = getMapBounds(this.state.map);
    const { radius, height } = getMapPlayerMetrics(this.state.map);
    const x = clampNumber(position[0], bounds.minX + radius, bounds.maxX - radius);
    const z = clampNumber(position[2], bounds.minZ + radius, bounds.maxZ - radius);
    const terrainY = sampleTerrainHeight(this.state.map, x, z);
    const maxY = Math.max(terrainY, bounds.maxY - height);
    const y = clampNumber(position[1], terrainY, maxY);
    this.state.map.spawnPoints = [[x, y, z]];
  }

  private setSunPosition(position: [number, number, number]): void {
    if (!this.state.map) return;
    const bounds = getMapBounds(this.state.map);
    const reach = Math.max(this.state.map.box.size[0], this.state.map.box.size[1], this.state.map.box.size[2]) * 3;
    this.state.map.lighting.sunPosition = [
      clampNumber(position[0], bounds.minX - reach, bounds.maxX + reach),
      clampNumber(position[1], bounds.minY + 0.5, bounds.maxY + reach),
      clampNumber(position[2], bounds.minZ - reach, bounds.maxZ + reach)
    ];
    this.updateSceneLighting();
  }

  private updateSceneLighting(): void {
    if (!this.renderScene) return;
    // Every map swap goes through `rebuildScene`, which calls this — so this is
    // also where the runtime learns which map its shadow fit should follow.
    this.renderScene.map = this.state.map;
    this.renderScene.updateLighting();
  }

  private async reloadHdriTextures(): Promise<void> {
    const result = await editorFetch<{ hdriTextures?: HdriTexture[] }>('/api/editor/hdri')
      .catch(() => null);
    this.hdriTextures = result?.hdriTextures ?? [];
    this.hdriFiles = this.hdriTextures.map((texture) => texture.file);
  }

  private async saveHdriClassification(host: HTMLElement): Promise<void> {
    const panel = host.querySelector<HTMLElement>('[data-hdri-file]');
    const file = panel?.dataset.hdriFile;
    if (!file) return;
    const timeOfDay = panel.querySelector<HTMLSelectElement>('[data-hdri-category="timeOfDay"]')?.value ?? '';
    const temperature = panel.querySelector<HTMLSelectElement>('[data-hdri-category="temperature"]')?.value ?? '';
    try {
      await editorFetch(`/api/editor/hdri/${encodeURIComponent(file)}`, {
        method: 'PUT',
        body: JSON.stringify({ timeOfDay, temperature })
      });
      await this.reloadHdriTextures();
      this.state.message = `已更新天空分类：${file}`;
    } catch (error) {
      this.state.message = `天空分类保存失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
    this.updateToolbarState();
  }

  private applyCurrentRenderScheme(): void {
    const scheme = !this.mapAiPreviewMap && this.state.map?.confirmedAt
      ? this.renderAiPreview && !this.renderAiPreviewVisible
        ? this.renderAiComparisonScheme ?? this.selectedRenderScheme()
        : this.renderDraft ?? this.selectedRenderScheme()
      : null;
    this.renderScene?.applyScheme(scheme);
  }

  private renderDebugDetails(): RenderDebugDetails {
    const mapStats = this.renderedMap?.getDebugStats();
    const pipeline = this.renderScene?.adapter.getPerformanceStats();
    const atmosphere = this.renderScene?.getAtmosphereFxStats();
    return {
      objects: this.state.map?.objects.length ?? 0,
      waters: this.state.map?.waterBodies.length ?? 0,
      batchableParts: mapStats?.batchableParts ?? 0,
      instancedParts: mapStats?.instancedParts ?? 0,
      batchedMeshParts: mapStats?.batchedMeshParts ?? 0,
      fallbackParts: mapStats?.fallbackMeshParts ?? 0,
      batchCount: mapStats?.batchCount ?? 0,
      effectBatchCount: mapStats?.effectBatchCount ?? 0,
      effectBatchParts: mapStats?.effectBatchParts ?? 0,
      runtimeIndexPartRefs: mapStats?.runtimeIndexPartRefs ?? 0,
      orphanPartRefs: mapStats?.orphanPartRefs ?? 0,
      orphanInstanceRefs: mapStats?.orphanInstanceRefs ?? 0,
      culled: mapStats?.culled ?? 0,
      tested: mapStats?.tested ?? 0,
      grassBlades: mapStats?.grassBlades ?? 0,
      grassFlowers: mapStats?.grassFlowers ?? 0,
      grassDrawCalls: mapStats?.grassDrawCalls ?? 0,
      atmosphereParticles: atmosphere?.particles ?? 0,
      atmosphereDrawCalls: atmosphere?.drawCalls ?? 0,
      adaptiveQuality: this.renderScene?.getAdaptiveQuality() ?? 1,
      stages: pipeline?.stages ?? [],
      passes: pipeline?.passes ?? [],
      composerPasses: pipeline?.composerTrace?.passes ?? []
    };
  }

  private animate(): void {
    this.animationFrame = requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const frameMs = Math.max(0, now - this.lastFrameAt);
    const dt = Math.min(0.05, frameMs / 1000);
    this.lastFrameAt = now;
    this.resize();
    this.playMode?.update(dt);
    if (!this.playMode?.isActive) {
      this.updateKeyboardCamera(dt);
      this.orbit?.update();
    }
    this.applyRoomWallDisplayMode();
    this.selectionOutline?.update();
    this.renderStats?.beginFrame();
    const quality = this.adaptiveQuality.update(frameMs, dt);
    if (quality) this.renderScene?.setAdaptiveQuality(quality.scale);
    this.renderScene?.renderFrame(dt, now / 1000);
    this.renderStats?.endFrame(frameMs, now);
    this.previewOrbit?.update();
    this.resizePreview();
    if (this.previewRenderer && this.previewScene && this.previewCamera) this.previewRenderer.render(this.previewScene, this.previewCamera);
  }

  private resize(): void {
    const host = this.app.querySelector<HTMLElement>('#editor-viewport');
    if (!host || !this.renderer || !this.camera) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderScene?.setSize(width, height);
  }

  private resizePreview(): void {
    const host = this.app.querySelector<HTMLElement>('#asset-preview');
    if (!host || !this.previewRenderer || !this.previewCamera) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(1, Math.floor(Math.min(rect.width, rect.height || 180)));
    this.previewCamera.aspect = 1;
    this.previewCamera.updateProjectionMatrix();
    this.previewRenderer.setSize(size, size, false);
  }

  private updateToolbarState(): void {
    const mapStage = this.state.stage === 'map';
    this.app.dataset.stage = this.state.stage;
    this.app.querySelectorAll<HTMLElement>('[data-map-only]').forEach((element) => {
      element.hidden = !mapStage;
    });
    this.app.querySelectorAll<HTMLElement>('[data-render-only]').forEach((element) => {
      element.hidden = mapStage;
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((button) => {
      const stage = button.dataset.stage as EditorStage;
      button.classList.toggle('active', stage === this.state.stage);
      button.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || (stage === 'render' && !this.state.map);
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === this.state.tool);
      const indoorTerrainTool = this.state.map?.sceneMode === 'indoor'
        && (button.dataset.tool === 'terrain' || button.dataset.tool === 'grass');
      button.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || indoorTerrainTool;
    });
    const roomWallField = this.app.querySelector<HTMLElement>('#room-wall-display-field');
    if (roomWallField) roomWallField.hidden = !this.state.map?.room;
    const playButton = this.app.querySelector<HTMLButtonElement>('[data-play-mode]');
    if (playButton) {
      playButton.classList.toggle('active', Boolean(this.playMode?.isActive));
      playButton.disabled = this.state.busy || !this.state.map || Boolean(this.mapAiPreviewMap);
    }
    const developerButton = this.app.querySelector<HTMLButtonElement>('#toggle-developer-mode');
    if (developerButton) {
      developerButton.classList.toggle('active', this.developerMode);
      developerButton.textContent = this.developerMode ? '退出开发者' : '开发者';
      developerButton.disabled = this.state.busy || !this.state.map?.confirmedAt;
    }
    const deleteMapButton = this.app.querySelector<HTMLButtonElement>('#delete-map');
    if (deleteMapButton) deleteMapButton.disabled = this.state.busy || !this.state.map;
    const renameMapButton = this.app.querySelector<HTMLButtonElement>('#rename-current-map');
    if (renameMapButton) renameMapButton.disabled = this.state.busy || !this.state.map || Boolean(this.mapAiPreviewMap);
    const renameMapInput = this.app.querySelector<HTMLInputElement>('#rename-current-map-input');
    if (renameMapInput) renameMapInput.disabled = this.state.busy || !this.state.map || Boolean(this.mapAiPreviewMap);
    const noEditableSelection = Boolean(this.mapAiPreviewMap) || !mapStage || this.state.tool !== 'select' || !this.state.selectedObjectId;
    const transformTools = this.app.querySelector<HTMLElement>('[data-transform-tools]');
    if (transformTools) transformTools.hidden = noEditableSelection;
    this.app.querySelectorAll<HTMLButtonElement>('[data-transform-mode]').forEach((button) => {
      const mode = button.dataset.transformMode as TransformMode;
      const activeMode = this.isTranslateOnlySelection() ? 'translate' : this.state.transformMode;
      const disabled = noEditableSelection || (this.isTranslateOnlySelection() && mode !== 'translate');
      button.classList.toggle('active', mode === activeMode);
      button.disabled = disabled;
      if (noEditableSelection) button.title = '请先使用选择工具选中物体';
      else if (disabled) button.title = '系统参考物只允许移动位置';
    });
    const status = this.app.querySelector<HTMLElement>('#editor-status');
    if (status) {
      const syncState = this.mapAiPreviewMap
        ? '地图 AI 预览未应用'
        : this.renderDraftChanged
          ? '渲染预览未保存'
          : this.state.dirty
            ? '未保存'
            : '已同步';
      status.textContent = this.state.busy ? this.state.message : `${syncState}${this.state.message ? ` · ${this.state.message}` : ''}`;
      status.title = status.textContent;
    }
    const undo = this.app.querySelector<HTMLButtonElement>('#undo-transaction');
    if (undo) {
      undo.hidden = !mapStage;
      undo.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || this.state.dirty || !this.state.undoTransaction;
      undo.title = this.state.dirty
        ? '请先保存或放弃当前手工更改'
        : this.state.undoTransaction
          ? `撤销：${this.state.undoTransaction.label}`
          : '当前没有可撤销的 AI/Agent 事务';
    }
    const redo = this.app.querySelector<HTMLButtonElement>('#redo-transaction');
    if (redo) {
      redo.hidden = !mapStage;
      redo.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || this.state.dirty || !this.state.redoTransaction;
      redo.title = this.state.dirty
        ? '请先保存或放弃当前手工更改'
        : this.state.redoTransaction
          ? `重做：${this.state.redoTransaction.label}`
          : '当前没有可重做的 AI/Agent 事务';
    }
    const save = this.app.querySelector<HTMLButtonElement>('#save-map');
    if (save) {
      save.disabled = this.state.busy || !this.state.map || this.renderDraftChanged || Boolean(this.mapAiPreviewMap);
      save.classList.toggle('dirty', this.state.dirty);
      save.title = this.mapAiPreviewMap
        ? '请先应用或放弃 AI 地图预览'
        : this.renderDraftChanged
          ? '请先保存渲染微调'
          : '保存当前地图';
    }
    const confirmMapButton = this.app.querySelector<HTMLButtonElement>('#confirm-map');
    if (confirmMapButton) {
      confirmMapButton.hidden = !mapStage;
      confirmMapButton.disabled = this.state.busy || !this.state.map || Boolean(this.mapAiPreviewMap);
      confirmMapButton.textContent = '进入渲染';
      confirmMapButton.title = this.state.map?.confirmedAt && !this.state.dirty
        ? '直接进入渲染阶段'
        : '保存当前地图并进入渲染阶段';
    }
    const undoEdit = this.app.querySelector<HTMLButtonElement>('#undo-edit');
    if (undoEdit) undoEdit.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || this.historyPast.length === 0;
    const redoEdit = this.app.querySelector<HTMLButtonElement>('#redo-edit');
    if (redoEdit) redoEdit.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || this.historyFuture.length === 0;
  }

  private markDirty(refreshStatus = true, invalidateConfirmation = true): void {
    if (this.state.map && invalidateConfirmation && this.state.map.confirmedAt !== null) {
      this.state.map.confirmedAt = null;
      this.renderDraft = null;
      this.renderDraftChanged = false;
      this.applyCurrentRenderScheme();
    }
    if (this.state.map && !this.historyGestureStart) {
      const current = cloneMap(this.state.map);
      if (this.historyPresent && mapSnapshot(this.historyPresent) !== mapSnapshot(current)) {
        this.historyPast.push(this.historyPresent);
        if (this.historyPast.length > MAX_HISTORY_STEPS) this.historyPast.shift();
        this.historyFuture.length = 0;
      }
      this.historyPresent = current;
    }
    this.state.dirty = this.state.map ? mapSnapshot(this.state.map) !== this.savedMapSnapshot : false;
    this.state.message = '';
    if (refreshStatus) this.updateToolbarState();
  }

  private resetManualHistory(map: EditableMap, markSaved: boolean): void {
    this.historyPast.length = 0;
    this.historyFuture.length = 0;
    this.historyGestureStart = null;
    this.historyPresent = cloneMap(map);
    if (markSaved) this.savedMapSnapshot = mapSnapshot(map);
    this.state.dirty = false;
  }

  private beginHistoryGesture(): void {
    if (!this.state.map || this.historyGestureStart) return;
    this.historyGestureStart = cloneMap(this.state.map);
  }

  private endHistoryGesture(): void {
    if (!this.state.map || !this.historyGestureStart) return;
    const before = this.historyGestureStart;
    this.historyGestureStart = null;
    if (mapSnapshot(before) === mapSnapshot(this.state.map)) return;
    this.historyPast.push(before);
    if (this.historyPast.length > MAX_HISTORY_STEPS) this.historyPast.shift();
    this.historyFuture.length = 0;
    this.historyPresent = cloneMap(this.state.map);
    this.state.dirty = mapSnapshot(this.state.map) !== this.savedMapSnapshot;
    this.updateToolbarState();
  }

  private async undoManualEdit(): Promise<void> {
    if (!this.state.map || this.state.busy || this.mapAiPreviewMap) return;
    this.endHistoryGesture();
    const previous = this.historyPast.pop();
    if (!previous) return;
    this.historyFuture.push(cloneMap(this.state.map));
    this.state.map = cloneMap(previous);
    this.historyPresent = cloneMap(previous);
    this.state.dirty = mapSnapshot(previous) !== this.savedMapSnapshot;
    if (!this.state.map.confirmedAt) this.state.stage = 'map';
    this.resetRenderDraft();
    this.keepValidSelection();
    this.state.message = '已撤销手工编辑';
    await this.refreshScene();
    this.renderPanels();
  }

  private async redoManualEdit(): Promise<void> {
    if (!this.state.map || this.state.busy || this.mapAiPreviewMap) return;
    const next = this.historyFuture.pop();
    if (!next) return;
    this.historyPast.push(cloneMap(this.state.map));
    this.state.map = cloneMap(next);
    this.historyPresent = cloneMap(next);
    this.state.dirty = mapSnapshot(next) !== this.savedMapSnapshot;
    if (!this.state.map.confirmedAt) this.state.stage = 'map';
    this.resetRenderDraft();
    this.keepValidSelection();
    this.state.message = '已重做手工编辑';
    await this.refreshScene();
    this.renderPanels();
  }

  private keepValidSelection(): void {
    if (!this.state.selectedObjectId || this.isTranslateOnlySelection()) return;
    if (!this.state.map?.objects.some((object) => object.id === this.state.selectedObjectId)) {
      this.state.selectedObjectId = null;
    }
  }

  private async confirmLeaveDirtyMap(): Promise<boolean> {
    if (this.mapAiPreviewMap) {
      if (!confirm('当前 AI 地图预览尚未应用。\n\n确定：放弃预览并继续\n取消：留在当前地图')) return false;
      this.clearMapAiPreview();
    }
    if (this.renderDraftChanged) {
      if (!confirm('当前渲染微调尚未保存。\n\n确定：放弃预览并继续\n取消：留在当前地图')) return false;
      this.resetRenderDraft();
    }
    if (!this.state.dirty) return true;
    if (confirm('当前地图有未保存更改。\n\n确定：保存并继续\n取消：选择是否放弃')) {
      return this.saveMap();
    }
    return confirm('放弃当前未保存更改并继续吗？\n\n确定：放弃\n取消：留在当前地图');
  }

  private frameMap(): void {
    if (!this.state.map) return;
    const bounds = getMapBounds(this.state.map);
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
      new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ)
    );
    this.frameBox(box);
    this.setViewName('全景视图');
  }

  private focusSelection(): void {
    const group = this.renderedMap?.objectGroups.get(this.state.selectedObjectId ?? '');
    if (!group) return;
    this.frameBox(new THREE.Box3().setFromObject(group));
    this.setViewName('聚焦选中');
  }

  private setView(view: keyof typeof VIEW_DIRECTIONS): void {
    if (!this.state.map) return;
    const bounds = getMapBounds(this.state.map);
    this.frameBox(
      new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ)
      ),
      VIEW_DIRECTIONS[view]
    );
    this.setViewName(view === 'top' ? '顶视图' : view === 'front' ? '前视图' : view === 'right' ? '右视图' : '透视视图');
  }

  private frameBox(box: THREE.Box3, direction?: THREE.Vector3): void {
    if (!this.camera || !this.orbit || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(1, size.length() * 0.5);
    const currentDirection = this.camera.position.clone().sub(this.orbit.target);
    const viewDirection = (direction ?? currentDirection).clone();
    if (viewDirection.lengthSq() < 0.0001) viewDirection.set(1, 0.72, 1);
    viewDirection.normalize();
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * 1.15;
    this.camera.up.set(0, Math.abs(viewDirection.y) > 0.999 ? 0 : 1, Math.abs(viewDirection.y) > 0.999 ? -1 : 0);
    this.camera.position.copy(center).addScaledVector(viewDirection, distance);
    this.orbit.target.copy(center);
    this.camera.lookAt(center);
    this.orbit.update();
  }

  private setViewName(name: string): void {
    const label = this.app.querySelector<HTMLElement>('#viewport-view-name');
    if (label) label.textContent = name;
  }

  private setBusy(busy: boolean, message = ''): void {
    this.state.busy = busy;
    this.state.message = message || this.state.message;
    this.updateToolbarState();
  }

  private startMapAgentProgressTimer(): void {
    if (this.mapAgentProgressTimer !== null) window.clearInterval(this.mapAgentProgressTimer);
    this.mapAgentStartedAt = Date.now();
    this.mapAgentElapsedMs = 0;
    this.mapAgentProgressTimer = window.setInterval(() => {
      this.mapAgentElapsedMs = Date.now() - this.mapAgentStartedAt;
      this.renderMapAiPanel();
    }, 1_000);
  }

  private stopMapAgentProgressTimer(): void {
    if (this.mapAgentStartedAt > 0) this.mapAgentElapsedMs = Date.now() - this.mapAgentStartedAt;
    if (this.mapAgentProgressTimer !== null) window.clearInterval(this.mapAgentProgressTimer);
    this.mapAgentProgressTimer = null;
  }

  private startMapLayoutProgressTimer(): void {
    if (this.mapLayoutProgressTimer !== null) window.clearInterval(this.mapLayoutProgressTimer);
    this.mapLayoutStartedAt = Date.now();
    this.mapLayoutElapsedMs = 0;
    this.mapLayoutProgressTimer = window.setInterval(() => {
      this.mapLayoutElapsedMs = Date.now() - this.mapLayoutStartedAt;
      this.renderMapAiPanel();
    }, 1_000);
  }

  private stopMapLayoutProgressTimer(): void {
    if (this.mapLayoutStartedAt > 0) this.mapLayoutElapsedMs = Date.now() - this.mapLayoutStartedAt;
    if (this.mapLayoutProgressTimer !== null) window.clearInterval(this.mapLayoutProgressTimer);
    this.mapLayoutProgressTimer = null;
  }

  private startRenderAgentProgressTimer(): void {
    if (this.renderAgentProgressTimer !== null) window.clearInterval(this.renderAgentProgressTimer);
    this.renderAgentStartedAt = Date.now();
    this.renderAgentElapsedMs = 0;
    this.renderAgentProgressTimer = window.setInterval(() => {
      this.renderAgentElapsedMs = Date.now() - this.renderAgentStartedAt;
      this.renderRenderInspector();
    }, 1_000);
  }

  private stopRenderAgentProgressTimer(): void {
    if (this.renderAgentStartedAt > 0) this.renderAgentElapsedMs = Date.now() - this.renderAgentStartedAt;
    if (this.renderAgentProgressTimer !== null) window.clearInterval(this.renderAgentProgressTimer);
    this.renderAgentProgressTimer = null;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.playMode?.isActive) return;
    if (isEditableTarget(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
      void (event.shiftKey ? this.redoManualEdit() : this.undoManualEdit());
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyD') {
      this.duplicateSelectedObject();
      event.preventDefault();
      return;
    }
    if (event.code === 'Escape' && this.placingAssetId) {
      this.cancelAssetPlacement();
      this.state.message = '已取消放置';
      this.renderPanels();
      return;
    }
    if (event.code === 'Delete' || event.code === 'Backspace') {
      this.deleteSelectedObject();
      event.preventDefault();
      return;
    }
    if (event.code === 'KeyF') {
      this.focusSelection();
      event.preventDefault();
      return;
    }
    if (event.code === 'Home') {
      this.frameMap();
      event.preventDefault();
      return;
    }
    if (!CAMERA_MOVE_KEYS.has(event.code)) return;
    this.cameraKeys.add(event.code);
    event.preventDefault();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (!CAMERA_MOVE_KEYS.has(event.code)) return;
    this.cameraKeys.delete(event.code);
    event.preventDefault();
  };

  private clearCameraKeys = (): void => {
    this.cameraKeys.clear();
  };

  private handleOrbitPointerDownCapture = (event: PointerEvent): void => {
    if (!this.orbit || event.button !== 0) return;
    this.orbit.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : null;
  };

  private handleGlobalPointerEnd = (): void => {
    const shouldPreviewTerrainGesture = this.painting
      && this.state.tool === 'terrain'
      && this.state.terrainAction !== 'brush'
      && this.terrainGesturePoints.length > 0;
    this.painting = false;
    this.terrainFlattenHeight = null;
    this.transformPointerActive = false;
    if (this.orbit) this.orbit.mouseButtons.LEFT = null;
    this.endHistoryGesture();
    if (shouldPreviewTerrainGesture) void this.previewTerrainGesture();
  };

  private hidePointerPreviews = (): void => {
    if (this.brushPreview) this.brushPreview.visible = false;
    if (this.placementPreview) this.placementPreview.visible = false;
  };

  private handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.state.dirty && !this.renderDraftChanged && !this.mapAiPreviewMap) return;
    event.preventDefault();
    event.returnValue = '';
  };

  private updateKeyboardCamera(dt: number): void {
    if (!this.camera || !this.orbit || this.cameraKeys.size === 0 || dt <= 0) return;
    this.cameraForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    if (this.cameraForward.lengthSq() < 0.0001) this.cameraForward.set(0, 0, -1);
    this.cameraForward.normalize();
    this.cameraRight.crossVectors(this.cameraForward, this.camera.up);
    if (this.cameraRight.lengthSq() < 0.0001) {
      this.cameraRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    }
    this.cameraRight.normalize();
    this.cameraMove.set(0, 0, 0);
    if (this.cameraKeys.has('KeyW')) this.cameraMove.add(this.cameraForward);
    if (this.cameraKeys.has('KeyS')) this.cameraMove.sub(this.cameraForward);
    if (this.cameraKeys.has('KeyD')) this.cameraMove.add(this.cameraRight);
    if (this.cameraKeys.has('KeyA')) this.cameraMove.sub(this.cameraRight);
    if (this.cameraKeys.has('ArrowUp')) this.cameraMove.y += 1;
    if (this.cameraKeys.has('ArrowDown')) this.cameraMove.y -= 1;
    if (this.cameraMove.lengthSq() < 0.0001) return;

    const distanceScale = Math.max(1, this.camera.position.distanceTo(this.orbit.target) * 0.08);
    this.cameraMove.normalize().multiplyScalar(CAMERA_BASE_SPEED * distanceScale * dt);
    this.camera.position.add(this.cameraMove);
    this.orbit.target.add(this.cameraMove);
  }

  private enterPlayMode(): void {
    if (!this.state.map || this.state.busy || this.mapAiPreviewMap) return;
    if (!this.playMode?.enter()) return;
    this.state.message = '游玩视角：Esc 退出';
    this.updateToolbarState();
  }

  private setPlayModeActive(active: boolean): void {
    this.app.dataset.playMode = String(active);
    if (this.orbit) this.orbit.enabled = !active;
    const hud = this.app.querySelector<HTMLElement>('.play-mode-hud');
    if (hud) hud.hidden = !active;
    const spawn = this.renderedMap?.objectGroups.get(PLAYER_SPAWN_OBJECT_ID);
    if (spawn) spawn.visible = !active;
    if (active) {
      this.transform?.detach();
      this.clearSelectionOutline();
      this.cameraKeys.clear();
    } else {
      this.renderScene?.clearInteraction();
      this.attachSelectedTransform();
      this.state.message = '已退出游玩视角';
    }
    this.applyRoomWallDisplayMode();
    this.updateToolbarState();
  }

  private applyRoomWallDisplayMode(): void {
    if (!this.camera) return;
    this.renderedMap?.setRoomWallDisplayMode(
      this.playMode?.isActive ? 'full' : this.roomWallDisplayMode,
      this.camera
    );
  }
}

async function editorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = serverHttpBase(location, import.meta.env.DEV);
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
  const json = await resp.json().catch(() => ({})) as { error?: unknown };
  if (!resp.ok) throw new Error(describeEditorResponseError(json.error, resp.status, baseUrl));
  return json as T;
}

function describeEditorResponseError(error: unknown, status: number, baseUrl: string): string {
  const detail = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : `HTTP ${status}`;
  return `编辑器 API 请求失败（${detail}）：${baseUrl}`;
}

async function editorAgentFetch<T>(
  path: string,
  init: RequestInit,
  onProgress: (event: AgentProgressEvent) => void
): Promise<T> {
  const response = await fetch(`${serverHttpBase(location, import.meta.env.DEV)}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  if (!response.body || !String(response.headers.get('content-type')).includes('text/event-stream')) {
    return await response.json() as T;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | null = null;
  const consume = (block: string) => {
    if (!block.trim()) return;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join('\n')) as T & { error?: string };
    if (event === 'progress') onProgress(payload as unknown as AgentProgressEvent);
    else if (event === 'result') result = payload;
    else if (event === 'error') throw new Error(payload.error ?? 'agent_failed');
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consume(block);
    if (done) break;
  }
  consume(buffer);
  if (!result) throw new Error('agent_result_missing');
  return result;
}

function hasRefinableMapContent(map: EditableMap): boolean {
  return map.objects.length > 0
    || map.waterBodies.length > 0
    || map.terrain.heights.some((height) => Math.abs(height) > 0.001);
}

function renderObjectTree(objects: MapObject[], parentId: string | null, selectedId: string | null, depth = 0): string {
  return objects
    .filter((object) => object.parentId === parentId)
    .map((object) => `
      <button class="hierarchy-row ${selectedId === object.id ? 'active' : ''}" style="padding-left:${10 + depth * 16}px" data-object-id="${object.id}">
        <span>${escapeHtml(object.name)}</span>
        <small>${object.assetId ? 'asset' : 'box'}</small>
      </button>
      ${renderObjectTree(objects, object.id, selectedId, depth + 1)}
    `).join('');
}

function terrainPresetLabel(value: TerrainGenerationPreset): string {
  return ({
    plain: '平原', hills: '丘陵', valley: '山谷', island: '小岛', archipelago: '群岛', canyon: '峡谷',
    'cliff-plateau': '峭壁高原', 'dune-desert': '沙丘荒漠'
  } as const)[value];
}

function roomSurfaceLabel(surface: RoomSurface): string {
  return ({
    floor: '地板',
    ceiling: '天花板',
    north: '北墙',
    south: '南墙',
    east: '东墙',
    west: '西墙'
  } as const)[surface];
}

function normalizeRoomWallDisplayMode(value: unknown): RoomWallDisplayMode {
  return value === 'full' || value === 'half' || value === 'hidden' ? value : 'cutaway';
}

function terrainModifierLabel(value: TerrainModifier): string {
  return ({
    mountain: '山峦', ridge: '山脊', valley: '谷地', basin: '盆地',
    cliff: '峭壁', terrace: '梯田', dune: '沙丘', island: '局部小岛'
  } as const)[value];
}

function terrainSurfaceLabel(value: TerrainSurfaceKind): string {
  return ({ grass: '草地', sand: '沙地', rock: '岩地' } as const)[value];
}

function terrainCliffLayoutLabel(value: TerrainCliffLayout): string {
  return ({ plateau: '台地', coast: '海岸峭壁', canyon: '峡谷壁', wall: '独立岩壁', terraces: '多层断崖' } as const)[value];
}

function nextTerrainSeed(value: number): number {
  return (Math.imul(Math.trunc(value) >>> 0, 1_664_525) + 1_013_904_223) >>> 0;
}

function numberField(label: string, group: string, index: number, value: number): string {
  return `<label><span>${label}</span><input type="number" step="0.1" data-vector="${group}" data-index="${index}" value="${Number(value).toFixed(2)}" /></label>`;
}

function readonlyNumberField(label: string, value: number): string {
  return `<label><span>${label}</span><input type="number" value="${Number(value).toFixed(2)}" disabled /></label>`;
}

function colorField(label: string, key: string, value: string): string {
  return `<label><span>${label}</span><input type="color" data-color="${key}" value="${value}" /></label>`;
}

function bindVectorInputs(host: HTMLElement, group: string, vector: [number, number, number], onChange: () => void, positive = false): void {
  host.querySelectorAll<HTMLInputElement>(`[data-vector="${group}"]`).forEach((input) => {
    input.addEventListener('change', () => {
      const index = Number(input.dataset.index);
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      vector[index] = positive ? Math.max(0.01, value) : value;
      onChange();
    });
  });
}

function bindNumberState(host: HTMLElement, selector: string, onChange: (value: number) => void): void {
  host.querySelector<HTMLInputElement>(selector)?.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) onChange(value);
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function findMapObjectId(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.mapObjectId === 'string') return current.userData.mapObjectId;
    current = current.parent;
  }
  return null;
}

function findMapObjectIdFromHit(hit: THREE.Intersection): string | null {
  const resolveBatchHit = hit.object.userData.resolveMapObjectId;
  if (typeof resolveBatchHit === 'function') {
    const objectId = resolveBatchHit(hit);
    if (typeof objectId === 'string') return objectId;
  }
  if (Number.isInteger(hit.instanceId)) {
    const objectIds = hit.object.userData.instanceObjectIds;
    const objectId = Array.isArray(objectIds) ? objectIds[hit.instanceId as number] : null;
    if (typeof objectId === 'string') return objectId;
  }
  return findMapObjectId(hit.object);
}

function selectableObjectHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  const surfaceDistance = hits.find((hit) => findMapSurface(hit.object))?.distance ?? Number.POSITIVE_INFINITY;
  return hits.find((hit) => {
    return findMapObjectIdFromHit(hit) !== null && hit.distance <= surfaceDistance + 0.18;
  }) ?? null;
}

function surfaceHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  return hits.find((item) => findMapSurface(item.object)) ?? null;
}

function groundSurfaceHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  return hits.find((item) => {
    const surface = findMapSurface(item.object);
    return surface === 'terrain' || surface === 'floor';
  }) ?? null;
}

function findMapSurface(object: THREE.Object3D): MapSurface | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.surface === 'string') return current.userData.surface as MapSurface;
    current = current.parent;
  }
  return null;
}

function makePlacementPreview(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = 0.48;
      material.depthWrite = false;
    }
  });
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
  });
}

function cloneMap(map: EditableMap): EditableMap {
  return normalizeMap(structuredClone(map));
}

function mapSnapshot(map: EditableMap): string {
  return JSON.stringify(map);
}

function buildColliderPreview(boxes: MapAsset['colliderPlan']['boxes']): THREE.Group {
  const group = new THREE.Group();
  group.name = '自动碰撞箱';
  for (const box of boxes) {
    const size = new THREE.Vector3(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    );
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({
        color: 0x65e6ff,
        wireframe: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false
      })
    );
    mesh.name = box.sourceNodeId ? `碰撞箱 · ${box.sourceNodeId}` : '碰撞箱';
    mesh.position.set(
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2
    );
    mesh.renderOrder = 20;
    group.add(mesh);
  }
  return group;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function averageScale(scale: [number, number, number]): number {
  return Math.max(0.01, (scale[0] + scale[1] + scale[2]) / 3);
}

function uniformScaleFromAxes(nextScale: [number, number, number], previousScale: [number, number, number], axis: string | null): number {
  if (axis === 'X') return nextScale[0];
  if (axis === 'Y') return nextScale[1];
  if (axis === 'Z') return nextScale[2];
  if (axis === 'XYZ' || axis === 'XYZE') return averageScale(nextScale);
  let index = 0;
  let delta = Math.abs(nextScale[0] - previousScale[0]);
  for (let i = 1; i < 3; i += 1) {
    const nextDelta = Math.abs(nextScale[i] - previousScale[i]);
    if (nextDelta > delta) {
      index = i;
      delta = nextDelta;
    }
  }
  return Math.max(0.01, nextScale[index]);
}

function atmosphereMasterStrength(scheme: RenderScheme): number {
  const value = scheme.renderPlan?.modules.find((module) => module.id === 'runtime.atmosphere-fx')
    ?.params.masterStrength;
  return typeof value === 'number'
    ? value
    : scheme.renderPlan?.visualDirection?.atmosphereFx.masterStrength ?? 0.35;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function downloadJson(file: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function safeDownloadName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'asset-library';
}
