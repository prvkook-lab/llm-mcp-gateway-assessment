import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { acceptsMcp, HttpError, httpFailure, json, readJson } from '../shared/http.js';
import { McpSession, requestSchema, rpcError, VERSION } from './protocol.js';

/** Newline-delimited UTF-8 JSON. Oversized frames are discarded through the next LF. */
export async function serveStdio(input: Readable, output: Writable, maxBytes = 65_536): Promise<void> {
  const session = new McpSession();
  let pending: number[] = [];
  let dropping = false;
  const send = async (value: unknown) => { if (!output.write(JSON.stringify(value) + '\n')) await once(output, 'drain'); };
  for await (const chunk of input) {
    for (const byte of Buffer.from(chunk as Uint8Array)) {
      if (byte === 10) {
        if (dropping) { dropping = false; continue; }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(pending))); }
        catch { pending = []; await send(rpcError(null, -32700, 'Parse error')); continue; }
        pending = [];
        const response = session.handle(value);
        if (response) await send(response);
      } else if (!dropping) {
        pending.push(byte);
        if (pending.length > maxBytes) {
          pending = []; dropping = true;
          await send(rpcError(null, -32600, 'Frame too large'));
        }
      }
    }
  }
  if (pending.length) await send(rpcError(null, -32700, 'Unterminated frame'));
}

export function createMcpHttpServer(options: { allowedOrigins?: string[]; maxSessions?: number; sessionTtlMs?: number } = {}): Server {
  const sessions = new Map<string, { session: McpSession; seen: number }>();
  return createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp') throw new HttpError(404, 'Not found');
      if (req.headers.origin && !options.allowedOrigins?.includes(req.headers.origin)) throw new HttpError(403, 'Origin denied');
      const now = Date.now();
      for (const [id, entry] of sessions) if (now - entry.seen >= (options.sessionTtlMs ?? 1_800_000)) sessions.delete(id);
      const id = req.headers['mcp-session-id'];
      if (Array.isArray(id)) throw new HttpError(400, 'Invalid session');
      if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
      if (req.method === 'DELETE') {
        if (req.headers['mcp-protocol-version'] !== VERSION) throw new HttpError(400, 'Unsupported protocol version');
        if (!id || !sessions.delete(id)) throw new HttpError(404, 'Session not found');
        res.writeHead(204).end(); return;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (!acceptsMcp(req.headers.accept)) throw new HttpError(406, 'Accept must include application/json and text/event-stream');
      if (id && req.headers['mcp-protocol-version'] !== VERSION) throw new HttpError(400, 'Unsupported protocol version');
      let body: unknown;
      try { body = await readJson(req); }
      catch (error) {
        if (error instanceof HttpError && error.status === 400) { json(res, 400, rpcError(null, -32700, 'Parse error')); return; }
        throw error;
      }
      if (!requestSchema.safeParse(body).success) { json(res, 400, rpcError(null, -32600, 'Invalid Request')); return; }
      let entry = id ? sessions.get(id) : undefined;
      if (id && !entry) throw new HttpError(404, 'Session not found');
      if (!entry) {
        if (typeof body !== 'object' || body === null || !('method' in body) || body.method !== 'initialize') throw new HttpError(400, 'Initialize first');
        if (sessions.size >= (options.maxSessions ?? 1000)) throw new HttpError(503, 'Session capacity reached');
        entry = { session: new McpSession(), seen: now };
        const response = entry.session.handle(body);
        if (response && 'result' in response) {
          const sessionId = randomUUID(); sessions.set(sessionId, entry); res.setHeader('mcp-session-id', sessionId);
        }
        if (response) json(res, 200, response); else res.writeHead(202).end();
        return;
      }
      entry.seen = now;
      const response = entry.session.handle(body);
      if (response) json(res, 200, response); else res.writeHead(202).end();
    } catch (error) { httpFailure(res, error); }
  });
}
