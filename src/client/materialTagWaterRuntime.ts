import * as THREE from 'three';
import { PlanarReflectionPass } from '@voxel-studio/render-runtime';
import {
  FountainChain,
  ModelWaterInstances,
  WaterStreamSurface,
  WaterWrapSurface,
  classifyFallShape,
  createBallisticPath,
  getBallisticDuration,
  getWaterPartShapeSize,
  inferFountainRoles,
  inferWaterStreamGuide,
  selectMergedPoolReference
} from '@voxel-studio/render-runtime/model-water';
import { ParticleEngine, type ParticleEmitter } from '@voxel-studio/render-runtime/effects';
import { syncWaterSurfaceEnvironment } from './renderEnvironmentBridge';

interface WaterPart {
  id: string;
  isGroup: boolean;
}

interface CompiledWaterEntry {
  effectiveTags: unknown[];
}

interface WaterEntry {
  partId: string;
  group: THREE.Object3D;
  source: THREE.Mesh;
}

interface WaterStreamGuide {
  origin: THREE.Vector3;
  end: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radius: number;
  isFaucet: boolean;
}

export interface WaterFallRoute extends WaterEntry {
  role: string;
  shape: 'wall' | 'wrap' | 'jet';
  guide: WaterStreamGuide | null;
  isFaucet: boolean;
}

export interface ModelWaterMaskSource {
  clipObject: THREE.Object3D;
  ignoredObjects: THREE.Object3D[];
  objects: Map<string, THREE.Object3D>;
}

interface RoutedFall {
  modelId: string;
  partId: string;
  role: string;
  waterfall: WaterRuntimeSurface;
  source: THREE.Mesh;
  registryOwned: boolean;
  jetGroup?: ParticleEmitter[] | null;
  impactGroup?: ParticleEmitter[] | null;
  curtainEmitters?: ParticleEmitter[] | null;
  rippleWater?: WaterSurfaceLike | null;
  ripplePinId?: number | null;
}

interface WaterRuntimeSurface {
  mesh: THREE.Mesh | null;
  material: THREE.ShaderMaterial | null;
  splashGroup?: THREE.Group | null;
  update(deltaTime: number, camera?: THREE.Camera, depthTexture?: THREE.DepthTexture | null): void;
  dispose(): void;
  _worldBottomAnchor?: (target: THREE.Vector3) => THREE.Vector3;
  _receivingWater?: WaterSurfaceLike | null;
  _ripplePinId?: number | null;
}

interface WaterSurfaceLike extends WaterRuntimeSurface {
  mesh: THREE.Mesh;
  pinRippleDecalPoint(x: number, z: number): number;
  updatePinnedRipplePoint(id: number, x: number, z: number): void;
  unpinRippleDecalPoint(id: number): void;
  setWaterEnvMap(texture: THREE.Texture | null): void;
  setWaterReflectionParams(params: Record<string, unknown>): void;
  setPlanarReflectionTexture(texture: THREE.Texture | null): void;
  setPlanarReflectionMatrix(matrix: THREE.Matrix4): void;
  setWaterMode?: (mode: 'cartoon' | 'realistic' | 'hybrid') => void;
  applyWaveClearanceLift?: () => number;
}

const WATER_STREAM_PARAMS = Object.freeze({
  radiusScale: 1,
  tailScale: 1,
  strandCount: 3,
  uOpacity: 0.31,
  uEdgeAlpha: 0.34,
  uEdgeWobble: 0.1,
  uEdgeWobbleScale: 3.4,
  uFlowSpeed: -1.9,
  uFallAcceleration: 2.05,
  uSheetDrift: 0.06,
  uSheetTurbulence: 0.08,
  uFlowWarp: 0.34,
  uStrandBreakup: 1
});

const WATER_IMPACT_PARAMS = Object.freeze({
  densityScale: 1.15,
  spread: 1.55,
  upwardSpeed: 1.75,
  sizeScale: 1.25,
  lifetimeScale: 1.15,
  opacity: 0.5
});

