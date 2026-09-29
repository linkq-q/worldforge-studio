import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPatchGeometry } from '@voxel-studio/render-runtime/batching/PrimitiveGeometryBuilders.js';
import { buildModelGroup, type ModelRuntime } from './modelRenderer';
import type { TownBuilding, WorldBundle } from '../shared/worldPlanning';
import type { WorldSample } from '../shared/worldTerrain';

export type WorldAssetRole = 'house' | 'shop' | 'workshop' | 'tree' | 'landmark';
export interface WorldAssetSource { id: string; name: string; role: WorldAssetRole; modelJson: unknown }
export interface WorldAssetPrototype {
  id: string; name: string; role: WorldAssetRole; geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; size: THREE.Vector3;
}
export interface WorldAssetLibrary {
  byId: Map<string, WorldAssetPrototype>;
  byRole: Record<WorldAssetRole, WorldAssetPrototype[]>;
}
export type WorldBuildingPlacement = TownBuilding & { x: number; z: number; townId?: string };

const localRuntime: ModelRuntime = {
  buildGeometry(type, params) {
    const number = (key: string, fallback: number) => Number(params[key] ?? fallback);
    if (type === 'box') return new THREE.BoxGeometry(number('width', 1), number('height', 1), number('depth', 1));
    if (type === 'sphere') return new THREE.SphereGeometry(number('radius', 1), number('widthSegments', 8), number('heightSegments', 6));
    if (type === 'cylinder') return new THREE.CylinderGeometry(number('radiusTop', 1), number('radiusBottom', 1), number('height', 1), number('radialSegments', 8));
    if (type === 'cone') return new THREE.ConeGeometry(number('radius', 1), number('height', 1), number('radialSegments', 8));
    if (type === 'torus') return new THREE.TorusGeometry(number('radius', 1), number('tube', .3), number('radialSegments', 8), number('tubularSegments', 12));
    if (type === 'icosahedron') return new THREE.IcosahedronGeometry(number('radius', 1), number('detail', 0));
    if (type === 'dodecahedron') return new THREE.DodecahedronGeometry(number('radius', 1), number('detail', 0));
    if (type === 'octahedron') return new THREE.OctahedronGeometry(number('radius', 1), number('detail', 0));
    if (type === 'patch') return buildPatchGeometry(THREE, params);
    throw new Error('unsupported_preview_geometry:' + type);
  },
  evaluateMotion: () => ({})
};

const roles = ['house', 'shop', 'workshop', 'tree', 'landmark'] as const;
const supportedGeometry = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosahedron', 'dodecahedron', 'octahedron', 'patch']);
const emptyRoleMap = (): Record<WorldAssetRole, WorldAssetPrototype[]> => ({ house: [], shop: [], workshop: [], tree: [], landmark: [] });

export async function buildWorldAssetLibrary(sources: WorldAssetSource[]): Promise<WorldAssetLibrary> {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 32
    || new Set(sources.map(asset => asset.id)).size !== sources.length
    || sources.some(asset => !asset.id || !roles.includes(asset.role))) throw new Error('invalid_preview_asset_pack');
  const library: WorldAssetLibrary = { byId: new Map(), byRole: emptyRoleMap() };
  try {
    for (const asset of sources) {
      const nodes = (asset.modelJson as { nodes?: Array<{ mesh?: { type?: string } }> })?.nodes;
      if (!nodes?.some(node => node.mesh) || nodes.some(node => node.mesh && !supportedGeometry.has(node.mesh.type ?? ''))) throw new Error('unsupported_preview_asset:' + asset.id);
      const template = await buildModelGroup(asset.modelJson, localRuntime);
      template.updateMatrixWorld(true);
      const parts: THREE.BufferGeometry[] = [];
      try {
        template.traverse(child => {
          if (!(child instanceof THREE.Mesh)) return;
          const material = child.material as THREE.MeshStandardMaterial;
          if (Array.isArray(material) || material.transparent || material.opacity < 1) throw new Error('nonopaque_preview_asset:' + asset.id);
          const geometry = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrixWorld);
          for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal'].includes(name)) geometry.deleteAttribute(name);
          if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
          const colors = new Float32Array(geometry.getAttribute('position').count * 3);
          for (let i = 0; i < colors.length; i += 3) colors.set(material.color.toArray(), i);
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.clearGroups(); parts.push(geometry);
        });
        const geometry = mergeGeometries(parts);
        if (!geometry) throw new Error('preview_asset_merge_failed:' + asset.id);
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        const prototype: WorldAssetPrototype = {
          id: asset.id, name: asset.name, role: asset.role, geometry,
          material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, side: THREE.DoubleSide }),
          size: geometry.boundingBox!.getSize(new THREE.Vector3())
        };
        library.byId.set(asset.id, prototype); library.byRole[asset.role].push(prototype);
      } finally {
        parts.forEach(geometry => geometry.dispose());
        template.traverse(child => {
          if (child instanceof THREE.Mesh) { child.geometry.dispose(); for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose(); }
        });
      }
    }
    return library;
  } catch (error) { disposeWorldAssetLibrary(library); throw error; }
}

