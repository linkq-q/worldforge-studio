import type http from 'node:http';
import type { MapStore } from './mapStore';
import { mapCatalog } from './mapCatalog';
import { experiments } from './experiments';
import type { ExperimentConfig, ExperimentReview } from '../shared/experiments';

export async function handleExperimentRoute(req: http.IncomingMessage, res: http.ServerResponse, store: MapStore, parts: string[]): Promise<boolean> {
  if (!['map-folders', 'experiments'].includes(parts[2])) return false;
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  };
  try {
    if (parts[2] === 'map-folders') {
      const catalog = mapCatalog(store);
      if (req.method === 'GET' && parts.length === 3) send(200, await catalog.read());
      else if (req.method === 'POST' && parts.length === 3) send(201, { folder: await catalog.saveFolder(await body(req)) });
      else if (req.method === 'POST' && parts[3] === 'move' && parts.length === 4) {
        const input = await body<{ mapIds: string[]; folderId: string | null }>(req);
        await catalog.move(input.mapIds, input.folderId); send(200, await catalog.read());
      } else throw new Error('not_found');
      return true;
    }
    const manager = experiments(store);
    const id = parts[3];
    if (req.method === 'GET' && parts.length === 3) send(200, { experiments: await manager.list() });
    else if (req.method === 'POST' && parts.length === 3) send(201, { experiment: await manager.create(await body<ExperimentConfig>(req)) });
    else if (req.method === 'GET' && parts.length === 4) send(200, { experiment: await manager.get(id) });
    else if (req.method === 'POST' && parts.length === 5 && parts[4] === 'control') {
      const input = await body<{ action: string; runId?: string }>(req);
      send(200, { experiment: await manager.control(id, input.action, input.runId) });
    } else if (req.method === 'GET' && parts[4] === 'runs' && parts[6] === 'artifacts' && parts.length === 8) {
      send(200, await manager.artifact(id, parts[5], parts[7]));
    } else if (req.method === 'PUT' && parts[4] === 'runs' && parts[6] === 'reviews' && parts.length === 8) {
      send(200, { experiment: await manager.review(id, parts[5], parts[7] as 'human' | 'agent', await body<ExperimentReview>(req)) });
    } else throw new Error('not_found');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(message === 'not_found' || message.startsWith('unknown_') ? 404 : 400, { error: message });
  }
  return true;
}
async function body<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}