const WATER_VISUAL_PARAMS = Object.freeze({
  topColor: '#6fbfd0',
  bottomColor: '#62a4ac',
  foamColor: '#e8fbff',
  colorBands: false,
  waterReflectionTint: '#ffffff'
});

/** Full model-material water bridge shared by every rendered map object. */
export class MaterialTagWaterRuntime {
  private readonly waterInstances: InstanceType<typeof ModelWaterInstances>;
  private readonly particleEngine: ParticleEngine;
  private readonly poolsByModel = new Map<string, WaterSurfaceLike[]>();
  private readonly waterfalls = new Map<string, RoutedFall>();
  private readonly hiddenSources = new Set<THREE.Mesh>();
  private fountainChain = new FountainChain();
  private planarReflection: PlanarReflectionPass | null = null;
  private reflectionCamera: THREE.PerspectiveCamera | null = null;
  private reflectedSurfaces: WaterSurfaceLike[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly poolTuning: Record<string, unknown>,
    private readonly fallTuning: Record<string, unknown>
  ) {
    this.particleEngine = new ParticleEngine({ THREE, scene });
    this.waterInstances = new ModelWaterInstances(scene, renderer, {
      getParticleEngine: () => this.particleEngine
    });
  }

  applyModel(
    modelRoot: THREE.Object3D,
    modelId: string,
    parts: WaterPart[],
    objects: Map<string, THREE.Object3D>,
    compiledByPartId: Map<string, CompiledWaterEntry>
  ): void {
    const entries: Array<WaterEntry & { kind: 'pool' | 'fall' }> = [];
    const waterSources = new Set<THREE.Mesh>();
    for (const part of parts) {
      if (part.isGroup) continue;
      const kind = readWaterKind(compiledByPartId.get(part.id)?.effectiveTags);
      const source = objects.get(part.id) as THREE.Mesh | undefined;
      if (!source?.isMesh || !kind) continue;
      const entry = { partId: part.id, group: source.parent ?? modelRoot, source, kind };
      entries.push(entry);
      waterSources.add(source);
    }

    const waterPartIds = new Set(entries.map((entry) => entry.partId));
    const maskSource = resolveModelWaterMaskSource(modelRoot, waterPartIds);
    const structuralObjects = maskSource.clipObject === modelRoot ? objects : maskSource.objects;

    const structuralGroups = parts
      .filter((part) => part.isGroup && !readWaterKind(compiledByPartId.get(part.id)?.effectiveTags))
      .map((part) => structuralObjects.get(part.id))
      .filter((object): object is THREE.Object3D => Boolean(object));

    for (const group of groupAdjacentPools(entries.filter((entry) => entry.kind === 'pool'))) {
      const surfaceReference = selectMergedPoolReference(group);
      const water = this.waterInstances.createMergedPool({
        modelId,
        entries: group,
        surfaceReference,
        clipObject: maskSource.clipObject,
        ignoredMaskObjects: maskSource.ignoredObjects,
        containerBottom: findPoolContainerBottom(
          surfaceReference?.entry?.source,
          structuralGroups,
          waterSources
        )
      }) as WaterSurfaceLike | null;
      if (!water) continue;
      applyUniformParams(water.material?.uniforms, this.poolTuning);
      applyPoolVisuals(water, WATER_VISUAL_PARAMS);
      water.setWaterMode?.('cartoon');
      water.applyWaveClearanceLift?.();
      const pools = this.poolsByModel.get(modelId) ?? [];
      pools.push(water);
      this.poolsByModel.set(modelId, pools);
      for (const entry of group) this.hideSource(entry.source);
    }

    const fallEntries = entries.filter((entry) => entry.kind === 'fall');
    const nonWaterBoxes = parts
      .filter((part) => !part.isGroup && !waterPartIds.has(part.id))
      .map((part) => structuralObjects.get(part.id))
      .filter((object): object is THREE.Object3D => Boolean(object))
      .map((object) => {
        object.updateWorldMatrix(true, false);
        return new THREE.Box3().setFromObject(object);
      });

    for (const route of resolveWaterFallRoutes(fallEntries, nonWaterBoxes)) {
      this.createFall(modelRoot, modelId, route);
    }
  }

