import {
  createEmptyMap,
  createId,
  normalizeMap,
  sampleTerrainHeight,
  terrainPointAt,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type MapPaintStroke,
  type MapWaterBody
} from './map';
import { sampleGrassDensity, type MapGrassLayer } from './mapGrass';
import {
  createCompositeMapEdgeMask,
  createMapEdgeMask,
  type MapEcologyRegion,
  type MapStitchSeam,
  type MapStitchSource
} from './mapLayout';
import { MAX_VISUAL_ZONES, type MapVisualSemantics } from './visualDirection';

export type MapStitchDirection = 'east' | 'west' | 'north' | 'south';

export interface MapStitchOptions {
  name?: string;
  direction?: MapStitchDirection;
  mode?: 'contact' | 'corridor';
  width?: number;
  irregularity?: number;
  seed?: number;
  prompt?: string;
}

export interface MapStitchSeamPatch {
  width?: number;
  irregularity?: number;
  seed?: number;
  prompt?: string;
  locked?: boolean;
}

export function stitchMaps(
  primaryInput: EditableMap,
  secondaryInput: EditableMap,
  options: MapStitchOptions = {}
): EditableMap {
  const primary = normalizeMap(primaryInput);
  const secondary = normalizeMap(secondaryInput);
  if (primary.id === secondary.id) throw new Error('cannot_stitch_map_to_itself');
  const primarySourceIds = new Set([primary.id, ...primary.layout.stitchSources.map((source) => source.mapId)]);
  const secondarySourceIds = new Set([secondary.id, ...secondary.layout.stitchSources.map((source) => source.mapId)]);
  if ([...primarySourceIds].some((id) => secondarySourceIds.has(id))) throw new Error('duplicate_stitch_source');
  const direction = options.direction ?? 'east';
  const mode = options.mode === 'corridor' ? 'corridor' : 'contact';
  const width = clamp(Number(options.width) || 24, 8, 96);
  const requestedIrregularity = Number(options.irregularity);
  const irregularity = clamp(Number.isFinite(requestedIrregularity) ? requestedIrregularity : 0.25, 0, 0.65);
  const seed = Math.trunc(Number(options.seed) || primary.seed ^ secondary.seed) >>> 0;
  const gap = mode === 'corridor' ? width : 0;
  const horizontal = direction === 'east' || direction === 'west';
  const outputSize: [number, number, number] = horizontal
    ? [primary.box.size[0] + secondary.box.size[0] + gap, Math.max(primary.box.size[1], secondary.box.size[1]), Math.max(primary.box.size[2], secondary.box.size[2])]
    : [Math.max(primary.box.size[0], secondary.box.size[0]), Math.max(primary.box.size[1], secondary.box.size[1]), primary.box.size[2] + secondary.box.size[2] + gap];
  if (outputSize[0] > 768 || outputSize[2] > 768) throw new Error('stitched_map_exceeds_current_editor_limit');

  const placements = sourcePlacements(primary, secondary, direction, gap);
  const result = createEmptyMap(
    options.name?.trim() || `${primary.name} + ${secondary.name}`,
    createId('map'),
    outputSize,
    primary.assetGenerationMode
  );
  result.seed = seed;
  const seam = createSeam(primary, secondary, placements, { direction, mode, width, irregularity, seed, prompt: options.prompt ?? '' });
  for (let z = 0; z < result.terrain.resolutionZ; z += 1) {
    for (let x = 0; x < result.terrain.resolutionX; x += 1) {
      const point = terrainPointAt(result, x, z);
      result.terrain.heights[z * result.terrain.resolutionX + x] = stitchedHeight(
        primary,
        secondary,
        placements,
        point[0],
        point[2],
        seam,
        direction,
        gap
      );
    }
  }

  const assets = mergeAssets(primary.assets ?? [], secondary.assets ?? []);
  const assetIds = new Set(assets.map((asset) => asset.id));
  const primaryContent = translateMapContent(primary, placements.primary, 'a', assetIds);
  const secondaryContent = translateMapContent(secondary, placements.secondary, 'b', assetIds, primaryContent.ids);
  result.assets = assets;
  result.objects = [...primaryContent.objects, ...secondaryContent.objects];
  result.waterBodies = [...primaryContent.waters, ...secondaryContent.waters];
  result.paintStrokes = [...primaryContent.paint, ...secondaryContent.paint].slice(-1_200);
  result.grassLayers = mergeGrass(primary, secondary, result, placements);
  result.visualSemantics = mergeVisualSemantics(primary, secondary, placements);
  result.spawnPoints = primary.spawnPoints.map((point) => [
    point[0] + placements.primary[0], point[1], point[2] + placements.primary[1]
  ]);
  result.spawnYaw = primary.spawnYaw;
  result.confirmedAt = null;
  result.renderSchemeId = null;
  result.layout = {
    version: 1,
    globalPrompt: [primary.layout.globalPrompt, secondary.layout.globalPrompt].filter(Boolean).join('\n'),
    regions: [...primaryContent.regions, ...secondaryContent.regions],
    edgeMask: createStitchedEdgeMask(primary, secondary, placements, outputSize, direction, gap, seed),
    stitchSources: mergeSources(primary, secondary, placements),
    seams: [
      ...translateSeams(primary.layout.seams, placements.primary),
      ...translateSeams(secondary.layout.seams, placements.secondary),
      seam
    ]
  };
  return normalizeMap(result);
}

