/**
 * Registry for water surfaces created from selected model parts or whole models.
 *
 * A marked object is snapshotted from top-down into a mask, converted into a
 * shore-distance texture, then replaced by a local WaterSurface attached to the
 * model root so it follows model transforms.
 */

import * as THREE from 'three';
import { WaterSurface } from './WaterSurface.js';
import { WaterfallSurface } from './WaterfallSurface.js';
import { WaterWrapSurface } from './WaterWrapSurface.js';
import { WaterStreamSurface, createBallisticPath, getBallisticDuration } from './WaterFaucetStream.js';
import { ShoreDistanceGenerator } from './ShoreDistanceGenerator.js';
import { createMaskFromObject } from './WaterMaskGenerator.js';

const _mat4 = new THREE.Matrix4();

export const DEFAULT_WATER_BODY_PARAMS = Object.freeze({
  opacity: 0.28,
  refractionStrength: 0.012,
  distortionScale: 3.2,
  absorptionStrength: 1.35,
  causticStrength: 0.16,
});

// Wall only fits the documented `water:fall` shape contract (material-tags-v1.json:
// "thickness no more than one quarter of its width") — a GENUINELY flat board.
// 0.55 (the original threshold) is more than double that: a curved fin/petal with
// real sag depth (roundness ~0.3-0.5, common on fountain tiers) still slipped under
// it and got replaced by WaterfallSurface's flat PlaneGeometry+uBulge — discarding
// the fin's real silhouette for a generic bulged lens shape (2026-07-22 bug report).
// No amount of uBulge tuning can fix that: the slider only reshapes a flat
// rectangle, it can never reproduce an arbitrary curved fin. Tightened to the
// documented ratio so only true boards take the cheap flat-plane path; anything
// with real volume in its "thin" axis falls through to Wrap (always correct,
// costs a per-part shell instead of a shared plane — acceptable, effect over cost).
const WALL_MAX_ROUNDNESS = 0.25;

/**
 * Classify a `water:fall` part's AABB into a dynamic-water renderer (Phase H).
 * Pure function of geometry — the AI only ever tags `water:fall`; the shape
 * (wall panel / round body / slender spout / curved fin) is inferred here, no sub-tags.
 *
 * @param {THREE.Vector3} size - world-space AABB size of the part
 * @returns {'wall'|'wrap'|'jet'}
 */
export function classifyFallShape(size) {
  const x = Math.abs(size.x), y = Math.abs(size.y), z = Math.abs(size.z);
  const dimensions = [x, y, z].sort((a, b) => a - b);
  const hMin = Math.min(x, z), hMax = Math.max(x, z) || 1e-4;
  const roundness = hMin / hMax; // 1 = square/round footprint, →0 = elongated
  // Jet: a slender vertical spout — both horizontal dims small vs height, and
  // roughly square in plan. Conservative so it rarely misfires (falls back to wrap).
  // A single long authored axis is a stream guide. Its rotation carries the
  // actual flow direction, covering diagonal/horizontal guides as well as jets.
  if (dimensions[2] > 0 && dimensions[1] < 0.3 * dimensions[2]) return 'jet';
  if (y > 0 && hMax < 0.28 * y && roundness > 0.5) return 'jet';
  // Wall: a genuinely flat board (see WALL_MAX_ROUNDNESS above) → the flat-plane
  // WaterfallSurface fits its silhouette exactly, cheapest correct option.
  if (roundness < WALL_MAX_ROUNDNESS) return 'wall';
  // Wrap: everything else — a round body (vase/pot/column) OR an elongated shape
  // that still has real depth/curve (fin, petal, sail) — a flat plane can't cover
  // either without a "fake volume" reveal; wrap a shell on the real mesh instead.
  return 'wrap';
}

/** Size of authored geometry after world scale, without world rotation inflating its AABB. */
export function getWaterPartShapeSize(object, target = new THREE.Vector3()) {
  object.geometry?.computeBoundingBox?.();
  const bb = object.geometry?.boundingBox;
  if (!bb) return target.set(1, 1, 1);
  object.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  bb.getSize(target);
  target.set(
    Math.abs(target.x * scale.x),
    Math.abs(target.y * scale.y),
    Math.abs(target.z * scale.z),
  );
  return target;
}

/**
 * Pick the authored free-surface level for one connected pool component.
 * Small overlapping water blocks around characters must not lift the whole
 * pool, so use an XZ-area-weighted median instead of the union AABB maximum.
 */