  finalize(): void {
    for (const entry of this.waterfalls.values()) this.attachRipple(entry);
    this.fountainChain.dispose();
    this.fountainChain = new FountainChain();
    for (const [key, entry] of this.waterfalls) {
      if (entry.role === 'fall') continue;
      const world = bottomAnchor(entry.waterfall);
      if (world) this.fountainChain.register({ partId: key, role: entry.role, worldY: world.y });
    }
    this.fountainChain.link();
  }

  syncEnvironment(environmentMap: THREE.Texture | null): number {
    const surfaces = this.waterInstances.waterSurfaces() as WaterSurfaceLike[];
    for (const surface of surfaces) syncWaterSurfaceEnvironment(surface, environmentMap);
    return surfaces.length;
  }

  update(deltaTime: number, camera: THREE.Camera): void {
    for (const surface of this.waterInstances.waterSurfaces() as WaterSurfaceLike[]) {
      if (surface.mesh && surface.material && surface.mesh.material !== surface.material) {
        surface.mesh.material = surface.material;
      }
    }
    this.waterInstances.update(deltaTime, camera);
    this.updatePlanarReflection(camera);
    for (const entry of this.waterfalls.values()) {
      if (!entry.registryOwned) entry.waterfall.update(deltaTime, camera, null);
      if (entry.rippleWater && entry.ripplePinId != null) {
        const world = bottomAnchor(entry.waterfall);
        if (world) entry.rippleWater.updatePinnedRipplePoint(entry.ripplePinId, world.x, world.z);
      }
    }
    this.particleEngine.update(deltaTime, camera, null, this.renderer.domElement.height);
    this.fountainChain.tick([...this.waterfalls].flatMap(([partId, entry]) => {
      const emitters = [entry.jetGroup, entry.impactGroup, entry.curtainEmitters].flatMap((group) => group ?? []);
      return emitters.length
        ? [{ partId, aliveCount: emitters.reduce((sum, emitter) => sum + emitter.alive, 0) }]
        : [];
    }));
  }

  clear(): void {
    for (const entry of this.waterfalls.values()) {
      if (!entry.registryOwned) entry.waterfall.dispose();
      if (entry.rippleWater && entry.ripplePinId != null) {
        entry.rippleWater.unpinRippleDecalPoint(entry.ripplePinId);
      }
      if (entry.jetGroup) this.particleEngine.removeGroup(entry.jetGroup);
      if (entry.impactGroup) this.particleEngine.removeGroup(entry.impactGroup);
      if (entry.curtainEmitters) this.particleEngine.removeGroup(entry.curtainEmitters);
    }
    this.waterfalls.clear();
    // Detach the reflection pass while WaterSurface materials still exist.
    // disposeAll() clears those materials, so doing this afterwards would make
    // PlanarReflectionPass try to write uniforms on an already disposed surface.
    this.planarReflection?.setWaterSurfaces([]);
    this.reflectedSurfaces = [];
    this.waterInstances.disposeAll();
    for (const source of this.hiddenSources) source.visible = true;
    this.hiddenSources.clear();
    this.poolsByModel.clear();
    this.fountainChain.dispose();
    this.fountainChain = new FountainChain();
  }

  dispose(): void {
    this.clear();
    this.planarReflection?.dispose();
    this.planarReflection = null;
    this.reflectionCamera = null;
    this.particleEngine.dispose();
  }

