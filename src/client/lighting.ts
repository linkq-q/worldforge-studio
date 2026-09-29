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