export function selectMergedPoolReference(entries) {
  const candidates = [];
  let totalArea = 0;
  for (const entry of entries || []) {
    if (!entry?.source) continue;
    entry.source.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3().setFromObject(entry.source);
    if (bounds.isEmpty()) continue;
    const size = bounds.getSize(new THREE.Vector3());
    const area = Math.max(size.x, 1e-4) * Math.max(size.z, 1e-4);
    candidates.push({ entry, bounds, area });
    totalArea += area;
  }
  if (!candidates.length) return null;

  // A tapered vessel is often authored as comparable boxes stacked vertically.
  // That is one continuous water column, so its only free surface is the top cap.
  // Small tagged props inside a broad bath are not comparable in footprint and
  // deliberately fall through to the weighted-median rule below.
  if (candidates.length > 1) {
    const stack = [...candidates].sort((a, b) => a.bounds.min.y - b.bounds.min.y);
    const maxArea = Math.max(...stack.map(candidate => candidate.area));
    const comparableFootprints = stack.every(candidate => candidate.area >= maxArea * 0.25);
    const verticallyConnected = stack.slice(1).every((upper, index) => {
      const lower = stack[index];
      const overlapX = Math.max(0, Math.min(lower.bounds.max.x, upper.bounds.max.x)
        - Math.max(lower.bounds.min.x, upper.bounds.min.x));
      const overlapZ = Math.max(0, Math.min(lower.bounds.max.z, upper.bounds.max.z)
        - Math.max(lower.bounds.min.z, upper.bounds.min.z));
      const overlapRatio = (overlapX * overlapZ) / Math.max(Math.min(lower.area, upper.area), 1e-4);
      const lowerHeight = lower.bounds.max.y - lower.bounds.min.y;
      const upperHeight = upper.bounds.max.y - upper.bounds.min.y;
      const verticalGap = upper.bounds.min.y - lower.bounds.max.y;
      return overlapRatio >= 0.5
        && verticalGap <= Math.max(lowerHeight, upperHeight) * 0.15;
    });
    if (comparableFootprints && verticallyConnected) {
      return stack.reduce((highest, candidate) => (
        candidate.bounds.max.y > highest.bounds.max.y ? candidate : highest
      ));
    }
  }

  candidates.sort((a, b) => a.bounds.max.y - b.bounds.max.y);
  let accumulatedArea = 0;
  for (const candidate of candidates) {
    accumulatedArea += candidate.area;
    if (accumulatedArea >= totalArea * 0.5) return candidate;
  }
  return candidates[candidates.length - 1];
}

/**
 * ponytail: assign fountain roles to water:fall parts by spatial relationship.
 * No AI sub-tags needed — a part's role falls out of its geometry and position
 * relative to its siblings. O(n²) over fall parts; n≤10 in practice.
 *
 * Rules (priority order):
 *   spout  — highest part, slender (roundness>0.4), no fall source above
 *   tier   — flat/disc (height < 0.35× width), water source above AND receiver below
 *   basin  — lowest pool, flat, no fall receiver below
 *   fall   — standalone (backward-compat default)
 *
 * @param {Array<{size:THREE.Vector3, worldCenter:THREE.Vector3}>} fallParts
 * @returns {string[]} roles in same order as input
 */
export function inferFountainRoles(fallParts) {
  if (fallParts.length <= 1) return fallParts.map(() => 'fall');
  const roles = new Array(fallParts.length).fill('fall');

  // A model can contain multiple fountains. Build XZ-connected components first;
  // height ordering alone incorrectly linked distant decorations into one chain.
  const indexed = fallParts.map((p, i) => ({ ...p, idx: i }));
  const adjacentXZ = (a, b) => {
    const reachX = (Math.abs(a.size.x) + Math.abs(b.size.x)) * 0.5;
    const reachZ = (Math.abs(a.size.z) + Math.abs(b.size.z)) * 0.5;
    const margin = Math.max(0.05, Math.min(reachX, reachZ) * 0.25);
    return Math.abs(a.worldCenter.x - b.worldCenter.x) <= reachX + margin
      && Math.abs(a.worldCenter.z - b.worldCenter.z) <= reachZ + margin;
  };
  const visited = new Set();
  const components = [];
  for (const seed of indexed) {
    if (visited.has(seed.idx)) continue;
    const component = [];
    const queue = [seed];
    visited.add(seed.idx);
    while (queue.length) {
      const current = queue.pop();
      component.push(current);
      for (const candidate of indexed) {
        if (visited.has(candidate.idx) || !adjacentXZ(current, candidate)) continue;
        visited.add(candidate.idx);
        queue.push(candidate);
      }
    }
    components.push(component);
  }

  for (const component of components) {
    if (component.length <= 1) continue;
    component.sort((a, b) => b.worldCenter.y - a.worldCenter.y);
    for (let rank = 0; rank < component.length; rank++) {
      const p = component[rank];
      const sz = p.size;
      const h = Math.abs(sz.y);
      const w = Math.max(Math.abs(sz.x), Math.abs(sz.z));
      const roundness = Math.min(Math.abs(sz.x), Math.abs(sz.z)) / Math.max(Math.abs(sz.x), Math.abs(sz.z), 1e-4);
      const isFlat = h < 0.35 * w;
      const isSlender = roundness > 0.4 && h > 0.5 * w;
      const hasSourceAbove = rank > 0;
      const hasReceiverBelow = rank < component.length - 1;

      if (rank === 0 && isSlender) {
        roles[p.idx] = 'spout';
      } else if (isFlat && hasSourceAbove && hasReceiverBelow) {
        roles[p.idx] = 'tier';
      } else if (isFlat && !hasReceiverBelow && hasSourceAbove) {
        roles[p.idx] = 'basin';
      } else if (!hasSourceAbove && isFlat) {
        roles[p.idx] = 'basin';
      }
    }
  }
  return roles;
}

/**
 * Resolve a slender guide mesh into a signed world-space stream axis.
 * A solid touching exactly one endpoint identifies a faucet/nozzle source. With
 * no contact, the lower endpoint is the fountain source and the direction points up.
 * Grouped falling guides can opt into the inverse (high endpoint -> low endpoint).
 */
