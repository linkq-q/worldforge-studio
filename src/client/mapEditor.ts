import * as THREE from 'three';
import { serverHttpBase } from './serverEndpoint';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  DEFAULT_SUN_POSITION,
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
  type TerrainBrushMode
} from '../shared/map';
import { buildEditableMapGroup, type RenderedMap } from './mapRenderer';
import { configureSunLight } from './lighting';
import { buildModelGroup } from './modelRenderer';
import type { MapTransactionSummary } from '../shared/mapOperations';

type EditorTool = 'select' | 'paint' | 'terrain';
type TransformMode = 'translate' | 'rotate' | 'scale';

const CAMERA_MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);
const CAMERA_BASE_SPEED = 8;
const CAMERA_LOOK_SENSITIVITY = 0.003;
const CAMERA_MIN_PITCH = -Math.PI / 2 + 0.02;
const CAMERA_MAX_PITCH = Math.PI / 2 - 0.02;

interface EditorState {
  maps: MapSummary[];
  assets: MapAsset[];
  map: EditableMap | null;
  selectedObjectId: string | null;
  selectedAssetId: string | null;
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
    map: null,
    selectedObjectId: null,
    selectedAssetId: null,
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
  private sunLight: THREE.DirectionalLight | null = null;
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
  private readonly cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly cameraLookDirection = new THREE.Vector3();
  private cameraLookPointerId: number | null = null;
  private cameraLookLast = { x: 0, y: 0 };
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

  constructor(private readonly app: HTMLElement) {}

