import * as THREE from 'three';
import type { EditableMap, MapAsset, MapLightRole, MapObject, MapObjectLight } from '../shared/map';
import type { MapAssetLight } from '../shared/mapAssetMetadata';
import { isMaterialTagEnabled } from '../shared/materialTagPolicy';
import type { VisualTimeOfDay } from '../shared/visualDirection';

export const MAX_VISIBLE_MAP_POINT_LIGHTS = 6;
export const MAX_VISIBLE_MAP_SPOT_LIGHTS = 2;
export const MAX_VISIBLE_MAP_LOCAL_LIGHTS = MAX_VISIBLE_MAP_POINT_LIGHTS + MAX_VISIBLE_MAP_SPOT_LIGHTS;
const MAP_LOCAL_LIGHT_DISTANCE = 12;
const MAX_VISIBLE_MAP_WINDOW_LIGHTS = 2;
// Slightly softer than strict inverse-square so a hand-authored light reads as a
// usable cartoon light pool across a room-sized interior.
const LOCAL_LIGHT_DECAY = 1.2;
const AGGREGATE_LIGHTING_QUALITY_THRESHOLD = 0.5;
const KEY_SHADOW_QUALITY_THRESHOLD = 0.85;

export interface MapLocalLightCandidateInfo {
  objectId: string;
  color: THREE.ColorRepresentation;
  intensity: number;
  range: number;
  offset: [number, number, number];
  direction: [number, number, number];
  coneAngleDegrees: number;
  penumbra: number;
  priority: number;
  kind: 'point' | 'spot';
  role: MapLightRole;
  authored?: boolean;
  castShadow: boolean;
  target?: [number, number, number];
  shadowMapSize: 512 | 1024;
  shadowBias: number;
  shadowNormalBias: number;
  shadowRadius: number;
}

export interface MapLocalLights {
  group: THREE.Group;
  update(camera: THREE.Camera): void;
  setTimeOfDay(timeOfDay: VisualTimeOfDay): void;
  setQuality(quality: number): void;
  setSoloObjectId(objectId: string | null): void;
}

