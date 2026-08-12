import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
  normalizeMapSceneMode,
  type EditableMap,
  type MapAsset,
  type MapBoxColors,
  type MapObject,
  type MapPaintStroke,
  type MapSummary,
  type MapSceneMode,
  type WorldScaleProfile,
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
import { prepareStructuredWaterInPlace } from '../shared/mapWater';

import { MAP_ASSET_COLLIDER_PROFILE, normalizeModelColliderPlan } from '../shared/modelBounds';
import { assetFootprintRadius, assetSizeClass, normalizeAssetTags } from '../shared/mapAssetMetadata';
import {
  BUILTIN_RENDER_SCHEMES,
  createRenderScheme,
  normalizeRenderScheme,
  type RenderScheme
} from '../shared/renderScheme';
import { HDRI_CATALOG_FILE, hdriExtensionOf, parseHdriCatalog, type HdriTexture } from '../shared/hdri';
import {
  normalizeAssetLibrary,
  normalizeAssetLibraryMetadata,
  normalizeAssetLibraryPack,
  type AssetLibrary,
  type AssetLibraryMetadata,
  type AssetLibraryPack
} from '../shared/assetLibrary';

export interface MapStoreOptions {
  rootDir?: string;
  /** Read-only, Git LFS-managed panoramas shipped with this checkout. */
  sharedHdriDir?: string;
  /** Golden maps/assets copied only when a new data directory is empty. */
  starterDataDir?: string | null;
}

export interface CreateMapInput {
  name?: string;
  size?: Vec3;
  sceneMode?: MapSceneMode;
  roomSize?: Vec3;
  assetGenerationMode?: ModelGenerationMode;
  playerHeight?: number;
  worldScaleProfile?: WorldScaleProfile;
}

export interface GenerateAssetInput {
  name?: string;
  prompt: string;
  modelJson: unknown;
  colliderPlan?: MapAsset['colliderPlan'];
  tags?: string[];
  mode?: string;
  provider?: string;
  libraryId?: string;
  libraryMetadata?: Partial<AssetLibraryMetadata>;
}

interface UndoTransaction {
  summary: MapTransactionSummary;
  map: EditableMap;
}

