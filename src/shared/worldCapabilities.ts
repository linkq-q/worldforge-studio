import type { MapOperation } from './mapOperations';

export type WorldCapabilityRuntime = 'map-code' | 'scene-program';

export interface WorldCapabilityBinding {
  runtime: WorldCapabilityRuntime;
  method: string;
}

export interface WorldCapabilityManifest {
  id: string;
  label: string;
  description: string;
  category: 'topology' | 'settlement' | 'roadside';
  deterministic: boolean;
  bindings: readonly WorldCapabilityBinding[];
  writes: readonly MapOperation['type'][];
  inputSchema: {
    type: 'object';
    required: readonly string[];
    properties: Readonly<Record<string, unknown>>;
    additionalProperties: boolean;
  };
}

/** One catalog drives Agent instructions and the local editor capability API. */
export const WORLD_CAPABILITIES: readonly WorldCapabilityManifest[] = Object.freeze([
  {
    id: 'topology.create-route-network',
    label: '创建路线网络',
    description: '先创建连接入口、焦点、路口和区域端口的共享路线拓扑。',
    category: 'topology',
    deterministic: true,
    bindings: [{ runtime: 'map-code', method: 'api.routeNetwork' }],
    writes: ['guide.upsert', 'terrain.surface'],
    inputSchema: {
      type: 'object',
      required: ['id', 'nodes', 'edges'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object', required: ['id', 'point'] } },
        edges: { type: 'array', items: { type: 'object', required: ['from', 'to'] } }
      }
    }
  },
  {
    id: 'settlement.create-street-grid',
    label: '创建聚落街区',
    description: '从聚落包络生成确定性的道路骨架和可建设街区，再由 AI 为街区分配用途。',
    category: 'settlement',
    deterministic: true,
    bindings: [
      { runtime: 'map-code', method: 'api.streetGrid' },
      { runtime: 'scene-program', method: 'scene.streetGrid' }
    ],
    writes: ['guide.upsert', 'terrain.surface'],
    inputSchema: {
      type: 'object',
      required: ['id', 'region', 'blockWidth', 'blockDepth', 'roadWidth'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        region: { type: 'array', minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2 } },
        direction: { type: 'number' },
        blockWidth: { type: 'number', exclusiveMinimum: 0 },
        blockDepth: { type: 'number', exclusiveMinimum: 0 },
        roadWidth: { type: 'number', exclusiveMinimum: 0 },
        inset: { type: 'number', minimum: 0 },
        surface: { enum: ['paving', 'soil', 'grass', 'sand', 'rock', 'none'] }
      }
    }
  },
  {
    id: 'settlement.place-street-frontage',
    label: '布置沿街建筑',
    description: '按真实门面宽度、建筑深度和街道侧向，连续布置朝向道路的商铺与民居。',
    category: 'settlement',
    deterministic: true,
    bindings: [{ runtime: 'map-code', method: 'api.placeStreetFrontage' }],
    writes: ['object.add'],
    inputSchema: {
      type: 'object',
      required: ['routeId', 'side', 'items'],
      additionalProperties: false,
      properties: {
        routeId: { type: 'string' },
        side: { enum: ['left', 'right'] },
        items: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'dimensions'] } },
        startInset: { type: 'number', minimum: 0 },
        endInset: { type: 'number', minimum: 0 },
        gap: { type: 'number', minimum: 0 },
        setback: { type: 'number', minimum: 0 }
      }
    }
  },
  {
    id: 'roadside.decorate-route',
    label: '沿路线布置设施',
    description: '根据已存在路线派生路灯、长椅、标牌或护栏的位置和朝向。',
    category: 'roadside',
    deterministic: true,
    bindings: [
      { runtime: 'map-code', method: 'api.placeAlongRoute' },
      { runtime: 'scene-program', method: 'scene.placeAlong' }
    ],
    writes: ['object.add'],
    inputSchema: {
      type: 'object',
      required: ['routeId', 'spacing'],
      additionalProperties: false,
      properties: {
        routeId: { type: 'string' },
        assetId: { type: 'string' },
        name: { type: 'string' },
        spacing: { type: 'number', exclusiveMinimum: 0 },
        offset: { type: 'number', minimum: 0 },
        side: { enum: ['left', 'right', 'both', 'alternate'] },
        startInset: { type: 'number', minimum: 0 },
        endInset: { type: 'number', minimum: 0 },
        facing: { enum: ['forward', 'toward-route', 'away-from-route'] }
      }
    }
  }
]);

export function worldCapabilitySummary(runtime?: WorldCapabilityRuntime): WorldCapabilityManifest[] {
  return WORLD_CAPABILITIES
    .filter((capability) => !runtime || capability.bindings.some((binding) => binding.runtime === runtime))
    .map((capability) => ({
      ...capability,
      bindings: capability.bindings
        .filter((binding) => !runtime || binding.runtime === runtime)
        .map((binding) => ({ ...binding })),
      writes: [...capability.writes],
      inputSchema: {
        ...capability.inputSchema,
        required: [...capability.inputSchema.required],
        properties: structuredClone(capability.inputSchema.properties)
      }
    }));
}