  private updatePlanarReflection(camera: THREE.Camera): void {
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    if (!perspectiveCamera.isPerspectiveCamera) return;
    const surfaces = this.waterInstances.waterSurfaces() as WaterSurfaceLike[];
    if (!surfaces.length) return;
    if (!this.planarReflection || this.reflectionCamera !== camera) {
      this.planarReflection?.dispose();
      this.planarReflection = new PlanarReflectionPass({
        renderer: this.renderer,
        scene: this.scene,
        camera: perspectiveCamera,
        width: 512,
        height: 256
      });
      this.reflectionCamera = perspectiveCamera;
      this.reflectedSurfaces = [];
    }
    const changed = surfaces.length !== this.reflectedSurfaces.length
      || surfaces.some((surface, index) => surface !== this.reflectedSurfaces[index]);
    if (changed) {
      this.planarReflection.setWaterSurfaces(surfaces);
      this.reflectedSurfaces = [...surfaces];
    }
    this.planarReflection.render();
  }

  private createFall(modelRoot: THREE.Object3D, modelId: string, route: WaterFallRoute): void {
    const globalPartId = `${modelId}:${route.partId}`;
    let waterfall: WaterRuntimeSurface | null = null;
    let registryOwned = false;
    let jetGroup: ParticleEmitter[] | null = null;
    let impactGroup: ParticleEmitter[] | null = null;

    if (route.shape === 'wall') {
      waterfall = this.waterInstances.create({
        modelId,
        globalPartId,
        ref: { object: route.source },
        rootGroup: modelRoot,
        kind: 'fall'
      }) as WaterRuntimeSurface | null;
      if (waterfall) {
        applyUniformParams(waterfall.material?.uniforms, this.fallTuning);
        registryOwned = true;
      }
    } else if (route.shape === 'jet' && route.guide) {
      const guide = route.guide;
      const speed = Math.sqrt(2 * 9.8 * Math.max(guide.length, 0.25));
      const worldPath = route.isFaucet
        ? [guide.origin, guide.origin.clone().lerp(guide.end, 0.5), guide.end]
        : createBallisticPath({ origin: guide.origin, direction: guide.direction, speed });
      const localPath = worldPath.map((point) => modelRoot.worldToLocal(point.clone()));
      waterfall = new WaterStreamSurface(this.scene, this.renderer, modelRoot, {
        name: route.isFaucet ? `WorldForgeWaterFaucet:${globalPartId}` : `WorldForgeWaterJet:${globalPartId}`,
        pathPoints: localPath,
        radius: guide.radius * 0.7 * WATER_STREAM_PARAMS.radiusScale,
        tailScale: (route.isFaucet ? 0.5 : 0.35) * WATER_STREAM_PARAMS.tailScale,
        strandCount: WATER_STREAM_PARAMS.strandCount,
        flowSpeed: WATER_STREAM_PARAMS.uFlowSpeed,
        opacity: WATER_STREAM_PARAMS.uOpacity,
        edgeAlpha: WATER_STREAM_PARAMS.uEdgeAlpha,
        edgeWobble: WATER_STREAM_PARAMS.uEdgeWobble,
        edgeWobbleScale: WATER_STREAM_PARAMS.uEdgeWobbleScale,
        fallAcceleration: WATER_STREAM_PARAMS.uFallAcceleration,
        sheetDrift: WATER_STREAM_PARAMS.uSheetDrift,
        sheetTurbulence: WATER_STREAM_PARAMS.uSheetTurbulence,
        flowWarp: WATER_STREAM_PARAMS.uFlowWarp,
        strandBreakup: WATER_STREAM_PARAMS.uStrandBreakup
      });
      if (!route.isFaucet) jetGroup = this.createJetParticles(guide, speed);
      if (route.isFaucet && guide.direction.y < -0.2) impactGroup = this.createImpactSplash(guide);
    } else {
      route.source.updateWorldMatrix(true, false);
      modelRoot.updateWorldMatrix(true, false);
      const localMatrix = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert().multiply(route.source.matrixWorld);
      waterfall = new WaterWrapSurface(this.scene, this.renderer, modelRoot, {
        name: `WorldForgeWaterWrap:${globalPartId}`,
        sourceGeometry: route.source.geometry,
        localMatrix,
        columnCount: Number(this.fallTuning.uColumnCount) || 6,
        flowSpeed: Math.abs(Number(this.fallTuning.uFlowSpeed)) || 0.6,
        radialOverflow: route.role === 'tier'
      });
    }

    if (!waterfall) return;
    applyWaterfallVisuals(waterfall, WATER_VISUAL_PARAMS);
    this.hideSource(route.source);
    this.waterfalls.set(globalPartId, {
      modelId,
      partId: route.partId,
      role: route.role,
      waterfall,
      source: route.source,
      registryOwned,
      jetGroup,
      impactGroup
    });
  }