export class MapStore {
  readonly rootDir: string;
  private readonly mapsDir: string;
  private readonly assetsDir: string;
  private readonly assetLibrariesDir: string;
  private readonly historyDir: string;
  private readonly renderSchemesDir: string;
  private readonly hdriDir: string;
  private readonly sharedHdriDir: string;
  private readonly starterDataDir: string | null;
  private readonly starterSeedPath: string;
  // ponytail: one global queue is enough for local single-user editing; split per map only if concurrency becomes measurable.
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(options: MapStoreOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.WORLDFORGE_DATA_DIR ?? path.join(process.cwd(), 'data', 'map-editor');
    this.mapsDir = path.join(this.rootDir, 'maps');
    this.assetsDir = path.join(this.rootDir, 'assets');
    this.assetLibrariesDir = path.join(this.rootDir, 'asset-libraries');
    this.historyDir = path.join(this.rootDir, 'history');
    this.renderSchemesDir = path.join(this.rootDir, 'render-schemes');
    this.hdriDir = path.join(this.rootDir, 'hdri');
    this.sharedHdriDir = options.sharedHdriDir ?? path.join(process.cwd(), 'assets', 'hdri');
    this.starterDataDir = options.starterDataDir === undefined
      ? (options.rootDir ? null : path.join(process.cwd(), 'assets', 'starter-data'))
      : options.starterDataDir;
    this.starterSeedPath = path.join(this.rootDir, '.starter-seed.json');
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.mapsDir, { recursive: true });
    await mkdir(this.assetsDir, { recursive: true });
    await mkdir(this.assetLibrariesDir, { recursive: true });
    await mkdir(this.historyDir, { recursive: true });
    await mkdir(this.renderSchemesDir, { recursive: true });
    await mkdir(this.hdriDir, { recursive: true });
    await this.seedStarterDataIfEmpty();
  }

  private async seedStarterDataIfEmpty(): Promise<void> {
    if (!this.starterDataDir) return;
    if (await readFile(this.starterSeedPath).catch(() => null)) return;
    const [maps, assets, schemes] = await Promise.all([
      readdir(this.mapsDir).catch(() => []),
      readdir(this.assetsDir).catch(() => []),
      readdir(this.renderSchemesDir).catch(() => [])
    ]);
    if ([...maps, ...assets, ...schemes].some((file) => file.endsWith('.json'))) {
      await atomicWriteJson(this.starterSeedPath, { status: 'existing-data', createdAt: Date.now() });
      return;
    }
    const manifest = await readFile(path.join(this.starterDataDir, 'manifest.json')).catch(() => null);
    if (!manifest) return;

    for (const directory of ['maps', 'assets', 'render-schemes']) {
      const source = path.join(this.starterDataDir, directory);
      const target = path.join(this.rootDir, directory);
      const files = await readdir(source).catch(() => []);
      await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => copyFile(
        path.join(source, file),
        path.join(target, file),
        fsConstants.COPYFILE_EXCL
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      })));
    }
    await atomicWriteJson(this.starterSeedPath, { status: 'seeded', createdAt: Date.now() });
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
      normalizeModelGenerationMode(input.assetGenerationMode),
      normalizeMapSceneMode(input.sceneMode),
      input.roomSize ? sanitizeVec3(input.roomSize, [10, 3, 8]) : undefined,
      input.playerHeight,
      input.worldScaleProfile
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
    await rm(this.redoPath(persisted.id), { force: true });
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
    await rm(this.redoPath(id), { force: true });
  }

  async getUndoTransaction(mapId: string): Promise<MapTransactionSummary | null> {
    return (await this.readUndoTransaction(mapId))?.summary ?? null;
  }

  async getRedoTransaction(mapId: string): Promise<MapTransactionSummary | null> {
    return (await this.readTransactionSnapshot(this.redoPath(mapId)))?.summary ?? null;
  }

  async commitTransaction(
    mapId: string,
    request: MapTransactionRequest
  ): Promise<{ map: EditableMap; transaction: MapTransactionSummary }> {
    return this.withTransactionLock(async () => {
      const before = await this.loadMap(mapId);
      await this.requireOperationAssets(request.operations);
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
      const current = await this.loadMap(mapId);
      const map = await this.replaceMap(mapId, undo.map);
      await atomicWriteJson(this.redoPath(mapId), {
        summary: undo.summary,
        map: normalizeMap({ ...current, assets: undefined })
      });
      return { map, transaction: undo.summary };
    });
  }

  async redoTransaction(mapId: string): Promise<{ map: EditableMap; transaction: MapTransactionSummary }> {
    return this.withTransactionLock(async () => {
      const redo = await this.readTransactionSnapshot(this.redoPath(mapId));
      if (!redo) throw new Error('nothing_to_redo');
      const current = await this.loadMap(mapId);
      const map = await this.replaceMap(mapId, redo.map);
      await atomicWriteJson(this.undoPath(mapId), {
        summary: redo.summary,
        map: normalizeMap({ ...current, assets: undefined })
      });
      return { map, transaction: redo.summary };
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
    await this.requireKnownAsset(input.assetId ?? null);
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
    if ('assetId' in patch) await this.requireKnownAsset(patch.assetId ?? null);
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

  private async requireOperationAssets(operations: readonly MapOperation[]): Promise<void> {
    const ids = new Set<string>();
    for (const operation of operations) {
      if (operation.type === 'object.add' && operation.object.assetId) ids.add(operation.object.assetId);
      if (operation.type === 'object.update' && operation.patch.assetId) ids.add(operation.patch.assetId);
    }
    await Promise.all([...ids].map((id) => this.requireKnownAsset(id)));
  }

  private async requireKnownAsset(assetId: string | null): Promise<void> {
    if (!assetId) return;
    const asset = await this.loadAsset(assetId).catch(() => null);
    if (!asset) throw new Error('unknown_map_asset');
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
    return assets
      .filter((asset): asset is MapAsset => asset !== null && !asset.libraryId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
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
      libraryId: input.libraryId,
      libraryMetadata: input.libraryId
        ? normalizeAssetLibraryMetadata(input.libraryMetadata, input.tags)
        : undefined,
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

  async updateRenderScheme(id: string, input: Partial<RenderScheme>): Promise<RenderScheme> {
    await this.ensureReady();
    if (BUILTIN_RENDER_SCHEMES.some((scheme) => scheme.id === id)) throw new Error('builtin_scheme_readonly');
    const current = await this.loadRenderScheme(id);
    const scheme = normalizeRenderScheme({
      ...current,
      ...input,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.renderSchemePath(id), scheme);
    return scheme;
  }

  async deleteRenderScheme(id: string): Promise<void> {
    if (BUILTIN_RENDER_SCHEMES.some((scheme) => scheme.id === id)) throw new Error('builtin_scheme_readonly');
    const scheme = await this.loadRenderScheme(id);
    if (scheme.kind === 'builtin') throw new Error('builtin_scheme_readonly');
    const fallbackId = BUILTIN_RENDER_SCHEMES[0]?.id ?? null;
    const maps = await this.listMaps();
    for (const map of maps) {
      if (map.renderSchemeId !== id) continue;
      await atomicWriteJson(this.mapPath(map.id), normalizeMap({
        ...map,
        assets: undefined,
        renderSchemeId: fallbackId,
        updatedAt: Date.now(),
        version: map.version + 1
      }));
    }
    await rm(this.renderSchemePath(id), { force: true });
  }

  async listAssetLibraries(): Promise<AssetLibrary[]> {
    await this.ensureReady();
    const files = await readdir(this.assetLibrariesDir).catch(() => []);
    const libraries = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => (
      this.loadAssetLibrary(path.basename(file, '.json')).catch(() => null)
    )));
    return libraries
      .filter((library): library is AssetLibrary => Boolean(library))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async loadAssetLibrary(id: string): Promise<AssetLibrary> {
    const text = await readFile(this.assetLibraryPath(id), 'utf8');
    return normalizeAssetLibrary(JSON.parse(text) as Partial<AssetLibrary>);
  }

  async createAssetLibrary(input: { name?: string; description?: string }): Promise<AssetLibrary> {
    await this.ensureReady();
    const now = Date.now();
    const library = normalizeAssetLibrary({
      id: createId('library'),
      name: input.name,
      description: input.description,
      assetIds: [],
      createdAt: now,
      updatedAt: now
    });
    await atomicWriteJson(this.assetLibraryPath(library.id), library);
    return library;
  }

  async updateAssetLibrary(id: string, input: { name?: string; description?: string }): Promise<AssetLibrary> {
    const current = await this.loadAssetLibrary(id);
    const library = normalizeAssetLibrary({
      ...current,
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.assetLibraryPath(library.id), library);
    return library;
  }

  async deleteAssetLibrary(id: string): Promise<void> {
    await this.loadAssetLibrary(id);
    await rm(this.assetLibraryPath(id), { force: true });
    // ponytail: keep detached snapshots because existing maps may still reference them.
  }

  async listAssetLibraryAssets(id: string): Promise<MapAsset[]> {
    const library = await this.loadAssetLibrary(id);
    const assets = await Promise.all(library.assetIds.map((assetId) => this.loadAsset(assetId).catch(() => null)));
    return assets.filter((asset): asset is MapAsset => Boolean(asset));
  }

  async addAssetLibrarySnapshot(
    libraryId: string,
    source: MapAsset,
    metadata: Partial<AssetLibraryMetadata>
  ): Promise<{ library: AssetLibrary; asset: MapAsset }> {
    const library = await this.loadAssetLibrary(libraryId);
    const asset = await this.saveAsset({
      name: source.name,
      prompt: source.prompt,
      tags: source.tags,
      modelJson: source.modelJson,
      colliderPlan: source.colliderPlan,
      mode: source.mode,
      provider: source.provider,
      libraryId,
      libraryMetadata: metadata
    });
    const updatedLibrary = normalizeAssetLibrary({
      ...library,
      assetIds: [...library.assetIds, asset.id],
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.assetLibraryPath(library.id), updatedLibrary);
    return { library: updatedLibrary, asset };
  }

  async addImportedAssetLibrarySnapshot(
    libraryId: string,
    input: GenerateAssetInput,
    metadata: Partial<AssetLibraryMetadata>
  ): Promise<{ library: AssetLibrary; asset: MapAsset }> {
    const library = await this.loadAssetLibrary(libraryId);
    const asset = await this.saveAsset({ ...input, libraryId, libraryMetadata: metadata });
    const updatedLibrary = normalizeAssetLibrary({
      ...library,
      assetIds: [...library.assetIds, asset.id],
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.assetLibraryPath(library.id), updatedLibrary);
    return { library: updatedLibrary, asset };
  }

  async updateAssetLibraryEntry(
    libraryId: string,
    assetId: string,
    input: { name?: string; prompt?: string; metadata?: Partial<AssetLibraryMetadata> }
  ): Promise<MapAsset> {
    const library = await this.loadAssetLibrary(libraryId);
    if (!library.assetIds.includes(assetId)) throw new Error('asset_not_in_library');
    const current = await this.loadAsset(assetId);
    const asset = normalizeAsset({
      ...current,
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
      libraryId,
      libraryMetadata: normalizeAssetLibraryMetadata(
        { ...current.libraryMetadata, ...input.metadata },
        current.tags
      ),
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.assetPath(asset.id), asset);
    return asset;
  }

  async removeAssetLibraryEntry(libraryId: string, assetId: string): Promise<AssetLibrary> {
    const library = await this.loadAssetLibrary(libraryId);
    if (!library.assetIds.includes(assetId)) throw new Error('asset_not_in_library');
    const updated = normalizeAssetLibrary({
      ...library,
      assetIds: library.assetIds.filter((id) => id !== assetId),
      updatedAt: Date.now()
    });
    await atomicWriteJson(this.assetLibraryPath(library.id), updated);
    return updated;
  }

  async exportAssetLibrary(id: string): Promise<AssetLibraryPack> {
    const library = await this.loadAssetLibrary(id);
    return {
      kind: 'worldforge-asset-library',
      version: 1,
      library,
      assets: await this.listAssetLibraryAssets(id)
    };
  }

  async importAssetLibrary(input: unknown): Promise<{ library: AssetLibrary; assets: MapAsset[] }> {
    await this.ensureReady();
    const pack = normalizeAssetLibraryPack(input);
    const now = Date.now();
    const library = normalizeAssetLibrary({
      ...pack.library,
      id: createId('library'),
      name: `${pack.library.name}（导入）`,
      assetIds: [],
      createdAt: now,
      updatedAt: now
    });
    const importedAssets: MapAsset[] = [];
    for (const raw of pack.assets.filter((asset) => pack.library.assetIds.includes(asset.id))) {
      const source = normalizeAsset(raw);
      const imported = normalizeAsset({
        ...source,
        id: createId('asset'),
        libraryId: library.id,
        createdAt: now,
        updatedAt: now
      });
      await atomicWriteJson(this.assetPath(imported.id), imported);
      importedAssets.push(imported);
    }
    const completed = normalizeAssetLibrary({
      ...library,
      assetIds: importedAssets.map((asset) => asset.id)
    });
    await atomicWriteJson(this.assetLibraryPath(completed.id), completed);
    return { library: completed, assets: importedAssets };
  }

  /**
   * Lists the panoramas dropped into `<data>/hdri`. There is no upload path —
   * the directory is the library, so adding a sky is a file copy.
   */
  async listHdriTextures(): Promise<HdriTexture[]> {
    await this.ensureReady();
    const [sharedFiles, localFiles, sharedCatalog, localCatalog] = await Promise.all([
      readdir(this.sharedHdriDir).catch(() => []),
      readdir(this.hdriDir).catch(() => []),
      readHdriCatalog(path.join(this.sharedHdriDir, HDRI_CATALOG_FILE)),
      readHdriCatalog(path.join(this.hdriDir, HDRI_CATALOG_FILE))
    ]);
    // Local imports deliberately win over shipped files with the same name.
    const sources = new Map<string, string>();
    for (const file of sharedFiles) sources.set(file, this.sharedHdriDir);
    for (const file of localFiles) sources.set(file, this.hdriDir);
    const textures = await Promise.all([...sources].map(async ([file, source]) => {
      const extension = hdriExtensionOf(file);
      if (!extension) return null;
      const info = await stat(path.join(source, file)).catch(() => null);
      if (!info?.isFile()) return null;
      const metadata = localCatalog.get(file) ?? sharedCatalog.get(file);
      return {
        id: path.basename(file, path.extname(file)),
        file,
        extension,
        bytes: info.size,
        tags: metadata?.tags ?? [],
        ...(metadata?.skyColor ? { skyColor: metadata.skyColor } : {}),
        ...(metadata?.groundColor ? { groundColor: metadata.groundColor } : {})
      } satisfies HdriTexture;
    }));
    return textures
      .filter((texture): texture is HdriTexture => Boolean(texture))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Resolves a listed panorama to its absolute path, or null when unknown. */
  async resolveHdriFile(file: string): Promise<string | null> {
    const textures = await this.listHdriTextures();
    if (!textures.some((texture) => texture.file === file)) return null;
    const localPath = path.join(this.hdriDir, file);
    const local = await stat(localPath).catch(() => null);
    if (local?.isFile()) return localPath;
    const sharedPath = path.join(this.sharedHdriDir, file);
    const shared = await stat(sharedPath).catch(() => null);
    return shared?.isFile() ? sharedPath : null;
  }

  async hydrateMap(map: EditableMap): Promise<EditableMap> {
    const normalized = normalizeMap(map);
    prepareStructuredWaterInPlace(normalized);
    const ids = [...new Set(normalized.objects.map((object) => object.assetId).filter((id): id is string => Boolean(id)))];
    const assets = await Promise.all(ids.map(async (id) => this.loadAsset(id).catch(() => null)));
    const hydrated: EditableMap = {
      ...normalized,
      assets: assets.filter((asset): asset is MapAsset => Boolean(asset))
    };
    return { ...hydrated, collisionBake: getMapCollisionBake(hydrated) };
  }

  async updateHdriClassification(
    file: string,
    input: { timeOfDay?: string; temperature?: string }
  ): Promise<HdriTexture> {
    const textures = await this.listHdriTextures();
    const selected = textures.find((texture) => texture.file === file);
    if (!selected) throw new Error('unknown_hdri_texture');
    const timeOfDay = ['morning', 'day', 'evening'].includes(input.timeOfDay ?? '') ? input.timeOfDay! : '';
    const temperature = ['cool', 'warm'].includes(input.temperature ?? '') ? input.temperature! : '';
    const categoryTags = new Set(['morning', 'day', 'evening', 'cool', 'warm']);
    const tags = selected.tags.filter((tag) => !categoryTags.has(tag));
    if (timeOfDay) tags.push(timeOfDay);
    if (temperature) tags.push(temperature);
    const entries = textures.map((texture) => ({
      file: texture.file,
      tags: texture.file === file ? tags : texture.tags,
      ...(texture.skyColor ? { skyColor: texture.skyColor } : {}),
      ...(texture.groundColor ? { groundColor: texture.groundColor } : {})
    }));
    await atomicWriteJson(path.join(this.hdriDir, HDRI_CATALOG_FILE), { version: 1, textures: entries });
    return { ...selected, tags };
  }

  /** Imports a portable map as a new project and remaps embedded assets. */
  async importMap(input: EditableMap, renderSchemeId: string | null = null): Promise<EditableMap> {
    await this.ensureReady();
    const source = normalizeMap(input);
    const now = Date.now();
    const embeddedAssetIds = new Set((source.assets ?? []).map((asset) => asset.id));
    if (source.objects.some((object) => object.assetId && !embeddedAssetIds.has(object.assetId))) {
      throw new Error('import_missing_embedded_asset');
    }
    const assetIds = new Map<string, string>();
    for (const rawAsset of source.assets ?? []) {
      const asset = normalizeAsset(rawAsset);
      const imported = {
        ...asset,
        id: createId('asset'),
        createdAt: now,
        updatedAt: now
      };
      await atomicWriteJson(this.assetPath(imported.id), imported);
      assetIds.set(asset.id, imported.id);
    }
    const objects = source.objects.map((object) => ({
      ...object,
      assetId: object.assetId ? assetIds.get(object.assetId) ?? null : null
    }));
    const imported = normalizeMap({
      ...source,
      id: createId('map'),
      name: `${source.name}（导入）`,
      version: 1,
      createdAt: now,
      updatedAt: now,
      renderSchemeId,
      objects,
      assets: undefined
    });
    await atomicWriteJson(this.mapPath(imported.id), imported);
    return this.hydrateMap(imported);
  }

  /** Adds a supported panorama from a portable scene package without overwriting a different file. */
  async importHdri(file: string, bytes: Uint8Array): Promise<string> {
    await this.ensureReady();
    const requested = path.basename(file);
    const extension = hdriExtensionOf(requested);
    if (!extension) throw new Error('import_hdri_requires_supported_format');
    let actual = requested;
    const existingPath = await this.resolveHdriFile(actual);
    const existing = existingPath ? await readFile(existingPath).catch(() => null) : null;
    if (existing && !existing.equals(Buffer.from(bytes))) {
      actual = `${path.basename(requested, path.extname(requested))}-import-${Date.now()}.${extension}`;
    }
    if (!existing || actual !== requested) await writeFile(path.join(this.hdriDir, actual), bytes);
    return actual;
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

  private assetLibraryPath(id: string): string {
    return path.join(this.assetLibrariesDir, `${safeId(id)}.json`);
  }

  private redoPath(id: string): string {
    return path.join(this.historyDir, `${safeId(id)}.redo.json`);
  }

  private async readUndoTransaction(id: string): Promise<UndoTransaction | null> {
    return this.readTransactionSnapshot(this.undoPath(id));
  }

  private async readTransactionSnapshot(file: string): Promise<UndoTransaction | null> {
    try {
      const text = await readFile(file, 'utf8');
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
    create: '创建地图：--name --scene outdoor|indoor|mixed --width --height --depth --room-width --room-height --room-depth',
    show: '输出完整地图 JSON：--map',
    applyTransaction: '原子应用操作文件：--map --file --source agent|basic-ai|manual --label',
    undoTransaction: '撤销地图最近一次事务：--map',
    redoTransaction: '重做地图最近一次撤销事务：--map',
    setBox: '调整地图盒子：--map --width --height --depth --floor --ceiling --north --south --east --west',
    spawn: '设置玩家出生点：--map --x --y --z',
    sun: '设置太阳位置：--map --x --y --z',
    addObject: '新增物体：--map --name --asset --parent --x --y --z',
    transformObject: '调整物体 transform：--map --object --x --y --z --rx --ry --rz --sx --sy --sz --w --h --d',
    bindAsset: '绑定资产：--map --object --asset',
    paint: '绘制表面：--map --surface --x --y --z --u --v --color --size --softness',
    terrain: '调整地形：--map --mode raise|lower|flatten --x --z --size --strength --height',
    terrainCapabilities: '列出可组合的整体地貌、局部修改器与地表能力：terrain-capabilities',
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

async function readHdriCatalog(file: string): Promise<ReturnType<typeof parseHdriCatalog>> {
  try {
    return parseHdriCatalog(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // An optional malformed catalog must not make the actual HDRI files disappear.
    return new Map();
  }
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
    libraryId: typeof input.libraryId === 'string' && input.libraryId ? input.libraryId : undefined,
    libraryMetadata: input.libraryId
      ? normalizeAssetLibraryMetadata(input.libraryMetadata, input.tags)
      : undefined,
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}