export function inferWaterStreamGuide(object, otherBoxes = [], { preferDownward = false } = {}) {
  object.geometry?.computeBoundingBox?.();
  const bb = object.geometry?.boundingBox;
  if (!bb) {
    return {
      origin: new THREE.Vector3(),
      end: new THREE.Vector3(0, 1, 0),
      direction: new THREE.Vector3(0, 1, 0),
      length: 1,
      radius: 0.05,
      isFaucet: false,
    };
  }
  object.updateWorldMatrix(true, false);
  const size = bb.getSize(new THREE.Vector3());
  const axes = [size.x, size.y, size.z];
  const axisIndex = axes.indexOf(Math.max(...axes));
  const axis = new THREE.Vector3(
    axisIndex === 0 ? 1 : 0,
    axisIndex === 1 ? 1 : 0,
    axisIndex === 2 ? 1 : 0,
  );
  const center = bb.getCenter(new THREE.Vector3());
  const half = axes[axisIndex] * 0.5;
  const a = center.clone().addScaledVector(axis, -half).applyMatrix4(object.matrixWorld);
  const b = center.clone().addScaledVector(axis, half).applyMatrix4(object.matrixWorld);
  const length = Math.max(a.distanceTo(b), 1e-3);
  const shapeSize = getWaterPartShapeSize(object, new THREE.Vector3());
  const cross = axisIndex === 0 ? [shapeSize.y, shapeSize.z]
    : axisIndex === 1 ? [shapeSize.x, shapeSize.z]
      : [shapeSize.x, shapeSize.y];
  // Preserve the authored rectangular cross-section area when converting the
  // guide box to a round Tube. Using only the thinnest side made wide streams
  // collapse into hairline wires (for example 0.48 x 0.1 authored ribbons).
  const radius = Math.max(Math.sqrt(cross[0] * cross[1]) * 0.5, length * 0.01);
  const nearestDistance = point => otherBoxes.reduce(
    (best, box) => Math.min(best, box.distanceToPoint(point)),
    Infinity,
  );
  const da = nearestDistance(a);
  const db = nearestDistance(b);
  const contactTolerance = Math.max(0.05, radius * 1.5, length * 0.04);
  const aTouches = da <= contactTolerance;
  const bTouches = db <= contactTolerance;
  const isFaucet = aTouches !== bTouches;
  let origin;
  let end;
  const hasVerticalDrop = Math.abs(a.y - b.y) > length * 0.25;
  if (preferDownward && hasVerticalDrop) {
    origin = a.y >= b.y ? a : b;
    end = origin === a ? b : a;
  } else if (isFaucet) {
    origin = aTouches ? a : b;
    end = aTouches ? b : a;
  } else if (a.y <= b.y) {
    origin = a;
    end = b;
  } else {
    origin = b;
    end = a;
  }
  return {
    origin: origin.clone(),
    end: end.clone(),
    direction: end.clone().sub(origin).normalize(),
    length,
    radius,
    isFaucet,
  };
}

/**
 * ponytail: a slender vertical water:fall part is a fountain jet (shoots up) OR a faucet
 * stream (pours down from a tap). Geometry alone can't tell — the distinguishing signal is
 * spatial: a faucet has a solid part sitting directly above it (the tap/spout it pours from),
 * a fountain is open above. Pure AABB test, no raycast, so it runs headless in tests.
 *
 * @param {THREE.Box3} streamBox - the water part's world AABB
 * @param {THREE.Box3[]} otherBoxes - world AABBs of the non-water parts
 * @returns {boolean} true if a solid part sits just above the stream (⇒ faucet)
 */
export function hasSolidAbove(streamBox, otherBoxes, tol = 0.05) {
  const top = streamBox.max.y;
  const h = Math.max(streamBox.max.y - streamBox.min.y, 1e-3);
  const capTolerance = Math.max(tol, h * 0.1);
  for (const b of otherBoxes) {
    const xzOverlap = b.min.x <= streamBox.max.x && b.max.x >= streamBox.min.x
      && b.min.z <= streamBox.max.z && b.max.z >= streamBox.min.z;
    if (!xzOverlap) continue;
    // Solid extends above the stream top and starts within ~one stream-height above it —
    // a tap right at the spout, not an unrelated roof far overhead.
    if (b.max.y > top + tol && Math.abs(b.min.y - top) <= capTolerance) return true;
  }
  return false;
}

