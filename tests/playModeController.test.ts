import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';
import type { InputState } from '../src/shared/protocol';
import { MapGrassInteraction } from '../src/client/mapGrassInteraction';
import { stepPlayMotion, type PlayMotionState } from '../src/client/playModeController';

const FORWARD: InputState = {
  forward: true,
  backward: false,
  left: false,
  right: false,
  up: false,
  down: false,
  sprint: false,
  yaw: 0,
  pitch: 0
};

describe('first-person play mode', () => {
  it('moves from the capsule feet position and applies gravity/jump through map collision', () => {
    const map = createEmptyMap('游玩地图');
    const initial = state();
    const walked = stepPlayMotion(initial, FORWARD, 0.05, false, map);
    const jumped = stepPlayMotion(initial, FORWARD, 0.05, true, map);

    expect(walked.position[2]).toBeCloseTo(-0.21, 4);
    expect(walked.position[1]).toBe(0);
    expect(jumped.position[1]).toBeGreaterThan(0);
    expect(jumped.velocityY).toBeGreaterThan(0);
  });

  it('detects wading and slows the next movement step', () => {
    const map = createEmptyMap('池塘');
    map.waterBodies = [lake()];
    const entered = stepPlayMotion(state(), FORWARD, 0.05, false, map);
    const wadingStep = stepPlayMotion(entered, FORWARD, 0.05, false, map);

    expect(entered.wading).toBe(true);
    expect(entered.waterBodyId).toBe('lake-1');
    expect(Math.abs(wadingStep.position[2] - entered.position[2])).toBeCloseTo(0.21 * 0.62, 4);
  });

  it('bends grass in the shader without rewriting instance matrices', () => {
    const root = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    material.userData.grassUniforms = {};
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(), material, 2);
    mesh.userData.grassBladeCount = 2;
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0.4, 0, 0));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(8, 0, 0));
    root.add(mesh);
    const interaction = new MapGrassInteraction(root, 1.5);
    const before = Array.from(mesh.instanceMatrix.array);
    const shader: any = {
      uniforms: {},
      vertexShader: `#include <common>
uniform float uGrassNormalFlatten;
#include <begin_vertex>
transformed += grassLocalWind * (grassWave * uGrassWindStrength * vGrassBladeT * vGrassBladeT);
#include <defaultnormal_vertex>`,
      fragmentShader: ''
    };

    interaction.update([0, 0, 0], 1);
    material.onBeforeCompile(shader, {} as never);
    expect(shader.vertexShader).toContain('uGrassInteractionPosition');
    expect(shader.vertexShader).toContain('grassInteractionInfluence');
    expect(shader.uniforms).toHaveProperty('uGrassInteractionStrength');
    expect(shader.uniforms.uGrassInteractionStrength.value).toBe(0.48);
    expect(Array.from(mesh.instanceMatrix.array)).toEqual(before);
    interaction.restore();
    expect(shader.uniforms.uGrassInteractionStrength.value).toBe(0);
  });
});

function state(): PlayMotionState {
  return {
    position: [0, 0, 0],
    velocityY: 0,
    grounded: true,
    wading: false,
    waterBodyId: null
  };
}

function lake(): MapWaterBody {
  return {
    id: 'lake-1',
    name: '池塘',
    type: 'lake',
    level: 1,
    depth: 1,
    width: 2,
    points: [[-3, -3], [3, -3], [3, 3], [-3, 3]]
  };
}