/** Derives a bounded Three.js light rig from lamp semantics and material tags. */
export function buildMapLocalLights(
  map: EditableMap,
  objectGroups: ReadonlyMap<string, THREE.Group>,
  options: { preserveLocalLights?: boolean } = {}
): MapLocalLights {
  const group = new THREE.Group();
  group.name = 'mapLocalLights';
  const candidates = analyzeMapLocalLightCandidates(map).flatMap((info) => {
    const objectGroup = objectGroups.get(info.objectId);
    return objectGroup ? [{
      objectId: info.objectId,
      group: objectGroup,
      color: info.color,
      intensity: info.intensity,
      range: info.range,
      offset: info.offset,
      direction: info.direction,
      coneAngleDegrees: info.coneAngleDegrees,
      penumbra: info.penumbra,
      priority: info.priority,
      kind: info.kind,
      role: info.role,
      authored: info.authored,
      castShadow: info.castShadow,
      target: info.target,
      shadowMapSize: info.shadowMapSize,
      shadowBias: info.shadowBias,
      shadowNormalBias: info.shadowNormalBias,
      shadowRadius: info.shadowRadius
    }] : [];
  });
  const pointCandidates = candidates.filter((candidate) => candidate.kind === 'point');
  const spotCandidates = candidates.filter((candidate) => candidate.kind === 'spot');
  const pointLights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_POINT_LIGHTS, pointCandidates.length) }, () => {
    const light = new THREE.PointLight(0xffc46b, 0, MAP_LOCAL_LIGHT_DISTANCE, 2);
    light.decay = LOCAL_LIGHT_DECAY;
    light.castShadow = false;
    // Keep the light count stable so camera movement does not compile a new
    // material shader variant whenever an emitter crosses the viewport edge.
    light.visible = true;
    group.add(light);
    return light;
  });
  const spotLights = Array.from({ length: Math.min(MAX_VISIBLE_MAP_SPOT_LIGHTS, spotCandidates.length) }, () => {
    const light = new THREE.SpotLight(0xffd69a, 0, MAP_LOCAL_LIGHT_DISTANCE, Math.PI / 5, 0.45, 2);
    light.decay = LOCAL_LIGHT_DECAY;
    light.castShadow = false;
    light.visible = true;
    light.target.name = 'mapLocalLightTarget';
    light.target.position.set(0, -3, 0);
    light.add(light.target);
    group.add(light);
    return light;
  });
  const windowLights = buildWindowLights(map);
  group.add(windowLights.group);
  const indirectProbe = buildInteriorIndirectProbe(map, candidates);
  if (indirectProbe) group.add(indirectProbe.light);
  let timeOfDay: VisualTimeOfDay = 'noon';
  let aggregateLighting = false;
  let quality = 1;
  let soloObjectId: string | null = null;
  const preserveLocalLights = options.preserveLocalLights === true;
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const influence = new THREE.Sphere(new THREE.Vector3(), MAP_LOCAL_LIGHT_DISTANCE);
  return {
    group,
    update: (camera) => {
      camera.updateMatrixWorld();
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection);
      const visibleCandidates = candidates
        .filter((candidate) => !soloObjectId || candidate.objectId === soloObjectId)
        .map((candidate) => {
          candidate.group.getWorldPosition(position);
          candidate.group.getWorldQuaternion(rotation);
          const world = new THREE.Vector3(...candidate.offset).applyQuaternion(rotation).add(position);
          const direction = candidate.target
            ? new THREE.Vector3(...candidate.target).sub(world).normalize()
            : new THREE.Vector3(...candidate.direction).applyQuaternion(rotation).normalize();
          return { candidate, world, direction, distance: world.distanceToSquared(camera.position) };
        })
        // The emitter may be outside the picture while its light still reaches
        // visible surfaces. Cull the influence volume, not the bulb position.
        .filter((entry) => frustum.intersectsSphere(influence.set(entry.world, entry.candidate.range)))
        .sort((left, right) => right.candidate.priority - left.candidate.priority || left.distance - right.distance);
      const selectedPoints = visibleCandidates.filter((entry) => entry.candidate.kind === 'point').slice(0, pointLights.length);
      const selectedSpots = visibleCandidates.filter((entry) => entry.candidate.kind === 'spot').slice(0, spotLights.length);
      const shadowSpotIndex = selectedSpots.findIndex((entry) => entry.candidate.castShadow);
      const windowOwnsKeyShadow = map.sceneMode === 'indoor'
        && quality >= KEY_SHADOW_QUALITY_THRESHOLD
        && (timeOfDay === 'morning' || timeOfDay === 'noon')
        && shadowSpotIndex < 0
        && !soloObjectId
        && windowLights.count > 0;
      windowLights.setKeyShadow(windowOwnsKeyShadow);
      // Keep the parent active so camera movement never changes Three's compiled light count.
      group.visible = true;
      pointLights.forEach((light, index) => {
        const entry = selectedPoints[index];
        if (!entry) {
          light.intensity = 0;
          return;
        }
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = map.sceneMode === 'outdoor'
          ? entry.candidate.intensity * (entry.candidate.authored ? 1.35 : 1)
          : indoorLocalIntensity(entry.candidate.intensity, timeOfDay, entry.candidate.role, entry.candidate.authored === true);
        light.distance = entry.candidate.range;
      });
      spotLights.forEach((light, index) => {
        const entry = selectedSpots[index];
        configureIndoorKeyShadow(
          light,
          map.sceneMode === 'indoor'
            && quality >= KEY_SHADOW_QUALITY_THRESHOLD
            && !windowOwnsKeyShadow
            && index === shadowSpotIndex
            && Boolean(entry),
          entry?.candidate
        );
        if (!entry) {
          light.intensity = 0;
          return;
        }
        light.position.copy(entry.world);
        light.color.set(entry.candidate.color);
        light.intensity = map.sceneMode === 'outdoor'
          ? entry.candidate.intensity * (entry.candidate.authored ? 1.35 : 1)
          : indoorLocalIntensity(entry.candidate.intensity, timeOfDay, entry.candidate.role, entry.candidate.authored === true);
        light.distance = entry.candidate.range;
        light.angle = THREE.MathUtils.degToRad(entry.candidate.coneAngleDegrees);
        light.penumbra = entry.candidate.penumbra;
        light.target.position.copy(entry.direction).multiplyScalar(Math.max(2, entry.candidate.range * 0.4));
      });
    },
    setTimeOfDay: (nextTimeOfDay) => {
      timeOfDay = nextTimeOfDay;
      windowLights.setTimeOfDay(timeOfDay);
      indirectProbe?.update(timeOfDay, aggregateLighting);
    },
    setQuality: (nextQuality) => {
      quality = THREE.MathUtils.clamp(nextQuality, 0, 1);
      aggregateLighting = !preserveLocalLights
        && map.sceneMode === 'indoor'
        && quality <= AGGREGATE_LIGHTING_QUALITY_THRESHOLD;
      pointLights.forEach((light) => { light.visible = !aggregateLighting; });
      spotLights.forEach((light) => { light.visible = !aggregateLighting; });
      windowLights.setAggregateLighting(aggregateLighting);
      indirectProbe?.update(timeOfDay, aggregateLighting);
    },
    setSoloObjectId: (objectId) => {
      soloObjectId = objectId;
      windowLights.setSolo(Boolean(objectId));
      if (indirectProbe) indirectProbe.light.visible = !objectId;
    }
  };
}

