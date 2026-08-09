/**
 * BatchedPrimitiveGroup — scene-level batching for parts whose geometry is unique
 * per part (tri / patch). These can't use the InstancedMesh unit-geometry +
 * matrix-scale path (arbitrary vertices, not TRS-expressible), so each part is a
 * distinct geometry inside a THREE.BatchedMesh.
 *
 * P1 spike (tests/batchedmesh-spike.test.mjs) verified, on three r160:
 *   - many distinct geometries live in one BatchedMesh (one draw call)
 *   - raycast sets intersection.batchId (= addGeometry id) + .object, so a hit
 *     maps back to a partId via the batchId→partId map this class maintains
 *   - r160 has NO setColorAt → color differences are handled by BUCKETING parts
 *     into separate BatchedMeshes per materialKey (same as InstancedMesh batches).
 *
 * Capacity model: r160 BatchedMesh capacity is fixed at construction, so a bucket
 * is REBUILT (dispose + recreate sized to its current entries) whenever its entry
 * set changes. tri/patch counts are modest and rebuild only touches dirty buckets.
 * // ponytail: rebuild-per-dirty-bucket, not incremental grow. Switch to
 * //           addGeometry/optsize growth only if a profile shows rebuild cost.
 */

import * as THREE from 'three';
import { DEFAULT_PBR_METALNESS, DEFAULT_PBR_ROUGHNESS } from '../materials/MaterialDefaults.js';

/** Make a geometry BatchedMesh-friendly: indexed (r160 manages a shared index buffer). */
function ensureIndexed(geom) {
  if (geom.index) return geom;
  const count = geom.attributes.position.count;
  const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  geom.setIndex(new THREE.BufferAttribute(arr, 1));
  return geom;
}

export class BatchedPrimitiveGroup {
  /**
   * @param {object} [options]
   * @param {THREE.Object3D} [options.sharedRoot] parent for the BatchedMeshes
   */
  constructor(options = {}) {
    this._sharedRoot = options.sharedRoot || null;
    this._onMaterialReady = typeof options.onMaterialReady === 'function' ? options.onMaterialReady : null;

    /**
     * materialKey → bucket. Bucket holds its entries (the source of truth) and the
     * live BatchedMesh once built.
     * entry: { globalPartId, modelId, geometry, matrix, materialParams }
     * @type {Map<string, {materialParams:object, entries:Map<string,object>, mesh:THREE.BatchedMesh|null, dirty:boolean, idToPart:Map<number,string>, partToId:Map<string,number>}>}
     */
    this._buckets = new Map();

    /** globalPartId → materialKey, so removePart/updateMatrix find the bucket. */
    this._partToBucket = new Map();
  }

  attachToSharedRoot(root) {
    this._sharedRoot = root;
    for (const bucket of this._buckets.values()) {
      if (bucket.mesh && bucket.mesh.parent !== root) root.add(bucket.mesh);
    }
  }

  /**
   * Stage a part into its material bucket. Upsert by globalPartId. Marks the
   * bucket dirty; the BatchedMesh is (re)built on flush().
   * @param {string} globalPartId `${modelId}:${partId}`
   * @param {string} modelId
   * @param {THREE.BufferGeometry} geometry — part's real local-space geometry
   * @param {THREE.Matrix4} matrix — local→world instance matrix
   * @param {string} materialKey — bucket key (color/roughness/metalness/flatShading)
   * @param {object} materialParams — params to build the bucket material
   */
  setPart(globalPartId, modelId, geometry, matrix, materialKey, materialParams, baseRecipe = null) {
    let bucket = this._buckets.get(materialKey);
    if (!bucket) {
      bucket = {
        materialKey,
        materialParams,
        baseRecipe,
        entries: new Map(),
        mesh: null,
        dirty: true,
        idToPart: new Map(),
        partToId: new Map(),
      };
      this._buckets.set(materialKey, bucket);
    }
    // If the part moved buckets (material changed), drop it from the old one.
    const prevKey = this._partToBucket.get(globalPartId);
    if (prevKey && prevKey !== materialKey) this._removeFromBucket(globalPartId, prevKey);

    bucket.entries.set(globalPartId, {
      globalPartId,
      modelId,
      geometry: ensureIndexed(geometry),
      matrix: matrix.clone(),
      materialParams,
    });
    bucket.dirty = true;
    this._partToBucket.set(globalPartId, materialKey);
  }

  /** Remove one part. Marks its bucket dirty. */
  removePart(globalPartId) {
    const key = this._partToBucket.get(globalPartId);
    if (!key) return false;
    return this._removeFromBucket(globalPartId, key);
  }

  /** Remove every part belonging to a model. Marks affected buckets dirty. */
  removeModel(modelId) {
    let removed = 0;
    for (const [globalPartId, key] of [...this._partToBucket]) {
      const bucket = this._buckets.get(key);
      if (bucket?.entries.get(globalPartId)?.modelId === modelId) {
        if (this._removeFromBucket(globalPartId, key)) removed++;
      }
    }
    return removed;
  }

  _removeFromBucket(globalPartId, materialKey) {
    const bucket = this._buckets.get(materialKey);
    if (!bucket || !bucket.entries.has(globalPartId)) return false;
    bucket.entries.delete(globalPartId);
    bucket.dirty = true;
    this._partToBucket.delete(globalPartId);
    return true;
  }

