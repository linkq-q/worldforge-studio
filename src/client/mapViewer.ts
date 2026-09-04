import type * as THREE from 'three';
import { buildEditableMapGroup, type MapMotionAdapter } from './mapRenderer';
import { RenderSceneRuntime } from './renderSceneRuntime';
import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import { adaptiveQualityScale, type AdaptiveQualityLevel } from './adaptiveRenderQuality';

export type { RenderSceneRuntime } from './renderSceneRuntime';
export type { AdaptiveQualityLevel } from './adaptiveRenderQuality';

export interface MapViewerOptions {
  /** Canvas to draw into. Leave unset to let three.js create one. */
  canvas?: HTMLCanvasElement;
  map: EditableMap;
  /** `null` renders the map in the neutral editor look, with no styling. */
  scheme?: RenderScheme | null;
  /**
   * Resolves an HDRI file name from the render plan to a fetchable URL.
   * Defaults to `hdri/<file>` relative to the page.
   */
  hdriUrl?: (file: string) => string;
  pixelRatio?: number;
  /** Selects the render budget; performance mode aggregates indoor practical lights into room-scale fill. */
  quality?: AdaptiveQualityLevel;
  /** Drive frames from your own game loop instead of `requestAnimationFrame`. */
  autoStart?: boolean;
  /** Optional semantic-animation bridge, for example a 3d-generate adapter. */
  motionAdapter?: MapMotionAdapter;
}

export interface MapViewer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Escape hatch: lights, shadow runtime and post-process adapter. */
  readonly runtime: RenderSceneRuntime;
  setMap(map: EditableMap): Promise<void>;
  setRenderScheme(scheme: RenderScheme | null): void;
  setSize(width: number, height: number): void;
  setQuality(level: AdaptiveQualityLevel): void;
  /** One frame. Call this yourself when `autoStart` is false. */
  tick(deltaTime: number): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

/**
 * Renders a WorldForge map with the exact look the editor shows.
 *
 * ```ts
 * const viewer = await createMapViewer({ canvas, map, scheme });
 * viewer.camera.position.set(20, 14, 20);
 * ```
 *
 * The map's assets travel inside `map.assets[].modelJson`, so nothing else has
 * to be fetched — except the HDRI panorama a render plan may name, which is
 * what `hdriUrl` is for.
 */
export async function createMapViewer(options: MapViewerOptions): Promise<MapViewer> {
  const runtime = new RenderSceneRuntime({
    canvas: options.canvas,
    hdriUrl: options.hdriUrl ?? ((file) => `hdri/${encodeURIComponent(file)}`),
    pixelRatio: options.pixelRatio
  });
  runtime.setAdaptiveQuality(adaptiveQualityScale(options.quality ?? 'high'));

  let scheme = options.scheme ?? null;
  let frame = 0;
  let elapsedSeconds = 0;
  let lastFrameAt = 0;

  const loadMap = async (map: EditableMap): Promise<void> => {
    const previous = runtime.rendered;
    runtime.attach(null);
    if (previous) {
      runtime.scene.remove(previous.group);
      previous.dispose();
    }
    runtime.map = map;
    runtime.updateLighting();
    const rendered = await buildEditableMapGroup(map, {
      scene: runtime.scene,
      renderer: runtime.renderer,
      motionAdapter: options.motionAdapter
    });
    runtime.scene.add(rendered.group);
    runtime.attach(rendered);
    runtime.applyScheme(scheme);
  };

  const tick = (deltaTime: number): void => {
    elapsedSeconds += deltaTime;
    runtime.renderFrame(deltaTime, elapsedSeconds);
  };

  const loop = (): void => {
    frame = requestAnimationFrame(loop);
    const now = performance.now();
    // Clamp so a backgrounded tab does not resume with a multi-second step.
    const deltaTime = Math.min(0.05, Math.max(0, now - lastFrameAt) / 1000);
    lastFrameAt = now;
    tick(deltaTime);
  };

  const start = (): void => {
    if (frame) return;
    lastFrameAt = performance.now();
    frame = requestAnimationFrame(loop);
  };

  const stop = (): void => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  };

  await loadMap(options.map);
  if (options.canvas) {
    runtime.setSize(options.canvas.clientWidth || 1, options.canvas.clientHeight || 1);
  }
  if (options.autoStart !== false) start();

  return {
    scene: runtime.scene,
    camera: runtime.camera,
    renderer: runtime.renderer,
    runtime,
    setMap: loadMap,
    setRenderScheme: (next) => {
      scheme = next;
      runtime.applyScheme(next);
    },
    setSize: (width, height) => runtime.setSize(width, height),
    setQuality: (level) => runtime.setAdaptiveQuality(adaptiveQualityScale(level)),
    tick,
    start,
    stop,
    dispose: () => {
      stop();
      const rendered = runtime.rendered;
      runtime.attach(null);
      if (rendered) {
        runtime.scene.remove(rendered.group);
        rendered.dispose();
      }
      runtime.dispose();
    }
  };
}
