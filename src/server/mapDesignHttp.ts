import type http from 'node:http';
import type { MapDesignSessionOptions } from '../shared/mapDesignSession';
import type { MapStore } from './mapStore';
import { MapDesignSessionManager } from './mapDesignSessions';

const managers = new WeakMap<MapStore, MapDesignSessionManager>();

export function mapDesignManager(store: MapStore): MapDesignSessionManager {
  let manager = managers.get(store);
  if (!manager) { manager = new MapDesignSessionManager(store); managers.set(store, manager); }
  return manager;
}

/** Called inside the editor API's existing locality/auth boundary. */
export async function handleMapDesignHttp(
  req: http.IncomingMessage, res: http.ServerResponse, store: MapStore, parts: string[]
): Promise<boolean> {
  const collection = parts[2] === 'maps' && parts[4] === 'design-sessions' && parts.length === 5;
  const session = parts[2] === 'design-sessions';
  if (!collection && !session) return false;
  res.setHeader('Cache-Control', 'no-store');
  const manager = mapDesignManager(store);
  try {
    if (collection && req.method === 'GET') return send(res, 200, { sessions: await manager.list(parts[3]) });
    if (collection && req.method === 'POST') {
      const options = await body(req) as unknown as MapDesignSessionOptions;
      return send(res, 201, { session: await manager.create(parts[3], options) });
    }
    const id = parts[3];
    if (!id) return send(res, 404, { error: 'unknown_design_session' });
    if (req.method === 'GET' && parts.length === 4) {
      const current = await manager.get(id);
      const sinceVersion = new URL(req.url ?? '', 'http://localhost').searchParams.get('sinceVersion');
      return send(res, 200, sinceVersion === String(current.version)
        ? { session: null, version: current.version } : { session: current });
    }
    if (req.method === 'GET' && parts.length === 5 && parts[4] === 'draft') return send(res, 200, await manager.draft(id));
    if (req.method === 'POST' && parts.length === 5) {
      const input = await body(req);
      if (parts[4] === 'messages') return send(res, 200, { session: await manager.message(id, input.message as string) });
      if (parts[4] === 'pause') return send(res, 200, { session: await manager.pause(id) });
      if (parts[4] === 'resume') return send(res, 200, { session: await manager.resume(id) });
      if (parts[4] === 'approve-plan') return send(res, 200, { session: await manager.approvePlan(id, input.expectedRevision as number, input.approved === true) });
      if (parts[4] === 'commit') return send(res, 200, await manager.commit(id, input.expectedRevision as number, input.approved === true));
    }
    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'unknown_design_session' ? 404
      : /stale|already_running|still_running|commit_in_progress|session_committed/.test(message) ? 409
      : /required|invalid|unavailable|empty_draft/.test(message) ? 400 : 500;
    return send(res, status, { error: message });
  }
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('invalid_design_request_size');
    chunks.push(buffer);
  }
  if (!bytes) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid_design_request_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_design_request');
  return value as Record<string, unknown>;
}

function send(res: http.ServerResponse, status: number, value: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
  return true;
}