export function retuneMapStitchSeam(
  mapInput: EditableMap,
  firstSourceInput: EditableMap,
  secondSourceInput: EditableMap,
  seamId: string,
  patch: MapStitchSeamPatch
): EditableMap {
  const result = normalizeMap(mapInput);
  const firstSource = normalizeMap(firstSourceInput);
  const secondSource = normalizeMap(secondSourceInput);
  const seamIndex = result.layout.seams.findIndex((item) => item.id === seamId);
  const previous = result.layout.seams[seamIndex];
  if (!previous) throw new Error('unknown_stitch_seam');
  if (previous.locked && patch.locked !== false) throw new Error('stitch_seam_locked');
  if (!previous.sourceMapIds.includes(firstSource.id) || !previous.sourceMapIds.includes(secondSource.id)) {
    throw new Error('stitch_seam_source_mismatch');
  }
  const sources = new Map([[firstSource.id, firstSource], [secondSource.id, secondSource]]);
  const primary = sources.get(previous.sourceMapIds[0])!;
  const secondary = sources.get(previous.sourceMapIds[1])!;
  const sourceOffsets = new Map(result.layout.stitchSources.map((source) => [source.mapId, source.offset]));
  const firstRecord = result.layout.stitchSources.find((source) => source.mapId === firstSource.id);
  const secondRecord = result.layout.stitchSources.find((source) => source.mapId === secondSource.id);
  if (!firstRecord || !secondRecord) throw new Error('stitch_seam_source_missing');
  if (firstRecord.version !== firstSource.version || secondRecord.version !== secondSource.version) {
    throw new Error('stitch_seam_source_changed');
  }
  const placements: PlacementPair = {
    primary: sourceOffsets.get(primary.id) ?? [0, 0],
    secondary: sourceOffsets.get(secondary.id) ?? [0, 0]
  };
  const width = patch.width === undefined ? previous.width : clamp(Number(patch.width) || 24, 8, 96);
  const requestedIrregularity = Number(patch.irregularity);
  const irregularity = patch.irregularity === undefined
    ? previous.irregularity
    : clamp(Number.isFinite(requestedIrregularity) ? requestedIrregularity : previous.irregularity, 0, 0.65);
  const updated: MapStitchSeam = {
    ...previous,
    width,
    irregularity,
    seed: patch.seed === undefined ? previous.seed : Math.trunc(Number(patch.seed) || 0) >>> 0,
    prompt: patch.prompt === undefined ? previous.prompt : String(patch.prompt).trim().slice(0, 1_200),
    locked: patch.locked === undefined ? previous.locked : patch.locked === true
  };
  const horizontal = Math.abs(previous.points[0]?.[0] - previous.points[1]?.[0])
    < Math.abs(previous.points[0]?.[1] - previous.points[1]?.[1]);
  const primaryAxis = horizontal ? placements.primary[0] : placements.primary[1];
  const secondaryAxis = horizontal ? placements.secondary[0] : placements.secondary[1];
  const sign = secondaryAxis >= primaryAxis ? 1 : -1;
  const gap = Math.max(0, Math.abs(secondaryAxis - primaryAxis)
    - (horizontal
      ? (primary.box.size[0] + secondary.box.size[0]) / 2
      : (primary.box.size[2] + secondary.box.size[2]) / 2));
  const oldHalf = Math.max(previous.width, gap) / 2;
  const newHalf = Math.max(updated.width, gap) / 2;
  for (let zIndex = 0; zIndex < result.terrain.resolutionZ; zIndex += 1) {
    for (let xIndex = 0; xIndex < result.terrain.resolutionX; xIndex += 1) {
      const [worldX, , worldZ] = terrainPointAt(result, xIndex, zIndex);
      const transverse = horizontal ? worldZ : worldX;
      const axis = horizontal ? worldX : worldZ;
      const transverseInBoth = horizontal
        ? Math.abs(worldZ - placements.primary[1]) <= primary.box.size[2] / 2
          && Math.abs(worldZ - placements.secondary[1]) <= secondary.box.size[2] / 2
        : Math.abs(worldX - placements.primary[0]) <= primary.box.size[0] / 2
          && Math.abs(worldX - placements.secondary[0]) <= secondary.box.size[0] / 2;
      if (!transverseInBoth) continue;
      const oldProgress = sign * (axis - seamJitter(transverse, previous.seed) * previous.irregularity * Math.min(12, previous.width * 0.35));
      const newProgress = sign * (axis - seamJitter(transverse, updated.seed) * updated.irregularity * Math.min(12, updated.width * 0.35));
      if (Math.abs(oldProgress) > oldHalf && Math.abs(newProgress) > newHalf) continue;
      const primaryHeight = sampleTerrainHeight(primary, worldX - placements.primary[0], worldZ - placements.primary[1]);
      const secondaryHeight = sampleTerrainHeight(secondary, worldX - placements.secondary[0], worldZ - placements.secondary[1]);
      const height = newProgress <= -newHalf
        ? primaryHeight
        : newProgress >= newHalf
          ? secondaryHeight
          : mix(primaryHeight, secondaryHeight, smoothstep(-newHalf, newHalf, newProgress));
      result.terrain.heights[zIndex * result.terrain.resolutionX + xIndex] = height;
    }
  }
  result.layout.seams[seamIndex] = updated;
  result.confirmedAt = null;
  return normalizeMap(result);
}