  async start(): Promise<void> {
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
            <button id="new-map" class="small">新建</button>
          </div>
          <div class="editor-section hierarchy-head">
            <h2>层级</h2>
            <button id="add-object" class="secondary small">添加物体</button>
          </div>
          <div id="hierarchy" class="hierarchy"></div>
        </aside>
        <section class="editor-main">
          <header class="editor-toolbar">
            <div class="toolbar-group">
              <span class="toolbar-label">工具</span>
              <div class="segmented compact">
                <button data-tool="select">选择</button>
                <button data-tool="paint">绘制</button>
                <button data-tool="terrain">地形</button>
              </div>
            </div>
            <div class="toolbar-group">
              <span class="toolbar-label">变换</span>
              <div class="segmented compact">
                <button data-transform-mode="translate">移动</button>
                <button data-transform-mode="rotate">旋转</button>
                <button data-transform-mode="scale">缩放</button>
              </div>
            </div>
            <div class="toolbar-actions">
              <button id="undo-transaction" class="secondary" disabled>撤销事务</button>
              <button id="save-map">保存</button>
            </div>
            <span id="editor-status"></span>
          </header>
          <div id="editor-viewport" class="editor-viewport">
            <div class="viewport-badge"><span></span>透视视图</div>
          </div>
          <footer class="editor-shortcuts" aria-label="地图编辑器操作键">
            <span><kbd>左键</kbd>选择 / 绘制 / 地形</span>
            <span><kbd>中键拖动</kbd>旋转视角</span>
            <span><kbd>右键拖动</kbd>平移视角</span>
            <span><kbd>滚轮</kbd>缩放视角</span>
            <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动镜头</span>
            <span><kbd>Space</kbd>/<kbd>Shift</kbd>上升 / 下沉镜头</span>
            <span>选中物体后拖动指示器调整 Transform</span>
          </footer>
        </section>
        <aside class="editor-sidebar right">
          <div class="inspector-heading"><strong>属性</strong><small>SCENE</small></div>
          <div id="map-inspector"></div>
          <div id="object-inspector"></div>
          <div id="asset-panel"></div>
        </aside>
      </main>
    `;

    this.app.querySelector('#new-map')?.addEventListener('click', () => void this.createMap());
    this.app.querySelector('#add-object')?.addEventListener('click', () => this.addObject());
    this.app.querySelector('#save-map')?.addEventListener('click', () => void this.saveMap());
    this.app.querySelector('#undo-transaction')?.addEventListener('click', () => void this.undoLatestTransaction());
    this.app.querySelector('#editor-map-select')?.addEventListener('change', (event) => {
      const id = (event.target as HTMLSelectElement).value;
      void this.loadMap(id);
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        this.state.tool = button.dataset.tool as EditorTool;
        if (this.renderer) this.renderer.domElement.style.cursor = this.state.tool === 'select' ? 'default' : 'crosshair';
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
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
    this.camera.position.set(22, 18, 24);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.enableRotate = false;
    this.orbit.enablePan = true;
    this.orbit.enableZoom = true;
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = {
      LEFT: null,
      MIDDLE: null,
      RIGHT: THREE.MOUSE.PAN
    };
    this.orbit.target.set(0, 1.5, 0);

    const hemi = new THREE.HemisphereLight(0xeaf6ff, 0x30382f, 1.6);
    const sun = new THREE.DirectionalLight(0xfff0ce, 2.5);
    const sunTarget = new THREE.Object3D();
    sun.position.set(...DEFAULT_SUN_POSITION);
    sun.target = sunTarget;
    sun.castShadow = true;
    this.sunLight = sun;
    this.sunTarget = sunTarget;
    this.scene.add(hemi, sun, sunTarget);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode(this.state.transformMode);
    this.transform.addEventListener('mouseDown', () => {
      this.transformPointerActive = true;
    });
    this.transform.addEventListener('mouseUp', () => {
      this.transformPointerActive = false;
    });
    this.transform.addEventListener('dragging-changed', (event) => {
      this.transformDragging = Boolean(event.value);
      if (this.orbit) this.orbit.enabled = !this.transformDragging && this.cameraLookPointerId === null;
    });
    this.transform.addEventListener('objectChange', () => this.syncSelectedTransform());
    this.scene.add(this.transform.getHelper());

    this.renderer.domElement.addEventListener('pointerdown', this.handleCameraLookPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.handleCameraLookPointerMove);
    this.renderer.domElement.addEventListener('pointerdown', (event) => this.handlePointer(event, true));
    this.renderer.domElement.addEventListener('pointermove', (event) => this.handlePointer(event, false));
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('pointerup', this.handleGlobalPointerEnd);
    window.addEventListener('pointercancel', this.handleGlobalPointerEnd);
    window.addEventListener('blur', this.clearCameraKeys);
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
    const [maps, assets] = await Promise.all([
      editorFetch<{ maps: MapSummary[] }>('/api/editor/maps'),
      editorFetch<{ assets: MapAsset[] }>('/api/editor/assets')
    ]);
    this.state.maps = maps.maps;
    this.state.assets = assets.assets;
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
        objectCount: map.objects.length
      }];
      await this.refreshScene();
    }
  }

  private async loadMap(id: string): Promise<void> {
    if (!id) return;
    const [{ map }, { transaction }] = await Promise.all([
      editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(id)}`),
      editorFetch<{ transaction: MapTransactionSummary | null }>(`/api/editor/maps/${encodeURIComponent(id)}/transactions`)
    ]);
    this.state.map = normalizeMap(map);
    this.state.undoTransaction = transaction;
    this.state.selectedObjectId = null;
    this.state.dirty = false;
    await this.refreshScene();
    this.renderPanels();
  }

  private async createMap(): Promise<void> {
    const name = prompt('地图名称', '新地图') ?? '新地图';
    const { map } = await editorFetch<{ map: EditableMap }>('/api/editor/maps', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    await this.reloadLists();
    this.state.map = normalizeMap(map);
    this.state.undoTransaction = null;
    await this.refreshScene();
    this.renderPanels();
  }

  private async saveMap(): Promise<void> {
    if (!this.state.map) return;
    this.setBusy(true, '保存中...');
    try {
      const { map } = await editorFetch<{ map: EditableMap }>(`/api/editor/maps/${encodeURIComponent(this.state.map.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ map: this.state.map })
      });
      this.state.map = normalizeMap(map);
      this.state.dirty = false;
      this.state.undoTransaction = null;
      await this.reloadLists();
      this.state.message = '已保存';
      await this.refreshScene();
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private async undoLatestTransaction(): Promise<void> {
    if (!this.state.map || !this.state.undoTransaction || this.state.dirty) return;
    this.setBusy(true, '撤销事务中...');
    try {
      const { map, transaction } = await editorFetch<{ map: EditableMap; transaction: MapTransactionSummary }>(
        `/api/editor/maps/${encodeURIComponent(this.state.map.id)}/transactions/undo`,
        { method: 'POST' }
      );
      this.state.map = normalizeMap(map);
      this.state.undoTransaction = null;
      this.state.selectedObjectId = null;
      this.state.message = `已撤销：${transaction.label}`;
      await this.reloadLists();
      await this.refreshScene();
      this.renderPanels();
    } finally {
      this.setBusy(false);
    }
  }

  private addObject(): void {
    if (!this.state.map) return;
    const object = createMapObject(`物体 ${this.state.map.objects.length + 1}`, this.state.selectedAssetId);
    this.state.map.objects.push(object);
    this.state.selectedObjectId = object.id;
    this.markDirty();
    void this.refreshScene();
    this.renderPanels();
  }

  private renderPanels(): void {
    this.renderMapSelector();
    this.renderHierarchy();
    this.renderMapInspector();
    this.renderObjectInspector();
    this.renderAssetPanel();
    this.attachSelectedTransform();
    this.updateToolbarState();
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
      ${renderObjectTree(map.objects, null, this.state.selectedObjectId)}
    `;
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
          ${colorField('天花板', 'ceiling', map.box.colors.ceiling)}
          ${colorField('北墙', 'north', map.box.colors.north)}
          ${colorField('南墙', 'south', map.box.colors.south)}
          ${colorField('东墙', 'east', map.box.colors.east)}
          ${colorField('西墙', 'west', map.box.colors.west)}
        </div>
      </section>
      <section class="editor-section">
        <h2>画笔</h2>
        <label class="field compact"><span>颜色</span><input data-brush-color type="color" value="${this.state.brushColor}" /></label>
        <label class="field compact"><span>大小</span><input data-brush-size type="range" min="0.1" max="8" step="0.1" value="${this.state.brushSize}" /></label>
        <label class="field compact"><span>边缘模糊</span><input data-brush-softness type="range" min="0" max="1" step="0.05" value="${this.state.brushSoftness}" /></label>
      </section>
      <section class="editor-section">
        <h2>地形</h2>
        <select data-terrain-mode>
          <option value="raise" ${this.state.terrainMode === 'raise' ? 'selected' : ''}>抬高</option>
          <option value="lower" ${this.state.terrainMode === 'lower' ? 'selected' : ''}>降低</option>
          <option value="flatten" ${this.state.terrainMode === 'flatten' ? 'selected' : ''}>平整</option>
        </select>
        <label class="field compact"><span>大小</span><input data-terrain-size type="range" min="0.3" max="8" step="0.1" value="${this.state.terrainSize}" /></label>
        <label class="field compact"><span>强度</span><input data-terrain-strength type="range" min="0.02" max="1.5" step="0.02" value="${this.state.terrainStrength}" /></label>
      </section>
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
            ${this.state.assets.map((asset) => `<option value="${asset.id}" ${object.assetId === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('')}
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
      map.objects = map.objects.filter((item) => item.id !== object.id).map((item) => item.parentId === object.id ? { ...item, parentId: null } : item);
      this.state.selectedObjectId = null;
      this.markDirty();
      void this.refreshScene();
      this.renderPanels();
    });
  }

  private renderAssetPanel(): void {
    const host = this.app.querySelector<HTMLElement>('#asset-panel');
    if (!host) return;
    const selectedAsset = this.state.assets.find((asset) => asset.id === this.state.selectedAssetId) ?? this.state.assets[0] ?? null;
    if (selectedAsset && this.state.selectedAssetId !== selectedAsset.id) this.state.selectedAssetId = selectedAsset.id;
    host.innerHTML = `
      <section class="editor-section asset-tools">
        <h2>资产</h2>
        <textarea id="asset-prompt" placeholder="输入提示词生成模型资产"></textarea>
        <button id="generate-asset" ${this.state.busy ? 'disabled' : ''}>生成资产</button>
        <select id="asset-list">
          ${this.state.assets.map((asset) => `<option value="${asset.id}" ${selectedAsset?.id === asset.id ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('')}
        </select>
        <div id="asset-preview" class="asset-preview"></div>
        <p class="empty">${selectedAsset
          ? `自动碰撞箱：${selectedAsset.colliderPlan.boxes.length} 个 · 候选 ${selectedAsset.colliderPlan.candidateCount} 个${selectedAsset.colliderPlan.fallbackUsed ? ' · 已回退整体边界' : ''}`
          : '尚未选择资产'}</p>
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
      this.state.selectedAssetId = (event.target as HTMLSelectElement).value;
      this.renderPanels();
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
        body: JSON.stringify({ prompt, mode: 'voxel' })
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

  private async refreshScene(): Promise<void> {
    if (!this.scene) return;
    const previous = this.renderedMap;
    if (previous) {
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
    this.attachSelectedTransform();
  }

  private handlePointer(event: PointerEvent, first: boolean): void {
    if (!this.renderer || !this.camera || !this.renderedMap || !this.state.map) return;
    if (first && event.button !== 0) return;
    if (!first && this.state.tool === 'select' && event.buttons === 0) {
      const hits = this.raycast(event);
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
    if (first) {
      this.painting = this.state.tool !== 'select';
      event.preventDefault();
    }
    const hits = this.raycast(event);
    if (this.state.tool === 'select') {
      if (!first) return;
      const hit = selectableObjectHit(hits);
      this.selectObject(hit ? findMapObjectId(hit.object) : null);
      return;
    }
    const hit = hits.find((item) => findMapSurface(item.object));
    if (!hit) return;
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

  private mapWithEditorAssets(): EditableMap {
    if (!this.state.map) throw new Error('missing_map');
    const assets = new Map<string, MapAsset>();
    for (const asset of this.state.map.assets ?? []) assets.set(asset.id, asset);
    for (const asset of this.state.assets) assets.set(asset.id, asset);
    return {
      ...this.state.map,
      assets: [...assets.values()]
    };
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

  private animate(): void {
    this.animationFrame = requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;
    this.resize();
    this.updateKeyboardCamera(dt);
    this.orbit?.update();
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
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
    this.app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === this.state.tool);
    });
    this.app.querySelectorAll<HTMLButtonElement>('[data-transform-mode]').forEach((button) => {
      const mode = button.dataset.transformMode as TransformMode;
      const activeMode = this.isTranslateOnlySelection() ? 'translate' : this.state.transformMode;
      const disabled = this.isTranslateOnlySelection() && mode !== 'translate';
      button.classList.toggle('active', mode === activeMode);
      button.disabled = disabled;
      button.title = disabled ? '系统参考物只允许移动位置' : '';
    });
    const status = this.app.querySelector<HTMLElement>('#editor-status');
    if (status) status.textContent = this.state.busy ? this.state.message : `${this.state.dirty ? '有未保存更改' : '已同步'}${this.state.message ? ` · ${this.state.message}` : ''}`;
    const undo = this.app.querySelector<HTMLButtonElement>('#undo-transaction');
    if (undo) {
      undo.disabled = this.state.busy || this.state.dirty || !this.state.undoTransaction;
      undo.title = this.state.dirty
        ? '请先保存或放弃当前手工更改'
        : this.state.undoTransaction
          ? `撤销：${this.state.undoTransaction.label}`
          : '当前没有可撤销的 AI/Agent 事务';
    }
    const save = this.app.querySelector<HTMLButtonElement>('#save-map');
    if (save) save.disabled = this.state.busy || !this.state.map;
  }

  private markDirty(refreshStatus = true): void {
    this.state.dirty = true;
    this.state.message = '';
    if (refreshStatus) this.updateToolbarState();
  }

  private setBusy(busy: boolean, message = ''): void {
    this.state.busy = busy;
    this.state.message = message || this.state.message;
    this.updateToolbarState();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!CAMERA_MOVE_KEYS.has(event.code) || isEditableTarget(event.target)) return;
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

  private handleCameraLookPointerDown = (event: PointerEvent): void => {
    if (event.button !== 1 || !this.camera || !this.orbit || !this.renderer || this.transformDragging) return;
    this.cameraLookPointerId = event.pointerId;
    this.cameraLookLast = { x: event.clientX, y: event.clientY };
    this.orbit.enabled = false;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private handleCameraLookPointerMove = (event: PointerEvent): void => {
    if (this.cameraLookPointerId !== event.pointerId) return;
    const dx = event.clientX - this.cameraLookLast.x;
    const dy = event.clientY - this.cameraLookLast.y;
    this.cameraLookLast = { x: event.clientX, y: event.clientY };
    this.rotateCameraInPlace(dx, dy);
    event.preventDefault();
  };

  private handleGlobalPointerEnd = (event: PointerEvent): void => {
    this.painting = false;
    this.terrainFlattenHeight = null;
    this.transformPointerActive = false;
    if (this.cameraLookPointerId !== event.pointerId) return;
    this.cameraLookPointerId = null;
    if (this.renderer?.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (this.orbit && !this.transformDragging) this.orbit.enabled = true;
  };

  private rotateCameraInPlace(dx: number, dy: number): void {
    if (!this.camera || !this.orbit) return;
    const targetDistance = Math.max(1, this.camera.position.distanceTo(this.orbit.target));
    this.cameraEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.cameraEuler.y -= dx * CAMERA_LOOK_SENSITIVITY;
    this.cameraEuler.x = THREE.MathUtils.clamp(
      this.cameraEuler.x - dy * CAMERA_LOOK_SENSITIVITY,
      CAMERA_MIN_PITCH,
      CAMERA_MAX_PITCH
    );
    this.cameraEuler.z = 0;
    this.camera.quaternion.setFromEuler(this.cameraEuler);
    this.camera.getWorldDirection(this.cameraLookDirection);
    this.orbit.target.copy(this.camera.position).addScaledVector(this.cameraLookDirection, targetDistance);
  }

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
    if (this.cameraKeys.has('Space')) this.cameraMove.y += 1;
    if (this.cameraKeys.has('ShiftLeft') || this.cameraKeys.has('ShiftRight')) this.cameraMove.y -= 1;
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

function selectableObjectHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  const surfaceDistance = hits.find((hit) => findMapSurface(hit.object))?.distance ?? Number.POSITIVE_INFINITY;
  return hits.find((hit) => {
    return findMapObjectId(hit.object) !== null && hit.distance <= surfaceDistance + 0.18;
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

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.dispose();
  });
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
