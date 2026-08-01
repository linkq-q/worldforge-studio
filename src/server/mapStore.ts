import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  addPaintStroke,
  applyTerrainBrush,
  createEmptyMap,
  createId,
  createMapObject,
  getMapCollisionBake,
  mapToSummary,
  normalizeMap,
  type EditableMap,
  type MapAsset,
  type MapBoxColors,
  type MapObject,
  type MapPaintStroke,
  type MapSummary,
  type TerrainBrushMode,
  type Transform3D
} from '../shared/map';
import type { Vec3 } from '../shared/protocol';
import { normalizeModelGenerationMode, type ModelGenerationMode } from '../shared/modelGenerationMode';
import {
  applyMapOperations,
  type MapOperation,
  type MapTransactionRequest,
  type MapTransactionSummary
} from '../shared/mapOperations';

import { MAP_ASSET_COLLIDER_PROFILE, normalizeModelColliderPlan } from '../shared/modelBounds';
import { assetFootprintRadius, assetSizeClass, normalizeAssetTags } from '../shared/mapAssetMetadata';
import {
  BUILTIN_RENDER_SCHEMES,
  createRenderScheme,
  normalizeRenderScheme,
  type RenderScheme
} from '../shared/renderScheme';
import { hdriExtensionOf, type HdriTexture } from '../shared/hdri';

export interface MapStoreOptions {
  rootDir?: string;
}

export interface CreateMapInput {
  name?: string;
  size?: Vec3;
  assetGenerationMode?: ModelGenerationMode;
}

export interface GenerateAssetInput {
  name?: string;
  prompt: string;
  modelJson: unknown;
  colliderPlan?: MapAsset['colliderPlan'];
  tags?: string[];
  mode?: string;
  provider?: string;
}

interface UndoTransaction {
  summary: MapTransactionSummary;
  map: EditableMap;
}

