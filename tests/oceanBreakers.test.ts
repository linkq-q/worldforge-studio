import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { OceanBreakers, configureOceanSeaState, createOceanWaveUniforms, sampleOceanWaveDisplacement } from '@voxel-studio/render-runtime/environment';

function fixture() {
  const uniforms: Record<string, { value: unknown }> = { ...createOceanWaveUniforms(), uTime: { value: 0 }, uWhitecapEnabled: { value: true } };
  configureOceanSeaState(uniforms, 'large', { foamStrength: 0.8 });
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 3, 0);
  const breakers = new OceanBreakers(uniforms);
  return { uniforms, camera, breakers };
}

describe('bounded ocean breaking-wave companions', () => {
  it('requires the host sea-state gate and honors spectrum, foam and whitecap disabling', () => {
    const { uniforms, camera, breakers } = fixture();
    breakers.update(camera, 1);
    expect(breakers.group.visible).toBe(false);
    breakers.enabled = true; breakers.update(camera, 1);
    expect(breakers.group.visible).toBe(true);
    expect(breakers.ribbon.geometry.instanceCount).toBeGreaterThan(0);
    for (const [name, disabled] of [['uOceanCrestFoamStrength', 0], ['uOceanSpectrumHeight', 0], ['uOceanSpectrumEnabled', false], ['uWhitecapEnabled', false]] as const) {
      const uniform = uniforms[name]; const previous = uniform.value;
      uniform.value = disabled; breakers.update(camera, 1);
      expect(breakers.group.visible, name).toBe(false);
      uniform.value = previous;
    }
    // The host owns the exact preset identity, even if a light preset is scaled up.
    configureOceanSeaState(uniforms, 'light', { strength: 1.5 });
    breakers.enabled = false; breakers.update(camera, 1);
    expect(breakers.group.visible).toBe(false);
    configureOceanSeaState(uniforms, 'custom');
    breakers.enabled = true; breakers.update(camera, 1);
    expect(breakers.group.visible).toBe(false);
    breakers.dispose();
  });

  it('places every active strip on a moving primary crest using the shared wave field', () => {
    const { uniforms, camera, breakers } = fixture(); breakers.enabled = true;
    let tested = 0;
    for (const time of [0, 0.7, 2.1, 4.2]) {
      breakers.update(camera, time);
      const origin = breakers.ribbon.geometry.getAttribute('aCrestOrigin');
      const dimensions = breakers.ribbon.geometry.getAttribute('aBreaker');
      const wave = (uniforms.uOceanWaveComponents.value as THREE.Vector4[])[0], motion = (uniforms.uOceanWaveMotion.value as THREE.Vector4[])[0];
      for (let i = 0; i < breakers.ribbon.geometry.instanceCount; i++) {
        const x = origin.getX(i), z = origin.getY(i);
        const phase = (x * wave.x + z * wave.y) * wave.w + time * Math.sqrt(9.81 * wave.w) * motion.x + motion.y;
        expect(Math.sin(phase)).toBeCloseTo(1, 5);
        const displacement = sampleOceanWaveDisplacement(uniforms, x, z, time);
        expect(displacement[1]).toBeGreaterThan(0);
        expect(dimensions.getZ(i)).toBeLessThanOrEqual(displacement[1] * 0.9 + 0.0001);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(10);
    breakers.dispose();
  });

  it('has attached feet, an overhanging lip, an inner return and finite sheet thickness', () => {
    const { breakers } = fixture();
    const profile = breakers.ribbon.geometry.getAttribute('aProfile');
    const row = breakers.ribbon.geometry.getAttribute('position');
    const curve: THREE.Vector2[] = [];
    for (let i = 0; i < row.count && row.getX(i) === 0; i++) curve.push(new THREE.Vector2(profile.getX(i), profile.getY(i)));
    expect(curve.length).toBeGreaterThanOrEqual(20);
    expect(curve[0].y).toBe(0); expect(curve.at(-1)!.y).toBe(0);
    expect(Math.max(...curve.map(point => point.y))).toBeGreaterThan(0.9);
    const outerLip = curve.findIndex(point => point.x > 0.7 && point.y > 0.3);
    expect(outerLip).toBeGreaterThan(0);
    expect(curve.slice(outerLip + 1).some(point => point.x < 0 && point.y > 0.5)).toBe(true);
    expect(curve.slice(outerLip + 1).some(point => point.x > 0.6 && point.x < 0.75 && point.y > 0.2 && point.y < 0.6)).toBe(true);
    breakers.dispose();
  });

  it('reuses two fixed geometry buffers and bounds near-view strips and ballistic spray through time', () => {
    const { camera, breakers } = fixture(); breakers.enabled = true;
    const stripGeometry = breakers.ribbon.geometry, sprayGeometry = breakers.spray.geometry;
    let visibleSpray = 0;
    for (let step = 0; step < 60; step++) {
      camera.position.x = step * 0.2; breakers.update(camera, step * 0.15);
      expect(breakers.ribbon.geometry).toBe(stripGeometry); expect(breakers.spray.geometry).toBe(sprayGeometry);
      expect(stripGeometry.instanceCount).toBeLessThanOrEqual(12);
      expect(sprayGeometry.drawRange.count).toBeLessThanOrEqual(96);
      const life = stripGeometry.getAttribute('aBreaker');
      for (let i = 0; i < stripGeometry.instanceCount; i++) {
        expect(life.getX(i)).toBeGreaterThanOrEqual(0);
        expect(life.getX(i)).toBeLessThan(life.getY(i));
      }
      visibleSpray = Math.max(visibleSpray, sprayGeometry.drawRange.count);
    }
    expect(visibleSpray).toBeGreaterThan(0);
    expect(breakers.group.children).toHaveLength(2);
    for (const object of breakers.group.children) {
      expect(object.userData.isWater).toBe(true); expect(object.userData.skipShaderApply).toBe(true);
    }
    expect(breakers.ribbon.material.forceSinglePass).toBe(true);
    breakers.dispose();
  });

  it('owns and releases its buffers and materials without disposing shared ocean uniforms', () => {
    const { breakers } = fixture(); const parent = new THREE.Group(); parent.add(breakers.group);
    const disposals = [breakers.ribbon, breakers.spray].flatMap(object => [object.geometry, object.material]).map(resource => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener;
    });
    breakers.dispose(); breakers.dispose();
    expect(parent.children).toHaveLength(0);
    for (const listener of disposals) expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps launched droplets detached from the advancing crest', () => {
    const { uniforms, camera, breakers } = fixture(); breakers.enabled = true;
    configureOceanSeaState(uniforms, 'moderate', { foamStrength: 0.8 });
    let time = 0;
    for (; time < 5; time += 0.1) {
      breakers.update(camera, time);
      if (breakers.spray.geometry.drawRange.count > 4) break;
    }
    const position = breakers.spray.geometry.getAttribute('position'), flight = breakers.spray.geometry.getAttribute('aFlight');
    const births = Array.from({ length: breakers.spray.geometry.drawRange.count }, (_, i) => ({
      point: new THREE.Vector3().fromBufferAttribute(position, i), age: flight.getW(i)
    }));
    breakers.update(camera, time + 0.01);
    let stable = 0;
    for (let i = 0; i < breakers.spray.geometry.drawRange.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(position, i);
      if (births.some(birth => point.distanceTo(birth.point) < 0.0001 && Math.abs(flight.getW(i) - birth.age - 0.01) < 0.0001)) stable++;
    }
    expect(stable).toBeGreaterThanOrEqual(Math.min(births.length, breakers.spray.geometry.drawRange.count) * 0.8);
    breakers.dispose();
  });
});
