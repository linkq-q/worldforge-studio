import * as THREE from 'three';
import { getMapBounds, getSunPosition, type EditableMap } from '../shared/map';

export function configureSunLight(light: THREE.DirectionalLight, target: THREE.Object3D, map: EditableMap): void {
  const [x, y, z] = getSunPosition(map);
  const bounds = getMapBounds(map);
  const [width, height, depth] = map.box.size;
  const radius = Math.sqrt(width * width + height * height + depth * depth) * 0.5 + 8;
  const centerY = bounds.minY + height * 0.35;

  light.position.set(x, y, z);
  light.target = target;
  target.position.set(0, centerY, 0);
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
