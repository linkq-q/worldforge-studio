declare module '@voxel-studio/render-runtime' {
  import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
  import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

  export class RenderGraph {
    registerProducer(spec: {
      id: string;
      writes?: string[];
      reads?: string[];
      phase?: 'default' | 'prePass';
      policy?: 'everyFrame' | 'onDirty';
      run(context: Record<string, unknown>, blackboard: Map<string, unknown>): void;
    }): void;
    registerConsumer(spec: {
      id: string;
      reads?: string[];
      enabled?: boolean | (() => boolean);
    }): void;
    getResource(name: string): unknown;
    dispose(): void;
  }
  export class RenderPipeline {
    graph: RenderGraph;
    constructor(options: {
      renderer: import('three').WebGLRenderer;
      scene: import('three').Scene;
      camera: import('three').PerspectiveCamera;
      composer: EffectComposer | null;
      debug?: boolean;
      timer?: {
        begin(name: string): void;
        end(name: string): void;
        getStats(): { frameMs?: number; smoothFrameMs?: number };
      } | null;
    });
    setPlanarReflectionPass(pass: { render(): void; enabled?: boolean } | null): void;
    registerPass(
      pass: Pass,
      slot: 'mainComposer' | 'presentation' | 'overlay',
      order?: number,
      metadata?: {
        id: string;
        enabled?: boolean;
        name?: string;
        tiers?: Array<'low' | 'medium' | 'high' | 'ultra'>;
      }
    ): unknown;
    setPassEnabled(id: string, enabled: boolean): void;
    syncComposer(): void;
    notifySceneLoaded(protectionFrames?: number): void;
    renderFrame(deltaTime: number, elapsedSeconds: number, context?: Record<string, unknown>): void;
    getStats(): {
      stages: Array<{ name: string; ms: number }>;
      passes: Array<{ id: string; name: string; enabled: boolean }>;
      composerTrace: null | { total: number; unknown: number; passes: Array<{ name: string; ms: number }> };
    };
    dispose(): void;
  }
  export class CSMController {
    csm: {
      update(): void;
      updateFrustums(): void;
    } | null;
    enabled: boolean;
    constructor(options: {
      sun: import('three').DirectionalLight;
      camera: import('three').PerspectiveCamera;
      scene: import('three').Scene;
      modelRoot: import('three').Object3D;
      updateSceneShadowCameraFit: () => void;
      useCsmShadows?: boolean;
    });
    applyCsmParams(params: {
      enabled?: boolean;
      cascades?: number;
      shadowMapSize?: number;
      maxFar?: number;
      mode?: 'practical' | 'uniform' | 'logarithmic';
      fade?: boolean;
      lightMargin?: number;
      bias?: number;
      normalBias?: number;
    }): Record<string, unknown>;
    setupCsmMaterials(root?: import('three').Object3D | null): unknown;
    removeCsmPatches(root?: import('three').Object3D | null): void;
    syncCsmFromSun(): void;
    disposeCsm(): void;
  }
  export class RenderStyleManager {
    mode: 'pbr' | 'cel' | 'ink';
    getBatchMeshes: (() => import('three').Object3D[]) | null;
    constructor(options: {
      THREE: typeof import('three');
      renderer: import('three').WebGLRenderer;
      scene: import('three').Scene;
      meshRegistry: Map<string, import('three').Mesh>;
    });
    applyStyle(preset: { renderMode: 'pbr' | 'cel'; cartoon?: Record<string, number> }): void;
    setCartoonParams(params: Record<string, number>): void;
  }
  export class RuntimeIndex {
    renderRevision: number;
    partToRender: Map<string, {
      mode?: string;
      batchId?: string;
      instanceId?: number;
      object?: import('three').Object3D & { isInstancedMesh?: boolean };
    }>;
    batchToParts: Map<string, Set<string>>;
    registerMesh(
      partId: string,
      object: import('three').Object3D,
      options?: Record<string, unknown>
    ): unknown;
    getPartIdFromHit(hit: import('three').Intersection): string | null;
    audit(options?: { table?: boolean }): Record<string, number>;
    clear(): void;
  }
  export class ObjectDistanceCuller {
    constructor(options?: { hysteresis?: number });
    syncRuntimeIndex(runtimeIndex: RuntimeIndex): boolean;
    update(camera: import('three').Camera, maxDistance: number): { tested: number; culled: number };
    dispose(): void;
  }
  export class AIPrimitiveBatcher {
    constructor(options?: {
      runtimeIndex?: RuntimeIndex;
      celBatchable?: boolean;
      batchedMeshable?: boolean;
      onBatchMaterialReady?: (
        material: import('three').Material,
        sourceMaterial: unknown,
        baseRecipe: Record<string, unknown> | null,
        mesh: import('three').Object3D
      ) => void;
    });
    reset(): void;
    resetScene(root: import('three').Object3D): void;
    canBatch(part: object, options?: Record<string, unknown>): {
      eligible: boolean;
      reason?: string;
    };
    stagePart(part: object, assessment: object, modelId: string, parentChain?: import('three').Matrix4): boolean;
    compile(modelId: string, rootGroup: import('three').Object3D): unknown;
    updateModelInstanceMatrices(modelId: string): unknown;
    getSceneAudit(): {
      totalParts?: number;
      batchableParts?: number;
      instancedParts?: number;
      batchedMeshParts?: number;
      fallbackMeshParts?: number;
      fallbackParts?: number;
      batchCount?: number;
    };
    getInstancedMeshes(): import('three').Object3D[];
    getBatchedMeshes(): import('three').Object3D[];
    dispose(): void;
  }
  export interface PlanarReflectionSurface {
    mesh: import('three').Mesh;
    setPlanarReflectionTexture(texture: import('three').Texture | null): void;
    setPlanarReflectionMatrix(matrix: import('three').Matrix4): void;
  }
  export class PlanarReflectionPass {
    constructor(options: {
      renderer: import('three').WebGLRenderer;
      scene: import('three').Scene;
      camera: import('three').PerspectiveCamera;
      waterMesh?: import('three').Mesh | null;
    });
    setWaterSurfaces(surfaces: PlanarReflectionSurface[]): void;
    syncToRendererSize(): void;
    render(): void;
    dispose(): void;
  }
  export interface CartoonGrassStyle {
    cellSize?: number;
    bladeWidth?: number;
    bladeHeight?: number;
    rootColor?: string;
    tipColor?: string;
    flowerColors?: string[];
    paletteVariation?: number;
    bands?: 2 | 3;
    normalFlatten?: number;
    rootDarken?: number;
    gradientBias?: number;
    windStrength?: number;
    windDirection?: [number, number];
    windSpeed?: number;
    waveFrequency?: number;
    fadeStart?: number;
    fadeEnd?: number;
    maxInstances?: number;
  }
  export class CartoonGrassField {
    group: import('three').Group;
    constructor(options: {
      layers: Array<{
        id: string;
        visible: boolean;
        seed: number;
        resolutionX: number;
        resolutionZ: number;
        densities: number[];
        preset?: 'meadow' | 'sand' | 'wetland' | 'farm' | 'magic' | 'alpine-moss';
        height?: number;
        mix: { short: number; tall: number; flowers: number };
      }>;
      width: number;
      depth: number;
      sampleHeight: (x: number, z: number) => number;
      sampleNormal: (x: number, z: number) => [number, number, number];
      style?: CartoonGrassStyle;
    });
    update(deltaTime: number): void;
    setStyle(style: CartoonGrassStyle): CartoonGrassStyle;
    getStats(): { layerCount: number; bladeCount: number; flowerCount: number; drawCalls: number };
    dispose(): void;
  }
}