  private attachRipple(entry: RoutedFall): void {
    if (entry.waterfall._receivingWater || entry.rippleWater) return;
    const world = bottomAnchor(entry.waterfall);
    if (!world) return;
    const receiving = findNearestPool(this.poolsByModel.get(entry.modelId) ?? [], world);
    if (!receiving) return;
    const pinId = receiving.pinRippleDecalPoint(world.x, world.z);
    if (entry.registryOwned) {
      entry.waterfall._receivingWater = receiving;
      entry.waterfall._ripplePinId = pinId;
      return;
    }
    entry.rippleWater = receiving;
    entry.ripplePinId = pinId;
  }

  private createJetParticles(guide: WaterStreamGuide, speed: number): ParticleEmitter[] {
    const flightTime = getBallisticDuration(guide.direction, speed);
    const direction = guide.direction.toArray();
    const position = guide.origin.toArray();
    const speedRange = [speed * 0.9, speed * 1.1];
    return this.particleEngine.multiSpawn([
      { config: {
        rate: 45, lifetime: [flightTime * 0.85, flightTime * 1.05],
        velocity: { dir: direction, spread: 0.06, speed: speedRange }, acceleration: [0, -9.8, 0], drag: 0.15,
        sizeCurve: 'smooth', scaleStart: 0.8, scaleEnd: 0.2, meshSize: Math.max(guide.radius * 0.55, 0.025),
        alphaCurve: 'holdFade', alphaStart: 0.8, alphaEnd: 0.1,
        colorStart: [0.35, 0.68, 0.88], colorEnd: [0.65, 0.86, 0.98], renderMode: 'mesh', mesh: 'ico'
      }, anchor: { worldPos: position } },
      { config: {
        rate: 28, lifetime: [flightTime * 0.75, flightTime],
        velocity: { dir: direction, spread: 0.1, speed: speedRange }, acceleration: [0, -9.8, 0], drag: 0.1,
        sizeCurve: 'easeOut', scaleStart: 1, scaleEnd: 0.05, meshSize: Math.max(guide.radius * 0.3, 0.015),
        alphaCurve: 'easeOut', alphaStart: 0.55, alphaEnd: 0,
        colorStart: [0.82, 0.95, 1], colorEnd: [0.95, 0.99, 1],
        additive: true, renderMode: 'mesh', mesh: 'ico', velocityStretch: true, stretchFactor: 2.5
      }, anchor: { worldPos: position } }
    ]);
  }

