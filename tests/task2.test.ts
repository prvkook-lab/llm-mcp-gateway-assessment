import { describe, it, expect } from 'vitest';
import { createSecurityGateway } from '../src/task2/gateway.js';
import { createMcpHttpServer } from '../src/task1/transports.js';
import { close, init, initialized, listen, rpcHeaders } from './helpers.js';
describe('Task 2: security gateway', () => {
  it('authenticates, filters discovery, denies tools and prevents session theft', async () => {
    const upstream = createMcpHttpServer(); const target = await listen(upstream) + '/mcp';
    const gateway = createSecurityGateway({ upstream: target, principals: [
      { id: 'alice', role: 'reader', key: 'reader-secret' }, { id: 'bob', role: 'admin', key: 'admin-secret' },
    ] });
    const url = await listen(gateway) + '/mcp';
    const post = (body: unknown, token: string, session?: string) => fetch(url, { method: 'POST', headers: {
      ...rpcHeaders, authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}),
    }, body: JSON.stringify(body) });
    try {
      expect((await post(init, 'invalid')).status).toBe(401);
      const response = await post(init, 'reader-secret'); const id = response.headers.get('mcp-session-id')!;
      expect(response.status).toBe(200);
      await post(initialized, 'reader-secret', id);
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'reader-secret', id);
      expect(await list.json()).toMatchObject({ result: { tools: [{ name: 'echo' }] } });
      const forbidden = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 2 } } }, 'reader-secret', id);
      expect(forbidden.status).toBe(403);
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'ping' }, 'admin-secret', id)).status).toBe(403);
      expect((await post([init], 'reader-secret')).status).toBe(400);
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'resources/read' }, 'reader-secret', id)).status).toBe(403);
      const admin = await post(init, 'admin-secret'); const adminId = admin.headers.get('mcp-session-id')!;
      await post(initialized, 'admin-secret', adminId);
      const add = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } }, 'admin-secret', adminId);
      expect(await add.json()).toMatchObject({ result: { content: [{ text: '5' }] } });
    } finally { await close(gateway); await close(upstream); }
  });
});

describe('Task 2 review regressions', () => {
  it('rejects unauthorized calls and malformed arguments without any upstream side effects', async () => {
    const { vi } = await import('vitest');
    const fetcher = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
    });
    const gateway = createSecurityGateway({ upstream: 'http://example.test/mcp', principals: [{ id: 'u', role: 'reader', key: 'secret' }], fetcher });
    const url = await listen(gateway) + '/mcp';
    const headers = { ...rpcHeaders, authorization: 'Bearer secret' };
    try {
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(init) })).status).toBe(200);
      const sessionHeaders = { ...headers, 'mcp-session-id': 'test-session', 'mcp-protocol-version': '2025-11-25', 'x-role': 'admin' };
      const post = (body: unknown) => fetch(url, { method: 'POST', headers: sessionHeaders, body: JSON.stringify(body) });
      expect((await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 2 } } })).status).toBe(403);
      expect((await post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 2 } } })).status).toBe(202);
      expect((await post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { text: 'notification' } } })).status).toBe(202);
      expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ok', extra: true } } })).status).toBe(400);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const forwarded = fetcher.mock.calls[0]![1];
      expect(forwarded.headers).not.toHaveProperty('authorization');
      expect(forwarded.headers).not.toHaveProperty('x-role');
      expect(forwarded.redirect).toBe('error');
    } finally { await close(gateway); }
  });
  it('rejects malformed, ambiguous, mismatched and oversized upstream JSON-RPC responses', async () => {
    const { vi } = await import('vitest');
    const responses: unknown[] = [null, [], { jsonrpc: '2.0', id: 999, result: {} },
      { jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'both' } },
      { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'invalid' } },
      { jsonrpc: '2.0', id: 1, result: { padding: 'x'.repeat(70_000) } }];
    const fetcher = vi.fn();
    const gateway = createSecurityGateway({ upstream: 'http://example.test/mcp', principals: [{ id: 'u', role: 'reader', key: 'secret' }], fetcher });
    const url = await listen(gateway) + '/mcp';
    try {
      for (const response of responses) {
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test' } }));
        expect((await fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: JSON.stringify(init) })).status).toBe(502);
      }
      expect((await fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: '{' })).status).toBe(400);
      expect((await fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: JSON.stringify({ ...init, extra: 'x'.repeat(70_000) }) })).status).toBe(413);
    } finally { await close(gateway); }
  });
  it('removes ownership on DELETE and denies cross-principal deletion', async () => {
    const upstream = createMcpHttpServer(); const target = await listen(upstream) + '/mcp';
    const gateway = createSecurityGateway({ upstream: target, principals: [{ id: 'u', role: 'reader', key: 'secret' }, { id: 'a', role: 'admin', key: 'admin' }] });
    const url = await listen(gateway) + '/mcp';
    try {
      const response = await fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: JSON.stringify(init) });
      const headers = { ...rpcHeaders, authorization: 'Bearer secret', 'mcp-session-id': response.headers.get('mcp-session-id')!, 'mcp-protocol-version': '2025-11-25' };
      expect((await fetch(url, { method: 'DELETE', headers: { ...headers, authorization: 'Bearer admin' } })).status).toBe(403);
      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(204);
      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(403);
    } finally { await close(gateway); await close(upstream); }
  });
});

describe('Proxy failure and capacity boundaries', () => {
  it('returns an ID-correlated JSON-RPC error when the upstream fails', async () => {
    const gateway = createSecurityGateway({ upstream: 'http://example.test/mcp', principals: [{ id: 'u', role: 'reader', key: 'secret' }],
      fetcher: async () => { throw new Error('upstream-secret'); },
    });
    const url = await listen(gateway) + '/mcp';
    try {
      const response = await fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: JSON.stringify({ ...init, id: '' }) });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: '', error: { code: -32001, message: 'Upstream unavailable' } });
    } finally { await close(gateway); }
  });
  it('counts in-flight initialization toward session capacity before calling upstream', async () => {
    let started!: () => void; const noticed = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const gateway = createSecurityGateway({ upstream: 'http://example.test/mcp', maxSessions: 1, principals: [{ id: 'u', role: 'reader', key: 'secret' }],
      fetcher: async () => {
        calls++; started(); await gate;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session' } });
      },
    });
    const url = await listen(gateway) + '/mcp';
    const post = () => fetch(url, { method: 'POST', headers: { ...rpcHeaders, authorization: 'Bearer secret' }, body: JSON.stringify(init) });
    try {
      const first = post(); await noticed;
      expect((await post()).status).toBe(503); expect(calls).toBe(1);
      release(); expect((await first).status).toBe(200);
      expect((await post()).status).toBe(503); expect(calls).toBe(1);
    } finally { release(); await close(gateway); }
  });
});