declare module '@voxel-studio/render-runtime/postprocess' {
  import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
  import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

  export const COMIC_LOOK_PRESETS: Record<'clean' | 'print', Record<string, string | number | boolean>>;
  export function createComicPrintPass(): ShaderPass;
  export function createPaperTexturePass(params?: {
    strength?: number;
    scale?: number;
    tint?: import('three').Vector3;
    texture?: import('three').Texture;
  }): ShaderPass;
  export function createSketchHatchPass(): ShaderPass;
  export function createToneMapPass(): ShaderPass;
  export function createExponentialFogPass(): ShaderPass;
  export function linearizePerspectiveDepth(depthSample: number, cameraNear: number, cameraFar: number): number;
  export class GlobalBloomPass extends Pass {
    strength: number;
    radius: number;
    threshold: number;
    constructor(
      resolution?: import('three').Vector2,
      strength?: number,
      radius?: number,
      threshold?: number
    );
  }
  export class SharedSSAOPass extends Pass {
    kernelRadius: number;
    minDistance: number;
    maxDistance: number;
    constructor(
      scene: import('three').Scene,
      camera: import('three').Camera,
      width?: number,
      height?: number,
      kernelSize?: number
    );
    setSharedNormalDepth(
      normalTexture: import('three').Texture,
      depthTexture: import('three').DepthTexture
    ): void;
  }
}

declare module '@voxel-studio/render-runtime/outline' {
  import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