  private createImpactSplash(guide: WaterStreamGuide): ParticleEmitter[] {
    const params = WATER_IMPACT_PARAMS;
    const size = Math.max(guide.radius * 0.7, 0.035) * params.sizeScale;
    return this.particleEngine.multiSpawn([
      { config: {
        rate: 32 * params.densityScale, lifetime: [0.28 * params.lifetimeScale, 0.55 * params.lifetimeScale],
        velocity: { dir: [0, 1, 0], spread: params.spread, speed: [0.3, params.upwardSpeed] }, acceleration: [0, -6.5, 0], drag: 0.3,
        sizeCurve: 'easeOut', scaleStart: 1, scaleEnd: 0.15, meshSize: size,
        alphaCurve: 'holdFade', alphaStart: params.opacity, alphaEnd: 0,
        colorStart: [0.78, 0.94, 1], colorEnd: [0.42, 0.72, 0.9], renderMode: 'mesh', mesh: 'ico', velocityStretch: true, stretchFactor: 1.4
      }, anchor: { worldPos: guide.end.toArray() } },
      { config: {
        rate: 18 * params.densityScale, lifetime: [0.22 * params.lifetimeScale, 0.42 * params.lifetimeScale],
        velocity: { dir: [0, 1, 0], spread: params.spread * 1.2, speed: [0.15, params.upwardSpeed * 0.6] }, acceleration: [0, -4.5, 0], drag: 0.45,
        sizeCurve: 'smooth', scaleStart: 0.7, scaleEnd: 0.05, meshSize: size * 0.55,
        alphaCurve: 'easeOut', alphaStart: params.opacity * 0.7, alphaEnd: 0,
        colorStart: [0.9, 0.98, 1], colorEnd: [0.7, 0.9, 1],
        additive: true, renderMode: 'mesh', mesh: 'ico', velocityStretch: true, stretchFactor: 1.1
      }, anchor: { worldPos: guide.end.toArray() } }
    ]);
  }

  private hideSource(source: THREE.Mesh): void {
    source.visible = false;
    this.hiddenSources.add(source);
  }
}

export function resolveModelWaterMaskSource(
  modelRoot: THREE.Object3D,
  waterPartIds: ReadonlySet<string>
): ModelWaterMaskSource {
  const candidate = modelRoot.userData.materialTagClipSource as THREE.Object3D | undefined;
  const clipObject = candidate?.isObject3D ? candidate : modelRoot;
  if (clipObject !== modelRoot) {
    modelRoot.updateWorldMatrix(true, false);
    clipObject.matrixAutoUpdate = false;
    clipObject.matrix.copy(modelRoot.matrixWorld);
    clipObject.updateWorldMatrix(false, true);
  }

  const objects = new Map<string, THREE.Object3D>();
  const ignoredObjects: THREE.Object3D[] = [];
  clipObject.traverse((object) => {
    const partId = String(object.userData.rawNodeId ?? object.userData.nodeId ?? '');
    if (!partId) return;
    objects.set(partId, object);
    if (waterPartIds.has(partId)) ignoredObjects.push(object);
  });
  return { clipObject, ignoredObjects, objects };
}

export function resolveWaterFallRoutes<T extends WaterEntry>(entries: T[], nonWaterBoxes: THREE.Box3[]): Array<T & WaterFallRoute> {
  const roles = inferFountainRoles(entries.map((entry) => {
    const size = getWaterPartShapeSize(entry.source, new THREE.Vector3());
    entry.source.updateWorldMatrix(true, false);
    const worldCenter = new THREE.Box3().setFromObject(entry.source).getCenter(new THREE.Vector3());
    return { size, worldCenter };
  }));
  return entries.map((entry, index) => {
    const role = roles[index];
    const shape = classifyFallShape(getWaterPartShapeSize(entry.source, new THREE.Vector3()));
    const effectiveShape = role === 'spout' ? 'jet' : shape;
    const preferDownward = effectiveShape === 'jet' && role !== 'spout' && entries.length > 1;
    const guide = effectiveShape === 'jet'
      ? inferWaterStreamGuide(entry.source, nonWaterBoxes, { preferDownward }) as WaterStreamGuide
      : null;
    const isFaucet = effectiveShape === 'jet' && role !== 'spout'
      && Boolean(guide?.isFaucet || (preferDownward && guide && guide.direction.y < -0.25));
    return { ...entry, role, shape: effectiveShape, guide, isFaucet };
  });
}