export function disposeWorldAssetLibrary(library: WorldAssetLibrary) {
  for (const model of library.byId.values()) { model.geometry.dispose(); model.material.dispose(); }
  library.byId.clear(); for (const role of roles) library.byRole[role] = [];
}

export function buildingAssetRole(building: TownBuilding): Exclude<WorldAssetRole, 'tree' | 'landmark'> {
  return /工|仓|农具/.test(building.use) ? 'workshop' : /商|店|客/.test(building.use) ? 'shop' : 'house';
}

function stableIndex(id: string, count: number): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return count ? (hash >>> 0) % count : 0;
}

export function pickWorldAsset(library: WorldAssetLibrary, building: TownBuilding): WorldAssetPrototype | undefined {
  if (building.assetKey) return library.byId.get(building.assetKey);
  const variants = library.byRole[buildingAssetRole(building)];
  return variants[stableIndex(building.id, variants.length)];
}

export function pickWorldTreeAsset(library: WorldAssetLibrary, id: string): WorldAssetPrototype | undefined {
  const variants = library.byRole.tree;
  return variants[stableIndex(id, variants.length)];
}

export function worldAssetBuildingMatrix(
  building: WorldBuildingPlacement,
  sample: (x: number, z: number) => WorldSample,
  model: WorldAssetPrototype,
  target = new THREE.Object3D()
): THREE.Matrix4 {
  const scale = Math.min(building.width / model.size.x, building.depth / model.size.z);
  target.position.set(building.x, sample(building.x, building.z).height, building.z);
  target.rotation.set(0, building.rotation ?? 0, 0); target.scale.setScalar(scale); target.updateMatrix();
  return target.matrix;
}

export function buildWorldAssetBuildingPlacements(
  placements: WorldBuildingPlacement[], sample: (x: number, z: number) => WorldSample, library: WorldAssetLibrary
): THREE.Group {
  const root = new THREE.Group();
  const selected = placements.map(building => ({ building, model: pickWorldAsset(library, building) })).filter(entry => entry.model);
  for (const model of library.byId.values()) {
    const entries = selected.filter(entry => entry.model === model);
    if (!entries.length || model.role === 'tree') continue;
    const mesh = new THREE.InstancedMesh(model.geometry, model.material, entries.length), transform = new THREE.Object3D();
    mesh.name = model.name; mesh.userData.sharedWorldAsset = true; mesh.userData.buildingIds = entries.map(entry => entry.building.id);
    entries.forEach((entry, index) => mesh.setMatrixAt(index, worldAssetBuildingMatrix(entry.building, sample, model, transform)));
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  }
  return root;
}

export function buildWorldAssetBuildings(bundle: WorldBundle, sample: (x: number, z: number) => WorldSample, library: WorldAssetLibrary): THREE.Group {
  const placements = bundle.patches.flatMap(patch => {
    const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId)!;
    return patch.buildings.map(building => ({ ...building, x: building.x + town.center[0], z: building.z + town.center[1], townId: town.id }));
  });
  return buildWorldAssetBuildingPlacements(placements, sample, library);
}

