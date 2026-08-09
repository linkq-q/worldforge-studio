import * as THREE from 'three';
import { shouldSkipShaderApply } from '../utils/ShaderApplyGuard.js';

export const SHADER_CATEGORIES = ['building', 'glass', 'default'];
const CATEGORY_SET = new Set(SHADER_CATEGORIES);

export const OUTLINE_MESH_NAME = '__outlineMesh__';

/**
 * 判断对象是否属于用户内容（应参与材质替换）
 */
export function isUserContentObject(obj) {
  return obj.userData?.isUserContent === true
    || obj.userData?.isStaticBatchMesh === true
    || obj.parent?.userData?.isModelRoot === true;
}

/**
 * 判断对象是否受保护（不应参与材质替换）
 */
export function isProtectedRenderObject(obj) {
  return (
    obj.userData?.isEnvironment === true ||
    obj.userData?.isEnvironmentObject === true ||
    obj.userData?.isSky === true ||
    obj.userData?.isWater === true ||
    obj.userData?.isHelper === true ||
    obj.userData?.isGizmo === true ||
    obj.userData?.skipShaderApply === true
    || obj.userData?.skipShaderLibrary === true
  );
}

export function isRenderableMesh(object) {
  return !!(object && (object.isMesh || object.isInstancedMesh));
}

export function isOutlineMesh(object) {
  return object?.name === OUTLINE_MESH_NAME || object?.userData?.shaderOutline === true || object?.userData?.isOutline === true;
}

export function cloneMaterial(material) {
  if (!material) return null;
  if (Array.isArray(material)) return material.map(item => item.clone());
  return material.clone();
}

function firstMaterial(material) {
  return Array.isArray(material) ? material[0] : material;
}

export function getMaterialColor(material) {
  const source = firstMaterial(material);
  if (source?.color instanceof THREE.Color) return source.color.clone();
  if (source?.uniforms?.uColor?.value instanceof THREE.Color) {
    return source.uniforms.uColor.value.clone();
  }
  return new THREE.Color(0.8, 0.8, 0.8);
}

const NAME_RULES = [
  { category: 'glass', keywords: ['glass', 'window', 'pane', 'glazing'] },
  {
    category: 'building',
    keywords: ['wall', 'pillar', 'roof', 'stone', 'rock', 'fence', 'ground', 'floor', 'earth', 'sand', 'path', 'water', 'pond', 'river', 'lake', 'ocean', 'sea', 'pool', 'lantern', 'light', 'glow', 'lamp'],
  },
];

const TYPE_DEFAULTS = new Map([
  ['box', 'building'],
  ['cylinder', 'building'],
  ['cone', 'building'],
  ['sphere', 'building'],
  ['torus', 'building'],
  ['icosahedron', 'building'],
]);

function meshType(mesh) {
  return mesh?.userData?.node?.type || mesh?.userData?.type || mesh?.geometry?.type || '';
}