/** One low-frequency SH probe supplies cheap room-scale bounce on desktop. */
function buildInteriorIndirectProbe(
  map: EditableMap,
  candidates: readonly MapLocalLightCandidateInfo[]
): { light: THREE.LightProbe; update(timeOfDay: VisualTimeOfDay, aggregateLighting: boolean): void } | null {
  if (map.sceneMode !== 'indoor' || !map.room) return null;
  const hasWindows = map.room.openings.some((opening) => opening.kind === 'window');
  const probe = new THREE.LightProbe();
  probe.name = 'mapInteriorLightProbe';
  const colors = map.interiorArtDirection?.palette ?? [map.box.colors.floor, map.box.colors.north, '#ffd8a0'];
  const roomBounce = colors.reduce((result, color) => result.add(new THREE.Color(color)), new THREE.Color())
    .multiplyScalar(1 / Math.max(1, colors.length));
  const practicalBounce = candidates.reduce((result, candidate) => result.add(new THREE.Color(candidate.color)), new THREE.Color())
    .multiplyScalar(1 / Math.max(1, candidates.length));
  const update = (timeOfDay: VisualTimeOfDay, aggregateLighting: boolean): void => {
    probe.intensity = indirectProbeIntensity(timeOfDay, candidates.length > 0, hasWindows, aggregateLighting);
    const bounce = roomBounce.clone();
    if (aggregateLighting && candidates.length > 0) {
      bounce.lerp(practicalBounce, timeOfDay === 'night' ? 0.65 : timeOfDay === 'evening' ? 0.55 : 0.4);
    }
    probe.sh.coefficients[0].set(bounce.r, bounce.g, bounce.b).multiplyScalar(2 * Math.sqrt(Math.PI));
  };
  update('noon', false);
  return { light: probe, update };
}

function indirectProbeIntensity(
  timeOfDay: VisualTimeOfDay,
  hasPracticalLights: boolean,
  hasWindows: boolean,
  aggregateLighting = false
): number {
  const base = timeOfDay === 'night'
    ? (hasPracticalLights ? 0.28 : 0.05)
    : timeOfDay === 'evening'
      ? (hasPracticalLights ? 0.2 : 0.07) + (hasWindows ? 0.06 : 0)
      : timeOfDay === 'morning'
        ? (hasWindows ? 0.27 : 0.11)
        : (hasWindows ? 0.3 : 0.12);
  if (!aggregateLighting || !hasPracticalLights) return base;
  return Math.min(0.82, base + (timeOfDay === 'night' ? 0.34 : 0.44));
}