function createStitchedEdgeMask(
  primary: EditableMap,
  secondary: EditableMap,
  placements: PlacementPair,
  outputSize: [number, number, number],
  direction: MapStitchDirection,
  gap: number,
  seed: number
) {
  const polygons = [
    ...translatedMaskPolygons(primary, placements.primary),
    ...translatedMaskPolygons(secondary, placements.secondary)
  ];
  if (gap > 0) {
    const horizontal = direction === 'east' || direction === 'west';
    const transverse = horizontal
      ? Math.min(primary.box.size[2], secondary.box.size[2]) / 2
      : Math.min(primary.box.size[0], secondary.box.size[0]) / 2;
    polygons.push(horizontal
      ? [[-gap / 2, -transverse], [gap / 2, -transverse], [gap / 2, transverse], [-gap / 2, transverse]]
      : [[-transverse, -gap / 2], [transverse, -gap / 2], [transverse, gap / 2], [-transverse, gap / 2]]);
  }
  const bothRectangles = primary.layout.edgeMask.kind === 'none'
    && secondary.layout.edgeMask.kind === 'none'
    && gap === 0;
  return bothRectangles
    ? createMapEdgeMask('none', outputSize, seed)
    : createCompositeMapEdgeMask(outputSize, polygons, seed);
}

function translatedMaskPolygons(map: EditableMap, offset: [number, number]): Array<Array<[number, number]>> {
  const polygons = map.layout.edgeMask.kind === 'composite'
    ? map.layout.edgeMask.polygons ?? [map.layout.edgeMask.points]
    : [map.layout.edgeMask.points];
  return polygons.map((polygon) => polygon.map((point): [number, number] => [
    point[0] + offset[0],
    point[1] + offset[1]
  ]));
}

interface PlacementPair {
  primary: [number, number];
  secondary: [number, number];
}

function sourcePlacements(
  primary: EditableMap,
  secondary: EditableMap,
  direction: MapStitchDirection,
  gap: number
): PlacementPair {
  if (direction === 'east') return {
    primary: [-(secondary.box.size[0] + gap) / 2, 0],
    secondary: [(primary.box.size[0] + gap) / 2, 0]
  };
  if (direction === 'west') return {
    primary: [(secondary.box.size[0] + gap) / 2, 0],
    secondary: [-(primary.box.size[0] + gap) / 2, 0]
  };
  if (direction === 'south') return {
    primary: [0, -(secondary.box.size[2] + gap) / 2],
    secondary: [0, (primary.box.size[2] + gap) / 2]
  };
  return {
    primary: [0, (secondary.box.size[2] + gap) / 2],
    secondary: [0, -(primary.box.size[2] + gap) / 2]
  };
}

