import * as THREE from 'three';
import { getMapBounds, getSunPosition, type EditableMap } from '../shared/map';
import type { Vec3 } from '../shared/protocol';

export function configureSunLight(
  light: THREE.DirectionalLight,
  target: THREE.Object3D,
  map: EditableMap,
  activeBounds?: { center: Vec3; size: Vec3 }
): void {
  const [x, y, z] = getSunPosition(map);
  const bounds = getMapBounds(map);
  const [width, height, depth] = activeBounds?.size ?? map.box.size;
  const center = activeBounds?.center ?? [0, 0, 0];
  const radius = Math.sqrt(width * width + height * height + depth * depth) * 0.5 + 8;
  const centerY = activeBounds ? center[1] + height * 0.35 : bounds.minY + height * 0.35;

  if (activeBounds) {
    const direction = new THREE.Vector3(x, y, z).normalize();
    light.position.set(center[0], centerY, center[2]).addScaledVector(direction, Math.max(80, radius * 1.25));
  } else light.position.set(x, y, z);
  light.target = target;
  target.position.set(center[0], centerY, center[2]);
  target.updateMatrixWorld();

  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.map?.setSize(2048, 2048);
  light.shadow.bias = -0.00012;
  light.shadow.normalBias = 0.035;
  light.shadow.radius = 2;

  const camera = light.shadow.camera;
  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  camera.near = 0.1;
  camera.far = Math.max(80, light.position.distanceTo(target.position) + radius * 2);
  camera.updateProjectionMatrix();
  light.shadow.needsUpdate = true;
}

/**
 * Optional outdoor fit. Angles are degrees; azimuth 0 is +Z and 90 is +X.
 * Call after content changes, not every frame. The caller uses PCFShadowMap
 * because Three's directional PCFSoftShadowMap does not use shadow.radius.
 * Returns false for content without visible shadow casters or receivers.
 */
export function configureOutdoorSunLight(
  light: THREE.DirectionalLight,
  target: THREE.Object3D,
  contentRoot: THREE.Object3D,
  azimuth: number,
  elevation: number,
  softness: number,
  shadowQuality = 1,
  maxShadowMapSize = 8192
): boolean {
  if (![azimuth, elevation, softness].every(Number.isFinite)) return false;
  contentRoot.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  const meshBounds = new THREE.Box3();
  contentRoot.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (!mesh.castShadow && !mesh.receiveShadow)) return;
    for (let ancestor: THREE.Object3D | null = mesh; ancestor; ancestor = ancestor.parent) {
      if (ancestor.userData.isHelper || ancestor.userData.isEditorObject || ancestor.userData.isEnvironmentObject
        || ancestor.userData.isOutline || ancestor.userData.shaderOutline) return;
      if (ancestor === contentRoot) break;
    }
    const instances = mesh as THREE.InstancedMesh;
    if (instances.isInstancedMesh) {
      // instanceMatrix can change without invalidating the cached aggregate box.
      instances.computeBoundingBox();
      if (!instances.boundingBox) return;
      meshBounds.copy(instances.boundingBox);
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      meshBounds.copy(mesh.geometry.boundingBox);
    }
    bounds.union(meshBounds.applyMatrix4(mesh.matrixWorld));
  });
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) return false;

  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() * 0.5);
  const margin = Math.max(0.75, radius * 0.01);
  const azimuthRadians = THREE.MathUtils.degToRad(azimuth);
  const elevationRadians = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevation, 2, 88));
  const direction = new THREE.Vector3(
    Math.sin(azimuthRadians) * Math.cos(elevationRadians),
    Math.sin(elevationRadians),
    Math.cos(azimuthRadians) * Math.cos(elevationRadians)
  );
  // Place the light outside the enclosing sphere so even the tallest caster
  // stays in front of its near plane, independently of the authored map height.
  const position = center.clone().addScaledVector(direction, radius + margin * 2);
  light.position.copy(light.parent ? light.parent.worldToLocal(position) : position);
  target.position.copy(target.parent ? target.parent.worldToLocal(center.clone()) : center);
  light.target = target;
  light.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  light.shadow.updateMatrices(light);

  const viewBounds = new THREE.Box3();
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) {
    for (const z of [bounds.min.z, bounds.max.z]) {
      viewBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(light.shadow.camera.matrixWorldInverse));
    }
  }
  const camera = light.shadow.camera;
  camera.left = viewBounds.min.x - margin;
  camera.right = viewBounds.max.x + margin;
  camera.bottom = viewBounds.min.y - margin;
  camera.top = viewBounds.max.y + margin;
  camera.near = Math.max(0.1, -viewBounds.max.z - margin);
  camera.far = Math.max(camera.near + 1, -viewBounds.min.z + margin);
  camera.updateProjectionMatrix();
  light.castShadow = true;
  const shadowMapSize = Math.min(shadowQuality >= 2 ? 8192 : 4096, maxShadowMapSize);
  light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  light.shadow.map?.setSize(shadowMapSize, shadowMapSize);
  // The opt-in receiver-plane filter needs only millimetres of residual bias.
  light.shadow.bias = shadowQuality >= 2 ? -0.002 / (camera.far - camera.near) : -0.00008;
  light.shadow.normalBias = shadowQuality >= 2 ? 0.003 : 0.02;
  light.shadow.radius = 1 + THREE.MathUtils.clamp(softness, 0, 1) * 4;
  light.shadow.updateMatrices(light);
  light.shadow.needsUpdate = true;
  return true;
}
