import { describe, it, expect } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { McpSession } from '../src/task1/protocol.js';
import { createMcpHttpServer, serveStdio } from '../src/task1/transports.js';
import { close, init, initialized, listen, rpcHeaders } from './helpers.js';
let requestId = 100;
const call = (args: unknown) => ({ jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name: 'add', arguments: args } });
describe('Task 1: custom MCP server', () => {
  it('requires initialization and validates every tool argument strictly', () => {
    const session = new McpSession();
    expect(session.handle(call({ a: 1, b: 2 }))).toMatchObject({ error: { code: -32002 } });
    expect(session.handle(init)).toHaveProperty('result');
    session.handle(initialized);
    expect(session.handle(call({ a: 1, b: 2 }))).toMatchObject({ result: { content: [{ text: '3' }] } });
    for (const args of [{ a: '1', b: 2 }, { a: 1 }, { a: 1, b: 2, extra: true }, { a: Infinity, b: 1 }]) {
      expect(session.handle(call(args))).toMatchObject({ error: { code: -32602 } });
    }
    expect(session.handle({ ...call({ a: 1, b: 2 }), id: undefined })).toBeUndefined();
    expect(session.handle({ jsonrpc: '2.0', id: 0, method: 'unknown' })).toMatchObject({ id: 0, error: { code: -32601 } });
    expect(session.handle([init])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(session.handle({ ...init, extra: 1 })).toMatchObject({ error: { code: -32600 } });
  });
  it('frames stdio across chunks, handles malformed JSON, and keeps notifications silent', async () => {
    const text = `${JSON.stringify(init)}\n${JSON.stringify(initialized)}\n{broken}\n${JSON.stringify(call({ a: 3, b: 4 }))}\n`;
    const output = new PassThrough(); let written = '';
    output.on('data', chunk => { written += String(chunk); });
    await serveStdio(Readable.from([text.slice(0, 12), text.slice(12)]), output);
    const frames = written.trim().split('\n').map(line => JSON.parse(line));
    expect(frames).toHaveLength(3);
    expect(frames[1]).toMatchObject({ error: { code: -32700 } });
    expect(frames[2]).toMatchObject({ result: { content: [{ text: '7' }] } });
  });
  it('discards oversized stdio frames and resynchronizes', async () => {
    const output = new PassThrough(); let written = '';
    output.on('data', chunk => { written += String(chunk); });
    await serveStdio(Readable.from(['x'.repeat(100) + '\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n']), output, 64);
    expect(written.trim().split('\n').map(line => JSON.parse(line))).toMatchObject([
      { error: { code: -32600 } }, { id: 1, result: {} },
    ]);
  });
  it('enforces HTTP transport headers, origins, lifecycle and session isolation', async () => {
    const server = createMcpHttpServer(); const url = await listen(server) + '/mcp';
    try {
      const denied = await fetch(url, { method: 'POST', headers: { ...rpcHeaders, origin: 'https://evil.test' }, body: JSON.stringify(init) });
      expect(denied.status).toBe(403);
      expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) })).status).toBe(406);
      const response = await fetch(url, { method: 'POST', headers: rpcHeaders, body: JSON.stringify(init) });
      expect(response.status).toBe(200);
      const id = response.headers.get('mcp-session-id')!;
      const headers = { ...rpcHeaders, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialized) })).status).toBe(202);
      const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(call({ a: 4, b: 5 })) });
      expect(await result.json()).toMatchObject({ result: { content: [{ text: '9' }] } });
      expect((await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': 'bad' }, body: '{}' })).status).toBe(400);
      expect((await fetch(url, { method: 'GET' })).status).toBe(405);
      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(204);
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(call({ a: 1, b: 1 })) })).status).toBe(404);
      expect((await fetch(url, { method: 'POST', headers: rpcHeaders, body: '{' })).status).toBe(400);
    } finally { await close(server); }
  });
});

describe('Task 1 review regressions', () => {
  it('accepts empty-string IDs and MCP metadata, and prevents ID reuse', () => {
    const session = new McpSession();
    expect(session.handle({ ...init, id: '', params: { ...init.params, _meta: { 'example.org/request': 'value' }, clientInfo: { ...init.params.clientInfo, title: 'Test Client' } } })).toMatchObject({ id: '', result: {} });
    session.handle({ ...initialized, params: { _meta: {} } });
    expect(session.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' }, _meta: { progressToken: 1 } } })).toMatchObject({ result: { content: [{ text: 'hello' }] } });
    expect(session.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'replay' } } })).toMatchObject({ error: { code: -32600 } });
    expect(session.handle({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: { cursor: 'unsupported' } })).toMatchObject({ error: { code: -32602 } });
    for (const id of [null, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(session.handle({ jsonrpc: '2.0', id, method: 'ping' })).toMatchObject({ error: { code: -32600 } });
  });
  it('runs the real npm stdio entry point with JSON-RPC-only stdout', async () => {
    const { spawnSync } = await import('node:child_process');
    const input = [init, initialized, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: { text: 'héllo\nworld' } } }].map(value => JSON.stringify(value)).join('\n') + '\n';
    const child = spawnSync(process.execPath, [process.env.npm_execpath!, 'run', 'start:mcp'], {
      cwd: process.cwd(), env: { ...process.env, MCP_TRANSPORT: 'stdio' }, input, encoding: 'utf8', timeout: 5000,
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    const messages = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ result: { content: [{ text: 'héllo\nworld' }] } });
  });
  it('returns 413 for oversized bodies, rejects invalid UTF-8, batches and unacceptable media types', async () => {
    const server = createMcpHttpServer(); const url = await listen(server) + '/mcp';
    const post = (body: string | Uint8Array, headers = rpcHeaders) => fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : Uint8Array.from(body) });
    try {
      expect((await post(JSON.stringify({ ...init, padding: 'x'.repeat(70_000) }))).status).toBe(413);
      expect(await (await post(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).json()).toMatchObject({ error: { code: -32700 } });
      expect(await (await post(JSON.stringify([init]))).json()).toMatchObject({ error: { code: -32600 } });
      for (const accept of ['application/json-fake, text/event-stream', 'application/json;q=0, text/event-stream', 'application/json']) {
        expect((await post(JSON.stringify(init), { ...rpcHeaders, accept })).status).toBe(406);
      }
    } finally { await close(server); }
  });
  it('rejects malformed and unterminated UTF-8 stdio frames', async () => {
    const output = new PassThrough(); let written = '';
    output.on('data', chunk => { written += String(chunk); });
    await serveStdio(Readable.from([Buffer.from([0xff, 10]), Buffer.from('{')]), output);
    expect(written.trim().split('\n').map(line => JSON.parse(line))).toMatchObject([{ error: { code: -32700 } }, { error: { code: -32700 } }]);
  });
});
