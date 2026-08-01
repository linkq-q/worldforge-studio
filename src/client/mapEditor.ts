import * as THREE from 'three';
import { serverHttpBase } from './serverEndpoint';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RenderStyleManager } from '@voxel-studio/render-runtime';
import {
  DEFAULT_SUN_POSITION,
  MAP_SIZE_PRESETS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPAWN_OBJECT_ID,
  SUN_OBJECT_ID,
  addPaintStroke,
  applyTerrainBrush,
  createMapObject,
  createPaintStroke,
  getMapBounds,
  getPlayerSpawnYaw,
  getSpawnPoints,
  getSunPosition,
  normalizeMap,
  sampleTerrainHeight,
  surfaceUvFromPoint,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type MapSummary,
  type MapSurface,
  type MapSizePresetKey,
  type TerrainBrushMode
} from '../shared/map';
import { planLimits } from '../shared/mapPlanning';
import { isCompositionEmptyMap, SCENE_COMPOSITION_LIMITS } from '../shared/sceneComposition';
import { renderMapCompositionSummary } from './mapCompositionPanel';
import {
  bindGrassEditorPanel,
  ensureGrassLayerSelection,
  renderGrassEditorPanel,
  type GrassEditorState,
} from './grassEditorPanel';
import { applyGrassBrushInPlace } from '../shared/mapGrass';
import { defaultRenderModule, renderDeveloperCapability } from './developerRenderControls';
import {
  humanizeAgentError,
  renderAgentProgress,
  updateAgentProgress
} from './agentProgressPanel';
import { buildEditableMapGroup, type RenderedMap } from './mapRenderer';
import { configureSunLight } from './lighting';
import { buildModelGroup } from './modelRenderer';
import { RenderRuntimeAdapter } from './renderRuntimeAdapter';
import { HDRI_DOME_RADIUS, HdriSkyController } from './hdriSky';
import { configureRendererOutput } from './renderOutputPipeline';
import { RenderStats } from './renderStats';
import {
  applyMapOperations,
  type MapAiSuggestion,
  type MapTransactionSummary
} from '../shared/mapOperations';
import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider
} from '../shared/protocol';
import type { HdriTexture } from '../shared/hdri';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';
import {
  MODEL_GENERATION_MODES,
  normalizeModelGenerationMode,
  type ModelGenerationMode
} from '../shared/modelGenerationMode';
import {
  RENDER_CAPABILITIES,
  compileRuntimeColorGrade,
  compileRuntimeEffectRecipes,
  compileRuntimeGrassStyle,
  compileRuntimeHdriSky,
  compileRuntimeLightRig,
  compileRuntimeMaterialThemes,
  compileRuntimeOutline,
  compileRuntimePostQuality,
  compileRuntimePresentation,
  compileRuntimeShaderExtension,
  compileRuntimeStyle,
  compileRuntimeWaterStyles,
  createDefaultRenderAccessPolicy,
  DEFAULT_RUNTIME_GRASS_STYLE,
  normalizeRenderAccessPolicy,
  type RuntimeLightRig,
  type RenderModuleId,
  type RenderParameterAccess,
  type RenderPlan,
  renderModuleLabel
} from '../shared/renderPlan';

type EditorTool = 'select' | 'paint' | 'terrain' | 'grass';
type TransformMode = 'translate' | 'rotate' | 'scale';
type EditorStage = 'map' | 'render';

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
  terrainSize: number;
  terrainStrength: number;
  uniformScale: boolean;
  dirty: boolean;
  busy: boolean;
  message: string;
  undoTransaction: MapTransactionSummary | null;
}

export function startMapEditor(app: HTMLElement): void {
  const editor = new MapEditor(app);
  void editor.start();
}

class MapEditor {
  private readonly state: EditorState = {
    maps: [],
    assets: [],
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
    terrainSize: 1.8,
    terrainStrength: 0.3,
    uniformScale: false,
    dirty: false,
    busy: false,
    message: '',
    undoTransaction: null
  };

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private renderStats: RenderStats | null = null;
  private renderStyleManager: RenderStyleManager | null = null;
  private renderRuntimeAdapter: RenderRuntimeAdapter | null = null;
  private hdriSky: HdriSkyController | null = null;
  private hdriFiles: string[] = [];
  private readonly runtimeMeshes = new Map<string, THREE.Mesh>();
  private sunLight: THREE.DirectionalLight | null = null;
  private hemisphereLight: THREE.HemisphereLight | null = null;
  private sunTarget: THREE.Object3D | null = null;
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
  private lastFrameAt = performance.now();
  private painting = false;
  private terrainFlattenHeight: number | null = null;
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
  private renderAiExplanation = '';
  private renderAiAbortController: AbortController | null = null;
  private renderAgentProgress: AgentProgressEvent[] = [];
  private developerMode = false;
  private mapAiPrompt = '';
  private mapAiProvider: ChatProvider = 'gpt';
  private newMapAssetGenerationMode: ModelGenerationMode = 'voxel';
  private mapAiSuggestion: MapAiSuggestion | null = null;
  private mapAiPreviewMap: EditableMap | null = null;
  private mapAiAbortController: AbortController | null = null;
  private mapAgentProgress: AgentProgressEvent[] = [];
  private mapAgentStartedAt = 0;
  private mapAgentElapsedMs = 0;
  private mapAgentProgressTimer: number | null = null;
  private newMapSizePreset: MapSizePresetKey = 'medium';
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
          <div class="editor-section map-loader">
            <select id="editor-map-select"></select>
            <select id="new-map-size" aria-label="新地图尺寸">
              ${MAP_SIZE_PRESETS.map((preset) => `
                <option value="${preset.key}" ${preset.key === this.newMapSizePreset ? 'selected' : ''}>
                  ${preset.label}
                </option>
              `).join('')}
            </select>
            <select id="new-map-asset-mode" aria-label="新地图模型风格">
              ${MODEL_GENERATION_MODES.map((mode) => `
                <option value="${mode.key}" ${mode.key === this.newMapAssetGenerationMode ? 'selected' : ''}>${mode.label}</option>
              `).join('')}
            </select>
            <button id="new-map" class="small">新建</button>
          </div>
          <div class="editor-section stage-switcher">
            <span class="toolbar-label">制作阶段</span>
            <div class="segmented compact">
              <button data-stage="map">1 地图</button>
              <button data-stage="render">2 渲染</button>
            </div>
          </div>
          <div class="editor-section hierarchy-head">
            <h2>层级</h2>
            <button id="add-object" class="secondary small" data-map-only>添加空物体</button>
          </div>
          <div id="hierarchy" class="hierarchy"></div>
        </aside>
        <section class="editor-main">
          <header class="editor-toolbar">
            <div class="toolbar-group" data-map-only>
              <span class="toolbar-label">工具</span>
              <div class="segmented compact">
                <button data-tool="select">选择</button>
                <button data-tool="paint">绘制</button>
                <button data-tool="terrain">地形</button>
                <button data-tool="grass">草地</button>
              </div>
            </div>
            <div class="toolbar-group" data-map-only>
              <span class="toolbar-label">对象变换</span>
              <div class="segmented compact">
                <button data-transform-mode="translate" title="移动物体">移动</button>
                <button data-transform-mode="rotate" title="旋转物体">旋转</button>
                <button data-transform-mode="scale" title="缩放物体">缩放</button>
              </div>
            </div>
            <div class="toolbar-actions">
              <button id="undo-edit" class="secondary" disabled title="撤销手工编辑（Ctrl+Z）">撤销</button>
              <button id="redo-edit" class="secondary" disabled title="重做手工编辑（Ctrl+Shift+Z）">重做</button>
              <button id="undo-transaction" class="secondary" disabled title="撤销最近一次 AI/Agent 生成">撤销 AI</button>
              <button id="confirm-map" title="进入渲染阶段">进入渲染</button>
              <button id="save-map">保存</button>
            </div>
            <span id="editor-status"></span>
          </header>
          <div id="editor-viewport" class="editor-viewport">
            <div class="viewport-badge"><span></span><b id="viewport-view-name">透视视图</b></div>
            <div id="viewport-stats" class="viewport-stats" hidden></div>
            <nav class="viewport-navigation" aria-label="视角导航">
              <button data-view="perspective" title="透视视图">透视</button>
              <button data-view="top" title="顶视图">顶</button>
              <button data-view="front" title="前视图">前</button>
              <button data-view="right" title="右视图">右</button>
              <button data-frame="selection" title="聚焦选中物体（F）">选中</button>
              <button data-frame="all" title="显示完整地图（Home）">全景</button>
            </nav>
          </div>
          <footer class="editor-shortcuts" aria-label="地图编辑器操作键">
            <span><kbd>左键</kbd>选择 / 绘制 / 地形</span>
            <span><kbd>右键拖动</kbd>旋转视角</span>
            <span><kbd>中键拖动</kbd>平移视角</span>
            <span><kbd>Alt</kbd>+<kbd>左键</kbd>旋转视角</span>
            <span><kbd>滚轮</kbd>缩放视角</span>
            <span><kbd>F</kbd>聚焦选中 <kbd>Home</kbd>显示全景</span>
            <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动镜头</span>
            <span><kbd>↑</kbd>/<kbd>↓</kbd>上升 / 下沉镜头</span>
          </footer>
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