function buildWindowLights(map: EditableMap): {
  group: THREE.Group;
  count: number;
  setTimeOfDay(timeOfDay: VisualTimeOfDay): void;
  setAggregateLighting(enabled: boolean): void;
  setKeyShadow(enabled: boolean): void;
  setSolo(enabled: boolean): void;
} {
  const group = new THREE.Group();
  group.name = 'mapWindowLights';
  const room = map.room;
  if (!room || map.sceneMode === 'outdoor') {
    return {
      group,
      count: 0,
      setTimeOfDay: () => {},
      setAggregateLighting: () => {},
      setKeyShadow: () => {},
      setSolo: () => {}
    };
  }
  const range = Math.hypot(...room.size);
  const lights = room.openings
    .filter((opening) => opening.kind === 'window')
    .sort((left, right) => right.width * right.height - left.width * left.height || left.id.localeCompare(right.id))
    .slice(0, MAX_VISIBLE_MAP_WINDOW_LIGHTS)
    .map((opening) => {
      const inward = opening.wall === 'north'
        ? new THREE.Vector3(0, -0.18, 1)
        : opening.wall === 'south'
          ? new THREE.Vector3(0, -0.18, -1)
          : opening.wall === 'east'
            ? new THREE.Vector3(-1, -0.18, 0)
            : new THREE.Vector3(1, -0.18, 0);
      const inset = room.wallThickness / 2 + 0.08;
      const centerY = room.position[1] + opening.bottom + opening.height / 2;
      const position = opening.wall === 'north'
        ? [room.position[0] + opening.offset, centerY, room.position[2] - room.size[2] / 2 + inset]
        : opening.wall === 'south'
          ? [room.position[0] + opening.offset, centerY, room.position[2] + room.size[2] / 2 - inset]
          : opening.wall === 'east'
            ? [room.position[0] + room.size[0] / 2 - inset, centerY, room.position[2] + opening.offset]
            : [room.position[0] - room.size[0] / 2 + inset, centerY, room.position[2] + opening.offset];
      const light = new THREE.SpotLight('#d9efff', 0, range, Math.PI / 3, 0.8, LOCAL_LIGHT_DECAY);
      light.name = 'mapWindowLight';
      light.position.set(position[0], position[1], position[2]);
      light.castShadow = false;
      light.target.name = 'mapWindowLightTarget';
      light.target.position.copy(inward.normalize()).multiplyScalar(range * 0.65);
      light.add(light.target);
      group.add(light);
      return { light, baseIntensity: THREE.MathUtils.clamp(opening.width * opening.height * 8, 10, 30) };
    });
  const setTimeOfDay = (timeOfDay: VisualTimeOfDay): void => {
    const profile = windowLightProfile(timeOfDay);
    for (const entry of lights) {
      entry.light.color.set(profile.color);
      entry.light.intensity = entry.baseIntensity * profile.strength;
    }
  };
  let aggregateLighting = false;
  let keyShadow = false;
  let solo = false;
  const syncState = (): void => {
    lights.forEach((entry, index) => {
      entry.light.visible = !solo && (!aggregateLighting || index === 0);
      configureIndoorKeyShadow(entry.light, !solo && keyShadow && index === 0);
    });
  };
  const setAggregateLighting = (enabled: boolean): void => {
    aggregateLighting = enabled;
    syncState();
  };
  const setKeyShadow = (enabled: boolean): void => {
    keyShadow = enabled;
    syncState();
  };
  const setSolo = (enabled: boolean): void => {
    solo = enabled;
    syncState();
  };
  setTimeOfDay('noon');
  syncState();
  return { group, count: lights.length, setTimeOfDay, setAggregateLighting, setKeyShadow, setSolo };
}