  export const ARTISTIC_OUTLINE_PRESETS: Record<string, Record<string, unknown>>;
  export function createCurvatureEdgePass(renderer: import('three').WebGLRenderer): ShaderPass;
  export function createInkEdgePass(renderer: import('three').WebGLRenderer): ShaderPass;
  export function createBoundaryIdPass(): {
    render(
      renderer: import('three').WebGLRenderer,
      scene: import('three').Scene,
      camera: import('three').Camera,
      target: import('three').WebGLRenderTarget,
      modelRoot: import('three').Object3D
    ): boolean;
    dispose(): void;
  };
  export function createEdgeMaskPass(): {
    material: import('three').ShaderMaterial;
    render(
      renderer: import('three').WebGLRenderer,
      target: import('three').WebGLRenderTarget,
      normalTexture: import('three').Texture,
      depthTexture: import('three').DepthTexture | null,
      boundaryTexture: import('three').Texture | null,
      near: number,
      far: number
    ): void;
    setSize(width: number, height: number): void;
    dispose(): void;
  };
}

declare module '@voxel-studio/render-runtime/environment' {
  export const PANORAMA_EXTENSIONS: string[];
  export function loadPanoramaTexture(
    url: string,
    extension: string
  ): Promise<import('three').Texture>;
  export class HDRISkyDome {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    uniforms: Record<string, { value: unknown }>;
    constructor(radius?: number);
    setTexture(texture: import('three').Texture | null): void;
    getTexture(): import('three').Texture | null;
    setRotationY(radians: number): void;
    setIntensity(value: number): void;
    setExposure(value: number): void;
    setSaturation(value: number): void;
    setTint(enabled: boolean, color?: string | import('three').Color, strength?: number): void;
    setVisible(visible: boolean): void;
    isVisible(): boolean;
    addTo(parent: import('three').Object3D): void;
    removeFromParent(): void;
    dispose(disposeTexture?: boolean): void;
  }
  export class WaterSurface {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      environmentRoot?: import('three').Group | null,
      options?: Record<string, unknown>
    );
    update(
      deltaTime: number,
      camera: import('three').Camera,
      depthTexture: import('three').DepthTexture | null
    ): void;
    importState(state: Record<string, unknown>): void;
    setWaterMode(mode: 'cartoon' | 'realistic' | 'hybrid'): void;
    setWaterEnvMap(texture: import('three').Texture | null): void;
    setWaterReflectionParams(params: Record<string, unknown>): void;
    setPlanarReflectionParams(params: Record<string, unknown>): void;
    setPlanarReflectionTexture(texture: import('three').Texture | null): void;
    setPlanarReflectionMatrix(matrix: import('three').Matrix4): void;
    setShoreDistanceTexture(texture: import('three').Texture | null): void;
    setShoreWorldRegion(centerXZ: { x: number; y: number } | null, size?: number): void;
    dispose(): void;
  }
  export class WaterfallSurface {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    splashGroup?: import('three').Group | null;
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      environmentRoot?: import('three').Group | null,
      options?: Record<string, unknown>
    );
    update(
      deltaTime: number,
      camera: import('three').Camera,
      depthTexture?: import('three').DepthTexture | null
    ): void;
    dispose(): void;
  }
  export class ModelWaterInstances {
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      options?: Record<string, unknown>
    );
    create(options: Record<string, unknown>): WaterSurface | WaterfallSurface | null;
    createMergedPool(options: Record<string, unknown>): WaterSurface | null;
    waterSurfaces(): WaterSurface[];
    findNearestPool(worldPoint: import('three').Vector3): WaterSurface | null;
    update(deltaTime: number, camera: import('three').Camera): void;
    disposeAll(): void;
  }
  export class WaterWrapSurface {
    mesh: import('three').Mesh | null;
    material: import('three').ShaderMaterial | null;
    splashGroup: import('three').Group | null;
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      parent?: import('three').Object3D | null,
      options?: Record<string, unknown>
    );
    update(deltaTime: number): void;
    dispose(): void;
  }
  export class WaterStreamSurface extends WaterWrapSurface {
    _worldBottomAnchor(target?: import('three').Vector3): import('three').Vector3;
    setProfile(options?: { radius?: number; tailScale?: number }): void;
  }
  export class FountainChain {
    register(config: { partId: string; role: string; worldY: number }): void;
    link(): void;
    tick(counts?: Array<{ partId: string; aliveCount: number }>): void;
    dispose(): void;
  }
  export function classifyFallShape(size: import('three').Vector3): 'wall' | 'wrap' | 'jet';
  export function getWaterPartShapeSize(
    object: import('three').Object3D,
    target?: import('three').Vector3
  ): import('three').Vector3;
  export function inferFountainRoles(parts: Array<{
    size: import('three').Vector3;
    worldCenter: import('three').Vector3;
  }>): string[];
  export function inferWaterStreamGuide(
    object: import('three').Object3D,
    otherBoxes?: import('three').Box3[],
    options?: { preferDownward?: boolean }
  ): {
    origin: import('three').Vector3;
    end: import('three').Vector3;
    direction: import('three').Vector3;
    length: number;
    radius: number;
    isFaucet: boolean;
  };
  export function createBallisticPath(options: {
    origin: import('three').Vector3;
    direction: import('three').Vector3;
    speed: number;
  }): import('three').Vector3[];
  export function getBallisticDuration(direction: import('three').Vector3, speed: number): number;
  export function selectMergedPoolReference(entries: Array<{
    partId: string;
    group: import('three').Object3D;
    source: import('three').Mesh;
  }>): { entry: { source: import('three').Mesh }; bounds: import('three').Box3 } | null;
}

