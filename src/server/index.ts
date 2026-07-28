import http from 'node:http';
import path from 'node:path';
import { handleMapHttp } from './mapHttp';
import { MapStore } from './mapStore';
import { handleStaticClient } from './staticClient';

const development = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const store = new MapStore();

await store.ensureReady();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { ok: true, app: 'worldforge-studio' });
      return;
    }

    if (await handleMapHttp(req, res, store)) return;
    if (!development && await handleStaticClient(req, res, path.resolve(process.cwd(), 'dist'))) return;
    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(port, host, () => {
  const client = development ? 'http://localhost:5173' : `http://${host}:${port}`;
  console.log(`WorldForge Studio: ${client}`);
  console.log(`Local API: http://${host}:${port}`);
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
