/**
 * `@worldforge/map-core` — the zero-dependency half of WorldForge Studio.
 *
 * Everything re-exported here is pure TypeScript with no `three`, no DOM and no
 * Node imports, so a game server or a gameplay layer can run collisions, spawn
 * placement and terrain queries against the exact data the editor saved.
 *
 * Deliberately NOT exported: the map/render AI pipeline (`sceneComposition*`,
 * `mapAi` prompts, `mapLint`, `mapScatter`, `mapPlanning`) and the editor
 * transaction protocol. Those are studio internals; keeping them out keeps the
 * contract we owe downstream projects small.
 */

// Map schema, bounds, terrain sampling, collision bake and player movement.
export * from './map';
export * from './mapLayout';
export * from './mapGuide';
export * from './mapStitch';
export * from './materialTagPolicy';

// Spawn placement safety checks that go with `getSpawnPoints`.
export * from './mapSpawnSafety';

// Structured lakes and rivers: basin carving and point-in-water queries.
export * from './mapWater';

// Grass layers — density sampling is what gameplay usually needs.
export * from './mapGrass';

// Deterministic height-field generation from the persisted map `seed`.
export * from './terrainGeneration';

// Voxel model bounds and the collider plan the map collision bake derives from.
export * from './modelBounds';

// Asset tag normalisation, footprint radius and size class.
export * from './mapAssetMetadata';

// HDRI catalog parsing — needed to resolve the panorama a render scheme names.
export * from './hdri';

// Render scheme + render plan: the *description* of how a map should look.
// Applying it needs `worldforge-studio/viewer`; the data itself is dependency-free.
export * from './renderScheme';
export * from './renderPlan';

/**
 * Vector/angle helpers shared with the editor. Namespaced because names like
 * `add`, `scale` and `length` have no business sitting in a package's top level.
 */
export * as vectorMath from './math';
