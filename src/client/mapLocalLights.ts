import * as THREE from 'three';
import type { EditableMap, MapAsset, MapObject } from '../shared/map';
import type { MapAssetLight } from '../shared/mapAssetMetadata';
import { isMaterialTagEnabled } from '../shared/materialTagPolicy';

export const MAX_VISIBLE_MAP_POINT_LIGHTS = 6;
export const MAX_VISIBLE_MAP_SPOT_LIGHTS = 2;
export const MAX_VISIBLE_MAP_LOCAL_LIGHTS = MAX_VISIBLE_MAP_POINT_LIGHTS + MAX_VISIBLE_MAP_SPOT_LIGHTS;
const MAP_LOCAL_LIGHT_DISTANCE = 12;

export interface MapLocalLightCandidateInfo {
  objectId: string;
  color: THREE.ColorRepresentation;
  intensity: number;
  range: number;
  offset: [number, number, number];
  direction: [number, number, number];
  coneAngleDegrees: number;
  penumbra: number;
  priority: number;
  kind: 'point' | 'spot';
}

export interface MapLocalLights {
  group: THREE.Group;
  update(camera: THREE.Camera): void;
}

/** Derives a bounded Three.js light rig from lamp semantics and material tags. */
export function buildMapLocalLights(
  map: EditableMap,
  objectGroups: ReadonlyMap<string, THREE.Group>
): MapLocalLights {
  const group = new THREE.Group();
  group.name = 'mapLocalLights';
  const candidates = analyzeMapLocalLightCandidates(map).flatMap((info) => {
    const objectGroup = objectGroups.get(info.objectId);
    return objectGroup ? [{
      group: objectGroup,
      color: info.color,
      intensity: info.intensity,
      range: info.range,
      offset: info.offset,
      direction: info.direction,
      coneAngleDegrees: info.coneAngleDegrees,
      penumbra: info.penumbra,
      priority: info.priority,
      kind: info.kind
    }] : [];
  });
  const pointCandidates = candidates.filter((candidate) => candidate.kind === 'point');
  const spotCandidates = candidates.filter((candidate) => candidate.kind === 'spot');
  const pointLights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_POINT_LIGHTS, pointCandidates.length) }, () => {
    const light = new THREE.PointLight(0xffc46b, 0, MAP_LOCAL_LIGHT_DISTANCE, 2);
    light.castShadow = false;
    // Keep the light count stable so camera movement does not compile a new
    // material shader variant whenever an emitter crosses the viewport edge.
    light.visible = true;
    group.add(light);
    return light;
  });
  const spotLights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_SPOT_LIGHTS, spotCandidates.length) }, () => {
    const light = new THREE.SpotLight(0xffd69a, 0, MAP_LOCAL_LIGHT_DISTANCE, Math.PI / 5, 0.45, 2);
    light.castShadow = false;
    light.visible = true;
    light.target.name = 'mapLocalLightTarget';
    light.target.position.set(0, -3, 0);
    light.add(light.target);
    group.add(light);
    return light;
  });
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const influence = new THREE.Sphere(new THREE.Vector3(), MAP_LOCAL_LIGHT_DISTANCE);
  return {
    group,
    update: (camera) => {
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection);
      const visibleCandidates = candidates
        .map((candidate) => {
          candidate.group.getWorldPosition(position);
          candidate.group.getWorldQuaternion(rotation);
          const world = new THREE.Vector3(...candidate.offset).applyQuaternion(rotation).add(position);
          const direction = new THREE.Vector3(...candidate.direction).applyQuaternion(rotation).normalize();
          return { candidate, world, direction, distance: world.distanceToSquared(camera.position) };
        })
        // The emitter may be outside the picture while its light still reaches
        // visible surfaces. Cull the influence volume, not the bulb position.
        .filter((entry) => frustum.intersectsSphere(influence.set(entry.world, entry.candidate.range)))
        .sort((left, right) => right.candidate.priority - left.candidate.priority || left.distance - right.distance);
      const selectedPoints = visibleCandidates.filter((entry) => entry.candidate.kind === 'point').slice(0, pointLights.length);
      const selectedSpots = visibleCandidates.filter((entry) => entry.candidate.kind === 'spot').slice(0, spotLights.length);
      group.visible = selectedPoints.length + selectedSpots.length > 0;
      pointLights.forEach((light, index) => {
        const entry = selectedPoints[index];
        if (!entry) {
          light.intensity = 0;
          return;
        }
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = entry.candidate.intensity;
        light.distance = entry.candidate.range;
      });
      spotLights.forEach((light, index) => {
        const entry = selectedSpots[index];
        if (!entry) {
          light.intensity = 0;
          return;
        }
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = entry.candidate.intensity;
        light.distance = entry.candidate.range;
        light.angle = THREE.MathUtils.degToRad(entry.candidate.coneAngleDegrees);
        light.penumbra = entry.candidate.penumbra;
        light.target.position.copy(entry.direction).multiplyScalar(Math.max(2, entry.candidate.range * 0.4));
      });
    }
  };
}

