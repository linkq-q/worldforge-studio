import { readFile } from 'node:fs/promises';
import {
  createPaintStroke,
  mapToSummary,
  surfaceUvFromPoint,
  type MapSurface,
  type TerrainBrushMode,
  type Transform3D
} from '../shared/map';
import type { Vec3 } from '../shared/protocol';
import type { MapOperation, MapTransactionSource } from '../shared/mapOperations';
import { generateModel } from './modelApi';
import { MapStore, mapEditorCliManifest } from './mapStore';

const store = new MapStore();

void main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';

  if (command === 'help') {
    print({ commands: mapEditorCliManifest() });
    return;
  }

  if (command === 'list') {
    print({ maps: await store.listMapSummaries() });
    return;
  }

  if (command === 'create') {
    print({ map: await store.createMap({ name: stringArg(args, 'name', '未命名地图'), size: optionalSize(args) }) });
    return;
  }

  if (command === 'show') {
    print({ map: await store.loadMap(required(args, 'map')) });
    return;
  }

  if (command === 'apply-transaction') {
    const source = stringArg(args, 'source', 'agent');
    if (source !== 'agent' && source !== 'basic-ai') throw new Error('invalid_transaction_source');
    const input = JSON.parse(await readFile(required(args, 'file'), 'utf8')) as MapOperation[] | { operations?: MapOperation[] };
    const operations = Array.isArray(input) ? input : input.operations;
    if (!Array.isArray(operations)) throw new Error('invalid_operations_file');
    const result = await store.commitTransaction(required(args, 'map'), {
      label: optionalString(args, 'label') ?? undefined,
      source: source as MapTransactionSource,
      operations
    });
    print({ map: mapToSummary(result.map), transaction: result.transaction });
    return;
  }

  if (command === 'undo-transaction') {
    const result = await store.undoTransaction(required(args, 'map'));
    print({ map: mapToSummary(result.map), transaction: result.transaction });
    return;
  }

  if (command === 'set-box') {
    const colors = Object.fromEntries(['floor', 'ceiling', 'north', 'south', 'east', 'west']
      .filter((key) => typeof args[key] === 'string')
      .map((key) => [key, args[key]]));
    print({ map: await store.updateMapBox(required(args, 'map'), { size: optionalSize(args), colors }) });
    return;
  }

  if (command === 'spawn') {
    print({ map: await store.setSpawnPoint(required(args, 'map'), vec3FromArgs(args, ['x', 'y', 'z'], [0, 0, 0])) });
    return;
  }

  if (command === 'sun') {
    print({ map: await store.setSunPosition(required(args, 'map'), vec3FromArgs(args, ['x', 'y', 'z'], [-18, 24, 14])) });
    return;
  }

  if (command === 'add-object') {
    print({
      map: await store.addObject(required(args, 'map'), {
        name: stringArg(args, 'name', '新物体'),
        assetId: optionalString(args, 'asset'),
        parentId: optionalString(args, 'parent'),
        transform: {
          position: vec3FromArgs(args, ['x', 'y', 'z'], [0, 0, 0]),
          rotation: vec3FromArgs(args, ['rx', 'ry', 'rz'], [0, 0, 0]),
          scale: vec3FromArgs(args, ['sx', 'sy', 'sz'], [1, 1, 1]),
          size: vec3FromArgs(args, ['w', 'h', 'd'], [1, 1, 1])
        }
      })
    });
    return;
  }

  if (command === 'transform-object') {
    const transform: Partial<Transform3D> = {};
    const position = optionalVec3(args, ['x', 'y', 'z']);
    const rotation = optionalVec3(args, ['rx', 'ry', 'rz']);
    const scale = optionalVec3(args, ['sx', 'sy', 'sz']);
    const size = optionalVec3(args, ['w', 'h', 'd']);
    if (position) transform.position = position;
    if (rotation) transform.rotation = rotation;
    if (scale) transform.scale = scale;
    if (size) transform.size = size;
    print({
      map: await store.patchObject(required(args, 'map'), required(args, 'object'), {
        transform
      })
    });
    return;
  }

  if (command === 'bind-asset') {
    print({ map: await store.patchObject(required(args, 'map'), required(args, 'object'), { assetId: required(args, 'asset') }) });
    return;
  }

  if (command === 'delete-object') {
    print({ map: await store.deleteObject(required(args, 'map'), required(args, 'object')) });
    return;
  }

  if (command === 'paint') {
    const map = await store.loadMap(required(args, 'map'));
    const surface = stringArg(args, 'surface', 'terrain') as MapSurface;
    const point = vec3FromArgs(args, ['x', 'y', 'z'], [0, 0, 0]);
    print({
      map: await store.addPaint(map.id, createPaintStroke({
        surface,
        point,
        uv: optionalVec2(args, ['u', 'v']) ?? surfaceUvFromPoint(map, surface, point),
        color: stringArg(args, 'color', '#d8ef75'),
        size: numberArg(args, 'size', 1.2),
        softness: numberArg(args, 'softness', 0.35)
      }))
    });
    return;
  }

  if (command === 'terrain') {
    print({
      map: await store.applyTerrain(
        required(args, 'map'),
        stringArg(args, 'mode', 'raise') as TerrainBrushMode,
        vec3FromArgs(args, ['x', 'height', 'z'], [0, 0, 0]),
        numberArg(args, 'size', 1.5),
        numberArg(args, 'strength', 0.3),
        numberArg(args, 'height', Number.NaN)
      )
    });
    return;
  }

  if (command === 'list-assets') {
    print({ assets: await store.listAssets() });
    return;
  }

  if (command === 'generate-asset') {
    const prompt = required(args, 'prompt');
    const mode = stringArg(args, 'mode', 'voxel') as 'standard' | 'lite' | 'voxel' | 'voxel-pro' | 'curve' | 'wire';
    const modelJson = await generateModel(prompt, { mode });
    print({ asset: await store.saveAsset({ prompt, name: optionalString(args, 'name') ?? undefined, modelJson, mode }) });
    return;
  }

  if (command === 'list-render-schemes') {
    print({ renderSchemes: await store.listRenderSchemes() });
    return;
  }

  throw new Error(`unknown_command:${command}`);
}

interface ParsedArgs {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function required(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing_${key}`);
  return value;
}

function optionalString(args: ParsedArgs, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringArg(args: ParsedArgs, key: string, fallback: string): string {
  return optionalString(args, key) ?? fallback;
}

function numberArg(args: ParsedArgs, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function optionalSize(args: ParsedArgs): Vec3 | undefined {
  const size = optionalVec3(args, ['width', 'height', 'depth']);
  return size;
}

function optionalVec3(args: ParsedArgs, keys: [string, string, string]): Vec3 | undefined {
  if (!keys.some((key) => typeof args[key] === 'string')) return undefined;
  return vec3FromArgs(args, keys, [0, 0, 0]);
}

function vec3FromArgs(args: ParsedArgs, keys: [string, string, string], fallback: Vec3): Vec3 {
  return [
    numberArg(args, keys[0], fallback[0]),
    numberArg(args, keys[1], fallback[1]),
    numberArg(args, keys[2], fallback[2])
  ];
}

function optionalVec2(args: ParsedArgs, keys: [string, string]): [number, number] | undefined {
  if (!keys.some((key) => typeof args[key] === 'string')) return undefined;
  return [numberArg(args, keys[0], 0.5), numberArg(args, keys[1], 0.5)];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