function configureIndoorKeyShadow(
  light: THREE.SpotLight,
  enabled: boolean,
  profile?: Pick<MapLocalLightCandidateInfo, 'shadowMapSize' | 'shadowBias' | 'shadowNormalBias' | 'shadowRadius'>
): void {
  const changed = light.castShadow !== enabled;
  light.castShadow = enabled;
  if (!enabled) return;
  const mapSize = profile?.shadowMapSize ?? 512;
  const mapSizeChanged = light.shadow.mapSize.width !== mapSize;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.bias = profile?.shadowBias ?? -0.0002;
  light.shadow.normalBias = profile?.shadowNormalBias ?? 0.025;
  light.shadow.radius = profile?.shadowRadius ?? 2;
  if (changed || mapSizeChanged) light.shadow.needsUpdate = true;
}

function indoorLocalIntensity(baseIntensity: number, timeOfDay: VisualTimeOfDay, role: MapLightRole, authored: boolean): number {
  const scale = timeOfDay === 'night' ? 1.5 : timeOfDay === 'evening' ? 1.2 : timeOfDay === 'morning' ? 1 : 0.8;
  const practicalPeak = timeOfDay === 'night' ? 8 : timeOfDay === 'evening' ? 7 : timeOfDay === 'morning' ? 6 : 5;
  const rolePeak = role === 'key' ? 8 : role === 'fill' ? 4 : role === 'accent' ? 4.5 : practicalPeak;
  const peak = role === 'practical' ? practicalPeak : rolePeak;
  if (!authored) return Math.min(baseIntensity * scale, peak);
  const roleScale = role === 'key' ? 3.2 : role === 'fill' ? 2.2 : role === 'accent' ? 2.4 : 2.6;
  return Math.min(baseIntensity * scale * roleScale, peak * roleScale);
}

function windowLightProfile(timeOfDay: VisualTimeOfDay): { color: string; strength: number } {
  return timeOfDay === 'night'
    ? { color: '#809bd3', strength: 0.08 }
    : timeOfDay === 'evening'
      ? { color: '#eab7aa', strength: 0.45 }
      : timeOfDay === 'morning'
        ? { color: '#fff0d2', strength: 0.82 }
        : { color: '#d9efff', strength: 1 };
}

/** Pure candidate analysis shared by the renderer and the derived-results inspector. */
export function analyzeMapLocalLightCandidates(map: EditableMap): MapLocalLightCandidateInfo[] {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  return map.objects.flatMap((object) => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const authored = object.light && object.light.enabled ? object.light : undefined;
    if (!object.visible || object.light === null || (object.light && !object.light.enabled)) return [];
    const glow = authored ? lightContractProfile(authored) : asset ? modelLightProfile(asset, map) : null;
    return glow ? [{
      objectId: object.id,
      color: glow.color,
      intensity: glow.intensity,
      range: glow.range,
      offset: glow.offset ?? [0, localLightHeight(object, asset), 0],
      direction: glow.direction ?? [0, -1, 0],
      coneAngleDegrees: glow.coneAngleDegrees ?? 40,
      penumbra: glow.penumbra ?? 0.4,
      priority: authored ? lightRolePriority(authored.role) : glow.priority,
      kind: glow.kind,
      role: authored?.role ?? 'practical',
      authored: Boolean(authored),
      castShadow: authored?.castShadow ?? glow.kind === 'spot',
      target: authored?.target,
      shadowMapSize: authored?.shadowMapSize ?? 512,
      shadowBias: authored?.shadowBias ?? -0.0002,
      shadowNormalBias: authored?.shadowNormalBias ?? 0.025,
      shadowRadius: authored?.shadowRadius ?? 2
    }] : [];
  });
}

export function resolvedMapObjectLight(object: MapObject, asset?: MapAsset): MapObjectLight | null {
  if (object.light === null) return null;
  if (object.light) return object.light;
  const inherited = asset?.light;
  if (!inherited) return null;
  return {
    ...inherited,
    enabled: true,
    role: 'practical',
    castShadow: inherited.kind === 'spot',
    shadowMapSize: 512,
    shadowBias: -0.0002,
    shadowNormalBias: 0.025,
    shadowRadius: 2
  };
}