export function findPoolContainerBottom(
  source: THREE.Mesh | undefined,
  structuralGroups: THREE.Object3D[] = [],
  excludedWater: Set<THREE.Mesh> = new Set()
): number | null {
  if (!source) return null;
  source.updateWorldMatrix(true, false);
  const waterBounds = new THREE.Box3().setFromObject(source);
  const waterSize = waterBounds.getSize(new THREE.Vector3());
  // WorldForge keeps basin trim and water placeholders as sibling groups. The
  // trim can be visibly wider than the inner water opening (the real fountain's
  // upper bowl is 1.48x wider on Z), so the Voxel Studio ancestor-only 1.35x
  // allowance is too tight here. The smallest-footprint score below still
  // prevents a broad model root from being selected as a tiny pool container.
  const maxWidth = Math.max(waterSize.x * 1.6, waterSize.x + 0.7);
  const maxDepth = Math.max(waterSize.z * 1.6, waterSize.z + 0.7);
  let best: { bottom: number; score: number } | null = null;
  for (const group of structuralGroups) {
    const bounds = boundsFromSolidMeshes(group, excludedWater);
    if (!bounds) continue;
    const size = bounds.getSize(new THREE.Vector3());
    const enclosesFootprint = size.x >= waterSize.x * 0.9
      && size.z >= waterSize.z * 0.9
      && size.x <= maxWidth
      && size.z <= maxDepth
      && bounds.min.x <= waterBounds.min.x + waterSize.x * 0.1
      && bounds.max.x >= waterBounds.max.x - waterSize.x * 0.1
      && bounds.min.z <= waterBounds.min.z + waterSize.z * 0.1
      && bounds.max.z >= waterBounds.max.z - waterSize.z * 0.1;
    if (!enclosesFootprint || bounds.min.y >= waterBounds.min.y - 0.05) continue;
    const footprintError = Math.abs(size.x - waterSize.x) + Math.abs(size.z - waterSize.z);
    const verticalGap = Math.max(0, waterBounds.min.y - bounds.max.y);
    const score = footprintError + verticalGap * 0.25;
    if (!best || score < best.score) best = { bottom: bounds.min.y, score };
  }
  return best?.bottom ?? null;
}

function boundsFromSolidMeshes(root: THREE.Object3D, excludedWater: Set<THREE.Mesh>): THREE.Box3 | null {
  const bounds = new THREE.Box3().makeEmpty();
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || excludedWater.has(mesh) || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  return bounds.isEmpty() ? null : bounds;
}