export class ModelWaterInstances {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer, {
    getReceivingWater = null,
    getParticleEngine = null,
    refractionProvider = null,
  } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.getReceivingWater = getReceivingWater;
    this.getParticleEngine = getParticleEngine;
    this.refractionProvider = refractionProvider;
    this.bodyParams = { ...DEFAULT_WATER_BODY_PARAMS };
    /** @type {Map<string, { water: WaterSurface, modelId: string }>} keyed by globalPartId */
    this._instances = new Map();
  }

  has(globalPartId) {
    return this._instances.has(globalPartId);
  }

  getWater(globalPartId) {
    return this._instances.get(globalPartId)?.water || null;
  }

  waterSurfaces() {
    return [...this._instances.values()]
      .filter(entry => entry.kind === 'pool')
      .map(entry => entry.water)
      .filter(Boolean);
  }

  setBodyParams(params = {}) {
    Object.assign(this.bodyParams, params);
    let updated = 0;
    for (const entry of this._instances.values()) {
      const uniforms = entry.skirt?.material?.uniforms;
      if (uniforms) {
        if (uniforms.uOpacity) uniforms.uOpacity.value = this.bodyParams.opacity;
        if (uniforms.uRefractionStrength) {
          uniforms.uRefractionStrength.value = this.bodyParams.refractionStrength;
        }
        if (uniforms.uDistortionScale) {
          uniforms.uDistortionScale.value = this.bodyParams.distortionScale;
        }
        if (uniforms.uAbsorptionStrength) {
          uniforms.uAbsorptionStrength.value = this.bodyParams.absorptionStrength;
        }
        if (uniforms.uCausticStrength) {
          uniforms.uCausticStrength.value = this.bodyParams.causticStrength;
        }
      }
      const bottomOpacity = entry.bottom?.material?.uniforms?.uOpacity;
      if (bottomOpacity) bottomOpacity.value = this.bodyParams.opacity;
      if (uniforms || bottomOpacity) updated++;
    }
    return updated;
  }

  findNearestPool(worldPoint) {
    if (!worldPoint) return null;
    let nearest = null;
    let nearestDistanceSq = Infinity;
    const bounds = new THREE.Box3();
    const closestPoint = new THREE.Vector3();
    for (const water of this.waterSurfaces()) {
      if (!water.mesh) continue;
      water.mesh.updateWorldMatrix(true, false);
      bounds.setFromObject(water.mesh);
      if (bounds.isEmpty()) continue;
      bounds.clampPoint(worldPoint, closestPoint);
      const distanceSq = closestPoint.distanceToSquared(worldPoint);
      if (distanceSq >= nearestDistanceSq) continue;
      nearest = water;
      nearestDistanceSq = distanceSq;
    }
    return nearest;
  }

  /** @returns {string[]} globalPartIds of currently live water instances */
  activePartIds() {
    return [...this._instances.keys()];
  }

  /** Build a standalone Mesh whose local transform == the part's world transform. */
  _buildFootprintMesh(ref) {
    const obj = ref?.object;
    if (!obj) return null;
    let geometry;
    let worldMat;
    if (obj.isInstancedMesh) {
      if (!Number.isInteger(ref.instanceId) || ref.instanceId < 0) return null;
      geometry = obj.geometry;
      obj.updateWorldMatrix(true, false);
      obj.getMatrixAt(ref.instanceId, _mat4);
      worldMat = new THREE.Matrix4().copy(obj.matrixWorld).multiply(_mat4);
    } else if (obj.isMesh && obj.geometry) {
      geometry = obj.geometry;
      obj.updateWorldMatrix(true, false);
      worldMat = obj.matrixWorld;
    } else {
      return null;
    }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(worldMat);
    mesh.matrixWorld.copy(worldMat);
    return mesh;
  }

  _createWaterFromMask({ modelId, globalPartId, rootGroup, canvas, size, center, top, bottom, sourceGeometry = null, sourceWorldMatrix = null, containerBottom = null }) {
    const shoreTex = ShoreDistanceGenerator.fromCanvas(canvas);

    rootGroup.updateWorldMatrix(true, false);
    const rootScale = new THREE.Vector3();
    rootGroup.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), rootScale);
    const s = rootScale.x || 1;
    const localSize = size / s;
    const segments = Math.min(192, Math.max(32, Math.round(size * 4)));

    const water = new WaterSurface(this.scene, this.renderer, rootGroup, {
      size: localSize,
      segments,
      waterLevel: 0,
      waterMode: 'cartoon',
    });
    water.setShoreDistanceTexture(shoreTex);

    const wu = water.material.uniforms;
    wu.uOpacity.value = 0.7;
    wu.uToonPatternScale.value = Math.min(2.0, Math.max(0.35, 4.0 / size));
    wu.uToonPatternWidth.value = 0.010;
    wu.uToonSparkleScale.value = Math.min(6.0, Math.max(1.6, 18.0 / size));
    // v2 model-water: the placeholder block is hidden, so the real pool floor is now
    // visible — fade the shore edge to transparent for depth, and let cartoon water
    // reflect the sky (needs a composite sky env feeding tWaterEnvMap; harmless otherwise).
    wu.uShoreTransparency.value = 1.0;
    wu.uShoreEdgeAlpha.value = 0.35;
    wu.uToonEnvReflection.value = 1.0;
    wu.uUseWaterEnvReflection.value = true;
    const localPos = rootGroup.worldToLocal(new THREE.Vector3(center.x, top, center.z));
    water.mesh.position.copy(localPos);
    water.mesh.userData.isModelWater = true;
    water.mesh.userData.modelId = modelId;
    water.mesh.userData.globalPartId = globalPartId;
    const surfaceLift = water.applyWaveClearanceLift();

    // Phase F（2026-07-22 重写）：鱼缸/花瓶类举高容器的水下水体。地面恒为 y=0（项目
    // 坐标系约定），"海拔" = top 本身。地面湖泊/水池（elevation≈0）或纯平面水面
    // （top≈bottom，无真实体积）都不生成，行为零回归。
    // 旧版是外接圆柱近似——对方形鱼缸完全错（圆管套在方缸里）。现直接复用被隐藏的
    // 水体部件自身的真实几何 clone 出半透明水体，形状精确匹配任意容器（方缸/花瓶/异形），
    // 深度自动来自几何本身，不需要重建近似轮廓。
    const bodyBottom = Number.isFinite(containerBottom) ? containerBottom : bottom;
    const worldDepth = bodyBottom != null ? (top - bodyBottom) : 0;
    wu.uModelWaterDepth.value = Math.max(worldDepth, 0);
    let skirt = null;
    let bottomMesh = null;
    if (
      sourceGeometry &&
      sourceWorldMatrix &&
      worldDepth > Math.max(size * 0.002, 0.001)
    ) {
      const localMatrix = new THREE.Matrix4()
        .copy(rootGroup.matrixWorld).invert()
        .multiply(sourceWorldMatrix);
      skirt = this._buildPoolBody(water, sourceGeometry, localMatrix, surfaceLift, worldDepth);
      rootGroup.add(skirt);
    }
    if (worldDepth > Math.max(size * 0.002, 0.001)) {
      bottomMesh = this._buildPoolBottom(water, worldDepth, rootScale.y);
      rootGroup.add(bottomMesh);
    }

    this._instances.set(globalPartId, { water, modelId, kind: 'pool', skirt, bottom: bottomMesh });
    return water;
  }

  /**
   * Phase F: submerged water body — a translucent, depth-tinted clone of the
   * hidden water part's real geometry, positioned to exactly overlap where the
   * part used to sit. Matches any container silhouette because it IS the part.
   */
  _buildPoolBody(water, sourceGeometry, localMatrix, surfaceLift = 0, worldDepth = null) {
    const geometry = sourceGeometry.clone();
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const yMin = bb.min.y;
    const yRange = Math.max(bb.max.y - yMin, 1e-4);

    // Thin water:pool parts are intentional AI output. When a compact parent
    // container supplied a real world depth, stretch only the bottom ring down
    // to that depth; the original top ring remains the animated water surface.
    if (worldDepth != null && worldDepth > yRange) {
      const s = new THREE.Vector3();
      localMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      const localDepth = worldDepth / Math.max(Math.abs(s.y), 1e-4);
      const pos = geometry.attributes.position;
      const bottomBand = yMin + yRange * 0.02;
      const bodyBottom = bb.max.y - localDepth;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) <= bottomBand) pos.setY(i, bodyBottom);
      }
      pos.needsUpdate = true;
      geometry.computeBoundingBox();
    }

    // Seam fix (Phase J): the top WaterSurface renders at (top + uSurfaceLift) because of
    // wave-clearance lift, but this body's top edge is the un-lifted geometry max.y — the
    // difference is the visible gap the user reported. Raise the top ring by the lift
    // (converted into this geometry's local Y via the localMatrix Y scale) so the body
    // meets the surface. Erring toward slight overlap is invisible; a gap is not.
    // ponytail: assumes an axis-aligned water part (compressed primitive, no tilt). A tilted
    // container would over/under-lift a hair — still just overlap, never a gap.
    if (surfaceLift > 0) {
      const s = new THREE.Vector3();
      localMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      const localLift = surfaceLift / Math.max(Math.abs(s.y), 1e-4);
      const pos = geometry.attributes.position;
      const topBand = bb.max.y - yRange * 0.02;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) >= topBand) pos.setY(i, pos.getY(i) + localLift);
      }
      pos.needsUpdate = true;
    }

    // Color fix (Phase J): share the top surface's live Color uniforms BY REFERENCE. The
    // panel mutates them in place (uniforms.uXColor.value.set(...), never replaces the
    // object), so the body tracks water-color slider edits instead of freezing a snapshot
    // that drifts out of sync with the surface. Top of the body = shallow/waterline color,
    // floor = depth color — one gradient, no baked vertex buffer.
    const wu = water.material.uniforms;
    const refraction = this.refractionProvider;
    const bodyParams = this.bodyParams;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTopColor: { value: (wu.uShallowColor || wu.uWaterColor).value },
        uBottomColor: { value: (wu.uDepthColor || wu.uWaterColor).value },
        uBodyYMin: { value: geometry.boundingBox.min.y },
        uBodyYMax: { value: bb.max.y },
        // Share the existing water clock; the body needs no second update lifecycle.
        uTime: wu.uTime,
        tSceneColor: { value: refraction?.texture || null },
        uViewportSize: { value: refraction?.viewportSize || new THREE.Vector2(1, 1) },
        uUseSceneRefraction: { value: refraction ? 1 : 0 },
        uOpacity: { value: bodyParams.opacity },
        uRefractionStrength: { value: bodyParams.refractionStrength },
        uDistortionScale: { value: bodyParams.distortionScale },
        uAbsorptionStrength: { value: bodyParams.absorptionStrength },
        uCausticStrength: { value: bodyParams.causticStrength },
      },
      vertexShader: /* glsl */`
        varying float vBodyY;
        varying float vLocalNormalY;
        varying vec3 vWorldPosition;
        varying vec3 vViewPosition;
        varying vec3 vViewNormal;
        void main() {
          vBodyY = position.y;
          vLocalNormalY = normal.y;
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = viewPosition.xyz;
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */`
        varying float vBodyY;
        varying float vLocalNormalY;
        varying vec3 vWorldPosition;
        varying vec3 vViewPosition;
        varying vec3 vViewNormal;
        uniform vec3 uTopColor;
        uniform vec3 uBottomColor;
        uniform float uBodyYMin;
        uniform float uBodyYMax;
        uniform float uTime;
        uniform sampler2D tSceneColor;
        uniform vec2 uViewportSize;
        uniform float uUseSceneRefraction;
        uniform float uOpacity;
        uniform float uRefractionStrength;
        uniform float uDistortionScale;
        uniform float uAbsorptionStrength;
        uniform float uCausticStrength;
        void main() {
          // Horizontal caps are owned by the animated surface and the merged
          // footprint bottom. This mesh contributes vertical volume only.
          if (abs(vLocalNormalY) > 0.98) discard;
          float t = clamp((vBodyY - uBodyYMin) / max(uBodyYMax - uBodyYMin, 1e-4), 0.0, 1.0);
          vec3 N = normalize(vViewNormal);
          vec3 V = normalize(-vViewPosition);
          float depth = 1.0 - t;
          float NoV = clamp(dot(N, V), 0.0, 1.0);
          float viewPath = 1.0 / max(NoV, 0.2);
          float absorption = 1.0 - exp(-depth * viewPath * uAbsorptionStrength);

          // A homogeneous flat box is mathematically uniform head-on. Two restrained
          // moving bands supply the missing underwater light/density cue without a
          // texture, raymarch, extra mesh, or scene-color pass.
          float waveA = sin(vWorldPosition.x * uDistortionScale + vWorldPosition.y * 4.7 + uTime * 0.42);
          float waveB = sin(vWorldPosition.z * (uDistortionScale * 1.19) - vWorldPosition.y * 3.3 - uTime * 0.31);
          float densityNoise = (waveA + waveB) * 0.5;
          float causticWave = 0.5 + 0.5 * sin(
            (vWorldPosition.x + vWorldPosition.z) * (uDistortionScale * 1.56)
            - vWorldPosition.y * 2.0
            + densityNoise * 1.2
            + uTime * 0.58
          );
          float surfaceCaustic = pow(causticWave, 6.0) * smoothstep(0.48, 0.95, t);

          vec3 bodyColor = mix(uTopColor, uBottomColor, clamp(depth * 0.65 + absorption * 0.45, 0.0, 1.0));
          bodyColor *= 1.0 + densityNoise * 0.035;
          bodyColor = mix(bodyColor, uTopColor * 1.15, surfaceCaustic * uCausticStrength);
          float fresnel = pow(1.0 - NoV, 3.0);
          bodyColor += uTopColor * fresnel * 0.16;
          float bottomContact = 1.0 - smoothstep(0.0, 0.14, t);
          bodyColor *= 1.0 - bottomContact * 0.14;

          vec2 screenUv = gl_FragCoord.xy / max(uViewportSize, vec2(1.0));
          vec2 flow = vec2(waveA, waveB) * 0.35;
          vec2 distortion = (N.xy + flow) * uRefractionStrength * mix(0.35, 1.0, absorption);
          vec2 refractedUv = clamp(screenUv + distortion, vec2(0.002), vec2(0.998));
          vec3 sceneColor = texture2D(tSceneColor, refractedUv).rgb;
          float tint = clamp(uOpacity + absorption * 0.48, 0.0, 0.94);
          vec3 refractedWater = mix(sceneColor, bodyColor, tint);
          refractedWater += uTopColor * (surfaceCaustic * uCausticStrength + fresnel * 0.06);

          float topFade = 1.0 - smoothstep(0.82, 1.0, t) * 0.65;
          float alpha = uOpacity * mix(0.30, 1.0, absorption) * topFade;
          alpha *= 1.0 + densityNoise * 0.04;
          alpha += uOpacity * (fresnel * 0.08 + bottomContact * 0.12);
          // Scene color is already the background contribution, so the refractive
          // branch replaces it with alpha=1. The outer glass renders afterwards.
          gl_FragColor = uUseSceneRefraction > 0.5
            ? vec4(refractedWater, 1.0)
            : vec4(bodyColor, alpha);
        }
      `,
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    const body = new THREE.Mesh(geometry, material);
    body.name = `${water.mesh.name || 'WaterSurface'}Body`;
    body.matrixAutoUpdate = false;
    body.matrix.copy(localMatrix); // parent = rootGroup → follows model transforms
    body.userData.skipShaderApply = true;
    body.userData.isEnvironmentObject = true;
    body.userData.isWater = true;
    body.userData.isWaterRefractionBody = true;
    body.renderOrder = water.mesh.renderOrder - 0.01;
    return body;
  }

  _buildPoolBottom(water, worldDepth, rootScaleY = 1) {
    const wu = water.material.uniforms;
    // One flat quad follows the already-merged shore mask, so horizontally tiled
    // water parts receive one continuous bottom instead of the reference part only.
    const geometry = new THREE.PlaneGeometry(wu.uWaterPlaneSize.value, wu.uWaterPlaneSize.value);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tShoreDistance: wu.tShoreDistance,
        uInvertShoreDistance: wu.uInvertShoreDistance,
        uShoreClipThreshold: wu.uShoreClipThreshold,
        uBottomColor: { value: (wu.uDepthColor || wu.uWaterColor).value },
        uWorldDepth: { value: Math.max(worldDepth, 0) },
        uOpacity: { value: this.bodyParams.opacity },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D tShoreDistance;
        uniform bool uInvertShoreDistance;
        uniform float uShoreClipThreshold;
        uniform vec3 uBottomColor;
        uniform float uWorldDepth;
        uniform float uOpacity;
        void main() {
          float shoreDist = texture2D(tShoreDistance, vUv).r;
          if (uInvertShoreDistance) shoreDist = 1.0 - shoreDist;
          if (shoreDist < uShoreClipThreshold) discard;

          float depthFactor = smoothstep(0.15, 1.5, uWorldDepth);
          float shallowAlpha = 0.03 + uOpacity * 0.12;
          float deepAlpha = clamp(0.58 + uOpacity * 0.75, 0.58, 0.88);
          float alpha = mix(shallowAlpha, deepAlpha, depthFactor);
          vec3 bottomColor = uBottomColor * mix(1.0, 0.62, depthFactor);
          gl_FragColor = vec4(bottomColor, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const bottom = new THREE.Mesh(geometry, material);
    bottom.name = `${water.mesh.name || 'WaterSurface'}Bottom`;
    bottom.position.copy(water.mesh.position);
    bottom.position.y -= worldDepth / Math.max(Math.abs(rootScaleY), 1e-4);
    bottom.userData.skipShaderApply = true;
    bottom.userData.isEnvironmentObject = true;
    bottom.userData.isWater = true;
    bottom.renderOrder = water.mesh.renderOrder - 0.02;
    return bottom;
  }

  _createWaterfallFromPart({ modelId, globalPartId, rootGroup, footprintMesh }) {
    footprintMesh.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3().setFromObject(footprintMesh);
    const size = getWaterPartShapeSize(footprintMesh, new THREE.Vector3());

    // Phase H: route by shape. Round/stout bodies (vase/pot) can't be a flat
    // plane — wrap a shell on the real geometry instead. Wall keeps the plane.
    const shape = classifyFallShape(size);
    if (shape !== 'wall') {
      return this._createWaterWrapFromPart({ modelId, globalPartId, rootGroup, footprintMesh, shape });
    }

    const height = Math.max(size.y, 0.1);
    const thinAxis = size.x <= size.z ? 'x' : 'z';
    const width = Math.max(thinAxis === 'x' ? size.z : size.x, 0.1);
    const normalWorld = thinAxis === 'x'
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);
    const bottomWorld = new THREE.Vector3(bounds.getCenter(new THREE.Vector3()).x, bounds.min.y, bounds.getCenter(new THREE.Vector3()).z);
    rootGroup.updateWorldMatrix(true, false);
    const rootScale = new THREE.Vector3();
    rootGroup.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), rootScale);
    const localHeight = height / Math.max(Math.abs(rootScale.y), 1e-4);
    const localWidth = width / Math.max(Math.abs(thinAxis === 'x' ? rootScale.z : rootScale.x), 1e-4);
    const localPosition = rootGroup.worldToLocal(bottomWorld.clone()).add(new THREE.Vector3(0, localHeight * 0.5, 0));
    const rootRotation = new THREE.Matrix4().extractRotation(rootGroup.matrixWorld).invert();
    const localNormal = normalWorld.clone().transformDirection(rootRotation);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);
    const water = new WaterfallSurface(this.scene, this.renderer, rootGroup, {
      name: `ModelWaterfall:${globalPartId}`,
      width: localWidth,
      height: localHeight,
      position: localPosition,
      quaternion,
      receivingWater: this.getReceivingWater?.() || null,
      particleEngine: this.getParticleEngine?.() || null,
    });
    water.mesh.userData.isModelWater = true;
    water.mesh.userData.modelId = modelId;
    water.mesh.userData.globalPartId = globalPartId;
    this._instances.set(globalPartId, { water, modelId, kind: 'fall' });
    return water;
  }

  /**
   * Phase H: round/stout `water:fall` bodies (vase/pot/column) get a water shell
   * wrapped onto their real geometry instead of a flat plane. `jet` additionally
   * spawns an upward particle fountain (best-effort — the shell is the reliable part).
   */
  _createWaterWrapFromPart({ modelId, globalPartId, rootGroup, footprintMesh, shape }) {
    rootGroup.updateWorldMatrix(true, false);
    const localMatrix = new THREE.Matrix4()
      .copy(rootGroup.matrixWorld).invert()
      .multiply(footprintMesh.matrixWorld);
    if (shape === 'jet') {
      const guide = inferWaterStreamGuide(footprintMesh);
      const speed = Math.sqrt(2 * 9.8 * Math.max(guide.length, 0.25));
      const worldPath = createBallisticPath({
        origin: guide.origin,
        direction: guide.direction,
        speed,
      });
      const localPath = worldPath.map(point => rootGroup.worldToLocal(point.clone()));
      const stream = new WaterStreamSurface(this.scene, this.renderer, rootGroup, {
        name: `ModelWaterJet:${globalPartId}`,
        pathPoints: localPath,
        radius: guide.radius * 0.7,
        tailScale: 0.45,
      });
      stream.mesh.userData.isModelWater = true;
      stream.mesh.userData.modelId = modelId;
      stream.mesh.userData.globalPartId = globalPartId;
      const jetEmitter = this._spawnJet(footprintMesh, globalPartId, guide, speed);
      this._instances.set(globalPartId, { water: stream, modelId, kind: 'fall', jetEmitter });
      return stream;
    }
    const wrap = new WaterWrapSurface(this.scene, this.renderer, rootGroup, {
      name: `ModelWaterWrap:${globalPartId}`,
      sourceGeometry: footprintMesh.geometry,
      localMatrix,
    });
    wrap.mesh.userData.isModelWater = true;
    wrap.mesh.userData.modelId = modelId;
    wrap.mesh.userData.globalPartId = globalPartId;

    this._instances.set(globalPartId, { water: wrap, modelId, kind: 'fall', jetEmitter: null });
    return wrap;
  }

  /** Phase H (Jet): continuous upward particle fountain at the spout top. */
  _spawnJet(footprintMesh, globalPartId, streamGuide = null, launchSpeed = null) {
    const engine = this.getParticleEngine?.();
    if (!engine?.spawn) return null;
    const guide = streamGuide || inferWaterStreamGuide(footprintMesh);
    const speed = launchSpeed ?? Math.sqrt(2 * 9.8 * Math.max(guide.length, 0.25));
    const flightTime = getBallisticDuration(guide.direction, speed);
    // Cone-ish upward jet + gravity (standard fountain: velocity up, accel down).
    const emitter = engine.spawn({
      rate: 90,
      lifetime: [flightTime * 0.85, flightTime * 1.05],
      velocity: {
        dir: guide.direction.toArray(),
        spread: 0.12,
        speed: [speed * 0.9, speed * 1.1],
      },
      acceleration: [0, -9.8, 0],
      groundKill: false,
      sizeCurve: 'easeOut', scaleStart: 1.0, scaleEnd: 0.2, meshSize: 0.05,
      alphaCurve: 'easeOut', alphaStart: 0.85, alphaEnd: 0.0,
      colorStart: [0.7, 0.9, 1.0], colorEnd: [0.9, 0.97, 1.0],
      additive: false,
    }, { worldPos: guide.origin.toArray() });
    if (emitter) emitter.userData = { globalPartId };
    return emitter;
  }

  /**
   * Create or rebuild water for a selected render part.
   * @param {object} cfg
   * @param {string} cfg.modelId
   * @param {string} cfg.globalPartId
   * @param {object} cfg.ref
   * @param {THREE.Object3D} cfg.rootGroup
   * @param {number} [cfg.resolution=512]
   * @param {'pool'|'fall'} [cfg.kind='pool']
   * @returns {WaterSurface|WaterfallSurface|null}
   */
  /**
   * Create ONE merged WaterSurface from multiple spatially-adjacent pool parts.
   * ponytail: Group footprint meshes → one mask → one surface. No new abstractions.
   * @param {{ modelId:string, entries:{partId:string,group:THREE.Object3D,source:THREE.Mesh}[] }} cfg
   * @returns {WaterSurface|null}
   */
  createMergedPool({ modelId, entries, resolution = 512, containerBottom = null, surfaceReference = null }) {
    if (!entries?.length) return null;
    const reference = surfaceReference || selectMergedPoolReference(entries);
    if (!reference?.entry?.group || !reference.entry.source) return null;
    // Build a Group of all footprint meshes → createMaskFromObject renders them as one.
    const mergedGroup = new THREE.Group();
    const rootGroup = reference.entry.group;
    const globalPartId = `${modelId}:${reference.entry.partId}`;
    for (const entry of entries) {
      const fm = this._buildFootprintMesh({ object: entry.source });
      if (fm) mergedGroup.add(fm);
    }
    if (mergedGroup.children.length === 0) return null;

    this.disposePart(globalPartId);
    const { canvas, size, center, bottom } = createMaskFromObject(this.renderer, mergedGroup, resolution);
    // ponytail: dispose ONLY materials — geometry is shared with source part, do NOT dispose.
    for (const child of [...mergedGroup.children]) {
      child.material?.dispose?.();
    }
    reference.entry.source.updateWorldMatrix(true, false);
    return this._createWaterFromMask({
      modelId, globalPartId, rootGroup, canvas, size, center, top: reference.bounds.max.y, bottom,
      sourceGeometry: reference.entry.source.geometry,
      sourceWorldMatrix: reference.entry.source.matrixWorld.clone(),
      containerBottom,
    });
  }

  create({ modelId, globalPartId, ref, rootGroup, resolution = 512, kind = 'pool' }) {
    if (!globalPartId || !ref || !rootGroup) return null;
    this.disposePart(globalPartId);

    const footprintMesh = this._buildFootprintMesh(ref);
    if (!footprintMesh) return null;

    if (kind === 'fall') {
      const waterfall = this._createWaterfallFromPart({ modelId, globalPartId, rootGroup, footprintMesh });
      footprintMesh.material.dispose();
      return waterfall;
    }
    const { canvas, size, center, top, bottom } = createMaskFromObject(this.renderer, footprintMesh, resolution);
    // Phase F: keep the part's real geometry + baked world matrix for the submerged
    // body before disposing the footprint helper (geometry is shared with the source,
    // cloned inside _buildPoolBody so its lifetime is independent).
    const sourceGeometry = footprintMesh.geometry;
    const sourceWorldMatrix = footprintMesh.matrixWorld.clone();
    footprintMesh.material.dispose();
    return this._createWaterFromMask({
      modelId, globalPartId, rootGroup, canvas, size, center, top, bottom,
      sourceGeometry, sourceWorldMatrix,
    });
  }

  /**
   * Create or rebuild water for an entire selected model root.
   * @param {object} cfg
   * @param {string} cfg.modelId
   * @param {THREE.Object3D} cfg.rootGroup
   * @param {number} [cfg.resolution=512]
   * @returns {WaterSurface|null}
   */
  createForModel({ modelId, rootGroup, resolution = 512 }) {
    if (!modelId || !rootGroup) return null;
    const globalPartId = `model:${modelId}`;
    this.disposePart(globalPartId);
    rootGroup.updateWorldMatrix(true, true);
    const { canvas, size, center, top, bottom } = createMaskFromObject(this.renderer, rootGroup, resolution);
    return this._createWaterFromMask({ modelId, globalPartId: `model:${modelId}`, rootGroup, canvas, size, center, top, bottom });
  }

  update(deltaTime, camera) {
    for (const { water } of this._instances.values()) {
      water.update(deltaTime, camera, null);
    }
  }

  disposePart(globalPartId) {
    const entry = this._instances.get(globalPartId);
    if (!entry) return;
    this._instances.delete(globalPartId);
    const mesh = entry.water.mesh;
    mesh?.parent?.remove(mesh);
    entry.water.dispose();
    if (entry.skirt) {
      entry.skirt.parent?.remove(entry.skirt);
      entry.skirt.geometry.dispose();
      entry.skirt.material.dispose();
    }
    if (entry.bottom) {
      entry.bottom.parent?.remove(entry.bottom);
      entry.bottom.geometry.dispose();
      entry.bottom.material.dispose();
    }
    if (entry.jetEmitter) {
      this.getParticleEngine?.()?.remove?.(entry.jetEmitter);
    }
  }

  disposeModel(modelId) {
    for (const [gid, entry] of [...this._instances.entries()]) {
      if (entry.modelId === modelId) this.disposePart(gid);
    }
  }

  disposeAll() {
    for (const gid of [...this._instances.keys()]) this.disposePart(gid);
  }
}