/** Pure candidate analysis shared by the renderer and the derived-results inspector. */
export function analyzeMapLocalLightCandidates(map: EditableMap): MapLocalLightCandidateInfo[] {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  return map.objects.flatMap((object) => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (!object.visible || !asset) return [];
    const glow = modelLightProfile(asset, map);
    return glow ? [{
      objectId: object.id,
      color: glow.color,
      intensity: glow.intensity,
      range: glow.range,
      offset: glow.offset ?? [0, localLightHeight(object, asset), 0],
      direction: glow.direction ?? [0, -1, 0],
      coneAngleDegrees: glow.coneAngleDegrees ?? 40,
      penumbra: glow.penumbra ?? 0.4,
      priority: glow.priority,
      kind: glow.kind
    }] : [];
  });
}

function modelLightProfile(asset: MapAsset, map: EditableMap): {
  color: THREE.ColorRepresentation;
  intensity: number;
  range: number;
  offset?: [number, number, number];
  direction?: [number, number, number];
  coneAngleDegrees?: number;
  penumbra?: number;
  priority: number;
  kind: 'point' | 'spot';
} | null {
  if (asset.light) return lightContractProfile(asset.light);
  const legacy = legacyTaggedLight(asset);
  if (legacy) return legacy;
  const nodes = (asset.modelJson as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return null;
  let fireStrength = 0;
  let fireVariant = '';
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const tags = (node as { tags?: unknown }).tags;
    if (!Array.isArray(tags)) continue;
    for (const value of tags) {
      if (!isMaterialTagEnabled(value, map.materialTagPolicy)) continue;
      const tag = value && typeof value === 'object' ? value as { tag?: unknown; value?: unknown; variant?: unknown } : null;
      const strength = typeof tag?.value === 'number' ? THREE.MathUtils.clamp(tag.value, 0, 1) : 1;
      if (tag?.tag === 'fire') {
        fireStrength = Math.max(fireStrength, strength);
        fireVariant = typeof tag.variant === 'string' ? tag.variant : fireVariant;
      }
    }
  }
  if (fireStrength > 0.05) {
    return {
      color: fireVariant === 'blue' ? '#68a7ff' : fireVariant === 'green' ? '#70ef92' : '#ffad5c',
      intensity: 2 + fireStrength * 3,
      range: 10,
      priority: 2,
      kind: 'point'
    };
  }
  return null;
}

function lightContractProfile(light: MapAssetLight): NonNullable<ReturnType<typeof modelLightProfile>> {
  return {
    kind: light.kind,
    color: light.color,
    intensity: light.intensity,
    range: light.range,
    offset: light.offset,
    direction: light.direction,
    coneAngleDegrees: light.coneAngleDegrees,
    penumbra: light.penumbra,
    priority: 3
  };
}

function legacyTaggedLight(asset: MapAsset): NonNullable<ReturnType<typeof modelLightProfile>> | null {
  const tags = new Set(asset.tags ?? []);
  const spot = tags.has('spotlight') || tags.has('spot-light') || tags.has('track-light')
    || (tags.has('light') && (tags.has('track') || tags.has('downlight')));
  const fixture = spot || [...tags].some((tag) => (
    tag === 'light' || tag === 'lighting' || tag.endsWith('-light') || tag.endsWith('-lamp') || tag.endsWith('-lighting')
  ));
  if (!fixture) return null;
  const cool = [...tags].some((tag) => tag.includes('cool') || tag.includes('blue'));
  const ceiling = tags.has('ceiling') || tags.has('ceiling-mounted');
  return {
    kind: spot ? 'spot' : 'point',
    color: cool ? '#bfe8ff' : '#ffd8a0',
    intensity: spot ? 5 : 3,
    range: spot ? 9 : 7,
    offset: ceiling ? [0, -0.2, 0] : undefined,
    direction: spot ? [0, -1, 0] : undefined,
    coneAngleDegrees: spot ? 38 : undefined,
    penumbra: spot ? 0.45 : undefined,
    priority: 2
  };
}

function localLightHeight(object: MapObject, asset: MapAsset): number {
  const boxHeight = asset.colliderPlan.boxes.reduce(
    (height, box) => Math.max(height, box.max[1] - box.min[1]),
    object.transform.size[1]
  );
  return Math.max(0.4, boxHeight * object.transform.scale[1] * 0.55);
}