function lightRolePriority(role: MapLightRole): number {
  return role === 'key' ? 5 : role === 'accent' ? 4 : role === 'fill' ? 2 : 3;
}

function modelLightProfile(asset: MapAsset, map: EditableMap): {
  color: THREE.ColorRepresentation;
  intensity: number;
  range: number;
  offset?: [number, number, number];
  direction?: [number, number, number];
  coneAngleDegrees?: number;
  penumbra?: number;
  priority: number;
  kind: 'point' | 'spot';
} | null {
  if (asset.light) return lightContractProfile(asset.light);
  const legacy = legacyTaggedLight(asset);
  if (legacy) return legacy;
  const nodes = (asset.modelJson as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return null;
  let fireStrength = 0;
  let fireVariant = '';
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const tags = (node as { tags?: unknown }).tags;
    if (!Array.isArray(tags)) continue;
    for (const value of tags) {
      if (!isMaterialTagEnabled(value, map.materialTagPolicy)) continue;
      const tag = value && typeof value === 'object' ? value as { tag?: unknown; value?: unknown; variant?: unknown } : null;
      const strength = typeof tag?.value === 'number' ? THREE.MathUtils.clamp(tag.value, 0, 1) : 1;
      if (tag?.tag === 'fire') {
        fireStrength = Math.max(fireStrength, strength);
        fireVariant = typeof tag.variant === 'string' ? tag.variant : fireVariant;
      }
    }
  }
  if (fireStrength > 0.05) {
    return {
      color: fireVariant === 'blue' ? '#68a7ff' : fireVariant === 'green' ? '#70ef92' : '#ffad5c',
      intensity: 2 + fireStrength * 3,
      range: 10,
      priority: 2,
      kind: 'point'
    };
  }
  return null;
}

function lightContractProfile(light: MapAssetLight): NonNullable<ReturnType<typeof modelLightProfile>> {
  return {
    kind: light.kind,
    color: light.color,
    intensity: light.intensity,
    range: light.range,
    offset: light.offset,
    direction: light.direction,
    coneAngleDegrees: light.coneAngleDegrees,
    penumbra: light.penumbra,
    priority: 3
  };
}

function legacyTaggedLight(asset: MapAsset): NonNullable<ReturnType<typeof modelLightProfile>> | null {
  const tags = new Set(asset.tags ?? []);
  const spot = tags.has('spotlight') || tags.has('spot-light') || tags.has('track-light')
    || (tags.has('light') && (tags.has('track') || tags.has('downlight')));
  const fixture = spot || [...tags].some((tag) => (
    tag === 'light' || tag === 'lighting' || tag.endsWith('-light') || tag.endsWith('-lamp') || tag.endsWith('-lighting')
  ));
  if (!fixture) return null;
  const cool = [...tags].some((tag) => tag.includes('cool') || tag.includes('blue'));
  const ceiling = tags.has('ceiling') || tags.has('ceiling-mounted');
  return {
    kind: spot ? 'spot' : 'point',
    color: cool ? '#bfe8ff' : '#ffd8a0',
    intensity: spot ? 5 : 3,
    range: spot ? 9 : 7,
    offset: ceiling ? [0, -0.2, 0] : undefined,
    direction: spot ? [0, -1, 0] : undefined,
    coneAngleDegrees: spot ? 38 : undefined,
    penumbra: spot ? 0.45 : undefined,
    priority: 2
  };
}

function localLightHeight(object: MapObject, asset?: MapAsset): number {
  const boxHeight = asset?.colliderPlan.boxes.reduce(
    (height, box) => Math.max(height, box.max[1] - box.min[1]),
    object.transform.size[1]
  ) ?? object.transform.size[1];
  return Math.max(0.4, boxHeight * object.transform.scale[1] * 0.55);
}
