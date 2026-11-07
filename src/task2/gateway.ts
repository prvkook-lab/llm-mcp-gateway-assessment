import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { acceptsMcp, HttpError, httpFailure, json, readJson, readResponseJson } from '../shared/http.js';
import { requestSchema, rpcError, validMethodParams, VERSION } from '../task1/protocol.js';

export type Role = 'reader' | 'admin';
export interface Principal { id: string; role: Role; key: string }
const allowedTools: Record<Role, readonly string[]> = { reader: ['echo'], admin: ['echo', 'add'] };
export function validatePrincipals(principals: readonly Principal[]): void {
  if (!principals.length || principals.some(p => !p.id || p.id.length > 256 || !p.key || !['reader', 'admin'].includes(p.role)) ||
      new Set(principals.map(p => p.key)).size !== principals.length ||
      new Set(principals.map(p => p.id)).size !== principals.length) throw new Error('Invalid principals');
}
export function authenticate(header: string | undefined, principals: readonly Principal[]): Principal | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const candidate = Buffer.from(header.slice(7));
  return principals.find(p => {
    const expected = Buffer.from(p.key);
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  });
}
const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int(), z.null()]), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int(), z.null()]), error: z.strictObject({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }),
]);
const toolListSchema = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough();
export function createSecurityGateway(options: {
  upstream: string; principals: readonly Principal[]; timeoutMs?: number; fetcher?: typeof fetch;
  maxSessions?: number;
}): Server {
  validatePrincipals(options.principals);
  const upstreamUrl = new URL(options.upstream);
  if (!['http:', 'https:'].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) throw new Error('Invalid upstream URL');
  const maxSessions = options.maxSessions ?? 1000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error('Invalid session capacity');
  const owners = new Map<string, { principal: string; expires: number }>();
  let pendingInitializations = 0;
  const fetcher = options.fetcher ?? fetch;
  return createServer(async (req, res) => {
    let reserved = false;
    let rpc: ReturnType<typeof requestSchema.parse> | undefined;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', disconnect);
    try {
      if (req.url !== '/mcp') throw new HttpError(404, 'Not found');
      if (req.headers.origin) throw new HttpError(403, 'Browser origins are disabled');
      const principal = authenticate(req.headers.authorization, options.principals);
      if (!principal) { res.setHeader('www-authenticate', 'Bearer'); throw new HttpError(401, 'Unauthorized'); }
      if (req.method !== 'POST' && req.method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
      if (req.method === 'POST' && !acceptsMcp(req.headers.accept)) throw new HttpError(406, 'Accept must include application/json and text/event-stream');
      for (const [id, owner] of owners) if (owner.expires <= Date.now()) owners.delete(id);
      const session = req.headers['mcp-session-id'];
      if (Array.isArray(session)) throw new HttpError(400, 'Invalid session');
      if (session && owners.get(session)?.principal !== principal.id) throw new HttpError(403, 'Session denied');
      if (session && req.headers['mcp-protocol-version'] !== VERSION) throw new HttpError(400, 'Unsupported protocol version');
      if (req.method === 'DELETE' && !session) throw new HttpError(400, 'Session required');
      let body: unknown;
      if (req.method === 'POST') {
        try { body = await readJson(req); }
        catch (error) {
          if (error instanceof HttpError && error.status === 400) { json(res, 400, rpcError(null, -32700, 'Parse error')); return; }
          throw error;
        }
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success) { json(res, 400, rpcError(null, -32600, 'Invalid Request')); return; }
        rpc = parsed.data;
        const methods = ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'];
        const tool = rpc.params?.name;
        if (!methods.includes(rpc.method) || (rpc.method === 'tools/call' &&
            (typeof tool !== 'string' || !allowedTools[principal.role].includes(tool)))) {
          if (rpc.id === undefined) res.writeHead(202).end();
          else json(res, 403, rpcError(rpc.id, -32003, 'Forbidden'));
          return;
        }
        if (rpc.method === 'notifications/initialized' && rpc.id !== undefined) {
          json(res, 400, rpcError(rpc.id, -32600, 'Expected notification')); return;
        }
        // Never let notification-shaped tool calls reach an upstream that might execute them.
        if (rpc.id === undefined && rpc.method !== 'notifications/initialized') { res.writeHead(202).end(); return; }
        if (!validMethodParams(rpc)) {
          if (rpc.id === undefined) res.writeHead(400).end();
          else json(res, 400, rpcError(rpc.id, -32602, 'Invalid parameters'));
          return;
        }
        if (!session && rpc.method !== 'initialize') throw new HttpError(400, 'Initialize first');
        if (rpc.method === 'initialize' && session) { json(res, 400, rpcError(rpc.id ?? null, -32600, 'Already initialized')); return; }
        if (rpc.method === 'initialize') {
          if (owners.size + pendingInitializations >= maxSessions) throw new HttpError(503, 'Session capacity reached');
          pendingInitializations++; reserved = true;
        }
      }
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (session) { headers['mcp-session-id'] = session; headers['mcp-protocol-version'] = VERSION; }
      // Never forward the client's credentials, role header, arbitrary headers, or URL.
      const upstream = await fetcher(options.upstream, {
        method: req.method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 3000)]), redirect: 'error',
      });
      if (req.method === 'DELETE') {
        if ((upstream.ok || upstream.status === 404) && session) owners.delete(session);
        void upstream.body?.cancel().catch(() => undefined);
        if (upstream.status !== 204) throw new HttpError(upstream.status === 404 ? 404 : 502, 'Upstream session unavailable');
        res.writeHead(204).end(); return;
      }
      if (rpc?.id === undefined) {
        void upstream.body?.cancel().catch(() => undefined);
        if (upstream.status !== 202) throw new HttpError(502, 'Invalid notification acknowledgement');
        if (session) owners.set(session, { principal: principal.id, expires: Date.now() + 1_800_000 });
        res.writeHead(202).end(); return;
      }
      const parsedResponse = responseSchema.safeParse(await readResponseJson(upstream));
      if (!parsedResponse.success || parsedResponse.data.id !== rpc.id) throw new HttpError(502, 'Invalid upstream response');
      const result = parsedResponse.data;
      if (rpc.method === 'tools/list' && 'result' in result) {
        const list = toolListSchema.safeParse(result.result);
        if (!list.success) throw new HttpError(502, 'Invalid upstream tools');
        result.result = { ...list.data, tools: list.data.tools.filter(tool => allowedTools[principal.role].includes(tool.name)) };
      }
      const newSession = upstream.headers.get('mcp-session-id');
      if (rpc.method === 'initialize' && upstream.ok && 'result' in result) {
        if (!newSession || !/^[\x21-\x7e]{1,256}$/.test(newSession) || owners.has(newSession)) throw new HttpError(502, 'Invalid upstream session');
        owners.set(newSession, { principal: principal.id, expires: Date.now() + 1_800_000 });
        res.setHeader('mcp-session-id', newSession);
      }
      if (session && upstream.ok) owners.set(session, { principal: principal.id, expires: Date.now() + 1_800_000 });
      json(res, upstream.status, result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = error instanceof HttpError ? error : new HttpError(502, 'Upstream unavailable');
        if (rpc?.id !== undefined) json(res, failure.status, rpcError(rpc.id, -32001, failure.message));
        else httpFailure(res, failure);
      }
    } finally {
      if (reserved) pendingInitializations--;
      res.off('close', disconnect);
    }
  });
}