function stitchedHeight(
  primary: EditableMap,
  secondary: EditableMap,
  placements: PlacementPair,
  x: number,
  z: number,
  seam: MapStitchSeam,
  direction: MapStitchDirection,
  gap: number
): number {
  const inPrimary = pointInPlacedMap(primary, placements.primary, x, z);
  const inSecondary = pointInPlacedMap(secondary, placements.secondary, x, z);
  const primaryHeight = sampleTerrainHeight(primary, x - placements.primary[0], z - placements.primary[1]);
  const secondaryHeight = sampleTerrainHeight(secondary, x - placements.secondary[0], z - placements.secondary[1]);
  const horizontal = direction === 'east' || direction === 'west';
  const transverse = horizontal ? z : x;
  const axis = horizontal ? x : z;
  const sign = direction === 'east' || direction === 'south' ? 1 : -1;
  const jitter = seamJitter(transverse, seam.seed) * seam.irregularity * Math.min(12, seam.width * 0.35);
  const progress = sign * (axis - jitter);
  const blendHalf = Math.max(seam.width, gap) / 2;
  const t = smoothstep(-blendHalf, blendHalf, progress);
  const transverseInBoth = horizontal
    ? Math.abs(z - placements.primary[1]) <= primary.box.size[2] / 2
      && Math.abs(z - placements.secondary[1]) <= secondary.box.size[2] / 2
    : Math.abs(x - placements.primary[0]) <= primary.box.size[0] / 2
      && Math.abs(x - placements.secondary[0]) <= secondary.box.size[0] / 2;
  if (transverseInBoth && Math.abs(progress) <= blendHalf) {
    return mix(primaryHeight, secondaryHeight, t);
  }
  if (inPrimary) return primaryHeight;
  if (inSecondary) return secondaryHeight;
  if (transverseInBoth && Math.abs(progress) <= Math.max(blendHalf, gap / 2 + seam.width / 2)) {
    return mix(primaryHeight, secondaryHeight, t);
  }
  return 0;
}

function pointInPlacedMap(map: EditableMap, offset: [number, number], x: number, z: number): boolean {
  return Math.abs(x - offset[0]) <= map.box.size[0] / 2
    && Math.abs(z - offset[1]) <= map.box.size[2] / 2;
}

function createSeam(
  primary: EditableMap,
  secondary: EditableMap,
  placements: PlacementPair,
  options: Required<Pick<MapStitchOptions, 'direction' | 'mode' | 'width' | 'irregularity' | 'seed' | 'prompt'>>
): MapStitchSeam {
  const horizontal = options.direction === 'east' || options.direction === 'west';
  const transverse = horizontal
    ? Math.min(primary.box.size[2], secondary.box.size[2]) / 2
    : Math.min(primary.box.size[0], secondary.box.size[0]) / 2;
  return {
    id: createId('seam'),
    name: `${primary.name} ↔ ${secondary.name}`,
    sourceMapIds: [primary.id, secondary.id],
    mode: options.mode,
    width: options.width,
    irregularity: options.irregularity,
    seed: options.seed,
    prompt: options.prompt.trim().slice(0, 1_200),
    locked: false,
    points: horizontal ? [[0, -transverse], [0, transverse]] : [[-transverse, 0], [transverse, 0]]
  };
}

interface TranslatedContent {
  ids: Set<string>;
  objects: MapObject[];
  waters: MapWaterBody[];
  paint: MapPaintStroke[];
  regions: MapEcologyRegion[];
}

function translateMapContent(
  map: EditableMap,
  offset: [number, number],
  prefix: string,
  allowedAssetIds: Set<string>,
  reservedIds: Set<string> = new Set()
): TranslatedContent {
  const ids = new Set(reservedIds);
  const objectIds = new Map<string, string>();
  for (const object of map.objects) objectIds.set(object.id, uniqueId(`${prefix}:${object.id}`, ids));
  const objects = map.objects.map((object): MapObject => ({
    ...object,
    id: objectIds.get(object.id)!,
    parentId: object.parentId ? objectIds.get(object.parentId) ?? null : null,
    assetId: object.assetId && allowedAssetIds.has(object.assetId) ? object.assetId : null,
    transform: {
      ...object.transform,
      position: [object.transform.position[0] + offset[0], object.transform.position[1], object.transform.position[2] + offset[1]]
    }
  }));
  const waters = map.waterBodies.map((water, index): MapWaterBody => ({
    ...water,
    id: uniqueId(`${prefix}:${water.id || `water-${index}`}`, ids),
    points: water.points.map((point) => [point[0] + offset[0], point[1] + offset[1]])
  }));
  const paint = map.paintStrokes.map((stroke, index): MapPaintStroke => ({
    ...stroke,
    id: uniqueId(`${prefix}:${stroke.id || `paint-${index}`}`, ids),
    point: [stroke.point[0] + offset[0], stroke.point[1], stroke.point[2] + offset[1]]
  }));
  const regions = map.layout.regions.map((region, index): MapEcologyRegion => ({
    ...region,
    id: uniqueId(`${prefix}:${region.id || `region-${index}`}`, ids),
    groupId: region.groupId ? `${prefix}:${region.groupId}` : null,
    points: region.points.map((point) => [point[0] + offset[0], point[1] + offset[1]])
  }));
  return { ids, objects, waters, paint, regions };
}