    this.app.querySelector('#new-map')?.addEventListener('click', () => void this.createMap());
    this.app.querySelector<HTMLSelectElement>('#new-map-size')?.addEventListener('change', (event) => {
      this.newMapSizePreset = (event.target as HTMLSelectElement).value as MapSizePresetKey;
    });
    this.app.querySelector<HTMLSelectElement>('#new-map-asset-mode')?.addEventListener('change', (event) => {
      this.newMapAssetGenerationMode = normalizeModelGenerationMode((event.target as HTMLSelectElement).value);
      localStorage.setItem('worldforge.newMapAssetMode', this.newMapAssetGenerationMode);
    });
    this.app.querySelector('#add-object')?.addEventListener('click', () => this.addObject());
    this.app.querySelector('#save-map')?.addEventListener('click', () => void this.saveMap());
    this.app.querySelector('#confirm-map')?.addEventListener('click', () => void this.confirmMap());
    this.app.querySelector('#undo-edit')?.addEventListener('click', () => void this.undoManualEdit());
    this.app.querySelector('#redo-edit')?.addEventListener('click', () => void this.redoManualEdit());
    this.app.querySelector('#undo-transaction')?.addEventListener('click', () => void this.undoLatestTransaction());
    this.app.querySelector('#editor-map-select')?.addEventListener('change', async (event) => {
      const id = (event.target as HTMLSelectElement).value;
      if (!await this.loadMap(id)) this.renderMapSelector();
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view as keyof typeof VIEW_DIRECTIONS));
    });
    this.app.querySelector<HTMLButtonElement>('[data-frame="selection"]')?.addEventListener('click', () => this.focusSelection());
    this.app.querySelector<HTMLButtonElement>('[data-frame="all"]')?.addEventListener('click', () => this.frameMap());
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
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111719);
    // The HDRI dome is a fixed-radius sphere centred on the origin, so the far
    // plane has to clear HDRI_DOME_RADIUS plus however far the camera orbits out.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, HDRI_DOME_RADIUS * 3);
    this.camera.position.set(22, 18, 24);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    configureRendererOutput(this.renderer);
    const statsElement = host.querySelector<HTMLElement>('#viewport-stats');
    if (statsElement) {
      this.renderStats = new RenderStats(this.renderer.info, statsElement);
      this.renderStats.setVisible(this.developerMode);
    }
    host.appendChild(this.renderer.domElement);

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

    const hemi = new THREE.HemisphereLight(0xeaf6ff, 0x30382f, 1.6);
    const sun = new THREE.DirectionalLight(0xfff0ce, 2.5);
    const sunTarget = new THREE.Object3D();
    sun.position.set(...DEFAULT_SUN_POSITION);
    sun.target = sunTarget;
    sun.castShadow = true;
    this.sunLight = sun;
    this.hemisphereLight = hemi;
    this.sunTarget = sunTarget;
    this.scene.userData.directionalLight = sun;
    this.renderStyleManager = new RenderStyleManager({
      THREE,
      renderer: this.renderer,
      scene: this.scene,
      meshRegistry: this.runtimeMeshes
    });
    this.renderRuntimeAdapter = new RenderRuntimeAdapter(this.renderer, this.scene, this.camera);
    this.hdriSky = new HdriSkyController(
      this.renderer,
      this.scene,
      (file) => `${serverHttpBase(location, import.meta.env.DEV)}/api/editor/hdri/${encodeURIComponent(file)}`,
      (environmentMap) => this.renderRuntimeAdapter?.syncEnvironment(environmentMap)
    );
    void this.reloadHdriTextures();
    this.scene.add(hemi, sun, sunTarget);
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
    const [maps, assets, renderSchemes] = await Promise.all([
      editorFetch<{ maps: MapSummary[] }>('/api/editor/maps'),
      editorFetch<{ assets: MapAsset[] }>('/api/editor/assets'),
      editorFetch<{ renderSchemes: RenderScheme[] }>('/api/editor/render-schemes')
    ]);
    this.state.maps = maps.maps;
    this.state.assets = assets.assets;
    this.state.renderSchemes = renderSchemes.renderSchemes;
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
    const [{ map }, { transaction }] = await Promise.all([
      editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(id)}`),
      editorFetch<{ transaction: MapTransactionSummary | null }>(`/api/editor/maps/${encodeURIComponent(id)}/transactions`)
    ]);
    this.state.map = normalizeMap(map);
    this.clearMapAiPreview();
    this.state.undoTransaction = transaction;
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
    this.cancelAssetPlacement();
    const { map } = await editorFetch<{ map: EditableMap }>('/api/editor/maps', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim() || '新地图',
        size: preset.size,
        assetGenerationMode: this.newMapAssetGenerationMode
      })
    });
    await this.reloadLists();
    this.state.map = normalizeMap(map);
    this.clearMapAiPreview();
    this.state.undoTransaction = null;
    this.state.selectedObjectId = null;
    this.state.stage = 'map';
    this.resetRenderDraft();
    this.resetManualHistory(this.state.map, true);
    await this.refreshScene();
    this.renderPanels();
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
    this.renderStats?.setVisible(this.developerMode);
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
    const terrainCount = suggestion?.operations.filter((operation) => operation.type.startsWith('terrain.')).length ?? 0;
    const waterCount = suggestion?.operations.filter((operation) => operation.type.startsWith('water.')).length ?? 0;
    const objectCount = suggestion?.operations.filter((operation) => operation.type.startsWith('object.')).length ?? 0;
    const hasSpawn = suggestion?.operations.some((operation) => operation.type === 'reference.set') ?? false;
    const compositionAvailable = isCompositionEmptyMap(map);
    const generationBlocked = this.state.busy || this.state.dirty || !this.mapAiPrompt.trim() || !compositionAvailable;
    const refinementBlocked = generationBlocked || !hasRefinableMapContent(map);
    const limits = planLimits(getMapBounds(map));
    host.innerHTML = `
      <section class="editor-section map-ai">
        <h2>AI 生成地图</h2>
        <textarea id="map-ai-prompt" rows="3" maxlength="1200" placeholder="例如：中央有缓坡小丘，周围放置树木和岩石" ${this.state.busy ? 'disabled' : ''}>${escapeHtml(this.mapAiPrompt)}</textarea>
        <div class="map-ai-controls">
          <select id="map-ai-provider" aria-label="地图 AI 模型" ${this.state.busy ? 'disabled' : ''}>
            ${CHAT_PROVIDER_OPTIONS.map((option) => `
              <option value="${option.key}" ${option.key === this.mapAiProvider ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>
                ${escapeHtml(option.label)}${option.disabled ? '（暂不可用）' : ''}
              </option>
            `).join('')}
          </select>
          <button id="generate-map-ai" ${generationBlocked ? 'disabled' : ''}>生成新规划</button>
          <button id="refine-map-ai" class="secondary" ${refinementBlocked ? 'disabled' : ''}>调整当前地图</button>
          ${this.mapAiAbortController ? '<button id="cancel-map-ai" class="secondary">取消</button>' : ''}
        </div>
        ${renderAgentProgress(this.mapAgentProgress, {
          running: Boolean(this.mapAiAbortController),
          elapsedMs: this.mapAgentElapsedMs,
          slowAssetMode: map.assetGenerationMode === 'standard' || map.assetGenerationMode === 'voxel-pro'
        })}
        <p class="empty">模型风格 ${map.assetGenerationMode.toUpperCase()} · ${this.state.dirty
          ? '请先保存当前手工修改，再生成 AI 地图预览。'
          : !compositionAvailable
            ? '当前地图已有内容，请使用“调整当前地图”继续 Refine。'
            : `总导演会先组织完整场景，按需调用最多 ${SCENE_COMPOSITION_LIMITS.consultationCount} 个专家，并生成最多 ${limits.assetRequestCount} 类同风格缺失资产；合成审查后再进入预览。`}</p>
      </section>
      ${suggestion && this.mapAiPreviewMap ? `
        <section class="editor-section map-ai-result">
          <span class="stage-kicker">AI 地图建议</span>
          <h2>${escapeHtml(suggestion.summary)}</h2>
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
          ${(suggestion.diagnostics?.length ?? 0) > 0 ? `
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
    host.querySelector<HTMLTextAreaElement>('#map-ai-prompt')?.addEventListener('input', (event) => {
      this.mapAiPrompt = (event.target as HTMLTextAreaElement).value;
      const blocked = this.state.busy || this.state.dirty || !this.mapAiPrompt.trim();
      const generateButton = host.querySelector<HTMLButtonElement>('#generate-map-ai');
      const refineButton = host.querySelector<HTMLButtonElement>('#refine-map-ai');
      if (generateButton) generateButton.disabled = blocked || !isCompositionEmptyMap(map);
      if (refineButton) refineButton.disabled = blocked || !hasRefinableMapContent(map);
    });
    host.querySelector<HTMLSelectElement>('#map-ai-provider')?.addEventListener('change', (event) => {
      this.mapAiProvider = (event.target as HTMLSelectElement).value as ChatProvider;
    });
    host.querySelector('#generate-map-ai')?.addEventListener('click', () => void this.generateMapAiPreview('generate'));
    host.querySelector('#refine-map-ai')?.addEventListener('click', () => void this.generateMapAiPreview('refine'));
    host.querySelector('#cancel-map-ai')?.addEventListener('click', () => {
      this.mapAiAbortController?.abort();
      this.state.message = '正在取消地图 Agent...';
      this.updateToolbarState();
    });
    host.querySelector('#discard-map-ai')?.addEventListener('click', () => void this.discardMapAiPreview());
    host.querySelector('#apply-map-ai')?.addEventListener('click', () => void this.applyMapAiPreview());
  }

  private async generateMapAiPreview(mode: 'generate' | 'refine'): Promise<void> {
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
      this.mapAiSuggestion = combinedSuggestion;
      this.mapAiPreviewMap = applyMapOperations(this.mapWithEditorAssets(map), combinedSuggestion.operations);
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

  private async discardMapAiPreview(): Promise<void> {
    if (!this.mapAiPreviewMap) return;
    this.clearMapAiPreview();
    this.state.message = '已放弃 AI 地图预览';
    await this.refreshScene();
    this.renderPanels();
  }

  private async applyMapAiPreview(): Promise<void> {
    const map = this.state.map;
    const suggestion = this.mapAiSuggestion;
    if (!map || !suggestion || this.state.busy || this.state.dirty) return;
    this.setBusy(true, '正在应用 AI 地图...');
    try {
      const result = await editorFetch<{ map: EditableMap; transaction: MapTransactionSummary }>(
        `/api/editor/maps/${encodeURIComponent(map.id)}/transactions`,
        {
          method: 'POST',
          body: JSON.stringify({
            source: 'basic-ai',
            label: suggestion.summary,
            operations: suggestion.operations
          })
        }
      );
      this.state.map = normalizeMap(result.map);
      this.state.undoTransaction = result.transaction;
      this.state.selectedObjectId = null;
      this.clearMapAiPreview();
      this.resetRenderDraft();
      this.resetManualHistory(this.state.map, true);
      await this.reloadLists();
      await this.refreshScene();
      this.state.message = `已应用：${result.transaction.label}`;
    } catch (error) {
      this.state.message = `应用 AI 地图失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      this.setBusy(false);
      this.renderPanels();
    }
  }

  private clearMapAiPreview(): void {
    this.mapAiSuggestion = null;
    this.mapAiPreviewMap = null;
  }

  private renderMapSelector(): void {
    const select = this.app.querySelector<HTMLSelectElement>('#editor-map-select');
    if (!select) return;
    select.innerHTML = this.state.maps.length
      ? this.state.maps.map((map) => `<option value="${map.id}" ${this.state.map?.id === map.id ? 'selected' : ''}>${escapeHtml(map.name)}</option>`).join('')
      : '<option value="">暂无地图</option>';
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
          <small>${water.type === 'lake' ? 'lake' : 'river'}</small>
        </div>
      `).join('')}
      ${renderObjectTree(map.objects, null, this.state.selectedObjectId)}
    `;
    if (this.mapAiPreviewMap) return;
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
    host.innerHTML = `
      <section class="editor-section">
        <h2>地图</h2>
        <label class="field compact"><span>名称</span><input data-map-name value="${escapeHtml(map.name)}" /></label>
        <div class="triple">
          ${numberField('宽', 'box-size', 0, map.box.size[0])}
          ${numberField('高', 'box-size', 1, map.box.size[1])}
          ${numberField('深', 'box-size', 2, map.box.size[2])}
        </div>
        <div class="color-grid">
          ${colorField('地板', 'floor', map.box.colors.floor)}
        </div>
      </section>
      ${this.state.tool === 'paint' ? `<section class="editor-section">
        <h2>画笔</h2>
        <label class="field compact"><span>颜色</span><input data-brush-color type="color" value="${this.state.brushColor}" /></label>
        <label class="field compact"><span>大小</span><input data-brush-size type="range" min="0.1" max="8" step="0.1" value="${this.state.brushSize}" /></label>
        <label class="field compact"><span>边缘模糊</span><input data-brush-softness type="range" min="0" max="1" step="0.05" value="${this.state.brushSoftness}" /></label>
      </section>` : ''}
      ${this.state.tool === 'terrain' ? `<section class="editor-section">
        <h2>地形</h2>
        <select data-terrain-mode>
          <option value="raise" ${this.state.terrainMode === 'raise' ? 'selected' : ''}>抬高</option>
          <option value="lower" ${this.state.terrainMode === 'lower' ? 'selected' : ''}>降低</option>
          <option value="flatten" ${this.state.terrainMode === 'flatten' ? 'selected' : ''}>平整</option>
        </select>
        <label class="field compact"><span>大小</span><input data-terrain-size type="range" min="0.3" max="8" step="0.1" value="${this.state.terrainSize}" /></label>
        <label class="field compact"><span>强度</span><input data-terrain-strength type="range" min="0.02" max="1.5" step="0.02" value="${this.state.terrainStrength}" /></label>
      </section>` : ''}
      ${this.state.tool === 'grass' ? renderGrassEditorPanel(map, this.grassEditorState) : ''}
    `;
    host.querySelector<HTMLInputElement>('[data-map-name]')?.addEventListener('input', (event) => {
      map.name = (event.target as HTMLInputElement).value;
      this.markDirty(false);
    });
    bindVectorInputs(host, 'box-size', map.box.size, () => {
      this.markDirty();
      void this.refreshScene();
    });
    host.querySelectorAll<HTMLInputElement>('[data-color]').forEach((input) => {
      input.addEventListener('input', () => {
        map.box.colors[input.dataset.color as keyof typeof map.box.colors] = input.value;
        this.markDirty();
        void this.refreshScene();
      });
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
    bindNumberState(host, '[data-terrain-size]', (value) => { this.state.terrainSize = value; });
    bindNumberState(host, '[data-terrain-strength]', (value) => { this.state.terrainStrength = value; });
    if (this.state.tool === 'grass') {
      bindGrassEditorPanel(host, map, this.grassEditorState, {
        changed: (message) => {
          this.markDirty();
          this.state.message = message;
          void this.refreshScene();
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
    if (map && this.isPlayerSpawnSelected()) {
      const spawn = this.playerSpawnPoint();
      host.innerHTML = `
        <section class="editor-section">
          <h2>场景参考点</h2>
          <p class="empty">用于预览、导航或后续运行时接入的默认空间参考点。</p>
          <div class="triple">${numberField('X', 'spawn-pos', 0, spawn[0])}${numberField('Y', 'spawn-pos', 1, spawn[1])}${numberField('Z', 'spawn-pos', 2, spawn[2])}</div>
          <label class="field compact"><span>朝向 Yaw（度）</span><input data-spawn-yaw type="number" step="1" value="${radiansToDegrees(getPlayerSpawnYaw(map)).toFixed(1)}" /></label>
          <div class="triple">${readonlyNumberField('宽', PLAYER_RADIUS * 2)}${readonlyNumberField('高', PLAYER_HEIGHT)}${readonlyNumberField('深', PLAYER_RADIUS * 2)}</div>
        </section>
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
      host.innerHTML = `
        <section class="editor-section">
          <h2>太阳</h2>
          <p class="empty">调整太阳的位置会改变地图中的主方向光照。太阳始终朝向地图中心。</p>
          <div class="triple">${numberField('X', 'sun-pos', 0, sunPosition[0])}${numberField('Y', 'sun-pos', 1, sunPosition[1])}${numberField('Z', 'sun-pos', 2, sunPosition[2])}</div>
        </section>
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
      host.innerHTML = '<section class="editor-section"><h2>Transform</h2><p class="empty">选择一个物体。</p></section>';
      return;
    }
    const compatibleAssets = this.compatibleAssets();
    const currentAsset = this.state.assets.find((asset) => asset.id === object.assetId) ?? null;
    const legacyAssetOption = currentAsset && currentAsset.mode !== map.assetGenerationMode
      ? `<option value="${currentAsset.id}" selected disabled>${escapeHtml(currentAsset.name)}（旧 ${escapeHtml(currentAsset.mode.toUpperCase())}，不可继续复用）</option>`
      : '';
    host.innerHTML = `
      <section class="editor-section">
        <h2>Transform</h2>
        <label class="field compact"><span>名称</span><input data-object-name value="${escapeHtml(object.name)}" /></label>
        <label class="field compact">
          <span>父级</span>
          <select data-parent>
            <option value="">无</option>
            ${map.objects.filter((item) => item.id !== object.id).map((item) => `<option value="${item.id}" ${object.parentId === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
          </select>
        </label>
        <div class="triple">${numberField('X', 'pos', 0, object.transform.position[0])}${numberField('Y', 'pos', 1, object.transform.position[1])}${numberField('Z', 'pos', 2, object.transform.position[2])}</div>
        <div class="triple">${numberField('RX', 'rot', 0, radiansToDegrees(object.transform.rotation[0]))}${numberField('RY', 'rot', 1, radiansToDegrees(object.transform.rotation[1]))}${numberField('RZ', 'rot', 2, radiansToDegrees(object.transform.rotation[2]))}</div>
        <label class="field compact"><span>等比例缩放</span><input data-uniform-scale type="checkbox" ${this.state.uniformScale ? 'checked' : ''} /></label>
        <div class="triple">${numberField('SX', 'scale', 0, object.transform.scale[0])}${numberField('SY', 'scale', 1, object.transform.scale[1])}${numberField('SZ', 'scale', 2, object.transform.scale[2])}</div>
        <div class="triple">${numberField('宽', 'size', 0, object.transform.size[0])}${numberField('高', 'size', 1, object.transform.size[1])}${numberField('深', 'size', 2, object.transform.size[2])}</div>
        <label class="field compact">
          <span>资产</span>
          <select data-object-asset>
            <option value="">未绑定</option>
            ${legacyAssetOption}
            ${compatibleAssets.map((asset) => `<option value="${asset.id}" ${object.assetId === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('')}
          </select>
        </label>
        <button id="delete-object" class="secondary small">删除物体</button>
      </section>
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
    bindVectorInputs(host, 'pos', object.transform.position, () => {
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
    const compatibleAssets = this.compatibleAssets();
    const selectedAsset = compatibleAssets.find((asset) => asset.id === this.state.selectedAssetId) ?? compatibleAssets[0] ?? null;
    if (this.state.selectedAssetId !== selectedAsset?.id) this.state.selectedAssetId = selectedAsset?.id ?? null;
    host.innerHTML = `
      <section class="editor-section asset-tools">
        <h2>资产</h2>
        <textarea id="asset-prompt" placeholder="输入提示词生成模型资产"></textarea>
        <p class="empty">当前地图的新资产统一使用 ${this.state.map?.assetGenerationMode.toUpperCase() ?? 'VOXEL'} 模式。</p>
        <button id="generate-asset" ${this.state.busy ? 'disabled' : ''}>生成资产</button>
        <p class="empty">资产列表只显示与当前地图相同模式的可复用资产。</p>
        <select id="asset-list" ${selectedAsset ? '' : 'disabled'}>
          ${compatibleAssets.map((asset) => `<option value="${asset.id}" ${selectedAsset?.id === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('')}
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
    `;
    const previewHost = host.querySelector<HTMLElement>('#asset-preview');
    if (previewHost && this.previewRenderer) {
      previewHost.appendChild(this.previewRenderer.domElement);
      this.resizePreview();
    }
    host.querySelector('#generate-asset')?.addEventListener('click', () => void this.generateAsset());
    host.querySelector<HTMLSelectElement>('#asset-list')?.addEventListener('change', (event) => {
      this.cancelAssetPlacement();
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
    void this.renderAssetPreview();
  }

  private renderDeveloperPresetEditor(draft: RenderScheme): string {
    const shader = draft.renderPlan ? compileRuntimeShaderExtension(draft.renderPlan) : { mode: 'off' as const };
    return `
      <section class="editor-section developer-render-panel">
        <span class="stage-kicker">开发者模式</span>
        <h2>预设与开放策略</h2>
        <p class="empty">“预设值”决定方案当前效果；“AI / 开发者”决定谁能调整，以及可调整的范围和控件形式。保存时始终生成新方案。</p>
        <label class="field compact">
          <span>方案名称</span>
          <input data-dev-scheme-field="name" maxlength="48" value="${escapeHtml(draft.name)}" />
        </label>
        <label class="field compact">
          <span>方案说明</span>
          <textarea data-dev-scheme-field="description" rows="2" maxlength="160">${escapeHtml(draft.description)}</textarea>
        </label>
        <div class="developer-capability-list">
          ${RENDER_CAPABILITIES.map((capability) => renderDeveloperCapability(capability, draft, this.hdriFiles)).join('')}
        </div>
        ${shader.mode === 'isolated-glsl' ? `
          <p class="developer-warning">完整 GLSL 只作为隔离扩展保存在方案中；当前基础编辑器不会执行它，也不会修改核心源码。</p>
        ` : ''}
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
    const activeSchemeId = this.renderAiPreview ? draft?.id : selected?.id;
    host.innerHTML = `
      <section class="editor-section render-stage-summary">
        <span class="stage-kicker">第二阶段</span>
        <h2>为地图选择视觉氛围</h2>
        <p class="empty">地图空间内容保持不变。这里保存的是可被其他地图复用的独立渲染方案。</p>
        <button id="toggle-developer-mode" class="${this.developerMode ? '' : 'secondary'}">
          ${this.developerMode ? '退出开发者模式' : '开发者模式'}
        </button>
      </section>
      <section class="editor-section render-ai">
        <h2>AI 生成风格</h2>
        <textarea id="render-ai-prompt" rows="3" maxlength="1000" placeholder="例如：素描风格的宁静田园，带有柔和晨雾">${escapeHtml(this.renderAiPrompt)}</textarea>
        ${map.renderPromptSuggestions.length > 0 ? `
          <div class="render-prompt-suggestions">
            <small>地图阶段提取的氛围建议</small>
            <div class="style-tags">
              ${map.renderPromptSuggestions.map((suggestion) => `
                <button type="button" data-render-prompt-suggestion="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div class="render-ai-controls">
          <select id="render-ai-provider" aria-label="AI 模型">
            ${CHAT_PROVIDER_OPTIONS.map((option) => `
              <option value="${option.key}" ${option.key === this.renderAiProvider ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>
                ${escapeHtml(option.label)}${option.disabled ? '（暂不可用）' : ''}
              </option>
            `).join('')}
          </select>
          <button id="generate-render-ai" ${this.state.busy || !this.renderAiPrompt.trim() ? 'disabled' : ''}>生成新风格</button>
          <button id="refine-render-ai" class="secondary" ${this.state.busy || !this.renderAiPrompt.trim() || !draft ? 'disabled' : ''}>
            ${this.renderAiPreview ? '继续调整预览' : '调整当前方案'}
          </button>
          ${this.renderAiAbortController ? '<button id="cancel-render-ai" class="secondary">取消</button>' : ''}
        </div>
        ${renderAgentProgress(this.renderAgentProgress, {
          running: Boolean(this.renderAiAbortController),
          elapsedMs: 0
        })}
        <p class="empty">AI 会选择基础方案，并编排环境、雾、光照和 runtime 表面/画面风格模块；不会修改地图或生成 Shader。</p>
      </section>
      ${this.renderAiPreview && draft ? `
        <section class="editor-section render-ai-result">
          <span class="stage-kicker">AI 建议 · ${escapeHtml(draft.name)}</span>
          <p>${escapeHtml(this.renderAiExplanation || '已根据提示词生成可预览的渲染方案。')}</p>
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
      <section class="editor-section">
        <h2>方案库</h2>
        <div class="render-scheme-list">
          ${this.state.renderSchemes.map((scheme) => `
            <button class="render-scheme-card ${scheme.id === activeSchemeId ? 'active' : ''}" data-render-scheme="${scheme.id}">
              <span class="scheme-swatch" style="--scheme-bg:${scheme.settings.background};--scheme-sun:${scheme.settings.sunColor}"></span>
              <span><strong>${escapeHtml(scheme.name)}</strong><small>${escapeHtml(scheme.description)}</small></span>
              <em>${scheme.kind === 'builtin' ? '预设' : '自定义'}</em>
            </button>
          `).join('')}
        </div>
      </section>
      ${draft && this.developerMode ? this.renderDeveloperPresetEditor(draft) : ''}
      ${draft ? `
        <section class="editor-section render-tuning">
          <h2>安全微调</h2>
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
          <p id="render-tuning-note" class="empty">${this.renderDraftChanged ? '微调正在预览，保存后会生成新的渲染方案，不会改动原预设。' : '只开放普通用户容易理解的白名单参数。'}</p>
          ${this.renderAiPreview ? '' : `<button id="save-render-scheme">${this.renderDraftChanged ? '保存为新方案' : '复制为新方案'}</button>`}
        </section>
      ` : ''}
    `;
    host.querySelector('#toggle-developer-mode')?.addEventListener('click', () => {
      this.developerMode = !this.developerMode;
      localStorage.setItem('worldforge.developerMode', this.developerMode ? 'on' : 'off');
      this.renderStats?.setVisible(this.developerMode);
      this.state.message = this.developerMode ? '已进入开发者模式' : '已退出开发者模式';
      this.renderRenderInspector();
      this.updateToolbarState();
    });
    host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-dev-scheme-field]').forEach((input) => {
      input.addEventListener('input', () => {
        if (!this.renderDraft) return;
        const field = input.dataset.devSchemeField as 'name' | 'description';
        this.renderDraft[field] = input.value;
        this.markRenderDraftChanged();
      });
    });
    host.querySelectorAll<HTMLInputElement>('[data-dev-module-enable]').forEach((input) => {
      input.addEventListener('change', () => {
        const plan = this.ensureRenderDraftPlan();
        const id = input.dataset.devModuleEnable as RenderModuleId;
        if (!plan) return;
        if (input.checked && !plan.modules.some((module) => module.id === id)) {
          const capability = RENDER_CAPABILITIES.find((entry) => entry.id === id);
          if (capability) plan.modules.push(defaultRenderModule(capability, plan.modules.length));
        } else if (!input.checked) {
          plan.modules = plan.modules.filter((module) => module.id !== id);
        }
        this.markRenderDraftChanged(true);
        this.renderRenderInspector();
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
        const plan = this.ensureRenderDraftPlan();
        const index = Number(input.dataset.devModuleIndex);
        const parameter = input.dataset.devParam;
        const module = plan?.modules[index];
        const capability = module && RENDER_CAPABILITIES.find((entry) => entry.id === module.id);
        const rule = capability && parameter ? capability.params[parameter] : null;
        if (!module || !parameter || !rule) return;
        if (rule.type === 'number') {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          module.params[parameter] = value;
          host.querySelectorAll<HTMLInputElement>(
            `[data-dev-module-index="${index}"][data-dev-param="${parameter}"]`
          ).forEach((peer) => {
            if (peer !== input) peer.value = String(value);
          });
          const output = host.querySelector<HTMLOutputElement>(
            `[data-dev-value-output="${index}:${parameter}"]`
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
      });
    });
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-dev-module-index][data-dev-scope]').forEach((input) => {
      input.addEventListener(input.dataset.devScope === 'tag' ? 'input' : 'change', () => {
        const plan = this.ensureRenderDraftPlan();
        const index = Number(input.dataset.devModuleIndex);
        const module = plan?.modules[index];
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
    host.querySelector<HTMLSelectElement>('#render-ai-provider')?.addEventListener('change', (event) => {
      this.renderAiProvider = (event.target as HTMLSelectElement).value as ChatProvider;
    });
    host.querySelectorAll<HTMLButtonElement>('[data-render-prompt-suggestion]').forEach((button) => {
      button.addEventListener('click', () => {
        const suggestion = button.dataset.renderPromptSuggestion?.trim();
        if (!suggestion) return;
        const current = this.renderAiPrompt.trim();
        if (!current.includes(suggestion)) this.renderAiPrompt = current ? `${current}，${suggestion}` : suggestion;
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
    host.querySelector('#save-render-scheme')?.addEventListener('click', () => void this.saveRenderDraft());
  }

  private selectedRenderScheme(): RenderScheme | null {
    const id = this.state.map?.renderSchemeId;
    return this.state.renderSchemes.find((scheme) => scheme.id === id) ?? this.state.renderSchemes[0] ?? null;
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
    this.renderAiExplanation = '';
  }

  private async generateRenderAiPreview(mode: 'generate' | 'refine'): Promise<void> {
    const prompt = this.renderAiPrompt.trim();
    if (!prompt || !this.state.map?.confirmedAt || this.state.busy) return;
    const currentPlan = mode === 'refine' ? structuredClone(this.ensureRenderDraftPlan()) : null;
    if (mode === 'refine' && !currentPlan) return;
    const controller = new AbortController();
    this.renderAiAbortController = controller;
    this.renderAgentProgress = [];
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
      this.renderAiExplanation = suggestion.explanation;
      this.state.message = 'AI 渲染预览已生成，尚未应用';
      this.applyCurrentRenderScheme();
    } catch (error) {
      this.state.message = error instanceof Error && error.name === 'AbortError'
        ? '已取消渲染 Agent'
        : `AI 渲染生成失败：${error instanceof Error ? error.message : '未知错误'}`;
    } finally {
      if (this.renderAiAbortController === controller) this.renderAiAbortController = null;
      this.setBusy(false);
      this.renderPanels();
    }
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
      this.renderAiExplanation = '';
      this.markDirty(true, false);
      this.state.message = '新渲染方案已保存，记得保存地图引用';
      this.applyCurrentRenderScheme();
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
    const asset = this.state.assets.find((item) => item.id === this.state.selectedAssetId);
    const assetId = asset?.id ?? null;
    if (this.previewAssetId === assetId && (assetId === null || this.previewModel)) return;
    this.previewAssetId = assetId;
    const requestId = this.previewRequestId + 1;
    this.previewRequestId = requestId;
    this.clearAssetPreviewModel();
    if (!asset?.modelJson) return;
    const model = await buildModelGroup(asset.modelJson);
    if (requestId !== this.previewRequestId || this.state.selectedAssetId !== assetId || !this.previewModelRoot) {
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

  private async refreshScene(): Promise<void> {
    if (!this.scene) return;
    this.clearSelectionOutline();
    const previous = this.renderedMap;
    if (previous) {
      this.runtimeMeshes.clear();
      this.renderRuntimeAdapter?.setSceneRoots(null, null);
      this.scene.remove(previous.group);
      previous.dispose();
      this.renderedMap = null;
    }
    if (!this.state.map) {
      this.transform?.detach();
      return;
    }
    this.updateSceneLighting();
    this.renderedMap = await buildEditableMapGroup(this.mapWithEditorAssets(), { editorHelpers: true });
    this.scene.add(this.renderedMap.group);
    this.renderRuntimeAdapter?.setSceneRoots(this.renderedMap.group, this.renderedMap.modelsRoot);
    this.renderedMap.modelsRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && object.userData.editorHelper !== true) this.runtimeMeshes.set(mesh.uuid, mesh);
    });
    this.attachSelectedTransform();
    this.applyCurrentRenderScheme();
  }

  private handlePointer(event: PointerEvent, first: boolean): void {
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
      if (this.painting) this.beginHistoryGesture();
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
      void this.refreshScene();
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
      void this.refreshScene();
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
    void this.refreshScene();
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

  private mapWithEditorAssets(source = this.mapAiPreviewMap ?? this.state.map): EditableMap {
    if (!source) throw new Error('missing_map');
    const assets = new Map<string, MapAsset>();
    for (const asset of source.assets ?? []) assets.set(asset.id, asset);
    for (const asset of this.state.assets) assets.set(asset.id, asset);
    return {
      ...source,
      assets: [...assets.values()]
    };
  }

  private compatibleAssets(): MapAsset[] {
    const mode = this.state.map?.assetGenerationMode;
    return mode ? this.state.assets.filter((asset) => asset.mode === mode) : [];
  }

  private isPlayerSpawnSelected(): boolean {
    return this.state.selectedObjectId === PLAYER_SPAWN_OBJECT_ID;
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
    const x = clampNumber(position[0], bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS);
    const z = clampNumber(position[2], bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS);
    const terrainY = sampleTerrainHeight(this.state.map, x, z);
    const maxY = Math.max(terrainY, bounds.maxY - PLAYER_HEIGHT);
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
    if (!this.state.map || !this.sunLight || !this.sunTarget) return;
    configureSunLight(this.sunLight, this.sunTarget, this.state.map);
  }

  private async reloadHdriTextures(): Promise<void> {
    const result = await editorFetch<{ hdriTextures?: HdriTexture[] }>('/api/editor/hdri')
      .catch(() => null);
    this.hdriFiles = (result?.hdriTextures ?? []).map((texture) => texture.file);
  }

  private applyCurrentRenderScheme(): void {
    if (!this.scene || !this.renderer || !this.sunLight || !this.hemisphereLight) return;
    const scheme = !this.mapAiPreviewMap && this.state.map?.confirmedAt
      ? this.renderDraft ?? this.selectedRenderScheme()
      : null;
    this.renderRuntimeAdapter?.resetScopedCapabilities();
    if (!scheme) {
      this.renderStyleManager?.applyStyle({ renderMode: 'pbr' });
      this.renderRuntimeAdapter?.applyOutline({ mode: 'none', params: {} });
      this.renderRuntimeAdapter?.applyPresentation({
        mode: 'none',
        sketch: {},
        paper: {},
        comic: {}
      });
      this.scene.background = new THREE.Color(0x111719);
      this.scene.fog = null;
      this.hemisphereLight.color.set(0xeaf6ff);
      this.hemisphereLight.groundColor.set(0x30382f);
      this.hemisphereLight.intensity = 1.6;
      this.sunLight.color.set(0xfff0ce);
      this.sunLight.intensity = 2.5;
      configureRendererOutput(this.renderer);
      this.renderRuntimeAdapter?.applyColorGrade({ recipe: 'neutral' });
      this.renderRuntimeAdapter?.applyPostQuality({
        bloom: 'off',
        ssao: 'off',
        depthOfField: 'off'
      });
      this.renderRuntimeAdapter?.applyDistanceFog('#111719', 0);
      this.renderRuntimeAdapter?.applyScopedCapabilities([], [], []);
      this.renderedMap?.setGrassStyle(DEFAULT_RUNTIME_GRASS_STYLE);
      this.hdriSky?.clear();
      this.updateSceneLighting();
      return;
    }
    const settings = scheme.settings;
    this.scene.background = new THREE.Color(settings.background);
    // One depth-based fog pass also covers custom ShaderMaterials such as water.
    this.scene.fog = null;
    this.renderRuntimeAdapter?.applyDistanceFog(settings.fogColor, settings.fogDensity);
    this.hemisphereLight.color.set(settings.hemisphereSkyColor);
    this.hemisphereLight.groundColor.set(settings.hemisphereGroundColor);
    this.hemisphereLight.intensity = settings.hemisphereIntensity;
    this.sunLight.color.set(settings.sunColor);
    this.sunLight.intensity = settings.sunIntensity;
    configureRendererOutput(this.renderer, settings.exposure);
    const runtimeStyle = scheme.renderPlan
      ? compileRuntimeStyle(scheme.renderPlan)
      : { mode: 'pbr' as const, cartoon: {} };
    this.renderStyleManager?.applyStyle({
      renderMode: runtimeStyle.mode,
      cartoon: runtimeStyle.cartoon
    });
    if (runtimeStyle.mode === 'cel') this.renderStyleManager?.setCartoonParams(runtimeStyle.cartoon);
    const runtimeOutline = scheme.renderPlan
      ? compileRuntimeOutline(scheme.renderPlan)
      : { mode: 'none' as const, params: {} };
    this.renderRuntimeAdapter?.applyOutline(runtimeOutline);
    const runtimePresentation = scheme.renderPlan
      ? compileRuntimePresentation(scheme.renderPlan)
      : { mode: 'none' as const, sketch: {}, paper: {}, comic: {} };
    this.renderRuntimeAdapter?.applyPresentation(runtimePresentation);
    const colorGrade = scheme.renderPlan
      ? compileRuntimeColorGrade(scheme.renderPlan)
      : { recipe: 'neutral' as const };
    this.renderRuntimeAdapter?.applyColorGrade(colorGrade);
    const postQuality = scheme.renderPlan
      ? compileRuntimePostQuality(scheme.renderPlan)
      : { bloom: 'off' as const, ssao: 'off' as const, depthOfField: 'off' as const };
    this.renderRuntimeAdapter?.applyPostQuality(postQuality);
    this.renderedMap?.setGrassStyle(
      scheme.renderPlan ? compileRuntimeGrassStyle(scheme.renderPlan) : DEFAULT_RUNTIME_GRASS_STYLE
    );
    if (scheme.renderPlan) {
      applyLightRig(
        compileRuntimeLightRig(scheme.renderPlan),
        this.sunLight,
        this.hemisphereLight,
        settings
      );
    }
    this.renderRuntimeAdapter?.applyScopedCapabilities(
      scheme.renderPlan ? compileRuntimeMaterialThemes(scheme.renderPlan) : [],
      scheme.renderPlan ? compileRuntimeWaterStyles(scheme.renderPlan) : [],
      scheme.renderPlan ? compileRuntimeEffectRecipes(scheme.renderPlan) : []
    );
    if (scheme.renderPlan) void this.hdriSky?.apply(compileRuntimeHdriSky(scheme.renderPlan));
    else this.hdriSky?.clear();
  }

  private animate(): void {
    this.animationFrame = requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const frameMs = Math.max(0, now - this.lastFrameAt);
    const dt = Math.min(0.05, frameMs / 1000);
    this.lastFrameAt = now;
    this.resize();
    this.updateKeyboardCamera(dt);
    this.orbit?.update();
    this.selectionOutline?.update();
    this.renderedMap?.update(dt);
    this.renderRuntimeAdapter?.tick(dt, now / 1000);
    this.renderStats?.beginFrame();
    this.renderRuntimeAdapter?.render();
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderRuntimeAdapter?.setSize(width, height);
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
    this.app.querySelectorAll<HTMLElement>('[data-map-only]').forEach((element) => {
      element.hidden = !mapStage;
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((button) => {
      const stage = button.dataset.stage as EditorStage;
      button.classList.toggle('active', stage === this.state.stage);
      button.disabled = this.state.busy || Boolean(this.mapAiPreviewMap) || (stage === 'render' && !this.state.map);
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === this.state.tool);
      button.disabled = this.state.busy || Boolean(this.mapAiPreviewMap);
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-transform-mode]').forEach((button) => {
      const mode = button.dataset.transformMode as TransformMode;
      const activeMode = this.isTranslateOnlySelection() ? 'translate' : this.state.transformMode;
      const noEditableSelection = Boolean(this.mapAiPreviewMap) || !mapStage || this.state.tool !== 'select' || !this.state.selectedObjectId;
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
    const save = this.app.querySelector<HTMLButtonElement>('#save-map');
    if (save) {
      save.disabled = this.state.busy || !this.state.map || this.renderDraftChanged || Boolean(this.mapAiPreviewMap);
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

  private handleKeyDown = (event: KeyboardEvent): void => {
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
    this.painting = false;
    this.terrainFlattenHeight = null;
    this.transformPointerActive = false;
    if (this.orbit) this.orbit.mouseButtons.LEFT = null;
    this.endHistoryGesture();
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
}

async function editorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${serverHttpBase(location, import.meta.env.DEV)}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
  const json = await resp.json().catch(() => ({})) as { error?: string };
  if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`);
  return json as T;
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

function applyLightRig(
  rig: RuntimeLightRig,
  sun: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight,
  base: RenderScheme['settings']
): void {
  const recipes: Record<RuntimeLightRig['recipe'], {
    key: number;
    fill: number;
    sun: string;
    sky: string;
    ground: string;
    softness: number;
  }> = {
    neutral: { key: 1, fill: 1, sun: base.sunColor, sky: base.hemisphereSkyColor, ground: base.hemisphereGroundColor, softness: 0.55 },
    'soft-morning': { key: 0.72, fill: 1.08, sun: '#ffe5bd', sky: '#e7f2f2', ground: '#46554d', softness: 0.92 },
    'hard-day': { key: 1.35, fill: 0.7, sun: '#fff4dc', sky: '#dff3ff', ground: '#34443a', softness: 0.16 },
    backlit: { key: 1.18, fill: 0.76, sun: '#ffd5a1', sky: '#dbe9f1', ground: '#3d4347', softness: 0.42 },
    overcast: { key: 0.36, fill: 1.28, sun: '#e8eef0', sky: '#d9e2e4', ground: '#59605d', softness: 1 },
    sunset: { key: 1.08, fill: 0.72, sun: '#ff9c5a', sky: '#c99691', ground: '#40373d', softness: 0.72 }
  };
  const recipe = recipes[rig.recipe];
  const strength = rig.strength ?? 1;
  const warmth = THREE.MathUtils.clamp(rig.warmth ?? 0, -1, 1);
  sun.intensity = base.sunIntensity * recipe.key * strength;
  hemisphere.intensity = base.hemisphereIntensity * recipe.fill * Math.sqrt(strength);
  sun.color.set(recipe.sun).lerp(
    new THREE.Color(warmth >= 0 ? '#ffb56b' : '#9fc9ff'),
    Math.abs(warmth) * 0.28
  );
  hemisphere.color.set(recipe.sky);
  hemisphere.groundColor.set(recipe.ground);
  sun.shadow.radius = 1 + (rig.shadowSoftness ?? recipe.softness) * 4;
  sun.shadow.needsUpdate = true;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
