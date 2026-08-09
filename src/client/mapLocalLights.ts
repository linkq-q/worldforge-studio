import * as THREE from 'three';
import type { EditableMap, MapAsset, MapObject } from '../shared/map';
import { isMaterialTagEnabled } from '../shared/materialTagPolicy';

export const MAX_VISIBLE_MAP_LOCAL_LIGHTS = 8;

interface LightCandidate {
  group: THREE.Object3D;
  height: number;
  color: THREE.ColorRepresentation;
  intensity: number;
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
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const candidates = map.objects.flatMap((object) => {
    const objectGroup = objectGroups.get(object.id);
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (!object.visible || !objectGroup || !asset) return [];
    const glow = modelGlow(asset, map);
    return glow ? [{
      group: objectGroup,
      height: localLightHeight(object, asset),
      color: glow.color,
      intensity: glow.intensity
    }] : [];
  });
  const lights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_LOCAL_LIGHTS, candidates.length) }, () => {
    const light = new THREE.PointLight(0xffc46b, 0, 12, 2);
    light.castShadow = false;
    light.visible = false;
    group.add(light);
    return light;
  });
  const position = new THREE.Vector3();
  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
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
        .filter((entry) => frustum.containsPoint(entry.world))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, lights.length);
      lights.forEach((light, index) => {
        const entry = selected[index];
        light.visible = Boolean(entry);
        if (!entry) return;
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = entry.candidate.intensity;
      });
    }
  };
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