function groupAdjacentPools<T extends WaterEntry>(entries: T[]): T[][] {
  if (entries.length <= 1) return entries.length ? [entries] : [];
  const bounds = entries.map((entry) => {
    entry.source.updateWorldMatrix(true, false);
    return new THREE.Box3().setFromObject(entry.source);
  });
  const parent = entries.map((_, index) => index);
  const find = (start: number): number => {
    let index = start;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => { parent[find(left)] = find(right); };
  for (let left = 0; left < bounds.length; left += 1) {
    for (let right = left + 1; right < bounds.length; right += 1) {
      const diagonal = Math.max(
        bounds[left].getSize(new THREE.Vector3()).length(),
        bounds[right].getSize(new THREE.Vector3()).length()
      );
      const gapX = Math.max(0, bounds[left].min.x - bounds[right].max.x, bounds[right].min.x - bounds[left].max.x);
      const gapY = Math.max(0, bounds[left].min.y - bounds[right].max.y, bounds[right].min.y - bounds[left].max.y);
      const gapZ = Math.max(0, bounds[left].min.z - bounds[right].max.z, bounds[right].min.z - bounds[left].max.z);
      if (Math.hypot(gapX, gapY, gapZ) <= diagonal * 1e-4 + 1e-6) union(left, right);
    }
  }
  const groups = new Map<number, T[]>();
  entries.forEach((entry, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function readWaterKind(tags: unknown[] | undefined): 'pool' | 'fall' | null {
  const water = tags?.find((tag) => tag !== null && typeof tag === 'object' && (tag as { tag?: unknown }).tag === 'water') as { value?: unknown } | undefined;
  return water?.value === 'pool' || water?.value === 'fall' ? water.value : null;
}

function applyUniformParams(uniforms: Record<string, { value: unknown }> | undefined, params: Record<string, unknown>): void {
  if (!uniforms) return;
  const vectors = new Map<string, [number, number]>();
  for (const [name, value] of Object.entries(params)) {
    const vector = name.match(/^(.+)_([xy])$/);
    if (vector && typeof value === 'number') {
      const uniform = uniforms[vector[1]]?.value as { x?: number; y?: number; set?: (x: number, y: number) => void } | undefined;
      if (uniform?.set) {
        const pending = vectors.get(vector[1]) ?? [Number(uniform.x) || 0, Number(uniform.y) || 0];
        pending[vector[2] === 'x' ? 0 : 1] = value;
        vectors.set(vector[1], pending);
      }
      continue;
    }
    if (uniforms[name]) uniforms[name].value = value;
  }
  for (const [name, value] of vectors) {
    (uniforms[name].value as { set: (x: number, y: number) => void }).set(value[0], value[1]);
  }
}

function applyPoolVisuals(water: WaterSurfaceLike, params: typeof WATER_VISUAL_PARAMS): void {
  const uniforms = water.material?.uniforms;
  if (!uniforms) return;
  setColor(uniforms.uShallowColor, params.topColor);
  setColor(uniforms.uWaterColor, params.topColor);
  setColor(uniforms.uDepthColor, params.bottomColor);
  setColor(uniforms.uFoamColor, params.foamColor);
  if (uniforms.uUseCartoonBands) uniforms.uUseCartoonBands.value = params.colorBands;
  setColor(uniforms.uWaterReflectionTint, params.waterReflectionTint);
}

function applyWaterfallVisuals(waterfall: WaterRuntimeSurface, params: typeof WATER_VISUAL_PARAMS): void {
  const uniforms = waterfall.material?.uniforms;
  if (!uniforms) return;
  setColor(uniforms.uTopColor, params.topColor);
  setColor(uniforms.uBottomColor, params.bottomColor);
  setColor(uniforms.uFoamColor, params.foamColor);
  if (uniforms.uBandSteps) uniforms.uBandSteps.value = params.colorBands ? 5 : 128;
  for (const plane of waterfall.splashGroup?.children ?? []) {
    setColor((plane as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material?.uniforms?.uColor, params.foamColor);
  }
}

function setColor(uniform: { value?: { set?: (color: string) => void } } | undefined, color: string): void {
  uniform?.value?.set?.(color);
}

function bottomAnchor(waterfall: WaterRuntimeSurface): THREE.Vector3 | null {
  if (waterfall._worldBottomAnchor) return waterfall._worldBottomAnchor(new THREE.Vector3());
  if (!waterfall.mesh) return null;
  return waterfall.mesh.getWorldPosition(new THREE.Vector3());
}

function findNearestPool(pools: WaterSurfaceLike[], worldPoint: THREE.Vector3): WaterSurfaceLike | null {
  let nearest: WaterSurfaceLike | null = null;
  let nearestDistanceSq = Infinity;
  const bounds = new THREE.Box3();
  const closest = new THREE.Vector3();
  for (const water of pools) {
    if (!water.mesh) continue;
    water.mesh.updateWorldMatrix(true, false);
    bounds.setFromObject(water.mesh);
    if (bounds.isEmpty()) continue;
    bounds.clampPoint(worldPoint, closest);
    const distanceSq = closest.distanceToSquared(worldPoint);
    if (distanceSq >= nearestDistanceSq) continue;
    nearest = water;
    nearestDistanceSq = distanceSq;
  }
  return nearest;
}