declare module '@voxel-studio/render-runtime/effects' {
  export interface ParticleEmitter {
    rate: number;
    alive: number;
    capacity: number;
    worldPos: number[];
    config: Record<string, unknown>;
    alive: number;
  }

  export class ParticleEngine {
    constructor(context: { THREE: typeof import('three'); scene: import('three').Scene });
    spawn(config: Record<string, unknown>, anchor?: { worldPos?: number[] }): ParticleEmitter;
    multiSpawn(layers?: Array<{
      config: Record<string, unknown>;
      anchor?: { worldPos?: number[] };
    }>): ParticleEmitter[];
    remove(emitter: ParticleEmitter): void;
    removeGroup(emitters?: ParticleEmitter[]): void;
    update(
      deltaTime: number,
      camera?: import('three').Camera | null,
      depthTexture?: import('three').DepthTexture | null,
      viewportHeight?: number | null
    ): void;
    dispose(): void;
  }

  export class EffectSlotManager {
    constructor(options?: Record<string, unknown>);
    applyPackage(
      target: Record<string, unknown>,
      effectPackage: Record<string, unknown>,
      runtimeContext?: Record<string, unknown>
    ): unknown;
    clearEffects(target: import('three').Object3D, options?: Record<string, unknown>): unknown;
  }
  export function createParticleEffect(
    anchor: { attachTo?: import('three').Object3D; scene?: import('three').Scene },
    options: { preset?: string; config?: Record<string, unknown>; overrides?: Record<string, unknown> }
  ): ParticleEmitter | null;
  export function removeParticleEffect(emitter: ParticleEmitter): boolean;
  export function tickParticleEffects(
    deltaTime: number,
    camera?: import('three').Camera | null,
    depthTexture?: import('three').DepthTexture | null,
    viewportHeight?: number | null
  ): void;
  export function applyMaterialSurfaceBinding(
    target: import('three').Object3D | import('three').Material,
    binding: Record<string, unknown>,
    environmentMap?: import('three').Texture | null
  ): number;
  export function compileModelMaterialTags(
    model: Record<string, unknown>,
    vocabulary: Record<string, unknown>
  ): {
    byPartId: Map<string, {
      part?: Record<string, unknown>;
      effectiveTags: unknown[];
      effectPackage?: { materialLayers?: unknown[] };
      runtimeEffectPackage?: {
        companionEffects?: Array<{ type?: string; params?: Record<string, unknown> }>;
      };
      baseRecipe?: Record<string, unknown>;
      materialBindings?: {
        surface?: Record<string, unknown>;
        matcap?: Record<string, unknown>;
      };
    }>;
    diagnostics: unknown[];
  };
  export function createEffectRuntime(): {
    runtime: {
      applyToMaterial(material: import('three').Material, effectPackage: Record<string, unknown>): unknown;
      applyToObject3D(root: import('three').Object3D, effectPackage: Record<string, unknown>): unknown;
      removeFromObject3D(root: import('three').Object3D): void;
      updateRuntimeUniforms(root: import('three').Object3D, values: Record<string, number>): number;
    };
  };
}

declare module '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js' {
  export function addMaterialShaderPatch(
    material: import('three').Material,
    key: string,
    patch: (shader: import('three').WebGLProgramParametersWithUniforms) => void,
    options?: { order?: number; cacheKey?: () => string }
  ): void;
  export function hasMaterialShaderPatch(material: import('three').Material, key: string): boolean;
}

declare module '@voxel-studio/render-runtime/model/material-tags-v1.json' {
  const vocabulary: Record<string, unknown>;
  export default vocabulary;
}