export class MapStore {
  readonly rootDir: string;
  private readonly mapsDir: string;
  private readonly assetsDir: string;
  private readonly historyDir: string;
  private readonly renderSchemesDir: string;
  private readonly hdriDir: string;
  // ponytail: one global queue is enough for local single-user editing; split per map only if concurrency becomes measurable.
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(options: MapStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.WORLDFORGE_DATA_DIR ?? path.join(process.cwd(), 'data', 'map-editor');
    this.mapsDir = path.join(this.rootDir, 'maps');
    this.assetsDir = path.join(this.rootDir, 'assets');
    this.historyDir = path.join(this.rootDir, 'history');
    this.renderSchemesDir = path.join(this.rootDir, 'render-schemes');
    this.hdriDir = path.join(this.rootDir, 'hdri');
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.mapsDir, { recursive: true });
    await mkdir(this.assetsDir, { recursive: true });
    await mkdir(this.historyDir, { recursive: true });
    await mkdir(this.renderSchemesDir, { recursive: true });
    await mkdir(this.hdriDir, { recursive: true });
  }

  async listMapSummaries(): Promise<MapSummary[]> {
    await this.ensureReady();
    const files = await readdir(this.mapsDir).catch(() => []);
    const maps = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      const map = await this.readMapFile(path.basename(file, '.json')).catch(() => null);
      return map ? mapToSummary(map) : null;
    }));
    return maps.filter((map): map is MapSummary => Boolean(map)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listMaps(): Promise<EditableMap[]> {
    const summaries = await this.listMapSummaries();
    const maps = await Promise.all(summaries.map((summary) => this.loadMap(summary.id)));
    return maps.filter((map): map is EditableMap => Boolean(map));
  }

  async loadMap(id: string): Promise<EditableMap> {
    const map = await this.readMapFile(id);
    return this.hydrateMap(map);
  }

  async createMap(input: CreateMapInput = {}): Promise<EditableMap> {
    const fallback = createEmptyMap(input.name ?? '未命名地图');
    const size = input.size ? sanitizeVec3(input.size, fallback.box.size) : fallback.box.size;
    const map = createEmptyMap(
      input.name ?? '未命名地图',
      undefined,
      size,
      normalizeModelGenerationMode(input.assetGenerationMode)
    );
    return this.saveMap(map);
  }

  async saveMap(map: EditableMap): Promise<EditableMap> {
    await this.ensureReady();
    const normalized = normalizeMap({
      ...map,
      assets: undefined,
      updatedAt: Date.now(),
      version: Math.max(1, map.version + 1)
    });
    const hydrated = await this.hydrateMap(normalized);
    const persisted = normalizeMap({ ...hydrated, assets: undefined });
    const destination = this.mapPath(persisted.id);
    await atomicWriteJson(destination, persisted);
    await rm(this.undoPath(persisted.id), { force: true });
    return hydrated;
  }

  async replaceMap(id: string, map: EditableMap): Promise<EditableMap> {
    const existing = await this.loadMap(id);
    return this.saveMap({
      ...map,
      id: existing.id,
      createdAt: existing.createdAt,
      version: existing.version
    });
  }

  async deleteMap(id: string): Promise<void> {
    await rm(this.mapPath(id), { force: true });
    await rm(this.undoPath(id), { force: true });
  }

  async getUndoTransaction(mapId: string): Promise<MapTransactionSummary | null> {
    return (await this.readUndoTransaction(mapId))?.summary ?? null;
  }

  async commitTransaction(
    mapId: string,
    request: MapTransactionRequest
  ): Promise<{ map: EditableMap; transaction: MapTransactionSummary }> {
    return this.withTransactionLock(async () => {
      const before = await this.loadMap(mapId);
      await this.requireCompatibleOperationAssets(before, request.operations);
      const next = applyMapOperations(before, request.operations);
      const map = await this.replaceMap(mapId, next);
      const transaction: MapTransactionSummary = {
        id: createId('tx'),
        label: cleanLabel(request.label),
        source: request.source,
        operationCount: request.operations.length,
        createdAt: Date.now()
      };
      await atomicWriteJson(this.undoPath(mapId), {
        summary: transaction,
        map: normalizeMap({ ...before, assets: undefined })
      });
      return { map, transaction };
    });
  }

  async undoTransaction(mapId: string): Promise<{ map: EditableMap; transaction: MapTransactionSummary }> {
    return this.withTransactionLock(async () => {
      const undo = await this.readUndoTransaction(mapId);
      if (!undo) throw new Error('nothing_to_undo');
      const map = await this.replaceMap(mapId, undo.map);
      return { map, transaction: undo.summary };
    });
  }

  async updateMapBox(id: string, patch: { size?: Vec3; colors?: Partial<MapBoxColors> }): Promise<EditableMap> {
    const map = await this.loadMap(id);
    if (patch.size) map.box.size = sanitizeVec3(patch.size, map.box.size);
    if (patch.colors) map.box.colors = { ...map.box.colors, ...patch.colors };
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async setSpawnPoint(id: string, point: Vec3): Promise<EditableMap> {
    const map = await this.loadMap(id);
    map.spawnPoints = [sanitizeVec3(point, map.spawnPoints[0] ?? [0, 0, 0])];
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async setSunPosition(id: string, point: Vec3): Promise<EditableMap> {
    const map = await this.loadMap(id);
    map.lighting.sunPosition = sanitizeVec3(point, map.lighting.sunPosition);
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async addObject(mapId: string, input: Partial<MapObject>): Promise<EditableMap> {
    const map = await this.loadMap(mapId);
    await this.requireCompatibleAsset(map, input.assetId ?? null);
    const object = {
      ...createMapObject(input.name, input.assetId ?? null),
      ...input,
      id: input.id ?? createId('obj'),
      parentId: input.parentId ?? null,
      assetId: input.assetId ?? null,
      visible: input.visible !== false,
      locked: input.locked === true
    };
    map.objects.push(object);
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async patchObject(mapId: string, objectId: string, patch: Omit<Partial<MapObject>, 'transform'> & { transform?: Partial<Transform3D> }): Promise<EditableMap> {
    const map = await this.loadMap(mapId);
    if ('assetId' in patch) await this.requireCompatibleAsset(map, patch.assetId ?? null);
    const object = map.objects.find((item) => item.id === objectId);
    if (!object) throw new Error('object_not_found');
    if (typeof patch.name === 'string') object.name = patch.name;
    if ('parentId' in patch) object.parentId = patch.parentId ?? null;
    if ('assetId' in patch) object.assetId = patch.assetId ?? null;
    if (typeof patch.visible === 'boolean') object.visible = patch.visible;
    if (typeof patch.locked === 'boolean') object.locked = patch.locked;
    if (patch.transform) {
      object.transform = {
        position: patch.transform.position ? sanitizeVec3(patch.transform.position, object.transform.position) : object.transform.position,
        rotation: patch.transform.rotation ? sanitizeVec3(patch.transform.rotation, object.transform.rotation) : object.transform.rotation,
        scale: patch.transform.scale ? sanitizePositiveVec3(patch.transform.scale, object.transform.scale) : object.transform.scale,
        size: patch.transform.size ? sanitizePositiveVec3(patch.transform.size, object.transform.size) : object.transform.size
      };
    }
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async deleteObject(mapId: string, objectId: string): Promise<EditableMap> {
    const map = await this.loadMap(mapId);
    map.objects = map.objects
      .filter((object) => object.id !== objectId)
      .map((object) => object.parentId === objectId ? { ...object, parentId: null } : object);
    map.confirmedAt = null;
    return this.saveMap(map);
  }

  async addPaint(mapId: string, stroke: Partial<MapPaintStroke> & Pick<MapPaintStroke, 'surface' | 'point'>): Promise<EditableMap> {
    const map = await this.loadMap(mapId);
    return this.saveMap({ ...addPaintStroke(map, stroke), confirmedAt: null });
  }

  async applyTerrain(mapId: string, mode: TerrainBrushMode, point: Vec3, size: number, strength: number, targetHeight?: number): Promise<EditableMap> {
    const map = await this.loadMap(mapId);
    return this.saveMap({ ...applyTerrainBrush(map, mode, point, size, strength, targetHeight), confirmedAt: null });
  }

  private async withTransactionLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.transactionQueue;
    let release = () => {};
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async requireCompatibleOperationAssets(map: EditableMap, operations: readonly MapOperation[]): Promise<void> {
    const ids = new Set<string>();
    for (const operation of operations) {
      if (operation.type === 'object.add' && operation.object.assetId) ids.add(operation.object.assetId);
      if (operation.type === 'object.update' && operation.patch.assetId) ids.add(operation.patch.assetId);
    }
    await Promise.all([...ids].map((id) => this.requireCompatibleAsset(map, id)));
  }

  private async requireCompatibleAsset(map: EditableMap, assetId: string | null): Promise<void> {
    if (!assetId) return;
    const asset = await this.loadAsset(assetId).catch(() => null);
    if (!asset) throw new Error('unknown_map_asset');
    if (asset.mode !== map.assetGenerationMode) throw new Error('map_asset_mode_mismatch');
  }

  async listAssets(): Promise<MapAsset[]> {
    await this.ensureReady();
    const files = await readdir(this.assetsDir).catch(() => []);
    const assets = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      try {
        return await this.loadAsset(path.basename(file, '.json'));
      } catch {
        return null;
      }
    }));
    return assets.filter((asset): asset is MapAsset => Boolean(asset)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadAsset(id: string): Promise<MapAsset> {
    const text = await readFile(this.assetPath(id), 'utf8');
    return normalizeAsset(JSON.parse(text) as Partial<MapAsset>);
  }

  async saveAsset(input: GenerateAssetInput): Promise<MapAsset> {
    await this.ensureReady();
    const now = Date.now();
    const asset = normalizeAsset({
      id: createId('asset'),
      name: input.name || input.prompt.slice(0, 42) || '未命名资产',
      prompt: input.prompt,
      tags: input.tags,
      modelJson: input.modelJson,
      colliderPlan: input.colliderPlan,
      mode: input.mode ?? 'voxel',
      provider: input.provider,
      createdAt: now,
      updatedAt: now
    });
    await writeFile(this.assetPath(asset.id), `${JSON.stringify(asset, null, 2)}\n`, 'utf8');
    return asset;
  }

  async deleteAsset(id: string): Promise<void> {
    await rm(this.assetPath(id), { force: true });
  }

  async migrateAssetColliderPlans(): Promise<{ scanned: number; updated: number }> {
    await this.ensureReady();
    const files = (await readdir(this.assetsDir).catch(() => [])).filter((file) => file.endsWith('.json'));
    let updated = 0;
    for (const file of files) {
      const filePath = path.join(this.assetsDir, file);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<MapAsset>;
      const asset = normalizeAsset(raw);
      if (JSON.stringify(raw.colliderPlan ?? null) === JSON.stringify(asset.colliderPlan)) continue;
      await writeFile(filePath, `${JSON.stringify(asset, null, 2)}\n`, 'utf8');
      updated += 1;
    }
    return { scanned: files.length, updated };
  }

  async migrateMapCollisionBakes(): Promise<{ scanned: number; updated: number }> {
    await this.ensureReady();
    const files = (await readdir(this.mapsDir).catch(() => [])).filter((file) => file.endsWith('.json'));
    let updated = 0;
    for (const file of files) {
      const filePath = path.join(this.mapsDir, file);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<EditableMap>;
      const hydrated = await this.hydrateMap(normalizeMap(raw));
      if (JSON.stringify(raw.collisionBake ?? null) === JSON.stringify(hydrated.collisionBake ?? null)) continue;
      const persisted = normalizeMap({ ...hydrated, assets: undefined });
      await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      updated += 1;
    }
    return { scanned: files.length, updated };
  }

  async listRenderSchemes(): Promise<RenderScheme[]> {
    await this.ensureReady();
    const files = await readdir(this.renderSchemesDir).catch(() => []);
    const custom = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      return this.loadRenderScheme(path.basename(file, '.json')).catch(() => null);
    }));
    return [
      ...BUILTIN_RENDER_SCHEMES.map((scheme) => normalizeRenderScheme(scheme)),
      ...custom.filter((scheme): scheme is RenderScheme => Boolean(scheme))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    ];
  }

  async loadRenderScheme(id: string): Promise<RenderScheme> {
    const builtin = BUILTIN_RENDER_SCHEMES.find((scheme) => scheme.id === id);
    if (builtin) return normalizeRenderScheme(builtin);
    const text = await readFile(this.renderSchemePath(id), 'utf8');
    return normalizeRenderScheme(JSON.parse(text) as Partial<RenderScheme>);
  }

  async saveRenderScheme(input: Partial<RenderScheme>): Promise<RenderScheme> {
    await this.ensureReady();
    const scheme = createRenderScheme(input);
    await atomicWriteJson(this.renderSchemePath(scheme.id), scheme);
    return scheme;
  }

  async deleteRenderScheme(id: string): Promise<void> {
    if (BUILTIN_RENDER_SCHEMES.some((scheme) => scheme.id === id)) throw new Error('builtin_scheme_readonly');
    await rm(this.renderSchemePath(id), { force: true });
  }

  /**
   * Lists the panoramas dropped into `<data>/hdri`. There is no upload path —
   * the directory is the library, so adding a sky is a file copy.
   */
  async listHdriTextures(): Promise<HdriTexture[]> {
    await this.ensureReady();
    const files = await readdir(this.hdriDir).catch(() => []);
    const textures = await Promise.all(files.map(async (file) => {
      const extension = hdriExtensionOf(file);
      if (!extension) return null;
      const info = await stat(path.join(this.hdriDir, file)).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        id: path.basename(file, path.extname(file)),
        file,
        extension,
        bytes: info.size
      } satisfies HdriTexture;
    }));
    return textures
      .filter((texture): texture is HdriTexture => Boolean(texture))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Resolves a listed panorama to its absolute path, or null when unknown. */
  async resolveHdriFile(file: string): Promise<string | null> {
    const textures = await this.listHdriTextures();
    return textures.some((texture) => texture.file === file)
      ? path.join(this.hdriDir, file)
      : null;
  }

  async hydrateMap(map: EditableMap): Promise<EditableMap> {
    const normalized = normalizeMap(map);
    const ids = [...new Set(normalized.objects.map((object) => object.assetId).filter((id): id is string => Boolean(id)))];
    const assets = await Promise.all(ids.map(async (id) => this.loadAsset(id).catch(() => null)));
    const hydrated: EditableMap = {
      ...normalized,
      assets: assets.filter((asset): asset is MapAsset => Boolean(asset))
    };
    return { ...hydrated, collisionBake: getMapCollisionBake(hydrated) };
  }

  private async readMapFile(id: string): Promise<EditableMap> {
    const text = await readFile(this.mapPath(id), 'utf8');
    return normalizeMap(JSON.parse(text) as Partial<EditableMap>);
  }

  private mapPath(id: string): string {
    return path.join(this.mapsDir, `${safeId(id)}.json`);
  }

  private assetPath(id: string): string {
    return path.join(this.assetsDir, `${safeId(id)}.json`);
  }

  private renderSchemePath(id: string): string {
    return path.join(this.renderSchemesDir, `${safeId(id)}.json`);
  }

  private undoPath(id: string): string {
    return path.join(this.historyDir, `${safeId(id)}.json`);
  }

  private async readUndoTransaction(id: string): Promise<UndoTransaction | null> {
    try {
      const text = await readFile(this.undoPath(id), 'utf8');
      const input = JSON.parse(text) as Partial<UndoTransaction>;
      if (!input.summary || !input.map) return null;
      return {
        summary: input.summary as MapTransactionSummary,
        map: normalizeMap(input.map)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export function mapEditorCliManifest(): Record<string, string> {
  return {
    list: '列出服务端地图',
    create: '创建地图：--name --width --height --depth',
    show: '输出完整地图 JSON：--map',
    applyTransaction: '原子应用操作文件：--map --file --source agent|basic-ai --label',
    undoTransaction: '撤销地图最近一次事务：--map',
    setBox: '调整地图盒子：--map --width --height --depth --floor --ceiling --north --south --east --west',
    spawn: '设置玩家出生点：--map --x --y --z',
    sun: '设置太阳位置：--map --x --y --z',
    addObject: '新增物体：--map --name --asset --parent --x --y --z',
    transformObject: '调整物体 transform：--map --object --x --y --z --rx --ry --rz --sx --sy --sz --w --h --d',
    bindAsset: '绑定资产：--map --object --asset',
    paint: '绘制表面：--map --surface --x --y --z --u --v --color --size --softness',
    terrain: '调整地形：--map --mode raise|lower|flatten --x --z --size --strength --height',
    listAssets: '列出服务端资产',
    generateAsset: '生成资产：--prompt --name --mode',
    listRenderSchemes: '列出可复用渲染方案'
  };
}

function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) throw new Error('bad_id');
  return cleaned;
}

function sanitizeVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2])
  ];
}