  /**
   * Rebuild every dirty bucket's BatchedMesh and refresh its batchId↔partId maps.
   * Empty buckets are disposed and dropped.
   */
  flush() {
    for (const [materialKey, bucket] of [...this._buckets]) {
      if (!bucket.dirty) continue;
      this._disposeMesh(bucket);
      if (bucket.entries.size === 0) {
        this._buckets.delete(materialKey);
        continue;
      }
      this._buildBucketMesh(bucket);
      bucket.dirty = false;
    }
  }

  _buildBucketMesh(bucket) {
    const entries = [...bucket.entries.values()];
    let maxVerts = 0;
    let maxIndices = 0;
    for (const e of entries) {
      maxVerts += e.geometry.attributes.position.count;
      maxIndices += e.geometry.index.count;
    }
    const material = this._createMaterial(bucket.materialParams);
    this._onMaterialReady?.(material, bucket.materialParams, bucket.baseRecipe);
    const mesh = new THREE.BatchedMesh(entries.length, maxVerts, maxIndices, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.isBatchedPrimitiveGroup = true;
    mesh.userData.batchKey = bucket.materialKey;
    mesh.userData.batchId = `batched-mesh:${bucket.materialKey}`;

    bucket.idToPart = new Map();
    bucket.partToId = new Map();
    for (const e of entries) {
      const batchId = mesh.addGeometry(e.geometry);
      mesh.setMatrixAt(batchId, e.matrix);
      bucket.idToPart.set(batchId, e.globalPartId);
      bucket.partToId.set(e.globalPartId, batchId);
    }
    bucket.mesh = mesh;
    if (this._sharedRoot) this._sharedRoot.add(mesh);
  }

  _disposeMesh(bucket) {
    if (!bucket.mesh) return;
    if (bucket.mesh.parent) bucket.mesh.parent.remove(bucket.mesh);
    bucket.mesh.dispose?.();
    bucket.mesh.material?.dispose?.();
    bucket.mesh = null;
  }

  /** Resolve a raycast hit (BatchedMesh + batchId) back to a globalPartId. */
  resolvePartId(mesh, batchId) {
    for (const bucket of this._buckets.values()) {
      if (bucket.mesh === mesh) return bucket.idToPart.get(batchId) ?? null;
    }
    return null;
  }

  /** Per-part visibility (selection isolate / hide) without a rebuild. */
  setVisibleAt(globalPartId, visible) {
    const loc = this._locate(globalPartId);
    if (!loc) return false;
    loc.bucket.mesh.setVisibleAt(loc.batchId, visible);
    return true;
  }

  /** Per-part matrix update (transform edit) without a rebuild. */
  updateMatrix(globalPartId, matrix) {
    const loc = this._locate(globalPartId);
    if (!loc) return false;
    loc.bucket.mesh.setMatrixAt(loc.batchId, matrix);
    // keep the entry's matrix in sync so a later rebuild preserves the edit
    loc.bucket.entries.get(globalPartId)?.matrix.copy(matrix);
    return true;
  }

  _locate(globalPartId) {
    const key = this._partToBucket.get(globalPartId);
    if (!key) return null;
    const bucket = this._buckets.get(key);
    if (!bucket || !bucket.mesh) return null;
    const batchId = bucket.partToId.get(globalPartId);
    if (batchId === undefined) return null;
    return { bucket, batchId };
  }

  /** All live BatchedMeshes (e.g. for raycast target list). */
  getMeshes() {
    const meshes = [];
    for (const bucket of this._buckets.values()) if (bucket.mesh) meshes.push(bucket.mesh);
    return meshes;
  }

  /**
   * RuntimeIndex registration payloads. Each BatchedMesh bucket has one registry
   * batch id, while raycast uses the per-geometry `batchId` inside idToPart.
   */
  getRegistrations() {
    const registrations = [];
    for (const [materialKey, bucket] of this._buckets) {
      if (!bucket.mesh) continue;
      registrations.push({
        batchId: `batched-mesh:${materialKey}`,
        batchKey: materialKey,
        mesh: bucket.mesh,
        idToPart: new Map(bucket.idToPart),
      });
    }
    return registrations;
  }

  /** Audit snapshot: bucket (draw-call) count and total batched parts. */
  getAudit() {
    let parts = 0;
    for (const bucket of this._buckets.values()) parts += bucket.entries.size;
    return { buckets: this._buckets.size, parts };
  }

  dispose() {
    for (const bucket of this._buckets.values()) this._disposeMesh(bucket);
    this._buckets.clear();
    this._partToBucket.clear();
  }

  _createMaterial(matParams = {}) {
    const color = (matParams.color !== undefined && matParams.color !== null
      && !(typeof matParams.color === 'number' && isNaN(matParams.color)))
      ? matParams.color : 0xcccccc;
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: matParams.roughness ?? DEFAULT_PBR_ROUGHNESS,
      metalness: matParams.metalness ?? DEFAULT_PBR_METALNESS,
      flatShading: matParams.flatShading !== false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      side: THREE.DoubleSide, // tri/patch are thin/zero-thickness surfaces
    });
    material.userData.isBatchedPrimitiveMaterial = true;
    return material;
  }
}
