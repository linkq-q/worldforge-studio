import * as THREE from 'three';
import type { EditableMap, MapAsset, MapObject } from '../shared/map';
import { isMaterialTagEnabled } from '../shared/materialTagPolicy';

export const MAX_VISIBLE_MAP_LOCAL_LIGHTS = 2;
const MAP_LOCAL_LIGHT_DISTANCE = 12;

export interface MapLocalLightCandidateInfo {
  objectId: string;
  color: THREE.ColorRepresentation;
  intensity: number;
  height: number;
}

export interface MapLocalLights {
  group: THREE.Group;
  update(camera: THREE.Camera): void;
}

/** Derives a bounded light rig from visible fire/emissive model tags. */
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
      height: info.height,
      color: info.color,
      intensity: info.intensity
    }] : [];
  });
  const lights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_LOCAL_LIGHTS, candidates.length) }, () => {
    const light = new THREE.PointLight(0xffc46b, 0, MAP_LOCAL_LIGHT_DISTANCE, 2);
    light.castShadow = false;
    // Keep the light count stable so camera movement does not compile a new
    // material shader variant whenever an emitter crosses the viewport edge.
    light.visible = true;
    group.add(light);
    return light;
  });
  const position = new THREE.Vector3();
  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const influence = new THREE.Sphere(new THREE.Vector3(), MAP_LOCAL_LIGHT_DISTANCE);
  return {
    group,
    update: (camera) => {
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection);
      const selected = candidates
        .map((candidate) => {
          candidate.group.getWorldPosition(position);
          const world = position.clone();
          world.y += candidate.height;
          return { candidate, world, distance: world.distanceToSquared(camera.position) };
        })
        // The emitter may be outside the picture while its light still reaches
        // visible surfaces. Cull the influence volume, not the bulb position.
        .filter((entry) => frustum.intersectsSphere(influence.set(entry.world, MAP_LOCAL_LIGHT_DISTANCE)))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, lights.length);
      group.visible = selected.length > 0;
      lights.forEach((light, index) => {
        const entry = selected[index];
        if (!entry) {
          light.intensity = 0;
          return;
        }
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = entry.candidate.intensity;
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
    const glow = modelGlow(asset, map);
    return glow ? [{
      objectId: object.id,
      height: localLightHeight(object, asset),
      color: glow.color,
      intensity: glow.intensity
    }] : [];
  });
}

function modelGlow(asset: MapAsset, map: EditableMap): { color: THREE.ColorRepresentation; intensity: number } | null {
  const nodes = (asset.modelJson as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return null;
  let emissiveStrength = 0;
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
      if (tag?.tag === 'emissive') emissiveStrength = Math.max(emissiveStrength, strength);
      if (tag?.tag === 'fire') {
        fireStrength = Math.max(fireStrength, strength);
        fireVariant = typeof tag.variant === 'string' ? tag.variant : fireVariant;
      }
    }
  }
  if (fireStrength > 0.05) {
    return {
      color: fireVariant === 'blue' ? '#68a7ff' : fireVariant === 'green' ? '#70ef92' : '#ffad5c',
      intensity: 3 + fireStrength * 4
    };
  }
  return emissiveStrength > 0.05
    ? { color: '#ffd878', intensity: 2 + emissiveStrength * 3 }
    : null;
}

function localLightHeight(object: MapObject, asset: MapAsset): number {
  const boxHeight = asset.colliderPlan.boxes.reduce(
    (height, box) => Math.max(height, box.max[1] - box.min[1]),
    object.transform.size[1]
  );
  return Math.max(0.4, boxHeight * object.transform.scale[1] * 0.55);
}