function mergeAssets(primary: readonly MapAsset[], secondary: readonly MapAsset[]): MapAsset[] {
  const result = primary.map((asset) => structuredClone(asset));
  const seen = new Set(result.map((asset) => asset.id));
  for (const asset of secondary) {
    if (!seen.has(asset.id)) {
      result.push(structuredClone(asset));
      seen.add(asset.id);
    }
  }
  return result;
}

function mergeGrass(
  primary: EditableMap,
  secondary: EditableMap,
  result: EditableMap,
  placements: PlacementPair
): MapGrassLayer[] {
  return [
    ...translateGrass(primary, result, placements.primary, 'a'),
    ...translateGrass(secondary, result, placements.secondary, 'b')
  ].slice(0, 8);
}

function translateGrass(
  source: EditableMap,
  result: EditableMap,
  offset: [number, number],
  prefix: string
): MapGrassLayer[] {
  return source.grassLayers.map((layer): MapGrassLayer => {
    const densities = new Array(result.terrain.resolutionX * result.terrain.resolutionZ).fill(0);
    for (let z = 0; z < result.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < result.terrain.resolutionX; x += 1) {
        const point = terrainPointAt(result, x, z);
        if (!pointInPlacedMap(source, offset, point[0], point[2])) continue;
        densities[z * result.terrain.resolutionX + x] = sampleGrassDensity(
          layer,
          source,
          point[0] - offset[0],
          point[2] - offset[1]
        );
      }
    }
    return {
      ...layer,
      id: `${prefix}:${layer.id}`.slice(0, 80),
      resolutionX: result.terrain.resolutionX,
      resolutionZ: result.terrain.resolutionZ,
      densities
    };
  });
}

function mergeVisualSemantics(
  primary: EditableMap,
  secondary: EditableMap,
  placements: PlacementPair
): MapVisualSemantics {
  return {
    version: 1,
    zones: [
      ...primary.visualSemantics.zones.map((zone) => ({
        ...zone,
        id: `a:${zone.id}`.slice(0, 80),
        center: [zone.center[0] + placements.primary[0], zone.center[1] + placements.primary[1]] as [number, number]
      })),
      ...secondary.visualSemantics.zones.map((zone) => ({
        ...zone,
        id: `b:${zone.id}`.slice(0, 80),
        center: [zone.center[0] + placements.secondary[0], zone.center[1] + placements.secondary[1]] as [number, number]
      }))
    ].slice(-MAX_VISUAL_ZONES),
    wind: primary.visualSemantics.wind
  };
}

function mergeSources(
  primary: EditableMap,
  secondary: EditableMap,
  placements: PlacementPair
): MapStitchSource[] {
  const sources = [
    translateSource(sourceOf(primary), placements.primary),
    ...primary.layout.stitchSources.map((source) => translateSource(source, placements.primary)),
    translateSource(sourceOf(secondary), placements.secondary),
    ...secondary.layout.stitchSources.map((source) => translateSource(source, placements.secondary))
  ];
  return sources.filter((source, index) => sources.findIndex((candidate) => candidate.mapId === source.mapId) === index).slice(0, 64);
}

function sourceOf(map: EditableMap): MapStitchSource {
  return { mapId: map.id, name: map.name, version: map.version, offset: [0, 0] };
}

function translateSource(source: MapStitchSource, offset: [number, number]): MapStitchSource {
  return { ...source, offset: [source.offset[0] + offset[0], source.offset[1] + offset[1]] };
}

function translateSeams(seams: readonly MapStitchSeam[], offset: [number, number]): MapStitchSeam[] {
  return seams.map((seam) => ({
    ...seam,
    points: seam.points.map((point) => [point[0] + offset[0], point[1] + offset[1]])
  }));
}

function uniqueId(requested: string, seen: Set<string>): string {
  let id = requested.slice(0, 80);
  for (let suffix = 2; seen.has(id); suffix += 1) id = `${requested}:${suffix}`.slice(0, 80);
  seen.add(id);
  return id;
}

function seamJitter(value: number, seed: number): number {
  return Math.sin(value * 0.071 + seed * 0.17) * 0.62
    + Math.sin(value * 0.163 - seed * 0.11) * 0.28
    + Math.sin(value * 0.031 + seed * 0.07) * 0.1;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