function sanitizePositiveVec3(value: unknown, fallback: Vec3): Vec3 {
  const vector = sanitizeVec3(value, fallback);
  return [
    vector[0] > 0 ? vector[0] : fallback[0],
    vector[1] > 0 ? vector[1] : fallback[1],
    vector[2] > 0 ? vector[2] : fallback[2]
  ];
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function cleanLabel(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 80)
    : '地图事务';
}

async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${createId('tmp')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizeAsset(input: Partial<MapAsset>): MapAsset {
  const now = Date.now();
  const colliderPlan = normalizeModelColliderPlan(input.colliderPlan, input.modelJson, MAP_ASSET_COLLIDER_PROFILE);
  const footprintRadius = Number.isFinite(Number(input.footprintRadius))
    ? Math.max(0.1, Number(input.footprintRadius))
    : assetFootprintRadius(colliderPlan);
  return {
    id: typeof input.id === 'string' && input.id ? input.id : createId('asset'),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 48) : '未命名资产',
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    tags: normalizeAssetTags(input.tags),
    modelJson: input.modelJson ?? null,
    colliderPlan,
    footprintRadius,
    sizeClass: input.sizeClass === 'small' || input.sizeClass === 'medium' || input.sizeClass === 'large'
      ? input.sizeClass
      : assetSizeClass(footprintRadius),
    mode: typeof input.mode === 'string' && input.mode ? input.mode : 'voxel',
    provider: typeof input.provider === 'string' && input.provider ? input.provider : undefined,
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}
