import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function parseUtf8Json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
export async function readJson(req: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Expected application/json');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Unsupported content encoding');
  // Async iterator early-exit destroys IncomingMessage, preventing a reliable 413.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = () => { cleanup(); reject(new HttpError(400, 'Incomplete request body')); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup(); chunks.length = 0;
        req.on('error', () => undefined); req.resume();
        reject(new HttpError(413, 'Request too large'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(parseUtf8Json(Buffer.concat(chunks))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}
/** Bound upstream bodies as well as client bodies. */
export async function readResponseJson(response: Response, maxBytes = 65_536): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, 'Expected upstream JSON');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new HttpError(502, 'Upstream response too large');
      chunks.push(value);
    }
    return parseUtf8Json(Buffer.concat(chunks));
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function acceptsMcp(header: string | undefined): boolean {
  const media = new Set((header ?? '').split(',').flatMap(item => {
    const [type, ...parameters] = item.trim().toLowerCase().split(';');
    const q = parameters.find(part => part.trim().startsWith('q='));
    if (q !== undefined && !(Number(q.trim().slice(2)) > 0)) return [];
    return type ? [type.trim()] : [];
  }));
  return media.has('application/json') && media.has('text/event-stream');
}
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function httpFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  json(res, error instanceof HttpError ? error.status : 500,
    { error: error instanceof HttpError ? error.message : 'Internal server error' });
}
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
