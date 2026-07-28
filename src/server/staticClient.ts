import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp'
};

export async function handleStaticClient(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rootDir: string
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return true;
  }

  const root = path.resolve(rootDir);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(root, requested);
  if (!isInside(root, filePath)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  let body = await readFileOrNull(filePath);
  if (!body && path.extname(pathname) === '') {
    filePath = path.join(root, 'index.html');
    body = await readFileOrNull(filePath);
  }
  if (!body) return false;

  const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
  res.writeHead(200, {
    'Cache-Control': relativePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Length': body.byteLength,
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
