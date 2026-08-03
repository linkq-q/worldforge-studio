import * as THREE from 'three';
import type { EditableMap } from '../shared/map';
import type { AtmosphereFxKind, CompiledAtmosphereFx } from '../shared/atmosphereFx';

type ParticleKind = 'pollen' | 'vapor' | 'dust';

interface ParticleLayer {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  origins: Float32Array;
  zoneRadii: Float32Array;
}

const BUDGETS: Record<ParticleKind, number> = { pollen: 240, vapor: 96, dust: 140 };

/** Three bounded particle draws for map-owned regional ambience. */
export class AtmosphereFxRuntime {
  readonly group = new THREE.Group();
  private readonly layers = new Map<ParticleKind, ParticleLayer>();
  private state: CompiledAtmosphereFx | null = null;
  private quality = 1;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'worldforge-atmosphere-fx';
    this.group.userData.isEnvironmentObject = true;
    this.group.userData.skipShaderApply = true;
    this.group.userData.skipNormalDepthPrePass = true;
    this.scene.add(this.group);
  }

  apply(map: EditableMap, state: CompiledAtmosphereFx): void {
    this.clearLayers();
    this.state = state;
    for (const kind of ['pollen', 'vapor', 'dust'] as const) {
      if (state.channels[kind] <= 0 || state.zones[kind].length === 0) continue;
      const count = Math.max(1, Math.round(BUDGETS[kind] * state.channels[kind] * this.quality));
      const positions = new Float32Array(count * 3);
      const origins = new Float32Array(count * 3);
      const zoneRadii = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        const zone = state.zones[kind][index % state.zones[kind].length];
        const angle = random(map.seed, `${kind}:angle:${index}`) * Math.PI * 2;
        const radius = Math.sqrt(random(map.seed, `${kind}:radius:${index}`)) * zone.radius;
        const x = zone.center[0] + Math.cos(angle) * radius;
        const z = zone.center[1] + Math.sin(angle) * radius;
        const y = particleHeight(kind, random(map.seed, `${kind}:height:${index}`));
        positions.set([x, y, z], index * 3);
        origins.set([zone.center[0], 0, zone.center[1]], index * 3);
        zoneRadii[index] = zone.radius;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: particleColor(kind),
        size: particleSize(kind),
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.34 + state.channels[kind] * 0.38,
        depthWrite: false,
        blending: kind === 'vapor' ? THREE.NormalBlending : THREE.AdditiveBlending
      });
      const points = new THREE.Points(geometry, material);
      points.name = `atmosphere-${kind}`;
      points.frustumCulled = false;
      this.group.add(points);
      this.layers.set(kind, { points, origins, zoneRadii });
    }
  }

  setQuality(quality: number): void {
    this.quality = THREE.MathUtils.clamp(quality, 0.2, 1);
  }

  update(deltaTime: number, elapsedSeconds: number): void {
    if (!this.state) return;
    const wind = this.state.wind;
    const gust = 1 + Math.sin(elapsedSeconds * wind.gustFrequency * Math.PI * 2) * wind.gustStrength;
    for (const [kind, layer] of this.layers) {
      const positions = layer.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const drift = wind.speed * gust * deltaTime * (kind === 'vapor' ? 0.18 : 0.55);
      for (let index = 0; index < positions.count; index += 1) {
        let x = positions.getX(index) + wind.direction[0] * drift;
        let y = positions.getY(index) + Math.sin(elapsedSeconds * 0.8 + index) * deltaTime * 0.025;
        let z = positions.getZ(index) + wind.direction[1] * drift;
        const offset = index * 3;
        const ox = layer.origins[offset];
        const oz = layer.origins[offset + 2];
        const radius = layer.zoneRadii[index];
        if (Math.hypot(x - ox, z - oz) > radius) {
          x = ox - wind.direction[0] * radius * 0.85;
          z = oz - wind.direction[1] * radius * 0.85;
        }
        if (kind !== 'vapor' && y > 4.5) y = 0.25;
        positions.setXYZ(index, x, y, z);
      }
      positions.needsUpdate = true;
    }
  }

  getStats(): { particles: number; drawCalls: number; quality: number } {
    let particles = 0;
    for (const layer of this.layers.values()) particles += layer.points.geometry.getAttribute('position').count;
    return { particles, drawCalls: this.layers.size, quality: this.quality };
  }

  dispose(): void {
    this.clearLayers();
    this.scene.remove(this.group);
  }

  private clearLayers(): void {
    for (const layer of this.layers.values()) {
      this.group.remove(layer.points);
      layer.points.geometry.dispose();
      layer.points.material.dispose();
    }
    this.layers.clear();
  }
}

function particleHeight(kind: ParticleKind, unit: number): number {
  if (kind === 'vapor') return 0.2 + unit * 0.75;
  return 0.35 + unit * (kind === 'pollen' ? 3.8 : 2.6);
}

function particleColor(kind: ParticleKind): string {
  return kind === 'pollen' ? '#f3d58a' : kind === 'vapor' ? '#d8edf0' : '#d3ae78';
}

function particleSize(kind: ParticleKind): number {
  return kind === 'pollen' ? 0.12 : kind === 'vapor' ? 0.55 : 0.16;
}

function random(seed: number, key: string): number {
  let hash = seed | 0;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  hash += 0x6d2b79f5;
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1);
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61);
  return ((hash ^ (hash >>> 14)) >>> 0) / 4294967296;
}
