import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const api = process.env.WORLDFORGE_API ?? 'http://127.0.0.1:8797';
const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'start') await start(...args);
  else if (command === 'worker') await worker(...args);
  else if (command === 'next') await next(...args);
  else if (command === 'respond') await respond(...args);
  else if (command === 'result') await result(...args);
  else if (command === 'close') await close(...args);
  else throw new Error('Usage: bridge.mjs start METHOD /api/editor/route body.json | next STATE | respond STATE REQUEST_ID response.txt | result STATE | close STATE');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function start(method, route, bodyFile) {
  if (method !== 'POST' || !route?.startsWith('/api/editor/') || !bodyFile) throw new Error('start requires POST, an editor API route, and a JSON body file');
  const health = await fetch(`${api}/api/health`);
  if (!health.ok) throw new Error('WorldForge local API is unavailable');
  const created = await fetch(`${api}/api/editor/codex-runs`, { method: 'POST' });
  if (!created.ok) throw new Error(`Cannot create Codex run: HTTP ${created.status}`);
  const { runId } = await created.json();
  const directory = path.join(os.tmpdir(), `worldforge-codex-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, JSON.stringify({ api, runId, method, route, resultFile: path.join(directory, 'result.json') }));
  const child = spawn(process.execPath, [process.argv[1], 'worker', stateFile, path.resolve(bodyFile)], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({ stateFile, runId })}\n`);
}

async function worker(stateFile, bodyFile) {
  const state = await load(stateFile);
  try {
    const body = await readFile(bodyFile, 'utf8');
    // Planning can wait for a human-visible Codex turn longer than fetch's
    // implicit header timeout. Keep the local request alive for the run TTL.
    const result = await new Promise((resolve, reject) => {
      const pending = httpRequest(`${state.api}${state.route}`, {
        method: state.method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-WorldForge-Codex-Run': state.runId }
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      pending.setTimeout(60 * 60 * 1000, () => pending.destroy(new Error('Codex run request timed out')));
      pending.on('error', reject);
      pending.end(body);
    });
    await writeFile(state.resultFile, JSON.stringify(result));
  } catch (error) {
    await writeFile(state.resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function next(stateFile) {
  const state = await load(stateFile);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${state.api}/api/editor/codex-runs/${state.runId}/next`);
    if (!response.ok) throw new Error(`Cannot read Codex requests: HTTP ${response.status}`);
    const { requests } = await response.json();
    if (requests.length) {
      const visible = await Promise.all(requests.map(async (request) => ({
        ...request,
        messages: await Promise.all(request.messages.map(async (message, messageIndex) => ({
          ...message,
          content: typeof message.content === 'string' ? message.content : await Promise.all(message.content.map(async (part, partIndex) => {
            if (part.type !== 'image_url') return part;
            const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/i.exec(part.image_url.url);
            if (!match) throw new Error('Codex image must be a local data URL');
            const imagePath = path.join(path.dirname(stateFile), `${request.id}-${messageIndex}-${partIndex}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
            await writeFile(imagePath, Buffer.from(match[2], 'base64'));
            return { type: 'localImage', path: imagePath };
          }))
        })))
      })));
      process.stdout.write(`${JSON.stringify({ requests: visible })}\n`);
      return;
    }
    if (await readFile(state.resultFile, 'utf8').catch(() => null)) {
      process.stdout.write(`${JSON.stringify({ complete: true, resultFile: state.resultFile })}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(`${JSON.stringify({ waiting: true })}\n`);
}

async function respond(stateFile, requestId, responseFile) {
  if (!requestId || !responseFile) throw new Error('respond requires a request ID and response text file');
  const state = await load(stateFile);
  const content = await readFile(responseFile, 'utf8');
  const response = await fetch(`${state.api}/api/editor/codex-runs/${state.runId}/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, content })
  });
  if (!response.ok) throw new Error(`Codex response rejected: ${await response.text()}`);
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

async function result(stateFile) {
  const state = await load(stateFile);
  const raw = await readFile(state.resultFile, 'utf8').catch(() => null);
  if (!raw) {
    process.stdout.write(`${JSON.stringify({ waiting: true })}\n`);
    return;
  }
  const result = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify({ status: result.status, error: result.error, resultFile: state.resultFile })}\n`);
}

async function close(stateFile) {
  const state = await load(stateFile);
  const response = await fetch(`${state.api}/api/editor/codex-runs/${state.runId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Cannot close Codex run: HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

async function load(stateFile) {
  if (!stateFile) throw new Error('state file is required');
  return JSON.parse(await readFile(stateFile, 'utf8'));
}