function getWorldNameHaystack(mesh) {
  const parts = [];
  let object = mesh;
  while (object) {
    parts.push(object.name, object.userData?.nodeId, object.userData?.partId, object.userData?.node?.name, object.userData?.node?.id);
    object = object.parent;
  }
  parts.push(mesh?.userData?.node?.parentId, mesh?.userData?.node?.parent?.name, mesh?.userData?.node?.parent?.id);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * mesh 分类：只读查询（category/group/label），不生产材质、不改 mesh.material。
 * 供 ShaderLibrary（glass 材质）和 RenderStyleManager（cel，getCategory(...) === 'glass' 跳过判断）共用。
 */
export class MeshCategoryClassifier {
  constructor() {
    this._categoryMap = new Map();
    this._meshMap = new Map();
    this._meshLabels = new Map();
    this.originalColors = new Map();
    this.groupMap = {};
    this.ungrouped = new Set();
  }

  classify(root) {
    if (!root) return this._categoryMap;

    this._categoryMap.clear();
    this._meshMap.clear();
    this.groupMap = {};
    this.ungrouped.clear();
    let meshIndex = 0;
    root.traverse(object => {
      if (!isRenderableMesh(object)) return;
      if (isOutlineMesh(object)) return;
      if (shouldSkipShaderApply(object)) return;
      if (isProtectedRenderObject(object)) return;
      if (!object.userData._originalMaterial) {
        object.userData._originalMaterial = cloneMaterial(object.material);
      }
      if (!this.originalColors.has(object.uuid)) {
        this.originalColors.set(object.uuid, getMaterialColor(object.userData._originalMaterial || object.material));
      }
      if (!object.userData.meshLabel) {
        object.userData.meshLabel = `m${meshIndex}`;
      }
      this._meshLabels.set(object.uuid, object.userData.meshLabel);
      meshIndex += 1;
      this._meshMap.set(object.uuid, object);
      this._categoryMap.set(object.uuid, this._inferCategory(object));
      const groupKey = this._getGroupKey(object);
      if (!this.groupMap[groupKey]) this.groupMap[groupKey] = [];
      this.groupMap[groupKey].push(object.uuid);
    });
    return this._categoryMap;
  }

  getCategory(meshUuid) {
    const category = this._categoryMap.get(meshUuid);
    return CATEGORY_SET.has(category) ? category : 'building';
  }

  /** 纯 category map 写入，不碰 mesh.material——材质应用由调用方（ShaderLibrary.applyCategoryToMesh）负责。 */
  setCategory(meshUuid, category) {
    if (!CATEGORY_SET.has(category)) {
      throw new TypeError(`Unknown shader category: ${category}`);
    }
    this._categoryMap.set(meshUuid, category);
  }

  getMesh(meshUuid) {
    return this._meshMap.get(meshUuid) || null;
  }

  ungroupMesh(meshUuid) {
    this.ungrouped.add(meshUuid);
  }

  getGroupForMesh(meshUuid) {
    for (const [groupKey, uuids] of Object.entries(this.groupMap)) {
      if (uuids.includes(meshUuid)) return groupKey;
    }
    return null;
  }

  getMeshList(root) {
    if (!root) return [];
    const meshes = [];
    root.traverse(object => {
      if (!isRenderableMesh(object)) return;
      if (isOutlineMesh(object)) return;
      if (isProtectedRenderObject(object)) return;
      this._meshMap.set(object.uuid, object);
      meshes.push({
        uuid: object.uuid,
        name: object.userData.nodeId || object.name || object.uuid,
        label: this._meshLabels.get(object.uuid) || object.userData.meshLabel || `m${meshes.length}`,
        category: this.getCategory(object.uuid),
        mesh: object,
        groupKey: this._getGroupKey(object),
        ungrouped: this.ungrouped.has(object.uuid),
      });
    });
    return meshes;
  }

  getGroupedMeshList(root) {
    const meshes = this.getMeshList(root);
    const groups = new Map();
    const loose = [];

    for (const item of meshes) {
      if (item.ungrouped) {
        loose.push(item);
        continue;
      }
      if (!groups.has(item.groupKey)) {
        groups.set(item.groupKey, {
          key: item.groupKey,
          category: item.category,
          meshes: [],
        });
      }
      const group = groups.get(item.groupKey);
      group.meshes.push(item);
      group.category = group.meshes[0]?.category || item.category;
    }

    return { groups: [...groups.values()], loose };
  }

  _inferCategory(mesh) {
    const haystack = getWorldNameHaystack(mesh);
    for (const rule of NAME_RULES) {
      if (rule.keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) {
        return rule.category;
      }
    }

    const normalizedType = String(meshType(mesh)).toLowerCase();
    return TYPE_DEFAULTS.get(normalizedType) || 'building';
  }

  _getGroupKey(mesh) {
    const parent = mesh?.parent;
    if (parent?.userData?.nodeId && parent.name !== 'model') return parent.userData.nodeId;
    return mesh?.userData?.node?.parent || mesh?.userData?.nodeId || mesh?.name || 'ungrouped';
  }
}
